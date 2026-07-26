import { createHash } from 'node:crypto';

export const DOCUMENT_AST_VERSION = 'document-ast-v1';

export type AstBlockType =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table'
  | 'code'
  | 'quote';

export type AstMetadataValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[];

export interface AstOffsets {
  /**
   * Half-open offsets into ParseResult.content_text, counted as JavaScript
   * UTF-16 code units. `content_text.slice(start, end)` is always block.text.
   */
  start: number;
  end: number;
  unit: 'utf16_code_unit';
  source: 'content_text';
}

export interface DocumentAstBlock {
  block_id: string;
  type: AstBlockType;
  text: string;
  heading_path: string[];
  page_start: number | null;
  page_end: number | null;
  offsets: AstOffsets;
  metadata: Record<string, AstMetadataValue>;
}

export type AstLocation =
  | { kind: 'page' | 'slide'; status: 'exact' }
  | {
      kind: 'page' | 'slide' | 'none';
      status: 'degraded' | 'unavailable';
      reason: string;
    };

export interface DocumentAst {
  version: typeof DOCUMENT_AST_VERSION;
  location: AstLocation;
  blocks: DocumentAstBlock[];
}

export interface ParseContext {
  source_checksum: string;
  /** Immutable, checksum-verified source bytes supplied by the worker. */
  source_bytes?: Buffer;
  budget?: Partial<ParserBudget>;
  signal?: AbortSignal;
}

export interface ParserBudget {
  max_bytes: number;
  max_pages: number;
  max_slides: number;
  max_blocks: number;
  max_chars: number;
  max_tokens: number;
  max_time_ms: number;
}

export const DEFAULT_PARSER_BUDGET: Readonly<ParserBudget> = {
  max_bytes: 50 * 1024 * 1024,
  max_pages: 2_000,
  max_slides: 2_000,
  max_blocks: 100_000,
  max_chars: 20_000_000,
  max_tokens: 20_000_000,
  max_time_ms: 120_000,
};

export class ParserBudgetGuard {
  readonly budget: ParserBudget;
  private readonly startedAt = Date.now();
  private outputBlocks = 0;
  private outputChars = 0;
  private outputTokens = 0;
  private readonly committedBlocks = new WeakSet<DraftAstBlock>();
  private readonly reservedBlockTexts = new WeakSet<ParserTextAccumulator>();
  private incrementalOutputUsed = false;

