import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { parseDocx } from './docx.parser.js';
import { parseMarkdown } from './markdown.parser.js';
import { parsePptx } from './pptx.parser.js';
import { parseTxt } from './txt.parser.js';
import { parsePdf } from './pdf.parser.js';
import {
  assertUniqueOoxmlEntryNames,
  getActiveOoxmlWorkerCountForTests,
} from './ooxml-worker-client.js';
import {
  assertDocumentAst,
  finalizeDocumentAst,
  ParserBudgetGuard,
  type ParserBudget,
} from './document-ast.js';

const CHECKSUM = createHash('sha256')
  .update('structured-parser-fixture')
  .digest('hex');

describe('versioned document AST parsers', () => {
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-agent-ast-'));
  });

  afterEach(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it('preserves Markdown heading paths, lists, tables, code and stable offsets', async () => {
    const fixture = path.join(fixtureDir, 'material.md');
    await fs.writeFile(
      fixture,
      [
        '# 数据工程',
        '',
        '导言段落。',
        '',
        '## 数据采集',
        '',
        '- 批处理',
        '- 流处理',
        '',
        '| 类型 | 延迟 |',
        '| --- | --- |',
        '| 批处理 | 高 |',
        '',
        '```ts',
        'const mode = "stream";',
        '```',
      ].join('\n'),
    );

    const first = await parseMarkdown(fixture, {
      source_checksum: CHECKSUM,
    });
    const second = await parseMarkdown(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(first.parser_version).toMatch(/^markdown-ast-/);
    expect(first.ast.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'list_item',
      'list_item',
      'table',
      'code',
    ]);
    expect(first.ast.blocks[3]?.heading_path).toEqual(['数据工程', '数据采集']);
    expect(first.ast.blocks[5]?.metadata).toEqual(
      expect.objectContaining({ rows: 2, columns: 2 }),
    );
    expect(first.ast.blocks.map((block) => block.block_id)).toEqual(
      second.ast.blocks.map((block) => block.block_id),
    );
    for (const block of first.ast.blocks) {
      expect(block.offsets).toEqual(
        expect.objectContaining({
          unit: 'utf16_code_unit',
          source: 'content_text',
        }),
      );
      expect(
        first.content_text.slice(block.offsets.start, block.offsets.end),
      ).toBe(block.text);
    }
  });

  it('marks TXT and DOCX pagination as unavailable instead of inventing pages', async () => {
    const txtFixture = path.join(fixtureDir, 'material.txt');
    await fs.writeFile(
      txtFixture,
      '第一章\n\n这是正文。\n\n- 要点一\n- 要点二',
    );

    const docxFixture = path.join(fixtureDir, 'material.docx');
    createDocxFixture(docxFixture);

    const txt = await parseTxt(txtFixture, { source_checksum: CHECKSUM });
    const docx = await parseDocx(docxFixture, {
      source_checksum: CHECKSUM,
    });

    expect(txt.page_count).toBeNull();
    expect(txt.ast.location).toEqual({
      kind: 'none',
      status: 'unavailable',
      reason: 'plain_text_has_no_pagination',
    });
    expect(txt.ast.blocks.some((block) => block.type === 'list_item')).toBe(
      true,
    );
    expect(docx.page_count).toBeNull();
    expect(docx.ast.location).toEqual({
      kind: 'page',
      status: 'degraded',
      reason: 'docx_does_not_expose_rendered_page_boundaries',
    });
    expect(docx.ast.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'list_item',
      'table',
    ]);
    expect(docx.ast.blocks[1]?.heading_path).toEqual(['结构化教材']);
    expect(
      docx.ast.blocks.every(
        (block) => block.page_start === null && block.page_end === null,
      ),
    ).toBe(true);
  });

  it('records exact PPTX slides without presenting them as inferred pages', async () => {
    const pptxFixture = path.join(fixtureDir, 'material.pptx');
    createPptxFixture(pptxFixture);

    const pptx = await parsePptx(pptxFixture, {
      source_checksum: CHECKSUM,
    });

    expect(pptx.page_count).toBe(2);
    expect(pptx.ast.location).toEqual({ kind: 'slide', status: 'exact' });
    expect(pptx.ast.blocks[0]).toEqual(
      expect.objectContaining({
        type: 'heading',
        text: '第一讲',
        page_start: 1,
        page_end: 1,
      }),
    );
    expect(pptx.ast.blocks.some((block) => block.type === 'table')).toBe(true);
    expect(
      pptx.ast.blocks
        .filter((block) => block.page_start === 2)
        .every((block) => block.page_end === 2),
    ).toBe(true);
  });

  it('rejects an OOXML archive with an oversized uncompressed entry', async () => {
    const fixture = path.join(fixtureDir, 'oversized.docx');
    const zip = new AdmZip();
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
    zip.addFile(
      'word/media/oversized.bin',
      Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
    );
    zip.writeZip(fixture);

    await expect(
      parseDocx(fixture, { source_checksum: CHECKSUM }),
    ).rejects.toThrow('OOXML archive entry exceeds its size limit');
  });

  it('keeps heading paths compact when a document starts at H2 or skips levels', async () => {
    const fixture = path.join(fixtureDir, 'sparse-headings.md');
    await fs.writeFile(
      fixture,
      ['## 第一节', '正文', '# 第一章', '### 深入主题', '更多正文'].join(
        '\n\n',
      ),
    );

    const result = await parseMarkdown(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.blocks[0]?.heading_path).toEqual(['第一节']);
    expect(
      result.ast.blocks.find((block) => block.text === '深入主题')
        ?.heading_path,
    ).toEqual(['第一章', '深入主题']);
    expect(
      result.ast.blocks.every((block) =>
        block.heading_path.every((part) => typeof part === 'string'),
      ),
    ).toBe(true);
  });

  it('parses DOCX local names independently of XML namespace prefixes and styles', async () => {
    const fixture = path.join(fixtureDir, 'alternate-prefix.docx');
    createAlternatePrefixDocxFixture(fixture);

    const result = await parseDocx(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.blocks.map((block) => block.type)).toEqual([
      'heading',
      'list_item',
    ]);
    expect(result.ast.blocks[0]).toEqual(
      expect.objectContaining({
        text: '替代前缀标题',
        heading_path: ['替代前缀标题'],
      }),
    );
    expect(result.ast.blocks[1]?.metadata).toEqual(
      expect.objectContaining({
        numbering_id: '7',
        numbering_level: 0,
        list_format: 'bullet',
      }),
    );
  });

  it('uses presentation relationships for slide order and placeholder titles', async () => {
    const fixture = path.join(fixtureDir, 'relationship-order.pptx');
    createRelationshipOrderedPptxFixture(fixture);

    const result = await parsePptx(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.location).toEqual({ kind: 'slide', status: 'exact' });
    expect(result.title).toBe('逻辑第一页');
    expect(result.ast.blocks[0]).toEqual(
      expect.objectContaining({
        type: 'heading',
        text: '逻辑第一页',
        page_start: 1,
      }),
    );
    expect(
      result.ast.blocks.find((block) => block.text === '逻辑第二页')
        ?.page_start,
    ).toBe(2);
  });

  it('ignores external and escaping PPTX slide relationships without parsing shadow parts', async () => {
    const fixture = path.join(fixtureDir, 'external-relationship.pptx');
    createUntrustedRelationshipPptxFixture(fixture);

    const result = await parsePptx(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.location).toEqual({
      kind: 'slide',
      status: 'degraded',
      reason: 'pptx_external_slide_relationship',
    });
    expect(result.content_text).not.toContain('不可信影子页');
    expect(result.content_text).not.toContain('逃逸页');
  });

  it('rejects PPTX relationship targets that become unsafe after percent decoding', async () => {
    const fixture = path.join(fixtureDir, 'encoded-relationship.pptx');
    createEncodedRelationshipPptxFixture(fixture);

    const result = await parsePptx(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.location).toEqual({
      kind: 'slide',
      status: 'degraded',
      reason: 'pptx_invalid_slide_relationship_target',
    });
    expect(result.content_text).toBe('');
    expect(result.content_text).not.toContain('编码查询影子页');
  });

  it('preserves explicit xml:space block-boundary whitespace in OOXML text', async () => {
    const fixture = path.join(fixtureDir, 'preserved-space.docx');
    createPreservedSpaceDocxFixture(fixture);

    const result = await parseDocx(fixture, {
      source_checksum: CHECKSUM,
    });

    expect(result.ast.blocks).toHaveLength(1);
    expect(result.ast.blocks[0]?.text).toBe('  E  ');
    expect(result.ast.blocks[0]?.metadata).toEqual(
      expect.objectContaining({ xml_space_preserve: true }),
    );
    expect(result.content_text).toBe('  E  ');
  });

  it('inherits the nearest xml:space value from OOXML ancestors into extracted blocks', async () => {
    const docxFixture = path.join(fixtureDir, 'inherited-space.docx');
    createInheritedSpaceDocxFixture(docxFixture);
    const docx = await parseDocx(docxFixture, {
      source_checksum: CHECKSUM,
    });

    expect(docx.ast.blocks[0]).toEqual(
      expect.objectContaining({
        text: '  inherited  ',
      }),
    );
    expect(docx.ast.blocks[0]?.metadata).toMatchObject({
      xml_space_preserve: true,
    });
    expect(docx.ast.blocks[1]).toEqual(
      expect.objectContaining({
        text: 'reset',
        metadata: {},
      }),
    );
    expect(docx.ast.blocks[2]).toEqual(
      expect.objectContaining({
        text: '  nearest wins  ',
      }),
    );
    expect(docx.ast.blocks[2]?.metadata).toMatchObject({
      xml_space_preserve: true,
    });

    const pptxFixture = path.join(fixtureDir, 'inherited-space.pptx');
    createInheritedSpacePptxFixture(pptxFixture);
    const pptx = await parsePptx(pptxFixture, {
      source_checksum: CHECKSUM,
    });

    expect(pptx.ast.blocks[0]).toEqual(
      expect.objectContaining({
        text: '  inherited title  ',
      }),
    );
    expect(pptx.ast.blocks[0]?.metadata).toMatchObject({
      xml_space_preserve: true,
    });
    expect(pptx.ast.blocks[1]).toEqual(
      expect.objectContaining({
        text: 'reset body',
      }),
    );
    expect(pptx.ast.blocks[1]?.metadata).not.toHaveProperty(
      'xml_space_preserve',
    );
  });

  it.each([
    ['required DOCX part', 'word/document.xml', 'word/documenT.xml'],
    ['unrequested DOCX part', 'word/theme/theme1.xml', 'word/theme/themE1.xml'],
    ['PPTX manifest part', 'ppt/presentation.xml', 'ppt/presentatioN.xml'],
    ['PPTX slide part', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'],
  ])(
    'rejects duplicate normalized ZIP names for a %s before selecting either payload',
    async (kind, canonicalName, aliasName) => {
      const isPptx = kind.startsWith('PPTX');
      const fixture = path.join(
        fixtureDir,
        `duplicate-${kind.replaceAll(' ', '-')}.${isPptx ? 'pptx' : 'docx'}`,
      );
      await createDuplicatePartFixture(
        fixture,
        isPptx ? 'pptx' : 'docx',
        canonicalName,
        aliasName,
      );

      await expect(
        isPptx
          ? parsePptx(fixture, { source_checksum: CHECKSUM })
          : parseDocx(fixture, { source_checksum: CHECKSUM }),
      ).rejects.toThrow('duplicate OOXML archive entry');
    },
  );

  it('rejects a ZIP whose local and central directory names disagree', async () => {
    const fixture = path.join(fixtureDir, 'mismatched-name.docx');
    await createLocalCentralNameMismatchFixture(fixture);

    await expect(
      parseDocx(fixture, { source_checksum: CHECKSUM }),
    ).rejects.toThrow('local and central directory names differ');
  });

  it('validates normalized worker manifests without folding OOXML name case', () => {
    expect(() =>
      assertUniqueOoxmlEntryNames(['word/document.xml', 'word/Document.xml']),
    ).not.toThrow();
    expect(() =>
      assertUniqueOoxmlEntryNames(['word/document.xml', 'word/document.xml']),
    ).toThrow('duplicate OOXML archive entry');
    expect(() =>
      assertUniqueOoxmlEntryNames([
        'word/cafe\u0301.xml',
        'word/caf\u00e9.xml',
      ]),
    ).toThrow('duplicate OOXML archive entry');
  });

  it('accepts semantic OOXML elements only from the required namespace URI', async () => {
    const docxFixture = path.join(fixtureDir, 'wrong-namespace.docx');
    createWrongNamespaceDocxFixture(docxFixture);
    await expect(
      parseDocx(docxFixture, { source_checksum: CHECKSUM }),
    ).rejects.toThrow(/namespace/i);

    const pptxFixture = path.join(fixtureDir, 'wrong-placeholder.pptx');
    createWrongPlaceholderNamespacePptxFixture(pptxFixture);
    const pptx = await parsePptx(pptxFixture, {
      source_checksum: CHECKSUM,
    });
    expect(pptx.title).toBe('');
    expect(pptx.ast.location).toEqual({
      kind: 'slide',
      status: 'degraded',
      reason: 'pptx_title_placeholder_unavailable',
    });
  });

  it('rejects OOXML document type declarations before entity expansion', async () => {
    const fixture = path.join(fixtureDir, 'entity-expansion.docx');
    const zip = new AdmZip();
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        [
          '<!DOCTYPE w:document [<!ENTITY expanded "expanded text">]>',
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
          '<w:p><w:r><w:t>&expanded;</w:t></w:r></w:p>',
          '</w:body></w:document>',
        ].join(''),
      ),
    );
    zip.writeZip(fixture);

    await expect(
      parseDocx(fixture, { source_checksum: CHECKSUM }),
    ).rejects.toThrow(/document type|doctype/i);
  });

  it.each([
    ['Markdown', 'oversize.md', parseMarkdown],
    ['TXT', 'oversize.txt', parseTxt],
    ['DOCX', 'oversize.docx', parseDocx],
    ['PPTX', 'oversize.pptx', parsePptx],
  ])('enforces a common input-byte budget for %s', async (_, name, parser) => {
    const fixture = path.join(fixtureDir, name);
    await fs.writeFile(fixture, 'too large');
    const budget: Partial<ParserBudget> = { max_bytes: 2 };

    await expect(
      parser(fixture, {
        source_checksum: CHECKSUM,
        source_bytes: Buffer.from('too large'),
        budget,
      }),
    ).rejects.toThrow('Parser budget exceeded: bytes');
  });

  it('enforces the common byte budget before PDF loading begins', async () => {
    const fixture = path.join(fixtureDir, 'oversize.pdf');
    const bytes = Buffer.from('%PDF-over-budget');
    await fs.writeFile(fixture, bytes);

    await expect(
      parsePdf(fixture, {
        source_checksum: CHECKSUM,
        source_bytes: bytes,
        budget: { max_bytes: 2 },
      }),
    ).rejects.toThrow('Parser budget exceeded: bytes');
  });

  it('enforces block, character, token, slide, time and abort budgets', async () => {
    const markdownFixture = path.join(fixtureDir, 'blocks.md');
    await fs.writeFile(markdownFixture, '# 标题\n\n正文');
    await expect(
      parseMarkdown(markdownFixture, {
        source_checksum: CHECKSUM,
        budget: { max_blocks: 1 },
      }),
    ).rejects.toThrow('Parser budget exceeded: blocks');

    const txtFixture = path.join(fixtureDir, 'chars.txt');
    await fs.writeFile(txtFixture, '这是足够长的正文。');
    await expect(
      parseTxt(txtFixture, {
        source_checksum: CHECKSUM,
        budget: { max_chars: 2 },
      }),
    ).rejects.toThrow('Parser budget exceeded: chars');
    await expect(
      parseTxt(txtFixture, {
        source_checksum: CHECKSUM,
        budget: { max_tokens: 2 },
      }),
    ).rejects.toThrow('Parser budget exceeded: tokens');

    const pptxFixture = path.join(fixtureDir, 'slides.pptx');
    createPptxFixture(pptxFixture);
    await expect(
      parsePptx(pptxFixture, {
        source_checksum: CHECKSUM,
        budget: { max_slides: 1 },
      }),
    ).rejects.toThrow('Parser budget exceeded: slides');
    expect(() =>
      new ParserBudgetGuard({ max_pages: 1 }).assertPages(2),
    ).toThrow('Parser budget exceeded: pages');

    const controller = new AbortController();
    controller.abort(new Error('caller cancelled parsing'));
    await expect(
      parseMarkdown(markdownFixture, {
        source_checksum: CHECKSUM,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted|cancelled/i);

    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_002);
    try {
      expect(() => new ParserBudgetGuard({ max_time_ms: 1 }).check()).toThrow(
        'Parser budget exceeded: time',
      );
    } finally {
      now.mockRestore();
    }
  });

  it('enforces OOXML output budgets after safe archive inspection', async () => {
    const fixture = path.join(fixtureDir, 'blocks.docx');
    createDocxFixture(fixture);

    await expect(
      parseDocx(fixture, {
        source_checksum: CHECKSUM,
        budget: { max_blocks: 1 },
      }),
    ).rejects.toThrow('Parser budget exceeded: blocks');
  });

  it('preempts synchronous OOXML inflation and XML parsing at the time budget', async () => {
    const fixture = path.join(fixtureDir, 'heavy-time-budget.docx');
    createHeavyDocxFixture(fixture, 120_000);
    const startedAt = performance.now();

    await expect(
      parseDocx(fixture, {
        source_checksum: CHECKSUM,
        budget: { max_time_ms: 10 },
      }),
    ).rejects.toThrow('Parser budget exceeded: time');

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(getActiveOoxmlWorkerCountForTests()).toBe(0);
  }, 15_000);

  it('terminates an in-flight OOXML parser worker immediately when aborted', async () => {
    const fixture = path.join(fixtureDir, 'heavy-abort.docx');
    createHeavyDocxFixture(fixture, 120_000);
    const controller = new AbortController();
    const startedAt = performance.now();
    const parsing = parseDocx(fixture, {
      source_checksum: CHECKSUM,
      signal: controller.signal,
    });
    setTimeout(
      () => controller.abort(new Error('caller cancelled OOXML parsing')),
      10,
    );

    await expect(parsing).rejects.toThrow('caller cancelled OOXML parsing');
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(getActiveOoxmlWorkerCountForTests()).toBe(0);
  }, 15_000);

  it('rejects output at the append boundary before retaining an extra block', () => {
    const guard = new ParserBudgetGuard({ max_blocks: 1 });
    const blocks: Array<{
      structural_path: string;
      type: 'paragraph';
      text: string;
      heading_path: string[];
    }> = [];
    guard.appendBlock(blocks, {
      structural_path: 'block/0',
      type: 'paragraph',
      text: '第一段',
      heading_path: [],
    });

    expect(() =>
      guard.appendBlock(blocks, {
        structural_path: 'block/1',
        type: 'paragraph',
        text: '第二段',
        heading_path: [],
      }),
    ).toThrow('Parser budget exceeded: blocks');
    expect(blocks).toHaveLength(1);
  });

  it('rejects text while it is accumulated before retaining an oversized fragment', () => {
    const guard = new ParserBudgetGuard({ max_chars: 2, max_tokens: 2 });
    const text = guard.createTextAccumulator();
    text.append('甲');
    text.append('乙');

    expect(() => text.append('丙')).toThrow('Parser budget exceeded: chars');
    expect(text.toString()).toBe('甲乙');
  });

  it('rejects malformed AST fields and offset/order drift before persistence', () => {
    expect(() =>
      finalizeDocumentAst({
        source_checksum: CHECKSUM,
        parser_version: 'test-1',
        location: {
          kind: 'none',
          status: 'unavailable',
          reason: 'fixture',
        },
        blocks: [
          {
            structural_path: 'block/0',
            type: 'paragraph',
            text: '正文',
            heading_path: [null as unknown as string],
          },
        ],
      }),
    ).toThrow('heading_path');

    const valid = finalizeDocumentAst({
      source_checksum: CHECKSUM,
      parser_version: 'test-1',
      location: {
        kind: 'none',
        status: 'unavailable',
        reason: 'fixture',
      },
      blocks: [
        {
          structural_path: 'block/0',
          type: 'paragraph',
          text: '正文',
          heading_path: [],
        },
      ],
    });
    const invalidOffsets = structuredClone(valid.ast);
    invalidOffsets.blocks[0].offsets.end = 999;
    expect(() => assertDocumentAst(invalidOffsets, valid.content_text)).toThrow(
      'offsets/order',
    );

    const invalidMetadata = structuredClone(valid.ast);
    invalidMetadata.blocks[0].metadata = {
      bad: { nested: true },
    } as unknown as Record<string, string>;
    expect(() =>
      assertDocumentAst(invalidMetadata, valid.content_text),
    ).toThrow('metadata');

    const invalidLocation = structuredClone(valid.ast);
    invalidLocation.location = {
      kind: 'none',
      status: 'exact',
    } as unknown as typeof invalidLocation.location;
    expect(() =>
      assertDocumentAst(invalidLocation, valid.content_text),
    ).toThrow('location');
  });
});

function createDocxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      [
        '<?xml version="1.0"?>',
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">结构化教材</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>正文段落</w:t></w:r></w:p>',
        '<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p>',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
        '</w:body></w:document>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createPptxFixture(filePath: string): void {
  const presentation =
    'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelationships =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships =
    'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      `<p:presentation xmlns:p="${presentation}" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${officeRelationships}/slide" Target="slides/slide2.xml"/></Relationships>`,
    ),
  );
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      [
        `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree>`,
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第一讲</a:t></a:r></a:p></p:txBody></p:sp>',
        '<p:sp><p:txBody><a:p><a:r><a:t>课程正文</a:t></a:r></a:p></p:txBody></p:sp>',
        '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>列一</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>列二</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>',
        '</p:spTree></p:cSld></p:sld>',
      ].join(''),
    ),
  );
  zip.addFile(
    'ppt/slides/slide2.xml',
    Buffer.from(
      `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>第二讲</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  zip.writeZip(filePath);
}

function createAlternatePrefixDocxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      [
        '<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body>',
        '<x:p><x:pPr><x:pStyle x:val="CustomHeading"/></x:pPr><x:r><x:t>替代前缀标题</x:t></x:r></x:p>',
        '<x:p><x:pPr><x:numPr><x:ilvl x:val="0"/><x:numId x:val="7"/></x:numPr></x:pPr><x:r><x:t>列表正文</x:t></x:r></x:p>',
        '</x:body></x:document>',
      ].join(''),
    ),
  );
  zip.addFile(
    'word/styles.xml',
    Buffer.from(
      [
        '<x:styles xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<x:style x:type="paragraph" x:styleId="CustomHeading"><x:name x:val="heading 2"/><x:pPr><x:outlineLvl x:val="1"/></x:pPr></x:style>',
        '</x:styles>',
      ].join(''),
    ),
  );
  zip.addFile(
    'word/numbering.xml',
    Buffer.from(
      [
        '<x:numbering xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<x:abstractNum x:abstractNumId="3"><x:lvl x:ilvl="0"><x:numFmt x:val="bullet"/></x:lvl></x:abstractNum>',
        '<x:num x:numId="7"><x:abstractNumId x:val="3"/></x:num>',
        '</x:numbering>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createRelationshipOrderedPptxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      [
        '<q:presentation xmlns:q="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:z="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<q:sldIdLst><q:sldId id="256" z:id="rId2"/><q:sldId id="257" z:id="rId1"/></q:sldIdLst>',
        '</q:presentation>',
      ].join(''),
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      [
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
        '</Relationships>',
      ].join(''),
    ),
  );
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      [
        '<q:sld xmlns:q="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main"><q:cSld><q:spTree>',
        '<q:sp><q:nvSpPr><q:nvPr><q:ph type="title"/></q:nvPr></q:nvSpPr><q:txBody><d:p><d:r><d:t>逻辑第二页</d:t></d:r></d:p></q:txBody></q:sp>',
        '</q:spTree></q:cSld></q:sld>',
      ].join(''),
    ),
  );
  zip.addFile(
    'ppt/slides/slide2.xml',
    Buffer.from(
      [
        '<q:sld xmlns:q="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/main"><q:cSld><q:spTree>',
        '<q:sp><q:nvSpPr><q:nvPr><q:ph type="ctrTitle"/></q:nvPr></q:nvSpPr><q:txBody><d:p><d:r><d:t>逻辑第一页</d:t></d:r></d:p></q:txBody></q:sp>',
        '</q:spTree></q:cSld></q:sld>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createUntrustedRelationshipPptxFixture(filePath: string): void {
  const presentation =
    'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelationships =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships =
    'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      `<p:presentation xmlns:p="${presentation}" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml" TargetMode="External"/><Relationship Id="rId2" Type="${officeRelationships}/slide" Target="../escape.xml"/></Relationships>`,
    ),
  );
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>不可信影子页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  zip.addFile(
    'ppt/escape.xml',
    Buffer.from(
      `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>逃逸页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  zip.writeZip(filePath);
}

function createEncodedRelationshipPptxFixture(filePath: string): void {
  const presentation =
    'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelationships =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships =
    'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      `<p:presentation xmlns:p="${presentation}" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/><p:sldId id="3" r:id="rId3"/><p:sldId id="4" r:id="rId4"/><p:sldId id="5" r:id="rId5"/></p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      [
        `<Relationships xmlns="${packageRelationships}">`,
        `<Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide%3Fx.xml"/>`,
        `<Relationship Id="rId2" Type="${officeRelationships}/slide" Target="slides/slide%23x.xml"/>`,
        `<Relationship Id="rId3" Type="${officeRelationships}/slide" Target="slides/slide%00x.xml"/>`,
        `<Relationship Id="rId4" Type="${officeRelationships}/slide" Target="slides%5Cslide4.xml"/>`,
        `<Relationship Id="rId5" Type="${officeRelationships}/slide" Target="slides/%252e%252e/slide5.xml"/>`,
        '</Relationships>',
      ].join(''),
    ),
  );
  zip.addFile(
    'ppt/slides/slide?x.xml',
    Buffer.from(
      `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>编码查询影子页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  zip.writeZip(filePath);
}

function createPreservedSpaceDocxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
        '<w:body><w:p><w:r><w:t xml:space="preserve">  E  </w:t></w:r></w:p></w:body>',
        '</w:document>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createInheritedSpaceDocxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xml:space="preserve">',
        '<w:body>',
        '<w:p><w:r><w:t>  inherited  </w:t></w:r></w:p>',
        '<w:p xml:space="default"><w:r><w:t>  reset  </w:t></w:r></w:p>',
        '<w:p xml:space="default"><w:r xml:space="preserve"><w:t>  nearest wins  </w:t></w:r></w:p>',
        '</w:body>',
        '</w:document>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createInheritedSpacePptxFixture(filePath: string): void {
  const presentation =
    'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelationships =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships =
    'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      `<p:presentation xmlns:p="${presentation}" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ),
  );
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      [
        `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}" xml:space="preserve"><p:cSld><p:spTree>`,
        '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>  inherited title  </a:t></a:r></a:p></p:txBody></p:sp>',
        '<p:sp xml:space="default"><p:txBody><a:p><a:r><a:t>  reset body  </a:t></a:r></a:p></p:txBody></p:sp>',
        '</p:spTree></p:cSld></p:sld>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

async function createDuplicatePartFixture(
  filePath: string,
  type: 'docx' | 'pptx',
  canonicalName: string,
  aliasName: string,
): Promise<void> {
  if (Buffer.byteLength(canonicalName) !== Buffer.byteLength(aliasName)) {
    throw new Error('Duplicate ZIP fixture names must have equal byte lengths');
  }
  const zip = new AdmZip();
  if (type === 'docx') {
    zip.addFile(
      'word/document.xml',
      Buffer.from(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>可信正文</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
  } else {
    zip.addFile(
      'ppt/presentation.xml',
      Buffer.from(
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
      ),
    );
    zip.addFile(
      'ppt/_rels/presentation.xml.rels',
      Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
      ),
    );
    zip.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from(
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>可信页</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>',
      ),
    );
  }
  if (!zip.getEntry(canonicalName)) {
    zip.addFile(canonicalName, Buffer.from('first compressed payload'));
  }
  zip.addFile(aliasName, Buffer.from('second distinct compressed payload'));
  const ambiguousArchive = replaceAllZipNameBytes(
    zip.toBuffer(),
    aliasName,
    canonicalName,
    2,
  );
  await fs.writeFile(filePath, ambiguousArchive);
}

async function createLocalCentralNameMismatchFixture(
  filePath: string,
): Promise<void> {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
    ),
  );
  const archive = zip.toBuffer();
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const centralOffset = archive.indexOf(centralSignature);
  if (centralOffset < 0)
    throw new Error('ZIP fixture has no central directory');
  const localNameLength = archive.readUInt16LE(26);
  const localName = archive.subarray(30, 30 + localNameLength);
  const mismatchName = Buffer.from('word/documenT.xml');
  if (localName.length !== mismatchName.length) {
    throw new Error('ZIP fixture mismatch name has the wrong byte length');
  }
  mismatchName.copy(archive, 30);
  await fs.writeFile(filePath, archive);
}

