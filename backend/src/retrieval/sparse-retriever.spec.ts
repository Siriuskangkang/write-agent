import { SparseRetriever } from './sparse-retriever.js';

describe('SparseRetriever', () => {
  it('uses MySQL FULLTEXT over active child content and headings, never LIKE', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const retriever = new SparseRetriever({ query } as never);

    await retriever.search({
      project_id: 'project-1',
      sparse_query: '数控机床 闭环控制',
      limit: 40,
    });

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('MATCH(c.search_text) AGAINST(? IN BOOLEAN MODE)');
    expect(sql).toContain("c.chunk_type = 'child'");
    expect(sql).toContain('c.is_active = 1');
    expect(sql.toUpperCase()).not.toContain(' LIKE ');
    expect(params).toEqual([
      '数控机床 闭环控制',
      '数控机床 闭环控制',
      'project-1',
      40,
    ]);
  });
});
