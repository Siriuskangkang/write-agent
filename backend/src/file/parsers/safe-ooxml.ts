import type AdmZip from 'adm-zip';
import type { ParserBudgetGuard } from './document-ast.js';

const MAX_OOXML_ENTRY_SIZE = 16 * 1024 * 1024;
const MAX_OOXML_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_OOXML_ENTRIES = 10_000;

export function assertSafeOoxmlArchive(
  archive: AdmZip,
  guard?: ParserBudgetGuard,
): void {
  guard?.check();
  const entries = archive.getEntries();
  if (entries.length > MAX_OOXML_ENTRIES) {
    throw new Error('OOXML archive has too many entries');
  }
  let totalUncompressedSize = 0;
  for (const entry of entries) {
    guard?.check();
    const entrySize = entry.header.size;
    if (
      !Number.isSafeInteger(entrySize) ||
      entrySize < 0 ||
      entrySize > MAX_OOXML_ENTRY_SIZE
    ) {
      throw new Error('OOXML archive entry exceeds its size limit');
    }
    totalUncompressedSize += entrySize;
    if (totalUncompressedSize > MAX_OOXML_TOTAL_SIZE) {
      throw new Error('OOXML archive exceeds its uncompressed size limit');
    }
  }
}
