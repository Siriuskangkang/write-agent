# Task 11.1 Storage Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move persistent source-file mutation behind a durable MySQL intent contract and a least-privilege storage broker, while preserving current API routes and keeping activation fail-closed.

**Architecture:** The NestJS API validates uploads into quarantine and requests immutable storage intents; it never mutates the protected storage root. A small Go broker claims fenced intents from MySQL and performs dirfd-relative filesystem operations before completing the intent transaction. Schema, binaries, and broker-aware application code ship dormant under `STORAGE_AUTHORITY_MODE=legacy`; production-style activation is a separate offline operator step gated on Task 11.2 procedure-only application DML.

**Tech Stack:** NestJS, TypeScript, TypeORM, MySQL 8.4, Jest, Go 1.26, PM2, Docker Compose

## Global Constraints

- Baseline is commit `d476aa2` on branch `codex/full-optimization`.
- Keep existing HTTP paths and successful response shapes compatible.
- Default `STORAGE_AUTHORITY_MODE=legacy`; unknown, empty, and case-variant values resolve to `legacy`.
- Broker contract is exactly `storage-broker.v1`; operation digest tag is exactly `storage-operation.v1`.
- Canonical unsigned 64-bit values use decimal strings matching `0|[1-9][0-9]*`, bounded by `18446744073709551615`, and are parsed with `BigInt`.
- Storage keys use exactly `p/<project-lowercase-uuid>/f/<file-lowercase-uuid>/g/<positive-decimal-generation>/<lowercase-sha256>.blob`.
- Persistent protected-root writes, renames, chmods, and deletes are broker-only when broker mode is active.
- Parser dispatch accepts only an `AVAILABLE` storage object in broker mode.
- Migrations install dormant schema and routines but do not insert `storage_control`, revoke a principal, create OS users, change ownership, or enroll an authoring project.
- Final activation is not executed until Task 11.2 replaces legacy direct business-table DML with procedure-only authority.
- Do not weaken Task 10B's unconditional positive `atomic:v1` rejection.
- Do not add the deterministic authoring graph, proposals, approvals, business-version commits, Task 12 UI, LangGraph, or autonomous agents in this plan.
- Do not rewrite Git history, push, deploy, or delete local operator backups.
- Each task follows RED → GREEN → REFACTOR and ends with an independent commit.
- Each task receives one specification review and one quality review; at most one bounded repair pass is allowed before escalating a concrete blocker.

---

## File Structure

### TypeScript storage module

- `backend/src/storage/storage-operation.contract.ts` — closed operation preimage union, canonical validation, and idempotency digest.
- `backend/src/storage/storage-key.ts` — exact storage-key formatter/parser.
- `backend/src/storage/storage.config.ts` — fail-closed environment parsing and root validation.
- `backend/src/storage/entities/storage-control.entity.ts` — active broker epoch read model.
- `backend/src/storage/entities/storage-object.entity.ts` — durable blob identity and state.
- `backend/src/storage/entities/storage-operation-intent.entity.ts` — fenced broker work item.
- `backend/src/storage/storage-request.service.ts` — application-side request-procedure adapter.
- `backend/src/storage/storage-readiness.service.ts` — active epoch/contract/root/runtime readiness.
- `backend/src/storage/storage.module.ts` — exports storage request and readiness services.

### Schema and application integration

- `backend/migrations/1713400000000-CreateStorageBrokerAuthority.ts` — dormant storage tables, same-row checks, additive FKs, and upload-outbox transition.
- `backend/migrations/1713410000000-CreateStorageBrokerRoutines.ts` — view, terminal trigger, definer routines, and dormant database roles.
- `backend/migrations/1713420000000-ReconcileStorageLifecycleAuthority.ts` — reconciles the source-file project FK when broker-aware project tombstoning ships.
- `backend/migrations/support/storage-schema-contract.ts` — exact normalized schema/routine/view/grant contract.
- `backend/migrations/support/application-schema-contract.ts` — registers the new tables and changed `source_files`/outbox signatures.
- `backend/src/file/file.service.ts` — quarantine-to-intent upload and tombstone-to-delete request in broker mode.
- `backend/src/file/file-upload-outbox.dispatcher.ts` — dispatches only `pending`, never storage-preparation states.
- `backend/src/file/parse.worker.ts` — requires an `AVAILABLE` object before reading a broker-mode file.
- `backend/src/project/project.service.ts` — removes protected-root unlink/rm behavior in broker mode.
- `backend/src/style-template/style-template.service.ts` — keeps template storage outside the protected source-blob root and refuses protected-root deletion.

### Broker and operations

