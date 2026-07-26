/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/require-await */
import { CHUNK_VERSION } from '../chunk/chunker.js';
import type { ParseResult } from './parsers/document-ast.js';
import { StructuredIngestionService } from './structured-ingestion.service.js';

const checksum = 'a'.repeat(64);
const parseResult: ParseResult = {
  title: '教材',
  content_text: '第一章\n\n正文',
  page_count: null,
  sections: [{ title: '第一章', content: '正文' }],
  parser_version: 'markdown-ast-1',
  ast: {
    version: 'document-ast-v1',
    location: {
      kind: 'none',
      status: 'unavailable',
      reason: 'markdown_has_no_pagination',
    },
    blocks: [
      {
        block_id: 'b'.repeat(64),
        type: 'paragraph',
        text: '正文',
        heading_path: ['第一章'],
        page_start: null,
        page_end: null,
        offsets: {
          start: 5,
          end: 7,
          unit: 'utf16_code_unit',
          source: 'content_text',
        },
        metadata: {},
      },
    ],
  },
};

describe('StructuredIngestionService', () => {
  it('locks the source and atomically creates one active version with chunks', async () => {
    const manager = createManager();
    manager.findOne
      .mockResolvedValueOnce({
        id: 'file-1',
        project_id: 'project-1',
        checksum_sha256: checksum,
        parse_generation: 1,
        parse_status: 'parsing',
        parse_attempt_token: 'attempt-1',
        parse_lease_expires_at: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce(null);
    manager.create.mockImplementation((_entity, value) => value);
    manager.save.mockImplementation(async (_entity, value) => ({
      id: 'document-1',
      ...value,
    }));
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    };
    const chunkService = {
      createChunksForDocument: jest.fn().mockResolvedValue([]),
    };
    const service = new StructuredIngestionService(
      dataSource as never,
      chunkService as never,
      createIndexRecorder() as never,
    );

    const document = await service.activate({
      file_id: 'file-1',
      project_id: 'project-1',
      source_checksum: checksum,
      parse_generation: 1,
      attempt_token: 'attempt-1',
      result: parseResult,
    });

    expect(manager.findOne).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      expect.objectContaining({
        where: { id: 'file-1', project_id: 'project-1' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(document).toEqual(
      expect.objectContaining({
        id: 'document-1',
        source_checksum: checksum,
        parser_version: 'markdown-ast-1',
        chunk_version: CHUNK_VERSION,
        is_active: true,
      }),
    );
    expect(chunkService.createChunksForDocument).toHaveBeenCalledWith(
      'project-1',
      'file-1',
      'document-1',
      expect.objectContaining({
        ast: parseResult.ast,
        ingestion_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      manager,
    );
    expect(manager.update).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        id: 'file-1',
        project_id: 'project-1',
        parse_generation: 1,
        parse_attempt_token: 'attempt-1',
      }),
      expect.objectContaining({
        parse_status: 'done',
        active_ingestion_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it('reuses the committed version on duplicate Bull consumption', async () => {
    const existing = {
      id: 'document-1',
      file_id: 'file-1',
      project_id: 'project-1',
      ingestion_key: 'existing-key',
      is_active: true,
    };
    const manager = createManager();
    manager.findOne
      .mockResolvedValueOnce({
        id: 'file-1',
        project_id: 'project-1',
        checksum_sha256: checksum,
        parse_generation: 1,
        parse_status: 'parsing',
        parse_attempt_token: 'attempt-1',
        parse_lease_expires_at: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce(existing);
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    };
    const chunkService = {
      createChunksForDocument: jest.fn(),
    };
    const service = new StructuredIngestionService(
      dataSource as never,
      chunkService as never,
      createIndexRecorder() as never,
    );

    const result = await service.activate({
      file_id: 'file-1',
      project_id: 'project-1',
      source_checksum: checksum,
      parse_generation: 1,
      attempt_token: 'attempt-1',
      result: parseResult,
    });

    expect(result).toBe(existing);
    expect(manager.save).not.toHaveBeenCalled();
    expect(chunkService.createChunksForDocument).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({ parse_status: 'done' }),
    );
  });

  it('rejects a stale job whose project does not match the locked source', async () => {
    const manager = createManager();
    manager.findOne.mockResolvedValueOnce(null);
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    };
    const service = new StructuredIngestionService(
      dataSource as never,
      { createChunksForDocument: jest.fn() } as never,
      createIndexRecorder() as never,
    );

    await expect(
      service.activate({
        file_id: 'file-1',
        project_id: 'other-project',
        source_checksum: checksum,
        parse_generation: 1,
        attempt_token: 'attempt-1',
        result: parseResult,
      }),
    ).rejects.toThrow('Source file does not belong to the parse job');
  });

  it('rejects an old attempt token before changing documents or chunks', async () => {
    const manager = createManager();
    manager.findOne.mockResolvedValueOnce({
      id: 'file-1',
      project_id: 'project-1',
      checksum_sha256: checksum,
      parse_generation: 1,
      parse_status: 'parsing',
      parse_attempt_token: 'current-attempt',
      parse_lease_expires_at: new Date(Date.now() + 60_000),
    });
    const dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
    };
    const chunkService = {
      createChunksForDocument: jest.fn(),
    };
    const service = new StructuredIngestionService(
      dataSource as never,
      chunkService as never,
      createIndexRecorder() as never,
    );

    await expect(
      service.activate({
        file_id: 'file-1',
        project_id: 'project-1',
        source_checksum: checksum,
        parse_generation: 1,
        attempt_token: 'stale-attempt',
        result: parseResult,
      } as never),
    ).rejects.toThrow('Stale parse attempt');

    expect(manager.save).not.toHaveBeenCalled();
    expect(chunkService.createChunksForDocument).not.toHaveBeenCalled();
  });
});

function createManager() {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([{ leaseActive: 1 }]),
  };
}

function createIndexRecorder() {
  return {
    stage: jest.fn().mockResolvedValue(undefined),
  };
}
