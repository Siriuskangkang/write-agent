import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { FileService } from './file.service.js';
import { ProjectUploadGuard } from './guards/project-upload.guard.js';
import { SourceFile } from './entities/source-file.entity.js';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import type { StorageOperationPreimageV1 } from '../storage/storage-operation.contract.js';

describe('secure file upload lifecycle', () => {
  let uploadRoot: string;
  let service: FileService;
  let fileRepository: {
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager?: unknown;
  };
  let projectService: { findOne: jest.Mock };
  let parseQueue: { add: jest.Mock };
  let outboxDispatcher: { dispatchPending: jest.Mock };
  let outboxRepository: { create: jest.Mock; save: jest.Mock };
  let cleanupRepository: { create: jest.Mock; save: jest.Mock };
  let moveIntentRepository: {
    create: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    manager?: unknown;
  };
  let quotaQuery: {
    innerJoin: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
  };
  let queryRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isReleased: boolean;
    manager: {
      getRepository: jest.Mock;
      createQueryBuilder: jest.Mock;
    };
    databaseConnection: { destroy: jest.Mock };
  };
  let recoveryRunner: {
    connect: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
    isReleased: boolean;
    manager: {
      getRepository: jest.Mock;
    };
    databaseConnection: { destroy: jest.Mock };
  };
  let createQueryRunner: jest.Mock;

  beforeEach(async () => {
    uploadRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-upload-'),
    );
    process.env.UPLOAD_DIR = uploadRoot;
    delete process.env.MAX_USER_STORAGE;

    quotaQuery = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
    };
    fileRepository = {
      create: jest.fn(
        (value: Partial<SourceFile>): SourceFile => value as SourceFile,
      ),
      save: jest.fn(
        (value: SourceFile): Promise<SourceFile> =>
          Promise.resolve({ ...value, id: value.id || 'saved-file-id' }),
      ),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => quotaQuery),
    };
    outboxRepository = {
      create: jest.fn((value: object): object => value),
      save: jest.fn((value: object): Promise<object> => Promise.resolve(value)),
    };
    cleanupRepository = {
      create: jest.fn((value: object): object => value),
      save: jest.fn((value: object): Promise<object> => Promise.resolve(value)),
    };
    moveIntentRepository = {
      create: jest.fn((value: object): object => value),
      save: jest.fn((value: object) =>
        Promise.resolve({ ...value, id: 'move-intent-id' }),
      ),
      insert: jest.fn().mockResolvedValue({ identifiers: [] }),
      upsert: jest.fn().mockResolvedValue({ identifiers: [] }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const transactionManager = {
      getRepository: jest.fn((entity) => {
        if (entity === SourceFile) return fileRepository;
        if (entity === FileMoveIntent) return moveIntentRepository;
        return outboxRepository;
      }),
      createQueryBuilder: jest.fn(() => quotaQuery),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockResolvedValueOnce([{ acquired: 1 }])
        .mockResolvedValueOnce([{ released: 1 }]),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isReleased: false,
      manager: transactionManager,
      databaseConnection: { destroy: jest.fn() },
    };
    recoveryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ lockWaitTimeout: 50 }]),
      release: jest.fn().mockResolvedValue(undefined),
      isReleased: false,
      manager: {
        getRepository: jest.fn(() => moveIntentRepository),
      },
      databaseConnection: { destroy: jest.fn() },
    };
    createQueryRunner = jest.fn(() => queryRunner);
    fileRepository.manager = {
      connection: { createQueryRunner },
    };
    moveIntentRepository.manager = {
      connection: { createQueryRunner },
    };
    projectService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1' }),
    };
    parseQueue = { add: jest.fn().mockResolvedValue(undefined) };
    outboxDispatcher = {
      dispatchPending: jest.fn().mockResolvedValue(undefined),
    };
    service = new FileService(
      fileRepository as never,
      {} as never,
      {} as never,
      parseQueue as never,
      outboxRepository as never,
      cleanupRepository as never,
      moveIntentRepository as never,
      {} as never,
      projectService as never,
      outboxDispatcher as never,
    );
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    delete process.env.MAX_USER_STORAGE;
    delete process.env.STORAGE_AUTHORITY_MODE;
    delete process.env.STORAGE_PROTECTED_ROOT;
    delete process.env.STORAGE_QUARANTINE_ROOT;
    jest.restoreAllMocks();
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  it('commits broker metadata before requesting promotion without writing the protected root', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const quarantineRoot = path.join(uploadRoot, 'broker-quarantine');
    const protectedRoot = path.join(uploadRoot, 'broker-protected');
    process.env.STORAGE_AUTHORITY_MODE = 'broker';
    process.env.STORAGE_QUARANTINE_ROOT = quarantineRoot;
    process.env.STORAGE_PROTECTED_ROOT = protectedRoot;
    projectService.findOne.mockResolvedValue({ id: projectId });
    const readiness = {
      assertReady: jest.fn().mockResolvedValue({
        storage_epoch: '33333333-3333-4333-8333-333333333333',
        storage_contract_version: 'storage-broker.v1',
      }),
    };
    const storageRequests = {
      request: jest.fn().mockResolvedValue({
        intent_id: 'ignored-by-test',
        status: 'PENDING',
        execution_fence_decimal: '0',
        result_code: null,
      }),
    };
    service = new FileService(
      fileRepository as never,
      {} as never,
      {} as never,
      parseQueue as never,
      outboxRepository as never,
      cleanupRepository as never,
      moveIntentRepository as never,
      {} as never,
      projectService as never,
      outboxDispatcher as never,
      readiness as never,
      storageRequests as never,
    );
    const file = await writeQuarantineFileAt(
      quarantineRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    const [saved] = await service.uploadFiles(userId, projectId, [file]);

    expect(saved.file_path).toMatch(
      new RegExp(`^${escapeRegExp(protectedRoot)}${escapeRegExp(path.sep)}p`),
    );
    await expect(fs.access(saved.file_path)).rejects.toThrow();
    expect(storageRequests.request).toHaveBeenCalledTimes(1);
    expect(storageRequests.request).toHaveBeenCalledWith(
      queryRunner,
      expect.objectContaining({
        kind: 'PROMOTE',
        actor_id: userId,
        project_id: projectId,
        source_file_id: saved.id,
        expected_sha256: createHash('sha256').update('%PDF-1.7').digest('hex'),
        authorization_kind: 'UPLOAD_COMMIT',
      }),
    );
    const operation = mockCallArgument<StorageOperationPreimageV1>(
      storageRequests.request,
      0,
      1,
    );
    expect(operation.quarantine_key).toBe(`${operation.intent_id}.upload`);
    await expect(
      fs.access(path.join(quarantineRoot, operation.quarantine_key)),
    ).resolves.toBeUndefined();
    expect(outboxRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: operation.authorization_id,
        status: 'storage_preparing',
        storage_intent_id: null,
      }),
    );
    expect(outboxDispatcher.dispatchPending).not.toHaveBeenCalled();
    expect(storageRequests.request.mock.invocationCallOrder[0]).toBeLessThan(
      queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
  });

  it('rolls back broker metadata and persists quarantine recovery when cleanup fails', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const projectId = '22222222-2222-4222-8222-222222222222';
    const quarantineRoot = path.join(uploadRoot, 'broker-quarantine');
    process.env.STORAGE_AUTHORITY_MODE = 'broker';
    process.env.STORAGE_QUARANTINE_ROOT = quarantineRoot;
    process.env.STORAGE_PROTECTED_ROOT = path.join(
      uploadRoot,
      'broker-protected',
    );
    projectService.findOne.mockResolvedValue({ id: projectId });
    const readiness = {
      assertReady: jest.fn().mockResolvedValue({
        storage_epoch: '33333333-3333-4333-8333-333333333333',
        storage_contract_version: 'storage-broker.v1',
      }),
    };
    const storageRequests = {
      request: jest
        .fn()
        .mockRejectedValue(new Error('STORAGE_PROMOTION_REJECTED')),
    };
    service = new FileService(
      fileRepository as never,
      {} as never,
      {} as never,
      parseQueue as never,
      outboxRepository as never,
      cleanupRepository as never,
      moveIntentRepository as never,
      {} as never,
      projectService as never,
      outboxDispatcher as never,
      readiness as never,
      storageRequests as never,
    );
    const file = await writeQuarantineFileAt(
      quarantineRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );
    storageRequests.request.mockImplementationOnce(async () => {
      await fs.chmod(quarantineRoot, 0o555);
      throw new Error('STORAGE_PROMOTION_REJECTED');
    });
    try {
      await expect(
        service.uploadFiles(userId, projectId, [file]),
      ).rejects.toThrow('STORAGE_PROMOTION_REJECTED');
    } finally {
      await fs.chmod(quarantineRoot, 0o755);
    }

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    const retained = await fs.readdir(quarantineRoot);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatch(/^[0-9a-f-]{36}\.upload$/);
    expect(cleanupRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({
        file_path: path.join(quarantineRoot, retained[0]),
        reason: 'STORAGE_PROMOTION_REJECTED',
      }),
    ]);
  });

  it('rejects a foreign project before Multer can create a quarantine file', async () => {
    const projectAccessPolicy = {
      assertOwner: jest
        .fn()
        .mockRejectedValue(new ForbiddenException('无权访问该项目')),
    };
    const guard = new ProjectUploadGuard(projectAccessPolicy as never);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          params: { id: 'project-1' },
          user: { sub: 'other-user', email: 'other@example.test' },
        }),
      }),
    };

    await expect(guard.canActivate(context as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(fs.readdir(uploadRoot)).resolves.toEqual([]);
  });

  it('removes a quarantine file when project authorization rejects it', async () => {
    projectService.findOne.mockRejectedValue(new ForbiddenException());
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.txt',
      'text/plain',
      'notes',
    );

    await expect(
      service.uploadFiles('other-user', 'project-1', [file]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(fs.access(file.path)).rejects.toThrow();
  });

  it('removes an unsupported extension and MIME from quarantine', async () => {
    const file = await writeQuarantineFile(
      uploadRoot,
      'malware.exe',
      'application/pdf',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(fs.access(file.path)).rejects.toThrow();
    await expect(
      fs.readdir(path.join(uploadRoot, 'project-1')),
    ).rejects.toThrow();
  });

  it('removes a file whose extension and MIME disagree', async () => {
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'text/plain',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(fs.access(file.path)).rejects.toThrow();
  });

  it('moves a valid PDF atomically from quarantine into project storage', async () => {
    const file = await writeQuarantineFile(
      uploadRoot,
      'course-notes.pdf',
      'application/pdf',
      '%PDF-1.7\nlesson',
    );

    const [saved] = await service.uploadFiles('owner-1', 'project-1', [file]);

    expect(saved.file_path).toMatch(
      new RegExp(
        `${escapeRegExp(path.join(uploadRoot, 'project-1'))}.+\\.pdf$`,
      ),
    );
    await expect(fs.access(file.path)).rejects.toThrow();
    await expect(fs.readFile(saved.file_path, 'utf8')).resolves.toBe(
      '%PDF-1.7\nlesson',
    );
    expect(saved.checksum_sha256).toBe(
      createHash('sha256').update('%PDF-1.7\nlesson').digest('hex'),
    );
  });

  it('creates and renews move intent deadlines with database clock expressions', async () => {
    const file = await writeQuarantineFile(
      uploadRoot,
      'database-clock.pdf',
      'application/pdf',
      '%PDF-1.7\ndatabase clock',
    );

    await service.uploadFiles('owner-1', 'project-1', [file]);

    const inserted = mockCallArgument<{
      recover_after: () => string;
      lease_expires_at: () => string;
      next_attempt_at: () => string;
    }>(moveIntentRepository.insert, 0, 0);
    expect(inserted.recover_after()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 120 SECOND)',
    );
    expect(inserted.lease_expires_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 120 SECOND)',
    );
    expect(inserted.next_attempt_at()).toBe('CURRENT_TIMESTAMP(6)');

    const renew = mockCallArgument<{
      recover_after: () => string;
      lease_expires_at: () => string;
    }>(moveIntentRepository.update, 0, 1);
    expect(renew.recover_after()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 120 SECOND)',
    );
    expect(renew.lease_expires_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 120 SECOND)',
    );
  });

  it('treats every commitTransaction error as UNCERTAIN without an immediate database verdict', async () => {
    queryRunner.commitTransaction.mockRejectedValue(
      new Error('commit acknowledgement lost'),
    );
    createQueryRunner
      .mockReturnValueOnce(queryRunner)
      .mockReturnValueOnce(recoveryRunner);
    const file = await writeQuarantineFile(
      uploadRoot,
      'uncertain-commit.pdf',
      'application/pdf',
      '%PDF-1.7\nuncertain commit',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('commit acknowledgement lost');

    const storedPath = lastMockCallArgument<SourceFile>(
      fileRepository.create,
      0,
    ).file_path;
    await expect(fs.readFile(storedPath, 'utf8')).resolves.toBe(
      '%PDF-1.7\nuncertain commit',
    );
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(recoveryRunner.query).toHaveBeenCalledWith(
      'SET SESSION innodb_lock_wait_timeout = 2',
    );
    expect(recoveryRunner.query).toHaveBeenCalledWith(
      'SET SESSION innodb_lock_wait_timeout = ?',
      [50],
    );
    expect(
      recoveryRunner.query.mock.calls.some(([sql]) =>
        String(sql).includes('source_files'),
      ),
    ).toBe(false);
    expect(moveIntentRepository.upsert).toHaveBeenCalledTimes(1);
    expect(outboxDispatcher.dispatchPending).not.toHaveBeenCalled();
  });

  it('keeps the file when persisting the UNCERTAIN recovery intent also fails', async () => {
    queryRunner.commitTransaction.mockRejectedValue(
      new Error('commit acknowledgement lost'),
    );
    moveIntentRepository.upsert.mockRejectedValue(
      new Error('recovery database unavailable'),
    );
    createQueryRunner
      .mockReturnValueOnce(queryRunner)
      .mockReturnValueOnce(recoveryRunner);
    const file = await writeQuarantineFile(
      uploadRoot,
      'uncertain-upsert.pdf',
      'application/pdf',
      '%PDF-1.7\nuncertain upsert',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('commit acknowledgement lost');

    const storedPath = lastMockCallArgument<SourceFile>(
      fileRepository.create,
      0,
    ).file_path;
    await expect(fs.readFile(storedPath, 'utf8')).resolves.toBe(
      '%PDF-1.7\nuncertain upsert',
    );
    expect(recoveryRunner.query).toHaveBeenCalledWith(
      'SET SESSION innodb_lock_wait_timeout = 2',
    );
    expect(
      recoveryRunner.query.mock.calls.some(([sql]) =>
        String(sql).includes('source_files'),
      ),
    ).toBe(false);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('preserves files and delays every UNCERTAIN intent after a commit error', async () => {
    queryRunner.commitTransaction.mockRejectedValue(
      new Error('commit acknowledgement lost'),
    );
    createQueryRunner
      .mockReturnValueOnce(queryRunner)
      .mockReturnValueOnce(recoveryRunner);
    const file = await writeQuarantineFile(
      uploadRoot,
      'uncertain.pdf',
      'application/pdf',
      '%PDF-1.7\nuncertain',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('commit acknowledgement lost');

    const storedPath = lastMockCallArgument<SourceFile>(
      fileRepository.create,
      0,
    ).file_path;
    await expect(fs.readFile(storedPath, 'utf8')).resolves.toBe(
      '%PDF-1.7\nuncertain',
    );
    const uncertainIntents = lastMockCallArgument<
      Array<{
        writer_token: string;
        status: string;
        last_error: string;
        recover_after: () => string;
        next_attempt_at: () => string;
      }>
    >(moveIntentRepository.upsert, 0);
    expect(uncertainIntents).toHaveLength(1);
    expect(uncertainIntents[0]?.writer_token).toContain('upload-writer:');
    expect(uncertainIntents[0]?.status).toBe('UNCERTAIN');
    expect(uncertainIntents[0]?.last_error).toContain(
      'commit acknowledgement lost',
    );
    expect(uncertainIntents[0]?.recover_after()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 300 SECOND)',
    );
    expect(uncertainIntents[0]?.next_attempt_at()).toBe(
      'DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 300 SECOND)',
    );
    expect(recoveryRunner.query).toHaveBeenCalledWith(
      'SET SESSION innodb_lock_wait_timeout = 2',
    );
    expect(
      recoveryRunner.query.mock.calls.some(([sql]) =>
        String(sql).includes('source_files'),
      ),
    ).toBe(false);
    expect(
      lastMockCallArgument<string[]>(moveIntentRepository.upsert, 1),
    ).toEqual(['id']);
  });

  it('keeps the committed file and pending outbox when post-commit dispatch throws synchronously', async () => {
    outboxDispatcher.dispatchPending.mockImplementation(() => {
      throw new Error('dispatcher hook failed');
    });
    const file = await writeQuarantineFile(
      uploadRoot,
      'dispatch.pdf',
      'application/pdf',
      '%PDF-1.7\ndispatch',
    );

    const [saved] = await service.uploadFiles('owner-1', 'project-1', [file]);

    await expect(fs.readFile(saved.file_path, 'utf8')).resolves.toBe(
      '%PDF-1.7\ndispatch',
    );
    expect(outboxRepository.save).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('cleans up both quarantine and moved files when persistence fails', async () => {
    fileRepository.save.mockRejectedValue(new Error('database unavailable'));
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('database unavailable');
    await expect(fs.access(file.path)).rejects.toThrow();
    await expect(
      fs.readdir(path.join(uploadRoot, 'project-1')),
    ).resolves.toEqual([]);
  });

  it('rejects a request that would exceed the configured user storage quota', async () => {
    process.env.MAX_USER_STORAGE = '10';
    quotaQuery.getRawOne.mockResolvedValue({ total: '6' });
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );
    file.size = 5;

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(fs.access(file.path)).rejects.toThrow();
  });

  it('rejects a file path outside the request quarantine without touching it', async () => {
    const outsidePath = path.join(uploadRoot, 'outside.pdf');
    await fs.writeFile(outsidePath, '%PDF-1.7');
    const file = {
      ...(await writeQuarantineFile(
        uploadRoot,
        'notes.pdf',
        'application/pdf',
        '%PDF-1.7',
      )),
      path: outsidePath,
      destination: uploadRoot,
    };

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('%PDF-1.7');
  });

  it('removes verified quarantine siblings while leaving an outside path untouched', async () => {
    const quarantineFile = await writeQuarantineFile(
      uploadRoot,
      'inside.pdf',
      'application/pdf',
      '%PDF-1.7',
    );
    const outsidePath = path.join(uploadRoot, 'outside.pdf');
    await fs.writeFile(outsidePath, '%PDF-1.7');
    const outsideFile = {
      ...quarantineFile,
      originalname: 'outside.pdf',
      path: outsidePath,
      destination: uploadRoot,
    };

    await expect(
      service.uploadFiles('owner-1', 'project-1', [
        quarantineFile,
        outsideFile,
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(fs.access(quarantineFile.path)).rejects.toThrow();
    await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('%PDF-1.7');
  });

  it('still cleans files and reports both causes when transaction rollback fails', async () => {
    fileRepository.save.mockRejectedValue(new Error('database unavailable'));
    queryRunner.rollbackTransaction.mockRejectedValue(
      new Error('rollback unavailable'),
    );
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('Upload failed and transaction rollback failed');

    await expect(fs.access(file.path)).rejects.toThrow();
    await expect(
      fs.readdir(path.join(uploadRoot, 'project-1')),
    ).resolves.toEqual([]);
    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('destroys rather than pools the connection when connect fails after assigning a raw connection', async () => {
    queryRunner.connect.mockRejectedValue(new Error('connect unavailable'));
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('connect unavailable');

    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('destroys rather than pools the connection when starting the transaction fails', async () => {
    queryRunner.startTransaction.mockRejectedValue(
      new Error('start transaction unavailable'),
    );
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    await expect(
      service.uploadFiles('owner-1', 'project-1', [file]),
    ).rejects.toThrow('start transaction unavailable');

    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('destroys rather than pools the connection when releasing its named lock fails', async () => {
    queryRunner.query
      .mockReset()
      .mockResolvedValueOnce([{ acquired: 1 }])
      .mockRejectedValueOnce(new Error('release lock unavailable'));
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    const [saved] = await service.uploadFiles('owner-1', 'project-1', [file]);

    await expect(fs.access(saved.file_path)).resolves.toBeUndefined();
    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('destroys rather than pools the connection when MySQL cannot confirm lock release', async () => {
    queryRunner.query
      .mockReset()
      .mockResolvedValueOnce([{ acquired: 1 }])
      .mockResolvedValueOnce([{ released: 0 }]);
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    const [saved] = await service.uploadFiles('owner-1', 'project-1', [file]);

    await expect(fs.access(saved.file_path)).resolves.toBeUndefined();
    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('returns a normally unlocked connection to the pool without destroying it', async () => {
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    await service.uploadFiles('owner-1', 'project-1', [file]);

    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(queryRunner.databaseConnection.destroy).not.toHaveBeenCalled();
  });

  it('destroys the raw connection when returning it to the pool fails', async () => {
    queryRunner.release.mockRejectedValue(
      new Error('pool release unavailable'),
    );
    const file = await writeQuarantineFile(
      uploadRoot,
      'notes.pdf',
      'application/pdf',
      '%PDF-1.7',
    );

    const [saved] = await service.uploadFiles('owner-1', 'project-1', [file]);

    await expect(fs.access(saved.file_path)).resolves.toBeUndefined();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(queryRunner.databaseConnection.destroy).toHaveBeenCalledTimes(1);
  });
});

async function writeQuarantineFile(
  uploadRoot: string,
  originalname: string,
  mimetype: string,
  contents: string,
): Promise<Express.Multer.File> {
  const quarantineDir = path.join(uploadRoot, '.quarantine');
  await fs.mkdir(quarantineDir, { recursive: true });
  const tempPath = path.join(
    quarantineDir,
    `upload-${Date.now()}-${Math.random()}`,
  );
  const buffer = Buffer.from(contents);
  await fs.writeFile(tempPath, buffer);
  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype,
    size: buffer.byteLength,
    destination: quarantineDir,
    filename: path.basename(tempPath),
    path: tempPath,
    buffer,
    stream: undefined as never,
  };
}

async function writeQuarantineFileAt(
  quarantineDir: string,
  originalname: string,
  mimetype: string,
  contents: string,
): Promise<Express.Multer.File> {
  await fs.mkdir(quarantineDir, { recursive: true });
  const tempPath = path.join(
    quarantineDir,
    `upload-${Date.now()}-${Math.random()}`,
  );
  const buffer = Buffer.from(contents);
  await fs.writeFile(tempPath, buffer);
  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype,
    size: buffer.byteLength,
    destination: quarantineDir,
    filename: path.basename(tempPath),
    path: tempPath,
    buffer,
    stream: undefined as never,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type MockCallRecorder = {
  mock: {
    calls: unknown[][];
  };
};

function mockCallArgument<T>(
  mock: MockCallRecorder,
  callIndex: number,
  argumentIndex: number,
): T {
  return mock.mock.calls[callIndex]?.[argumentIndex] as T;
}

function lastMockCallArgument<T>(
  mock: MockCallRecorder,
  argumentIndex: number,
): T {
  return mock.mock.calls.at(-1)?.[argumentIndex] as T;
}
