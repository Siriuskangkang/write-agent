import type { DataSource } from 'typeorm';
import type { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowRecoveryDispatcher } from './workflow-recovery.dispatcher.js';

describe('WorkflowRecoveryDispatcher', () => {
  it('redelivers queued and expired durable jobs without changing their state', async () => {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValue([
          { id: '11111111-1111-4111-8111-111111111111' },
          { id: '22222222-2222-4222-8222-222222222222' },
        ]),
    };
    const dispatch = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const recovery = new WorkflowRecoveryDispatcher(
      dataSource as unknown as DataSource,
      dispatch as unknown as WorkflowDispatchService,
      { intervalMs: 60_000 },
    );

    await recovery.recoverNow();

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('lease_expires_at <= CURRENT_TIMESTAMP(6)'),
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'REVISION_REQUIRED'"),
    );
    expect(dispatch.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.dispatch).toHaveBeenNthCalledWith(
      1,
      '11111111-1111-4111-8111-111111111111',
    );
    expect(dispatch.dispatch).toHaveBeenNthCalledWith(
      2,
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('stops its recovery timer on worker shutdown', async () => {
    jest.useFakeTimers();
    const dataSource = { query: jest.fn().mockResolvedValue([]) };
    const dispatch = { dispatch: jest.fn() };
    const recovery = new WorkflowRecoveryDispatcher(
      dataSource as unknown as DataSource,
      dispatch as unknown as WorkflowDispatchService,
      { intervalMs: 1000 },
    );

    await recovery.onModuleInit();
    recovery.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3000);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('uses one in-flight recovery scan while Redis acknowledgement is hung', async () => {
    let release!: () => void;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111' }]),
    };
    const dispatch = { dispatch: jest.fn().mockReturnValue(hung) };
    const recovery = new WorkflowRecoveryDispatcher(
      dataSource as unknown as DataSource,
      dispatch as unknown as WorkflowDispatchService,
      { intervalMs: 100, maxConcurrency: 2, failureBackoffMs: 1000 },
    );

    const first = recovery.recoverNow();
    const second = recovery.recoverNow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
  });

  it('bounds concurrent redis deliveries', async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    const dataSource = { query: jest.fn().mockResolvedValue(rows) };
    let active = 0;
    let maxActive = 0;
    const dispatch = {
      dispatch: jest.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      }),
    };
    const recovery = new WorkflowRecoveryDispatcher(
      dataSource as unknown as DataSource,
      dispatch as unknown as WorkflowDispatchService,
      { intervalMs: 60_000, maxConcurrency: 3 },
    );

    await recovery.recoverNow();

    expect(dispatch.dispatch).toHaveBeenCalledTimes(8);
    expect(maxActive).toBe(3);
  });
});
