import { DataSource } from 'typeorm';
import type { MigrationInterface, QueryRunner, ReplicationMode } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { InitSchema1710700000000 } from '../../migrations/1710700000000-InitSchema.js';
import { CreateFileUploadReliabilityTables1712050000000 } from '../../migrations/1712050000000-CreateFileUploadReliabilityTables.js';
import { HardenFileUploadLeases1712060000000 } from '../../migrations/1712060000000-HardenFileUploadLeases.js';
import { UseDatabaseClockForFileUploadLeases1712070000000 } from '../../migrations/1712070000000-UseDatabaseClockForFileUploadLeases.js';
import { NormalizeUploadLeaseTimestamps1712080000000 } from '../../migrations/1712080000000-NormalizeUploadLeaseTimestamps.js';
import { FileCleanupDispatcher } from './file-cleanup.dispatcher.js';
import { discardQueryRunnerConnection } from './discard-query-runner-connection.js';
import { FileUploadOutboxDispatcher } from './file-upload-outbox.dispatcher.js';
import { FileCleanupRecord } from './entities/file-cleanup-record.entity.js';
import { Document } from './entities/document.entity.js';
import { FileUploadOutbox } from './entities/file-upload-outbox.entity.js';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import { SourceFile } from './entities/source-file.entity.js';
import { FileService } from './file.service.js';
import { FileMoveIntentDispatcher } from './file-move-intent.dispatcher.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const mysqlDescribe =
  process.env.FILE_UPLOAD_MYSQL_TEST === '1' ? describe : describe.skip;

jest.setTimeout(120_000);

