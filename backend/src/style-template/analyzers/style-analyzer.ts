import { Injectable } from '@nestjs/common';
import { AgentService } from '../../agent/agent.service.js';
import { isLLMTextDeltaEvent } from '../../llm/llm.interface.js';
import { StyleTemplateService } from '../style-template.service.js';
import { StyleTemplateTextCacheService } from '../style-template-text-cache.service.js';
import { Observable, Subscriber, from, mergeMap } from 'rxjs';
import * as path from 'path';
import * as fs from 'fs/promises';
import { parseDocx } from '../../file/parsers/docx.parser.js';
import { parsePdf } from '../../file/parsers/pdf.parser.js';
import { parseTxt } from '../../file/parsers/txt.parser.js';
import { parsePptx } from '../../file/parsers/pptx.parser.js';
import { StyleTreeNode } from '../entities/style-template.entity.js';
import { nanoid } from 'nanoid';

function assignIds(node: StyleTreeNode): StyleTreeNode {
  return {
    ...node,
    id: node.id ?? nanoid(12),
    children: node.children.map(assignIds),
  };
}

interface AnalyzeEvent {
  type: 'meta' | 'token' | 'done' | 'error';
  data: Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStyleTreeNode(value: unknown): value is StyleTreeNode {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.title === 'string' &&
    Array.isArray(node.children) &&
    node.children.every(isStyleTreeNode) &&
    (node.id === undefined || typeof node.id === 'string') &&
    (node.requirement === undefined || typeof node.requirement === 'string')
  );
}

const PROMPT_STRUCTURE = `你是一名文章结构识别助手。

任务：根据给定文章中明确出现的标题、编号、栏目名、步骤名、项目符号等结构标记，识别文章层级，并以 JSON 树结构输出。
规则
只做结构划分，不做总结归纳。
只识别原文中显式存在的结构。可作为结构依据的内容包括：
标题
小标题
编号标题（如"一、二、三""（一）（二）（三）""1. 2. 3."）
栏目名（如"活动""拓展学习""思考与练习""总结"）
步骤名（如"步骤1""步骤2"）
项目符号列项
明显独立成行并承担标题功能的短语
没有显式标题、编号、分项标记的连续正文，一律视为正文，不再向下拆分。
不得根据正文内容自行概括出新标题。
图、表、示意图、配图、图注、表注、表格字段等，默认视为正文附属内容，不单独作为结构层级输出。
拿不准是否属于结构时，默认按正文处理，不新增层级。
最多划分到 5 级。
可以轻微规范格式，但不得改变原意。
输出要求
只输出 JSON，不输出任何 Markdown 代码块标记（不加 \`\`\`）。
每个节点只包含 title（字符串）和 children（数组）两个字段。
没有子节点时 children 返回空数组 []。
最外层输出一个根节点对象。`;

const PROMPT_REQUIREMENT = `你是一名体例分析助手。

背景说明：
用户输入的是一份"体例文档"（编写规范或模板），用于指导作者如何撰写各栏目的正文。
体例文档中通常包含：编写说明、格式要求、字数建议、内容方向、写法指引、示例说明等。

任务：
我已对该体例文档完成了结构识别，得到如下 JSON 树（每个节点含 title 和 children）。
请为其中所有叶节点（children 为空数组 []）补充一个 requirement 字段，内容为该栏目的正文编写要求。

requirement 提取规则：
- 从体例文档中该栏目对应的位置，找出明确的编写说明、格式要求、字数建议、内容方向等
- 提取内容包括：字数或篇幅要求、内容类型（如案例、定义、练习题、步骤说明）、格式规定（如列项数、图表要求）、写法指引（如视角、语气、结构方式）、特殊约束（如"不少于5条""建议不超过1页"）
- 保留体例原文的关键表述，不要改写成自己的语言
- 若该栏目在体例中没有任何编写说明，写：体例未说明编写要求
- 不超过 100 字，语言简洁

输出要求：
- 只输出完整的 JSON，保持原有树结构不变
- 只为叶节点加 requirement 字段，非叶节点不加
- 不添加任何 Markdown 代码块标记
- 不输出任何解释文字`;

@Injectable()
export class StyleAnalyzer {
  constructor(
    private readonly agentService: AgentService,
    private readonly styleTemplateService: StyleTemplateService,
    private readonly textCacheService: StyleTemplateTextCacheService,
  ) {}

  analyzeStream(
    templateId: string,
    filePath: string | null,
    textContent?: string,
  ): Observable<AnalyzeEvent> {
    const contextPromise = textContent
      ? Promise.resolve(textContent)
      : this.prepareContext(filePath);
    return from(contextPromise).pipe(
      mergeMap((context) => this.streamAnalysis(templateId, context)),
    );
  }

