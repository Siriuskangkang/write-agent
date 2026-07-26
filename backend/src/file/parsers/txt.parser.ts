import * as fs from 'fs/promises';
import {
  finalizeDocumentAst,
  ParserBudgetGuard,
  sectionsFromAst,
  sha256,
  type DraftAstBlock,
  type ParseContext,
  type ParseResult,
} from './document-ast.js';

const PARSER_VERSION = 'txt-ast-1';

export async function parseTxt(
  filePath: string,
  context?: ParseContext,
): Promise<ParseResult> {
  const guard = new ParserBudgetGuard(context?.budget, context?.signal);
  const bytes =
    context?.source_bytes ??
    (await guard.run(() => fs.readFile(filePath, { signal: context?.signal })));
  guard.assertInputBytes(bytes.length);
  const text = bytes.toString('utf8');
  const blocks: DraftAstBlock[] = [];
  const headingPath: string[] = [];
  let firstParagraph = '';
  let paragraphIndex = 0;

  for (const paragraph of iterateParagraphs(text)) {
    guard.check();
    const trimmed = paragraph.trim();
    if (!firstParagraph) firstParagraph = trimmed;
    const isHeadingLike =
      trimmed.length <= 40 &&
      !trimmed.includes('\n') &&
      !/[。！？.!?]/.test(trimmed) &&
      !trimmed.includes('：') &&
      !trimmed.includes(':');

    if (isHeadingLike) {
      headingPath.splice(0, headingPath.length, trimmed);
      const headingText = guard.createTextAccumulator({
        reserve_block: true,
      });
      appendInChunks(headingText, trimmed);
      guard.appendBlock(
        blocks,
        {
          structural_path: `paragraph/${paragraphIndex}/heading`,
          type: 'heading',
          text: headingText.toString(),
          heading_path: [...headingPath],
          metadata: { level: 1, inferred: true },
        },
        headingText,
      );
      paragraphIndex += 1;
      continue;
    }

    let isList = true;
    for (const line of iterateLines(trimmed)) {
      guard.check();
      if (!/^\s*(?:[-+*]|\d+[.)])\s+.+$/.test(line.trim())) {
        isList = false;
        break;
      }
    }
    if (isList) {
      let lineIndex = 0;
      for (const line of iterateLines(trimmed)) {
        const match = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
        if (!match) continue;
        guard.appendBlock(blocks, {
          structural_path: `paragraph/${paragraphIndex}/list/${lineIndex}`,
          type: 'list_item',
          text: match[1].trim(),
          heading_path: [...headingPath],
        });
        lineIndex += 1;
      }
      paragraphIndex += 1;
      continue;
    }
    const paragraphText = guard.createTextAccumulator({
      reserve_block: true,
    });
    appendInChunks(paragraphText, trimmed);
    guard.appendBlock(
      blocks,
      {
        structural_path: `paragraph/${paragraphIndex}`,
        type: 'paragraph',
        text: paragraphText.toString(),
        heading_path: [...headingPath],
      },
      paragraphText,
    );
    paragraphIndex += 1;
  }

  const finalized = finalizeDocumentAst({
    source_checksum: context?.source_checksum ?? sha256(text),
    parser_version: PARSER_VERSION,
    location: {
      kind: 'none',
      status: 'unavailable',
      reason: 'plain_text_has_no_pagination',
    },
    blocks,
    budget_guard: guard,
  });

  return {
    title:
      finalized.ast.blocks.find((block) => block.type === 'heading')?.text ??
      firstParagraph.substring(0, 100) ??
      '',
    content_text: finalized.content_text,
    page_count: null,
    sections: sectionsFromAst(finalized.ast),
    parser_version: PARSER_VERSION,
    ast: finalized.ast,
  };
}

function* iterateParagraphs(text: string): Generator<string> {
  const separators = /\n{2,}/g;
  let start = 0;
  for (
    let match = separators.exec(text);
    match;
    match = separators.exec(text)
  ) {
    const paragraph = text.slice(start, match.index);
    if (paragraph.trim()) yield paragraph;
    start = match.index + match[0].length;
  }
  const finalParagraph = text.slice(start);
  if (finalParagraph.trim()) yield finalParagraph;
}

function* iterateLines(text: string): Generator<string> {
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== '\n') continue;
    yield text.slice(start, index);
    start = index + 1;
  }
}

function appendInChunks(
  output: ReturnType<ParserBudgetGuard['createTextAccumulator']>,
  text: string,
): void {
  for (let offset = 0; offset < text.length; offset += 4096) {
    output.append(text.slice(offset, offset + 4096));
  }
}
