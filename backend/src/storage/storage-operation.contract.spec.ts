import {
  canonicalStorageOperationV1,
  parseStorageUint64Decimal,
  storageOperationIdempotencyKeyV1,
} from './storage-operation.contract.js';
import { formatStorageKey, parseStorageKey } from './storage-key.js';

const ids = {
  actor: '11111111-1111-4111-8111-111111111111',
  intent: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  file: '44444444-4444-4444-8444-444444444444',
  object: '55555555-5555-4555-8555-555555555555',
  authorization: '66666666-6666-4666-8666-666666666666',
  epoch: '77777777-7777-4777-8777-777777777777',
};
const sha = 'a'.repeat(64);
const uppercaseUuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const key = `p/${ids.project}/f/${ids.file}/g/1/${sha}.blob`;
const promoteDigestV1 =
  'fbf2308047decef8d34d972b170c26f80a68f2296b68245b150579b2107f3347';
const promote = {
  operation_version: 'storage-operation.v1',
  kind: 'PROMOTE',
  actor_id: ids.actor,
  intent_id: ids.intent,
  project_id: ids.project,
  source_file_id: ids.file,
  object_id: ids.object,
  object_generation_decimal: '1',
  storage_key: key,
  quarantine_key: `${ids.intent}.upload`,
  expected_sha256: sha,
  expected_size_decimal: '42',
  authorization_kind: 'UPLOAD_COMMIT',
  authorization_id: ids.authorization,
  storage_epoch: ids.epoch,
} as const;

it('round-trips the exact protected storage key', () => {
  expect(formatStorageKey(parseStorageKey(key))).toBe(key);
});

it('accepts only canonical uint64 boundary values', () => {
  expect(parseStorageUint64Decimal('0')).toBe(0n);
  expect(parseStorageUint64Decimal('18446744073709551615')).toBe(
    18_446_744_073_709_551_615n,
  );
  expect(parseStorageUint64Decimal('1', { positive: true })).toBe(1n);
  expect(() => parseStorageUint64Decimal('0', { positive: true })).toThrow(
    'STORAGE_UINT64_INVALID',
  );
});

it.each(['01', '-1', '+1', '1.0', '18446744073709551616'])(
  'rejects a non-canonical uint64 %s',
  (value) => expect(() => parseStorageUint64Decimal(value)).toThrow(),
);

it.each([
  key.toUpperCase(),
  `/var/db/textweaver/storage/${key}`,
  `p/${ids.project}/f/${ids.file}/g/01/${sha}.blob`,
  `p/${ids.project}/f/${ids.file}/g/1/../${sha}.blob`,
  `p\\${ids.project}\\f\\${ids.file}\\g\\1\\${sha}.blob`,
  `${key}%2fescape`,
])('rejects an ambiguous storage key %s', (value) => {
  expect(() => parseStorageKey(value)).toThrow();
});

it.each([
  {
    project_id: uppercaseUuid,
    source_file_id: ids.file,
    generation_decimal: '1',
    checksum_sha256: sha,
  },
  {
    project_id: ids.project,
    source_file_id: uppercaseUuid,
    generation_decimal: '1',
    checksum_sha256: sha,
  },
  {
    project_id: ids.project,
    source_file_id: ids.file,
    generation_decimal: '0',
    checksum_sha256: sha,
  },
  {
    project_id: ids.project,
    source_file_id: ids.file,
    generation_decimal: '1',
    checksum_sha256: sha.toUpperCase(),
  },
])('rejects invalid formatted key parts %#', (parts) => {
  expect(() => formatStorageKey(parts)).toThrow('STORAGE_KEY_INVALID');
});

it('locks the storage-operation.v1 promote digest golden', () => {
  expect(storageOperationIdempotencyKeyV1(promote)).toBe(promoteDigestV1);
});

it.each([
  ['actor_id', { actor_id: '81111111-1111-4111-8111-111111111111' }],
  ['intent_id', { intent_id: '82222222-2222-4222-8222-222222222222' }],
  [
    'project_id',
    {
      project_id: '83333333-3333-4333-8333-333333333333',
      storage_key: `p/83333333-3333-4333-8333-333333333333/f/${ids.file}/g/1/${sha}.blob`,
    },
  ],
  [
    'source_file_id',
    {
      source_file_id: '84444444-4444-4444-8444-444444444444',
      storage_key: `p/${ids.project}/f/84444444-4444-4444-8444-444444444444/g/1/${sha}.blob`,
    },
  ],
  ['object_id', { object_id: '85555555-5555-4555-8555-555555555555' }],
  [
    'authorization_id',
    { authorization_id: '86666666-6666-4666-8666-666666666666' },
  ],
  ['storage_epoch', { storage_epoch: '87777777-7777-4777-8777-777777777777' }],
])('changes the digest when identity field %s changes', (_field, patch) => {
  expect(storageOperationIdempotencyKeyV1({ ...promote, ...patch })).not.toBe(
    promoteDigestV1,
  );
});

it('rebuilds reordered null-prototype input before hashing', () => {
  const reordered = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(promote).reverse()) {
    reordered[name] = value;
  }

  const canonical = canonicalStorageOperationV1(reordered);

  expect(canonical).toEqual(promote);
  expect(canonical).not.toBe(reordered);
  expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
  expect(Object.keys(canonical)).toEqual(Object.keys(promote));
  expect(storageOperationIdempotencyKeyV1(reordered)).toBe(promoteDigestV1);
  expect(storageOperationIdempotencyKeyV1(canonical)).toBe(promoteDigestV1);
});

