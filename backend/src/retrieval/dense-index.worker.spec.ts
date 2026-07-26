import { DenseIndexWorker } from './dense-index.worker.js';

describe('DenseIndexWorker', () => {
  it('indexes only the active ingestion child chunks', async () => {
    const recorder = {
      beginAttempt: jest.fn().mockResolvedValue({
        id: 'index-1',
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'document-1',
        ingestion_key: 'ingestion-1',
        chunk_version: 'parent-child-v1',
        status: 'QUEUED',
        attempt_token: 'claim-1',
        attempt_count: 2,
      }),
    };
    const chunkRepository = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'chunk-1',
          content: '闭环控制',
          chunk_type: 'child',
        },
      ]),
    };
    const indexer = { index: jest.fn().mockResolvedValue(undefined) };
    const worker = new DenseIndexWorker(
      recorder as never,
      chunkRepository as never,
      indexer as never,
    );

    await worker.handle({
      data: {
        indexVersionId: 'index-1',
        attemptToken: 'claim-1',
        attempt: 2,
      },
    } as never);

    expect(chunkRepository.find).toHaveBeenCalledWith({
      where: {
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'document-1',
        ingestion_key: 'ingestion-1',
        is_active: true,
        chunk_type: 'child',
      },
      order: { position: 'ASC' },
    });
    expect(indexer.index).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestion_key: 'ingestion-1',
        record_id: 'index-1',
        attempt_token: 'claim-1',
        chunks: [
          {
            id: 'chunk-1',
            content: '闭环控制',
            chunk_type: 'child',
          },
        ],
      }),
      expect.any(AbortSignal),
    );
  });

  it('ignores an obsolete or expired claim without publishing stale points', async () => {
    const recorder = {
      beginAttempt: jest.fn().mockResolvedValue(null),
    };
    const indexer = { index: jest.fn() };
    const worker = new DenseIndexWorker(
      recorder as never,
      { find: jest.fn() } as never,
      indexer as never,
    );

    await worker.handle({
      data: {
        indexVersionId: 'index-1',
        attemptToken: 'stale-claim',
        attempt: 1,
      },
    } as never);

    expect(recorder.beginAttempt).toHaveBeenCalledWith(
      'index-1',
      'stale-claim',
    );
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it('renews the database-clock lease while indexing and aborts after losing the lease', async () => {
    jest.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    let finishIndex!: () => void;
    const pendingIndex = new Promise<void>((resolve) => {
      finishIndex = resolve;
    });
    const recorder = {
      beginAttempt: jest.fn().mockResolvedValue({
        id: 'index-1',
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'document-1',
        ingestion_key: 'ingestion-1',
        chunk_version: 'parent-child-v1',
        status: 'RUNNING',
        attempt_token: 'claim-1',
        attempt_count: 1,
      }),
      renewAttemptLease: jest.fn().mockResolvedValue(false),
    };
    const indexer = {
      index: jest
        .fn()
        .mockImplementation((_input: unknown, signal: AbortSignal) => {
          observedSignal = signal;
          return pendingIndex;
        }),
    };
    const worker = new DenseIndexWorker(
      recorder as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      indexer as never,
      10,
    );

    const handling = worker.handle({
      data: {
        indexVersionId: 'index-1',
        attemptToken: 'claim-1',
        attempt: 1,
      },
    } as never);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);

    expect(recorder.renewAttemptLease).toHaveBeenCalledWith(
      'index-1',
      'claim-1',
    );
    expect(observedSignal?.aborted).toBe(true);
    finishIndex();
    await handling;
    jest.useRealTimers();
  });
});
