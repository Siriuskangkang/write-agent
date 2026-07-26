import { DenseIndexGcService } from './dense-index-gc.service.js';

describe('DenseIndexGcService', () => {
  it('records retention debt but never deletes a reactivatable stale namespace', async () => {
    const recorder = {
      claimGcBatch: jest.fn().mockResolvedValue([
        {
          id: 'index-b',
          file_id: 'file-1',
          namespace: 'index-b:attempt-b',
          gc_token: 'gc-b',
        },
      ]),
      validateGcClaim: jest.fn().mockResolvedValue(true),
      completeGcClaim: jest.fn().mockResolvedValue(true),
      releaseGcClaim: jest.fn(),
      recordRetentionDebtBatch: jest.fn().mockResolvedValue([
        {
          id: 'index-b',
          namespace: 'index-b:attempt-b',
          reason: 'REACTIVATABLE_NAMESPACE_RETAINED',
        },
      ]),
    };
    const qdrant = {
      deleteNamespace: jest.fn().mockResolvedValue(undefined),
    };
    const service = new DenseIndexGcService(recorder as never);

    await service.collect();

    expect(recorder.recordRetentionDebtBatch).toHaveBeenCalledWith(20);
    expect(qdrant.deleteNamespace).not.toHaveBeenCalled();
    expect(recorder.validateGcClaim).not.toHaveBeenCalled();
    expect(recorder.completeGcClaim).not.toHaveBeenCalled();
  });

  it('does not issue a delete even if an old GC validation would have passed before reactivation', async () => {
    const recorder = {
      claimGcBatch: jest.fn().mockResolvedValue([
        {
          id: 'index-c',
          file_id: 'file-1',
          namespace: 'index-c:attempt-c',
          gc_token: 'gc-c',
        },
      ]),
      validateGcClaim: jest.fn().mockResolvedValue(false),
      completeGcClaim: jest.fn(),
      releaseGcClaim: jest.fn(),
      recordRetentionDebtBatch: jest.fn().mockResolvedValue([]),
    };
    const qdrant = { deleteNamespace: jest.fn() };

    await new DenseIndexGcService(recorder as never).collect();

    expect(qdrant.deleteNamespace).not.toHaveBeenCalled();
    expect(recorder.completeGcClaim).not.toHaveBeenCalled();
    expect(recorder.recordRetentionDebtBatch).toHaveBeenCalledWith(20);
  });
});
