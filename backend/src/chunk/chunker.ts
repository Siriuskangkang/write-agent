import { createHash } from 'node:crypto';
import type {
  DocumentAst,
  DocumentAstBlock,
} from '../file/parsers/document-ast.js';

export interface ChunkInput {
  content_text: string;
  sections: Array<{ title: string; content: string; page?: number }>;
  ast?: DocumentAst;
  ingestion_key?: string;
}

export interface ChunkOutput {
  content: string;
  section_title: string | null;
  page_number: number | null;
  chunk_index: number;
  chunk_type?: 'parent' | 'child';
  parent_key?: string | null;
  stable_key?: string;
  position?: number;
  token_count?: number;
  tokenizer_version?: string;
  overlap_previous_tokens?: number;
  heading_path?: string[];
  page_start?: number | null;
  page_end?: number | null;
  block_ids?: string[];
  char_start?: number | null;
  char_end?: number | null;
}

const MIN_CHUNK_SIZE = 300;
const MAX_CHUNK_SIZE = 800;
const OVERLAP_SIZE = 120;
export const CHUNK_VERSION = 'parent-child-v1';
export const TOKENIZER_VERSION = 'stable-mixed-script-v1';
const MAX_CHILD_TOKENS = 512;
const OVERLAP_TOKENS = 64;

function splitByParagraphs(text: string): string[] {
  const rawParagraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return rawParagraphs.flatMap((paragraph) =>
    splitOversizedParagraph(paragraph),
  );
}

function splitOversizedParagraph(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHUNK_SIZE) {
    return [paragraph];
  }

  const sentenceParts = paragraph
    .split(/(?<=[。！？.!?；;])\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (sentenceParts.length <= 1) {
    return splitByLength(paragraph, MAX_CHUNK_SIZE);
  }

  const segments: string[] = [];
  let buffer = '';

  for (const sentence of sentenceParts) {
    if (buffer && buffer.length + sentence.length + 1 > MAX_CHUNK_SIZE) {
      segments.push(buffer.trim());
      buffer = sentence;
      continue;
    }
    buffer += `${buffer ? ' ' : ''}${sentence}`;
  }

  if (buffer.trim()) {
    segments.push(buffer.trim());
  }

  return segments.flatMap((segment) =>
    segment.length > MAX_CHUNK_SIZE
      ? splitByLength(segment, MAX_CHUNK_SIZE)
      : [segment],
  );
}

function splitByLength(text: string, maxLength: number): string[] {
  const parts: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + maxLength, text.length);
    parts.push(text.slice(offset, end).trim());
    offset = end;
  }

  return parts.filter(Boolean);
}

function getOverlapPrefix(content: string): string {
  return content.slice(-OVERLAP_SIZE).trim();
}

export function chunkDocument(input: ChunkInput): ChunkOutput[] {
  if (input.ast) {
    return chunkStructuredDocument(input.ast, input.ingestion_key ?? '');
  }

  const chunks: ChunkOutput[] = [];
  let chunkIndex = 0;

  for (const section of input.sections) {
    const paragraphs = splitByParagraphs(section.content);
    let buffer = '';

    for (const para of paragraphs) {
      if (
        buffer.length + para.length > MAX_CHUNK_SIZE &&
        buffer.length >= MIN_CHUNK_SIZE
      ) {
        const finalized = buffer.trim();
        chunks.push({
          content: finalized,
          section_title: section.title || null,
          page_number: section.page ?? null,
          chunk_index: chunkIndex++,
        });
        const overlap = getOverlapPrefix(finalized);
        buffer = overlap ? `${overlap}\n\n${para}` : para;
        continue;
      }
      buffer += (buffer ? '\n\n' : '') + para;
    }

    if (buffer.trim()) {
      if (buffer.length < MIN_CHUNK_SIZE && chunks.length > 0) {
        const last = chunks[chunks.length - 1];
        if (
          last.section_title === (section.title || null) &&
          last.content.length + buffer.length <= MAX_CHUNK_SIZE
        ) {
          last.content += '\n\n' + buffer.trim();
          continue;
        }
      }
      chunks.push({
        content: buffer.trim(),
        section_title: section.title || null,
        page_number: section.page ?? null,
        chunk_index: chunkIndex++,
      });
    }
  }

  if (chunks.length === 0 && input.content_text.trim()) {
    const text = input.content_text;
    let offset = 0;
    while (offset < text.length) {
      const end = Math.min(offset + MAX_CHUNK_SIZE, text.length);
      const content = text.slice(offset, end).trim();
      chunks.push({
        content,
        section_title: null,
        page_number: null,
        chunk_index: chunkIndex++,
      });
      offset =
        end >= text.length ? end : Math.max(end - OVERLAP_SIZE, offset + 1);
    }
  }

  return chunks;
}

interface SectionBlocks {
  heading: DocumentAstBlock | null;
  blocks: DocumentAstBlock[];
}

interface TokenSpan {
  start: number;
  end: number;
}

export function countStableTokens(text: string): number {
  return tokenizeStable(text).length;
}

