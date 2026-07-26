import type { EvidenceItem, FusedCandidate } from './types.js';
import { createHash } from 'node:crypto';

export interface ContextBuildOptions {
  top_k: number;
  token_budget: number;
  max_per_source: number;
  query_embedding: number[] | null;
  mmr_lambda?: number;
  query_terms?: string[];
  retrieval_run_id?: string;
}

export function buildEvidenceContext(
  candidates: FusedCandidate[],
  options: ContextBuildOptions,
): { items: EvidenceItem[]; used_tokens: number } {
  const remaining = [...candidates];
  const selected: FusedCandidate[] = [];
  const sourceCounts = new Map<string, number>();
  let usedTokens = 0;

  while (remaining.length > 0 && selected.length < options.top_k) {
    const eligible = remaining.filter(
      (item) =>
        (sourceCounts.get(item.file_id) ?? 0) < options.max_per_source &&
        usedTokens + normalizedTokenCount(item) <= options.token_budget,
    );
    if (eligible.length === 0) break;

    const next = [...eligible].sort((a, b) => {
      const scoreDiff =
        mmrScore(b, selected, options) - mmrScore(a, selected, options);
      return scoreDiff || a.chunk_id.localeCompare(b.chunk_id);
    })[0];
    selected.push(next);
    usedTokens += normalizedTokenCount(next);
    sourceCounts.set(next.file_id, (sourceCounts.get(next.file_id) ?? 0) + 1);
    remaining.splice(
      remaining.findIndex((item) => item.chunk_id === next.chunk_id),
      1,
    );
  }

  return {
    items: selected.map((item) =>
      toEvidenceItem(
        item,
        options.query_terms ?? [],
        options.retrieval_run_id ?? 'offline-evaluation',
      ),
    ),
    used_tokens: usedTokens,
  };
}

function mmrScore(
  item: FusedCandidate,
  selected: FusedCandidate[],
  options: ContextBuildOptions,
): number {
  const lambda = options.mmr_lambda ?? 0.75;
  if (
    !options.query_embedding ||
    !item.embedding ||
    item.embedding.length !== options.query_embedding.length
  ) {
    return item.rerank_score;
  }
  const relevance = cosine(item.embedding, options.query_embedding);
  const redundancy =
    selected.length === 0
      ? 0
      : Math.max(
          ...selected.map((other) =>
            other.embedding?.length === item.embedding?.length
              ? cosine(item.embedding as number[], other.embedding as number[])
              : 0,
          ),
        );
  return lambda * relevance - (1 - lambda) * redundancy;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalizedTokenCount(item: FusedCandidate): number {
  return Math.max(1, item.token_count || Math.ceil(item.content.length / 2));
}

function toEvidenceItem(
  item: FusedCandidate,
  queryTerms: string[],
  retrievalRunId: string,
): EvidenceItem {
  const exactSpan = extractExactSpan(item, queryTerms);
  return {
    evidence_id: stableEvidenceId(retrievalRunId, item.chunk_id, exactSpan),
    chunk_id: item.chunk_id,
    content: item.content,
    exact_span: exactSpan,
    source: {
      file_id: item.file_id,
      file_name: item.file_name,
      document_id: item.document_id,
      ingestion_key: item.ingestion_key,
      page_start: item.page_start,
      page_end: item.page_end,
      section_title: item.section_title,
      heading_path: item.heading_path,
      keywords: item.keywords,
    },
    scores: {
      sparse: item.sparse_score,
      dense: item.dense_score,
      fusion: item.fusion_score,
      rerank: item.rerank_score,
    },
    ranks: {
      sparse: item.sparse_rank,
      dense: item.dense_rank,
      fusion: item.fusion_rank,
      rerank: item.rerank_rank,
    },
    token_count: normalizedTokenCount(item),
  };
}

function stableEvidenceId(
  retrievalRunId: string,
  chunkId: string,
  exactSpan: EvidenceItem['exact_span'],
): string {
  const spanDigest = createHash('sha256')
    .update(exactSpan.text.normalize('NFC'), 'utf8')
    .digest('hex');
  const identity = [
    retrievalRunId,
    chunkId,
    exactSpan.char_start === null ? 'null' : String(exactSpan.char_start),
    exactSpan.char_end === null ? 'null' : String(exactSpan.char_end),
    spanDigest,
  ].join('\0');
  return `evidence:${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

function extractExactSpan(
  item: FusedCandidate,
  queryTerms: string[],
): EvidenceItem['exact_span'] {
  const segments = sentenceSegments(item.content);
  const normalizedTerms = queryTerms
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const best = [...segments].sort((left, right) => {
    const score =
      supportScore(right.text, normalizedTerms) -
      supportScore(left.text, normalizedTerms);
    return score || left.start - right.start;
  })[0] ?? { text: item.content, start: 0 };
  const absoluteStart =
    item.char_start === null ? null : item.char_start + best.start;
  return {
    text: best.text,
    char_start: absoluteStart,
    char_end: absoluteStart === null ? null : absoluteStart + best.text.length,
  };
}

function sentenceSegments(
  content: string,
): Array<{ text: string; start: number }> {
  const segments: Array<{ text: string; start: number }> = [];
  const expression = /[^。！？!?\n]+[。！？!?]?/gu;
  for (const match of content.matchAll(expression)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) {
      segments.push({ text, start: (match.index ?? 0) + leading });
    }
  }
  return segments;
}

function supportScore(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce(
    (score, term) => score + (normalized.includes(term) ? term.length : 0),
    0,
  );
}
