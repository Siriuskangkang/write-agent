import * as fs from 'node:fs/promises';
import {
  finalizeDocumentAst,
  ParserBudgetGuard,
  sectionsFromAst,
  sha256,
  updateHeadingPath,
  type DraftAstBlock,
  type ParseContext,
  type ParseResult,
  type ParserTextAccumulator,
} from './document-ast.js';
import {
  OOXML_NAMESPACES,
  attributeValue,
  childElements,
  elementText,
  firstDescendant,
  hasEffectiveXmlSpacePreserve,
  iterateDescendantElements,
  type NamespaceElement,
} from './ooxml-xml.js';
import { parseOoxmlPartsInWorker } from './ooxml-worker-client.js';

const PARSER_VERSION = 'docx-ast-4';
const WORD = OOXML_NAMESPACES.wordprocessing;

export async function parseDocx(
  filePath: string,
  context?: ParseContext,
): Promise<ParseResult> {
  const guard = new ParserBudgetGuard(context?.budget, context?.signal);
  const buffer =
    context?.source_bytes ??
    (await guard.run(() => fs.readFile(filePath, { signal: context?.signal })));
  guard.assertInputBytes(buffer.length);
  const archive = await parseOoxmlPartsInWorker(
    buffer,
    [
      {
        entry_name: 'word/document.xml',
        root_local_name: 'document',
        root_namespace_uris: WORD,
        required: true,
        enforce_output_budget: true,
      },
      {
        entry_name: 'word/styles.xml',
        root_local_name: 'styles',
        root_namespace_uris: WORD,
        required: false,
        enforce_output_budget: false,
      },
      {
        entry_name: 'word/numbering.xml',
        root_local_name: 'numbering',
        root_namespace_uris: WORD,
        required: false,
        enforce_output_budget: false,
      },
    ],
    {
      budget: guard.budget,
      timeout_ms: guard.remainingTimeMs(),
      signal: context?.signal,
    },
  );
  guard.check();
  const document = requireParsedPart(archive.parts, 'word/document.xml');
  const styles = parseStyleLevels(
    archive.parts['word/styles.xml'] ?? undefined,
  );
  const numbering = parseNumberingFormats(
    archive.parts['word/numbering.xml'] ?? undefined,
  );
  const body = firstDescendant(document, WORD, 'body');
  if (!body) throw new Error('DOCX document namespace has no body');

  const blocks: DraftAstBlock[] = [];
  const headings: Array<{ level: number; title: string }> = [];
  const structuralElements = childElements(body).filter(
    (element) =>
      (WORD as readonly string[]).includes(element.namespace_uri ?? '') &&
      (element.local_name === 'p' || element.local_name === 'tbl'),
  );

  for (const [index, element] of structuralElements.entries()) {
    guard.check();
    const headingPath = headings.map((entry) => entry.title);
    if (element.local_name === 'tbl') {
      appendTableBlock(blocks, element, index, headingPath, guard);
      continue;
    }

    const textOutput = accumulateWordText(element, guard);
    if (!textOutput) continue;
    const text = textOutput.toString();
    const preserveBoundaryWhitespace = hasEffectiveXmlSpacePreserve(element);
    const style = firstDescendant(element, WORD, 'pStyle');
    const styleId = attributeValue(style, 'val', WORD);
    const level =
      (styleId ? styles.get(styleId) : undefined) ??
      headingLevelFromStyleName(styleId);
    if (level) {
      const currentHeadingPath = updateHeadingPath(headings, level, text);
      guard.appendBlock(
        blocks,
        {
          structural_path: `body/${index}/heading/${level}`,
          type: 'heading',
          text,
          heading_path: currentHeadingPath,
          metadata: {
            level,
            ...(styleId ? { style_id: styleId } : {}),
            ...(preserveBoundaryWhitespace ? { xml_space_preserve: true } : {}),
          },
          preserve_boundary_whitespace: preserveBoundaryWhitespace,
        },
        textOutput,
      );
      continue;
    }

    const numberingProperties = firstDescendant(element, WORD, 'numPr');
    const numberingId = attributeValue(
      numberingProperties
        ? firstDescendant(numberingProperties, WORD, 'numId')
        : undefined,
      'val',
      WORD,
    );
    const rawLevel = attributeValue(
      numberingProperties
        ? firstDescendant(numberingProperties, WORD, 'ilvl')
        : undefined,
      'val',
      WORD,
    );
    const numberingLevel = Number(rawLevel ?? 0);
    const numberingFormat = numberingId
      ? numbering.get(`${numberingId}:${numberingLevel}`)
      : undefined;
    const isListItem = numberingProperties !== undefined;
    guard.appendBlock(
      blocks,
      {
        structural_path: `body/${index}/${isListItem ? 'list-item' : 'paragraph'}`,
        type: isListItem ? 'list_item' : 'paragraph',
        text,
        heading_path: headings.map((entry) => entry.title),
        metadata: isListItem
          ? {
              ...(numberingId ? { numbering_id: numberingId } : {}),
              numbering_level: Number.isSafeInteger(numberingLevel)
                ? numberingLevel
                : 0,
              ...(numberingFormat ? { list_format: numberingFormat } : {}),
              ...(preserveBoundaryWhitespace
                ? { xml_space_preserve: true }
                : {}),
            }
          : preserveBoundaryWhitespace
            ? { xml_space_preserve: true }
            : {},
        preserve_boundary_whitespace: preserveBoundaryWhitespace,
      },
      textOutput,
    );
  }
  if (blocks.length === 0) {
    throw new Error(
      'DOCX produced no textual AST blocks from the required namespace',
    );
  }

  const finalized = finalizeDocumentAst({
    source_checksum: context?.source_checksum ?? sha256(buffer),
    parser_version: PARSER_VERSION,
    location: {
      kind: 'page',
      status: 'degraded',
      reason: 'docx_does_not_expose_rendered_page_boundaries',
    },
    blocks,
    budget_guard: guard,
  });

  return {
    title:
      finalized.ast.blocks.find((block) => block.type === 'heading')?.text ??
      '',
    content_text: finalized.content_text,
    page_count: null,
    sections: sectionsFromAst(finalized.ast),
    parser_version: PARSER_VERSION,
    ast: finalized.ast,
  };
}