- `storage-broker/go.mod` — isolated Go module.
- `storage-broker/internal/contract/contract.go` — MySQL claim/result types and closed values.
- `storage-broker/internal/fsstore/store.go` — root-dirfd-relative promote/delete operations.
- `storage-broker/internal/mysqlstore/store.go` — claim/complete procedure adapter.
- `storage-broker/cmd/write-agent-storage-broker/main.go` — polling process with signal-aware shutdown.
- `scripts/storage-authority-preflight.sh` — read-only schema, identity, mount, ownership, and queue checks.
- `scripts/storage-authority-activate.sh` — explicit offline activation with a Task 11.2 authority-floor assertion.
- `ecosystem.config.cjs` — broker process definition without HTTP ingress.
- `docker-compose.yml` — MySQL/Redis/Qdrant infrastructure only for activated mode; no protected rw application mount.
- `.env.example` and `backend/.env.example` — exact storage variables and safe defaults.

---

### Task 1: Canonical storage operation and key contracts

**Files:**
- Create: `backend/src/storage/storage-operation.contract.ts`
- Create: `backend/src/storage/storage-key.ts`
- Test: `backend/src/storage/storage-operation.contract.spec.ts`

**Interfaces:**
- Consumes: `canonicalJsonV1(value: unknown): Buffer` and `digestCanonicalV1(versionTag: string, value: unknown): string` from `backend/src/citation/atomic-grounding/canonical-json.ts`.
- Produces:
  - `parseStorageUint64Decimal(value: string, options?: { positive?: boolean }): bigint`
  - `formatStorageKey(input: StorageKeyPartsV1): string`
  - `parseStorageKey(value: string): StorageKeyPartsV1`
  - `canonicalStorageOperationV1(value: unknown): StorageOperationPreimageV1`
  - `storageOperationIdempotencyKeyV1(value: unknown): string`

- [ ] **Step 1: Write the failing contract tests**

```ts
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
const key = `p/${ids.project}/f/${ids.file}/g/1/${sha}.blob`;
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

it('canonicalizes and hashes a valid promote operation deterministically', () => {
  expect(canonicalStorageOperationV1(promote)).toEqual(promote);
  expect(storageOperationIdempotencyKeyV1(promote)).toMatch(/^[0-9a-f]{64}$/);
  expect(storageOperationIdempotencyKeyV1({ ...promote })).toBe(
    storageOperationIdempotencyKeyV1(promote),
  );
});

it('rejects a kind/authorization/quarantine shape mismatch', () => {
  expect(() =>
    canonicalStorageOperationV1({
      ...promote,
      kind: 'DELETE_BLOB',
      quarantine_key: `${ids.intent}.upload`,
      authorization_kind: 'UPLOAD_COMMIT',
    }),
  ).toThrow('STORAGE_OPERATION_INVALID');
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd backend && npx jest src/storage/storage-operation.contract.spec.ts --runInBand --no-coverage`

Expected: FAIL because the two storage contract modules do not exist.

- [ ] **Step 3: Implement the exact closed types and validators**

```ts
export const STORAGE_UINT64_MAX = 18_446_744_073_709_551_615n;
const UINT64_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_UINT64_DECIMAL = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function parseStorageUint64Decimal(
  value: string,
  options: { positive?: boolean } = {},
): bigint {
  const grammar = options.positive ? POSITIVE_UINT64_DECIMAL : UINT64_DECIMAL;
  if (!grammar.test(value)) throw new TypeError('STORAGE_UINT64_INVALID');
  const parsed = BigInt(value);
  if (parsed > STORAGE_UINT64_MAX) {
    throw new TypeError('STORAGE_UINT64_INVALID');
  }
  return parsed;
}

export interface StorageKeyPartsV1 {
  project_id: string;
  source_file_id: string;
  generation_decimal: string;
  checksum_sha256: string;
}

export function formatStorageKey(parts: StorageKeyPartsV1): string {
  if (!UUID.test(parts.project_id) || !UUID.test(parts.source_file_id)) {
    throw new TypeError('STORAGE_KEY_INVALID');
  }
  parseStorageUint64Decimal(parts.generation_decimal, { positive: true });
  if (!SHA256.test(parts.checksum_sha256)) {
    throw new TypeError('STORAGE_KEY_INVALID');
  }
  return `p/${parts.project_id}/f/${parts.source_file_id}/g/${parts.generation_decimal}/${parts.checksum_sha256}.blob`;
}
```

Define the operation union without optional authority fields:

```ts
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
```

`canonicalStorageOperationV1()` must reconstruct a null-prototype-free plain object in the interface field order shown in the approved specification, reject unknown/missing keys, validate every UUID/digest/decimal/key, require the key parts to equal `project_id`, `source_file_id`, `object_generation_decimal`, and `expected_sha256`, then enforce this exact shape matrix:

```ts
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

export function storageOperationIdempotencyKeyV1(value: unknown): string {
  return digestCanonicalV1(
    'storage-operation.v1',
    canonicalStorageOperationV1(value),
  );
}
```

- [ ] **Step 4: Run focused tests and static checks**

Run:

