import { createHash } from 'node:crypto';
import { isWellFormedUnicodeScalarV1 } from './well-formed-unicode.js';

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializeCanonical(
  value: unknown,
  inArray: boolean,
  ancestors: Set<object>,
): string | undefined {
  if (value === undefined) {
    if (inArray) throw new TypeError('undefined is not allowed in arrays');
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'string') {
      if (!isWellFormedUnicodeScalarV1(value)) {
        throw new TypeError(
          'canonical JSON strings must be well-formed Unicode',
        );
      }
      return JSON.stringify(value.normalize('NFC'));
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(
        'canonical JSON numbers must be finite safe integers',
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('cyclic values are not canonical JSON');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = Array.from(value, (item, index) => {
        if (!(index in value)) {
          throw new TypeError('sparse arrays are not canonical JSON');
        }
        return serializeCanonical(item, true, ancestors) as string;
      });
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON requires ordinary objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('canonical JSON does not allow symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, string]> = [];
    const seenKeys = new Set<string>();
    for (const [rawKey, descriptor] of Object.entries(descriptors)) {
      if (!('value' in descriptor)) {
        throw new TypeError('canonical JSON does not allow accessors');
      }
      if (!isWellFormedUnicodeScalarV1(rawKey)) {
        throw new TypeError('canonical JSON keys must be well-formed Unicode');
      }
      const key = rawKey.normalize('NFC');
      if (seenKeys.has(key)) {
        throw new TypeError('object keys collide after NFC normalization');
      }
      seenKeys.add(key);
      const item = serializeCanonical(descriptor.value, false, ancestors);
      if (item !== undefined) entries.push([key, item]);
    }
    entries.sort(([left], [right]) => compareUtf16(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${item}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonV1(value: unknown): Buffer {
  const canonical = serializeCanonical(value, false, new Set());
  if (canonical === undefined) {
    throw new TypeError('root canonical JSON value cannot be undefined');
  }
  return Buffer.from(canonical, 'utf8');
}

export function digestCanonicalV1(versionTag: string, value: unknown): string {
  if (!isWellFormedUnicodeScalarV1(versionTag)) {
    throw new TypeError('digest version tag must be well-formed Unicode');
  }
  return createHash('sha256')
    .update(versionTag.normalize('NFC'), 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJsonV1(value))
    .digest('hex');
}