  constructor(
    overrides: Partial<ParserBudget> | undefined,
    private readonly signal?: AbortSignal,
  ) {
    this.budget = { ...DEFAULT_PARSER_BUDGET, ...overrides };
    for (const [name, value] of Object.entries(this.budget)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid parser budget: ${name}`);
      }
    }
  }

  assertInputBytes(byteLength: number): void {
    this.check();
    if (byteLength > this.budget.max_bytes) this.exceeded('bytes');
  }

  assertPages(pageCount: number): void {
    this.check();
    if (pageCount > this.budget.max_pages) this.exceeded('pages');
  }

  assertSlides(slideCount: number): void {
    this.check();
    if (slideCount > this.budget.max_slides) this.exceeded('slides');
  }

  assertOutput(blocks: readonly DraftAstBlock[]): void {
    this.check();
    if (this.incrementalOutputUsed) {
      if (blocks.some((block) => !this.committedBlocks.has(block))) {
        throw new Error('Parser output bypassed the incremental budget guard');
      }
      return;
    }
    if (blocks.length > this.budget.max_blocks) this.exceeded('blocks');
    let chars = 0;
    let tokens = 0;
    for (const block of blocks) {
      this.check();
      chars += block.text.length;
      tokens += estimateConservativeTokens(block.text);
      if (chars > this.budget.max_chars) this.exceeded('chars');
      if (tokens > this.budget.max_tokens) this.exceeded('tokens');
    }
  }

  appendBlock<T extends DraftAstBlock>(
    blocks: T[],
    block: T,
    reservedText?: ParserTextAccumulator,
  ): void {
    this.check();
    this.incrementalOutputUsed = true;
    if (reservedText) {
      if (
        reservedText.owner !== this ||
        reservedText.toString() !== block.text
      ) {
        throw new Error('Parser text reservation does not match block text');
      }
      if (!this.reservedBlockTexts.delete(reservedText)) {
        this.reserveBlock();
      }
    } else {
      this.reserveBlockAndText(block.text);
    }
    this.committedBlocks.add(block);
    blocks.push(block);
  }

  createTextAccumulator(options?: {
    reserve_block?: boolean;
  }): ParserTextAccumulator {
    this.check();
    const accumulator = new ParserTextAccumulator(this);
    if (options?.reserve_block) {
      this.incrementalOutputUsed = true;
      this.reserveBlock();
      this.reservedBlockTexts.add(accumulator);
    }
    return accumulator;
  }

  reserveText(text: string): void {
    this.check();
    const nextChars = this.outputChars + text.length;
    const nextTokens = this.outputTokens + estimateConservativeTokens(text);
    if (nextChars > this.budget.max_chars) this.exceeded('chars');
    if (nextTokens > this.budget.max_tokens) this.exceeded('tokens');
    this.outputChars = nextChars;
    this.outputTokens = nextTokens;
  }

  check(): void {
    if (this.signal?.aborted) {
      throw this.signal.reason instanceof Error
        ? this.signal.reason
        : new Error('Document parsing aborted');
    }
    if (Date.now() - this.startedAt > this.budget.max_time_ms) {
      this.exceeded('time');
    }
  }

  remainingTimeMs(): number {
    this.check();
    return Math.max(1, this.budget.max_time_ms - (Date.now() - this.startedAt));
  }

  async run<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
    this.check();
    const pending = typeof operation === 'function' ? operation() : operation;
    const remaining = Math.max(
      1,
      this.budget.max_time_ms - (Date.now() - this.startedAt),
    );
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Parser budget exceeded: time')),
        remaining,
      );
      if (this.signal) {
        abortListener = () =>
          reject(
            this.signal?.reason instanceof Error
              ? this.signal.reason
              : new Error('Document parsing aborted'),
          );
        this.signal.addEventListener('abort', abortListener, { once: true });
      }
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) {
        this.signal?.removeEventListener('abort', abortListener);
      }
      this.check();
    }
  }

  private exceeded(name: string): never {
    throw new Error(`Parser budget exceeded: ${name}`);
  }

  private reserveBlock(): void {
    const nextBlocks = this.outputBlocks + 1;
    if (nextBlocks > this.budget.max_blocks) this.exceeded('blocks');
    this.outputBlocks = nextBlocks;
  }

  private reserveBlockAndText(text: string): void {
    this.check();
    const nextBlocks = this.outputBlocks + 1;
    const nextChars = this.outputChars + text.length;
    const nextTokens = this.outputTokens + estimateConservativeTokens(text);
    if (nextBlocks > this.budget.max_blocks) this.exceeded('blocks');
    if (nextChars > this.budget.max_chars) this.exceeded('chars');
    if (nextTokens > this.budget.max_tokens) this.exceeded('tokens');
    this.outputBlocks = nextBlocks;
    this.outputChars = nextChars;
    this.outputTokens = nextTokens;
  }
}

export class ParserTextAccumulator {
  private value = '';

  constructor(readonly owner: ParserBudgetGuard) {}

  append(fragment: string): void {
    this.owner.reserveText(fragment);
    this.value += fragment;
  }

  toString(): string {
    return this.value;
  }
}

export interface ParseResult {
  title: string;
  content_text: string;
  page_count: number | null;
  sections: Array<{ title: string; content: string; page?: number }>;
  parser_version: string;
  ast: DocumentAst;
}

export interface DraftAstBlock {
  structural_path: string;
  type: AstBlockType;
  text: string;
  heading_path: string[];
  page_start?: number | null;
  page_end?: number | null;
  metadata?: Record<string, AstMetadataValue>;
  /**
   * Preserve explicit OOXML `xml:space="preserve"` at block boundaries.
   * Other formats continue to use normalized block-boundary whitespace.
   */
  preserve_boundary_whitespace?: boolean;
}

export interface FinalizedAst {
  content_text: string;
  ast: DocumentAst;
}

export function finalizeDocumentAst(input: {
  source_checksum: string;
  parser_version: string;
  location: AstLocation;
  blocks: DraftAstBlock[];
  budget_guard?: ParserBudgetGuard;
}): FinalizedAst {
  assertChecksum(input.source_checksum);
  input.budget_guard?.assertOutput(input.blocks);
  const blocks: DocumentAstBlock[] = [];
  let contentText = '';

  for (const draft of input.blocks) {
    if (
      !Array.isArray(draft.heading_path) ||
      draft.heading_path.some(
        (part) => typeof part !== 'string' || part.trim().length === 0,
      )
    ) {
      throw new Error('Invalid document AST heading_path');
    }
    const text = normalizeBlockText(
      draft.text,
      draft.preserve_boundary_whitespace === true,
    );
    if (!text) continue;
    if (contentText) contentText += '\n\n';
    const start = contentText.length;
    contentText += text;
    const end = contentText.length;
    const identity = [
      input.source_checksum,
      input.parser_version,
      draft.structural_path,
      draft.type,
      start,
      end,
      sha256(text),
    ].join('\0');
    blocks.push({
      block_id: sha256(identity),
      type: draft.type,
      text,
      heading_path: compactHeadingPath(draft.heading_path),
      page_start: draft.page_start ?? null,
      page_end: draft.page_end ?? null,
      offsets: {
        start,
        end,
        unit: 'utf16_code_unit',
        source: 'content_text',
      },
      metadata: sanitizeMetadata(draft.metadata ?? {}),
    });
  }

  const finalized: FinalizedAst = {
    content_text: contentText,
    ast: {
      version: DOCUMENT_AST_VERSION,
      location: input.location,
      blocks,
    },
  };
  assertDocumentAst(finalized.ast, finalized.content_text);
  return finalized;
}

export function compactHeadingPath(path: readonly string[]): string[] {
  return path.filter(
    (part): part is string =>
      typeof part === 'string' && part.trim().length > 0,
  );
}

export function updateHeadingPath(
  stack: Array<{ level: number; title: string }>,
  level: number,
  title: string,
): string[] {
  while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
  stack.push({ level, title });
  return stack.map((entry) => entry.title);
}

export function assertDocumentAst(ast: DocumentAst, contentText: string): void {
  if (ast.version !== DOCUMENT_AST_VERSION) {
    throw new Error('Invalid document AST version');
  }
  if (!ast.location) throw new Error('Invalid document AST location');
  const runtimeLocation = ast.location as unknown as {
    kind?: unknown;
    status?: unknown;
    reason?: unknown;
  };
  if (
    typeof runtimeLocation.kind !== 'string' ||
    !['page', 'slide', 'none'].includes(runtimeLocation.kind) ||
    typeof runtimeLocation.status !== 'string' ||
    !['exact', 'degraded', 'unavailable'].includes(runtimeLocation.status) ||
    (runtimeLocation.status === 'exact' && runtimeLocation.kind === 'none')
  ) {
    throw new Error('Invalid document AST location');
  }
  if (
    runtimeLocation.status !== 'exact' &&
    (typeof runtimeLocation.reason !== 'string' ||
      !runtimeLocation.reason.trim())
  ) {
    throw new Error('Invalid document AST location reason');
  }

  let previousEnd = -1;
  const ids = new Set<string>();
  for (const [index, block] of ast.blocks.entries()) {
    if (!/^[a-f0-9]{64}$/.test(block.block_id) || ids.has(block.block_id)) {
      throw new Error(`Invalid document AST block_id at ${index}`);
    }
    ids.add(block.block_id);
    if (
      !['heading', 'paragraph', 'list_item', 'table', 'code', 'quote'].includes(
        block.type,
      ) ||
      typeof block.text !== 'string' ||
      block.text.length === 0
    ) {
      throw new Error(`Invalid document AST block at ${index}`);
    }
    if (
      !Array.isArray(block.heading_path) ||
      block.heading_path.some(
        (part) => typeof part !== 'string' || part.trim().length === 0,
      )
    ) {
      throw new Error(`Invalid document AST heading_path at ${index}`);
    }
    if (
      !Number.isSafeInteger(block.offsets.start) ||
      !Number.isSafeInteger(block.offsets.end) ||
      block.offsets.unit !== 'utf16_code_unit' ||
      block.offsets.source !== 'content_text' ||
      block.offsets.start < 0 ||
      block.offsets.end <= block.offsets.start ||
      block.offsets.end > contentText.length ||
      block.offsets.start <= previousEnd ||
      contentText.slice(block.offsets.start, block.offsets.end) !== block.text
    ) {
      throw new Error(`Invalid document AST offsets/order at ${index}`);
    }
    previousEnd = block.offsets.end;
    if (
      (block.page_start === null) !== (block.page_end === null) ||
      (block.page_start !== null &&
        (!Number.isSafeInteger(block.page_start) ||
          !Number.isSafeInteger(block.page_end) ||
          block.page_start < 1 ||
          (block.page_end ?? 0) < block.page_start)) ||
      (ast.location.kind === 'none' && block.page_start !== null)
    ) {
      throw new Error(`Invalid document AST location range at ${index}`);
    }
    if (
      typeof block.metadata !== 'object' ||
      block.metadata === null ||
      Array.isArray(block.metadata) ||
      Object.values(block.metadata).some((value) => !isMetadataValue(value))
    ) {
      throw new Error(`Invalid document AST metadata at ${index}`);
    }
  }
}

export function sectionsFromAst(ast: DocumentAst): ParseResult['sections'] {
  const sections: ParseResult['sections'] = [];
  let current: ParseResult['sections'][number] | undefined;

  for (const block of ast.blocks) {
    if (block.type === 'heading') {
      if (current?.content.trim()) sections.push(current);
      current = {
        title: block.text,
        content: '',
        ...(block.page_start === null ? {} : { page: block.page_start }),
      };
      continue;
    }
    if (!current) {
      current = {
        title: block.heading_path.at(-1) ?? 'Content',
        content: '',
        ...(block.page_start === null ? {} : { page: block.page_start }),
      };
    }
    current.content += `${current.content ? '\n\n' : ''}${block.text}`;
  }
  if (current?.content.trim()) sections.push(current);

  return sections.length > 0
    ? sections
    : ast.blocks.map((block) => ({
        title: block.heading_path.at(-1) ?? 'Content',
        content: block.text,
        ...(block.page_start === null ? {} : { page: block.page_start }),
      }));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertChecksum(checksum: string): void {
  if (!/^[a-f0-9]{64}$/i.test(checksum)) {
    throw new Error('source_checksum must be a SHA-256 digest');
  }
}

function normalizeBlockText(
  text: string,
  preserveBoundaryWhitespace: boolean,
): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return preserveBoundaryWhitespace ? normalized : normalized.trim();
}

function sanitizeMetadata(
  metadata: Record<string, AstMetadataValue>,
): Record<string, AstMetadataValue> {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.values(metadata).some((value) => !isMetadataValue(value))
  ) {
    throw new Error('Invalid document AST metadata');
  }
  return { ...metadata };
}

function estimateConservativeTokens(text: string): number {
  return Array.from(text).filter((character) => !/\s/u.test(character)).length;
}

function isMetadataValue(value: unknown): value is AstMetadataValue {
  if (value === null) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' || typeof item === 'number')
  );
}
