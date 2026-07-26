import * as fs from 'node:fs/promises';
import {
  finalizeDocumentAst,
  ParserBudgetGuard,
  sectionsFromAst,
  sha256,
  type DraftAstBlock,
  type ParseContext,
  type ParseResult,
  type ParserTextAccumulator,
} from './document-ast.js';
import {
  OOXML_NAMESPACES,
  attributeValue,
  elementText,
  firstDescendant,
  hasEffectiveXmlSpacePreserve,
  iterateDescendantElements,
  type NamespaceElement,
} from './ooxml-xml.js';
import {
  parseOoxmlPartsInWorker,
  type ParsedOoxmlArchive,
} from './ooxml-worker-client.js';

const PARSER_VERSION = 'pptx-ast-4';
const PRESENTATION = OOXML_NAMESPACES.presentation;
const DRAWING = OOXML_NAMESPACES.drawing;
const OFFICE_RELATIONSHIPS = OOXML_NAMESPACES.officeRelationships;
const PACKAGE_RELATIONSHIPS = OOXML_NAMESPACES.packageRelationships;
const SLIDE_RELATIONSHIP_TYPES = new Set(
  OFFICE_RELATIONSHIPS.map((namespace) => `${namespace}/slide`),
);

interface ParsedShape {
  text: string;
  output: ParserTextAccumulator;
  sourceIndex: number;
  isTitle: boolean;
  placeholderType: string | null;
  preserveBoundaryWhitespace: boolean;
}

