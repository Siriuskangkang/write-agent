import { tokenizeForSearch } from '../chunk/search-tokenizer.js';
import type { RetrievalQueryPlan, RetrievalTaskType } from './types.js';

const MAX_TERMS = 12;
const PROMPT_PREFIXES =
  /(?:请|根据|基于|结合|上传|材料|素材|撰写|生成|说明|介绍|分析|概述|教材|内容)/g;
const TECHNICAL_SUFFIXES = [
  '机床',
  '系统',
  '控制',
  '检测',
  '原理',
  '操作',
  '工艺',
  '结构',
  '目标',
  '方法',
  '技术',
];

const TASK_CONTEXT: Record<
  RetrievalTaskType,
  { intent: RetrievalQueryPlan['intent']; suffix: string }
> = {
  directory: {
    intent: 'structure',
    suffix: '课程结构 主题层级 先修关系',
  },
  outline: {
    intent: 'coverage',
    suffix: '学习目标 核心概念 重点难点 知识覆盖',
  },
  content: {
    intent: 'explanation',
    suffix: '定义 原理 步骤 案例 注意事项',
  },
};

export function planRetrievalQuery(input: {
  query: string;
  task_type: RetrievalTaskType;
}): RetrievalQueryPlan {
  const original = input.query.replace(/\s+/g, ' ').trim();
  const normalized = original
    .replace(PROMPT_PREFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const phrases = extractTechnicalPhrases(normalized);
  const fallback = tokenizeForSearch(normalized);
  const terms = unique([...phrases, ...fallback]).slice(0, MAX_TERMS);
  const context = TASK_CONTEXT[input.task_type];

  return {
    task_type: input.task_type,
    intent: context.intent,
    original_query: original,
    sparse_query: terms.join(' '),
    dense_query: `${normalized || original}；检索重点：${context.suffix}`,
    terms,
  };
}

function extractTechnicalPhrases(input: string): string[] {
  const segments = input
    .split(/[，。；、：:！？!?]|以及|并且|并|与|和|及|的/)
    .map((segment) => segment.replace(/[^\u4e00-\u9fa5a-zA-Z0-9-]/g, ''))
    .filter((segment) => segment.length >= 2);
  const result: string[] = [];

  for (const segment of segments) {
    let boundary = 0;
    for (let index = 0; index < segment.length; index += 1) {
      const suffix = TECHNICAL_SUFFIXES.find((candidate) =>
        segment.startsWith(candidate, index),
      );
      if (!suffix) continue;
      const end = index + suffix.length;
      const start = Math.max(boundary, end - 8);
      const phrase = segment.slice(start, end);
      if (phrase.length >= 2) result.push(phrase);
      boundary = end;
      index = end - 1;
    }

    if (boundary === 0 && segment.length <= 12) result.push(segment);
  }
  return unique(result);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
