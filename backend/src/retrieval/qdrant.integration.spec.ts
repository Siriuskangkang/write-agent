import { randomUUID } from 'node:crypto';
import { QdrantSchemaMismatchError, QdrantService } from './qdrant.service.js';

const qdrantDescribe =
  process.env.QDRANT_INTEGRATION_TEST === '1' ? describe : describe.skip;

jest.setTimeout(60_000);

qdrantDescribe('Qdrant 1.13 dense index integration', () => {
  const baseUrl = process.env.QDRANT_TEST_URL || 'http://127.0.0.1:6333';
  const collection = `write_agent_test_${randomUUID().replaceAll('-', '')}`;
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({
        QDRANT_URL: baseUrl,
        QDRANT_COLLECTION: collection,
        QDRANT_TIMEOUT_MS: 5_000,
        EMBEDDING_DIMENSION: 3,
        RAG_INDEX_VERSION: 'rag-test-v1',
      })[key] ?? fallback,
  };

  afterAll(async () => {
    await fetch(`${baseUrl}/collections/${collection}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  });

  it('idempotently upserts, filters and removes stale ingestion points', async () => {
    const service = new QdrantService(config as never);
    const firstId = '11111111-1111-4111-8111-111111111111';
    const staleId = '22222222-2222-4222-8222-222222222222';
    await service.upsertAttempt([
      point(firstId, 'ingestion-v1', [1, 0, 0]),
      point(staleId, 'ingestion-v1', [0.9, 0.1, 0]),
    ]);
    await service.upsertAttempt([point(firstId, 'ingestion-v2', [1, 0, 0])]);
    await service.upsertAttempt([point(firstId, 'ingestion-v2', [1, 0, 0])]);
    await service.deleteNamespace('index-old:attempt-old');

    const results = await service.search('project-1', [1, 0, 0], 40, [
      'index-ready:attempt-ready',
    ]);
    expect(results.map((result) => result.payload.chunk_id)).toEqual([firstId]);
    expect(results[0].payload).toMatchObject({
      ingestion_key: 'ingestion-v2',
      index_version: 'rag-test-v1',
    });
  });

  it('detects dimension drift before querying an existing collection', async () => {
    const mismatched = new QdrantService({
      get: (key: string, fallback?: unknown) =>
        ({
          QDRANT_URL: baseUrl,
          QDRANT_COLLECTION: collection,
          QDRANT_TIMEOUT_MS: 5_000,
          EMBEDDING_DIMENSION: 2,
          RAG_INDEX_VERSION: 'rag-test-v1',
        })[key] ?? fallback,
    } as never);

    await expect(mismatched.ensureCollection()).rejects.toBeInstanceOf(
      QdrantSchemaMismatchError,
    );
  });
});

function point(id: string, ingestionKey: string, vector: number[]) {
  const current = ingestionKey === 'ingestion-v2';
  return {
    id: current ? id.replace(/^[0-9a-f]{8}/, 'aaaaaaaa') : id,
    vector,
    payload: {
      chunk_id: id,
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-1',
      ingestion_key: ingestionKey,
      chunk_version: 'parent-child-v1',
      index_version: 'rag-test-v1',
      chunk_type: 'child' as const,
      is_active: true,
      index_record_id: current ? 'index-ready' : 'index-old',
      attempt_token: current ? 'attempt-ready' : 'attempt-old',
      index_namespace: current
        ? 'index-ready:attempt-ready'
        : 'index-old:attempt-old',
    },
  };
}
