import { DenseIndexService } from './dense-index.service.js';
import type { QdrantPoint } from './qdrant.service.js';

describe('DenseIndexService', () => {
  it('does not publish or delete points when an old attempt loses its fence while embedding', async () => {
    let resolveEmbedding!: (value: number[][]) => void;
    const embedding = new Promise<number[][]>((resolve) => {
      resolveEmbedding = resolve;
    });
    const qdrant = {
      configuredIndexVersion: 'rag-v1',
      upsertAttempt: jest.fn(),
      deleteOtherAttempts: jest.fn(),
    };
    const recorder = {
      isAttemptActive: jest.fn().mockResolvedValue(false),
      attemptFenceState: jest.fn().mockResolvedValue('STALE_INGESTION'),
      markReady: jest.fn(),
      markFailed: jest.fn(),
    };
    const service = new DenseIndexService(
      { generateEmbeddings: jest.fn().mockReturnValue(embedding) } as never,
      qdrant as never,
      recorder as never,
    );

    const indexing = service.index({
      record_id: 'index-a',
      attempt_token: 'attempt-a',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-a',
      ingestion_key: 'ingestion-a',
      chunk_version: 'chunk-v1',
      chunks: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          content: '旧版本',
          chunk_type: 'child',
        },
      ],
    });
    resolveEmbedding([[1, 0, 0]]);

    await expect(indexing).resolves.toBeUndefined();
    expect(qdrant.upsertAttempt).not.toHaveBeenCalled();
    expect(qdrant.deleteOtherAttempts).not.toHaveBeenCalled();
    expect(recorder.markReady).not.toHaveBeenCalled();
    expect(recorder.markFailed).toHaveBeenCalledWith(
      'index-a',
      'attempt-a',
      expect.objectContaining({ error_code: 'STALE_INGESTION' }),
    );
  });

  it('keeps a late orphan namespace invisible when the fence is lost after Qdrant upsert', async () => {
    const qdrant = {
      configuredIndexVersion: 'rag-v1',
      upsertAttempt: jest.fn().mockResolvedValue(undefined),
      deleteOtherAttempts: jest.fn(),
    };
    const recorder = {
      isAttemptActive: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      attemptFenceState: jest.fn().mockResolvedValue('LEASE_EXPIRED'),
      markReady: jest.fn(),
      markFailed: jest.fn(),
    };
    const service = new DenseIndexService(
      {
        generateEmbeddings: jest.fn().mockResolvedValue([[1, 0, 0]]),
      } as never,
      qdrant as never,
      recorder as never,
    );

    await service.index({
      record_id: 'index-a',
      attempt_token: 'attempt-a',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-a',
      ingestion_key: 'ingestion-a',
      chunk_version: 'chunk-v1',
      chunks: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          content: '旧版本',
          chunk_type: 'child',
        },
      ],
    });

    expect(qdrant.upsertAttempt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          id: expect.not.stringMatching(
            /^11111111-1111-4111-8111-111111111111$/,
          ),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          payload: expect.objectContaining({
            chunk_id: '11111111-1111-4111-8111-111111111111',
            index_record_id: 'index-a',
            attempt_token: 'attempt-a',
            index_namespace: 'index-a:attempt-a',
          }),
        }),
      ]),
    );
    expect(recorder.markReady).not.toHaveBeenCalled();
    expect(recorder.markFailed).toHaveBeenCalledWith(
      'index-a',
      'attempt-a',
      expect.objectContaining({ error_code: 'LEASE_EXPIRED' }),
    );
    expect(qdrant.deleteOtherAttempts).not.toHaveBeenCalled();
  });

  it('publishes READY without deleting any other attempt namespace', async () => {
    const order: string[] = [];
    const qdrant = {
      configuredIndexVersion: 'rag-v1',
      upsertAttempt: jest.fn().mockImplementation(() => {
        order.push('upsert');
        return Promise.resolve(undefined);
      }),
      deleteOtherAttempts: jest.fn(),
    };
    const recorder = {
      isAttemptActive: jest.fn().mockResolvedValue(true),
      markReady: jest.fn().mockImplementation(() => {
        order.push('ready');
        return Promise.resolve(true);
      }),
      markFailed: jest.fn(),
    };
    const service = new DenseIndexService(
      {
        generateEmbeddings: jest.fn().mockResolvedValue([[1, 0, 0]]),
      } as never,
      qdrant as never,
      recorder as never,
    );

    await service.index({
      record_id: 'index-b',
      attempt_token: 'attempt-b',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-b',
      ingestion_key: 'ingestion-b',
      chunk_version: 'chunk-v1',
      chunks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          content: '新版本',
          chunk_type: 'child',
        },
      ],
    });

    expect(order).toEqual(['upsert', 'ready']);
    expect(qdrant.deleteOtherAttempts).not.toHaveBeenCalled();
  });
  it('batch-upserts deterministic attempt point ids with rebuildable payload', async () => {
    let observedPoints: QdrantPoint[] = [];
    const upsertAttempt = (points: QdrantPoint[]): Promise<void> => {
      observedPoints = points;
      return Promise.resolve(undefined);
    };
    const qdrant = {
      configuredIndexVersion: 'rag-v1',
      upsertAttempt: jest.fn(upsertAttempt),
      deleteOtherAttempts: jest.fn().mockResolvedValue(undefined),
    };
    const recorder = {
      isAttemptActive: jest.fn().mockResolvedValue(true),
      markReady: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    const service = new DenseIndexService(
      {
        generateEmbeddings: jest.fn().mockResolvedValue([
          [1, 0, 0],
          [0, 1, 0],
        ]),
      } as never,
      qdrant as never,
      recorder as never,
    );
    const input = {
      record_id: 'index-record-1',
      attempt_token: 'attempt-1',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-1',
      ingestion_key: 'ingestion-v2',
      chunk_version: 'parent-child-v1',
      chunks: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          content: '第一条素材',
          chunk_type: 'child' as const,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          content: '第二条素材',
          chunk_type: 'child' as const,
        },
      ],
    };

    await service.index(input);
    await service.index(input);

    expect(qdrant.upsertAttempt).toHaveBeenCalledTimes(2);
    expect(observedPoints).toEqual([
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: expect.any(String),
        payload: {
          chunk_id: '11111111-1111-4111-8111-111111111111',
          project_id: 'project-1',
          file_id: 'file-1',
          document_id: 'document-1',
          ingestion_key: 'ingestion-v2',
          chunk_version: 'parent-child-v1',
          index_version: 'rag-v1',
          chunk_type: 'child',
          is_active: true,
          index_record_id: 'index-record-1',
          attempt_token: 'attempt-1',
          index_namespace: 'index-record-1:attempt-1',
        },
      }),
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        id: expect.any(String),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({
          chunk_id: '22222222-2222-4222-8222-222222222222',
        }),
      }),
    ]);
    const firstPoint = observedPoints[0];
    if (!firstPoint) throw new Error('Expected at least one indexed point');
    const payload = firstPoint.payload;
    expect(payload).not.toHaveProperty('content');
    expect(recorder.markReady).toHaveBeenCalledWith(
      'index-record-1',
      'attempt-1',
      expect.objectContaining({ point_count: 2 }),
    );
  });

  it('fails the index version instead of publishing partial null embeddings', async () => {
    const qdrant = {
      configuredIndexVersion: 'rag-v1',
      upsertAttempt: jest.fn(),
      deleteOtherAttempts: jest.fn(),
    };
    const recorder = {
      isAttemptActive: jest.fn().mockResolvedValue(true),
      markReady: jest.fn(),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    const service = new DenseIndexService(
      {
        generateEmbeddings: jest.fn().mockResolvedValue([[1, 0], null]),
      } as never,
      qdrant as never,
      recorder as never,
    );

    await expect(
      service.index({
        record_id: 'index-record-1',
        attempt_token: 'attempt-1',
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'document-1',
        ingestion_key: 'v2',
        chunk_version: 'parent-child-v1',
        chunks: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            content: '第一条',
            chunk_type: 'child',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            content: '第二条',
            chunk_type: 'child',
          },
        ],
      }),
    ).rejects.toThrow('2 chunks');
    expect(qdrant.upsertAttempt).not.toHaveBeenCalled();
    expect(recorder.markFailed).toHaveBeenCalled();
  });
});