mysqlDescribe('file upload reliability with MySQL 8.4', () => {
  let dataSource: DataSource;
  let uploadRoot: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.FILE_UPLOAD_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.FILE_UPLOAD_MYSQL_PORT || 3306),
      username: process.env.FILE_UPLOAD_MYSQL_USER || 'root',
      password: process.env.FILE_UPLOAD_MYSQL_PASSWORD || '',
      database: process.env.FILE_UPLOAD_MYSQL_DATABASE,
      charset: 'utf8mb4',
      timezone: '+08:00',
      entities: [
        SourceFile,
        Document,
        FileUploadOutbox,
        FileCleanupRecord,
        FileMoveIntent,
      ],
      migrations: [
        InitSchema1710700000000,
        CreateFileUploadReliabilityTables1712050000000,
        HardenFileUploadLeases1712060000000,
        UseDatabaseClockForFileUploadLeases1712070000000,
        NormalizeUploadLeaseTimestamps1712080000000,
      ],
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email)`,
      [USER_ID, 'upload-integration@example.test', 'not-used'],
    );
    await dataSource.query(
      `INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [PROJECT_ID, USER_ID, 'Upload integration'],
    );
  });

  beforeEach(async () => {
    uploadRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-mysql-upload-'),
    );
    process.env.UPLOAD_DIR = uploadRoot;
    delete process.env.MAX_USER_STORAGE;
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    delete process.env.MAX_USER_STORAGE;
    await dataSource.query('DROP TRIGGER IF EXISTS fail_second_source_file');
    await dataSource.query('DROP TRIGGER IF EXISTS pause_source_file');
    await dataSource.query('DELETE FROM file_upload_outbox');
    await dataSource.query('DELETE FROM file_move_intents');
    await dataSource.query('DELETE FROM source_files');
    await dataSource.query('DELETE FROM file_cleanup_records');
    if (uploadRoot) {
      await fs.rm(uploadRoot, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('serializes concurrent quota checks so only one request can consume the remaining bytes', async () => {
    const first = await writeQuarantinePdf(uploadRoot, 'first.pdf');
    const second = await writeQuarantinePdf(uploadRoot, 'second.pdf');
    process.env.MAX_USER_STORAGE = String(first.size);
    const service = createFileService(dataSource);

    const results = await Promise.allSettled([
      service.uploadFiles(USER_ID, PROJECT_ID, [first]),
      service.uploadFiles(USER_ID, PROJECT_ID, [second]),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await dataSource.getRepository(SourceFile).count()).toBe(1);
    expect(await dataSource.getRepository(FileUploadOutbox).count()).toBe(1);
    const stored = await dataSource.getRepository(SourceFile).findOneByOrFail({
      project_id: PROJECT_ID,
    });
    await expect(fs.stat(stored.file_path)).resolves.toMatchObject({
      size: first.size,
    });
  });

  it('marks the upload UNCERTAIN even when committed rows are already visible after commit throws', async () => {
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(
      dataSource,
    ) as (mode?: ReplicationMode) => QueryRunner;
    let injectCommitFailure = true;
    const createQueryRunner = jest.spyOn(dataSource, 'createQueryRunner');
    createQueryRunner.mockImplementation(
      (mode?: ReplicationMode): QueryRunner => {
        const runner = originalCreateQueryRunner(mode);
        if (injectCommitFailure) {
          injectCommitFailure = false;
          const commit = runner.commitTransaction.bind(
            runner,
          ) as () => Promise<void>;
          runner.commitTransaction = jest.fn(async () => {
            await commit();
            throw new Error('after-commit client hook failed');
          });
        }
        return runner;
      },
    );
    const upload = await writeQuarantinePdf(uploadRoot, 'commit-hook.pdf');
    const service = createFileService(dataSource);

    try {
      await expect(
        service.uploadFiles(USER_ID, PROJECT_ID, [upload]),
      ).rejects.toThrow('after-commit client hook failed');

      const stored = await dataSource
        .getRepository(SourceFile)
        .findOneByOrFail({ project_id: PROJECT_ID });
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource.getRepository(SourceFile).countBy({ id: stored.id }),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(FileUploadOutbox)
          .countBy({ file_id: stored.id }),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(FileMoveIntent)
          .countBy({ file_id: stored.id }),
      ).toBe(1);
      await dataSource.query(
        `UPDATE file_move_intents
           SET recover_after = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND),
               next_attempt_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
         WHERE file_id = ?`,
        [stored.id],
      );
      const recovery = new FileMoveIntentDispatcher(
        dataSource.getRepository(FileMoveIntent),
        dataSource.getRepository(SourceFile),
      );
      await recovery.dispatchPending();
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource
          .getRepository(FileMoveIntent)
          .countBy({ file_id: stored.id }),
      ).toBe(0);
    } finally {
      createQueryRunner.mockRestore();
    }
  });

  it('keeps the moved file while a commit error is followed by rows becoming visible later', async () => {
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(
      dataSource,
    ) as (mode?: ReplicationMode) => QueryRunner;
    let delayedRunner: QueryRunner | undefined;
    let restoreDestroy: (() => void) | undefined;
    let releaseLateCommit!: () => void;
    let signalCommitAttempted!: () => void;
    const allowLateCommit = new Promise<void>((resolve) => {
      releaseLateCommit = resolve;
    });
    const commitAttempted = new Promise<void>((resolve) => {
      signalCommitAttempted = resolve;
    });
    let lateCommit: Promise<void> | undefined;
    let injectCommitFailure = true;
    const createQueryRunner = jest.spyOn(dataSource, 'createQueryRunner');
    createQueryRunner.mockImplementation(
      (mode?: ReplicationMode): QueryRunner => {
        const runner = originalCreateQueryRunner(mode);
        if (injectCommitFailure) {
          injectCommitFailure = false;
          delayedRunner = runner;
          const connect = runner.connect.bind(runner) as () => Promise<void>;
          runner.connect = jest.fn(async () => {
            const connection = await connect();
            const raw = (
              runner as unknown as {
                databaseConnection: { destroy: () => void };
              }
            ).databaseConnection;
            const destroy = raw.destroy;
            raw.destroy = () => undefined;
            restoreDestroy = () => {
              raw.destroy = destroy;
            };
            return connection;
          });
          const commit = runner.commitTransaction.bind(
            runner,
          ) as () => Promise<void>;
          runner.commitTransaction = jest.fn(() => {
            lateCommit = (async () => {
              await allowLateCommit;
              await commit();
            })();
            signalCommitAttempted();
            return Promise.reject(
              new Error('commit response lost before visibility'),
            );
          });
        }
        return runner;
      },
    );
    const upload = await writeQuarantinePdf(uploadRoot, 'late-commit.pdf');
    const service = createFileService(dataSource);
    const uploadResult = service
      .uploadFiles(USER_ID, PROJECT_ID, [upload])
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

    try {
      const uploadStart = await Promise.race([
        commitAttempted.then(() => 'commit-attempted' as const),
        uploadResult.then(() => 'settled-early' as const),
        wait(5_000).then(() => 'timed-out' as const),
      ]);
      if (uploadStart !== 'commit-attempted') {
        const early =
          uploadStart === 'settled-early' ? await uploadResult : undefined;
        if (
          early &&
          early.status === 'rejected' &&
          early.error instanceof Error
        ) {
          throw early.error;
        }
        throw new Error(
          `Upload did not reach delayed commit (${uploadStart}): ${
            early && early.status === 'rejected' ? String(early.error) : ''
          }`,
        );
      }
      const [movedName] = await waitForFileCount(
        path.join(uploadRoot, PROJECT_ID),
        1,
      );
      const destination = path.join(uploadRoot, PROJECT_ID, movedName);
      expect(await dataSource.getRepository(SourceFile).count()).toBe(0);
      await wait(100);
      const existedBeforeLateCommit = await fs.access(destination).then(
        () => true,
        () => false,
      );

      releaseLateCommit();
      await withTimeout(
        lateCommit ?? Promise.reject(new Error('Late commit was not started')),
        5_000,
        'late commit',
      );
      const outcome = await withTimeout(uploadResult, 5_000, 'upload result');

      expect(existedBeforeLateCommit).toBe(true);
      expect(outcome.status).toBe('rejected');
      expect(
        outcome.status === 'rejected' ? String(outcome.error) : '',
      ).toContain('commit response lost before visibility');
      const stored = await dataSource
        .getRepository(SourceFile)
        .findOneByOrFail({ project_id: PROJECT_ID });
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource
          .getRepository(FileUploadOutbox)
          .countBy({ file_id: stored.id }),
      ).toBe(1);
      expect(
        await dataSource
          .getRepository(FileMoveIntent)
          .countBy({ file_id: stored.id }),
      ).toBe(1);

      await dataSource.query(
        `UPDATE file_move_intents
           SET recover_after = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND),
               next_attempt_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
         WHERE file_id = ?`,
        [stored.id],
      );
      const recovery = new FileMoveIntentDispatcher(
        dataSource.getRepository(FileMoveIntent),
        dataSource.getRepository(SourceFile),
      );
      await recovery.dispatchPending();
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource
          .getRepository(FileMoveIntent)
          .countBy({ file_id: stored.id }),
      ).toBe(0);
    } finally {
      releaseLateCommit();
      if (lateCommit) {
        await withTimeout(
          lateCommit.catch(() => undefined),
          5_000,
          'late commit cleanup',
        ).catch(() => undefined);
      }
      if (delayedRunner && !delayedRunner.isReleased) {
        restoreDestroy?.();
        await delayedRunner
          .query('SELECT RELEASE_LOCK(?)', [`upload-quota:${USER_ID}`])
          .catch(() => undefined);
        try {
          discardQueryRunnerConnection(delayedRunner);
        } catch {
          await delayedRunner.release().catch(() => undefined);
        }
        await waitForMysqlLockFree(dataSource, `upload-quota:${USER_ID}`);
      }
      createQueryRunner.mockRestore();
    }
  });

  it('retains a truly uncommitted upload until UNCERTAIN grace expires, then cleans it', async () => {
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(
      dataSource,
    ) as (mode?: ReplicationMode) => QueryRunner;
    let injectCommitFailure = true;
    const createQueryRunner = jest.spyOn(dataSource, 'createQueryRunner');
    createQueryRunner.mockImplementation(
      (mode?: ReplicationMode): QueryRunner => {
        const runner = originalCreateQueryRunner(mode);
        if (injectCommitFailure) {
          injectCommitFailure = false;
          runner.commitTransaction = jest
            .fn()
            .mockRejectedValue(new Error('commit never reached MySQL'));
        }
        return runner;
      },
    );
    const upload = await writeQuarantinePdf(uploadRoot, 'not-committed.pdf');
    const service = createFileService(dataSource);

    try {
      await expect(
        service.uploadFiles(USER_ID, PROJECT_ID, [upload]),
      ).rejects.toThrow('commit never reached MySQL');

      expect(await dataSource.getRepository(SourceFile).count()).toBe(0);
      expect(await dataSource.getRepository(FileUploadOutbox).count()).toBe(0);
      const intent = await dataSource
        .getRepository(FileMoveIntent)
        .findOneByOrFail({ project_id: PROJECT_ID });
      await expect(fs.access(intent.destination_path)).resolves.toBeUndefined();

      const recovery = new FileMoveIntentDispatcher(
        dataSource.getRepository(FileMoveIntent),
        dataSource.getRepository(SourceFile),
      );
      await recovery.dispatchPending();
      await expect(fs.access(intent.destination_path)).resolves.toBeUndefined();
      expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(1);

      await dataSource.query(
        `UPDATE file_move_intents
           SET recover_after = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND),
               next_attempt_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
         WHERE id = ?`,
        [intent.id],
      );
      await recovery.dispatchPending();
      await expect(fs.access(intent.destination_path)).rejects.toThrow();
      expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(0);
    } finally {
      createQueryRunner.mockRestore();
    }
  });

  it('keeps an UNCERTAIN durable intent and file when the commit probe sees a partial state', async () => {
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(
      dataSource,
    ) as (mode?: ReplicationMode) => QueryRunner;
    let injectPartialCommit = true;
    const createQueryRunner = jest.spyOn(dataSource, 'createQueryRunner');
    createQueryRunner.mockImplementation(
      (mode?: ReplicationMode): QueryRunner => {
        const runner = originalCreateQueryRunner(mode);
        if (injectPartialCommit) {
          injectPartialCommit = false;
          runner.commitTransaction = jest.fn(async () => {
            const rows: unknown = await runner.query(
              `SELECT id, project_id, file_name, file_type, file_size, file_path
               FROM source_files
               WHERE project_id = ?`,
              [PROJECT_ID],
            );
            const pendingFile = firstMysqlRow(rows);
            await runner.rollbackTransaction();
            await dataSource.query(
              `INSERT INTO source_files (
                 id, project_id, file_name, file_type, file_size, file_path
               ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                pendingFile?.id,
                pendingFile?.project_id,
                pendingFile?.file_name,
                pendingFile?.file_type,
                pendingFile?.file_size,
                pendingFile?.file_path,
              ],
            );
            throw new Error('partial commit state');
          });
        }
        return runner;
      },
    );
    const upload = await writeQuarantinePdf(uploadRoot, 'partial.pdf');
    const service = createFileService(dataSource);

    try {
      await expect(
        service.uploadFiles(USER_ID, PROJECT_ID, [upload]),
      ).rejects.toThrow('partial commit state');

      const stored = await dataSource
        .getRepository(SourceFile)
        .findOneByOrFail({ project_id: PROJECT_ID });
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource
          .getRepository(FileUploadOutbox)
          .countBy({ file_id: stored.id }),
      ).toBe(0);
      const uncertainIntent = await dataSource
        .getRepository(FileMoveIntent)
        .findOneByOrFail({ file_id: stored.id });
      expect(uncertainIntent.status).toBe('UNCERTAIN');
      expect(uncertainIntent.last_error).toContain('partial commit state');
      expect(uncertainIntent.lease_owner).toBeNull();

      const recovery = new FileMoveIntentDispatcher(
        dataSource.getRepository(FileMoveIntent),
        dataSource.getRepository(SourceFile),
      );
      await recovery.dispatchPending();
      await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
      expect(
        await dataSource
          .getRepository(FileMoveIntent)
          .countBy({ file_id: stored.id }),
      ).toBe(1);
    } finally {
      createQueryRunner.mockRestore();
    }
  });

  it('does not roll back a committed upload when immediate outbox dispatch throws synchronously', async () => {
    const upload = await writeQuarantinePdf(uploadRoot, 'dispatch-hook.pdf');
    const service = createFileService(dataSource, {
      dispatchPending: jest.fn(() => {
        throw new Error('dispatch hook failed');
      }),
    });

    const [stored] = await service.uploadFiles(USER_ID, PROJECT_ID, [upload]);

    await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
    expect(
      await dataSource.getRepository(SourceFile).countBy({ id: stored.id }),
    ).toBe(1);
    await expect(
      dataSource
        .getRepository(FileUploadOutbox)
        .findOneByOrFail({ file_id: stored.id }),
    ).resolves.toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('destroys a poisoned physical connection so its named lock and transaction cannot leak', async () => {
    const lockName = `poisoned-lock:${Date.now()}`;
    const poisoned = dataSource.createQueryRunner();
    await poisoned.connect();
    const [{ connectionId }] = (await poisoned.query(
      'SELECT CONNECTION_ID() AS connectionId',
    )) as Array<{ connectionId: number }>;
    await poisoned.query('SELECT GET_LOCK(?, 1)', [lockName]);
    await poisoned.startTransaction();
    await poisoned.query(
      'INSERT INTO source_files (id, project_id, file_name, file_type, file_size, file_path) VALUES (?, ?, ?, ?, ?, ?)',
      [
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        PROJECT_ID,
        'uncommitted.txt',
        'txt',
        1,
        path.join(uploadRoot, 'uncommitted.txt'),
      ],
    );

    discardQueryRunnerConnection(poisoned);

    await expect(waitForMysqlLockFree(dataSource, lockName)).resolves.toBe(
      true,
    );
    expect(
      await dataSource.getRepository(SourceFile).countBy({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBe(0);

    const replacement = dataSource.createQueryRunner();
    await replacement.connect();
    try {
      const [{ replacementId }] = (await replacement.query(
        'SELECT CONNECTION_ID() AS replacementId',
      )) as Array<{ replacementId: number }>;
      expect(Number(replacementId)).not.toBe(Number(connectionId));
      const [{ acquired }] = (await replacement.query(
        'SELECT GET_LOCK(?, 1) AS acquired',
        [lockName],
      )) as Array<{ acquired: number }>;
      expect(Number(acquired)).toBe(1);
      await replacement.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
      await replacement.release();
    }
  });

  it('keeps a committed outbox event pending after queue failure and publishes it on retry', async () => {
    const service = createFileService(dataSource);
    const upload = await writeQuarantinePdf(uploadRoot, 'retry.pdf');
    const [stored] = await service.uploadFiles(USER_ID, PROJECT_ID, [upload]);
    const queue = {
      add: jest.fn().mockRejectedValueOnce(new Error('redis unavailable')),
    };
    const dispatcher = new FileUploadOutboxDispatcher(
      dataSource.getRepository(FileUploadOutbox),
      queue as never,
    );

    await dispatcher.dispatchPending();

    await expect(
      dataSource.getRepository(FileUploadOutbox).findOneByOrFail({
        file_id: stored.id,
      }),
    ).resolves.toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'redis unavailable',
    });
    await expect(fs.stat(stored.file_path)).resolves.toBeDefined();

    queue.add.mockResolvedValueOnce(undefined);
    await dataSource.query(
      'UPDATE file_upload_outbox SET next_attempt_at = CURRENT_TIMESTAMP(6) WHERE file_id = ?',
      [stored.id],
    );
    await dispatcher.dispatchPending();

    await expect(
      dataSource.getRepository(FileUploadOutbox).findOneByOrFail({
        file_id: stored.id,
      }),
    ).resolves.toMatchObject({
      status: 'published',
      attempts: 2,
      last_error: null,
    });
  });

  it('atomically claims an outbox row across concurrent API and worker dispatchers', async () => {
    const service = createFileService(dataSource);
    const upload = await writeQuarantinePdf(uploadRoot, 'claim.pdf');
    const [stored] = await service.uploadFiles(USER_ID, PROJECT_ID, [upload]);
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const apiDispatcher = new FileUploadOutboxDispatcher(
      dataSource.getRepository(FileUploadOutbox),
      queue as never,
    );
    const workerDispatcher = new FileUploadOutboxDispatcher(
      dataSource.getRepository(FileUploadOutbox),
      queue as never,
    );

    await Promise.all([
      apiDispatcher.dispatchPending(),
      workerDispatcher.dispatchPending(),
    ]);

    expect(queue.add).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.getRepository(FileUploadOutbox).findOneByOrFail({
        file_id: stored.id,
      }),
    ).resolves.toMatchObject({
      status: 'published',
      attempts: 1,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('prevents an expired outbox owner from overwriting the new owner after deterministic replay', async () => {
    const service = createFileService(dataSource);
    const upload = await writeQuarantinePdf(uploadRoot, 'takeover.pdf');
    const [stored] = await service.uploadFiles(USER_ID, PROJECT_ID, [upload]);
    let releaseOldQueue!: () => void;
    let signalOldQueueStarted!: () => void;
    const oldQueueStarted = new Promise<void>((resolve) => {
      signalOldQueueStarted = resolve;
    });
    const oldQueueWait = new Promise<void>((resolve) => {
      releaseOldQueue = resolve;
    });
    const oldQueue = {
      add: jest.fn(() => {
        signalOldQueueStarted();
        return oldQueueWait;
      }),
    };
    const newQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const oldDispatcher = new FileUploadOutboxDispatcher(
      dataSource.getRepository(FileUploadOutbox),
      oldQueue as never,
    );
    const newDispatcher = new FileUploadOutboxDispatcher(
      dataSource.getRepository(FileUploadOutbox),
      newQueue as never,
    );

    const oldDispatch = oldDispatcher.dispatchPending();
    await oldQueueStarted;
    await dataSource.query(
      `UPDATE file_upload_outbox
         SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
       WHERE file_id = ?`,
      [stored.id],
    );
    await newDispatcher.dispatchPending();
    await dataSource.query(
      `UPDATE file_upload_outbox
         SET attempts = 41, last_error = 'new owner marker'
       WHERE file_id = ?`,
      [stored.id],
    );
    releaseOldQueue();
    await oldDispatch;

    expect(oldQueue.add).toHaveBeenCalledTimes(1);
    expect(newQueue.add).toHaveBeenCalledTimes(1);
    expect(oldQueue.add.mock.calls[0]).toEqual(newQueue.add.mock.calls[0]);
    await expect(
      dataSource.getRepository(FileUploadOutbox).findOneByOrFail({
        file_id: stored.id,
      }),
    ).resolves.toMatchObject({
      status: 'published',
      attempts: 41,
      last_error: 'new owner marker',
      lease_owner: null,
    });
  });

  it('stores every upload retry deadline as TIMESTAMP(6)', async () => {
    const rows: unknown = await dataSource.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              DATA_TYPE AS dataType, DATETIME_PRECISION AS datetimePrecision
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'file_upload_outbox'
              AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
            OR (TABLE_NAME = 'file_cleanup_records'
              AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
            OR (TABLE_NAME = 'file_move_intents'
              AND COLUMN_NAME IN ('recover_after', 'lease_expires_at', 'next_attempt_at'))
          )
        ORDER BY TABLE_NAME, COLUMN_NAME`,
    );

    expect(rows).toHaveLength(7);
    for (const row of rows as Array<Record<string, unknown>>) {
      expect(row.dataType).toBe('timestamp');
      expect(Number(row.datetimePrecision)).toBe(6);
    }
  });

  it.each([
    {
      producerTimeZone: '+00:00',
      consumerTimeZone: '+08:00',
      fileId: '16161616-1616-4616-8616-161616161616',
      outboxId: '17171717-1717-4717-8717-171717171717',
    },
    {
      producerTimeZone: '+08:00',
      consumerTimeZone: '+00:00',
      fileId: '18181818-1818-4818-8818-181818181818',
      outboxId: '19191919-1919-4919-8919-191919191919',
    },
  ])(
    'claims, renews, and completes across producer $producerTimeZone and consumer $consumerTimeZone sessions',
    async ({ producerTimeZone, consumerTimeZone, fileId, outboxId }) => {
      const producer = dataSource.createQueryRunner();
      const consumer = dataSource.createQueryRunner();
      await producer.connect();
      await consumer.connect();
      let releaseQueue!: () => void;
      let signalQueueStarted!: () => void;
      const queueWait = new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      const queueStarted = new Promise<void>((resolve) => {
        signalQueueStarted = resolve;
      });
      let dispatch: Promise<void> | undefined;

      try {
        await producer.query('SET time_zone = ?', [producerTimeZone]);
        await consumer.query('SET time_zone = ?', [consumerTimeZone]);
        await producer.query(
          `INSERT INTO source_files (
             id, project_id, file_name, file_type, file_size, file_path
           ) VALUES (?, ?, 'cross-zone.pdf', 'pdf', 1, ?)`,
          [fileId, PROJECT_ID, path.join(uploadRoot, `${fileId}.pdf`)],
        );
        await producer.query(
          `INSERT INTO file_upload_outbox (
             id, file_id, project_id, job_id, status, attempts, last_error,
             lease_owner, lease_expires_at, next_attempt_at
           ) VALUES (
             ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, CURRENT_TIMESTAMP(6)
           )`,
          [outboxId, fileId, PROJECT_ID, `file-parse:${fileId}`],
        );
        const queue = {
          add: jest.fn(async () => {
            signalQueueStarted();
            await queueWait;
          }),
        };
        const dispatcher = new FileUploadOutboxDispatcher(
          consumer.manager.getRepository(FileUploadOutbox),
          queue as never,
        );

        dispatch = dispatcher.dispatchPending();
        const claimed = await Promise.race([
          queueStarted.then(() => true),
          dispatch.then(() => false),
        ]);
        let leaseSeconds = 0;
        if (claimed) {
          const leaseRows: unknown = await consumer.query(
            `SELECT TIMESTAMPDIFF(
               MICROSECOND,
               CURRENT_TIMESTAMP(6),
               lease_expires_at
             ) / 1000000 AS leaseSeconds
             FROM file_upload_outbox
             WHERE id = ?`,
            [outboxId],
          );
          leaseSeconds = Number(firstMysqlRow(leaseRows)?.leaseSeconds);
        }
        releaseQueue();
        await dispatch;

        expect(claimed).toBe(true);
        expect(leaseSeconds).toBeGreaterThan(50);
        expect(leaseSeconds).toBeLessThanOrEqual(61);
        expect(queue.add).toHaveBeenCalledTimes(1);
        await expect(
          consumer.manager
            .getRepository(FileUploadOutbox)
            .findOneByOrFail({ id: outboxId }),
        ).resolves.toMatchObject({
          status: 'published',
          attempts: 1,
          lease_owner: null,
          lease_expires_at: null,
        });
      } finally {
        releaseQueue();
        await dispatch?.catch(() => undefined);
        await producer.query("SET time_zone = 'SYSTEM'");
        await consumer.query("SET time_zone = 'SYSTEM'");
        await producer.release();
        await consumer.release();
      }
    },
  );

  it.each(['+00:00', '+08:00'])(
    'claims, renews, and recovers an expired move intent with session time_zone=%s',
    async (sessionTimeZone) => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      const destination = path.join(
        uploadRoot,
        PROJECT_ID,
        `timezone-${sessionTimeZone.replace(/\W/g, '')}.pdf`,
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, 'orphan');
      let releaseLookup!: () => void;
      let signalLookup!: () => void;
      const lookupStarted = new Promise<void>((resolve) => {
        signalLookup = resolve;
      });
      const lookupWait = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      let dispatch: Promise<void> | undefined;

      try {
        await runner.query('SET time_zone = ?', [sessionTimeZone]);
        await runner.query(
          `INSERT INTO file_move_intents (
             id, status, source_path, destination_path, file_id, project_id,
             user_id, file_size, writer_token, recover_after, attempts,
             last_error, lease_owner, lease_expires_at, next_attempt_at
           ) VALUES (
             ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?,
             DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND),
             0, NULL, ?,
             DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND),
             DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
           )`,
          [
            '12121212-1212-4212-8212-121212121212',
            path.join(uploadRoot, '.quarantine', 'missing.pdf'),
            destination,
            '13131313-1313-4313-8313-131313131313',
            PROJECT_ID,
            USER_ID,
            6,
            'expired-writer',
            'expired-writer',
          ],
        );
        const dispatcher = new FileMoveIntentDispatcher(
          runner.manager.getRepository(FileMoveIntent),
          {
            findOneBy: jest.fn(async () => {
              signalLookup();
              await lookupWait;
              return null;
            }),
          } as never,
        );

        dispatch = dispatcher.dispatchPending();
        await lookupStarted;
        const leaseRows: unknown = await runner.query(
          `SELECT TIMESTAMPDIFF(
             MICROSECOND,
             CURRENT_TIMESTAMP(6),
             lease_expires_at
           ) / 1000000 AS leaseSeconds
           FROM file_move_intents
           WHERE id = ?`,
          ['12121212-1212-4212-8212-121212121212'],
        );
        const leaseSeconds = Number(firstMysqlRow(leaseRows)?.leaseSeconds);
        expect(leaseSeconds).toBeGreaterThan(50);
        expect(leaseSeconds).toBeLessThanOrEqual(61);

        releaseLookup();
        await dispatch;
        await expect(fs.access(destination)).rejects.toThrow();
        expect(await runner.manager.getRepository(FileMoveIntent).count()).toBe(
          0,
        );
      } finally {
        releaseLookup?.();
        await dispatch?.catch(() => undefined);
        await runner.query("SET time_zone = 'SYSTEM'");
        await runner.release();
      }
    },
  );

  it.each(['+00:00', '+08:00'])(
    'computes retry backoff from the same database clock with session time_zone=%s',
    async (sessionTimeZone) => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      const fileId = '14141414-1414-4414-8414-141414141414';
      const outboxId = '15151515-1515-4515-8515-151515151515';
      try {
        await runner.query('SET time_zone = ?', [sessionTimeZone]);
        await runner.query(
          `INSERT INTO source_files (
             id, project_id, file_name, file_type, file_size, file_path
           ) VALUES (?, ?, 'timezone.pdf', 'pdf', 1, ?)`,
          [fileId, PROJECT_ID, path.join(uploadRoot, 'timezone.pdf')],
        );
        await runner.query(
          `INSERT INTO file_upload_outbox (
             id, file_id, project_id, job_id, status, attempts, last_error,
             lease_owner, lease_expires_at, next_attempt_at
           ) VALUES (
             ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL,
             DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
           )`,
          [outboxId, fileId, PROJECT_ID, `file-parse:${fileId}`],
        );
        const queue = {
          add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
        };
        const dispatcher = new FileUploadOutboxDispatcher(
          runner.manager.getRepository(FileUploadOutbox),
          queue as never,
        );

        await dispatcher.dispatchPending();

        const retryRows: unknown = await runner.query(
          `SELECT TIMESTAMPDIFF(
             MICROSECOND,
             CURRENT_TIMESTAMP(6),
             next_attempt_at
           ) / 1000000 AS retrySeconds
           FROM file_upload_outbox
           WHERE id = ?`,
          [outboxId],
        );
        const retrySeconds = Number(firstMysqlRow(retryRows)?.retrySeconds);
        expect(retrySeconds).toBeGreaterThan(0);
        expect(retrySeconds).toBeLessThanOrEqual(3);
        await dispatcher.dispatchPending();
        expect(queue.add).toHaveBeenCalledTimes(1);
      } finally {
        await runner.query("SET time_zone = 'SYSTEM'");
        await runner.release();
      }
    },
  );

  it('does not recover an ACTIVE move intent while the uploader is paused before commit', async () => {
    await dataSource.query(`
      CREATE TRIGGER pause_source_file
      BEFORE INSERT ON source_files
      FOR EACH ROW
      BEGIN
        IF NEW.file_name = 'paused.pdf' THEN
          DO SLEEP(2);
        END IF;
      END
    `);
    const service = createFileService(dataSource);
    const source = await writeQuarantinePdf(uploadRoot, 'paused.pdf');

    const upload = service.uploadFiles(USER_ID, PROJECT_ID, [source]);
    const [movedName] = await waitForFileCount(
      path.join(uploadRoot, PROJECT_ID),
      1,
    );
    const destination = path.join(uploadRoot, PROJECT_ID, movedName);
    const activeIntent = await dataSource
      .getRepository(FileMoveIntent)
      .findOneByOrFail({ project_id: PROJECT_ID });
    expect(activeIntent.status).toBe('ACTIVE');
    const activeDeadlineRows: unknown = await dataSource.query(
      `SELECT
         recover_after > CURRENT_TIMESTAMP(6) AS recoveryFuture,
         lease_expires_at > CURRENT_TIMESTAMP(6) AS leaseFuture,
         next_attempt_at <= CURRENT_TIMESTAMP(6) AS retryDue
       FROM file_move_intents
       WHERE id = ?`,
      [activeIntent.id],
    );
    const activeDeadlines = firstMysqlRow(activeDeadlineRows);
    expect(Number(activeDeadlines?.recoveryFuture)).toBe(1);
    expect(Number(activeDeadlines?.leaseFuture)).toBe(1);
    expect(Number(activeDeadlines?.retryDue)).toBe(1);

    const worker = new FileMoveIntentDispatcher(
      dataSource.getRepository(FileMoveIntent),
      dataSource.getRepository(SourceFile),
    );
    await worker.dispatchPending();

    await expect(fs.access(destination)).resolves.toBeUndefined();
    expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(1);
    const [stored] = await upload;
    await expect(fs.access(stored.file_path)).resolves.toBeUndefined();
    expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(0);
  });

  it('recovers an expired ACTIVE intent after a crash immediately following rename', async () => {
    const source = await writeQuarantinePdf(uploadRoot, 'crash.pdf');
    const destinationDir = path.join(uploadRoot, PROJECT_ID);
    await fs.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, 'crash-recovery.pdf');
    await insertExpiredMoveIntent(dataSource, {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sourcePath: source.path,
      destinationPath: destination,
      fileId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      fileSize: source.size,
    });
    await fs.rename(source.path, destination);
    const eligibilityRows: unknown = await dataSource.query(
      `SELECT
         recover_after <= CURRENT_TIMESTAMP(6) AS recoveryDue,
         lease_expires_at <= CURRENT_TIMESTAMP(6) AS leaseExpired,
         next_attempt_at <= CURRENT_TIMESTAMP(6) AS retryDue
       FROM file_move_intents
       WHERE id = ?`,
      ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    );
    const eligibility = firstMysqlRow(eligibilityRows);
    expect(Number(eligibility?.recoveryDue)).toBe(1);
    expect(Number(eligibility?.leaseExpired)).toBe(1);
    expect(Number(eligibility?.retryDue)).toBe(1);

    const restarted = new FileMoveIntentDispatcher(
      dataSource.getRepository(FileMoveIntent),
      dataSource.getRepository(SourceFile),
    );
    await restarted.dispatchPending();

    await expect(fs.access(destination)).rejects.toThrow();
    expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(0);
  });

  it('clears an expired ACTIVE intent without deleting a committed SourceFile', async () => {
    const source = await writeQuarantinePdf(uploadRoot, 'committed.pdf');
    const destinationDir = path.join(uploadRoot, PROJECT_ID);
    await fs.mkdir(destinationDir, { recursive: true });
    const destination = path.join(destinationDir, 'committed.pdf');
    const fileId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await insertExpiredMoveIntent(dataSource, {
      id: '99999999-9999-4999-8999-999999999999',
      sourcePath: source.path,
      destinationPath: destination,
      fileId,
      fileSize: source.size,
    });
    await fs.rename(source.path, destination);
    await dataSource.getRepository(SourceFile).save({
      id: fileId,
      project_id: PROJECT_ID,
      file_name: 'committed.pdf',
      file_type: 'pdf',
      file_size: source.size,
      file_path: destination,
      parse_status: 'pending',
      error_message: null,
    });

    const restarted = new FileMoveIntentDispatcher(
      dataSource.getRepository(FileMoveIntent),
      dataSource.getRepository(SourceFile),
    );
    await restarted.dispatchPending();

    await expect(fs.access(destination)).resolves.toBeUndefined();
    expect(await dataSource.getRepository(FileMoveIntent).count()).toBe(0);
  });

  it('permanently rejects a cleanup record whose path became a directory', async () => {
    await dataSource.query(`
      CREATE TRIGGER fail_second_source_file
      BEFORE INSERT ON source_files
      FOR EACH ROW
      BEGIN
        IF NEW.file_name = 'fail.pdf' THEN
          DO SLEEP(1);
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced second save failure';
        END IF;
      END
    `);
    const service = createFileService(dataSource);
    const first = await writeQuarantinePdf(uploadRoot, 'first.pdf');
    const second = await writeQuarantinePdf(uploadRoot, 'fail.pdf');
    const upload = service.uploadFiles(USER_ID, PROJECT_ID, [first, second]);
    const projectDir = path.join(uploadRoot, PROJECT_ID);
    const movedFiles = await waitForFileCount(projectDir, 2);
    const blockedCleanupPath = path.join(projectDir, movedFiles[0]);
    await fs.unlink(blockedCleanupPath);
    await fs.mkdir(blockedCleanupPath);

    await expect(upload).rejects.toThrow('forced second save failure');
    expect(await dataSource.getRepository(SourceFile).count()).toBe(0);
    expect(await dataSource.getRepository(FileUploadOutbox).count()).toBe(0);
    await expect(
      dataSource.getRepository(FileCleanupRecord).findOneByOrFail({
        file_path: blockedCleanupPath,
      }),
    ).resolves.toMatchObject({
      attempts: 0,
      last_error: null,
    });

    const cleanupDispatcher = new FileCleanupDispatcher(
      dataSource.getRepository(FileCleanupRecord),
    );
    await cleanupDispatcher.dispatchPending();
    const retryRecord = await dataSource
      .getRepository(FileCleanupRecord)
      .findOneByOrFail({
        file_path: blockedCleanupPath,
      });
    expect(retryRecord.status).toBe('rejected');
    expect(retryRecord.attempts).toBe(1);
    expect(retryRecord.last_error).toContain('Unsafe cleanup path');
    await expect(fs.stat(blockedCleanupPath)).resolves.toMatchObject({});
  });

  it('normalizes live DATETIME lease state after 171207 without prematurely recovering files', async () => {
    const upgradeDatabase = `write_agent_upgrade_${process.pid}_${Date.now()}`;
    const upgradeDestination = path.join(
      uploadRoot,
      PROJECT_ID,
      'upgrade-active.pdf',
    );
    await fs.mkdir(path.dirname(upgradeDestination), { recursive: true });
    await fs.writeFile(upgradeDestination, 'upgrade active');
    await dataSource.query(
      `CREATE DATABASE \`${upgradeDatabase}\` CHARACTER SET utf8mb4`,
    );
    let upgraded: DataSource | undefined;
    let old: DataSource | undefined;
    let oldProducer: QueryRunner | undefined;
    let consumer: QueryRunner | undefined;
    try {
      old = createMysqlDataSource(upgradeDatabase, [
        InitSchema1710700000000,
        OldCreateFileUploadReliabilityTables1712050000000,
        HardenFileUploadLeases1712060000000,
        UseDatabaseClockForFileUploadLeases1712070000000,
      ]);
      await old.initialize();
      await old.runMigrations({ transaction: 'each' });
      oldProducer = old.createQueryRunner();
      await oldProducer.connect();
      await oldProducer.query("SET time_zone = '+00:00'");
      await oldProducer.query(
        `INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)`,
        [USER_ID, 'upgrade@example.test', 'not-used'],
      );
      await oldProducer.query(
        `INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`,
        [PROJECT_ID, USER_ID, 'Upgrade integration'],
      );
      await oldProducer.query(
        `INSERT INTO source_files (
           id, project_id, file_name, file_type, file_size, file_path
         ) VALUES (?, ?, 'upgrade-outbox.pdf', 'pdf', 1, ?)`,
        [
          '20202020-2020-4020-8020-202020202020',
          PROJECT_ID,
          path.join(uploadRoot, 'upgrade-outbox.pdf'),
        ],
      );
      await oldProducer.query(
        `INSERT INTO file_upload_outbox (
           id, file_id, project_id, job_id, status, attempts, last_error,
           lease_owner, lease_expires_at, next_attempt_at
         ) VALUES (
           ?, ?, ?, ?, 'pending', 0, NULL, 'old-outbox-owner',
           DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR),
           DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR)
         )`,
        [
          '21212121-2121-4121-8121-212121212121',
          '20202020-2020-4020-8020-202020202020',
          PROJECT_ID,
          'file-parse:20202020-2020-4020-8020-202020202020',
        ],
      );
      await oldProducer.query(
        `INSERT INTO file_cleanup_records (
           id, file_path, reason, status, attempts, last_error,
           lease_owner, lease_expires_at, next_attempt_at
         ) VALUES (
           ?, ?, 'old cleanup', 'pending', 0, NULL, 'old-cleanup-owner',
           DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR),
           DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR)
         )`,
        [
          '22222222-2222-4222-8222-222222222222',
          path.join(uploadRoot, 'old-cleanup.pdf'),
        ],
      );
      await oldProducer.query(
        `INSERT INTO file_move_intents (
           id, status, source_path, destination_path, file_id, project_id,
           user_id, file_size, writer_token, recover_after, attempts,
           last_error, lease_owner, lease_expires_at, next_attempt_at
         ) VALUES (
           ?, 'ACTIVE', ?, ?, ?, ?, ?, 14, 'old-writer',
           DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR),
           0, NULL, 'old-writer',
           DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR),
           DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 8 HOUR)
         )`,
        [
          '23232323-2323-4323-8323-232323232323',
          path.join(uploadRoot, '.quarantine', 'missing-upgrade.pdf'),
          upgradeDestination,
          '24242424-2424-4424-8424-242424242424',
          PROJECT_ID,
          USER_ID,
        ],
      );
      await oldProducer.query("SET time_zone = 'SYSTEM'");
      await oldProducer.release();
      oldProducer = undefined;
      await old.destroy();
      old = undefined;

      upgraded = createMysqlDataSource(upgradeDatabase, [
        InitSchema1710700000000,
        CreateFileUploadReliabilityTables1712050000000,
        HardenFileUploadLeases1712060000000,
        UseDatabaseClockForFileUploadLeases1712070000000,
        NormalizeUploadLeaseTimestamps1712080000000,
      ]);
      await upgraded.initialize();
      await upgraded.runMigrations({ transaction: 'each' });

      const rows: unknown = await upgraded.query(
        `SELECT
           COUNT(DISTINCT CASE WHEN TABLE_NAME = 'file_move_intents' THEN TABLE_NAME END) AS moveTable,
           COUNT(DISTINCT CASE
             WHEN TABLE_NAME = 'file_upload_outbox'
              AND COLUMN_NAME IN ('lease_owner', 'lease_expires_at', 'next_attempt_at')
             THEN COLUMN_NAME END) AS outboxLeaseColumns,
           COUNT(DISTINCT CASE
             WHEN TABLE_NAME = 'file_cleanup_records'
              AND COLUMN_NAME IN ('status', 'lease_owner', 'lease_expires_at', 'next_attempt_at')
             THEN COLUMN_NAME END) AS cleanupLeaseColumns,
           COUNT(DISTINCT CASE
             WHEN TABLE_NAME = 'file_move_intents'
              AND COLUMN_NAME IN ('writer_token', 'recover_after', 'lease_owner', 'lease_expires_at', 'next_attempt_at')
             THEN COLUMN_NAME END) AS moveLeaseColumns,
           MIN(CASE
             WHEN (
               (TABLE_NAME = 'file_upload_outbox'
                 AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
               OR (TABLE_NAME = 'file_cleanup_records'
                 AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
               OR (TABLE_NAME = 'file_move_intents'
                 AND COLUMN_NAME IN ('recover_after', 'lease_expires_at', 'next_attempt_at'))
             )
             THEN DATETIME_PRECISION END) AS leasePrecision,
           SUM(CASE
             WHEN (
               (TABLE_NAME = 'file_upload_outbox'
                 AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
               OR (TABLE_NAME = 'file_cleanup_records'
                 AND COLUMN_NAME IN ('lease_expires_at', 'next_attempt_at'))
               OR (TABLE_NAME = 'file_move_intents'
                 AND COLUMN_NAME IN ('recover_after', 'lease_expires_at', 'next_attempt_at'))
             ) AND DATA_TYPE = 'timestamp'
             THEN 1 ELSE 0 END) AS timestampDeadlines,
           MAX(CASE
             WHEN TABLE_NAME = 'file_move_intents' AND COLUMN_NAME = 'status'
             THEN COLUMN_DEFAULT END) AS moveStatusDefault
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?`,
        [upgradeDatabase],
      );
      const schema = firstMysqlRow(rows);
      expect(Number(schema?.moveTable)).toBe(1);
      expect(Number(schema?.outboxLeaseColumns)).toBe(3);
      expect(Number(schema?.cleanupLeaseColumns)).toBe(4);
      expect(Number(schema?.moveLeaseColumns)).toBe(5);
      expect(Number(schema?.leasePrecision)).toBe(6);
      expect(Number(schema?.timestampDeadlines)).toBe(7);
      expect(schema?.moveStatusDefault).toBe('ACTIVE');

      consumer = upgraded.createQueryRunner();
      await consumer.connect();
      await consumer.query("SET time_zone = '+08:00'");
      const normalizedRows: unknown = await consumer.query(
        `SELECT
           (SELECT lease_owner IS NULL
              FROM file_upload_outbox
             WHERE id = '21212121-2121-4121-8121-212121212121') AS outboxLeaseCleared,
           (SELECT next_attempt_at <= CURRENT_TIMESTAMP(6)
              FROM file_upload_outbox
             WHERE id = '21212121-2121-4121-8121-212121212121') AS outboxDue,
           (SELECT lease_owner IS NULL
              FROM file_cleanup_records
             WHERE id = '22222222-2222-4222-8222-222222222222') AS cleanupLeaseCleared,
           (SELECT next_attempt_at <= CURRENT_TIMESTAMP(6)
              FROM file_cleanup_records
             WHERE id = '22222222-2222-4222-8222-222222222222') AS cleanupDue,
           (SELECT status = 'UNCERTAIN'
              FROM file_move_intents
             WHERE id = '23232323-2323-4323-8323-232323232323') AS moveUncertain,
           (SELECT lease_owner IS NULL
              FROM file_move_intents
             WHERE id = '23232323-2323-4323-8323-232323232323') AS moveLeaseCleared,
           (SELECT recover_after > CURRENT_TIMESTAMP(6)
              FROM file_move_intents
             WHERE id = '23232323-2323-4323-8323-232323232323') AS moveGraceFuture,
           (SELECT next_attempt_at > CURRENT_TIMESTAMP(6)
              FROM file_move_intents
             WHERE id = '23232323-2323-4323-8323-232323232323') AS moveRetryFuture`,
      );
      const normalized = firstMysqlRow(normalizedRows);
      expect(Number(normalized?.outboxLeaseCleared)).toBe(1);
      expect(Number(normalized?.outboxDue)).toBe(1);
      expect(Number(normalized?.cleanupLeaseCleared)).toBe(1);
      expect(Number(normalized?.cleanupDue)).toBe(1);
      expect(Number(normalized?.moveUncertain)).toBe(1);
      expect(Number(normalized?.moveLeaseCleared)).toBe(1);
      expect(Number(normalized?.moveGraceFuture)).toBe(1);
      expect(Number(normalized?.moveRetryFuture)).toBe(1);

      const recovery = new FileMoveIntentDispatcher(
        consumer.manager.getRepository(FileMoveIntent),
        consumer.manager.getRepository(SourceFile),
      );
      await recovery.dispatchPending();
      await expect(fs.readFile(upgradeDestination, 'utf8')).resolves.toBe(
        'upgrade active',
      );
      expect(
        await consumer.manager.getRepository(FileMoveIntent).countBy({
          id: '23232323-2323-4323-8323-232323232323',
        }),
      ).toBe(1);
    } finally {
      if (oldProducer && !oldProducer.isReleased) {
        await oldProducer
          .query("SET time_zone = 'SYSTEM'")
          .catch(() => undefined);
        await oldProducer.release().catch(() => undefined);
      }
      if (old?.isInitialized) await old.destroy();
      if (consumer && !consumer.isReleased) {
        await consumer.query("SET time_zone = 'SYSTEM'").catch(() => undefined);
        await consumer.release();
      }
      if (upgraded?.isInitialized) await upgraded.destroy();
      await dataSource.query(`DROP DATABASE IF EXISTS \`${upgradeDatabase}\``);
    }
  });
});

