import * as fs from 'fs/promises';
import {
  finalizeDocumentAst,
  ParserBudgetGuard,
  sectionsFromAst,
  sha256,
  updateHeadingPath,
  type DraftAstBlock,
  type ParseContext,
  type ParseResult,
} from './document-ast.js';

const PARSER_VERSION = 'markdown-ast-2';

export async function parseMarkdown(
  filePath: string,
  context?: ParseContext,
): Promise<ParseResult> {
  const guard = new ParserBudgetGuard(context?.budget, context?.signal);
  const bytes =
    context?.source_bytes ??
    (await guard.run(() => fs.readFile(filePath, { signal: context?.signal })));
  guard.assertInputBytes(bytes.length);
  const text = bytes.toString('utf8');
  const lines = new MarkdownLineCursor(text);
  const blocks: DraftAstBlock[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];

  while (!lines.done) {
    guard.check();
    const index = lines.lineNumber;
    const line = lines.peek() ?? '';
    if (!line.trim()) {
      lines.advance();
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const start = index;
      const code = guard.createTextAccumulator({ reserve_block: true });
      let codeLines = 0;
      lines.advance();
      while (!lines.done && !/^```\s*$/.test(lines.peek() ?? '')) {
        code.append(`${codeLines > 0 ? '\n' : ''}${lines.peek() ?? ''}`);
        codeLines += 1;
        lines.advance();
      }
      if (!lines.done) lines.advance();
      guard.appendBlock(
        blocks,
        {
          structural_path: `line/${start}/code`,
          type: 'code',
          text: code.toString(),
          heading_path: headingStack.map((entry) => entry.title),
          metadata: { language: fence[1] ?? '' },
        },
        code,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const headingPath = updateHeadingPath(headingStack, level, title);
      guard.appendBlock(blocks, {
        structural_path: `line/${lines.lineNumber}/heading/${level}`,
        type: 'heading',
        text: title,
        heading_path: headingPath,
        metadata: { level },
      });
      lines.advance();
      continue;
    }

    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(lines.peek(1) ?? '')
    ) {
      const start = index;
      const table = guard.createTextAccumulator({ reserve_block: true });
      table.append(line);
      let rowCount = 1;
      lines.advance(2);
      while (!lines.done && /^\s*\|.*\|\s*$/.test(lines.peek() ?? '')) {
        table.append(`\n${lines.peek() ?? ''}`);
        rowCount += 1;
        lines.advance();
      }
      const columns = splitTableRow(line).length;
      guard.appendBlock(
        blocks,
        {
          structural_path: `line/${start}/table`,
          type: 'table',
          text: table.toString(),
          heading_path: headingStack.map((entry) => entry.title),
          metadata: { rows: rowCount, columns },
        },
        table,
      );
      continue;
    }

    const listItem = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      guard.appendBlock(blocks, {
        structural_path: `line/${lines.lineNumber}/list-item`,
        type: 'list_item',
        text: listItem[1].trim(),
        heading_path: headingStack.map((entry) => entry.title),
        metadata: { marker: line.trim().split(/\s+/, 1)[0] ?? '-' },
      });
      lines.advance();
      continue;
    }

    const paragraphStart = lines.lineNumber;
    const paragraph = guard.createTextAccumulator({ reserve_block: true });
    let paragraphLines = 0;
    while (
      !lines.done &&
      (lines.peek() ?? '').trim() &&
      !isMarkdownStructuralStart(lines)
    ) {
      paragraph.append(
        `${paragraphLines > 0 ? '\n' : ''}${lines.peek() ?? ''}`,
      );
      paragraphLines += 1;
      lines.advance();
    }
    if (paragraphLines === 0) {
      paragraph.append(line);
      lines.advance();
    }
    guard.appendBlock(
      blocks,
      {
        structural_path: `line/${paragraphStart}/paragraph`,
        type: 'paragraph',
        text: paragraph.toString(),
        heading_path: headingStack.map((entry) => entry.title),
      },
      paragraph,
    );
  }

  const finalized = finalizeDocumentAst({
    source_checksum: context?.source_checksum ?? sha256(text),
    parser_version: PARSER_VERSION,
    location: {
      kind: 'none',
      status: 'unavailable',
      reason: 'markdown_has_no_pagination',
    },
    blocks,
    budget_guard: guard,
  });
  const title =
    finalized.ast.blocks.find(
      (block) => block.type === 'heading' && block.metadata['level'] === 1,
    )?.text ?? '';

  return {
    title,
    content_text: finalized.content_text,
    page_count: null,
    sections: sectionsFromAst(finalized.ast),
    parser_version: PARSER_VERSION,
    ast: finalized.ast,
  };
}

function isMarkdownStructuralStart(lines: MarkdownLineCursor): boolean {
  const line = lines.peek() ?? '';
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) ||
    (/^\s*\|.*\|\s*$/.test(line) &&
      /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(lines.peek(1) ?? ''))
  );
}

function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

class MarkdownLineCursor {
  private offset = 0;
  lineNumber = 0;

  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.offset >= this.text.length;
  }

  peek(ahead = 0): string | undefined {
    let offset = this.offset;
    for (let index = 0; index <= ahead; index += 1) {
      if (offset >= this.text.length) return undefined;
      const newline = this.text.indexOf('\n', offset);
      if (index === ahead) {
        return newline < 0
          ? this.text.slice(offset)
          : this.text.slice(offset, newline);
      }
      offset = newline < 0 ? this.text.length : newline + 1;
    }
    return undefined;
  }

  advance(count = 1): void {
    for (let index = 0; index < count && !this.done; index += 1) {
      const newline = this.text.indexOf('\n', this.offset);
      this.offset = newline < 0 ? this.text.length : newline + 1;
      this.lineNumber += 1;
    }
  }
}
