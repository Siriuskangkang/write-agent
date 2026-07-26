import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { StyleTemplateService } from '../style-template/style-template.service.js';
import { type StyleTreeNode } from '../style-template/entities/style-template.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { CitationUseType } from '../common/enums.js';
import { RetrieveDto } from '../retrieval/dto/retrieve.dto.js';
import { SqlGroundingEvidenceStore } from '../citation/sql-grounding-evidence.store.js';
import type { EvidenceItem, RetrievalState } from '../retrieval/types.js';
import { planRetrievalQuery } from '../retrieval/query-planner.js';

export interface ParsedCitationMarker {
  paragraph_key: string;
  chunk_id: string;
  use_type: CitationUseType;
  description: string;
}

interface StructurePattern {
  level_type?: string;
  level?: string;
  placeholder_title?: string;
  requirement?: string;
  children?: StructurePattern[];
}

@Injectable()
export class ContentSharedService {
  readonly logger = new Logger(ContentSharedService.name);

  constructor(
    @InjectRepository(Chunk)
    readonly chunkRepo: Repository<Chunk>,
    readonly retrievalService: RetrievalService,
    readonly styleTemplateService: StyleTemplateService,
    @Optional()
    readonly groundingEvidenceStore?: SqlGroundingEvidenceStore,
  ) {}

  async retrieveMaterials(projectId: string, query: string): Promise<string> {
    try {
      const results = await this.retrievalService.retrieve(projectId, {
        query,
        task_type: 'content',
        top_k: 10,
      } satisfies RetrieveDto);
      return results
        .map(
          (c, i) =>
            `[素材${i + 1}] (chunk_id: ${c.chunk_id})\n${c.section_title ? `标题: ${c.section_title}\n` : ''}${c.content}`,
        )
        .join('\n\n---\n\n');
    } catch (err) {
      this.logger.warn(`素材检索失败: ${err}`);
      return '';
    }
  }

  async retrieveGroundingMaterials(
    projectId: string,
    query: string,
    workflowJobId: string,
    strictMode: boolean,
  ): Promise<{
    materials: string;
    evidenceIds: string[];
    retrievalRunId: string;
    state: RetrievalState;
  }> {
    if (!this.groundingEvidenceStore) {
      return {
        materials: await this.retrieveMaterials(projectId, query),
        evidenceIds: [],
        retrievalRunId: 'legacy:unassigned',
        state: 'DEGRADED',
      };
    }
    const result = await this.retrievalService.retrieveEvidenceSnapshot(
      projectId,
      {
        query,
        task_type: 'content',
        top_k: 10,
      } satisfies RetrieveDto,
    );
    if (result.state === 'ERROR') {
      throw new BadRequestException(
        result.error_message || '素材检索失败，无法建立证据快照',
      );
    }
    const evidenceIds = result.evidence.map((item) => item.evidence_id);
    await this.groundingEvidenceStore.assignEvidence({
      workflow_job_id: workflowJobId,
      project_id: projectId,
      retrieval_run_id: result.run_id,
      retrieval_state: result.state,
      evidence_ids: evidenceIds,
      strict_mode: strictMode,
      contract_version: strictMode ? 'atomic:v1' : 'legacy:v0',
    });
    return {
      materials: renderEvidenceMaterials(result.evidence),
      evidenceIds,
      retrievalRunId: result.run_id,
      state: result.state,
    };
  }

  async inheritGroundingMaterials(
    projectId: string,
    workflowJobId: string,
    parentResultId: string,
    strictMode: boolean,
  ): Promise<{
    materials: string;
    evidenceIds: string[];
    retrievalRunId: string;
    state: RetrievalState;
  }> {
    if (!this.groundingEvidenceStore) {
      throw new BadRequestException(
        '严格写作流程缺少 grounding evidence store',
      );
    }
    const assignment =
      await this.groundingEvidenceStore.inheritEvidenceAssignment({
        workflow_job_id: workflowJobId,
        project_id: projectId,
        parent_result_id: parentResultId,
        strict_mode: strictMode,
        contract_version: strictMode ? 'atomic:v1' : 'legacy:v0',
      });
    return {
      materials: assignment.evidence
        .map(
          (item) =>
            `[evidence_id: ${item.evidence_id}]\n` +
            `${item.heading_path.length > 0 ? `标题路径: ${item.heading_path.join(' > ')}\n` : ''}` +
            `${item.page_start !== null ? `页/张: ${item.page_start}${item.page_end !== null && item.page_end !== item.page_start ? `-${item.page_end}` : ''}\n` : ''}` +
            `精确证据: ${item.exact_span_text}`,
        )
        .join('\n\n---\n\n'),
      evidenceIds: assignment.evidence.map((item) => item.evidence_id),
      retrievalRunId: assignment.retrieval_run_id,
      state: assignment.retrieval_state,
    };
  }

