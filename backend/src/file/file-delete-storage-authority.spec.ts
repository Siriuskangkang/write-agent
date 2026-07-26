import { FileService } from './file.service.js';
import { StorageObject } from '../storage/entities/storage-object.entity.js';
import { FileType, ParseStatus } from '../common/enums.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const EPOCH = '55555555-5555-4555-8555-555555555555';
const SHA256 = 'a'.repeat(64);
const STORAGE_KEY = `p/${PROJECT_ID}/f/${FILE_ID}/g/1/${SHA256}.blob`;

describe('broker source-file deletion', () => {
  let sourceRepo: {
    findOne: jest.Mock;
    update: jest.Mock;
    manager: {
      connection: {
        createQueryRunner: jest.Mock;
      };
    };
  };
  let storageObjectRepo: { findOne: jest.Mock };
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    isReleased: boolean;
    manager: {
      getRepository: jest.Mock;
      update: jest.Mock;
    };
  };
  let storageRequests: { request: jest.Mock };
  let service: FileService;

  beforeEach(() => {
    process.env.STORAGE_AUTHORITY_MODE = 'broker';
    process.env.STORAGE_PROTECTED_ROOT = '/srv/storage/protected';
    process.env.STORAGE_QUARANTINE_ROOT = '/srv/storage/quarantine';
    sourceRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: FILE_ID,
        project_id: PROJECT_ID,
        file_type: FileType.PDF,
        file_path: `/srv/storage/protected/${STORAGE_KEY}`,
        file_size: 42,
        checksum_sha256: SHA256,
        parse_generation: 1,
        parse_status: ParseStatus.DONE,
        deleted_at: null,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        connection: {
          createQueryRunner: jest.fn(),
        },
      },
    };
    storageObjectRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: OBJECT_ID,
        project_id: PROJECT_ID,
        source_file_id: FILE_ID,
        generation: '1',
        storage_key: STORAGE_KEY,
        checksum_sha256: SHA256,
        byte_size: '42',
        state: 'AVAILABLE',
      }),
    };
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      isReleased: false,
      manager: {
        getRepository: jest.fn((entity) =>
          entity === StorageObject ? storageObjectRepo : sourceRepo,
        ),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      },
    };
    sourceRepo.manager.connection.createQueryRunner.mockReturnValue(
      queryRunner,
    );
    storageRequests = {
      request: jest.fn().mockResolvedValue({
        intent_id: '66666666-6666-4666-8666-666666666666',
        status: 'PENDING',
        execution_fence_decimal: '0',
        result_code: null,
      }),
    };
    service = new FileService(
      sourceRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ id: PROJECT_ID }) } as never,
      {} as never,
      {
        assertReady: jest.fn().mockResolvedValue({
          storage_epoch: EPOCH,
          storage_contract_version: 'storage-broker.v1',
        }),
      } as never,
      storageRequests as never,
    );
  });

  afterEach(() => {
    delete process.env.STORAGE_AUTHORITY_MODE;
    delete process.env.STORAGE_PROTECTED_ROOT;
    delete process.env.STORAGE_QUARANTINE_ROOT;
  });

  it('commits tombstone and DELETE_BLOB intent in one caller transaction', async () => {
    await service.deleteFile(USER_ID, PROJECT_ID, FILE_ID);

    expect(storageRequests.request).toHaveBeenCalledWith(
      queryRunner,
      expect.objectContaining({
        kind: 'DELETE_BLOB',
        actor_id: USER_ID,
        project_id: PROJECT_ID,
        source_file_id: FILE_ID,
        object_id: OBJECT_ID,
      }),
    );
    expect(storageRequests.request.mock.invocationCallOrder[0]).toBeLessThan(
      queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('rolls back the tombstone when DELETE_BLOB intent creation fails', async () => {
    storageRequests.request.mockRejectedValueOnce(
      new Error('STORAGE_DELETE_REJECTED'),
    );

    await expect(
      service.deleteFile(USER_ID, PROJECT_ID, FILE_ID),
    ).rejects.toThrow('STORAGE_DELETE_REJECTED');

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(sourceRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: FILE_ID, project_id: PROJECT_ID }),
      expect.objectContaining({ deleted_by: USER_ID }),
    );
  });
});
