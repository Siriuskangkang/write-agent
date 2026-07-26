/* eslint-disable @typescript-eslint/no-unsafe-assignment */
jest.mock('./parsers/pdf.parser.js', () => ({
  parsePdf: jest.fn().mockResolvedValue({
    title: 'Source material',
    content_text: 'Parsed text',
    page_count: 1,
    sections: [],
    parser_version: 'pdf-ast-1',
    ast: {
      version: 'document-ast-v1',
      location: { kind: 'page', status: 'exact' },
      blocks: [],
    },
  }),
}));
jest.mock('./parsers/docx.parser.js', () => ({ parseDocx: jest.fn() }));
jest.mock('./parsers/pptx.parser.js', () => ({ parsePptx: jest.fn() }));
jest.mock('./parsers/markdown.parser.js', () => ({ parseMarkdown: jest.fn() }));
jest.mock('./parsers/txt.parser.js', () => ({ parseTxt: jest.fn() }));
jest.mock('./verified-file-snapshot.js', () => ({
  readVerifiedFileSnapshot: jest.fn().mockResolvedValue({
    bytes: Buffer.from('verified PDF'),
    checksum: 'a'.repeat(64),
    size: 12,
  }),
}));

import { FileType, ParseStatus } from '../common/enums.js';
import { ParseWorker } from './parse.worker.js';
import { readVerifiedFileSnapshot } from './verified-file-snapshot.js';