class OldCreateFileUploadReliabilityTables1712050000000 implements MigrationInterface {
  name = 'CreateFileUploadReliabilityTables1712050000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS file_upload_outbox (
      id VARCHAR(36) NOT NULL DEFAULT (UUID()), file_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL, job_id VARCHAR(100) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_file_upload_outbox_file (file_id),
      UNIQUE KEY uq_file_upload_outbox_job (job_id),
      KEY idx_file_upload_outbox_status (status),
      CONSTRAINT file_upload_outbox_file_fkey FOREIGN KEY (file_id) REFERENCES source_files(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS file_cleanup_records (
      id VARCHAR(36) NOT NULL DEFAULT (UUID()), file_path VARCHAR(1000) NOT NULL,
      reason TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0, last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id),
      KEY idx_file_cleanup_records_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS file_cleanup_records');
    await queryRunner.query('DROP TABLE IF EXISTS file_upload_outbox');
  }
}

function createMysqlDataSource(
  database: string,
  migrations: Array<new () => MigrationInterface>,
): DataSource {
  return new DataSource({
    type: 'mysql',
    host: process.env.FILE_UPLOAD_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.FILE_UPLOAD_MYSQL_PORT || 3306),
    username: process.env.FILE_UPLOAD_MYSQL_USER || 'root',
    password: process.env.FILE_UPLOAD_MYSQL_PASSWORD || '',
    database,
    charset: 'utf8mb4',
    timezone: '+08:00',
    entities: [
      SourceFile,
      Document,
      FileUploadOutbox,
      FileCleanupRecord,
      FileMoveIntent,
    ],
    migrations,
    migrationsTableName: 'typeorm_migrations',
  });
}

