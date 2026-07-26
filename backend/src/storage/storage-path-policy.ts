import * as path from 'node:path';
import { parseStorageAuthorityConfig } from './storage.config.js';

export function assertStoragePathMayBeDeleted(
  filePath: string,
  source: Record<string, unknown> = process.env,
): void {
  const config = parseStorageAuthorityConfig(source);
  if (
    config.mode === 'broker' &&
    config.protectedRoot &&
    isDescendantOrEqual(config.protectedRoot, path.resolve(filePath))
  ) {
    throw new Error('STORAGE_PROTECTED_PATH_MUTATION_FORBIDDEN');
  }
}

export function isStorageProtectedPath(
  filePath: string,
  source: Record<string, unknown> = process.env,
): boolean {
  const config = parseStorageAuthorityConfig(source);
  return Boolean(
    config.mode === 'broker' &&
    config.protectedRoot &&
    isDescendantOrEqual(config.protectedRoot, path.resolve(filePath)),
  );
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
