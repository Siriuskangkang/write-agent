import { createHash, timingSafeEqual } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { DEFAULT_PARSER_BUDGET } from './parsers/document-ast.js';

export interface VerifiedFileSnapshot {
  bytes: Buffer;
  checksum: string;
  size: number;
}

export interface VerifiedFileSnapshotOptions {
  expected_checksum: string | null;
  expected_size?: number | null;
  max_bytes?: number;
  signal?: AbortSignal;
}

type SnapshotHandle = Pick<FileHandle, 'read'> & {
  stat(options: { bigint: true }): Promise<{
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
    ino: bigint;
    isFile(): boolean;
  }>;
};

export async function readVerifiedFileSnapshot(
  filePath: string,
  options: VerifiedFileSnapshotOptions,
): Promise<VerifiedFileSnapshot> {
  const handle = await open(filePath, 'r');
  try {
    return await readVerifiedFileSnapshotFromHandle(handle, options);
  } finally {
    await handle.close();
  }
}

export async function readVerifiedFileSnapshotFromHandle(
  handle: SnapshotHandle,
  options: VerifiedFileSnapshotOptions,
): Promise<VerifiedFileSnapshot> {
  throwIfAborted(options.signal);
  const maxBytes = options.max_bytes ?? DEFAULT_PARSER_BUDGET.max_bytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Invalid parser budget: max_bytes');
  }

  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new Error('Source path is not a regular file');
  assertSizeWithinBudget(before.size, maxBytes);
  if (
    options.expected_size !== undefined &&
    options.expected_size !== null &&
    (!Number.isSafeInteger(options.expected_size) ||
      options.expected_size < 0 ||
      before.size !== BigInt(options.expected_size))
  ) {
    throw new Error('Source file size changed after upload');
  }

  const buffer = Buffer.allocUnsafeSlow(Number(before.size) + 1);
  let bytesReadTotal = 0;
  while (bytesReadTotal < buffer.length) {
    throwIfAborted(options.signal);
    const requested = buffer.length - bytesReadTotal;
    const result = await handle.read(
      buffer,
      bytesReadTotal,
      requested,
      bytesReadTotal,
    );
    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > requested
    ) {
      throw new Error('Source file snapshot returned an invalid read length');
    }
    if (result.bytesRead === 0) break;
    bytesReadTotal += result.bytesRead;
    if (bytesReadTotal > maxBytes) {
      throw new Error('Parser budget exceeded: bytes');
    }
  }
  const bytes = buffer.subarray(0, bytesReadTotal);
  throwIfAborted(options.signal);
  const after = await handle.stat({ bigint: true });
  assertSizeWithinBudget(after.size, maxBytes);
  if (
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.ino !== after.ino ||
    BigInt(bytes.length) !== after.size
  ) {
    throw new Error('Source file changed while parsing snapshot');
  }

  const checksum = createHash('sha256').update(bytes).digest('hex');
  if (
    options.expected_checksum &&
    !equalChecksum(checksum, options.expected_checksum)
  ) {
    throw new Error('Source file checksum changed after upload');
  }
  return { bytes, checksum, size: bytes.length };
}

function assertSizeWithinBudget(size: bigint, maxBytes: number): void {
  if (size < 0n || size > BigInt(maxBytes)) {
    throw new Error('Parser budget exceeded: bytes');
  }
}

function equalChecksum(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual.toLowerCase(), 'hex'),
    Buffer.from(expected.toLowerCase(), 'hex'),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Document parsing aborted');
}
