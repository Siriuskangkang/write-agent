import * as fs from 'fs/promises';
import { createRequire } from 'node:module';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import {
  finalizeDocumentAst,
  ParserBudgetGuard,
  sectionsFromAst,
  sha256,
  type DraftAstBlock,
  type ParseContext,
  type ParseResult,
} from './document-ast.js';

export type { ParseResult } from './document-ast.js';

const PARSER_VERSION = 'pdf-ast-1';

interface PdfJsModule {
  getDocument(data: Uint8Array): PDFDocumentLoadingTask;
}

function loadPdfJs(): PdfJsModule {
  // Node 22 can synchronously load this ESM bundle. createRequire keeps the
  // dependency out of Jest's CommonJS source transform.
  const runtimeRequire = createRequire(__filename);
  return runtimeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfJsModule;
}

function getMetadataTitle(info: object): string {
  const title = (info as Record<string, unknown>).Title;
  return typeof title === 'string' ? title : '';
}

function getTextItemString(item: unknown): string {
  if (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof item.str === 'string'
  ) {
    return item.str;
  }

  return '';
}

export async function parsePdf(
  filePath: string,
  context?: ParseContext,
): Promise<ParseResult> {
  const guard = new ParserBudgetGuard(context?.budget, context?.signal);
  const buffer =
    context?.source_bytes ??
    (await guard.run(() => fs.readFile(filePath, { signal: context?.signal })));
  guard.assertInputBytes(buffer.length);
  const pdfjsLib = loadPdfJs();
  const loadingTask = pdfjsLib.getDocument(new Uint8Array(buffer));
  let pdfDoc: Awaited<PDFDocumentLoadingTask['promise']> | undefined;
  try {
    pdfDoc = await guard.run(loadingTask.promise);
    const pageCount = pdfDoc.numPages;
    guard.assertPages(pageCount);
    const blocks: DraftAstBlock[] = [];

    for (let i = 1; i <= pageCount; i++) {
      guard.check();
      const page = await guard.run(pdfDoc.getPage(i));
      const content = await guard.run(page.getTextContent());
      let pageText:
        | ReturnType<ParserBudgetGuard['createTextAccumulator']>
        | undefined;
      for (const item of content.items) {
        guard.check();
        const text = getTextItemString(item).trim();
        if (!text) continue;
        pageText ??= guard.createTextAccumulator({ reserve_block: true });
        pageText.append(`${pageText.toString() ? ' ' : ''}${text}`);
      }
      if (pageText) {
        guard.appendBlock(
          blocks,
          {
            structural_path: `page/${i}/paragraph/0`,
            type: 'paragraph',
            text: pageText.toString(),
            heading_path: [],
            page_start: i,
            page_end: i,
            metadata: { location_kind: 'page' },
          },
          pageText,
        );
      }
    }

    let title = '';
    try {
      const metadata = await guard.run(pdfDoc.getMetadata());
      title = getMetadataTitle(metadata.info);
    } catch {
      // optional
    }

    const finalized = finalizeDocumentAst({
      source_checksum: context?.source_checksum ?? sha256(buffer),
      parser_version: PARSER_VERSION,
      location: { kind: 'page', status: 'exact' },
      blocks,
      budget_guard: guard,
    });

    return {
      title,
      content_text: finalized.content_text,
      page_count: pageCount,
      sections: sectionsFromAst(finalized.ast),
      parser_version: PARSER_VERSION,
      ast: finalized.ast,
    };
  } finally {
    if (pdfDoc) {
      await Promise.allSettled([pdfDoc.destroy(), loadingTask.destroy()]);
    } else {
      await Promise.allSettled([loadingTask.destroy()]);
    }
  }
}