```bash
cd backend
npx jest src/storage/storage-operation.contract.spec.ts --runInBand --no-coverage
npx eslint src/storage/storage-operation.contract.ts src/storage/storage-key.ts src/storage/storage-operation.contract.spec.ts
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage
git commit -m "feat: define storage operation contracts"
```

---

### Task 2: Dormant storage schema and TypeORM read models

**Files:**
- Create: `backend/migrations/1713400000000-CreateStorageBrokerAuthority.ts`
- Create: `backend/migrations/support/storage-schema-contract.ts`
- Create: `backend/src/storage/entities/storage-control.entity.ts`
- Create: `backend/src/storage/entities/storage-object.entity.ts`
- Create: `backend/src/storage/entities/storage-operation-intent.entity.ts`
- Modify: `backend/migrations/support/application-schema-contract.ts`
- Modify: `backend/src/file/entities/source-file.entity.ts`
- Modify: `backend/src/file/entities/file-upload-outbox.entity.ts`
- Test: `backend/src/storage/storage-schema.mysql.spec.ts`

**Interfaces:**
- Consumes: closed values and decimal-string boundary from Task 1.
- Produces:
  - tables `storage_control`, `storage_objects`, `storage_operation_intents`
  - nullable `file_upload_outbox.storage_intent_id`
  - tombstone columns `source_files.deleted_at`, `source_files.deleted_by`
  - `findStorageSchemaContractViolations(queryRunner: QueryRunner): Promise<string[]>`

- [ ] **Step 1: Write opt-in MySQL schema tests**

