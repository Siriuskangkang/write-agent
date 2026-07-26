import { DenseIndexDispatcher } from './dense-index.dispatcher.js';

describe('DenseIndexDispatcher', () => {
  it('publishes a unique durable attempt job from a database claim', async () => {
    const recorder = {
      claimDispatchBatch: jest.fn().mockResolvedValue([
        {
          id: 'index-1',
          file_id: 'file-1',
          document_id: 'document-1',
          ingestion_key: 'ingestion-1',
          status: 'PENDING',
          attempt_token: 'claim-1',
          attempt_count: 2,
        },
      ]),
      releaseDispatchClaim: jest.fn(),
    };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = new DenseIndexDispatcher(
      recorder as never,
      queue as never,
    );

    await dispatcher.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      'index',
      {
        indexVersionId: 'index-1',
        attemptToken: 'claim-1',
        attempt: 2,
      },
      expect.objectContaining({
        jobId: 'dense-index:index-1:2:claim-1',
        attempts: 1,
        removeOnComplete: true,
      }),
    );
    expect(recorder.releaseDispatchClaim).not.toHaveBeenCalled();
  });

  it('leaves the row retryable when Redis publish fails', async () => {
    const recorder = {
      claimDispatchBatch: jest.fn().mockResolvedValue([
        {
          id: 'index-1',
          status: 'QUEUED',
          attempt_token: 'claim-2',
          attempt_count: 3,
        },
      ]),
      releaseDispatchClaim: jest.fn(),
    };
    const dispatcher = new DenseIndexDispatcher(
      recorder as never,
      {
        add: jest.fn().mockRejectedValue(new Error('redis down')),
      } as never,
    );

    await dispatcher.dispatchPending();

    expect(recorder.releaseDispatchClaim).toHaveBeenCalledWith(
      'index-1',
      'claim-2',
      'redis down',
    );
  });
});
