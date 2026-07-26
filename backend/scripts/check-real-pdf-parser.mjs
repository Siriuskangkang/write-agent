import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePdf } from '../dist/file/parsers/pdf.parser.js';

const fixtureDir = await fs.mkdtemp(
  path.join(os.tmpdir(), 'write-agent-real-pdf-'),
);
try {
  const fixture = path.join(fixtureDir, 'two-pages.pdf');
  const contents = createPdfFixture(['First page', 'Second page']);
  await fs.writeFile(fixture, contents);
  const result = await parsePdf(fixture, {
    source_checksum: createHash('sha256').update(contents).digest('hex'),
  });

  assert.equal(result.page_count, 2);
  assert.deepEqual(result.ast.location, {
    kind: 'page',
    status: 'exact',
  });
  assert.deepEqual(
    result.ast.blocks.map((block) => block.page_start),
    [1, 2],
  );
  assert.deepEqual(
    result.ast.blocks.map((block) => block.page_end),
    [1, 2],
  );
  for (const block of result.ast.blocks) {
    assert.equal(
      result.content_text.slice(block.offsets.start, block.offsets.end),
      block.text,
    );
  }
  console.log('Real PDF structured parser fixture passed');
} finally {
  await fs.rm(fixtureDir, { recursive: true, force: true });
}

function createPdfFixture(pageTexts) {
  const objects = [];
  const pageIds = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('');
  objects.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  for (const text of pageTexts) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = `BT /F1 18 Tf 30 120 Td (${escaped}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
    `/Count ${pageIds.length} >>`;

  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}
