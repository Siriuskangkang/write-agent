import type { DocumentAst } from '../file/parsers/document-ast.js';
import { ChunkService } from './chunk.service.js';

describe('ChunkService structured identities', () => {
  it('scopes deterministic row ids to the document while keeping stable keys reproducible', async () => {
    const savedBatches: Array<Array<Record<string, unknown>>> = [];
    const repository = {
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((values: Array<Record<string, unknown>>) => {
        savedBatches.push(values);
        return Promise.resolve(values);
      }),
    };
    const service = new ChunkService(repository as never, {} as never);
    const ast: DocumentAst = {
      version: 'document-ast-v1',
      location: {
        kind: 'none',
        status: 'unavailable',
        reason: 'fixture',
      },
      blocks: [
        {
          block_id: 'a'.repeat(64),
          type: 'heading',
          text: '第一章',
          heading_path: ['第一章'],
          page_start: null,
          page_end: null,
          offsets: {
            start: 0,
            end: 3,
            unit: 'utf16_code_unit',
            source: 'content_text',
          },
          metadata: {},
        },
        {
          block_id: 'b'.repeat(64),
          type: 'paragraph',
          text: '相同内容',
          heading_path: ['第一章'],
          page_start: null,
          page_end: null,
          offsets: {
            start: 5,
            end: 9,
            unit: 'utf16_code_unit',
            source: 'content_text',
          },
          metadata: {},
        },
      ],
    };
    const input = {
      content_text: '第一章\n\n相同内容',
      sections: [],
      ast,
      ingestion_key: 'c'.repeat(64),
    };

    const first = await service.createChunksForDocument(
      'project-1',
      'file-1',
      'document-1',
      input,
    );
    const second = await service.createChunksForDocument(
      'project-1',
      'file-2',
      'document-2',
      input,
    );

    expect(first.map((chunk) => chunk.stable_key)).toEqual(
      second.map((chunk) => chunk.stable_key),
    );
    expect(first.map((chunk) => chunk.id)).not.toEqual(
      second.map((chunk) => chunk.id),
    );
    expect(new Set(first.map((chunk) => chunk.id)).size).toBe(2);
    expect(first[1]?.parent_id).toBe(first[0]?.id);
    expect(second[1]?.parent_id).toBe(second[0]?.id);
    expect(
      savedBatches
        .flat()
        .some(
          (chunk) =>
            typeof chunk.search_text === 'string' &&
            chunk.search_text.includes('第一章'),
        ),
    ).toBe(true);
    expect(savedBatches).toHaveLength(4);
  });
});