function firstMysqlRow(rows: unknown): Record<string, unknown> | undefined {
  return Array.isArray(rows) && rows[0] !== null && typeof rows[0] === 'object'
    ? (rows[0] as Record<string, unknown>)
    : undefined;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createFileService(
  dataSource: DataSource,
  outboxDispatcher: { dispatchPending: jest.Mock } = {
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  },
): FileService {
  return new FileService(
    dataSource.getRepository(SourceFile),
    dataSource.getRepository(Document),
    {} as never,
    {} as never,
    dataSource.getRepository(FileUploadOutbox),
    dataSource.getRepository(FileCleanupRecord),
    dataSource.getRepository(FileMoveIntent),
    {} as never,
    { findOne: jest.fn().mockResolvedValue({ id: PROJECT_ID }) } as never,
    outboxDispatcher as never,
  );
}

async function writeQuarantinePdf(
  uploadRoot: string,
  originalname: string,
): Promise<Express.Multer.File> {
  const quarantineDir = path.join(uploadRoot, '.quarantine');
  await fs.mkdir(quarantineDir, { recursive: true });
  const filePath = path.join(
    quarantineDir,
    `${Date.now()}-${Math.random()}.pdf`,
  );
  const contents = Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');
  await fs.writeFile(filePath, contents);
  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype: 'application/pdf',
    size: contents.length,
    destination: quarantineDir,
    filename: path.basename(filePath),
    path: filePath,
    buffer: contents,
    stream: undefined as never,
  };
}

