import { DenseRetriever, type DenseChunkRow } from './dense-retriever.js';
import { QdrantSchemaMismatchError } from './qdrant.service.js';

const request = {
  project_id: 'project-1',
  task_type: 'content' as const,
  intent: 'explanation' as const,
  original_query: '闭环控制',
  sparse_query: '闭环控制',
  dense_query: '闭环控制 原理',
  terms: ['闭环控制'],
  limit: 40,
};

describe('DenseRetriever', () => {
  it('degrades before search when an active ingestion has no READY dense index', async () => {
    const qdrant = { search: jest.fn() };
    const database = {
      query: jest.fn().mockResolvedValue([
        {
          id: null,
          file_id: 'file-1',
          ingestion_key: 'active-a',
          status: 'PENDING',
          index_version: null,
          collection_name: null,
          embedding_model: null,
          embedding_dimension: null,
        },
      ]),
    };
    const retriever = new DenseRetriever(
      {
        generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
      } as never,
      qdrant as never,
      database as never,
    );

    await expect(retriever.search(request)).resolves.toMatchObject({
      state: 'unavailable',
      error_code: 'DENSE_INDEX_COVERAGE_INCOMPLETE',
      index_versions: [
        expect.objectContaining({
          id: null,
          file_id: 'file-1',
          status: 'MISSING',
        }),
      ],
    });
    expect(qdrant.search).not.toHaveBeenCalled();
  });

  it('degrades when READY metadata has fewer physical Qdrant points than expected', async () => {
    const qdrant = {
      countNamespaces: jest
        .fn()
        .mockResolvedValue(new Map([['index-ready:attempt-1', 0]])),
      search: jest.fn(),
      configuredIndexVersion: 'rag-v1',
    };
    const retriever = new DenseRetriever(
      {
        generateEmbeddingDetailed: jest.fn(),
      } as never,
      qdrant as never,
      {
        query: jest.fn().mockResolvedValue([
          {
            id: 'index-ready',
            file_id: 'file-1',
            ingestion_key: 'active-a',
            status: 'READY',
            index_version: 'rag-v1',
            collection_name: 'chunks',
            embedding_model: 'model',
            embedding_dimension: 3,
            published_namespace: 'index-ready:attempt-1',
            point_count: 1,
          },
        ]),
      } as never,
    );

    await expect(retriever.search(request)).resolves.toMatchObject({
      candidates: [],
      state: 'unavailable',
      error_code: 'INDEX_POINTS_MISSING',
      index_versions: [
        {
          id: 'index-ready',
          status: 'READY',
          expected_point_count: 1,
          observed_point_count: 0,
        },
      ],
    });
    expect(qdrant.search).not.toHaveBeenCalled();
  });

  it('degrades when an allowlisted non-empty READY namespace returns no nearest neighbor after coverage count', async () => {
    const qdrant = {
      countNamespaces: jest
        .fn()
        .mockResolvedValue(new Map([['index-ready:attempt-1', 1]])),
      search: jest.fn().mockResolvedValue([]),
      configuredIndexVersion: 'rag-v1',
    };
    const retriever = new DenseRetriever(
      {
        generateEmbeddingDetailed: jest.fn().mockResolvedValue({
          vector: [1, 0, 0],
          usage: null,
        }),
      } as never,
      qdrant as never,
      {
        query: jest.fn().mockResolvedValue([
          {
            id: 'index-ready',
            file_id: 'file-1',
            ingestion_key: 'active-a',
            status: 'READY',
            index_version: 'rag-v1',
            collection_name: 'chunks',
            embedding_model: 'model',
            embedding_dimension: 3,
            published_namespace: 'index-ready:attempt-1',
            point_count: 1,
          },
        ]),
      } as never,
    );

    await expect(retriever.search(request)).resolves.toMatchObject({
      candidates: [],
      state: 'unavailable',
      error_code: 'INDEX_POINTS_MISSING',
      index_versions: [
        {
          id: 'index-ready',
          status: 'READY',
          expected_point_count: 1,
          observed_point_count: 0,
        },
      ],
    });
  });

  it('hydrates the document vector returned by Qdrant for downstream MMR', async () => {
    const database = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'index-ready',
            file_id: 'file-1',
            ingestion_key: 'active-a',
            status: 'READY',
            index_version: 'rag-v1',
            collection_name: 'chunks',
            embedding_model: 'model',
            embedding_dimension: 3,
            published_namespace: 'index-ready:attempt-1',
          },
        ])
        .mockResolvedValueOnce([
          {
            chunk_id: 'chunk-1',
            project_id: 'project-1',
            file_id: 'file-1',
            document_id: 'doc-1',
            ingestion_key: 'active-a',
            content: '证据',
            section_title: null,
            heading_path: [],
            page_start: 1,
            page_end: 1,
            char_start: 0,
            char_end: 2,
            position: 0,
            token_count: 2,
            file_name: '教材.pdf',
            keywords: ['证据'],
          },
        ]),
    };
    const retriever = new DenseRetriever(
      {
        generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
      } as never,
      {
        search: jest.fn().mockResolvedValue([
          {
            id: 'point-attempt-1',
            score: 0.8,
            payload: { chunk_id: 'chunk-1' },
            vector: [0, 1, 0],
          },
        ]),
      } as never,
      database as never,
    );

    const result = await retriever.search(request);

    expect(result.candidates[0]?.embedding).toEqual([0, 1, 0]);
  });
  it('reports unavailable when no embedding can be generated', async () => {
    const qdrant = { search: jest.fn() };
    const retriever = new DenseRetriever(
      { generateEmbedding: jest.fn().mockResolvedValue(null) } as never,
      qdrant as never,
      { query: jest.fn().mockResolvedValue([]) } as never,
    );

    await expect(retriever.search(request)).resolves.toMatchObject({
      candidates: [],
      state: 'unavailable',
      error_code: 'EMBEDDING_UNAVAILABLE',
      query_embedding: null,
    });
    expect(qdrant.search).not.toHaveBeenCalled();
  });

  it('turns Qdrant schema drift into an explicit degraded reason', async () => {
    const retriever = new DenseRetriever(
      {
        generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
      } as never,
      {
        search: jest
          .fn()
          .mockRejectedValue(new QdrantSchemaMismatchError('wrong dimension')),
      } as never,
      { query: jest.fn().mockResolvedValue([]) } as never,
    );

    await expect(retriever.search(request)).resolves.toMatchObject({
      candidates: [],
      state: 'unavailable',
      error_code: 'QDRANT_SCHEMA_MISMATCH',
    });
  });

  it('hydrates only active MySQL chunks and preserves Qdrant rank', async () => {
    const rows: DenseChunkRow[] = [
      {
        chunk_id: '22222222-2222-4222-8222-222222222222',
        project_id: 'project-1',
        file_id: 'file-2',
        document_id: 'doc-2',
        ingestion_key: 'v1',
        content: '第二条',
        section_title: '第二节',
        heading_path: ['第一章', '第二节'],
        page_start: 2,
        page_end: 2,
        char_start: 10,
        char_end: 13,
        position: 1,
        token_count: 3,
      },
      {
        chunk_id: '11111111-1111-4111-8111-111111111111',
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'doc-1',
        ingestion_key: 'v1',
        content: '第一条',
        section_title: '第一节',
        heading_path: ['第一章', '第一节'],
        page_start: 1,
        page_end: 1,
        char_start: 0,
        char_end: 3,
        position: 0,
        token_count: 3,
      },
    ];
    let observedSql = '';
    const query = (sql: string): Promise<unknown[]> => {
      observedSql = sql;
      if (sql.includes('FROM source_files sf')) {
        return Promise.resolve([
          {
            id: 'index-ready',
            file_id: 'file-1',
            ingestion_key: 'v1',
            status: 'READY',
            index_version: 'rag-v1',
            collection_name: 'chunks',
            embedding_model: 'model',
            embedding_dimension: 3,
            published_namespace: 'index-ready:attempt-1',
          },
        ]);
      }
      return Promise.resolve(rows);
    };
    const database = { query };
    const retriever = new DenseRetriever(
      {
        generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
      } as never,
      {
        search: jest.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            score: 0.95,
            payload: {
              chunk_id: '11111111-1111-4111-8111-111111111111',
            },
            vector: [1, 0, 0],
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            score: 0.9,
            payload: {
              chunk_id: '22222222-2222-4222-8222-222222222222',
            },
            vector: [0, 1, 0],
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            score: 0.8,
            payload: {
              chunk_id: '33333333-3333-4333-8333-333333333333',
            },
            vector: [0, 0, 1],
          },
        ]),
      } as never,
      database as never,
    );

    const result = await retriever.search(request);

    expect(result.state).toBe('ready');
    expect(result.candidates.map((item) => item.chunk_id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(result.candidates.map((item) => item.source_score)).toEqual([
      0.95, 0.9,
    ]);
    expect(observedSql).toContain('c.is_active = 1');
    expect(observedSql).toContain("c.chunk_type = 'child'");
  });
});
