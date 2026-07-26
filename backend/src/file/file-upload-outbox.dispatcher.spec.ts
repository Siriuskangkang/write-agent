import { Logger } from '@nestjs/common';
import { FileUploadOutboxDispatcher } from './file-upload-outbox.dispatcher.js';

describe('FileUploadOutboxDispatcher', () => {
  const originalWorkerMode = process.env.WORKER_MODE;

  afterEach(() => {
    if (originalWorkerMode === undefined) delete process.env.WORKER_MODE;
    else process.env.WORKER_MODE = originalWorkerMode;
    jest.restoreAllMocks();
  });

  it('publishes a claimed outbox row with its deterministic job id', async () => {
    const outboxRepo = createRepository([outboxEvent()]);
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      queue as never,
    );

    await dispatcher.dispatchPending();

    expect(queue.add).toHaveBeenCalledWith(
      'parse',
      { fileId: 'file-1', projectId: 'project-1', parseGeneration: 1 },
      {
        jobId: 'file-parse:file-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    expect(outboxRepo.query).toHaveBeenCalledTimes(1);
    const claimSql = firstQuerySql(outboxRepo);
    expect(claimSql).toContain('CURRENT_TIMESTAMP(6)');
    expect(claimSql).not.toContain('CURRENT_TIMESTAMP(3)');
    expect(outboxRepo.update).toHaveBeenLastCalledWith(
      { id: 'outbox-1', lease_owner: 'outbox-owner-1' },
      {
        status: 'published',
        attempts: 1,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    );
  });

  it('backs off a claimed outbox row after publishing fails', async () => {
    const outboxRepo = createRepository([outboxEvent(2)]);
    const queue = { add: jest.fn().mockRejectedValue(new Error('redis down')) };
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      queue as never,
    );
    await dispatcher.dispatchPending();

    const update = lastUpdate(outboxRepo) as {
      attempts: number;
      last_error: string;
      lease_owner: null;
      lease_expires_at: null;
      next_attempt_at: () => string;
    };
    expect(update.attempts).toBe(3);
    expect(update.last_error).toBe('redis down');
    expect(update.lease_owner).toBeNull();
    expect(update.lease_expires_at).toBeNull();
    expect(update.next_attempt_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 8 SECOND)',
    );
  });

  it('coalesces overlapping dispatch calls on the same instance', async () => {
    const outboxRepo = createRepository([outboxEvent()]);
    let finishQueue!: () => void;
    const queueWait = new Promise<void>((resolve) => {
      finishQueue = resolve;
    });
    const queue = { add: jest.fn(() => queueWait) };
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      queue as never,
    );

    const first = dispatcher.dispatchPending();
    const second = dispatcher.dispatchPending();
    await Promise.resolve();
    finishQueue();
    await Promise.all([first, second]);

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('replays the same deterministic job after queue add succeeds but the published update fails', async () => {
    const outboxRepo = createRepository([outboxEvent(0), outboxEvent(1)]);
    outboxRepo.find
      .mockResolvedValueOnce([outboxEvent(0)])
      .mockResolvedValueOnce([outboxEvent(1)]);
    outboxRepo.update
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new Error('mysql update failed'))
      .mockResolvedValue({ affected: 1 });
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      queue as never,
    );

    await dispatcher.dispatchPending();
    await dispatcher.dispatchPending();

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    expect(outboxRepo.update).toHaveBeenLastCalledWith(
      { id: 'outbox-1', lease_owner: 'outbox-owner-1' },
      {
        status: 'published',
        attempts: 2,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    );
  });

  it('does not enqueue when renewing the claimed lease reports ownership lost', async () => {
    const outboxRepo = createRepository([outboxEvent()]);
    outboxRepo.update.mockResolvedValueOnce({ affected: 0 });
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      queue as never,
    );

    await dispatcher.dispatchPending();

    expect(queue.add).not.toHaveBeenCalled();
    const calls = outboxRepo.update.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    expect(calls[0]?.[0]).toEqual({
      id: 'outbox-1',
      lease_owner: 'outbox-owner-1',
    });
    const leaseDeadline = (
      calls[0]?.[1] as {
        lease_expires_at: () => string;
      }
    ).lease_expires_at;
    expect(leaseDeadline()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 60 SECOND)',
    );
  });

  it('does not start a periodic scan in the API process', async () => {
    delete process.env.WORKER_MODE;
    const outboxRepo = createRepository([]);
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      { add: jest.fn() } as never,
    );

    dispatcher.onModuleInit();
    await Promise.resolve();

    expect(outboxRepo.query).not.toHaveBeenCalled();
    expect(outboxRepo.find).not.toHaveBeenCalled();
  });

  it('catches a worker startup scan failure at the timer boundary', async () => {
    process.env.WORKER_MODE = 'true';
    const outboxRepo = createRepository([]);
    outboxRepo.query.mockRejectedValue(new Error('mysql unavailable'));
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const dispatcher = new FileUploadOutboxDispatcher(
      outboxRepo as never,
      { add: jest.fn() } as never,
    );

    dispatcher.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher.onModuleDestroy();

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('mysql unavailable'),
    );
  });
});

function outboxEvent(attempts = 0) {
  return {
    id: 'outbox-1',
    file_id: 'file-1',
    project_id: 'project-1',
    job_id: 'file-parse:file-1',
    parse_generation: 1,
    status: 'pending',
    attempts,
    last_error: null,
    lease_owner: 'outbox-owner-1',
    lease_expires_at: new Date('2026-07-25T00:01:00Z'),
    next_attempt_at: new Date('2026-07-25T00:00:00Z'),
    created_at: new Date('2026-07-25T00:00:00Z'),
  };
}

function createRepository(records: ReturnType<typeof outboxEvent>[]) {
  return {
    query: jest.fn().mockResolvedValue({ affectedRows: records.length }),
    find: jest.fn().mockResolvedValue(records),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function lastUpdate(repository: ReturnType<typeof createRepository>): unknown {
  const calls = repository.update.mock.calls as unknown as Array<
    [unknown, unknown]
  >;
  return calls.at(-1)?.[1];
}

function firstQuerySql(
  repository: ReturnType<typeof createRepository>,
): string {
  const calls = repository.query.mock.calls as unknown as Array<
    [unknown, ...unknown[]]
  >;
  return String(calls[0]?.[0]);
}
