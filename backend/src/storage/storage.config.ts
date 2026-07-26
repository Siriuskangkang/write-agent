import * as path from 'node:path';

export interface StorageAuthorityConfig {
  mode: 'legacy' | 'broker';
  protectedRoot: string | null;
  quarantineRoot: string | null;
}

export function parseStorageAuthorityConfig(
  source: Record<string, unknown>,
): StorageAuthorityConfig {
  if (source.STORAGE_AUTHORITY_MODE !== 'broker') {
    return {
      mode: 'legacy',
      protectedRoot: null,
      quarantineRoot: null,
    };
  }

  const protectedRoot = exactRoot(source.STORAGE_PROTECTED_ROOT);
  const quarantineRoot = exactRoot(source.STORAGE_QUARANTINE_ROOT);
  if (
    protectedRoot === null ||
    quarantineRoot === null ||
    protectedRoot === quarantineRoot
  ) {
    throw new Error('STORAGE_ROOTS_INVALID');
  }
  return { mode: 'broker', protectedRoot, quarantineRoot };
}

function exactRoot(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    (value !== path.parse(value).root && value.endsWith(path.sep)) ||
    path.normalize(value) !== value
  ) {
    return null;
  }
  return value;
}