function appendTableBlock(
  blocks: DraftAstBlock[],
  table: NamespaceElement,
  index: number,
  headingPath: string[],
  guard: ParserBudgetGuard,
): void {
  const preserveBoundaryWhitespace = hasEffectiveXmlSpacePreserve(table);
  const output = guard.createTextAccumulator({ reserve_block: true });
  let rowCount = 0;
  let columns = 0;
  for (const row of iterateDescendantElements(table, WORD, 'tr')) {
    guard.check();
    let cellCount = 0;
    output.append(`${rowCount > 0 ? '\n' : ''}| `);
    for (const cell of iterateDescendantElements(row, WORD, 'tc')) {
      const cellIndex = cellCount;
      if (cellIndex > 0) output.append(' | ');
      appendWordText(cell, output, guard);
      cellCount += 1;
    }
    if (rowCount === 0) columns = cellCount;
    output.append(' |');
    rowCount += 1;
  }
  guard.appendBlock(
    blocks,
    {
      structural_path: `body/${index}/table`,
      type: 'table',
      text: output.toString(),
      heading_path: headingPath,
      metadata: {
        rows: rowCount,
        columns,
        ...(preserveBoundaryWhitespace ? { xml_space_preserve: true } : {}),
      },
      preserve_boundary_whitespace: preserveBoundaryWhitespace,
    },
    output,
  );
}

function accumulateWordText(
  element: NamespaceElement,
  guard: ParserBudgetGuard,
): ParserTextAccumulator | undefined {
  let output: ParserTextAccumulator | undefined;
  for (const textElement of iterateDescendantElements(element, WORD, 't')) {
    guard.check();
    forEachTextChunk(elementText(textElement), (chunk) => {
      guard.check();
      if (!chunk) return;
      output ??= guard.createTextAccumulator({ reserve_block: true });
      output.append(chunk);
    });
  }
  return output;
}

function appendWordText(
  element: NamespaceElement,
  output: ParserTextAccumulator,
  guard: ParserBudgetGuard,
): void {
  for (const textElement of iterateDescendantElements(element, WORD, 't')) {
    forEachTextChunk(elementText(textElement), (chunk) => {
      guard.check();
      output.append(chunk);
    });
  }
}

function requireParsedPart(
  parts: Record<string, NamespaceElement | null>,
  name: string,
): NamespaceElement {
  const part = parts[name];
  if (!part) throw new Error(`DOCX is missing ${name}`);
  return part;
}

function parseStyleLevels(
  styles: NamespaceElement | undefined,
): Map<string, number> {
  const levels = new Map<string, number>();
  if (!styles) return levels;
  for (const style of iterateDescendantElements(styles, WORD, 'style')) {
    const styleId = attributeValue(style, 'styleId', WORD);
    if (!styleId) continue;
    const outlineValue = Number(
      attributeValue(firstDescendant(style, WORD, 'outlineLvl'), 'val', WORD),
    );
    const byName = headingLevelFromStyleName(
      attributeValue(firstDescendant(style, WORD, 'name'), 'val', WORD),
    );
    const level =
      Number.isSafeInteger(outlineValue) && outlineValue >= 0
        ? outlineValue + 1
        : byName;
    if (level && level >= 1 && level <= 9) levels.set(styleId, level);
  }
  return levels;
}

function headingLevelFromStyleName(style: string | null): number | undefined {
  const match = style?.match(/(?:heading|标题)\s*([1-9])/i);
  return match ? Number(match[1]) : undefined;
}

function parseNumberingFormats(
  numbering: NamespaceElement | undefined,
): Map<string, string> {
  const abstractFormats = new Map<string, Map<number, string>>();
  if (!numbering) return new Map();
  for (const abstract of iterateDescendantElements(
    numbering,
    WORD,
    'abstractNum',
  )) {
    const abstractId = attributeValue(abstract, 'abstractNumId', WORD);
    if (!abstractId) continue;
    const levels = new Map<number, string>();
    for (const levelElement of iterateDescendantElements(
      abstract,
      WORD,
      'lvl',
    )) {
      const level = Number(attributeValue(levelElement, 'ilvl', WORD));
      const format = attributeValue(
        firstDescendant(levelElement, WORD, 'numFmt'),
        'val',
        WORD,
      );
      if (Number.isSafeInteger(level) && level >= 0 && format) {
        levels.set(level, format);
      }
    }
    abstractFormats.set(abstractId, levels);
  }

  const formats = new Map<string, string>();
  for (const number of iterateDescendantElements(numbering, WORD, 'num')) {
    const numId = attributeValue(number, 'numId', WORD);
    const abstractId = attributeValue(
      firstDescendant(number, WORD, 'abstractNumId'),
      'val',
      WORD,
    );
    if (!numId || !abstractId) continue;
    for (const [level, format] of abstractFormats.get(abstractId) ?? []) {
      formats.set(`${numId}:${level}`, format);
    }
  }
  return formats;
}

function forEachTextChunk(
  text: string,
  visitor: (chunk: string) => void,
): void {
  for (let offset = 0; offset < text.length; offset += 4096) {
    visitor(text.slice(offset, offset + 4096));
  }
}