function replaceAllZipNameBytes(
  source: Buffer,
  from: string,
  to: string,
  expectedReplacements: number,
): Buffer {
  const output = Buffer.from(source);
  const fromBytes = Buffer.from(from);
  const toBytes = Buffer.from(to);
  let cursor = 0;
  let replacements = 0;
  while ((cursor = output.indexOf(fromBytes, cursor)) >= 0) {
    toBytes.copy(output, cursor);
    cursor += toBytes.length;
    replacements += 1;
  }
  if (replacements !== expectedReplacements) {
    throw new Error(
      `Expected ${expectedReplacements} ZIP name replacements, got ${replacements}`,
    );
  }
  return output;
}

function createHeavyDocxFixture(filePath: string, paragraphs: number): void {
  const zip = new AdmZip();
  const paragraph = '<w:p><w:r><w:t>需要被可抢占解析的正文</w:t></w:r></w:p>';
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        paragraph.repeat(paragraphs),
        '</w:body></w:document>',
      ].join(''),
    ),
  );
  zip.writeZip(filePath);
}

function createWrongNamespaceDocxFixture(filePath: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<x:document xmlns:x="https://example.invalid/not-wordprocessingml"><x:body><x:p><x:r><x:t>伪造正文</x:t></x:r></x:p></x:body></x:document>',
    ),
  );
  zip.writeZip(filePath);
}

function createWrongPlaceholderNamespacePptxFixture(filePath: string): void {
  const presentation =
    'http://schemas.openxmlformats.org/presentationml/2006/main';
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelationships =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRelationships =
    'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new AdmZip();
  zip.addFile(
    'ppt/presentation.xml',
    Buffer.from(
      `<p:presentation xmlns:p="${presentation}" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    'ppt/_rels/presentation.xml.rels',
    Buffer.from(
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/></Relationships>`,
    ),
  );
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:e="https://example.invalid/not-presentationml"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><e:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>不是标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ),
  );
  zip.writeZip(filePath);
}
