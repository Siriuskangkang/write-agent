import * as fs from 'fs/promises';
import { Stats } from 'fs';
import * as path from 'path';
import { isStorageProtectedPath } from '../storage/storage-path-policy.js';
import { parseStorageAuthorityConfig } from '../storage/storage.config.js';

export type UploadFileInspection =
  | { kind: 'regular' }
  | { kind: 'missing' }
  | { kind: 'unsafe'; reason: string };

export async function inspectUploadFileForUnlink(
  filePath: string,
): Promise<UploadFileInspection> {
  const uploadRoot = path.resolve(process.env.UPLOAD_DIR || './uploads');
  const candidate = path.resolve(filePath);

  if (isStorageProtectedPath(candidate)) {
    return {
      kind: 'unsafe',
      reason: 'path is managed by the storage broker',
    };
  }

  const storage = parseStorageAuthorityConfig(process.env);
  const quarantineRoot =
    storage.mode === 'broker' && storage.quarantineRoot
      ? storage.quarantineRoot
      : null;
  const permittedRoot = isStrictDescendant(uploadRoot, candidate)
    ? uploadRoot
    : quarantineRoot && isStrictDescendant(quarantineRoot, candidate)
      ? quarantineRoot
      : null;
  if (!permittedRoot) {
    return {
      kind: 'unsafe',
      reason: 'path is outside managed upload roots',
    };
  }

  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([
      fs.realpath(permittedRoot),
      fs.realpath(path.dirname(candidate)),
    ]);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  if (!isDescendantOrEqual(realRoot, realParent)) {
    return {
      kind: 'unsafe',
      reason: 'resolved parent is outside managed upload roots',
    };
  }

  let stat: Stats;
  try {
    stat = await fs.lstat(candidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return { kind: 'unsafe', reason: 'target is a symbolic link' };
  }
  if (!stat.isFile()) {
    return { kind: 'unsafe', reason: 'target is not a regular file' };
  }
  return { kind: 'regular' };
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isDescendantOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