async function waitForFileCount(
  directory: string,
  expected: number,
): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const entries = await fs.readdir(directory);
      if (entries.length === expected) return entries;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} moved files`);
}

async function waitForMysqlLockFree(
  dataSource: DataSource,
  lockName: string,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows: unknown = await dataSource.query(
      'SELECT IS_FREE_LOCK(?) AS isFree',
      [lockName],
    );
    const firstRow =
      Array.isArray(rows) &&
      rows[0] !== null &&
      typeof rows[0] === 'object' &&
      'isFree' in rows[0]
        ? (rows[0] as { isFree: unknown })
        : undefined;
    const isFree = firstRow?.isFree;
    if (Number(isFree) === 1) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function insertExpiredMoveIntent(
  dataSource: DataSource,
  intent: {
    id: string;
    sourcePath: string;
    destinationPath: string;
    fileId: string;
    fileSize: number;
  },
): Promise<void> {
  await dataSource.query(
    `INSERT INTO file_move_intents (
       id, status, source_path, destination_path, file_id, project_id,
       user_id, file_size, writer_token, recover_after, attempts,
       last_error, lease_owner, lease_expires_at, next_attempt_at
     ) VALUES (
       ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, 'crashed-writer',
       DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 MINUTE),
       0, NULL, 'crashed-writer',
       DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 MINUTE),
       DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 MINUTE)
     )`,
    [
      intent.id,
      intent.sourcePath,
      intent.destinationPath,
      intent.fileId,
      PROJECT_ID,
      USER_ID,
      intent.fileSize,
    ],
  );
}