describe('ParseWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STORAGE_AUTHORITY_MODE;
    delete process.env.STORAGE_PROTECTED_ROOT;
    delete process.env.STORAGE_QUARANTINE_ROOT;
    jest.mocked(readVerifiedFileSnapshot).mockResolvedValue({
      bytes: Buffer.from('verified PDF'),
      checksum: 'a'.repeat(64),
      size: 12,
    });
  });

  afterEach(() => {
    delete process.env.STORAGE_AUTHORITY_MODE;
    delete process.env.STORAGE_PROTECTED_ROOT;
    delete process.env.STORAGE_QUARANTINE_ROOT;
  });

  it('fails closed in broker mode until the exact generation is AVAILABLE', async () => {
    process.env.STORAGE_AUTHORITY_MODE = 'broker';
    process.env.STORAGE_PROTECTED_ROOT = '/srv/storage/protected';
    process.env.STORAGE_QUARANTINE_ROOT = '/srv/storage/quarantine';
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        project_id: '11111111-1111-4111-8111-111111111111',
        file_type: FileType.PDF,
        file_path:
          '/srv/storage/protected/p/11111111-1111-4111-8111-111111111111/f/22222222-2222-4222-8222-222222222222/g/1/' +
          `${'a'.repeat(64)}.blob`,
        file_size: 12,
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
        parse_status: ParseStatus.PENDING,
        deleted_at: null,
      }),
      update: jest.fn(),
    };
    const storageObjectRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    };
    const ingestionService = { activate: jest.fn() };
    const readiness = {
      assertReady: jest.fn().mockResolvedValue({
        storage_epoch: '33333333-3333-4333-8333-333333333333',
        storage_contract_version: 'storage-broker.v1',
      }),
    };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
      storageObjectRepo as never,
      readiness as never,
    );

    await expect(
      worker.handleParse({
        data: {
          fileId: '22222222-2222-4222-8222-222222222222',
          projectId: '11111111-1111-4111-8111-111111111111',
          parseGeneration: 1,
        },
      } as never),
    ).rejects.toThrow('STORAGE_OBJECT_NOT_AVAILABLE');
    expect(fileRepo.update).not.toHaveBeenCalled();
    expect(readVerifiedFileSnapshot).not.toHaveBeenCalled();
    expect(ingestionService.activate).not.toHaveBeenCalled();
  });

  it('consumes a parse job and marks the source file complete', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
        parse_status: ParseStatus.PENDING,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ingestionService = {
      activate: jest.fn().mockResolvedValue({ id: 'document-1' }),
    };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await worker.handleParse({
      data: {
        fileId: 'file-1',
        projectId: 'project-1',
        parseGeneration: 1,
      },
    } as never);

    expect(ingestionService.activate).toHaveBeenCalledWith({
      file_id: 'file-1',
      project_id: 'project-1',
      source_checksum: 'a'.repeat(64),
      parse_generation: 1,
      attempt_token: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      result: expect.objectContaining({
        parser_version: 'pdf-ast-1',
      }),
    });
    expect(fileRepo.update).toHaveBeenCalledTimes(1);
    expect(fileRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 1,
      }),
      expect.objectContaining({
        parse_status: ParseStatus.PARSING,
        error_message: null,
        parse_attempt_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        parse_lease_expires_at: expect.any(Function),
      }),
    );
    expect(readVerifiedFileSnapshot).toHaveBeenCalledWith(
      '/app/uploads/file-1.pdf',
      expect.objectContaining({
        expected_checksum: 'a'.repeat(64),
      }),
    );
  });

  it('rejects a stale queue payload for a different project before parsing', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
        parse_status: ParseStatus.PENDING,
      }),
      update: jest.fn(),
    };
    const ingestionService = { activate: jest.fn() };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await worker.handleParse({
      data: {
        fileId: 'file-1',
        projectId: 'foreign-project',
        parseGeneration: 1,
      },
    } as never);

    expect(ingestionService.activate).not.toHaveBeenCalled();
    expect(fileRepo.update).not.toHaveBeenCalled();
  });

  it('marks a failed attempt and rethrows so Bull can retry it', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
        parse_status: ParseStatus.PENDING,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ingestionService = {
      activate: jest.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await expect(
      worker.handleParse({
        data: {
          fileId: 'file-1',
          projectId: 'project-1',
          parseGeneration: 1,
        },
      } as never),
    ).rejects.toThrow('database unavailable');
    expect(fileRepo.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 1,
        parse_status: ParseStatus.PARSING,
        parse_attempt_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
      expect.objectContaining({
        parse_status: ParseStatus.FAILED,
        error_message: 'database unavailable',
        parse_attempt_token: null,
        parse_lease_expires_at: null,
      }),
    );
  });

  it('ignores a stale parse generation before reading or parsing bytes', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 2,
        parse_status: ParseStatus.PENDING,
      }),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const ingestionService = { activate: jest.fn() };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await worker.handleParse({
      data: {
        fileId: 'file-1',
        projectId: 'project-1',
        parseGeneration: 1,
      },
    } as never);

    expect(readVerifiedFileSnapshot).not.toHaveBeenCalled();
    expect(ingestionService.activate).not.toHaveBeenCalled();
  });

  it('treats a late duplicate delivery for a completed generation as a no-op', async () => {
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
        parse_status: ParseStatus.DONE,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ingestionService = { activate: jest.fn() };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await expect(
      worker.handleParse({
        data: {
          fileId: 'file-1',
          projectId: 'project-1',
          parseGeneration: 1,
        },
      } as never),
    ).resolves.toBeUndefined();

    expect(fileRepo.update).not.toHaveBeenCalled();
    expect(readVerifiedFileSnapshot).not.toHaveBeenCalled();
    expect(ingestionService.activate).not.toHaveBeenCalled();
  });

  it('fails closed on checksum mismatch without ingesting parsed content', async () => {
    jest
      .mocked(readVerifiedFileSnapshot)
      .mockRejectedValueOnce(
        new Error('Source file checksum changed after upload'),
      );
    const fileRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'file-1',
        project_id: 'project-1',
        file_type: FileType.PDF,
        file_path: '/app/uploads/file-1.pdf',
        checksum_sha256: 'a'.repeat(64),
        parse_generation: 1,
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ingestionService = { activate: jest.fn() };
    const worker = new ParseWorker(
      fileRepo as never,
      ingestionService as never,
    );

    await expect(
      worker.handleParse({
        data: {
          fileId: 'file-1',
          projectId: 'project-1',
          parseGeneration: 1,
        },
      } as never),
    ).rejects.toThrow('Source file checksum changed after upload');
    expect(ingestionService.activate).not.toHaveBeenCalled();
  });
});