export async function parsePptx(
  filePath: string,
  context?: ParseContext,
): Promise<ParseResult> {
  const guard = new ParserBudgetGuard(context?.budget, context?.signal);
  const sourceBuffer =
    context?.source_bytes ??
    (await guard.run(() => fs.readFile(filePath, { signal: context?.signal })));
  guard.assertInputBytes(sourceBuffer.length);
  const blocks: DraftAstBlock[] = [];
  const slideTitles: string[] = [];
  const manifest = await parseOoxmlPartsInWorker(
    sourceBuffer,
    [
      {
        entry_name: 'ppt/presentation.xml',
        root_local_name: 'presentation',
        root_namespace_uris: PRESENTATION,
        required: false,
        enforce_output_budget: false,
      },
      {
        entry_name: 'ppt/_rels/presentation.xml.rels',
        root_local_name: 'Relationships',
        root_namespace_uris: PACKAGE_RELATIONSHIPS,
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
  const slideOrder = resolveSlideOrder(manifest, guard);
  guard.assertSlides(slideOrder.paths.length);
  let degradedReason = slideOrder.reason;
  const slideArchive =
    slideOrder.paths.length === 0
      ? undefined
      : await parseOoxmlPartsInWorker(
          sourceBuffer,
          slideOrder.paths.map((entryName) => ({
            entry_name: entryName,
            root_local_name: 'sld',
            root_namespace_uris: PRESENTATION,
            required: true,
            enforce_output_budget: true,
          })),
          {
            budget: guard.budget,
            timeout_ms: guard.remainingTimeMs(),
            signal: context?.signal,
          },
        );
  guard.check();

  for (const [orderIndex, entryName] of slideOrder.paths.entries()) {
    guard.check();
    const slide = slideArchive?.parts[entryName];
    if (!slide) {
      degradedReason ??= 'pptx_slide_relationship_target_missing';
      continue;
    }
    const slideNumber = orderIndex + 1;
    const parsedShapes: ParsedShape[] = [];
    let sourceIndex = 0;
    for (const shape of iterateDescendantElements(slide, PRESENTATION, 'sp')) {
      guard.check();
      const output = accumulateDrawingText(shape, guard);
      if (!output) continue;
      const placeholder = firstDescendant(shape, PRESENTATION, 'ph');
      const placeholderType = attributeValue(placeholder, 'type', [null]);
      const preserveBoundaryWhitespace = hasEffectiveXmlSpacePreserve(shape);
      parsedShapes.push({
        text: output.toString(),
        output,
        sourceIndex,
        isTitle: placeholderType === 'title' || placeholderType === 'ctrTitle',
        placeholderType,
        preserveBoundaryWhitespace,
      });
      sourceIndex += 1;
    }

    const titleShape = parsedShapes.find((shape) => shape.isTitle);
    if (parsedShapes.length > 0 && !titleShape) {
      degradedReason ??= 'pptx_title_placeholder_unavailable';
    }
    const title = titleShape?.text ?? '';
    slideTitles.push(title);
    for (const shape of parsedShapes) {
      guard.appendBlock(
        blocks,
        {
          structural_path: `slide/${slideNumber}/shape/${shape.sourceIndex}`,
          type: shape.isTitle ? 'heading' : 'paragraph',
          text: shape.text,
          heading_path: title ? [title] : [],
          page_start: slideNumber,
          page_end: slideNumber,
          metadata: {
            location_kind: 'slide',
            ...(shape.isTitle ? { level: 1 } : {}),
            ...(shape.placeholderType
              ? { placeholder_type: shape.placeholderType }
              : {}),
            ...(shape.preserveBoundaryWhitespace
              ? { xml_space_preserve: true }
              : {}),
          },
          preserve_boundary_whitespace: shape.preserveBoundaryWhitespace,
        },
        shape.output,
      );
    }

    let tableIndex = 0;
    for (const table of iterateDescendantElements(slide, DRAWING, 'tbl')) {
      appendTableBlock(blocks, table, tableIndex, slideNumber, title, guard);
      tableIndex += 1;
    }
  }

  if (slideOrder.paths.length > 0 && blocks.length === 0) {
    degradedReason ??= 'pptx_text_content_unavailable';
  }
  const finalized = finalizeDocumentAst({
    source_checksum: context?.source_checksum ?? sha256(sourceBuffer),
    parser_version: PARSER_VERSION,
    location: degradedReason
      ? { kind: 'slide', status: 'degraded', reason: degradedReason }
      : { kind: 'slide', status: 'exact' },
    blocks,
    budget_guard: guard,
  });

  return {
    title: slideTitles[0] ?? '',
    content_text: finalized.content_text,
    page_count: slideOrder.paths.length,
    sections: sectionsFromAst(finalized.ast),
    parser_version: PARSER_VERSION,
    ast: finalized.ast,
  };
}

function appendTableBlock(
  blocks: DraftAstBlock[],
  table: NamespaceElement,
  tableIndex: number,
  slideNumber: number,
  title: string,
  guard: ParserBudgetGuard,
): void {
  const preserveBoundaryWhitespace = hasEffectiveXmlSpacePreserve(table);
  const output = guard.createTextAccumulator({ reserve_block: true });
  let rowCount = 0;
  let columns = 0;
  for (const row of iterateDescendantElements(table, DRAWING, 'tr')) {
    guard.check();
    let cellCount = 0;
    output.append(`${rowCount > 0 ? '\n' : ''}| `);
    for (const cell of iterateDescendantElements(row, DRAWING, 'tc')) {
      const cellIndex = cellCount;
      if (cellIndex > 0) output.append(' | ');
      appendDrawingText(cell, output, guard);
      cellCount += 1;
    }
    if (rowCount === 0) columns = cellCount;
    output.append(' |');
    rowCount += 1;
  }
  guard.appendBlock(
    blocks,
    {
      structural_path: `slide/${slideNumber}/table/${tableIndex}`,
      type: 'table',
      text: output.toString(),
      heading_path: title ? [title] : [],
      page_start: slideNumber,
      page_end: slideNumber,
      metadata: {
        location_kind: 'slide',
        rows: rowCount,
        columns,
        ...(preserveBoundaryWhitespace ? { xml_space_preserve: true } : {}),
      },
      preserve_boundary_whitespace: preserveBoundaryWhitespace,
    },
    output,
  );
}

function accumulateDrawingText(
  element: NamespaceElement,
  guard: ParserBudgetGuard,
): ParserTextAccumulator | undefined {
  let output: ParserTextAccumulator | undefined;
  for (const textElement of iterateDescendantElements(element, DRAWING, 't')) {
    const text = elementText(textElement);
    if (!text) continue;
    output ??= guard.createTextAccumulator({ reserve_block: true });
    if (output.toString()) output.append(' ');
    appendTextChunks(output, text, guard);
  }
  return output;
}

function appendDrawingText(
  element: NamespaceElement,
  output: ParserTextAccumulator,
  guard: ParserBudgetGuard,
): void {
  let hasText = false;
  for (const textElement of iterateDescendantElements(element, DRAWING, 't')) {
    const text = elementText(textElement);
    if (!text) continue;
    if (hasText) output.append(' ');
    appendTextChunks(output, text, guard);
    hasText = true;
  }
}

function appendTextChunks(
  output: ParserTextAccumulator,
  text: string,
  guard: ParserBudgetGuard,
): void {
  for (let offset = 0; offset < text.length; offset += 4096) {
    guard.check();
    output.append(text.slice(offset, offset + 4096));
  }
}

function resolveSlideOrder(
  archive: ParsedOoxmlArchive,
  guard: ParserBudgetGuard,
): {
  paths: string[];
  reason?: string;
} {
  const presentation = archive.parts['ppt/presentation.xml'];
  const relationships = archive.parts['ppt/_rels/presentation.xml.rels'];
  if (!presentation || !relationships) {
    return {
      paths: fallbackSlidePaths(archive.entry_names),
      reason: 'pptx_presentation_order_unavailable',
    };
  }

  guard.check();
  const exactEntryNames = new Set(archive.entry_names);
  const targets = new Map<string, string>();
  const ambiguousIds = new Set<string>();
  let reason: string | undefined;
  for (const relationship of iterateDescendantElements(
    relationships,
    PACKAGE_RELATIONSHIPS,
    'Relationship',
  )) {
    guard.check();
    const id = attributeValue(relationship, 'Id', [null]);
    const target = attributeValue(relationship, 'Target', [null]);
    const type = attributeValue(relationship, 'Type', [null]);
    if (!id || !target || !type || !SLIDE_RELATIONSHIP_TYPES.has(type)) {
      continue;
    }
    const targetMode = attributeValue(relationship, 'TargetMode', [null]);
    if (targetMode?.toLowerCase() === 'external') {
      reason ??= 'pptx_external_slide_relationship';
      ambiguousIds.add(id);
      targets.delete(id);
      continue;
    }
    if (targetMode && targetMode.toLowerCase() !== 'internal') {
      reason ??= 'pptx_invalid_slide_relationship';
      ambiguousIds.add(id);
      targets.delete(id);
      continue;
    }
    const normalizedTarget = normalizeSlideTarget(target, exactEntryNames);
    if (!normalizedTarget) {
      reason ??= 'pptx_invalid_slide_relationship_target';
      ambiguousIds.add(id);
      targets.delete(id);
      continue;
    }
    if (targets.has(id) || ambiguousIds.has(id)) {
      reason ??= 'pptx_duplicate_slide_relationship';
      ambiguousIds.add(id);
      targets.delete(id);
      continue;
    }
    targets.set(id, normalizedTarget);
  }

  const paths: string[] = [];
  let slideIdCount = 0;
  for (const slideId of iterateDescendantElements(
    presentation,
    PRESENTATION,
    'sldId',
  )) {
    slideIdCount += 1;
    guard.assertSlides(slideIdCount);
    const relationshipId = attributeValue(slideId, 'id', OFFICE_RELATIONSHIPS);
    const target =
      relationshipId && !ambiguousIds.has(relationshipId)
        ? targets.get(relationshipId)
        : undefined;
    if (!target) {
      reason ??= 'pptx_slide_relationship_target_missing';
      continue;
    }
    if (paths.includes(target)) {
      reason ??= 'pptx_duplicate_slide_relationship';
      continue;
    }
    paths.push(target);
  }
  if (slideIdCount === 0) {
    reason ??= 'pptx_presentation_order_unavailable';
  }
  return { paths, ...(reason ? { reason } : {}) };
}

function fallbackSlidePaths(entryNames: readonly string[]): string[] {
  return entryNames
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
}

function normalizeSlideTarget(
  target: string,
  exactEntryNames: ReadonlySet<string>,
): string | null {
  if (hasUnsafeRelationshipTargetSyntax(target)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (hasUnsafeRelationshipTargetSyntax(decoded) || decoded.includes('%')) {
    return null;
  }
  if (
    decoded.split('/').some((segment) => segment === '..' || segment === '.') ||
    !/^slides\/[^/]+\.xml$/.test(decoded)
  ) {
    return null;
  }
  const normalized = `ppt/${decoded}`;
  return exactEntryNames.has(normalized) ? normalized : null;
}

function hasUnsafeRelationshipTargetSyntax(target: string): boolean {
  return (
    Array.from(target).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    target.includes('\\') ||
    target.includes('?') ||
    target.includes('#') ||
    target.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  );
}