  private async prepareContext(filePath: string | null): Promise<string> {
    if (!filePath) {
      return '';
    }

    const ext = path.extname(filePath).toLowerCase();
    let content = '';

    try {
      switch (ext) {
        case '.docx':
        case '.doc': {
          const result = await parseDocx(filePath);
          content = result.sections
            .map((s) => (s.title ? `## ${s.title}\n\n${s.content}` : s.content))
            .join('\n\n');
          break;
        }
        case '.pdf': {
          const result = await parsePdf(filePath);
          content = result.sections
            .map((s) => (s.title ? `## ${s.title}\n\n${s.content}` : s.content))
            .join('\n\n');
          break;
        }
        case '.pptx':
        case '.ppt': {
          const result = await parsePptx(filePath);
          content = result.sections
            .map((s) => (s.title ? `## ${s.title}\n\n${s.content}` : s.content))
            .join('\n\n');
          break;
        }
        case '.txt':
        case '.md': {
          const result = await parseTxt(filePath);
          content = result.content_text;
          break;
        }
        default: {
          const raw = await fs.readFile(filePath, 'utf-8');
          content = raw;
        }
      }
    } catch (error) {
      throw new Error(`读取体例文件失败: ${getErrorMessage(error)}`);
    }

    const fileName = path.basename(filePath);
    return `## ${fileName}\n\n${content}`;
  }

  private streamAnalysis(
    templateId: string,
    context: string,
  ): Observable<AnalyzeEvent> {
    return new Observable<AnalyzeEvent>((subscriber) => {
      subscriber.next({
        type: 'meta',
        data: { templateId },
      });

      (async () => {
        try {
          // Step 1: 识别结构树
          const tree = await this.runStep1(context, subscriber);

          // Step 2: 补充 requirement
          const treeWithReq = await this.runStep2(context, tree, subscriber);

          const treeWithIds = assignIds(treeWithReq);
          const features = { structure_tree: treeWithIds };

          await this.styleTemplateService.updateAnalysisResult(
            templateId,
            features,
            'completed',
          );

          this.textCacheService.delete(templateId);

          subscriber.next({
            type: 'done',
            data: { features },
          });
          subscriber.complete();
        } catch (error) {
          const message = getErrorMessage(error);
          await this.styleTemplateService.updateAnalysisResult(
            templateId,
            null,
            'failed',
            message,
          );

          this.textCacheService.delete(templateId);

          subscriber.next({
            type: 'error',
            data: { message },
          });
          subscriber.error(error);
        }
      })();
    });
  }

  private async runStep1(
    context: string,
    subscriber: Subscriber<AnalyzeEvent>,
  ): Promise<StyleTreeNode> {
    subscriber.next({
      type: 'token',
      data: { content: '', step: 1, label: '第 1 步：识别结构树…' },
    });

    const maxRetries = 2;
    let lastError: Error | null = null;

    // 如果文档超长，智能截断到最后一个完整段落
    let processedContext = context;
    if (context.length > 12000) {
      const truncated = context.slice(0, 12000);
      const lastParagraph = truncated.lastIndexOf('\n\n');
      processedContext =
        lastParagraph > 8000 ? truncated.slice(0, lastParagraph) : truncated;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let buffer = '';
      try {
        for await (const event of this.agentService.streamCompletion(
          `待处理文章：\n\n${processedContext}`,
          PROMPT_STRUCTURE,
          0.1,
        )) {
          if (isLLMTextDeltaEvent(event)) {
            buffer += event.delta.text;
          }
        }
        return this.parseJson(buffer, 'Step1');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          subscriber.next({
            type: 'token',
            data: {
              content: '',
              step: 1,
              label: `第 1 步：重试中（${attempt + 1}/${maxRetries}）…`,
            },
          });
        }
      }
    }

    throw lastError ?? new Error('体例结构识别失败');
  }

  private async runStep2(
    context: string,
    tree: StyleTreeNode,
    subscriber: Subscriber<AnalyzeEvent>,
  ): Promise<StyleTreeNode> {
    subscriber.next({
      type: 'token',
      data: { content: '', step: 2, label: '第 2 步：提炼编写要求…' },
    });

    let processedContext2 = context;
    if (context.length > 12000) {
      const truncated = context.slice(0, 12000);
      const lastParagraph = truncated.lastIndexOf('\n\n');
      processedContext2 =
        lastParagraph > 8000 ? truncated.slice(0, lastParagraph) : truncated;
    }

    const userMessage =
      `体例文档：\n\n${processedContext2}` +
      `\n\n---\n\n结构树 JSON：\n\n${JSON.stringify(tree, null, 2)}`;

    let buffer = '';
    for await (const event of this.agentService.streamCompletion(
      userMessage,
      PROMPT_REQUIREMENT,
      0.2,
    )) {
      if (isLLMTextDeltaEvent(event)) {
        buffer += event.delta.text;
      }
    }

    try {
      return this.parseJson(buffer, 'Step2');
    } catch {
      // Step2 失败时回退到仅含结构树的结果
      return tree;
    }
  }

  private parseJson(text: string, stepLabel: string): StyleTreeNode {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (isStyleTreeNode(parsed)) return parsed;
      throw new Error(`${stepLabel} 返回的结构不合法`);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed: unknown = JSON.parse(m[0]);
        if (isStyleTreeNode(parsed)) return parsed;
      }
      throw new Error(`${stepLabel} 返回内容无法解析为 JSON`);
    }
  }
}
