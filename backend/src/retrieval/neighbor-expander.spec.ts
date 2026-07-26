import { NeighborExpander } from './neighbor-expander.js';
import type { FusedCandidate } from './types.js';

function seed(overrides: Partial<FusedCandidate> = {}): FusedCandidate {
  return {
    chunk_id: 'seed-1',
    project_id: 'project-1',
    file_id: 'file-1',
    document_id: 'document-1',
    ingestion_key: 'ingestion-1',
    content: '闭环控制由给定、比较和反馈环节组成。',
    section_title: '闭环控制',
    heading_path: ['第三章', '闭环控制'],
    page_start: 10,
    page_end: 10,
    char_start: 100,
    char_end: 119,
    position: 4,
    token_count: 19,
    source: 'sparse',
    source_score: 2,
    sparse_rank: 1,
    sparse_score: 2,
    dense_rank: null,
    dense_score: null,
    fusion_score: 0.016,
    fusion_rank: 1,
    rerank_score: 1.016,
    rerank_rank: 1,
    ...overrides,
  };
}

describe('NeighborExpander', () => {
  it('loads only active child chunks adjacent to the strongest seed', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          chunk_id: 'neighbor-previous',
          project_id: 'project-1',
          file_id: 'file-1',
          document_id: 'document-1',
          ingestion_key: 'ingestion-1',
          content: '前一块解释反馈信号。',
          section_title: '闭环控制',
          heading_path: JSON.stringify(['第三章', '闭环控制']),
          page_start: 9,
          page_end: 9,
          char_start: 80,
          char_end: 90,
          position: 3,
          token_count: 10,
        },
      ]),
    };
    const expander = new NeighborExpander(dataSource as never);

    const expanded = await expander.expand('project-1', [
      seed(),
      seed({ chunk_id: 'seed-2', position: 9, rerank_rank: 2 }),
    ]);

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("c.chunk_type = 'child'"),
      expect.arrayContaining(['project-1', 'document-1', 3, 5]),
    );
    expect(expanded.map((item) => item.chunk_id)).toEqual([
      'seed-1',
      'seed-2',
      'neighbor-previous',
    ]);
    expect(expanded[2]).toMatchObject({
      source: 'neighbor',
      sparse_rank: null,
      dense_rank: null,
      rerank_rank: 3,
    });
  });

  it('does not duplicate a neighbor already present in fused results', async () => {
    const existing = seed({
      chunk_id: 'already-fused',
      position: 3,
      rerank_rank: 2,
      fusion_rank: 2,
    });
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          chunk_id: 'already-fused',
          project_id: 'project-1',
          file_id: 'file-1',
          document_id: 'document-1',
          ingestion_key: 'ingestion-1',
          content: existing.content,
          section_title: existing.section_title,
          heading_path: existing.heading_path,
          page_start: 9,
          page_end: 9,
          char_start: 80,
          char_end: 90,
          position: 3,
          token_count: 10,
        },
      ]),
    };

    const expanded = await new NeighborExpander(dataSource as never).expand(
      'project-1',
      [seed(), existing],
    );

    expect(expanded).toHaveLength(2);
  });
});
