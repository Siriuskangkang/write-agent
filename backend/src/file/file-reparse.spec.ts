import { FileService } from './file.service.js';

describe('FileService.reparse version retention', () => {
  it('queues ingestion without deleting the current or historical versions', async () => {
    const lockedFile = {
      id: 'file-1',
      project_id: 'project-1',
      file_path: '/tmp/material.md',
      parse_generation: 3,
    };
    const transactionalFileRepo = {
      findOne: jest.fn().mockResolvedValue(lockedFile),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const transactionalOutboxRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'outbox-1',
        file_id: 'file-1',
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const manager = {
      getRepository: jest.fn((entity: { name: string }) =>
        entity.name === 'SourceFile'
          ? transactionalFileRepo
          : transactionalOutboxRepo,
      ),
    };
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_path: '/tmp/material.md',
      }),
      manager: {
        transaction: jest.fn(
          (work: (transactionManager: typeof manager) => unknown) =>
            Promise.resolve(work(manager)),
        ),
      },
    };
    const docRepo = { delete: jest.fn() };
    const citationRepo = { delete: jest.fn() };
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const chunkService = { deleteByFileId: jest.fn() };
    const projectService = {
      findOne: jest.fn().mockResolvedValue({ id: 'project-1' }),
    };
    const service = new FileService(
      fileRepo as never,
      docRepo as never,
      citationRepo as never,
      queue as never,
      {} as never,
      {} as never,
      {} as never,
      chunkService as never,
      projectService as never,
      { dispatchPending: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.reparse('user-1', 'project-1', 'file-1');

    expect(citationRepo.delete).not.toHaveBeenCalled();
    expect(chunkService.deleteByFileId).not.toHaveBeenCalled();
    expect(docRepo.delete).not.toHaveBeenCalled();
    expect(transactionalFileRepo.update).toHaveBeenCalledWith(
      {
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 3,
      },
      {
        parse_generation: 4,
        parse_status: 'pending',
        error_message: null,
        parse_attempt_token: null,
        parse_lease_expires_at: null,
      },
    );
    expect(transactionalOutboxRepo.update).toHaveBeenCalledWith(
      { id: 'outbox-1' },
      expect.objectContaining({
        file_id: 'file-1',
        project_id: 'project-1',
        parse_generation: 4,
        job_id: 'file-reparse:file-1:4',
        status: 'pending',
      }),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('increments generation only while holding a pessimistic source lock', async () => {
    const transactionalFileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 8,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const outboxRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue({ identifiers: [] }),
    };
    const manager = {
      getRepository: jest.fn((entity: { name: string }) =>
        entity.name === 'SourceFile' ? transactionalFileRepo : outboxRepo,
      ),
    };
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
      }),
      manager: {
        transaction: jest.fn(
          (work: (transactionManager: typeof manager) => unknown) =>
            Promise.resolve(work(manager)),
        ),
      },
    };
    const service = new FileService(
      fileRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ id: 'project-1' }) } as never,
      { dispatchPending: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await service.reparse('user-1', 'project-1', 'file-1');

    expect(transactionalFileRepo.findOne).toHaveBeenCalledWith({
      where: { id: 'file-1', project_id: 'project-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(transactionalFileRepo.update).toHaveBeenCalledWith(
      {
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 8,
      },
      {
        parse_generation: 9,
        parse_status: 'pending',
        error_message: null,
        parse_attempt_token: null,
        parse_lease_expires_at: null,
      },
    );
    expect(outboxRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'file-1',
        project_id: 'project-1',
        parse_generation: 9,
        job_id: 'file-reparse:file-1:9',
        status: 'pending',
      }),
    );
  });

  it('returns only the active parse result after versions accumulate', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
      }),
    };
    const docRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'document-current' }),
    };
    const service = new FileService(
      fileRepo as never,
      docRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ id: 'project-1' }) } as never,
      {} as never,
    );

    await service.getParseResult('user-1', 'project-1', 'file-1');

    expect(docRepo.findOne).toHaveBeenCalledWith({
      where: {
        file_id: 'file-1',
        project_id: 'project-1',
        is_active: true,
      },
    });
  });
});
