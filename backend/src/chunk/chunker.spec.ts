import { chunkDocument } from './chunker.js';
import type { DocumentAst } from '../file/parsers/document-ast.js';

describe('chunkDocument', () => {
  it('creates token-aware heading parents and bounded children without crossing sections', () => {
    const ast: DocumentAst = {
      version: 'document-ast-v1',
      location: { kind: 'page', status: 'exact' },
      blocks: [
        astBlock('h1', 'heading', '第一章', ['第一章'], 0, 3, 1),
        astBlock(
          'p1',
          'paragraph',
          '数据采集是教材第一章的核心内容。'.repeat(120),
          ['第一章'],
          5,
          2005,
          1,
        ),
        astBlock('h2', 'heading', '第二章', ['第二章'], 2007, 2010, 2),
        astBlock(
          'p2',
          'paragraph',
          '模型训练属于第二章，不能与第一章混合。'.repeat(80),
          ['第二章'],
          2012,
          3212,
          2,
        ),
      ],
    };

    const chunks = chunkDocument({
      content_text: ast.blocks.map((block) => block.text).join('\n\n'),
      sections: [],
      ast,
      ingestion_key: 'a'.repeat(64),
    });
    const parents = chunks.filter((chunk) => chunk.chunk_type === 'parent');
    const children = chunks.filter((chunk) => chunk.chunk_type === 'child');

    expect(parents).toHaveLength(2);
    expect(children.length).toBeGreaterThan(2);
    expect(children.every((chunk) => chunk.token_count <= 512)).toBe(true);
    expect(children.every((chunk) => chunk.parent_key)).toBe(true);
    expect(
      children.every(
        (chunk) =>
          !(
            chunk.heading_path.includes('第一章') &&
            chunk.heading_path.includes('第二章')
          ),
      ),
    ).toBe(true);
    expect(new Set(children.map((chunk) => chunk.tokenizer_version))).toEqual(
      new Set(['stable-mixed-script-v1']),
    );
    expect(children[1]?.overlap_previous_tokens).toBeGreaterThan(0);
  });

  it('adds overlap when splitting long section content', () => {
    const repeated = '这是一个用于测试切块重叠能力的长段落内容。'.repeat(80);

    const chunks = chunkDocument({
      content_text: repeated,
      sections: [{ title: '第一章', content: repeated }],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].content.length).toBeGreaterThan(0);

    const overlapSeed = chunks[0].content.slice(-120).trim();
    expect(chunks[1].content.startsWith(overlapSeed.slice(0, 40))).toBe(true);
  });

  it('splits plain text fallback with bounded chunk sizes', () => {
    const text = 'abcdefg'.repeat(300);

    const chunks = chunkDocument({
      content_text: text,
      sections: [],
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 800)).toBe(true);
  });
});

function astBlock(
  blockId: string,
  type: DocumentAst['blocks'][number]['type'],
  text: string,
  headingPath: string[],
  start: number,
  end: number,
  page: number,
): DocumentAst['blocks'][number] {
  return {
    block_id: blockId,
    type,
    text,
    heading_path: headingPath,
    page_start: page,
    page_end: page,
    offsets: {
      start,
      end,
      unit: 'utf16_code_unit',
      source: 'content_text',
    },
    metadata: {},
  };
}