it.each([
  {
    ...promote,
    kind: 'DELETE_QUARANTINE',
    authorization_kind: 'UPLOAD_COMMIT',
  },
  {
    ...promote,
    kind: 'DELETE_QUARANTINE',
    authorization_kind: 'MOVE_ABORT',
  },
  {
    ...promote,
    kind: 'DELETE_BLOB',
    quarantine_key: null,
    authorization_kind: 'SOURCE_FILE_TOMBSTONE',
  },
  {
    ...promote,
    kind: 'ABORT_PROMOTION',
    authorization_kind: 'MOVE_ABORT',
  },
])('accepts the exact operation shape matrix %#', (operation) => {
  expect(canonicalStorageOperationV1(operation)).toEqual(operation);
});

it.each([
  ['PROMOTE', 'UPLOAD_COMMIT'],
  ['DELETE_QUARANTINE', 'UPLOAD_COMMIT'],
  ['ABORT_PROMOTION', 'MOVE_ABORT'],
])(
  'rejects null quarantine for required-quarantine kind %s',
  (kind, authorizationKind) => {
    expect(() =>
      canonicalStorageOperationV1({
        ...promote,
        kind,
        quarantine_key: null,
        authorization_kind: authorizationKind,
      }),
    ).toThrow('STORAGE_OPERATION_INVALID');
  },
);

it('rejects non-null quarantine for DELETE_BLOB', () => {
  expect(() =>
    canonicalStorageOperationV1({
      ...promote,
      kind: 'DELETE_BLOB',
      quarantine_key: `${ids.intent}.upload`,
      authorization_kind: 'SOURCE_FILE_TOMBSTONE',
    }),
  ).toThrow('STORAGE_OPERATION_INVALID');
});

it.each([
  ['PROMOTE', 'MOVE_ABORT', `${ids.intent}.upload`],
  ['DELETE_QUARANTINE', 'SOURCE_FILE_TOMBSTONE', `${ids.intent}.upload`],
  ['DELETE_BLOB', 'UPLOAD_COMMIT', null],
  ['ABORT_PROMOTION', 'UPLOAD_COMMIT', `${ids.intent}.upload`],
])(
  'rejects wrong authorization %s + %s',
  (kind, authorizationKind, quarantineKey) => {
    expect(() =>
      canonicalStorageOperationV1({
        ...promote,
        kind,
        quarantine_key: quarantineKey,
        authorization_kind: authorizationKind,
      }),
    ).toThrow('STORAGE_OPERATION_INVALID');
  },
);

it.each([
  ['unknown key', { ...promote, delegated_authority: true }],
  [
    'missing key',
    Object.fromEntries(
      Object.entries(promote).filter(([name]) => name !== 'storage_epoch'),
    ),
  ],
  [
    'unknown version',
    { ...promote, operation_version: 'storage-operation.v2' },
  ],
  ['unknown kind', { ...promote, kind: 'COPY_BLOB' }],
])('rejects a non-closed operation with %s', (_label, operation) => {
  expect(() => canonicalStorageOperationV1(operation)).toThrow(
    'STORAGE_OPERATION_INVALID',
  );
});

it('rejects custom prototypes and class instances', () => {
  class StorageOperationInput {
    constructor() {
      Object.assign(this, promote);
    }
  }

  const customPrototype = Object.assign(
    Object.create({ delegated_authority: true }) as Record<string, unknown>,
    promote,
  );

  expect(() => canonicalStorageOperationV1(customPrototype)).toThrow(
    'STORAGE_OPERATION_INVALID',
  );
  expect(() =>
    canonicalStorageOperationV1(new StorageOperationInput()),
  ).toThrow('STORAGE_OPERATION_INVALID');
});

it('rejects an accessor without executing its getter', () => {
  let getterCalls = 0;
  const operation = { ...promote };
  Object.defineProperty(operation, 'actor_id', {
    enumerable: true,
    configurable: true,
    get: () => {
      getterCalls += 1;
      return ids.actor;
    },
  });

  expect(() => canonicalStorageOperationV1(operation)).toThrow(
    'STORAGE_OPERATION_INVALID',
  );
  expect(getterCalls).toBe(0);
});

it('rejects symbol keys', () => {
  const operation = { ...promote, [Symbol('delegated-authority')]: true };

  expect(() => canonicalStorageOperationV1(operation)).toThrow(
    'STORAGE_OPERATION_INVALID',
  );
});

it.each([
  'actor_id',
  'intent_id',
  'project_id',
  'source_file_id',
  'object_id',
  'authorization_id',
  'storage_epoch',
] as const)('rejects an invalid %s UUID', (field) => {
  expect(() =>
    canonicalStorageOperationV1({ ...promote, [field]: uppercaseUuid }),
  ).toThrow('STORAGE_OPERATION_INVALID');
});

it.each([
  ['zero object generation', { object_generation_decimal: '0' }],
  ['non-canonical object generation', { object_generation_decimal: '01' }],
  [
    'overflowing expected size',
    { expected_size_decimal: '18446744073709551616' },
  ],
  ['uppercase digest', { expected_sha256: sha.toUpperCase() }],
])('rejects %s', (_label, patch) => {
  expect(() => canonicalStorageOperationV1({ ...promote, ...patch })).toThrow(
    'STORAGE_OPERATION_INVALID',
  );
});

it.each([
  ['project', { project_id: ids.actor }],
  ['source file', { source_file_id: ids.actor }],
  ['generation', { object_generation_decimal: '2' }],
  ['checksum', { expected_sha256: 'b'.repeat(64) }],
])(
  'rejects a storage key whose %s authority does not match',
  (_label, patch) => {
    expect(() => canonicalStorageOperationV1({ ...promote, ...patch })).toThrow(
      'STORAGE_OPERATION_INVALID',
    );
  },
);
