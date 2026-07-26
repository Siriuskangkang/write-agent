import { IndexActivationRecorder } from './index-activation-recorder.js';

describe('IndexActivationRecorder', () => {
  it('stages one durable PENDING index version inside the ingestion transaction', async () => {
    const observedCalls: Array<{ sql: string; parameters: unknown[] }> = [];
    const queryMock = jest.fn();
    const query = (
      sql: string,
      parameters: unknown[],
    ): Promise<{ affectedRows: number }> => {
      observedCalls.push({ sql, parameters });
      queryMock();
      return Promise.resolve({ affectedRows: 1 });
    };
    const manager = { query };
    const recorder = new IndexActivationRecorder({
      get: (key: string, fallback?: unknown) =>
        ({
          RAG_INDEX_VERSION: 'rag-v1',
          QDRANT_COLLECTION: 'write_agent_chunks',
          EMBEDDING_MODEL: 'embedding-v1',
          EMBEDDING_DIMENSION: 3,
        })[key] ?? fallback,
    } as never);
    const input = {
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-1',
      ingestion_key: 'a'.repeat(64),
      chunk_version: 'parent-child-v1',
    };

    await recorder.stage(manager as never, input);
    await recorder.stage(manager as never, input);

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(observedCalls[0]?.sql).toContain('INSERT IGNORE');
    expect(observedCalls[0]?.sql).toContain('retrieval_index_versions');
    expect(observedCalls[0]?.parameters).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'project-1',
      'file-1',
      'document-1',
      'a'.repeat(64),
      'parent-child-v1',
      'rag-v1',
      'write_agent_chunks',
      'embedding-v1',
      3,
    ]);
  });
});
