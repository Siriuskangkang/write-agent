import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileCleanupDispatcher } from './file-cleanup.dispatcher.js';
import * as uploadFileSafety from './upload-file-safety.js';

describe('FileCleanupDispatcher', () => {
  let root: string;
  let outsideRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-cleanup-dispatcher-'));
    outsideRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'file-cleanup-outside-'),
    );
    process.env.UPLOAD_DIR = root;
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    delete process.env.STORAGE_AUTHORITY_MODE;
    delete process.env.STORAGE_PROTECTED_ROOT;
    delete process.env.STORAGE_QUARANTINE_ROOT;
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it('deletes a claimed record after removing a regular file inside UPLOAD_DIR', async () => {
    const residualPath = path.join(root, 'project-1', 'residual.txt');
    await fs.mkdir(path.dirname(residualPath), { recursive: true });
    await fs.writeFile(residualPath, 'residual');
    const repository = createRepository(residualPath);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    await expect(fs.access(residualPath)).rejects.toThrow();
    expect(repository.query).toHaveBeenCalledTimes(1);
    expect(repository.delete).toHaveBeenCalledWith({
      id: 'cleanup-1',
      lease_owner: 'cleanup-owner-1',
    });
  });

  it('deletes a broker quarantine recovery record outside UPLOAD_DIR', async () => {
    const quarantineRoot = path.join(outsideRoot, 'quarantine');
    const residualPath = path.join(quarantineRoot, 'intent.upload');
    process.env.STORAGE_AUTHORITY_MODE = 'broker';
    process.env.STORAGE_PROTECTED_ROOT = path.join(outsideRoot, 'protected');
    process.env.STORAGE_QUARANTINE_ROOT = quarantineRoot;
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.writeFile(residualPath, 'residual');
    const repository = createRepository(residualPath);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    await expect(fs.access(residualPath)).rejects.toThrow();
    expect(repository.delete).toHaveBeenCalledWith({
      id: 'cleanup-1',
      lease_owner: 'cleanup-owner-1',
    });
  });

  it('coalesces overlapping cleanup calls on the same instance', async () => {
    const residualPath = path.join(root, 'project-1', 'residual.txt');
    await fs.mkdir(path.dirname(residualPath), { recursive: true });
    await fs.writeFile(residualPath, 'residual');
    const repository = createRepository(residualPath);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await Promise.all([
      dispatcher.dispatchPending(),
      dispatcher.dispatchPending(),
    ]);

    expect(repository.delete).toHaveBeenCalledTimes(1);
  });

  it('permanently rejects a directory instead of attempting unlink', async () => {
    const residualPath = path.join(root, 'residual-directory');
    await fs.mkdir(residualPath);
    const repository = createRepository(residualPath, 2);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    expect((await fs.stat(residualPath)).isDirectory()).toBe(true);
    expectRejectedUpdate(repository, 3);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('permanently rejects an absolute path outside UPLOAD_DIR without deleting it', async () => {
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    await fs.writeFile(outsidePath, 'outside');
    const repository = createRepository(outsidePath);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('outside');
    expectRejectedUpdate(repository, 1);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('permanently rejects a traversal path that resolves outside UPLOAD_DIR', async () => {
    const outsideName = `${path.basename(root)}-outside.txt`;
    const outsidePath = path.join(path.dirname(root), outsideName);
    await fs.writeFile(outsidePath, 'outside');
    const traversal = path.join(root, 'nested', '..', '..', outsideName);
    const repository = createRepository(traversal);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    try {
      await dispatcher.dispatchPending();

      await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('outside');
      expectRejectedUpdate(repository, 1);
      expect(repository.delete).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('permanently rejects a symlink replacement without deleting link or target', async () => {
    const target = path.join(outsideRoot, 'target.txt');
    const symlink = path.join(root, 'project-1', 'residual.txt');
    await fs.writeFile(target, 'target');
    await fs.mkdir(path.dirname(symlink), { recursive: true });
    await fs.symlink(target, symlink);
    const repository = createRepository(symlink);
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    expect((await fs.lstat(symlink)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('target');
    expectRejectedUpdate(repository, 1);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('backs off a transient filesystem inspection failure and releases its lease', async () => {
    const residualPath = path.join(root, 'project-1', 'residual.txt');
    await fs.mkdir(path.dirname(residualPath), { recursive: true });
    await fs.writeFile(residualPath, 'residual');
    jest
      .spyOn(uploadFileSafety, 'inspectUploadFileForUnlink')
      .mockRejectedValueOnce(new Error('filesystem busy'));
    const repository = createRepository(residualPath, 3);
    const dispatcher = new FileCleanupDispatcher(repository as never);
    await dispatcher.dispatchPending();

    const update = lastUpdate(repository) as {
      attempts: number;
      last_error: string;
      lease_owner: null;
      lease_expires_at: null;
      next_attempt_at: () => string;
    };
    expect(update).toMatchObject({
      attempts: 4,
      last_error: 'filesystem busy',
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(update.next_attempt_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 16 SECOND)',
    );
    await expect(fs.readFile(residualPath, 'utf8')).resolves.toBe('residual');
  });

  it('does not unlink when renewing the claimed lease reports ownership lost', async () => {
    const residualPath = path.join(root, 'project-1', 'residual.txt');
    await fs.mkdir(path.dirname(residualPath), { recursive: true });
    await fs.writeFile(residualPath, 'residual');
    const repository = createRepository(residualPath);
    repository.update.mockResolvedValueOnce({ affected: 0 });
    const dispatcher = new FileCleanupDispatcher(repository as never);

    await dispatcher.dispatchPending();

    await expect(fs.readFile(residualPath, 'utf8')).resolves.toBe('residual');
    expect(repository.delete).not.toHaveBeenCalled();
    const calls = repository.update.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    expect(calls[0]?.[0]).toEqual({
      id: 'cleanup-1',
      lease_owner: 'cleanup-owner-1',
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
});

function createRepository(filePath: string, attempts = 0) {
  return {
    query: jest.fn().mockResolvedValue({ affectedRows: 1 }),
    find: jest.fn().mockResolvedValue([
      {
        id: 'cleanup-1',
        status: 'pending',
        file_path: filePath,
        reason: 'upload failed',
        attempts,
        last_error: null,
        lease_owner: 'cleanup-owner-1',
        lease_expires_at: new Date('2026-07-25T00:01:00Z'),
        next_attempt_at: new Date('2026-07-25T00:00:00Z'),
        created_at: new Date('2026-07-25T00:00:00Z'),
      },
    ]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function expectRejectedUpdate(
  repository: ReturnType<typeof createRepository>,
  attempts: number,
): void {
  const update = lastUpdate(repository) as {
    status: string;
    attempts: number;
    last_error: string;
    lease_owner: null;
    lease_expires_at: null;
  };
  expect(update.status).toBe('rejected');
  expect(update.attempts).toBe(attempts);
  expect(update.last_error).toContain('Unsafe cleanup path');
  expect(update.lease_owner).toBeNull();
  expect(update.lease_expires_at).toBeNull();
}

function lastUpdate(repository: ReturnType<typeof createRepository>): unknown {
  const calls = repository.update.mock.calls as unknown as Array<
    [unknown, unknown]
  >;
  return calls.at(-1)?.[1];
}
