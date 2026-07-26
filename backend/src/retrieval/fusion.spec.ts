import { reciprocalRankFusion } from './fusion.js';
import type { RetrievalCandidate } from './types.js';

function candidate(
  chunk_id: string,
  source: 'sparse' | 'dense',
  score: number,
): RetrievalCandidate {
  return {
    chunk_id,
    file_id: `${chunk_id}-file`,
    document_id: `${chunk_id}-document`,
    project_id: 'project',
    ingestion_key: 'v1',
    content: chunk_id,
    section_title: null,
    heading_path: [],
    page_start: null,
    page_end: null,
    char_start: 0,
    char_end: chunk_id.length,
    position: 0,
    token_count: 1,
    source,
    source_score: score,
  };
}

describe('reciprocalRankFusion', () => {
  it('fuses sparse and dense ranks and resolves ties by chunk id', () => {
    const result = reciprocalRankFusion(
      [candidate('b', 'sparse', 10), candidate('a', 'sparse', 9)],
      [candidate('a', 'dense', 0.9), candidate('b', 'dense', 0.8)],
      60,
    );

    expect(result.map((item) => item.chunk_id)).toEqual(['a', 'b']);
    expect(result[0]).toMatchObject({
      sparse_rank: 2,
      dense_rank: 1,
    });
    expect(result[0].fusion_score).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it('does not let raw score scales change rank-based fusion', () => {
    const first = reciprocalRankFusion(
      [candidate('a', 'sparse', 1_000_000)],
      [candidate('b', 'dense', 0.0001)],
      60,
    );
    const second = reciprocalRankFusion(
      [candidate('a', 'sparse', 1)],
      [candidate('b', 'dense', 100)],
      60,
    );

    expect(first.map((item) => [item.chunk_id, item.fusion_score])).toEqual(
      second.map((item) => [item.chunk_id, item.fusion_score]),
    );
  });
});