  async retrieveRevisionGroundingMaterials(
    projectId: string,
    workflowJobId: string,
    unsupportedClaims: Array<{ claim_id: string; claim_text: string }>,
    signal: AbortSignal,
    baseRetrievalRunId?: string,
  ): Promise<void> {
    if (!this.groundingEvidenceStore) {
      throw new BadRequestException('定向修订缺少 grounding evidence store');
    }
    if (signal.aborted) throw signal.reason;
    if (baseRetrievalRunId) {
      const current =
        await this.groundingEvidenceStore.loadAssignment(workflowJobId);
      if (
        current &&
        current.project_id === projectId &&
        current.targeted_revision_attempts === 1 &&
        current.retrieval_run_id !== baseRetrievalRunId
      ) {
        return;
      }
    }
    const rawQuery = unsupportedClaims
      .map((claim) => claim.claim_text.trim())
      .filter(Boolean)
      .join('\n');
    if (!rawQuery) {
      throw new BadRequestException('定向修订缺少可检索声明');
    }
    const plannedQuery = planRetrievalQuery({
      query: rawQuery,
      task_type: 'content',
    }).sparse_query;
    const query = (plannedQuery || rawQuery).slice(0, 500);
    const result = await this.retrievalService.retrieveEvidenceSnapshot(
      projectId,
      {
        query,
        task_type: 'content',
        top_k: 10,
      } satisfies RetrieveDto,
      {
        workflow_job_id: workflowJobId,
        revision_attempt: 1,
      },
    );
    if (signal.aborted) throw signal.reason;
    if (result.state === 'ERROR') {
      throw new BadRequestException(
        result.error_message || '定向检索失败，无法修订声明',
      );
    }
    await this.groundingEvidenceStore.replaceEvidenceAfterTargetedRetrieval({
      workflow_job_id: workflowJobId,
      project_id: projectId,
      retrieval_run_id: result.run_id,
      retrieval_state: result.state,
      evidence_ids: result.evidence.map((item) => item.evidence_id),
      strict_mode: true,
      contract_version: 'atomic:v1',
      revision_attempt: 1,
    });
  }

  async loadGroundingMaterials(
    projectId: string,
    workflowJobId: string,
  ): Promise<{ materials: string; evidenceIds: string[] }> {
    if (!this.groundingEvidenceStore) {
      throw new BadRequestException(
        '严格写作流程缺少 grounding evidence store',
      );
    }
    const assignment =
      await this.groundingEvidenceStore.loadAssignment(workflowJobId);
    if (!assignment || assignment.project_id !== projectId) {
      throw new BadRequestException('定向修订证据分配不存在');
    }
    return {
      materials: assignment.evidence
        .map(
          (item) =>
            `[evidence_id: ${item.evidence_id}]\n` +
            `精确证据: ${item.exact_span_text}\n` +
            `标题路径: ${item.heading_path.join(' > ') || '无'}`,
        )
        .join('\n\n---\n\n'),
      evidenceIds: assignment.evidence.map((item) => item.evidence_id),
    };
  }

  async getActiveTemplate(projectId: string) {
    return this.styleTemplateService.getProjectActiveTemplate(projectId);
  }

  async getStructureTreePrompt(
    projectId: string,
    type: 'directory' | 'outline' | 'content' = 'directory',
  ): Promise<string> {
    try {
      const activeTemplate = await this.getActiveTemplate(projectId);
      if (!activeTemplate?.features?.structure_tree) return '';

      const { structure_tree, panel_assignment } = activeTemplate.features;

      if (panel_assignment) {
        const panelKey =
          type === 'directory'
            ? 'panel_a'
            : type === 'outline'
              ? 'panel_b'
              : 'panel_c';
        const panelNodes = panel_assignment[panelKey];

        // 确保是 StyleTreeNode[] 格式（非旧版 string[]）
        const isValidNodes =
          Array.isArray(panelNodes) &&
          panelNodes.length > 0 &&
          typeof panelNodes[0] === 'object' &&
          panelNodes[0] !== null;

        if (isValidNodes) {
          const patterns = panelNodes.map((node) => this.extractPattern(node));
          return this.buildPanelPrompt(patterns, type);
        }
      }

      // Fallback: no panel assignment, use full tree
      const structureTemplate =
        this.transformToStructureTemplate(structure_tree);
      return this.buildFallbackPrompt(structureTemplate);
    } catch (err) {
      this.logger.warn(`获取体例结构失败: ${err}`);
      return '';
    }
  }