function chunkStructuredDocument(
  ast: DocumentAst,
  ingestionKey: string,
): ChunkOutput[] {
  const sections = groupByHeading(ast.blocks);
  const outputs: ChunkOutput[] = [];
  let chunkIndex = 0;

  for (const [sectionPosition, section] of sections.entries()) {
    const headingPath =
      section.heading?.heading_path ?? section.blocks[0]?.heading_path ?? [];
    const sectionTitle =
      section.heading?.text ?? headingPath.at(-1) ?? 'Content';
    const parentContent = [
      section.heading?.text,
      ...section.blocks.map((b) => b.text),
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    if (!parentContent) continue;
    const parentKey = hashKey(
      ingestionKey,
      'parent',
      sectionPosition,
      headingPath.join('/'),
      parentContent,
    );
    const allBlocks = [
      ...(section.heading ? [section.heading] : []),
      ...section.blocks,
    ];
    outputs.push({
      content: parentContent,
      section_title: sectionTitle,
      page_number: firstPage(allBlocks),
      chunk_index: chunkIndex++,
      chunk_type: 'parent',
      parent_key: null,
      stable_key: parentKey,
      position: sectionPosition,
      token_count: countStableTokens(parentContent),
      tokenizer_version: TOKENIZER_VERSION,
      overlap_previous_tokens: 0,
      heading_path: [...headingPath],
      page_start: firstPage(allBlocks),
      page_end: lastPage(allBlocks),
      block_ids: allBlocks.map((block) => block.block_id),
      char_start:
        section.heading?.offsets.start ??
        section.blocks[0]?.offsets.start ??
        null,
      char_end:
        section.blocks.at(-1)?.offsets.end ??
        section.heading?.offsets.end ??
        null,
    });

    let childPosition = 0;
    for (const block of section.blocks) {
      const spans = splitIntoTokenSpans(
        block.text,
        MAX_CHILD_TOKENS,
        OVERLAP_TOKENS,
      );
      for (const [spanIndex, span] of spans.entries()) {
        const content = block.text.slice(span.start, span.end).trim();
        if (!content) continue;
        const leadingTrim = block.text
          .slice(span.start, span.end)
          .indexOf(content);
        const localStart = span.start + Math.max(leadingTrim, 0);
        const localEnd = localStart + content.length;
        const stableKey = hashKey(
          ingestionKey,
          'child',
          parentKey,
          childPosition,
          block.block_id,
          localStart,
          localEnd,
          content,
        );
        outputs.push({
          content,
          section_title: sectionTitle,
          page_number: block.page_start,
          chunk_index: chunkIndex++,
          chunk_type: 'child',
          parent_key: parentKey,
          stable_key: stableKey,
          position: childPosition++,
          token_count: countStableTokens(content),
          tokenizer_version: TOKENIZER_VERSION,
          overlap_previous_tokens:
            spanIndex === 0
              ? 0
              : Math.min(
                  OVERLAP_TOKENS,
                  countStableTokens(block.text.slice(span.start, span.end)),
                ),
          heading_path: [...block.heading_path],
          page_start: block.page_start,
          page_end: block.page_end,
          block_ids: [block.block_id],
          char_start: block.offsets.start + localStart,
          char_end: block.offsets.start + localEnd,
        });
      }
    }
  }

  return outputs;
}

function groupByHeading(blocks: DocumentAstBlock[]): SectionBlocks[] {
  const sections: SectionBlocks[] = [];
  let current: SectionBlocks = { heading: null, blocks: [] };

  for (const block of blocks) {
    if (block.type === 'heading') {
      if (current.heading || current.blocks.length > 0) sections.push(current);
      current = { heading: block, blocks: [] };
      continue;
    }
    current.blocks.push(block);
  }
  if (current.heading || current.blocks.length > 0) sections.push(current);
  return sections;
}

function tokenizeStable(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const tokenPattern =
    /[\p{Script=Han}]|[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length });
  }
  return spans;
}

function splitIntoTokenSpans(
  text: string,
  maxTokens: number,
  overlapTokens: number,
): TokenSpan[] {
  const tokens = tokenizeStable(text);
  if (tokens.length === 0) return [];
  if (tokens.length <= maxTokens) {
    return [{ start: 0, end: text.length }];
  }

  const spans: TokenSpan[] = [];
  let tokenStart = 0;
  while (tokenStart < tokens.length) {
    const tokenEnd = Math.min(tokenStart + maxTokens, tokens.length);
    spans.push({
      start: tokens[tokenStart]?.start ?? 0,
      end: tokens[tokenEnd - 1]?.end ?? text.length,
    });
    if (tokenEnd >= tokens.length) break;
    tokenStart = Math.max(tokenEnd - overlapTokens, tokenStart + 1);
  }
  return spans;
}

function firstPage(blocks: DocumentAstBlock[]): number | null {
  return blocks.find((block) => block.page_start !== null)?.page_start ?? null;
}

function lastPage(blocks: DocumentAstBlock[]): number | null {
  return (
    [...blocks].reverse().find((block) => block.page_end !== null)?.page_end ??
    null
  );
}

function hashKey(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}
