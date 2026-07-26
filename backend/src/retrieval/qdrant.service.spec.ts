import { QdrantSchemaMismatchError, QdrantService } from './qdrant.service.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(call: Parameters<typeof fetch>): unknown {
  const body = call[1]?.body;
  if (typeof body !== 'string') {
    throw new Error('Expected a JSON string request body');
  }
  const parsed: unknown = JSON.parse(body);
  return parsed;
}

describe('QdrantService', () => {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      const values: Record<string, unknown> = {
        QDRANT_URL: 'http://qdrant.test:6333',
        QDRANT_COLLECTION: 'write_agent_chunks',
        QDRANT_API_KEY: '',
        QDRANT_TIMEOUT_MS: 2_000,
        EMBEDDING_DIMENSION: 3,
        RAG_INDEX_VERSION: 'rag-v1',
      };
      return values[key] ?? fallback;
    }),
  };

  afterEach(() => jest.restoreAllMocks());

  it('creates a missing Cosine collection and waits for batch upsert', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(404, { status: 'not found' }))
      .mockResolvedValueOnce(response(200, { status: 'ok', result: true }))
      .mockResolvedValueOnce(
        response(200, { status: 'ok', result: { status: 'completed' } }),
      );
    const service = new QdrantService(config as never);

    await service.upsert([
      {
        id: '11111111-1111-4111-8111-111111111111',
        vector: [1, 0, 0],
        payload: {
          project_id: 'project-1',
          file_id: 'file-1',
          document_id: 'document-1',
          ingestion_key: 'ingestion-v1',
          chunk_version: 'parent-child-v1',
          index_version: 'rag-v1',
          chunk_type: 'child',
          is_active: true,
          index_record_id: 'index-1',
          attempt_token: 'attempt-1',
          index_namespace: 'index-1:attempt-1',
        },
      },
    ]);

    expect(fetchSpy.mock.calls[1][0]).toBe(
      'http://qdrant.test:6333/collections/write_agent_chunks',
    );
    expect(requestBody(fetchSpy.mock.calls[1])).toEqual({
      vectors: { size: 3, distance: 'Cosine' },
      on_disk_payload: true,
    });
    expect(fetchSpy.mock.calls[2][0]).toContain('/points?wait=true');
  });

  it('rejects an existing collection with the wrong vector dimension', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      response(200, {
        status: 'ok',
        result: {
          config: {
            params: { vectors: { size: 2, distance: 'Cosine' } },
          },
        },
      }),
    );
    const service = new QdrantService(config as never);

    await expect(service.ensureCollection()).rejects.toBeInstanceOf(
      QdrantSchemaMismatchError,
    );
  });

  it('deletes only the exact namespace selected by durable GC', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(200, {
          status: 'ok',
          result: {
            config: {
              params: { vectors: { size: 3, distance: 'Cosine' } },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        response(200, { status: 'ok', result: { status: 'completed' } }),
      )
      .mockResolvedValueOnce(
        response(200, { status: 'ok', result: { status: 'completed' } }),
      );
    const service = new QdrantService(config as never);

    await service.upsertAttempt([
      {
        id: '11111111-1111-4111-8111-111111111111',
        vector: [1, 0, 0],
        payload: {
          project_id: 'project-1',
          file_id: 'file-1',
          document_id: 'document-2',
          ingestion_key: 'ingestion-v2',
          chunk_version: 'parent-child-v1',
          index_version: 'rag-v1',
          chunk_type: 'child',
          is_active: true,
          index_record_id: 'index-2',
          attempt_token: 'attempt-2',
          index_namespace: 'index-2:attempt-2',
        },
      },
    ]);
    await service.deleteNamespace('index-old:attempt-old');

    expect(fetchSpy.mock.calls[1][0]).toContain('/points?wait=true');
    expect(requestBody(fetchSpy.mock.calls[2])).toMatchObject({
      filter: {
        must: [
          {
            key: 'index_namespace',
            match: { value: 'index-old:attempt-old' },
          },
        ],
      },
    });
  });

  it('searches only active project children in the configured index version', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        response(200, {
          status: 'ok',
          result: {
            config: {
              params: { vectors: { size: 3, distance: 'Cosine' } },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        response(200, {
          status: 'ok',
          result: {
            points: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                score: 0.9,
                payload: { chunk_id: 'chunk-1' },
                vector: [0, 1, 0],
              },
            ],
          },
        }),
      );
    const service = new QdrantService(config as never);

    const result = await service.search('project-1', [1, 0, 0], 40, [
      'index-1',
    ]);

    expect(result).toHaveLength(1);
    const searchBody = JSON.stringify(requestBody(fetchSpy.mock.calls[1]));
    expect(searchBody).toContain(
      JSON.stringify({ key: 'project_id', match: { value: 'project-1' } }),
    );
    expect(searchBody).toContain(
      JSON.stringify({ key: 'index_version', match: { value: 'rag-v1' } }),
    );
    expect(searchBody).toContain(
      JSON.stringify({ key: 'chunk_type', match: { value: 'child' } }),
    );
    expect(searchBody).toContain(
      JSON.stringify({ key: 'is_active', match: { value: true } }),
    );
    expect(searchBody).toContain('"with_payload":true');
    expect(searchBody).toContain('"with_vector":true');
    expect(result[0]?.vector).toEqual([0, 1, 0]);
  });
});
