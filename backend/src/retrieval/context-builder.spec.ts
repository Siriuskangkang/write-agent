import { buildEvidenceContext } from './context-builder.js';
import type { FusedCandidate } from './types.js';

function fused(
  chunk_id: string,
  file_id: string,
  position: number,
  content: string,
  rerank_score: number,
): FusedCandidate {
  return {
    chunk_id,
    file_id,
    document_id: `${file_id}-document`,
    project_id: 'project',
    ingestion_key: 'v1',
    content,
    section_title: `标题-${file_id}`,
    heading_path: [`章-${file_id}`, `标题-${file_id}`],
    page_start: position + 1,
    page_end: position + 1,
    char_start: 10,
    char_end: 10 + content.length,
    position,
    token_count: content.length,
    source: 'sparse',
    source_score: rerank_score,
    sparse_rank: position + 1,
    sparse_score: rerank_score,
    dense_rank: null,
    dense_score: null,
    fusion_score: rerank_score,
    fusion_rank: position + 1,
    rerank_score,
    rerank_rank: position + 1,
  };
}

describe('buildEvidenceContext', () => {
  it('extracts the best query-supporting sentence and preserves absolute offsets', () => {
    const content =
      '背景介绍不涉及控制。闭环控制通过位置检测形成反馈误差。最后是维护说明。';
    const result = buildEvidenceContext(
      [fused('chunk-span', 'file-1', 0, content, 1)],
      {
        top_k: 1,
        token_budget: 100,
        max_per_source: 2,
        query_embedding: null,
        query_terms: ['闭环控制', '位置检测'],
      },
    );

    expect(result.items[0]?.exact_span.text).toBe(
      '闭环控制通过位置检测形成反馈误差。',
    );
    expect(result.items[0]?.exact_span.char_start).toBe(
      10 + content.indexOf('闭环控制'),
    );
    expect(result.items[0]?.exact_span.char_end).toBe(
      10 +
        content.indexOf('闭环控制') +
        '闭环控制通过位置检测形成反馈误差。'.length,
    );
  });
  it('enforces token budget and a source quota while preserving exact spans', () => {
    const result = buildEvidenceContext(
      [
        fused('a1', 'file-a', 0, '数控系统概述', 1),
        fused('a2', 'file-a', 1, '伺服控制原理', 0.99),
        fused('a3', 'file-a', 2, '位置检测反馈', 0.98),
        fused('b1', 'file-b', 0, '闭环误差校正', 0.8),
      ],
      {
        top_k: 4,
        token_budget: 24,
        max_per_source: 2,
        query_embedding: null,
      },
    );

    expect(result.items.map((item) => item.chunk_id)).toContain('b1');
    expect(
      result.items.filter((item) => item.source.file_id === 'file-a'),
    ).toHaveLength(2);
    expect(result.used_tokens).toBeLessThanOrEqual(24);
    expect(result.items[0].exact_span).toEqual({
      text: '数控系统概述',
      char_start: 10,
      char_end: 16,
    });
    expect(result.items[0].source.heading_path).toEqual([
      '章-file-a',
      '标题-file-a',
    ]);
  });

  it('uses deterministic MMR ordering when vectors are unavailable', () => {
    const candidates = [
      fused('b', 'file-b', 0, '乙', 0.8),
      fused('a', 'file-a', 0, '甲', 0.8),
    ];

    expect(
      buildEvidenceContext(candidates, {
        top_k: 2,
        token_budget: 20,
        max_per_source: 2,
        query_embedding: null,
      }).items.map((item) => item.chunk_id),
    ).toEqual(['a', 'b']);
  });

  it('binds stable evidence references to run, chunk, and exact span', () => {
    const candidate = fused(
      'same-chunk',
      'file-a',
      0,
      '装机容量为300 MW。年发电量为12亿千瓦时。',
      1,
    );
    const build = (retrievalRunId: string, queryTerms: string[]) =>
      buildEvidenceContext([candidate], {
        top_k: 1,
        token_budget: 100,
        max_per_source: 2,
        query_embedding: null,
        query_terms: queryTerms,
        retrieval_run_id: retrievalRunId,
      }).items[0];

    const capacity = build('run-old', ['装机容量']);
    const capacityAgain = build('run-old', ['装机容量']);
    const generation = build('run-new', ['年发电量']);
    const otherRunCapacity = build('run-new', ['装机容量']);

    expect(capacity.evidence_id).toMatch(/^evidence:[a-f0-9]{64}$/u);
    expect(capacityAgain.evidence_id).toBe(capacity.evidence_id);
    expect(generation.evidence_id).not.toBe(capacity.evidence_id);
    expect(otherRunCapacity.evidence_id).not.toBe(capacity.evidence_id);
    expect(generation.exact_span.text).toBe('年发电量为12亿千瓦时。');
  });
});
