export const STORAGE_UINT64_MAX = 18_446_744_073_709_551_615n;

const UINT64_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_UINT64_DECIMAL = /^[1-9][0-9]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE_KEY = new RegExp(
  `^p/(${UUID.source.slice(1, -1)})/f/(${UUID.source.slice(
    1,
    -1,
  )})/g/([1-9][0-9]*)/([0-9a-f]{64})\\.blob$`,
);

export interface StorageKeyPartsV1 {
  project_id: string;
  source_file_id: string;
  generation_decimal: string;
  checksum_sha256: string;
}

export function parseStorageUint64DecimalValue(
  value: string,
  options: { positive?: boolean } = {},
): bigint {
  const grammar = options.positive ? POSITIVE_UINT64_DECIMAL : UINT64_DECIMAL;
  if (typeof value !== 'string' || !grammar.test(value)) {
    throw new TypeError('STORAGE_UINT64_INVALID');
  }
  const parsed = BigInt(value);
  if (parsed > STORAGE_UINT64_MAX) {
    throw new TypeError('STORAGE_UINT64_INVALID');
  }
  return parsed;
}

export function formatStorageKey(parts: StorageKeyPartsV1): string {
  try {
    if (!UUID.test(parts.project_id) || !UUID.test(parts.source_file_id)) {
      return invalidStorageKey();
    }
    parseStorageUint64DecimalValue(parts.generation_decimal, {
      positive: true,
    });
    if (!SHA256.test(parts.checksum_sha256)) {
      return invalidStorageKey();
    }
    return `p/${parts.project_id}/f/${parts.source_file_id}/g/${parts.generation_decimal}/${parts.checksum_sha256}.blob`;
  } catch {
    return invalidStorageKey();
  }
}

export function parseStorageKey(value: string): StorageKeyPartsV1 {
  if (typeof value !== 'string') return invalidStorageKey();
  const match = STORAGE_KEY.exec(value);
  if (!match) return invalidStorageKey();
  try {
    parseStorageUint64DecimalValue(match[3], { positive: true });
  } catch {
    return invalidStorageKey();
  }
  return {
    project_id: match[1],
    source_file_id: match[2],
    generation_decimal: match[3],
    checksum_sha256: match[4],
  };
}

function invalidStorageKey(): never {
  throw new TypeError('STORAGE_KEY_INVALID');
}