  private buildPanelPrompt(
    patterns: StructurePattern[],
    type: 'directory' | 'outline' | 'content',
  ): string {
    const patternsJson = JSON.stringify(patterns, null, 2);

    if (type === 'directory') {
      return `## 目录体例结构（严格遵守，不得偏离）

以下是目录生成的结构模板。它定义了完整目录应有的层级关系和节点组成。
- placeholder_title 是占位名称，仅表示该位置需要一个该类型的节点
- level_type 表示层级类型（模块、任务、节、小节、栏目、步骤等）
- 实际标题必须根据项目信息和素材内容重新生成

${patternsJson}

### 目录生成规则（严格遵守）

**最核心原则：目录的层级结构必须与上述模板完全一致。模板中有 children 的节点照搬其子结构，模板中没有 children 的节点就是叶子节点，禁止为其添加任何子节点。**

具体规则：
1. **严格遵循层级深度**：如果模板中"任务"节点没有 children 字段或 children 为空，则目录中对应的"任务"节点也不能有任何子节点。绝对不能自行添加模板中不存在的层级（如"节""小节""步骤"等）
2. **节点数量和类型对应**：模板有几个子节点，目录就生成几个子节点。模板有3个任务，目录就生成3个任务
3. **层级复制**：每个顶层节点下的子结构必须完全一致地复现模板，不允许某个顶层节点有完整子结构而另一个为空
4. **标题自拟**：所有标题必须基于项目信息和素材内容自行拟定，绝不能照搬 placeholder_title
5. **禁止占位**：不得使用"预留任务""预留""（预留）"等占位表述
6. **展开简写**：体例中"任务2-4"等简写必须展开为独立的节点
7. **编号格式**：参考模板中的编号格式`.trim();
    }

    if (type === 'outline') {
      return `## 大纲体例结构

以下是大纲生成的结构模板，定义了每个章节/小节生成大纲时应包含的栏目及其写作要求。
- 每个节点代表大纲中的一个栏目/段落
- level_type 和 placeholder_title 指示栏目的类型和位置
- requirement 描述该栏目的具体写作要求、篇幅建议和内容要点

${patternsJson}

### 大纲生成规则
1. 大纲必须严格按照上述体例结构生成 sections，栏目数量、顺序和名称与体例一一对应
2. 每个栏目的 writing_guide 和 content_points 应根据该栏目的 requirement 生成
3. content_points 必须基于参考素材，具体可执行，不少于3个要点
4. length_suggestion 应根据 requirement 中的篇幅要求设置（如无明确要求则由内容决定）
5. 如无重难点或参考资料，也要返回空数组，不要省略字段
6. 只输出 JSON，不要输出其他内容`.trim();
    }

    // type === 'content'
    return `## 正文体例结构（仅定义栏目布局，不决定内容主题）

以下模板定义了正文撰写时的**栏目布局和写作要求**。
**关键说明**：
- 模板中的 placeholder_title 是栏目类型和位置的示例（如"一、xxx"、"活动"、"思考与练习"），仅用于标识栏目在结构中的位置和类型
- 模板中的具体标题（如"任务1 探究xxx"、"活动名 [音频转文字]"）是示例，**绝对不能照搬到正文中**
- 你要撰写的实际内容由下方"## 章节信息"中的章节标题和小节标题决定
- requirement 描述了该栏目的写作要求、篇幅建议、内容要点和格式规范

${patternsJson}

### 正文生成规则
1. **内容主题**：正文内容必须围绕"## 章节信息"中的章节和小节标题撰写，不得使用模板中的示例标题
2. **栏目顺序**：严格按上述体例结构中的栏目顺序逐栏输出，不得遗漏或调换
3. **栏目标记**：每个栏目以 <!-- column:栏目名称 --> 标记开头，栏目名称使用体例中对应位置的 placeholder_title（但去掉方括号内的具体内容）
4. **写作要求**：严格遵循每个栏目的 requirement 中的篇幅建议和写作要点
5. **段落标记**：栏目内每个段落以 <!-- paragraph_key:pX --> 标记开头
6. **引用标注（必须）**：每个段落的正文之后，必须使用 <!-- citations:pX --> 标记引用来源，格式为 - [chunk_id](use_type: rewrite|summarize|synthesize) 引用说明。没有引用的段落也要保留空引用块
7. **步骤编号**：任务实施类栏目必须使用"步骤1、步骤2..."编号
8. **素材引用**：基于参考素材撰写正文，核心论述必须标注引用来源`.trim();
  }

  private buildFallbackPrompt(structureTemplate: StructurePattern): string {
    return `## 体例结构要求（仅供参考）

以下是教材的体例结构模板。这是一个**结构示例**，展示了层级关系和编写要求，但其中的标题仅为占位符。

**重要说明**：
1. 请根据项目实际内容生成新的标题，不要复制模板中的标题
2. 参考模板的层级结构和顺序，但标题必须基于项目信息和素材
3. 叶节点的 requirement 字段描述了该栏目的编写要求
4. 某些层级可能在模板中简写（如"任务2-4"），实际生成时应展开为完整结构

结构模板：
${JSON.stringify(structureTemplate, null, 2)}`.trim();
  }

