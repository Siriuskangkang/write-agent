import { BadRequestException } from '@nestjs/common';
import AdmZip from 'adm-zip';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileType } from '../common/enums.js';
import { FileService, isAcceptedUploadDeclaration } from './file.service.js';

type ContentValidator = {
  assertMagicBytes(filePath: string, fileType: FileType): Promise<void>;
};

describe('upload format validation', () => {
  let fixtureRoot: string;
  let validateContents: ContentValidator['assertMagicBytes'];

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-formats-'),
    );
    const service = new FileService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const validator = service as unknown as ContentValidator;
    validateContents = (filePath, fileType) =>
      validator.assertMagicBytes(filePath, fileType);
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each([
    ['pdf', FileType.PDF, createMinimalPdf()],
    ['docx', FileType.DOCX, createMinimalOoxml('docx')],
    ['pptx', FileType.PPTX, createMinimalOoxml('pptx')],
    ['md', FileType.MD, Buffer.from('# 第一章\n\n正文。\n', 'utf8')],
    ['txt', FileType.TXT, Buffer.from('第一章\n正文。\n', 'utf8')],
  ])('accepts a real minimal %s fixture', async (extension, type, contents) => {
    const fixturePath = path.join(fixtureRoot, `fixture.${extension}`);
    await fs.writeFile(fixturePath, contents);

    await expect(validateContents(fixturePath, type)).resolves.toBeUndefined();
  });

  it.each([
    ['lesson.md', 'text/plain', true],
    ['lesson.md', 'text/markdown', true],
    ['lesson.md', 'text/x-markdown', true],
    ['lesson.md', '', true],
    ['lesson.txt', 'text/plain', true],
    ['lesson.txt', '', true],
    ['lesson.txt', 'text/markdown', false],
    ['lesson.pdf', 'text/plain', false],
    ['lesson.txt', 'application/pdf', false],
    ['lesson.bin', 'text/plain', false],
  ])(
    'validates the extension/MIME declaration %s + %s',
    (fileName, mime, expected) => {
      expect(isAcceptedUploadDeclaration(fileName, mime)).toBe(expected);
    },
  );

  it.each([
    [FileType.PDF, Buffer.from('not a PDF', 'utf8')],
    [FileType.DOCX, createMinimalOoxml('pptx')],
    [FileType.PPTX, createMinimalOoxml('docx')],
  ])(
    'rejects content that does not match a declared %s',
    async (type, contents) => {
      const fixturePath = path.join(fixtureRoot, `mismatch.${type}`);
      await fs.writeFile(fixturePath, contents);

      await expect(validateContents(fixturePath, type)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it.each([
    ['plain UTF-8', Buffer.from('教材正文🙂\n', 'utf8')],
    [
      'UTF-8 with BOM',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('# 教材正文\n', 'utf8'),
      ]),
    ],
  ])('accepts %s text', async (_label, contents) => {
    const fixturePath = path.join(fixtureRoot, 'valid.txt');
    await fs.writeFile(fixturePath, contents);

    await expect(
      validateContents(fixturePath, FileType.TXT),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      'UTF-16LE',
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('教\u0000材\u0000', 'utf8'),
      ]),
    ],
    ['invalid UTF-8', Buffer.from([0xe2, 0x28, 0xa1])],
  ])('rejects %s text', async (_label, contents) => {
    const fixturePath = path.join(fixtureRoot, 'invalid.txt');
    await fs.writeFile(fixturePath, contents);

    await expect(
      validateContents(fixturePath, FileType.TXT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a DOCX whose main content type is not mapped to the document part', async () => {
    const spoofed = new AdmZip();
    spoofed.addFile(
      '[Content_Types].xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
        'utf8',
      ),
    );
    spoofed.addFile(
      'word/document.xml',
      Buffer.from('<not-a-word-document/>', 'utf8'),
    );
    const fixturePath = path.join(fixtureRoot, 'spoofed.docx');
    await fs.writeFile(fixturePath, spoofed.toBuffer());

    await expect(
      validateContents(fixturePath, FileType.DOCX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['comment', 'CDATA'] as const)(
    'rejects a DOCX whose only main-part override is hidden in %s',
    async (container) => {
      const spoofed = new AdmZip();
      const override =
        '<Override PartName="/word/document.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>';
      const hidden =
        container === 'comment'
          ? `<!--${override}-->`
          : `<Metadata><![CDATA[${override}]]></Metadata>`;
      spoofed.addFile(
        '[Content_Types].xml',
        Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            hidden +
            '</Types>',
          'utf8',
        ),
      );
      spoofed.addFile(
        'word/document.xml',
        Buffer.from('<not-a-word-document/>', 'utf8'),
      );
      const fixturePath = path.join(fixtureRoot, `hidden-${container}.docx`);
      await fs.writeFile(fixturePath, spoofed.toBuffer());

      await expect(
        validateContents(fixturePath, FileType.DOCX),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rejects an OOXML archive with one oversized uncompressed entry', async () => {
    const archive = createMinimalOoxmlArchive('docx');
    archive.addFile(
      'word/media/oversized.bin',
      Buffer.alloc(16 * 1024 * 1024 + 1),
    );
    const fixturePath = path.join(fixtureRoot, 'oversized-entry.docx');
    await fs.writeFile(fixturePath, archive.toBuffer());

    await expect(
      validateContents(fixturePath, FileType.DOCX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an OOXML archive whose total uncompressed size exceeds its budget', async () => {
    const archive = createMinimalOoxmlArchive('docx');
    for (let index = 0; index < 5; index += 1) {
      archive.addFile(
        `word/media/large-${index}.bin`,
        Buffer.alloc(13 * 1024 * 1024),
      );
    }
    const fixturePath = path.join(fixtureRoot, 'oversized-total.docx');
    await fs.writeFile(fixturePath, archive.toBuffer());

    await expect(
      validateContents(fixturePath, FileType.DOCX),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['NUL', Buffer.from('valid\u0000text', 'utf8')],
    [
      'more than one percent disallowed C0 controls',
      Buffer.from(`${'\u0001'.repeat(2)}${'a'.repeat(98)}`, 'utf8'),
    ],
  ])('rejects UTF-8 text containing %s', async (_label, contents) => {
    const fixturePath = path.join(fixtureRoot, 'control-chars.txt');
    await fs.writeFile(fixturePath, contents);

    await expect(
      validateContents(fixturePath, FileType.TXT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createMinimalPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Count 0 >>\nendobj\n' +
      'xref\n0 3\n0000000000 65535 f \n' +
      'trailer\n<< /Root 1 0 R /Size 3 >>\nstartxref\n0\n%%EOF\n',
    'ascii',
  );
}

function createMinimalOoxml(kind: 'docx' | 'pptx'): Buffer {
  return createMinimalOoxmlArchive(kind).toBuffer();
}

function createMinimalOoxmlArchive(kind: 'docx' | 'pptx'): AdmZip {
  const isDocx = kind === 'docx';
  const mainPart = isDocx ? 'word/document.xml' : 'ppt/presentation.xml';
  const mainContentType = isDocx
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
    : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
  const officeRelationshipType =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
  const body = isDocx
    ? '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body><w:p><w:r><w:t>教材</w:t></w:r></w:p></w:body></w:document>'
    : '<?xml version="1.0" encoding="UTF-8"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>';

  const archive = new AdmZip();
  archive.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/${mainPart}" ContentType="${mainContentType}"/>` +
        '</Types>',
      'utf8',
    ),
  );
  archive.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${officeRelationshipType}" Target="${mainPart}"/>` +
        '</Relationships>',
      'utf8',
    ),
  );
  archive.addFile(mainPart, Buffer.from(body, 'utf8'));
  return archive;
}