```ts
const enabled = process.env.STORAGE_MYSQL_TEST === '1';
(enabled ? describe : describe.skip)('storage authority schema', () => {
  it('installs dormant tables without activating an epoch', async () => {
    const rows = await dataSource.query(
      'SELECT COUNT(*) AS count FROM storage_control',
    );
    expect(String(rows[0].count)).toBe('0');
  });

  it('accepts all same-row checks and rejects an invalid promote shape', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO storage_operation_intents
          (id,idempotency_key,kind,project_id,object_id,object_generation,
           storage_key,quarantine_key,expected_sha256,expected_size,
           authorization_kind,authorization_id,storage_epoch,status)
         VALUES (UUID(), ?, 'PROMOTE', ?, ?, 1, ?, NULL, ?, 42,
                 'SOURCE_FILE_TOMBSTONE', ?, ?, 'PENDING')`,
        [digest, projectId, objectId, storageKey, sha, authId, epoch],
      ),
    ).rejects.toThrow();
  });

  it('requires the outbox intent exactly in storage_pending', async () => {
    await expect(
      dataSource.query(
        `UPDATE file_upload_outbox
            SET status='storage_pending', storage_intent_id=NULL
          WHERE id=?`,
        [outboxId],
      ),
    ).rejects.toThrow();
  });

  it('reports no normalized schema-contract violations', async () => {
    expect(await findStorageSchemaContractViolations(queryRunner)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the MySQL test and confirm RED**

Run:

```bash
cd backend
STORAGE_MYSQL_TEST=1 npm test -- src/storage/storage-schema.mysql.spec.ts --runInBand --no-coverage
```

Expected: FAIL because the migration and storage tables are absent.

- [ ] **Step 3: Implement the migration as additive and dormant**

The migration must create the three approved tables with InnoDB, `utf8mb4_0900_ai_ci`, ASCII binary columns where specified, all seven named checks, all six named unique/claim indexes, all five RESTRICT FKs, and terminal-row trigger. It must also:

```sql
ALTER TABLE source_files
  ADD COLUMN deleted_at DATETIME(6) NULL AFTER error_message,
  ADD COLUMN deleted_by VARCHAR(36) NULL AFTER deleted_at,
  ADD CONSTRAINT chk_source_files_tombstone
    CHECK ((deleted_at IS NULL AND deleted_by IS NULL)
        OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)),
  ADD UNIQUE INDEX uq_source_files_project_id(project_id,id),
  ADD INDEX idx_source_files_project_deleted(project_id,deleted_at,id),
  ADD CONSTRAINT source_files_deleted_by_fkey
    FOREIGN KEY (deleted_by) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE file_upload_outbox
  ADD COLUMN storage_intent_id VARCHAR(36) NULL AFTER parse_generation,
  MODIFY status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD CONSTRAINT chk_file_upload_outbox_storage_intent CHECK (
    (status='storage_preparing' AND storage_intent_id IS NULL)
    OR (status='storage_pending' AND storage_intent_id IS NOT NULL)
    OR (status IN ('pending','published') AND storage_intent_id IS NULL)
  ),
  ADD INDEX idx_file_upload_outbox_storage_intent(storage_intent_id),
  ADD CONSTRAINT file_upload_outbox_storage_intent_fkey
    FOREIGN KEY (storage_intent_id)
    REFERENCES storage_operation_intents(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
```

This additive migration deliberately leaves the existing
`source_files_project_id_fkey` behavior unchanged so project deletion remains
compatible until Task 5 ships its broker-aware tombstone transaction.
`down()` must throw `STORAGE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN`. It must
never run an `INSERT INTO storage_control`.

- [ ] **Step 4: Implement exact TypeORM read models and schema contract**

Entity values are closed unions:

```ts
export type StorageObjectState =
  | 'STAGING'
  | 'AVAILABLE'
  | 'DELETE_PENDING'
  | 'DELETED';
export type StorageIntentKind =
  | 'PROMOTE'
  | 'DELETE_QUARANTINE'
  | 'DELETE_BLOB'
  | 'ABORT_PROMOTION';
export type StorageIntentStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'RETRY'
  | 'SUCCEEDED'
  | 'REJECTED';
```

All SQL BIGINT fields use TypeORM `type: 'bigint'` and TypeScript `string`. Register exact column/index/FK/check signatures in `storage-schema-contract.ts` and add the three tables plus modified existing signatures to `application-schema-contract.ts`.

- [ ] **Step 5: Verify fresh migration and compatibility**

Run:

```bash
cd backend
STORAGE_MYSQL_TEST=1 npm test -- src/storage/storage-schema.mysql.spec.ts --runInBand --no-coverage
npm test -- src/file/file-upload.mysql.spec.ts --runInBand --no-coverage
npm run build
npm run lint:check
```

Expected: all commands exit 0 and `storage_control` remains empty.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations backend/src/storage backend/src/file/entities
git commit -m "feat: add dormant storage authority schema"
```

---

### Task 3: Stored request, claim, and completion authority

**Files:**
- Create: `backend/migrations/1713410000000-CreateStorageBrokerRoutines.ts`
- Modify: `backend/migrations/support/storage-schema-contract.ts`
- Create: `backend/src/storage/storage-request.service.ts`
- Create: `backend/src/storage/storage-readiness.service.ts`
- Create: `backend/src/storage/storage.config.ts`
- Create: `backend/src/storage/storage.module.ts`
- Test: `backend/src/storage/storage-authority.mysql.spec.ts`
- Test: `backend/src/storage/storage.config.spec.ts`

**Interfaces:**
- Consumes: `StorageOperationPreimageV1`, `storageOperationIdempotencyKeyV1()`, and Task 2 tables.
- Produces:
  - `StorageRequestService.request(queryRunner, operation): Promise<StorageRequestResultV1>`
  - `StorageReadinessService.assertReady(): Promise<StorageAuthoritySnapshotV1>`
  - six exact definer routines and `v_storage_intent_execution_v1`

- [ ] **Step 1: Write failing configuration and authority tests**

```ts
it.each([undefined, '', 'BROKER', ' broker '])(
  'resolves %p to legacy',
  (value) =>
    expect(parseStorageAuthorityConfig({ STORAGE_AUTHORITY_MODE: value }))
      .toMatchObject({ mode: 'legacy' }),
);

it('requires absolute normalized distinct roots in broker mode', () => {
  expect(() =>
    parseStorageAuthorityConfig({
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: 'uploads',
      STORAGE_QUARANTINE_ROOT: 'uploads',
    }),
  ).toThrow('STORAGE_ROOTS_INVALID');
});

it('replays the same request and rejects same-key different payload', async () => {
  const first = await requestPromote(operation);
  expect(await requestPromote(operation)).toEqual(first);
  await expect(
    requestPromote({ ...operation, expected_size_decimal: '43' }),
  ).rejects.toThrow('STORAGE_IDEMPOTENCY_MISMATCH');
});

it('loses a stale completion fence without changing object state', async () => {
  const claim = await claim(instanceId, 30, epoch);
  await expect(
    complete({ ...claim, execution_fence_decimal: '0' }),
  ).rejects.toThrow('STORAGE_FENCE_LOST');
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cd backend
npx jest src/storage/storage.config.spec.ts --runInBand --no-coverage
STORAGE_MYSQL_TEST=1 npx jest src/storage/storage-authority.mysql.spec.ts --runInBand --no-coverage
```

Expected: FAIL because parser, routines, view, and services are absent.

- [ ] **Step 3: Add the exact routines, view, and grants contract**

Implement the six signatures from the approved specification:

```text
sp_storage_request_promote_v1
sp_storage_request_delete_quarantine_v1
sp_storage_request_delete_blob_v1
sp_storage_request_abort_promotion_v1
sp_storage_claim_v1
sp_storage_complete_v1
```

Request routines lock storage control → project → source file → object → intent, verify actor ownership/tombstone/generation/epoch, and return:

```text
intent_id,status,execution_fence,result_code
```

Claim validates a 5–300 second lease, uses `FOR UPDATE SKIP LOCKED`, increments `execution_fence`, assigns a lowercase UUID lease token, commits before I/O, and returns the exact `v_storage_intent_execution_v1` column order from the specification. Complete locks in the same control → project → source file → object → intent order and returns:

```text
intent_id,status,object_state,outbox_status,execution_fence,result_code
```

`PROMOTE/SUCCEEDED` must atomically perform:

```sql
UPDATE storage_objects
   SET state='AVAILABLE'
 WHERE id=? AND state='STAGING';

UPDATE file_upload_outbox
   SET status='pending',
       storage_intent_id=NULL,
       lease_owner=NULL,
       lease_expires_at=NULL,
       last_error=NULL,
       next_attempt_at=CURRENT_TIMESTAMP(6)
 WHERE file_id=? AND project_id=? AND parse_generation=?
   AND storage_intent_id=? AND status='storage_pending';
```

Exactly one row must change in each statement or the transaction rolls back. Store normalized `SHOW CREATE PROCEDURE`, `SHOW CREATE VIEW`, and `SHOW GRANTS` golden strings; readiness rejects any difference.

- [ ] **Step 4: Implement NestJS config, request adapter, and readiness**

```ts
export interface StorageAuthorityConfig {
  mode: 'legacy' | 'broker';
  protectedRoot: string | null;
  quarantineRoot: string | null;
}

export interface StorageRequestResultV1 {
  intent_id: string;
  status: StorageIntentStatus;
  execution_fence_decimal: string;
  result_code: string | null;
}

export interface StorageAuthoritySnapshotV1 {
  storage_epoch: string;
  storage_contract_version: 'storage-broker.v1';
}
```

`StorageRequestService.request()` chooses the exact stored routine from `kind`, passes only validated canonical values, and requires the returned intent ID to match the request. `assertReady()` requires one control row, exact contract, broker config, absolute distinct roots, and schema-contract success; otherwise it throws `STORAGE_AUTHORITY_UNPROVEN`.

- [ ] **Step 5: Run authority, build, and legacy regression tests**

Run:

```bash
cd backend
npx jest src/storage/storage.config.spec.ts --runInBand --no-coverage
STORAGE_MYSQL_TEST=1 npx jest src/storage/storage-authority.mysql.spec.ts --runInBand --no-coverage
npm test -- src/file/file-upload.spec.ts --runInBand --no-coverage
npm run build
npm run lint:check
```

Expected: all commands exit 0; legacy mode does not query `storage_control`.

- [ ] **Step 6: Commit**

```bash
git add backend/migrations backend/src/storage
git commit -m "feat: add fenced storage authority routines"
```

---

### Task 4: Secure Go filesystem broker

**Files:**
- Create: `storage-broker/go.mod`
- Create: `storage-broker/internal/contract/contract.go`
- Create: `storage-broker/internal/fsstore/store.go`
- Create: `storage-broker/internal/fsstore/store_test.go`
- Create: `storage-broker/internal/mysqlstore/store.go`
- Create: `storage-broker/internal/mysqlstore/store_test.go`
- Create: `storage-broker/cmd/write-agent-storage-broker/main.go`

**Interfaces:**
- Consumes: Task 3 view and claim/complete routines.
- Produces:
  - `fsstore.New(protectedRoot, quarantineRoot string) (*Store, error)`
  - `(*Store).Execute(ctx context.Context, intent contract.Intent) contract.Outcome`
  - `mysqlstore.Claim(ctx, instanceID, leaseSeconds, epoch)`
  - `mysqlstore.Complete(ctx, claim, outcome, epoch)`

- [ ] **Step 1: Write failing filesystem safety tests**

```go
func TestPromoteVerifiesHashSizeAndCreatesReadOnlyBlob(t *testing.T) {
    roots := newRoots(t)
    intent := validPromoteIntent(roots)
    writeQuarantine(t, roots, intent.QuarantineKey, []byte("教材素材"))
    result := roots.Store.Execute(context.Background(), intent)
    if result.Code != "STORAGE_PROMOTED" { t.Fatalf("%+v", result) }
    assertMode(t, roots.FinalPath(intent), 0o440)
    assertContent(t, roots.FinalPath(intent), "教材素材")
}

func TestRejectsSymlinkTraversalAndCollision(t *testing.T) {
    roots := newRoots(t)
    intent := validPromoteIntent(roots)
    makeProjectSegmentSymlink(t, roots, intent)
    result := roots.Store.Execute(context.Background(), intent)
    if result.Code != "STORAGE_PATH_UNSAFE" { t.Fatalf("%+v", result) }
}

func TestDeleteENOENTIsIdempotentSuccess(t *testing.T) {
    roots := newRoots(t)
    result := roots.Store.Execute(context.Background(), validDeleteIntent(roots))
    if result.Code != "STORAGE_ALREADY_ABSENT" { t.Fatalf("%+v", result) }
}
```

- [ ] **Step 2: Run Go tests and confirm RED**

Run: `cd storage-broker && go test ./...`

Expected: FAIL because the Go module and packages are absent.

- [ ] **Step 3: Implement closed contract and dirfd-relative operations**

Use `golang.org/x/sys/unix` and:

```go
type Intent struct {
    IntentID             string
    Kind                 Kind
    ProjectID            string
    SourceFileID         string
    ObjectID             string
    ObjectGeneration     uint64
    StorageKey           string
    QuarantineKey        *string
    ExpectedSHA256       [32]byte
    ExpectedSize         uint64
    StorageEpoch         string
    ExecutionFence       uint64
    LeaseToken           string
}

type Outcome struct {
    State          string
    ObservedSHA256 string
    ObservedSize   uint64
    Code           string
    SanitizedError string
}
```

Open roots once as directory FDs; walk every key segment with `Openat(..., O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC, 0)`. Promotion copies quarantine bytes to `.staging/<intent UUID>` using exclusive create, hashes while copying, `Fsync()`s the file, verifies exact hash/size, chmods `0440`, atomically renames within the final parent, fsyncs the final parent, and removes quarantine only after the final object is proven. Deletion uses `Unlinkat()` against a validated parent dirfd. Reject symlinks, non-regular files, hardlink count other than one, unknown kinds, key/identity mismatch, and final collisions.

- [ ] **Step 4: Implement procedure adapter and bounded poll loop**

```go
type AuthorityStore interface {
    Claim(context.Context, string, uint32, string) (*contract.Intent, error)
    Complete(context.Context, contract.Intent, contract.Outcome, string) error
}

for {
    claim, err := authority.Claim(ctx, instanceID, leaseSeconds, epoch)
    if errors.Is(err, mysqlstore.ErrNoWork) {
        if !waitOrDone(ctx, pollInterval) { return nil }
        continue
    }
    if err != nil { return err }
    outcome := files.Execute(ctx, *claim)
    if err := authority.Complete(ctx, *claim, outcome, epoch); err != nil {
        logCompletionFailure(claim.IntentID, err)
    }
}
```

Logs contain intent ID/result code only; never log database credentials, quarantine filenames, content bytes, or raw SQL errors.

- [ ] **Step 5: Run race, unit, and vet checks**

Run:

```bash
cd storage-broker
go test -race ./...
go vet ./...
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add storage-broker
git commit -m "feat: add secure storage broker"
```

---

### Task 5: Broker-aware upload, parse, and deletion lifecycle

**Files:**
- Create: `backend/migrations/1713420000000-ReconcileStorageLifecycleAuthority.ts`
- Modify: `backend/src/file/file.service.ts`
- Modify: `backend/src/file/file-upload-outbox.dispatcher.ts`
- Modify: `backend/src/file/parse.worker.ts`
- Modify: `backend/src/file/file.module.ts`
- Modify: `backend/src/project/project.service.ts`
- Modify: `backend/src/style-template/style-template.service.ts`
- Test: `backend/src/file/file-storage-authority.spec.ts`
- Test: `backend/src/file/file-storage-authority.mysql.spec.ts`
- Test: `backend/src/project/project-storage-authority.spec.ts`

**Interfaces:**
- Consumes: `StorageRequestService`, `StorageReadinessService`, Task 2 entities, Task 3 procedures.
- Produces: broker-mode transitions `storage_preparing → storage_pending → pending → published` and tombstone-driven delete intents.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it('creates broker-mode source/outbox/intent without renaming a file', async () => {
  await service.uploadFiles(projectId, userId, [upload]);
  expect(fs.rename).not.toHaveBeenCalled();
  expect(savedOutbox.status).toBe('storage_pending');
  expect(savedOutbox.storage_intent_id).toBe(intentId);
});

it.each(['storage_preparing', 'storage_pending'])(
  'does not dispatch an outbox in %s',
  async (status) => {
    seedOutbox({ status });
    await dispatcher.dispatchBatch();
    expect(queue.add).not.toHaveBeenCalled();
  },
);

it('refuses parsing when the broker object is not AVAILABLE', async () => {
  seedObject({ state: 'STAGING' });
  await expect(worker.handle(job)).rejects.toThrow(
    'STORAGE_OBJECT_NOT_AVAILABLE',
  );
});

it('tombstones a single file and requests DELETE_BLOB without unlink', async () => {
  await service.deleteFile(projectId, fileId, userId);
  expect(fs.unlink).not.toHaveBeenCalled();
  expect(storageRequest.request).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      kind: 'DELETE_BLOB',
      authorization_kind: 'SOURCE_FILE_TOMBSTONE',
    }),
  );
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
cd backend
npx jest src/file/file-storage-authority.spec.ts src/project/project-storage-authority.spec.ts --runInBand --no-coverage
STORAGE_MYSQL_TEST=1 npx jest src/file/file-storage-authority.mysql.spec.ts --runInBand --no-coverage
```

Expected: FAIL because broker-mode lifecycle is not wired.

- [ ] **Step 3: Add broker-mode upload transaction**

In broker mode, compute checksum and size from quarantine, generate file/object/intent IDs and the canonical key, then use one query runner transaction:

```ts
await queryRunner.startTransaction();
try {
  await materialMutation.createSourceFileAndOutbox(queryRunner, {
    sourceFile,
    outbox: { ...outbox, status: 'storage_preparing' },
  });
  const result = await storageRequest.request(queryRunner, promoteOperation);
  if (result.intent_id !== intentId) {
    throw new Error('STORAGE_INTENT_ID_MISMATCH');
  }
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}
```

The API never creates the protected project directory and never moves the upload. If the DB result is uncertain, it replays the same idempotency key. A rejected transaction requests or records quarantine cleanup without touching the protected root.

- [ ] **Step 4: Reconcile the project/source-file deletion authority**

The forward migration first proves every source file has a live parent project,
then replaces `source_files_project_id_fkey` with:

```sql
ALTER TABLE source_files
  DROP FOREIGN KEY source_files_project_id_fkey,
  ADD CONSTRAINT source_files_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
```

It refuses to run if a broker-active database is paired with a binary that
does not expose the broker-aware project tombstone contract. Its `down()`
throws `STORAGE_LIFECYCLE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN`.

- [ ] **Step 5: Gate dispatch, parse, and deletes**

The outbox claim SQL remains restricted to `status='pending'`. Parser broker mode joins:

```sql
SELECT so.storage_key, so.checksum_sha256, so.byte_size, so.state
  FROM storage_objects so
 WHERE so.source_file_id=?
   AND so.generation=?
   AND so.state='AVAILABLE'
```

It verifies the selected object matches the source file checksum, size, generation, and canonical storage key before opening `source_files.file_path` read-only. File deletion sets `deleted_at/deleted_by`, clears active ingestion, and requests `DELETE_BLOB` in one transaction. Project deletion tombstones the project and leaves blobs retained. Protected-root paths are refused by every legacy cleanup/move/template delete helper while broker mode is active.

- [ ] **Step 6: Run regression and integration suites**

Run:

```bash
cd backend
npx jest src/file/file-storage-authority.spec.ts src/project/project-storage-authority.spec.ts --runInBand --no-coverage
STORAGE_MYSQL_TEST=1 npx jest src/file/file-storage-authority.mysql.spec.ts --runInBand --no-coverage
npm test -- src/file/file-upload.spec.ts src/file/file-upload.mysql.spec.ts --runInBand --no-coverage
npm run build
npm run lint:check
```

Expected: all commands exit 0; existing legacy-mode upload tests remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/src/file backend/src/project backend/src/style-template
git commit -m "feat: route source files through storage authority"
```

---

### Task 6: PM2 process, activation tooling, and fail-closed verification

**Files:**
- Create: `scripts/storage-authority-preflight.sh`
- Create: `scripts/storage-authority-activate.sh`
- Create: `scripts/storage-authority-negative-probe.sh`
- Modify: `ecosystem.config.cjs`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `backend/.env.example`
- Modify: `package.json`
- Test: `tests/storage-authority-ops.test.js`
- Test: `backend/src/storage/storage-readiness.spec.ts`

**Interfaces:**
- Consumes: broker binary, readiness service, exact schema/grant contract, Task 11.2 authority-floor marker.
- Produces:
  - PM2 process `write-agent-storage-broker`
  - `npm run storage:preflight`
  - `npm run storage:activate`
  - `npm run storage:negative-probe`

- [ ] **Step 1: Write failing ops-contract tests**

```js
test('activation refuses a missing authoring authority floor', () => {
  const result = run('scripts/storage-authority-activate.sh', {
    AUTHORING_AUTHORITY_FLOOR: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TASK11_2_AUTHORITY_FLOOR_UNPROVEN/);
});

test('compose exposes MySQL only on loopback and has no app protected-rw mount', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  assert.match(compose, /127\.0\.0\.1:3306:3306/);
  assert.doesNotMatch(compose, /\/var\/db\/textweaver\/storage:.*rw/);
});

test('ecosystem defines one broker process without a listening port', () => {
  const ecosystem = require('../ecosystem.config.cjs');
  const broker = ecosystem.apps.filter(
    (app) => app.name === 'write-agent-storage-broker',
  );
  assert.equal(broker.length, 1);
  assert.equal(broker[0].env.PORT, undefined);
});
```

- [ ] **Step 2: Run ops tests and confirm RED**

Run: `node --test tests/storage-authority-ops.test.js`

Expected: FAIL because scripts and broker process definition are absent.

- [ ] **Step 3: Add broker process and safe infrastructure configuration**

`ecosystem.config.cjs` adds:

```js
{
  name: 'write-agent-storage-broker',
  cwd: path.join(rootDir, 'storage-broker'),
  script: path.join(rootDir, 'storage-broker/bin/write-agent-storage-broker'),
  interpreter: 'none',
  instances: 1,
  autorestart: true,
  kill_timeout: 15000,
  env: {
    STORAGE_BROKER_CONTRACT: 'storage-broker.v1',
  },
}
```

Activated infrastructure keeps only MySQL, Redis, and Qdrant in Docker Desktop. MySQL binds `127.0.0.1:3306:3306`. API/worker/broker run as isolated host identities with isolated `PM2_HOME`; no API or worker process receives a protected-root rw mount.

- [ ] **Step 4: Implement read-only preflight and explicit activation gate**

The preflight exits non-zero unless all of these are proven:

```text
storage_control is empty before first activation, or has exactly one matching ACTIVE row
all six procedures, the view, trigger, tables, checks, indexes, FKs, and exact grants match
parse/cleanup/move/outbox queues are drained
every source file has verified checksum and byte size
quarantine is empty or each entry has a durable intent
protected and quarantine roots are absolute, normalized, distinct, and have exact owner/mode
Docker has no protected rw application mount
API, worker, and broker runtime identities are distinct
```

Activation begins with:

```bash
if [ "${AUTHORING_AUTHORITY_FLOOR:-}" != "task11.2-procedure-only.v1" ]; then
  echo "TASK11_2_AUTHORITY_FLOOR_UNPROVEN" >&2
  exit 78
fi
if [ "${CONFIRM_STORAGE_ACTIVATION:-}" != "activate-storage-broker-v1" ]; then
  echo "EXPLICIT_STORAGE_ACTIVATION_CONFIRMATION_REQUIRED" >&2
  exit 78
fi
```

It then stops ingress, drains queues, stops old app processes, migrates and verifies existing blobs through the broker-aware migration command, activates one epoch, starts the new isolated processes, and runs the negative/positive probes. Any failed probe leaves ingress stopped and authoring enrollment empty; the script never restores the legacy principal or app write permission.

- [ ] **Step 5: Add negative probes and readiness behavior**

Run `mkdir`, create, chmod, rename, unlink, and recursive-delete probes as API and worker identities against a unique test key under the protected root; each must fail with `EACCES` or `EPERM`. The broker positive probe uploads, promotes, verifies `0440`, parses, and re-hashes one fixture. `StorageReadinessService` exposes no secrets and throws `STORAGE_AUTHORITY_UNPROVEN` when the process identity, epoch, contract, owner/mode, grant contract, or mount proof drifts.

- [ ] **Step 6: Verify without activating the workstation**

Run:

```bash
node --test tests/storage-authority-ops.test.js
cd storage-broker && go test -race ./... && go vet ./...
cd ../backend && npm test -- src/storage --runInBand --no-coverage
npm run build
npm run lint:check
cd .. && npm run storage:preflight
```

Expected: tests/build/lint exit 0. The preflight is read-only and either exits 0 with proofs or exits non-zero with a specific unmet prerequisite. Do not run `storage:activate` in this plan because Task 11.2's procedure-only application authority has not been installed.

- [ ] **Step 7: Commit**

```bash
git add scripts ecosystem.config.cjs docker-compose.yml .env.example backend/.env.example package.json tests backend/src/storage storage-broker
git commit -m "ops: add fail-closed storage authority activation"
```

---

## Plan-level verification

- [ ] Run all backend unit tests: `cd backend && npm test -- --runInBand`
- [ ] Run backend build: `cd backend && npm run build`
- [ ] Run backend lint without edits: `cd backend && npm run lint:check`
- [ ] Run opt-in MySQL storage suites against a fresh MySQL 8.4 database.
- [ ] Run existing database-upgrade/schema-diff suite against a copy of the current database.
- [ ] Run Go checks: `cd storage-broker && go test -race ./... && go vet ./...`
- [ ] Run ops contract: `node --test tests/storage-authority-ops.test.js`
- [ ] Confirm `git diff --check` exits 0.
- [ ] Confirm no migration inserted `storage_control`, no activation command ran, and no authoring project was enrolled.
- [ ] Confirm legacy mode still supports login, upload, parse, retrieval, generation shadow, and export.
- [ ] Record exact commits, commands, pass/fail evidence, inactive activation gate, and remaining Task 11.2 dependency in the optimization report.

## Task 11 continuation boundaries

After this plan, Task 11 continues as independently approved implementation plans:

1. Task 11.2 — procedure-only authoring schema, rollout selection, and database authority floor.
2. Task 11.3 — proposal contracts, persistence, approval DTO, and workflow suspension.
3. Task 11.4 — deterministic shadow graph, evidence gate, validators, and bounded budgets.
4. Task 11.5 — approval consumption plus transactional directory/outline commit.
5. Task 11.6 — exact-byte body commit, rewrite lineage, recovery, and compatibility completion.

Storage activation from Task 6 becomes executable only after Task 11.2 proves `AUTHORING_AUTHORITY_FLOOR=task11.2-procedure-only.v1`.
