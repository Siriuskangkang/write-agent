import {
  canonicalJsonV1,
  digestCanonicalV1,
} from '../citation/atomic-grounding/canonical-json.js';
import {
  parseStorageKey,
  parseStorageUint64DecimalValue,
  STORAGE_UINT64_MAX,
} from './storage-key.js';

export { STORAGE_UINT64_MAX };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPERATION_KEYS = [
  'operation_version',
  'kind',
  'actor_id',
  'intent_id',
  'project_id',
  'source_file_id',
  'object_id',
  'object_generation_decimal',
  'storage_key',
  'quarantine_key',
  'expected_sha256',
  'expected_size_decimal',
  'authorization_kind',
  'authorization_id',
  'storage_epoch',
] as const;

const SHAPES = {
  PROMOTE: { quarantine: 'required', authorization: ['UPLOAD_COMMIT'] },
  DELETE_QUARANTINE: {
    quarantine: 'required',
    authorization: ['UPLOAD_COMMIT', 'MOVE_ABORT'],
  },
  DELETE_BLOB: {
    quarantine: 'null',
    authorization: ['SOURCE_FILE_TOMBSTONE'],
  },
  ABORT_PROMOTION: {
    quarantine: 'required',
    authorization: ['MOVE_ABORT'],
  },
} as const;

type StorageOperationKind = keyof typeof SHAPES;
type StorageAuthorizationKind =
  (typeof SHAPES)[StorageOperationKind]['authorization'][number];

interface StorageOperationCommonPreimageV1 {
  operation_version: 'storage-operation.v1';
  actor_id: string;
  intent_id: string;
  project_id: string;
  source_file_id: string;
  object_id: string;
  object_generation_decimal: string;
  storage_key: string;
  expected_sha256: string;
  expected_size_decimal: string;
  authorization_id: string;
  storage_epoch: string;
}

export type StorageOperationPreimageV1 =
  | (StorageOperationCommonPreimageV1 & {
      kind: 'PROMOTE';
      quarantine_key: string;
      authorization_kind: 'UPLOAD_COMMIT';
    })
  | (StorageOperationCommonPreimageV1 & {
      kind: 'DELETE_QUARANTINE';
      quarantine_key: string;
      authorization_kind: 'UPLOAD_COMMIT' | 'MOVE_ABORT';
    })
  | (StorageOperationCommonPreimageV1 & {
      kind: 'DELETE_BLOB';
      quarantine_key: null;
      authorization_kind: 'SOURCE_FILE_TOMBSTONE';
    })
  | (StorageOperationCommonPreimageV1 & {
      kind: 'ABORT_PROMOTION';
      quarantine_key: string;
      authorization_kind: 'MOVE_ABORT';
    });

export function parseStorageUint64Decimal(
  value: string,
  options: { positive?: boolean } = {},
): bigint {
  return parseStorageUint64DecimalValue(value, options);
}

export function canonicalStorageOperationV1(
  value: unknown,
): StorageOperationPreimageV1 {
  try {
    const source = closedOperationRecord(value);
    const operationVersion = requiredString(source.operation_version);
    const kind = operationKind(source.kind);
    const actorId = uuid(source.actor_id);
    const intentId = uuid(source.intent_id);
    const projectId = uuid(source.project_id);
    const sourceFileId = uuid(source.source_file_id);
    const objectId = uuid(source.object_id);
    const objectGenerationDecimal = requiredString(
      source.object_generation_decimal,
    );
    parseStorageUint64Decimal(objectGenerationDecimal, { positive: true });
    const storageKey = requiredString(source.storage_key);
    const quarantineKey = source.quarantine_key;
    const expectedSha256 = sha256(source.expected_sha256);
    const expectedSizeDecimal = requiredString(source.expected_size_decimal);
    parseStorageUint64Decimal(expectedSizeDecimal);
    const authorizationKind = authorization(source.authorization_kind);
    const authorizationId = uuid(source.authorization_id);
    const storageEpoch = uuid(source.storage_epoch);

    if (operationVersion !== 'storage-operation.v1') {
      return invalidStorageOperation();
    }
    const keyParts = parseStorageKey(storageKey);
    if (
      keyParts.project_id !== projectId ||
      keyParts.source_file_id !== sourceFileId ||
      keyParts.generation_decimal !== objectGenerationDecimal ||
      keyParts.checksum_sha256 !== expectedSha256
    ) {
      return invalidStorageOperation();
    }
    const shape = SHAPES[kind];
    const allowedAuthorizations: readonly StorageAuthorizationKind[] =
      shape.authorization;
    if (
      !allowedAuthorizations.includes(authorizationKind) ||
      (shape.quarantine === 'required' && typeof quarantineKey !== 'string') ||
      (shape.quarantine === 'null' && quarantineKey !== null)
    ) {
      return invalidStorageOperation();
    }

    const operation = {
      operation_version: 'storage-operation.v1',
      kind,
      actor_id: actorId,
      intent_id: intentId,
      project_id: projectId,
      source_file_id: sourceFileId,
      object_id: objectId,
      object_generation_decimal: objectGenerationDecimal,
      storage_key: storageKey,
      quarantine_key: quarantineKey,
      expected_sha256: expectedSha256,
      expected_size_decimal: expectedSizeDecimal,
      authorization_kind: authorizationKind,
      authorization_id: authorizationId,
      storage_epoch: storageEpoch,
    } as StorageOperationPreimageV1;
    canonicalJsonV1(operation);
    return operation;
  } catch {
    return invalidStorageOperation();
  }
}

export function storageOperationIdempotencyKeyV1(value: unknown): string {
  return digestCanonicalV1(
    'storage-operation.v1',
    canonicalStorageOperationV1(value),
  );
}

function closedOperationRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidStorageOperation();
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidStorageOperation();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== OPERATION_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !OPERATION_KEYS.includes(key as (typeof OPERATION_KEYS)[number]),
    )
  ) {
    return invalidStorageOperation();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of OPERATION_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) {
      return invalidStorageOperation();
    }
    result[key] = descriptor.value;
  }
  return result;
}

function operationKind(value: unknown): StorageOperationKind {
  if (typeof value !== 'string' || !Object.hasOwn(SHAPES, value)) {
    return invalidStorageOperation();
  }
  return value as StorageOperationKind;
}

function authorization(value: unknown): StorageAuthorizationKind {
  if (
    value !== 'UPLOAD_COMMIT' &&
    value !== 'MOVE_ABORT' &&
    value !== 'SOURCE_FILE_TOMBSTONE'
  ) {
    return invalidStorageOperation();
  }
  return value;
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : invalidStorageOperation();
}

function uuid(value: unknown): string {
  return typeof value === 'string' && UUID.test(value)
    ? value
    : invalidStorageOperation();
}

function sha256(value: unknown): string {
  return typeof value === 'string' && SHA256.test(value)
    ? value
    : invalidStorageOperation();
}

function invalidStorageOperation(): never {
  throw new TypeError('STORAGE_OPERATION_INVALID');
}