  private extractPattern(node: StyleTreeNode): StructurePattern {
    const level = this.extractLevel(node.title);
    const result: StructurePattern = {
      level_type: level,
      placeholder_title: node.title,
    };
    if (node.requirement) {
      result.requirement = node.requirement;
    }
    if (node.children && node.children.length > 0) {
      result.children = node.children.map((child) =>
        this.extractPattern(child),
      );
    }
    return result;
  }

  private transformToStructureTemplate(node: StyleTreeNode): StructurePattern {
    const level = this.extractLevel(node.title);
    const result: StructurePattern = { level };
    if (node.requirement) {
      result.requirement = node.requirement;
    }
    if (node.children && node.children.length > 0) {
      result.children = node.children.map((child) =>
        this.transformToStructureTemplate(child),
      );
    }
    return result;
  }

  private extractLevel(title: string): string {
    if (!title) return '未命名层级';
    const patterns = [
      { regex: /^模块[一二三四五六七八九十\d]+/, level: '模块' },
      { regex: /^任务[一二三四五六七八九十\d]+/, level: '任务' },
      { regex: /^步骤[一二三四五六七八九十\d]+/, level: '步骤' },
      { regex: /^项目[一二三四五六七八九十\d]+/, level: '项目' },
      { regex: /^第[一二三四五六七八九十\d]+章/, level: '章' },
      { regex: /^第[一二三四五六七八九十\d]+节/, level: '节' },
      { regex: /^[一二三四五六七八九十]+[、．.]/, level: '节' },
      { regex: /^\d+[、．.]/, level: '小节' },
    ];
    for (const { regex, level } of patterns) {
      if (regex.test(title)) return level;
    }
    return '栏目';
  }

  normalizeCitationUseType(value: string | undefined): CitationUseType {
    const normalized = value?.trim().toLowerCase();
    switch (normalized) {
      case CitationUseType.REWRITE:
        return CitationUseType.REWRITE;
      case CitationUseType.SUMMARIZE:
        return CitationUseType.SUMMARIZE;
      case CitationUseType.SYNTHESIZE:
        return CitationUseType.SYNTHESIZE;
      case CitationUseType.TRANSITION:
        return CitationUseType.TRANSITION;
      default:
        return CitationUseType.UNSUPPORTED;
    }
  }

  parseStructuredCitations(content: string): ParsedCitationMarker[] {
    const blocks = Array.from(
      content.matchAll(
        /<!--\s*paragraph_key:\s*(p\d+)\s*-->([\s\S]*?)(?=<!--\s*paragraph_key:\s*p\d+\s*-->|$)/g,
      ),
    );

    const seen = new Set<string>();
    const parsed: ParsedCitationMarker[] = [];

    for (const match of blocks) {
      const paragraph_key = match[1];
      const body = match[2] ?? '';
      const citationMatch = body.match(
        /<!--\s*citations:\s*p\d+\s*-->([\s\S]*)$/i,
      );
      if (!citationMatch) continue;

      const lines = citationMatch[1]
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (const rawLine of lines) {
        const normalizedLine = rawLine.replace(/^-+\s*/, '').trim();
        const lineMatch = normalizedLine.match(
          /^\[([^\]]+)\]\(use_type:\s*([^)]+)\)\s*(.*)$/i,
        );
        if (!lineMatch) continue;

        const chunk_id = lineMatch[1].trim();
        if (!chunk_id) continue;

        const use_type = this.normalizeCitationUseType(lineMatch[2]);
        const description = lineMatch[3]?.trim() ?? '';
        const dedupeKey = `${paragraph_key}::${chunk_id}::${use_type}`;

        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        parsed.push({ paragraph_key, chunk_id, use_type, description });
      }
    }

    return parsed;
  }
}

function renderEvidenceMaterials(evidence: EvidenceItem[]): string {
  return evidence
    .map(
      (item) =>
        `[evidence_id: ${item.evidence_id}]\n` +
        `来源: ${item.source.file_name ?? item.source.file_id}\n` +
        `${item.source.heading_path.length > 0 ? `标题路径: ${item.source.heading_path.join(' > ')}\n` : ''}` +
        `${item.source.page_start !== null ? `页/张: ${item.source.page_start}${item.source.page_end !== null && item.source.page_end !== item.source.page_start ? `-${item.source.page_end}` : ''}\n` : ''}` +
        `精确证据: ${item.exact_span.text}\n上下文: ${item.content}`,
    )
    .join('\n\n---\n\n');
}
