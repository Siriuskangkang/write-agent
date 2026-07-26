import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileMoveIntentDispatcher } from './file-move-intent.dispatcher.js';

describe('FileMoveIntentDispatcher', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'move-intent-dispatcher-'));
    process.env.UPLOAD_DIR = root;
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('claims and recovers an orphaned move intent', async () => {
    const destination = path.join(root, 'project-1', 'orphan.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'orphan');
    const intentRepo = createIntentRepository(destination);
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      {
        findOneBy: jest.fn().mockResolvedValue(null),
      } as never,
    );

    await dispatcher.dispatchPending();

    await expect(fs.access(destination)).rejects.toThrow();
    expect(intentRepo.query).toHaveBeenCalledTimes(2);
    expect(intentRepo.delete).toHaveBeenCalledWith({
      id: 'intent-1',
      lease_owner: 'move-owner-1',
    });
  });

  it('coalesces overlapping recovery calls on the same instance', async () => {
    const destination = path.join(root, 'project-1', 'orphan.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'orphan');
    const intentRepo = createIntentRepository(destination);
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      {
        findOneBy: jest.fn().mockResolvedValue(null),
      } as never,
    );

    await Promise.all([
      dispatcher.dispatchPending(),
      dispatcher.dispatchPending(),
    ]);

    expect(intentRepo.delete).toHaveBeenCalledTimes(1);
  });

  it('backs off a transient recovery failure and releases its lease', async () => {
    const destination = path.join(root, 'project-1', 'orphan.pdf');
    const intentRepo = createIntentRepository(destination);
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      {
        findOneBy: jest.fn().mockRejectedValue(new Error('database busy')),
      } as never,
    );
    await dispatcher.dispatchPending();

    const update = lastUpdate(intentRepo) as {
      attempts: number;
      last_error: string;
      lease_owner: null;
      lease_expires_at: null;
      next_attempt_at: () => string;
    };
    expect(update).toMatchObject({
      attempts: 1,
      last_error: 'database busy',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(update.next_attempt_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 2 SECOND)',
    );
    expect(intentRepo.delete).not.toHaveBeenCalled();
  });

  it('does not inspect or unlink when renewing the recovery lease loses ownership', async () => {
    const destination = path.join(root, 'project-1', 'orphan.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'orphan');
    const intentRepo = createIntentRepository(destination);
    intentRepo.update.mockResolvedValueOnce({ affected: 0 });
    const fileRepo = { findOneBy: jest.fn().mockResolvedValue(null) };
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      fileRepo as never,
    );

    await dispatcher.dispatchPending();

    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('orphan');
    expect(fileRepo.findOneBy).not.toHaveBeenCalled();
    expect(intentRepo.delete).not.toHaveBeenCalled();
  });

  it('permanently rejects an outside recovery path without deleting it', async () => {
    const outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'move-intent-outside-'),
    );
    const outside = path.join(outsideRoot, 'outside.pdf');
    await fs.writeFile(outside, 'outside');
    const intentRepo = createIntentRepository(outside);
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      { findOneBy: jest.fn().mockResolvedValue(null) } as never,
    );

    try {
      await dispatcher.dispatchPending();

      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside');
      expect(lastUpdate(intentRepo)).toMatchObject({
        status: 'REJECTED',
        lease_owner: null,
        lease_expires_at: null,
      });
      expect(intentRepo.delete).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('clears a delayed UNCERTAIN intent without deleting files when source and outbox both exist', async () => {
    const destination = path.join(root, 'project-1', 'committed.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'committed');
    const intentRepo = createIntentRepository(destination, {
      status: 'UNCERTAIN',
      sourceCount: 1,
      outboxCount: 1,
    });
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      { findOneBy: jest.fn() } as never,
    );

    await dispatcher.dispatchPending();

    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('committed');
    expect(intentRepo.delete).toHaveBeenCalledWith({
      id: 'intent-1',
      lease_owner: 'move-owner-1',
    });
  });

  it('keeps a delayed UNCERTAIN intent and files on partial committed state', async () => {
    const destination = path.join(root, 'project-1', 'partial.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'partial');
    const intentRepo = createIntentRepository(destination, {
      status: 'UNCERTAIN',
      sourceCount: 1,
      outboxCount: 0,
    });
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      { findOneBy: jest.fn() } as never,
    );

    await dispatcher.dispatchPending();

    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('partial');
    expect(lastUpdate(intentRepo)).toMatchObject({
      status: 'UNCERTAIN',
      attempts: 1,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(
      (lastUpdate(intentRepo) as { last_error: string }).last_error,
    ).toContain('SourceFile=1, outbox=0');
    expect(intentRepo.delete).not.toHaveBeenCalled();
  });

  it('removes files for a delayed UNCERTAIN intent only when source and outbox are both absent', async () => {
    const destination = path.join(root, 'project-1', 'not-committed.pdf');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, 'not committed');
    const intentRepo = createIntentRepository(destination, {
      status: 'UNCERTAIN',
      sourceCount: 0,
      outboxCount: 0,
    });
    const dispatcher = new FileMoveIntentDispatcher(
      intentRepo as never,
      { findOneBy: jest.fn() } as never,
    );

    await dispatcher.dispatchPending();

    await expect(fs.access(destination)).rejects.toThrow();
    expect(intentRepo.delete).toHaveBeenCalledWith({
      id: 'intent-1',
      lease_owner: 'move-owner-1',
    });
  });
});

function createIntentRepository(
  destinationPath: string,
  options: {
    status?: 'ACTIVE' | 'UNCERTAIN';
    sourceCount?: number;
    outboxCount?: number;
  } = {},
) {
  const intent = {
    id: 'intent-1',
    status: options.status ?? 'ACTIVE',
    source_path: path.join(path.dirname(destinationPath), 'missing.pdf'),
    destination_path: destinationPath,
    file_id: 'file-1',
    project_id: 'project-1',
    user_id: 'user-1',
    file_size: 6,
    writer_token: 'writer-1',
    recover_after: new Date('2026-07-24T23:59:00Z'),
    attempts: 0,
    last_error: null,
    lease_owner: 'move-owner-1',
    lease_expires_at: new Date('2026-07-25T00:01:00Z'),
    next_attempt_at: new Date('2026-07-25T00:00:00Z'),
    created_at: new Date('2026-07-25T00:00:00Z'),
  };
  let claimedStatus: string | undefined;
  return {
    query: jest.fn((sql: string, parameters?: unknown[]) => {
      if (sql.includes('UPDATE file_move_intents')) {
        claimedStatus = String(parameters?.[1]);
        return Promise.resolve({ affectedRows: 1 });
      }
      return Promise.resolve([
        {
          sourceCount: options.sourceCount ?? 0,
          outboxCount: options.outboxCount ?? 0,
        },
      ]);
    }),
    find: jest.fn(() =>
      Promise.resolve(claimedStatus === intent.status ? [intent] : []),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function lastUpdate(
  repository: ReturnType<typeof createIntentRepository>,
): unknown {
  const calls = repository.update.mock.calls as unknown as Array<
    [unknown, unknown]
  >;
  return calls.at(-1)?.[1];
}
