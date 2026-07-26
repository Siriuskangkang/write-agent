# Deterministic Authoring Workflow Design

**Status:** approved by user for implementation

**Date:** 2026-07-27
**Baseline:** `1ed3a5b` on `codex/full-optimization`

## 1. Purpose and authority boundary

Task 11 turns the existing Bull/MySQL workflow runner and Task 10B atomic
grounding shadow path into a recoverable, deterministic authoring graph for
directory, outline, content, rewrite, expand and compress workflows.

The design keeps three authorities separate:

1. A model may only propose bounded structured data.
2. Deterministic server code owns validation, transitions, sealing, review,
   rendering, recovery and version selection.
3. For a project enrolled in `enforce_allowlist`, a transaction-bound,
   once-only in-process capability plus the procedure-only database authority
   from 4.3 are both required to create or promote a trusted business version.
   Projects outside enforce retain an explicitly labelled legacy/unverified
   compatibility path.

A sealed proposal is not permission to persist. Before approval, no authoring
workflow writes `directory_versions`, `outline_versions`, `writing_results`,
`content_versions`, `grounding_claims`, `citation_maps` or
`workflow_domain_commits`.

The approved two-stage body experience is preserved as:

1. the server stores exact, viewable body bytes as an isolated workflow
   proposal;
2. the user approves that proposal;
3. one approval transaction creates the business result, version, grounding
   ledger and current head.

The implementation remains a NestJS modular monolith with Bull workers and
MySQL checkpoints. It does not add LangGraph or an autonomous multi-agent
runtime.

## 2. Locked product decisions

- Directory and outline proposals remain workflow artifacts until approval.
  Approval creates one new current business version transactionally.
- Body proposals are persistent drafts in `authoring_proposals`, not in
  `writing_results` or `content_versions`. They are readable only through an
  owner-scoped workflow proposal endpoint.
- Content, rewrite, expand and compress approval writes the exact sealed
  server bytes and changes the corresponding content scope head in one
  transaction.
- Rewrite, expand and compress retain the approved parent-result relationship.
  An unapproved proposal can never be selected as a revision parent.
- The client approves only the current active proposal for the owned waiting
  job. It never supplies candidate bytes, evidence, digests, a nonce,
  capability, version number or business identifiers.
- Approval automatically requeues the job. A worker, not the request thread,
  performs the positive business transaction.
- Task 12 is responsible for the frontend approval UI. Until Task 12 ships,
  legacy generation entrypoints can use legacy or existing atomic shadow
  execution only; they never enter an approval-requiring definition and are
  never auto-approved.
- Positive persistence is selected once at job creation and stored. Claim and
  recovery never recompute the selection from current environment variables.

## 3. Non-goals

- No free-running agents, model tool selection or model-authored transitions.
- No positive atomic write through the existing
  `WorkflowDomainCommitService.commit()` method. It retains its unconditional
  `atomic:v1` rejection.
- No client-provided authority fields in input, checkpoints or approval DTOs.
- No automatic export or publication after approval.
- No unbounded repair, retrieval or model loop.
- No deletion of legacy generation endpoints in Task 11.

## 4. Persisted workflow selection and rollout

### 4.1 Stored selection

Every `workflow_jobs` row stores:

- `workflow_definition`:
  `legacy-generation.v1 | atomic-shadow.v1 |
  deterministic-authoring-shadow.v1 | deterministic-authoring.v1`;
- `authoring_mode`: `off | shadow | enforce_allowlist`;
- `rollout_policy_version`: exactly `authoring-rollout.v1`;
- `rollout_policy_snapshot`: canonical JSON bytes containing the selected
  policy and every value required to resume it;
- `rollout_policy_digest`: Task 10B tagged SHA-256 using
  `authoring-rollout-policy.v1`;
- `server_entrypoint`: `legacy_api | workflow_api | internal`;
- `client_contract_version`: nullable, with
  `authoring-approval-ui.v1` as the only supported positive value.

These fields are server-owned. The create DTO may contain
`client_contract_version` only as a compatibility signal; it cannot select a
definition or grant authority. The controller supplies `server_entrypoint`.
`WorkflowService` selects and stores all other values in the create
transaction after locking the owned project row and rechecking
`deleted_at IS NULL`; this project gate serializes workflow creation with
project/user tombstone. A claimed job receives the stored values and verified
snapshot in `ClaimedWorkflowJob`; workers never consult current rollout
configuration to change them.

`AuthoringRolloutPolicySnapshotV1` is closed and contains:

- `policy_version='authoring-rollout.v1'`, selected definition/mode,
  `project_allowlisted`, entrypoint and client contract;
- strict-citation and atomic-grounding modes captured at creation;
- deployment epoch and canonical runtime-manifest digest;
- storage-control active epoch and `storage-broker.v1` contract;
- all TTL, proposal, graph-call, token, cost, sweep and retention limits;
- `token_estimator_version='utf8-byte-upper-bound.v1'`;
- sorted operation/model entries containing operation name, provider, model,
  pricing schema version and `price_state`. `KNOWN` carries exact
  input/output/cached-input prices from canonical parsed
  `MODEL_PRICING_JSON`; `UNKNOWN` carries no price fields and is legal only
  for deterministic shadow;
- canonicalizer and graph versions.

Its exact stored preimage is:

```ts
interface AuthoringRolloutModelPriceV1 {
  operation: string;
  provider: string;
  model: string;
  pricing_schema_version: string;
  price_state: 'KNOWN' | 'UNKNOWN';
  input_micro_usd_per_million: string | null;
  output_micro_usd_per_million: string | null;
  cached_input_micro_usd_per_million: string | null;
}

interface AuthoringRolloutPolicySnapshotPreimageV1 {
  policy_version: 'authoring-rollout.v1';
  workflow_definition:
    | 'deterministic-authoring-shadow.v1'
    | 'deterministic-authoring.v1';
  authoring_mode: 'shadow' | 'enforce_allowlist';
  project_allowlisted: boolean;
  server_entrypoint: 'workflow_api' | 'internal';
  client_contract_version: 'authoring-approval-ui.v1' | null;
  strict_citation: boolean;
  atomic_grounding_mode: 'off' | 'shadow_no_persist';
  deployment_epoch: string | null;
  runtime_manifest_digest: string | null;
  storage_epoch: string | null;
  storage_contract_version: 'storage-broker.v1' | null;
  limits: {
    proposal_ttl_hours: number;
    max_model_calls: number;
    max_model_input_tokens: number;
    max_model_output_tokens: number;
    max_cost_micro_usd: string;
    proposal_sweep_batch: number;
    proposal_payload_retention_days: number;
  };
  token_estimator_version: 'utf8-byte-upper-bound.v1';
  model_prices: AuthoringRolloutModelPriceV1[];
  canonicalizer_version: 'canonical-json.v1';
  graph_version: 'deterministic-authoring-graph.v1';
}

type AuthoringRolloutPolicySnapshotV1 =
  AuthoringRolloutPolicySnapshotPreimageV1;

interface AuthoringRuntimeManifestPreimageV1 {
  manifest_version: 'authoring-runtime-manifest.v1';
  deployment_epoch: string;
  instances: Array<
    | {
        instance_id: string;
        role: 'api' | 'worker' | 'authoring_committer';
        runtime_contract_version: 'authoring-workflow.v1';
        build_commit_sha: string;
      }
    | {
        instance_id: string;
        role: 'storage_broker';
        runtime_contract_version: 'storage-broker.v1';
        build_commit_sha: string;
      }
  >;
}
```

Positive mode requires non-null deployment/runtime/storage fields; shadow
requires all four null. `server_entrypoint='workflow_api'` requires
`client_contract_version='authoring-approval-ui.v1'`;
`server_entrypoint='internal'` requires it to be null. Model-price rows sort by
operation/provider/model UTF-8 bytes and the tuple is unique; KNOWN requires
all three price strings and UNKNOWN requires all three null.
`runtime_manifest_digest` uses tag `authoring-runtime-manifest.v1` over the
exact manifest preimage, whose instances are unique by instance ID and sorted
by that ID's UTF-8 bytes. Instance IDs are lowercase UUIDs and build commit is
lowercase 40-hex. `rollout_policy_digest` uses the policy tag over this exact
object.

Only operation/model price entries used by the selected graph are stored, not
API keys or provider credentials. Recovery re-parses the snapshot, verifies
its digest and uses it as the sole policy source. Invalid bytes/digest fail
with `AUTHORING_POLICY_SNAPSHOT_INVALID`.

### 4.2 Exact configuration

```text
AUTHORING_COMMIT_MODE=off|shadow|enforce_allowlist
AUTHORING_ALLOWLIST_PROJECT_IDS=<comma-separated canonical lowercase UUIDs>
AUTHORING_PROPOSAL_TTL_HOURS=168
AUTHORING_MAX_MODEL_CALLS=9
AUTHORING_MAX_MODEL_INPUT_TOKENS=200000
AUTHORING_MAX_MODEL_OUTPUT_TOKENS=64000
AUTHORING_MAX_COST_MICRO_USD=2000000
AUTHORING_PROPOSAL_SWEEP_BATCH=100
AUTHORING_PROPOSAL_PAYLOAD_RETENTION_DAYS=30
AUTHORING_DEPLOYMENT_EPOCH=<canonical UUID>
AUTHORING_RUNTIME_MANIFEST_JSON=<canonical expected PM2 instances/roles>
STORAGE_AUTHORITY_MODE=legacy|broker
STORAGE_PROTECTED_ROOT=/var/db/textweaver/storage
STORAGE_QUARANTINE_ROOT=/var/db/textweaver/quarantine
```

Startup parsing rules:

- unknown, empty or case-variant modes resolve to `off`;
- the allowlist is trimmed, deduplicated and sorted; any non-canonical UUID
  fails startup while mode is `enforce_allowlist`;
- the allowlist and policy are read once at process startup; changes require a
  restart and produce a new policy digest;
- TTL range is 1–720 hours;
- model calls range is 1–9;
- input/output token limits range is 1–1,000,000;
- cost range is 1–100,000,000 micro USD;
- sweep batch range is 1–500;
- payload retention range is 1–365 days.
- unknown/empty/case-variant storage mode resolves to `legacy`; authoring
  enforce requires exact `broker`, absolute normalized distinct roots and a
  matching active `storage_control` epoch/contract.
- deployment epoch and manifest are required only for enforce; manifest has
  unique instance IDs, exact roles
  `api|worker|authoring_committer|storage_broker`, service identity, process
  names and count 1–64, and must match the isolated PM2/launchd process
  inventories for this release.

Task 10B keeps its existing exact
`ATOMIC_GROUNDING_MODE=off|shadow_no_persist` parser. Task 11 does not add an
`enforce` value to it.

### 4.3 Selection matrix

Rules are evaluated top to bottom. “Body” means content, rewrite, expand and
compress. File parse, index and export always use `legacy-generation.v1`.

The selector is this total pure function; exhaustive tests cover the Cartesian
product:

```ts
function selectAuthoringDefinition(context: SelectionContext): Selection {
  if (!isAuthoringType(context.workflow_type)) return legacy();

  const supportedClient =
    (context.server_entrypoint === 'workflow_api' &&
      context.client_contract_version === 'authoring-approval-ui.v1') ||
    (context.server_entrypoint === 'internal' &&
      context.server_internal_authority === true);
  const enrolled =
    context.authoring_mode === 'enforce_allowlist' &&
    context.project_in_allowlist;
  const groundingReady =
    !isBodyType(context.workflow_type) ||
    (context.atomic_grounding_mode === 'shadow_no_persist' &&
      context.strict_citation === true);

  if (enrolled && !supportedClient) return rejectEnforcedWorkflowRequired();
  if (enrolled && !groundingReady) return rejectGroundingRequired();
  if (enrolled) return deterministicPositive();
  if (supportedClient && context.authoring_mode === 'shadow') {
    return groundingReady ? deterministicShadow() : rejectGroundingRequired();
  }
  if (
    isBodyType(context.workflow_type) &&
    context.atomic_grounding_mode === 'shadow_no_persist' &&
    context.strict_citation === true
  ) {
    return atomicShadow();
  }
  return legacy();
}
```

“Allowlisted” in the explanatory table means `enrolled`, not raw list
membership while mode is off/shadow.

Before executor selection, `EnforcedAuthoringWritePolicy` guards every legacy
mutation entrypoint, including directory/outline save, body generation,
rewrite/expand/compress, current/version switches and direct body PATCH. If
the current startup policy is `enforce_allowlist` and the owned project is in
the allowlist, a legacy or unsupported-client mutation is rejected with
`AUTHORING_ENFORCED_WORKFLOW_REQUIRED` before any model call or business write.
It may not silently fall back, auto-approve or change a current marker. Reads,
file/index operations and export remain available.

| Enrolled | Supported client | Mode | Type/prerequisite | Result |
|---|---|---|---|---|
| yes | no | enforce | any authoring | reject `AUTHORING_ENFORCED_WORKFLOW_REQUIRED` |
| yes | yes | enforce | body grounding missing | reject `AUTHORING_GROUNDING_REQUIRED` |
| yes | yes | enforce | directory/outline or grounded body | `deterministic-authoring.v1` |
| no | yes | shadow | body grounding missing | reject `AUTHORING_GROUNDING_REQUIRED` |
| no | yes | shadow | directory/outline or grounded body | `deterministic-authoring-shadow.v1` |
| no | any | every remaining mode/client case | grounded body | `atomic-shadow.v1` |
| no | any | every remaining mode/client case | directory/outline or ungrounded body | `legacy-generation.v1` |

An `internal` entrypoint must provide a server-issued typed creation context
and then follows the supported `workflow_api` rows. It is not accepted from an
HTTP DTO.

Exactly one executor is resolved from the persisted definition. A job can
never run both an atomic-shadow executor and the deterministic graph.

Switching a project into enforce is an operational gate: startup refuses the
mode if that project has an active legacy authoring job. Existing non-terminal
legacy authoring jobs must be drained, stopped or allowed to finish before the
project enters the allowlist. Once enrolled, all authoring services use the
same policy guard, not only workflow creation.

Old/new binaries may not coexist while enforce is enabled. Each API, worker,
authoring committer and storage broker publishes Redis key
`write-agent:runtime-contract:<instance-id>` every 10 seconds with role and
its manifest-declared runtime contract version, TTL 30 seconds. Before an
enforce enrollment or mutation, the guard requires Redis healthy and every
manifest instance key at its role-specific manifest version; otherwise it
returns `AUTHORING_MIXED_BINARY_FLEET`. PM2 rollout stops and drains old
processes before enforce. Old-binary omitted-column compatibility is migration
safety, not permission to run an old binary in an enforce fleet.

Redis/PM2 checks are operational evidence, not the final write authority.
Connection variables are not credentials and are never used as a database
capability. Task 11 instead makes protected writes procedure-only:

- locked non-login definer
  `'wa_authoring_definer_v1'@'localhost' ACCOUNT LOCK` is the only principal
  with DML on `authoring_proposals`, approvals/invalidations/enrollment,
  workflow lifecycle/event/domain-commit rows and the directory/outline/body
  current/version/ledger tables;
- mTLS API role/account `wa_app_role_v1` / `'wa_app_v1'@'%'` has no direct
  INSERT/UPDATE/DELETE on those tables. It may execute only owner-scoped
  create/approve/cancel/resume, project/material/template and legacy-save
  procedures; legacy-save procedures reject an enrolled project;
- mTLS worker role/account `wa_authoring_worker_role_v1` /
  `'wa_authoring_worker_v1'@'%'` may execute only claim-safe lifecycle/seal
  procedures. It cannot approve, enroll, legacy-save or commit;
- positive business commit is not executable by the app role. A no-HTTP PM2
  process `write-agent-authoring-committer`, OS identity `_twcommit`, uses the
  mTLS account `'wa_authoring_commit_v1'@'%'` and role
  `'wa_authoring_commit_role_v1'`, whose only authoring grant is EXECUTE on
  `sp_authoring_commit_v1`;
- `sp_authoring_commit_v1(job_id,proposal_id,approval_id,
  expected_fencing_token)` locks in the section 11
  order, reads canonical sealed bytes from MySQL, recomputes their tagged
  digests with exact binary concatenation, revalidates the immutable approval,
  consumes the once-only domain-commit uniqueness and performs the complete
  business/head/ledger/job/event transaction. It accepts no caller-supplied
  content, version number, evidence row or current marker;
- the definer's direct privileges and every EXECUTE grant are golden
  `SHOW GRANTS` contracts. API, generic worker, committer and legacy
  principals have no `SET USER`, routine-DDL or grant authority.

No login principal can seal, approve and commit: API can approve but cannot
seal/commit; worker can seal but cannot approve/commit; committer can commit
but cannot seal/approve. The current API's JWT/cookie authentication boundary
is trusted to assert `actor_id`; compromise of the current API identity,
MySQL administrator or host root remains outside the stale/buggy-binary threat
model. Database credentials are per-process mTLS material and are not shared.

Named invariant triggers still protect illegal state/current combinations,
but they are not an authentication mechanism. Old binaries use the revoked
legacy login and cannot connect; a new app connection that attempts direct
DML receives MySQL privilege denial. The in-memory once-only capability
authorizes the committer request inside the new process, while the stored
procedure is the independent database enforcement boundary.

The procedure surface is closed. Mutating calls accept
`actor_id`, owned `project_id`, a server-generated idempotency key, an exact
canonical request BLOB and its tagged digest; worker-only calls additionally
accept job/proposal/approval IDs and fencing token. Procedures reject unknown
fields after `JSON_SCHEMA_VALID`, lock/reload every authoritative row, and
derive IDs, versions, counters and event payloads server-side. The only
exception is the four-scalar `sp_authoring_commit_v1` signature above because
it reads all content from locked proposal rows. Enrollment/deactivation
accept only project, deployment/storage epochs, policy digest and admin actor
and are executable solely by the migration-admin role. Golden procedure
fixtures cover exact parameter order/SQL types, result-set columns,
SQL SECURITY DEFINER, transaction ownership and every stable error signal.
API EXECUTE is exactly
`sp_workflow_create_v1,sp_workflow_control_transition_v1,
sp_authoring_approve_v1,sp_legacy_commit_directory_v1,
sp_legacy_commit_outline_v1,sp_legacy_commit_content_v1,
sp_legacy_patch_content_v1,sp_project_mutate_v1,sp_material_mutate_v1,
sp_style_template_mutate_v1` plus the four storage request routines. Worker
EXECUTE is exactly
`sp_workflow_worker_transition_v1,sp_authoring_seal_v1`; committer EXECUTE is
exactly `sp_authoring_commit_v1`; migration admin alone executes enroll/
deactivate. An extra grant fails readiness.

Enforce startup requires each configured allowlisted project to have a DB row
with the same deployment/storage epochs, runtime/storage contracts and policy
digest; missing or extra rows fail readiness with
`AUTHORING_ENFORCEMENT_EPOCH_MISMATCH`. Activation follows the complete 4.4
storage sequence, then starts the new fleet in off mode, proves
manifest/quorum, calls migration-admin-only `sp_authoring_enroll_v1` and
restarts the new fleet in enforce mode. Deactivation uses a separate admin
procedure that first disables positive creation, drains all deterministic jobs
and storage intents, and then removes the enrollment; an environment toggle
alone cannot remove the database guard.

DB triggers guard database writes only. Enforce additionally requires the
kernel-enforced storage authority in 4.4; process census is auxiliary evidence
and is never treated as filesystem permission.

### 4.4 Kernel-enforced storage authority

The current old `ProjectService.remove()` unlinks source files before opening
its database transaction. Task 11 therefore makes persistent source storage a
separate capability boundary before any project may enroll:

- API runs as non-admin OS identity `_twapi`, parser/workflow workers as
  `_twworker`, and the storage broker as `_twfs`;
- `_twapi` and `_twworker` are members of read-only group `_twread`, but never
  the broker owner/group;
- protected root `/var/db/textweaver/storage` is
  `_twfs:_twread` mode `0710`, `blobs/` and every project directory are mode
  `2710`, and blobs are `_twfs:_twread` mode `0440`. Only `_twfs` has write on
  every parent directory, which is the POSIX authority required by
  `unlink/rename/rm`;
- upload quarantine is separate
  `/var/db/textweaver/quarantine`, `_twapi:_twingest` mode `2730`; `_twfs` is
  also in `_twingest`. API may create quarantined files but cannot create,
  replace, chmod or unlink protected blobs;
- release code is root-owned/read-only, each identity has an isolated
  `PM2_HOME`, and the broker has no HTTP ingress. Root/administrator and Docker
  control are trusted operations outside the stale-binary threat model.

`write-agent-storage-broker` is the sole persistent-file writer/deleter. It
polls MySQL durable intents; Redis/Bull may wake it but never grants authority.
There is no delete RPC. API/worker code may read an AVAILABLE blob but all
mkdir/promote/rename/unlink operations for the protected root are forbidden.
An old API or cleanup/move worker started after activation still runs as
`_twapi`/`_twworker`; its legacy `unlink/rm` receives `EACCES/EPERM` before any
database action. A process census cannot weaken or replace this continuous
kernel rule.

The broker tables are:

```text
storage_control
  singleton_id TINYINT UNSIGNED PRIMARY KEY
  active_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  broker_contract_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    NOT NULL
  activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)

storage_objects
  id VARCHAR(36) PRIMARY KEY
  project_id VARCHAR(36) NOT NULL
  source_file_id VARCHAR(36) NOT NULL
  generation BIGINT UNSIGNED NOT NULL
  storage_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  checksum_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  byte_size BIGINT UNSIGNED NOT NULL
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6)

storage_operation_intents
  id VARCHAR(36) PRIMARY KEY
  idempotency_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  project_id VARCHAR(36) NOT NULL
  object_id VARCHAR(36) NOT NULL
  object_generation BIGINT UNSIGNED NOT NULL
  storage_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  quarantine_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL
  expected_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  expected_size BIGINT UNSIGNED NOT NULL
  authorization_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  authorization_id VARCHAR(36) NOT NULL
  storage_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
  execution_fence BIGINT UNSIGNED NOT NULL DEFAULT 0
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL
  lease_expires_at DATETIME(6) NULL
  next_attempt_at DATETIME(6) NULL
  completed_at DATETIME(6) NULL
  attempts INT UNSIGNED NOT NULL DEFAULT 0
  result_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL
  last_error VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6)
```

V1 does not rotate `storage_control.active_epoch`: historical intents and
enrollment rows intentionally RESTRICT an update/delete. Epoch rotation is a
future migration to an append-only epoch-history table, not an UPDATE of this
singleton.

Closed values are:

- broker contract `storage-broker.v1`;
- object state `STAGING | AVAILABLE | DELETE_PENDING | DELETED`;
- intent kind
  `PROMOTE | DELETE_QUARANTINE | DELETE_BLOB | ABORT_PROMOTION`;
- intent status `PENDING | EXECUTING | RETRY | SUCCEEDED | REJECTED`;
- authorization kind
  `UPLOAD_COMMIT | SOURCE_FILE_TOMBSTONE | MOVE_ABORT`.

`chk_storage_operation_intents_shape` is a same-row MySQL CHECK and closes
only intent-column combinations:

- PROMOTE requires non-null quarantine key and `UPLOAD_COMMIT`;
- DELETE_QUARANTINE requires non-null quarantine key and
  `UPLOAD_COMMIT|MOVE_ABORT`;
- DELETE_BLOB requires null quarantine key,
  `SOURCE_FILE_TOMBSTONE`;
- ABORT_PROMOTION requires non-null quarantine key, `MOVE_ABORT`, and a
  non-null authorization ID;
- PENDING/RETRY require null lease/completed/result; EXECUTING requires
  lease token/expiry and null completed/result; SUCCEEDED/REJECTED require
  null lease, non-null completed/result and `next_attempt_at IS NULL`;
- `last_error` is null except RETRY/REJECTED, and attempts/fence are positive
  for EXECUTING/terminal rows.

MySQL CHECKs never inspect another table. Same-project object state,
generation, key, authorization and source-file conditions are cross-table
procedure preconditions verified under the fixed locks: PROMOTE and
ABORT_PROMOTION require STAGING; DELETE_BLOB requires
AVAILABLE/DELETE_PENDING. The procedure/golden tests, not the CHECK clause,
enforce those predicates.
Terminal transition immutability is enforced by the definer procedures plus
named `BEFORE UPDATE` trigger
`trg_storage_operation_intents_terminal_bu`, which rejects every change to a
row whose old status is SUCCEEDED/REJECTED and rejects terminal→non-terminal.

`source_files` gains `deleted_at DATETIME(6) NULL` and
`deleted_by VARCHAR(36) NULL`; `chk_source_files_tombstone` requires both null
or both non-null, `idx_source_files_project_deleted(project_id,deleted_at,id)`
supports live reads and `source_files_deleted_by_fkey` is RESTRICT. Its
project FK is reconciled to RESTRICT. Normal material/index/retrieval reads
require null tombstone. Enrolled single-file delete first tombstones the row
and invalidates active ingestion in a transaction, then may request a
same-generation DELETE_BLOB; project tombstone retains blobs and creates no
such intent. `file_path` remains the absolute protected read path for
compatibility, but only the broker may create or remove it.

Named guards are:

- `chk_storage_control_singleton`,
  `chk_storage_control_contract`,
  `chk_storage_objects_state`,
  `chk_storage_operation_intents_kind`,
  `chk_storage_operation_intents_status`,
  `chk_storage_operation_intents_authorization`,
  `chk_storage_operation_intents_shape`;
- `uq_storage_objects_key(storage_key)`,
  `uq_storage_control_active_epoch(active_epoch)`,
  `uq_source_files_project_id(project_id,id)`,
  `uq_storage_objects_file_generation(source_file_id,generation)`,
  `uq_storage_objects_intent_identity(id,project_id,generation,storage_key)`,
  `uq_storage_operation_intents_idempotency(idempotency_key)`,
  `idx_storage_operation_intents_claim(status,next_attempt_at,
  lease_expires_at)`;
- RESTRICT FKs
  `storage_objects_project_fkey`,
  `storage_objects_project_file_fkey(project_id,source_file_id)` to
  `source_files(project_id,id)`,
  `storage_operation_intents_project_fkey`,
  `storage_operation_intents_storage_epoch_fkey(storage_epoch)` to
  `storage_control(active_epoch)` and
  `storage_operation_intents_object_fkey(object_id,project_id,
  object_generation,storage_key)` to the storage-object identity.

`storage_key` is an ASCII relative key generated by the server with exact
grammar
`p/<project-lowercase-uuid>/f/<file-lowercase-uuid>/g/<positive-decimal-generation>/<lowercase-sha256>.blob`.
No leading zero is allowed in generation. Absolute paths, empty segments,
`.`, `..`, percent/backslash ambiguity, symlinks, hardlinks and key reuse are
rejected. Broker filesystem operations are root-dirfd-relative and use
`openat/unlinkat` with no-follow/exclusive-create semantics; a small Go/Rust
broker is used instead of path `realpath` checks with TOCTOU windows.

MySQL authority is exact:

- locked, non-login definer
  `'wa_storage_definer_v1'@'localhost' ACCOUNT LOCK`;
- roles `'wa_app_role_v1'`, `'wa_authoring_worker_role_v1'` and
  `'wa_storage_broker_role_v1'`;
- mTLS login accounts `'wa_app_v1'@'%'`,
  `'wa_authoring_worker_v1'@'%'` and `'wa_storage_broker_v1'@'%'`
  with certificate subjects `/CN=write-agent-api-v1`,
  `/CN=write-agent-authoring-worker-v1` and
  `/CN=write-agent-storage-broker-v1`, respectively, and their matching
  default role set;
- Docker publishes MySQL only on `127.0.0.1`; neither account has
  `FILE`, `SUPER`, `SYSTEM_USER`, `CREATE USER`, `CREATE/ALTER/DROP ROUTINE`,
  direct storage-table DML, or physical DELETE on projects/source files.

The exact `SQL SECURITY DEFINER` signatures are:

```text
sp_storage_request_promote_v1(
  actor_id, intent_id, object_id, idempotency_key, project_id, source_file_id,
  generation, storage_key, quarantine_key, expected_sha256, expected_size,
  authorization_id, storage_epoch)
sp_storage_request_delete_quarantine_v1(
  actor_id, intent_id, idempotency_key, project_id, source_file_id, object_id,
  generation, storage_key, quarantine_key, expected_sha256, expected_size,
  authorization_kind, authorization_id, storage_epoch)
sp_storage_request_delete_blob_v1(
  actor_id, intent_id, idempotency_key, project_id, source_file_id, object_id,
  generation, storage_key, expected_sha256, expected_size,
  authorization_kind, authorization_id, storage_epoch)
sp_storage_request_abort_promotion_v1(
  actor_id, intent_id, idempotency_key, project_id, source_file_id, object_id,
  generation, storage_key, quarantine_key, expected_sha256, expected_size,
  authorization_id, storage_epoch)
sp_storage_claim_v1(broker_instance_id, lease_seconds, storage_epoch)
sp_storage_complete_v1(
  intent_id, execution_fence, lease_token, outcome, observed_sha256,
  observed_size, result_code, sanitized_error, storage_epoch)
```

UUID/digest/key/string arguments have the exact column types above. SQL size,
generation and fence are unsigned 64-bit, while every canonical TypeScript
representation is a base-10 string matching `0|[1-9][0-9]*` and bounded by
`18446744073709551615`; conversion uses `BigInt`, never `number`. Lease range
is 5–300 seconds; outcome is `SUCCEEDED|RETRY|REJECTED`. Request procedures
return exactly
`intent_id,status,execution_fence,result_code` and implement same-key/same-
payload replay; same key with different canonical payload signals
`STORAGE_IDEMPOTENCY_MISMATCH`.

Request routines lock storage control → project → source file → storage
object → intent. Claim is the explicit exception: it locks storage control,
then selects one candidate intent with `FOR UPDATE SKIP LOCKED`, increments
fence, writes lease/token and commits before filesystem I/O; it never holds an
intent lock while acquiring project/object locks. Complete first performs a
non-locking identity lookup, then starts a new transaction and locks storage
control → project → source file → object → intent before revalidating the
identity/fence. Request routines verify actor ownership, tombstone condition,
current generation, storage epoch and same-row shape before insert/replay.
Complete updates only
`WHERE id/fence/token/status='EXECUTING'/storage_epoch`; stale completion
returns `STORAGE_FENCE_LOST`. SUCCEEDED/REJECTED are immutable; RETRY clears
lease and sets bounded exponential `next_attempt_at`.

`wa_app_role_v1` gets SELECT on the application views and tables needed by
owned reads, direct INSERT/UPDATE only on
`refresh_tokens,user_settings,sessions,messages`, and DELETE only on
`refresh_tokens`. Project/material/template/export and every
workflow/authoring/business-current mutation use the exact definer procedures
registered in 8.8; app has no direct DML on their base tables and no privilege
on storage tables. It gets EXECUTE on the four storage request routines, not
claim/complete. `wa_storage_broker_role_v1` gets EXECUTE only on claim/complete
and SELECT on
`v_storage_intent_execution_v1`, whose columns in order are
`intent_id,kind,status,project_id,source_file_id,object_id,object_generation,
storage_key,quarantine_key,expected_sha256,expected_size,authorization_kind,
authorization_id,storage_epoch,execution_fence,lease_token,lease_expires_at,
object_state,object_checksum_sha256,object_byte_size,source_file_deleted_at,
outbox_id,outbox_status,outbox_parse_generation`. It exposes no user email,
content or API secret. The definer gets only SELECT on project/source-file/
authorization facts, SELECT/INSERT/UPDATE on the three storage tables, and
SELECT plus column-level
`UPDATE(storage_intent_id,status,next_attempt_at,lease_owner,lease_expires_at,
last_error)` on
`file_upload_outbox`; it has no DELETE or authoring-table write. Migration
stores golden
`SHOW CREATE PROCEDURE`, `SHOW CREATE VIEW` and normalized `SHOW GRANTS`
strings in `application-schema-contract.ts`; any extra/missing grant is
readiness failure. Activation revokes the legacy principal and kills all of
its sessions before storage control becomes active.

Upload is:

1. Multer writes only quarantine; API validates size, magic and checksum.
2. One app-owned DB transaction calls `sp_material_mutate_v1` to create the
   source-file and unique upload-outbox row in status `storage_preparing`,
   then calls `sp_storage_request_promote_v1`; that routine creates the
   STAGING object/intent and, after the FK target exists, sets the outbox's
   known intent ID and status `storage_pending`. Neither routine commits
   independently.
   Task 11 adds nullable `storage_intent_id VARCHAR(36)` with a RESTRICT FK and
   a named CHECK requiring null for `storage_preparing`, non-null for
   `storage_pending`, and null for ordinary parse statuses
   `pending|published`; neither storage status is dispatchable.
3. Broker copies with no-follow semantics into broker-owned staging, recomputes
   bytes/hash, fsyncs and atomically renames inside protected storage.
4. A fenced completion transaction changes object to AVAILABLE, intent to
   SUCCEEDED and CAS-updates exactly one matching outbox row from
   `storage_pending` to `pending`, requiring file/project/parse-generation/
   storage-intent identity and clearing lease/error fields. A zero/multi-row
   outbox result rolls back object and intent completion.
5. Parser reads only AVAILABLE objects. Failed/duplicate promotion is recovered
   from the same intent; API never promotes directly.

Kind-specific successful completion is closed: PROMOTE performs the
STAGING→AVAILABLE plus outbox transition; DELETE_BLOB performs
DELETE_PENDING→DELETED after `unlinkat` success or verified ENOENT;
ABORT_PROMOTION performs STAGING→DELETED; DELETE_QUARANTINE does not change
object state. RETRY changes no object/outbox state. REJECTED leaves object and
outbox unchanged and records the terminal sanitized result for operator
repair. `sp_storage_claim_v1` returns exactly the columns exposed by
`v_storage_intent_execution_v1`; `sp_storage_complete_v1` returns exactly
`intent_id,status,object_state,outbox_status,execution_fence,result_code`.
The DELETE_BLOB request transaction performs AVAILABLE→DELETE_PENDING before
committing its PENDING intent; idempotent replay accepts the same
DELETE_PENDING object only with identical identity/digest. No other request
routine changes object state.

Broker staging name is the intent UUID and final create is exclusive. On an
unknown result, a same-key final blob is accepted only after byte-size/hash,
object generation and canonical key all match the locked intent; mismatch is
`STORAGE_OBJECT_COLLISION` and no row is advanced. A partial staging file is
replaced only by the current fenced intent.

The exact idempotency preimage is:

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

type StorageOperationPreimageV1 =
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

For PROMOTE, `authorization_id` is the upload-outbox ID created in the same
request transaction; for DELETE_QUARANTINE with UPLOAD_COMMIT it is that
outbox ID, with MOVE_ABORT it is the `file_move_intents.id`; for DELETE_BLOB
it is the same source-file tombstone ID; for ABORT_PROMOTION it is the
move-intent ID. The
request routine derives/revalidates the authorization row and stores exactly
that value. No procedure parameter or intent column is omitted from this
preimage; `source_file_id` and the decimal strings bind the relational and
full-precision SQL identities.

Claim increments `execution_fence`, writes a random lease token and uses
`WHERE id/fence/token/status` on completion. The idempotency key uses tag
`storage-operation.v1` over `StorageOperationPreimageV1`.
Same key with different canonical payload is permanently rejected; `ENOENT`
after a previously claimed DELETE is idempotent success. `DELETE_BLOB`
requires a same-generation source-file tombstone. Task 11 project tombstone
never creates a physical-delete intent; separately authorized privacy purge is
outside Task 11 and must introduce its own future authorization contract.

Activation is fail closed:

1. install schema/procedures/DB roles and broker-aware binaries while
   authoring is off;
2. stop ingress; drain parse, cleanup, move and outbox queues; stop old PM2 and
   compose backend/worker processes; revoke the legacy login and kill all its
   sessions while the admin migration connection remains;
3. migrate every existing source file into protected storage, verify
   path/hash/size and set owner/mode; quarantine must be empty or represented
   by an intent;
4. insert the singleton `storage_control` ACTIVE epoch and commit; authoring
   enrollment is still empty, so storage can be exercised without enabling
   positive authoring;
5. start broker/API/worker under their distinct identities; Docker Desktop
   runs MySQL/Redis/Qdrant only and no backend/worker gets a protected rw bind
   mount;
6. run negative probes proving API/worker and a deliberately late-started old
   binary cannot
   mkdir/write/chmod/rename/unlink/rm the protected root, then run a positive
   upload→promote→parse probe;
7. prove exact grants/routines, continuous storage readiness and all migrated
   object hashes again, and only then insert authoring enrollment.

If a probe fails, storage remains ACTIVE and protected, ingress stays stopped
and authoring enrollment remains empty. Repair/retry uses the broker-aware
binary; there is no temporary bypass or downgrade to the revoked principal.

Readiness periodically verifies identity, parent-directory mode/owner, broker
contract/epoch and absence of protected rw Docker mounts. Drift stops new
uploads/authoring claims and returns `STORAGE_AUTHORITY_UNPROVEN`; it does not
make files app-writable. Rollback can use only a broker-aware binary, never
restore old DB grants or app write permission, and cannot roll back below this
storage floor while an enrolled project exists. Multi-host/rolling enforce is
unsupported in v1.

### 4.5 Shadow result

`deterministic-authoring-shadow.v1` performs one graph execution through
proposal seal and deterministic review, writes checkpoints, metrics and a
proposal row in state `SHADOW_COMPLETED`, and writes zero business rows,
approvals or domain commits. It emits compatibility `token` data only from the
sealed server bytes/structured server serialization, then `done` with
`server_saved=false`, and ends in `SUCCEEDED`. It never enters
`WAITING_APPROVAL`.

`atomic-shadow.v1` retains the Task 10B no-persist contract. Legacy SSE bridges
continue filtering internal events and terminate on the existing `done`
event. No legacy request can hang waiting for approval.

## 5. Engine suspension protocol and deterministic graph

### 5.1 Executor result protocol

`WorkflowTaskExecutor.execute()` becomes:

```ts
type WorkflowExecutionOutcome =
  | { kind: 'COMPLETED' }
  | {
      kind: 'COMPLETED_WITH_PROPOSAL';
      checkpoint: AuthoringCheckpointDraftV1;
      proposal: AuthoringProposalWriteIntentV1;
      event: WorkflowExecutionEvent;
    }
  | { kind: 'COMPLETED_PERSISTED' }
  | {
      kind: 'SUSPENDED_WAITING_APPROVAL';
      checkpoint: AuthoringCheckpointDraftV1;
      proposal: AuthoringProposalWriteIntentV1;
      event: WorkflowExecutionEvent;
    }
  | {
      kind: 'SUSPENDED_WAITING_MATERIAL';
      checkpoint: AuthoringCheckpointV1;
      event: WorkflowExecutionEvent;
    };

execute(
  job: ClaimedWorkflowJob,
  context: WorkflowTaskContext,
): AsyncGenerator<WorkflowExecutionEvent, WorkflowExecutionOutcome, void>;
```

The engine manually advances the iterator so it can read the generator return
value:

- `COMPLETED` calls the existing `store.complete()`;
- `COMPLETED_WITH_PROPOSAL` calls `store.completeWithProposal()` for
  deterministic shadow;
- either suspension calls `store.suspend()`;
- `COMPLETED_PERSISTED` means the positive business transaction already wrote
  the terminal job/event and the engine performs no further store call.

`AuthoringProposalWriteIntentV1` contains validated sealed bytes, artifact
kind, artifact digests/versions and the verified persisted TTL/retention
policy values, but no row ID, sequence, creation time, expiry/scrub time or
outer envelope digest.
`store.suspend()` locks and fences the running job, then in one transaction:

1. allocates `proposal_sequence = MAX(sequence)+1` under the locked job and a
   unique constraint;
2. generates the proposal UUID, reads one MySQL `NOW(6)` value and invokes the
   pure versioned `finalizeAuthoringProposalV1()` with the intent plus
   ID/sequence/time/expiry/scrub time;
3. canonicalizes the final outer envelope, computes
   `authoring_envelope_digest` and inserts immutable ACTIVE proposal bytes;
4. replaces the checkpoint draft with the persisted proposal ID, sequence and
   digest;
5. sets `WAITING_APPROVAL`;
6. appends the exact returned event;
7. clears lease owner, token and expiry and leaves `completed_at` null.

`SUSPENDED_WAITING_MATERIAL` has no proposal intent and atomically writes its
checkpoint/status/event/lease release. `completeWithProposal()` performs the
same sequence allocation, proposal insert as `SHADOW_COMPLETED`, final
checkpoint, compatibility event and `SUCCEEDED` transition in one
transaction. There is no crash point that can expose a proposal without its
matching job state/checkpoint.

Cancellation or lease loss before commit makes the suspension fail with the
existing fenced error and cannot reverse a terminal state.

### 5.2 Graph

Graph version is `deterministic-authoring-graph.v1`.

```text
access_checked
  -> input_snapshotted
  -> retrieval_planned
  -> evidence_ready
  -> proposal_generated
  -> proposal_validated
  -> proposal_reviewed
  -> proposal_sealed
  -> waiting_approval
  -> approval_recorded
  -> business_committed
  -> done
```

Bounded branches:

```text
proposal_generated
  -> structured_repair (max 1)
  -> proposal_generated

atomic_verification
  -> targeted_retrieval (max 1)
  -> targeted_evidence_ready
  -> targeted_revision_draft (max 1)
  -> proposal_generated

proposal_reviewed
  -> review_repair (max 2)
  -> proposal_generated

any pre-commit node
  -> waiting_material | stopped | failed
```

Targeted revision is permitted only before the first advisory
`proposal_reviewed` node. An advisory review evidence gap suspends
`WAITING_MATERIAL`; it does not re-enter targeted revision. Therefore the
three advisory review attempts in section 7 are initial review plus the two
review-repair rechecks. `targeted_revision_draft` itself supplies the next
`proposal_generated` artifact; it never passes through the ordinary initial
draft call again.

The maximum reachable provider path is exactly:
query-plan 1 + initial-draft 1 + structured-repair 1 +
targeted-revision-draft 1 + advisory-review 3 + review-repair 2 = 9.
Targeted retrieval is not a model call. No transition can visit either draft
operation twice.

Checkpoint fields are runtime-schema validated and include graph/node
versions, generation attempt, input/dependency/index/retrieval digests,
operation fingerprints, node-attempt ordinals, transition-instance keys,
repair counters, active proposal ID/sequence/digest and accumulated budget.
They never contain a capability or approval nonce. A graph visit increments
its bounded attempt counter before deriving its operation fingerprint; the
checkpoint write and any corresponding transition event are one transaction.

Operation identity is closed:

```ts
type CanonicalJsonValueV1 =
  | null | boolean | number | string
  | CanonicalJsonValueV1[]
  | { [key: string]: CanonicalJsonValueV1 };

interface ModelRequestFingerprintPreimageV1 {
  request_version: 'authoring-model-request.v1';
  operation_kind:
    | 'QUERY_PLAN' | 'INITIAL_DRAFT' | 'STRUCTURED_REPAIR'
    | 'TARGETED_REVISION_DRAFT' | 'ADVISORY_REVIEW' | 'REVIEW_REPAIR';
  provider: string;
  model: string;
  gateway_contract_version: 'model-gateway.v1';
  prompt_template_id: string;
  prompt_template_version: string;
  system_prompt: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  structured_output_schema: CanonicalJsonValueV1 | null;
  tools: [];
  temperature_decimal: '0';
  max_output_tokens: number;
}

interface AuthoringOperationFingerprintPreimageV1 {
  fingerprint_version: 'authoring-operation-fingerprint.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  graph_version: 'deterministic-authoring-graph.v1';
  node_id: string;
  node_version: string;
  operation_kind:
    | 'SNAPSHOT' | 'QUERY_PLAN' | 'RETRIEVAL' | 'INITIAL_DRAFT'
    | 'STRUCTURED_REPAIR' | 'TARGETED_RETRIEVAL'
    | 'TARGETED_REVISION_DRAFT' | 'ADVISORY_REVIEW'
    | 'REVIEW_REPAIR' | 'SEAL';
  node_attempt_ordinal: number;
  repair_counters: AuthoringRepairCountersV1;
  input_digest: string;
  dependency_digest: string;
  retrieval_digest: string | null;
  index_digest: string | null;
  previous_artifact_digest: string | null;
  model_request_fingerprint: string | null;
}
```

The node registry is exact:

| operation kind | node ID / version | ordinal | model fingerprint |
|---|---|---:|---|
| SNAPSHOT | `snapshot` / `snapshot.v1` | 0 | null |
| QUERY_PLAN | `query_plan` / `query-plan.v1` | 0 | required |
| RETRIEVAL | `retrieval` / `hybrid-retrieval.v1` | 0 | null |
| INITIAL_DRAFT | `initial_draft` / `initial-draft.v1` | 0 | required |
| STRUCTURED_REPAIR | `structured_repair` / `structured-repair.v1` | 0 | required |
| TARGETED_RETRIEVAL | `targeted_retrieval` / `targeted-retrieval.v1` | 0 | null |
| TARGETED_REVISION_DRAFT | `targeted_revision_draft` / `targeted-revision-draft.v1` | 0 | required |
| ADVISORY_REVIEW | `advisory_review` / `advisory-review.v1` | 0–2 | required |
| REVIEW_REPAIR | `review_repair` / `review-repair.v1` | 0–1 | required |
| SEAL | `seal` / `proposal-seal.v1` | 0 | null |

The ordinal is the zero-based visit within that operation. At fingerprint
time, counters contain the number of already completed repairs: structured
repair is legal only with structured counter 0, targeted revision only with
targeted counter 0, advisory ordinal equals current review-repair counter, and
review-repair ordinal equals the counter before increment. The successful
operation checkpoint atomically records the incremented counter.
`model_request_fingerprint` uses tag `authoring-model-request.v1` over the
complete canonical request preimage above; it contains request bytes, schema,
limits and model identity but no credential.

`operation_fingerprint` uses tag `authoring-operation-fingerprint.v1` over
this preimage. Legal operation/counter/ordinal combinations are exhaustively
validated by the registry above. Recovery byte-compares the checkpointed
preimage/digest before reusing a completed operation.

Recovery never repeats a completed model or retrieval operation whose stable
fingerprint has a persisted successful result. An operation left ambiguous by
a crash fails with `AUTHORING_OPERATION_AMBIGUOUS`; it is not guessed or
silently repeated.

## 6. Proposal contracts and exact limits

### 6.1 Common immutable envelope

Every object in sections 6 and 9 is runtime-closed
(`additionalProperties:false` recursively); every listed field is required
unless its type explicitly contains null or `?`. Strings are well-formed
Unicode NFC, UUIDs are canonical lowercase, digests are lowercase 64-hex,
timestamps are UTC RFC 3339 with six fractional digits and numbers are
non-negative safe integers. Set-like arrays are unique and sorted by UTF-8
bytes.

```ts
type AuthoringWorkflowType =
  | 'directory' | 'outline' | 'content'
  | 'rewrite' | 'expand' | 'compress';

interface AuthoringInputSnapshotCommonV1 {
  snapshot_version: 'authoring-input-snapshot.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
}

type AuthoringInputSnapshotPreimageV1 =
  | (AuthoringInputSnapshotCommonV1 & {
      workflow_type: 'directory';
      additional_instruction: string | null;
    })
  | (AuthoringInputSnapshotCommonV1 & {
      workflow_type: 'outline';
      target_directory_node_id: string;
    })
  | (AuthoringInputSnapshotCommonV1 & {
      workflow_type: 'content';
      chapter_node_id: string;
      normalized_section_node_id: string;
      session_id: string | null;
      word_count: number;
      style: string;
      strict_citation: true;
    })
  | (AuthoringInputSnapshotCommonV1 & {
      workflow_type: 'rewrite';
      parent_result_id: string;
      instruction: string;
      additional_context: string | null;
      strict_citation: true;
    })
  | (AuthoringInputSnapshotCommonV1 & {
      workflow_type: 'expand' | 'compress';
      parent_result_id: string;
      target_word_count: number;
      strict_citation: true;
    });

type AuthoringInputSnapshotV1 = AuthoringInputSnapshotPreimageV1 & {
  input_digest: string;
};

interface ProjectDependencyV1 {
  dependency_version: 'project-dependency.v1';
  project_id: string;
  owner_user_id: string;
  name: string;
  type: string | null;
  target_audience: string | null;
  target_chapters: number;
  style: string;
  description: string | null;
  lock_version_decimal: string;
}

interface StyleTreeNodeDependencyV1 {
  node_key: string;
  title: string;
  requirement: string | null;
  children: StyleTreeNodeDependencyV1[];
}

interface StyleTemplateDependencyV1 {
  dependency_version: 'style-template-dependency.v1';
  template_id: string;
  name: string;
  status: 'completed';
  structure_tree: StyleTreeNodeDependencyV1;
  panel_a: StyleTreeNodeDependencyV1[];
  panel_b: StyleTreeNodeDependencyV1[];
  panel_c: StyleTreeNodeDependencyV1[];
  reference_file_ids: string[];
}

interface DirectoryNodeDependencyV1 {
  node_id: string;
  parent_node_id: string | null;
  node_type: 'chapter' | 'section';
  order_index: number;
  title: string;
  description: string | null;
  level_label: string;
  source_files: string[];
}

interface DirectoryVersionDependencyV1 {
  dependency_version: 'directory-version-dependency.v1';
  version_id: string;
  version_number: number;
  content: DirectoryNodeDependencyV1[];
}

interface OutlineVersionDependencyV1 {
  dependency_version: 'outline-version-dependency.v1';
  version_id: string;
  version_number: number;
  chapter_node_id: string;
  normalized_section_node_id: string;
  content: OutlinePersistenceContentV1;
}

interface ContentHeadDependencyV1 {
  dependency_version: 'content-head-dependency.v1';
  scope_key: string;
  lock_version_decimal: string;
  result_id: string | null;
  content_version_id: string | null;
}

interface ParentContentDependencyV1 {
  dependency_version: 'parent-content-dependency.v1';
  result_id: string;
  content_version_id: string;
  project_id: string;
  chapter_node_id: string;
  normalized_section_node_id: string;
  task_type: 'content' | 'rewrite' | 'expand' | 'compress';
  parent_result_id: string | null;
  content_text: string;
  content_utf8_byte_length: number;
  content_digest: string;
  ledger_contract_version: 'atomic:v1';
  grounding_assignment_digest: string;
}

interface AuthoringDependencySnapshotCommonV1 {
  snapshot_version: 'authoring-dependency-snapshot.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  project: ProjectDependencyV1;
}

type AuthoringDependencySnapshotPreimageV1 =
  | (AuthoringDependencySnapshotCommonV1 & {
      workflow_type: 'directory';
      style_template: StyleTemplateDependencyV1 | null;
      base_directory: DirectoryVersionDependencyV1 | null;
      project_state_lock_version_decimal: string;
    })
  | (AuthoringDependencySnapshotCommonV1 & {
      workflow_type: 'outline';
      target_directory: DirectoryVersionDependencyV1;
      target_node: DirectoryNodeDependencyV1;
      style_template: StyleTemplateDependencyV1;
      base_outline: OutlineVersionDependencyV1 | null;
      scope_lock_version_decimal: string;
    })
  | (AuthoringDependencySnapshotCommonV1 & {
      workflow_type: 'content';
      target_directory: DirectoryVersionDependencyV1;
      target_node: DirectoryNodeDependencyV1;
      outline: OutlineVersionDependencyV1;
      style_template: StyleTemplateDependencyV1;
      base_content_head: ContentHeadDependencyV1;
    })
  | (AuthoringDependencySnapshotCommonV1 & {
      workflow_type: 'rewrite' | 'expand' | 'compress';
      parent_content: ParentContentDependencyV1;
      base_content_head: ContentHeadDependencyV1;
    });

type AuthoringDependencySnapshotV1 =
  AuthoringDependencySnapshotPreimageV1 & {
    dependency_digest: string;
  };

interface AuthoringIndexEntryV1 {
  retrieval_run_id: string;
  index_version_id: string | null;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string;
  chunk_version: string | null;
  index_version: string;
  status: 'READY' | 'UNAVAILABLE';
  provider: string | null;
  collection_name: string | null;
  embedding_model: string | null;
  embedding_dimension: number | null;
  distance: string | null;
  sparse_parser: string | null;
  published_namespace: string | null;
  expected_point_count: number;
  observed_point_count: number | null;
}

interface AuthoringIndexSnapshotPreimageV1 {
  snapshot_version: 'authoring-index-snapshot.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  entries: AuthoringIndexEntryV1[];
}

type AuthoringIndexSnapshotV1 = AuthoringIndexSnapshotPreimageV1 & {
  index_digest: string;
};

interface AuthoringRetrievalQueryPlanV1 {
  task_type: 'directory' | 'outline' | 'content';
  intent: 'structure' | 'coverage' | 'explanation';
  original_query: string;
  sparse_query: string;
  dense_query: string;
  terms: string[];
}

interface AuthoringSelectedEvidenceRefV1 {
  retrieval_candidate_id: string;
  evidence_id: string;
  chunk_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string;
  candidate_rank: number;
  sparse_score: string | null;
  dense_score: string | null;
  fusion_score: string;
  rerank_score: string;
  evidence_snapshot_digest: string;
}

interface AuthoringRetrievalRunSnapshotV1 {
  retrieval_run_id: string;
  revision_attempt: 0 | 1;
  request_sha256: string;
  state: 'READY' | 'DEGRADED';
  query: string;
  task_type: 'directory' | 'outline' | 'content';
  query_plan: AuthoringRetrievalQueryPlanV1;
  mode: 'legacy' | 'shadow' | 'hybrid';
  gate_decision: boolean;
  canonical_path: 'hybrid' | 'legacy_like';
  retrieval_config_hash: string;
  selected_evidence: AuthoringSelectedEvidenceRefV1[];
}

interface AuthoringRetrievalSnapshotPreimageV1 {
  snapshot_version: 'authoring-retrieval-snapshot.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  index_digest: string;
  runs: AuthoringRetrievalRunSnapshotV1[];
}

type AuthoringRetrievalSnapshotV1 =
  AuthoringRetrievalSnapshotPreimageV1 & {
    retrieval_digest: string;
  };

interface AuthoringRepairCountersV1 {
  counters_version: 'authoring-repair-counters.v1';
  structured_output_repairs: 0 | 1;
  targeted_revision_attempts: 0 | 1;
  review_repairs: 0 | 1 | 2;
}

interface AuthoringBudgetSnapshotV1 {
  budget_version: 'authoring-budget-snapshot.v1';
  model_calls: number;
  model_input_tokens: number;
  model_output_tokens: number;
  cost_state: 'KNOWN' | 'UNKNOWN';
  cost_micro_usd: string | null;
}

interface AuthoringValidationResultV1 {
  result_version: 'authoring-validation-result.v1';
  validator_version: 'structured-authoring-validator.v1' | 'atomic-verifier.v1';
  decision: 'PASS';
  issue_codes: [];
  artifact_digest: string;
}

interface AuthoringReviewResultV1 {
  result_version: 'authoring-review-result.v1';
  reviewer_version:
    | 'structured-authoring-reviewer.v1'
    | 'grounded-authoring-reviewer.v1';
  decision: 'PASS';
  issue_codes: [];
  review_attempts: 1 | 2 | 3;
  artifact_digest: string;
}

interface BodyArtifactIdentityV1 {
  artifact_kind: 'body';
  artifact_schema_version: 'sealed-grounded-candidate.v1';
  artifact_digest: string;
  proposal_digest: string;
  render_context_digest: string;
  render_digest: string;
  candidate_assignment_digest: string;
  ledger_digest: string;
}

interface StructuredArtifactIdentityV1 {
  artifact_kind: 'directory' | 'outline';
  artifact_schema_version: 'directory-proposal.v1' | 'outline-proposal.v1';
  artifact_digest: string;
  structured_proposal_digest: string;
  persistence_artifact_digest: string;
  evidence_sidecar_digest: string;
  projector_version: 'structured-persistence-projector.v1';
}

interface AuthoringProposalEnvelopeCommonPreimageV1 {
  proposal_version: 'authoring-proposal.v1';
  sealed_payload_version: 'authoring-sealed-payload.v1';
  proposal_id: string;
  workflow_job_id: string;
  project_id: string;
  graph_version: 'deterministic-authoring-graph.v1';
  proposal_sequence: number;
  generation_attempt: number;
  input_snapshot_version: 'authoring-input-snapshot.v1';
  input_digest: string;
  dependency_snapshot_version: 'authoring-dependency-snapshot.v1';
  dependency_digest: string;
  retrieval_snapshot_version: 'authoring-retrieval-snapshot.v1';
  retrieval_digest: string;
  index_snapshot_version: 'authoring-index-snapshot.v1';
  index_digest: string;
  assignment_snapshot_version:
    | 'body-assignment-binding.v1'
    | 'structured-assignment-snapshot.v1';
  assignment_digest: string;
  repair_counters: AuthoringRepairCountersV1;
  budget_snapshot: AuthoringBudgetSnapshotV1;
  validation: AuthoringValidationResultV1;
  review: AuthoringReviewResultV1;
  created_at: string;
  expires_at: string;
  payload_scrub_after: string;
}

type AuthoringProposalEnvelopePreimageV1 =
  | (AuthoringProposalEnvelopeCommonPreimageV1 & {
      workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
      artifact_kind: 'body';
      artifact: BodyArtifactIdentityV1;
    })
  | (AuthoringProposalEnvelopeCommonPreimageV1 & {
      workflow_type: 'directory';
      artifact_kind: 'directory';
      artifact: StructuredArtifactIdentityV1 & {
        artifact_kind: 'directory';
        artifact_schema_version: 'directory-proposal.v1';
      };
    })
  | (AuthoringProposalEnvelopeCommonPreimageV1 & {
      workflow_type: 'outline';
      artifact_kind: 'outline';
      artifact: StructuredArtifactIdentityV1 & {
        artifact_kind: 'outline';
        artifact_schema_version: 'outline-proposal.v1';
      };
    });

type AuthoringProposalEnvelopeV1 = AuthoringProposalEnvelopePreimageV1 & {
  authoring_envelope_digest: string;
};
```

`authoring_envelope_digest` uses the tagged rule in 6.7 over
`AuthoringProposalEnvelopePreimageV1` only. The digest field is never part of
its own preimage. Runtime validation requires top-level/artifact kind and
workflow mapping to match exhaustively.

Client `chapter_title`/`section_title` never become positive input authority;
they are obtained from locked directory dependencies. Resolved word-count and
style defaults are stored, not recomputed. Style trees are limited to depth
8, 2,000 total nodes, 128 children per node and 1–500 UTF-8 bytes per
key/title/requirement; node keys are unique and children use stored order.
Index entries sort by retrieval-run/file/ingestion key; retrieval runs by
revision attempt/run ID; selected evidence by evidence ID. Scores are
Task10B fixed-decimal strings, never database floats.
Rewrite/expand/compress retrieval snapshots use retrieval
`task_type='content'`; only the outer input/dependency/envelope retains the
specific revision workflow type.

Golden fixtures contain exact preimage bytes, digest and complete envelope
bytes for all six workflow types.

The payload and digest are immutable while present. Lifecycle state may move
forward and a terminal payload may later be scrubbed under the retention rule.
Any regeneration inserts a new sequence; it never changes old sealed bytes.

Stable size failures:

- body proposal: Task 10B maximum 4 MiB UTF-8;
- directory proposal: 512 KiB UTF-8;
- outline proposal: 1 MiB UTF-8;
- input snapshot: 128 KiB; dependency snapshot: 6 MiB;
- retrieval and index snapshots: 2 MiB each; assignment snapshot: 2 MiB;
- common envelope: 64 KiB excluding sealed payload;
- complete canonical sealed payload: 15 MiB, below the 16 MiB MEDIUMBLOB
  boundary.

An excess is `AUTHORING_PROPOSAL_LIMIT_EXCEEDED`, disposition `FAILED`, and
never reaches review or approval.

### 6.2 Body proposal

Body workflows embed the complete `SealedGroundedCandidateV1`. The only bytes
allowed into business tables are `sealed_candidate.server_output.text`.
Existing Task 10B limits remain authoritative: 500 claims, 2,000 render
fragments, 256 nested items, 3 evidence IDs per claim and 1,000 UTF-8 bytes per
claim.

Task10B assignment/evidence snapshot digests are legacy source identities, not
Task11 canonical snapshot digests. Body seals this closed bridge:

```ts
interface BodyAssignmentBindingPreimageV1 {
  binding_version: 'body-assignment-binding.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  grounding_contract_version: 'atomic:v1';
  task10b_assignment_snapshot_digest: string;
  candidate_assignment_digest: string;
  retrieval_digest: string;
  index_digest: string;
  assigned_evidence_snapshot_digests: string[];
}

type BodyAssignmentBindingV1 = BodyAssignmentBindingPreimageV1 & {
  assignment_digest: string;
};
```

The evidence digest array is unique UTF-8-byte sorted. The new tagged
`assignment_digest` cannot be replaced by either Task10B source digest.

Any schema, domain, style or consistency repair creates a new structured model
proposal and re-runs the atomic canonicalizer, verifier, renderer and all six
digest computations. Before suspension these are versioned checkpoint
candidates; only the final reviewed candidate becomes an ACTIVE
`authoring_proposals` row in the atomic suspend transaction. A persisted
proposal is never repaired in place: owner resume first makes it SUPERSEDED
and a later run inserts a new sequence. Sealed candidates are never edited in
place, and their approval is never reused.

Before suspension and again inside commit, recovery validates the sealed
envelope, workflow/project/generation identity, assignment and retrieval
snapshots, input/dependency snapshots, exact renderer versions and
byte-for-byte server output.

### 6.3 Directory proposal

`DirectoryProposalV1` is the following closed runtime schema
(`additionalProperties:false` at every object):

```ts
interface EvidenceBoundTextV1 {
  text: string;
  evidence_ids: string[];
}

interface DirectoryProposalNodeV1 {
  proposal_key: string;
  parent_key: string | null;
  node_type: 'chapter' | 'section';
  order: number;
  title: EvidenceBoundTextV1;
  description: EvidenceBoundTextV1;
  level_label: EvidenceBoundTextV1;
}

interface DirectoryProposalV1 {
  schema_version: 'directory-proposal.v1';
  nodes: DirectoryProposalNodeV1[];
}

type DirectoryProposalPreimageV1 = DirectoryProposalV1;
```

`proposal_key` is ASCII `/^n_[a-z0-9]{1,61}$/` (63 bytes maximum) and unique.
Chapter `parent_key` is null; section `parent_key` names exactly one chapter
key. Evidence IDs use Task 10B
`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/` and must occur in the locked
assignment. Limits are:

- 1–100 chapters and 0–20 sections per chapter;
- at most 1,000 nodes and exactly two levels;
- title 1–200 UTF-8 bytes;
- description 0–2,000 UTF-8 bytes;
- level label 1–64 UTF-8 bytes;
- 1–8 unique assigned evidence IDs for every non-empty bound text; empty
  description is exactly `{text:'',evidence_ids:[]}`.

The canonicalizer rejects duplicate proposal keys, missing parents, cycles,
invalid depths, non-contiguous sibling order and unsupported properties. It
normalizes Unicode with the versioned canonicalizer.

Every model-generated bound text follows that evidence rule.
`STRUCTURAL_ONLY` is not part of the model schema and cannot be returned for
free text. It exists only on fixed server-generated bytes from the allowlist
`structural-literals.v1`—empty containers, ordinal fields and renderer
delimiters—and those bytes are never accepted from a model. Missing model-text
coverage enters `WAITING_MATERIAL` with `AUTHORING_EVIDENCE_GAP`.

### 6.4 Outline proposal

`OutlineProposalV1` targets one snapshotted current directory node and uses:

```ts
interface OutlinePointV1 {
  point_key: string;
  text: EvidenceBoundTextV1;
}

interface OutlineColumnV1 {
  column_key: string;
  name: EvidenceBoundTextV1;
  writing_guidance: EvidenceBoundTextV1;
  length_suggestion: EvidenceBoundTextV1;
  content_points: OutlinePointV1[];
}

interface OutlineProposalV1 {
  schema_version: 'outline-proposal.v1';
  target_directory_node_id: string;
  columns: OutlineColumnV1[];
  key_points: OutlinePointV1[];
  difficulties: OutlinePointV1[];
}

type OutlineProposalPreimageV1 = OutlineProposalV1;
```

All objects are closed. `column_key` is ASCII
`/^c_[a-z0-9]{1,61}$/`; `point_key` is ASCII
`/^p_[a-z0-9]{1,61}$/`; keys are unique in their containing proposal. The
target ID byte-matches the workflow snapshot. Limits are:

- 1–64 columns;
- column name 1–200 UTF-8 bytes;
- writing guidance 1–8,000 UTF-8 bytes per column;
- length suggestion 1–200 UTF-8 bytes;
- at most 128 content points per column, each at most 2,000 UTF-8 bytes;
- at most 128 global difficulty and 128 global key-point entries, each at most
  1,000 UTF-8 bytes;
- 1–8 unique assigned evidence IDs for every non-empty bound text.

Every content-point/difficulty/key-point text is 1 byte minimum. Empty bound
text is permitted only for directory description; all other required fields
reject empty text before the evidence gate.

Required template columns occur exactly once; unknown required columns and
extra properties are rejected. Every model-generated column name, guidance,
length suggestion, content point and difficulty/key-point entry binds at
least one assigned evidence reference. Only fixed server-rendered literals
from `structural-literals.v1` are evidence-free. Empty or invalid model-text
coverage enters `WAITING_MATERIAL`.

The target directory, style template and input versions must match their
snapshots at approval.

### 6.5 Structured assignment snapshot

Structured authoring does not reuse an incomplete display projection of
Task 10B evidence. It seals:

```ts
interface StructuredEvidenceSnapshotPreimageV1 {
  evidence_id: string;
  project_id: string;
  file_id: string;
  file_name: string;
  file_checksum_sha256: string;
  document_id: string;
  chunk_id: string;
  retrieval_run_id: string;
  ingestion_key: string;
  exact_span_text: string;
  page_start: number | null;
  page_end: number | null;
  heading_path: string[];
}

type StructuredEvidenceSnapshotV1 =
  StructuredEvidenceSnapshotPreimageV1 & {
    evidence_snapshot_digest: string;
  };

interface StructuredAssignmentSnapshotPreimageV1 {
  snapshot_version: 'structured-assignment-snapshot.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  retrieval_digest: string;
  index_digest: string;
  evidence: StructuredEvidenceSnapshotV1[];
}

type StructuredAssignmentSnapshotV1 =
  StructuredAssignmentSnapshotPreimageV1 & {
    assignment_digest: string;
  };
```

The snapshot service locks/revalidates the Task 10B evidence rows and their
owned `source_files` rows, then captures NFC `file_name`, non-null file
checksum/ingestion key and exact page/heading data. Limits are 1–12 evidence
entries, file name 1–2,000 UTF-8 bytes, exact span 1–65,536 bytes, at most 32
heading parts of 1–1,000 bytes, and non-negative 32-bit pages with
both pages null or both non-null and `page_start<=page_end`. Evidence is unique
and sorted by evidence ID. Missing
filename/checksum/ingestion metadata enters `WAITING_MATERIAL`; projector code
never reads live file metadata later.

`assignment_digest` uses the domain tag in 6.7 over the preimage
without its digest. Each `evidence_snapshot_digest` similarly uses
`structured-evidence-snapshot.v1` over its evidence object without that field.
This complete snapshot is stored in the sealed payload, and approval/commit
re-lock current rows and require its bytes/digest.

### 6.6 Sealed structured persistence artifacts

Before suspension, pure `structured-persistence-projector.v1` converts the
validated model proposal plus locked snapshots into two independently
canonicalized objects:

```ts
interface StructuredEvidenceSidecarV1 {
  sidecar_version: 'structured-evidence-sidecar.v1';
  json_pointer_version: 'rfc6901.v1';
  bindings: Array<{
    artifact_json_pointer: string;
    evidence_ids: string[];
  }>;
}

interface DirectoryPersistenceNodeV1 {
  node_id: string;
  parent_node_id: string | null;
  node_type: 'chapter' | 'section';
  order_index: number;
  title: string;
  description?: string;
  level_label: string;
  source_files: string[];
}

interface DirectoryPersistenceArtifactV1 {
  artifact_version: 'directory-persistence.v1';
  nodes: DirectoryPersistenceNodeV1[];
}

interface OutlinePersistenceSectionV1 {
  column: string;
  required: boolean;
  writing_guide: string;
  length_suggestion: string;
  content_points: string[];
}

interface OutlinePersistenceSourceRefV1 {
  file: string;
  pages?: string;
  relevance: string;
}

interface OutlinePersistenceContentV1 {
  node_title: string;
  level: string;
  sections: OutlinePersistenceSectionV1[];
  key_points: string[];
  difficulties: string[];
  source_refs: OutlinePersistenceSourceRefV1[];
}

interface OutlinePersistenceArtifactV1 {
  artifact_version: 'outline-persistence.v1';
  content: OutlinePersistenceContentV1;
}

type StructuredEvidenceSidecarPreimageV1 = StructuredEvidenceSidecarV1;
type DirectoryPersistenceArtifactPreimageV1 =
  DirectoryPersistenceArtifactV1;
type OutlinePersistenceArtifactPreimageV1 =
  OutlinePersistenceArtifactV1;

type AuthoringSealedPayloadV1 =
  | {
      payload_version: 'authoring-sealed-payload.v1';
      artifact_kind: 'body';
      envelope: Extract<AuthoringProposalEnvelopeV1, { artifact_kind: 'body' }>;
      input_snapshot: Extract<AuthoringInputSnapshotV1, {
        workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
      }>;
      dependency_snapshot: Extract<AuthoringDependencySnapshotV1, {
        workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
      }>;
      retrieval_snapshot: AuthoringRetrievalSnapshotV1;
      index_snapshot: AuthoringIndexSnapshotV1;
      assignment_snapshot: BodyAssignmentBindingV1;
      artifact: {
        artifact_kind: 'body';
        sealed_candidate: SealedGroundedCandidateV1;
      };
    }
  | {
      payload_version: 'authoring-sealed-payload.v1';
      artifact_kind: 'directory';
      envelope: Extract<AuthoringProposalEnvelopeV1, {
        artifact_kind: 'directory';
      }>;
      input_snapshot: Extract<AuthoringInputSnapshotV1, {
        workflow_type: 'directory';
      }>;
      dependency_snapshot: Extract<AuthoringDependencySnapshotV1, {
        workflow_type: 'directory';
      }>;
      retrieval_snapshot: AuthoringRetrievalSnapshotV1;
      index_snapshot: AuthoringIndexSnapshotV1;
      assignment_snapshot: StructuredAssignmentSnapshotV1;
      artifact: {
        artifact_kind: 'directory';
        proposal: DirectoryProposalV1;
        persistence_artifact: DirectoryPersistenceArtifactV1;
        evidence_sidecar: StructuredEvidenceSidecarV1;
      };
    }
  | {
      payload_version: 'authoring-sealed-payload.v1';
      artifact_kind: 'outline';
      envelope: Extract<AuthoringProposalEnvelopeV1, {
        artifact_kind: 'outline';
      }>;
      input_snapshot: Extract<AuthoringInputSnapshotV1, {
        workflow_type: 'outline';
      }>;
      dependency_snapshot: Extract<AuthoringDependencySnapshotV1, {
        workflow_type: 'outline';
      }>;
      retrieval_snapshot: AuthoringRetrievalSnapshotV1;
      index_snapshot: AuthoringIndexSnapshotV1;
      assignment_snapshot: StructuredAssignmentSnapshotV1;
      artifact: {
        artifact_kind: 'outline';
        proposal: OutlineProposalV1;
        persistence_artifact: OutlinePersistenceArtifactV1;
        evidence_sidecar: StructuredEvidenceSidecarV1;
      };
    };

type AuthoringSealedPayloadPreimageV1 = AuthoringSealedPayloadV1;
```

Every object above is closed and every listed non-optional field is present.
These shapes are strict subsets of the existing `DirectoryNodeDto` and
`OutlineContentDto` wire contracts and are the exact JSON written to their
business `content` columns. No class-transformer defaulting or unknown-field
stripping participates in positive persistence.

Sidecar invariants are exact:

- RFC 6901 escaping replaces `~` with `~0` then `/` with `~1`;
- 1–10,000 bindings, pointer length 1–512 UTF-8 bytes;
- bindings sort by pointer UTF-8 bytes and pointers are unique;
- each evidence list contains 1–8 unique snapshot IDs sorted by UTF-8 bytes;
- projector computes the required-pointer set: every non-empty
  model-projected directory title/description/level label, outline
  column/guide/length/content/key/difficulty text, and every projected
  source-ref field;
- node title/level copied from locked dependency snapshots are covered by
  `dependency_digest`, not falsely relabelled as model evidence;
- binding pointers equal the required-pointer set exactly—no missing, extra or
  duplicate binding.

Directory node UUIDs are assigned before approval using UUIDv5 namespace
`bf7c823a-2e7a-5dc6-9a2a-2da34d3608f7`. Name bytes are UTF-8 bytes of ASCII
`write-agent/directory-node.v1:` followed by canonical-json.v1 bytes of
`{workflow_job_id,generation_attempt,proposal_key}`. Parent IDs are projected
from the same sealed map. The exact `DirectoryNodeDto[]` includes those IDs,
orders and plain text. Empty description is omitted, non-empty level label is
copied, `material_support` is always omitted, and `source_files` is the sorted
unique snapshot `file_name` set referenced by that node's bound texts.
`parent_node_id` is always present: null for chapters and the sealed parent
UUID for sections. The approval transaction allocates no node ID.

Outline projection exactly matches the current DTO:

- `sections[]` comes from columns and uses `column`, template-owned `required`,
  `writing_guide`, `length_suggestion` and plain `content_points[]`;
- global `key_points[]` and `difficulties[]` come from their global proposal
  arrays;
- `node_title` and `level` come from locked directory/template snapshots;
- `source_refs[]` is server-derived from bound evidence snapshots, ordered by
  stable evidence ID; `file` is exact NFC `file_name`; `pages` is omitted when
  both pages are null, is decimal `N` when equal, and decimal `N-M` otherwise;
  `relevance` is the UTF-8 string form of canonical-json.v1 encoding of the
  sorted unique model-projected artifact JSON pointers for that evidence,
  excluding all `/content/source_refs/*` pointers to avoid recursion. The
  model cannot author source-ref display fields.

The sidecar binds every non-empty projected text JSON pointer to its assigned
evidence IDs. The final proposal envelope contains
`projector_version='structured-persistence-projector.v1'`,
`persistence_artifact_digest` and `evidence_sidecar_digest`; sealed payload
contains proposal, persistence artifact and sidecar bytes. Approval binds all
three digests. Positive commit re-runs the projector from locked snapshots,
requires byte/digest equality and writes the sealed persistence artifact
without mutation.

Sealing order is component snapshots/digests → artifact/digests → outer
envelope/digest → complete payload canonical bytes. `sealed_payload_digest`
uses its own tag over the complete `AuthoringSealedPayloadV1`; it is stored
beside the BLOB and intentionally is not inside the payload/envelope, avoiding
a digest cycle. Reads require the original BLOB to byte-match a
re-canonicalized closed payload before any component is trusted.

### 6.7 Digest domains

All new Task11 digests use
`sha256(version_tag + "\0" + canonical_json_v1_bytes)` with these exact ASCII
tags:

- `authoring-input-snapshot.v1`;
- `authoring-dependency-snapshot.v1`;
- `authoring-index-snapshot.v1`;
- `authoring-retrieval-snapshot.v1`;
- `body-assignment-binding.v1`;
- `authoring-sealed-payload.v1`;
- `authoring-proposal-envelope.v1`;
- `authoring-rollout-policy.v1`;
- `authoring-runtime-manifest.v1`;
- `authoring-model-request.v1`;
- `authoring-scope-key.v1`;
- `structured-evidence-snapshot.v1`;
- `structured-assignment-snapshot.v1`;
- `structured-proposal.v1`;
- `structured-persistence-artifact.v1`;
- `structured-evidence-sidecar.v1`;
- `grounded-authoring-approval.v1`;
- `structured-authoring-approval.v1`;
- `authoring-operation-fingerprint.v1`;
- `workflow-transition-instance.v1`;
- `workflow-transition.v1`;
- `storage-operation.v1`;
- `authoring-domain-commit-receipt.v1`.

The remaining tag→preimage mapping is exact:

| Tag | Preimage |
|---|---|
| `authoring-rollout-policy.v1` | `AuthoringRolloutPolicySnapshotPreimageV1` |
| `authoring-runtime-manifest.v1` | `AuthoringRuntimeManifestPreimageV1` |
| `authoring-model-request.v1` | `ModelRequestFingerprintPreimageV1` |
| `structured-evidence-snapshot.v1` | `StructuredEvidenceSnapshotPreimageV1` |
| `structured-assignment-snapshot.v1` | `StructuredAssignmentSnapshotPreimageV1` |
| `structured-proposal.v1` | `DirectoryProposalPreimageV1 | OutlineProposalPreimageV1`, distinguished by `schema_version` |
| `structured-persistence-artifact.v1` | `DirectoryPersistenceArtifactPreimageV1 | OutlinePersistenceArtifactPreimageV1`, distinguished by `artifact_version` |
| `structured-evidence-sidecar.v1` | `StructuredEvidenceSidecarPreimageV1` |
| `authoring-sealed-payload.v1` | `AuthoringSealedPayloadPreimageV1` |
| `authoring-scope-key.v1` | `AuthoringScopeKeyPreimageV1` |
| `storage-operation.v1` | `StorageOperationPreimageV1` |
| `authoring-operation-fingerprint.v1` | `AuthoringOperationFingerprintPreimageV1` |
| `workflow-transition-instance.v1` | `WorkflowTransitionInstancePreimageV1` |
| `workflow-transition.v1` | `WorkflowTransitionPreimageV1` |

Every Task11 digest references its exact `*PreimageV1` type above and excludes
only its own digest field; “preceding fields” is not a valid implementation
rule.
`ParentContentDependencyV1.content_digest` is the one raw-text Task11 digest:
`sha256_utf8('parent-content-text.v1' + '\0' + content_text)`.

The nested Task10B candidate is byte-for-byte reused and keeps its existing
algorithms rather than being reinterpreted:

```text
proposal_digest =
  tagged('grounded-draft.v1', canonical_proposal)
render_context_digest =
  tagged('approved-render-context.v1', render_context)
render_digest =
  sha256_utf8('atomic-renderer.v1' + '\0' + server_output.text)
candidate_assignment_digest =
  sha256_utf8('atomic:v1' + '\0' + task10b_assignment_snapshot_digest)
ledger_digest =
  tagged('atomic-claim-ledger.v1', claims)
candidate_envelope_digest =
  tagged('sealed-grounded-candidate.v1',
    candidate excluding only digests.envelope_digest)
```

Task10B untagged database assignment/evidence snapshot digests are retained
only inside the new tagged body/structured bindings. They never substitute
for a Task11 digest. Golden fixtures store tag, exact canonical preimage bytes,
digest and complete envelope/payload bytes.

Wire `artifact_kind` values are lowercase `body|directory|outline`. Fixed
mapping `artifact-kind-map.v1` stores them as uppercase
`BODY|DIRECTORY|OUTLINE`; only lowercase wire values participate in canonical
proposal/envelope digests. Directory and outline fixtures include exact
canonical JSON bytes and digest goldens.

## 7. Validators, review and budgets

Validators run in fixed order:

1. runtime schema;
2. artifact/domain invariants;
3. evidence ownership and coverage;
4. style-template invariants;
5. cross-artifact consistency;
6. atomic claim verifier for body;
7. approval-readiness.

A model review produces only bounded issue codes. Deterministic code maps them
to `PASS | REPAIR_REQUIRED | WAITING_MATERIAL | FAILED`. Repair prompts contain
the previous proposal, allowlisted issue codes and the current assignment.

Worst-case provider attempts are closed:

| Operation | Maximum attempts |
|---|---:|
| query plan | 1 |
| initial structured draft | 1 |
| structured-output repair | 1 |
| targeted evidence revision draft | 1 |
| advisory review: initial + after each review repair | 3 |
| review repair draft | 2 |
| **total** | **9** |

Every authoring `ModelRequest` sets gateway `max_retries=0` and
`max_repair_attempts=0`; provider SDK retries are disabled for the selected
operation. Therefore one graph attempt equals one billable provider attempt
and one `model_runs` row. A provider integration that cannot disable hidden
retries is ineligible for positive authoring and fails startup policy
validation.

Total per-job maxima are:

- 9 provider attempts;
- 200,000 input tokens;
- 64,000 output tokens;
- 2,000,000 micro USD using the pricing digest persisted in the rollout
  policy.

The existing `ModelPricingCatalog` remains the price source. Before a call, the
gateway looks up the exact persisted provider/model price.
`utf8-byte-upper-bound.v1` counts the UTF-8 bytes of the complete canonical
request—roles, message content, tool/schema bytes and fixed separators—and
uses that number as a conservative input-token reservation. Output reservation
is the request `max_tokens`.

Reservation cost uses full, non-cached input price and rounds upward to an
integer micro-USD; actual cost uses the existing `ModelPricingCatalog` BigInt
formula and its one-time half-up conversion from decimal USD to micro-USD.
After completion, the reservation is replaced with actual `model_runs`
usage/cost. A call that
would exceed any maximum is not started and fails with
`AUTHORING_BUDGET_EXCEEDED`. A model absent from the price catalog is rejected
in positive mode with `AUTHORING_MODEL_PRICE_UNKNOWN`. Shadow records the
operation/model as `price_state=UNKNOWN` in its persisted closed policy
snapshot, enforces call/input/output limits, records cost as unknown and can
produce only `SHADOW_COMPLETED`. Missing/invalid provider usage after a
successful positive response fails with `AUTHORING_USAGE_UNKNOWN`; no
approval or business write is produced.

## 8. Database contract

All new authoring and storage tables use InnoDB and
`utf8mb4_0900_ai_ci`; digest, enum and canonical-byte columns explicitly use
ASCII/binary collations as stated.
All timestamps are `DATETIME(6)`.

### 8.1 `workflow_jobs` additions

| Column | Contract |
|---|---|
| `workflow_definition` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'legacy-generation.v1'` |
| `authoring_mode` | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'off'` |
| `rollout_policy_version` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'authoring-rollout.v1'` |
| `rollout_policy_snapshot` | `MEDIUMBLOB NULL`; required for deterministic definitions |
| `rollout_policy_digest` | `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL` |
| `server_entrypoint` | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'legacy_api'` |
| `client_contract_version` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL` |

Named CHECK constraints enumerate definition/mode/entrypoint values and
require both snapshot and digest for deterministic definitions and both null
for legacy/atomic-shadow definitions. Existing rows are explicitly backfilled
as legacy/off/legacy_api with null snapshot/digest before constraints are
added. Defaults permit an old binary to omit the new columns, but such rows can
only be legacy.

`workflow_events` gains nullable
`transition_instance_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin` and
`transition_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin`, named CHECK
requiring both null or both non-null, and unique
`uq_workflow_events_job_transition(job_id,transition_key)`. Existing rows are
backfilled with both null; MySQL permits multiple null keys. New authoring
transitions must supply the key defined in section 11, while legacy event
writers may keep it null outside enforce.

### 8.2 `authoring_proposals`

| Column | Contract |
|---|---|
| `id` | `VARCHAR(36) PRIMARY KEY`, matching existing UUID columns exactly |
| `workflow_job_id` | `VARCHAR(36) NOT NULL`, FK job `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `project_id` | `VARCHAR(36) NOT NULL`, FK project `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `proposal_sequence` | `INT UNSIGNED NOT NULL` |
| `artifact_kind` | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `state` | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `sealed_payload` | `MEDIUMBLOB NULL` |
| `sealed_payload_version` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `sealed_payload_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `authoring_envelope_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `proposal_digest` | `CHAR(64) ascii_bin NOT NULL`; grounded or structured canonical proposal digest |
| `artifact_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `input_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `dependency_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `retrieval_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `index_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `assignment_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `candidate_assignment_digest` | `CHAR(64) ascii_bin NULL` |
| `render_context_digest` | `CHAR(64) ascii_bin NULL` |
| `render_digest` | `CHAR(64) ascii_bin NULL` |
| `ledger_digest` | `CHAR(64) ascii_bin NULL` |
| `candidate_envelope_digest` | `CHAR(64) ascii_bin NULL` |
| `evidence_sidecar_digest` | `CHAR(64) ascii_bin NULL` |
| `contract_versions` | `JSON NOT NULL` |
| `repair_counters` | `JSON NOT NULL` |
| `budget_snapshot` | `JSON NOT NULL` |
| `expires_at` | `DATETIME(6) NOT NULL` |
| `payload_scrub_after` | `DATETIME(6) NOT NULL` |
| `payload_scrubbed_at` | `DATETIME(6) NULL` |
| `active_marker` | generated stored `TINYINT AS (CASE WHEN state IN ('ACTIVE','APPROVED') THEN 1 ELSE NULL END)` |
| `created_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` |
| `updated_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)` |

Allowed states are
`ACTIVE | APPROVED | COMMITTED | SUPERSEDED | EXPIRED | SHADOW_COMPLETED`.
Unique indexes are `(workflow_job_id, proposal_sequence)` and
`(workflow_job_id, active_marker)`. Secondary index order is
`(project_id, state, expires_at)` and
`(state, payload_scrubbed_at, payload_scrub_after, updated_at)`.
Before retention scrubbing, `sealed_payload` is present in every proposal
state. It is immutable until an eligible terminal-state retention sweep.

Named artifact CHECKs require:

- `artifact_kind IN ('BODY','DIRECTORY','OUTLINE')`;
- BODY has non-null assignment/render-context/render/ledger/candidate digests
  plus `candidate_assignment_digest`, and null evidence-sidecar digest;
- DIRECTORY/OUTLINE have non-null assignment/evidence-sidecar digests and null
  candidate-assignment/render-context/render/ledger/candidate digests;
- exactly one payload shape is legal:
  `(payload_scrubbed_at IS NULL AND sealed_payload IS NOT NULL)` or
  `(payload_scrubbed_at IS NOT NULL AND sealed_payload IS NULL AND state IN
  ('COMMITTED','SUPERSEDED','EXPIRED','SHADOW_COMPLETED'))`.

The proposal-finalization transaction reads one locked MySQL `NOW(6)` and the
retention days from that job's verified persisted rollout-policy snapshot.
It stores `payload_scrub_after=TIMESTAMPADD(DAY,retention_days,locked_now)`;
the value is immutable and is not recomputed from current environment
configuration.

Named `BEFORE UPDATE` trigger
`trg_authoring_proposals_immutable_bu` rejects changes to proposal ID, job,
project, sequence, artifact kind, every digest/version/contract/counter/budget
field, expiry/scrub-after or creation time. It permits only a transition in the
closed state machine plus `updated_at`, or the one-way scrub shape
`OLD.sealed_payload IS NOT NULL`, `NEW.sealed_payload IS NULL`,
`OLD.payload_scrubbed_at IS NULL`, `NEW.payload_scrubbed_at IS NOT NULL` when
both old and new state are the same eligible terminal state and immutable
`payload_scrub_after<=NOW(6)`. It rejects payload replacement, null-to-bytes
restoration, early scrub and state-plus-scrub updates with
`AUTHORING_PROPOSAL_IMMUTABLE`. The sweeper performs the byte-level
canonical/digest revalidation immediately before this trigger-guarded CAS;
the trigger is the independent column/state/time backstop, not a JSON
canonicalizer.

Named `BEFORE INSERT` trigger
`trg_authoring_proposals_immutable_bi` permits only initial ACTIVE or
SHADOW_COMPLETED rows, requires non-null payload, null scrub timestamp,
`created_at<expires_at`, `created_at<payload_scrub_after`, and exact
artifact/digest shape. The seal procedure additionally requires both times to
equal its locked policy-derived expressions. Legal later transitions are
exactly ACTIVE→APPROVED, ACTIVE→SUPERSEDED, ACTIVE→EXPIRED,
APPROVED→COMMITTED and APPROVED→SUPERSEDED. COMMITTED, SUPERSEDED, EXPIRED and
SHADOW_COMPLETED are terminal; only the same-state retention scrub mutation is
allowed. There is no direct INSERT of an already scrubbed or APPROVED/
COMMITTED proposal.

### 8.3 `authoring_approvals` and invalidations

`authoring_approvals`:

| Column | Contract |
|---|---|
| `id` | `VARCHAR(36) PRIMARY KEY`, matching existing UUID columns exactly |
| `proposal_id` | `VARCHAR(36) NOT NULL UNIQUE`, FK proposal `ON DELETE RESTRICT` |
| `workflow_job_id` | `VARCHAR(36) NOT NULL`, FK job `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `project_id` | `VARCHAR(36) NOT NULL`, FK project `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `proposal_sequence` | `INT UNSIGNED NOT NULL` |
| `artifact_kind` | `VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `approved_by` | `VARCHAR(36) NOT NULL`, FK user `ON DELETE RESTRICT ON UPDATE RESTRICT` |
| `approval_version` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `capability_version` | `VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` |
| `authoring_envelope_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `sealed_payload_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `artifact_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `input_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `dependency_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `retrieval_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `index_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `assignment_digest` | `CHAR(64) ascii_bin NOT NULL` |
| `approval_nonce` | `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE` |
| `approval_envelope` | `MEDIUMBLOB NOT NULL` canonical JSON bytes |
| `approval_digest` | `CHAR(64) ascii_bin NOT NULL UNIQUE` |
| `approved_at` | `DATETIME(6) NOT NULL`, inserted from locked MySQL time |
| `created_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` |

There is no unique workflow-job constraint: a superseded proposal can be
replaced and independently approved.
The proposal table has unique closure
`(id,workflow_job_id,project_id,proposal_sequence)`;
approval uses one composite FK across those four columns in addition to its
owned-user FK. Independent same-looking scalar IDs cannot be combined.
Legacy `workflow_jobs.approved_at` may mirror the first approval timestamp for
display compatibility, but it is never parsed as authority and cannot mint a
capability.

`authoring_approval_invalidations` has `approval_id VARCHAR(36)` as its
primary/FK key (`ON DELETE RESTRICT ON UPDATE RESTRICT`), plus
`reason_code VARCHAR(64) NOT NULL`,
`invalidated_by VARCHAR(36) NULL` with user FK
`ON DELETE RESTRICT ON UPDATE RESTRICT`, and
`created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`. Approval bytes
remain immutable; invalidation is a separate audit row.

### 8.4 Stable scope locks and content heads

`projects` and `project_states` each gain
`lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0`; existing rows backfill to
zero before NOT NULL is installed.
`ProjectDependencyV1.lock_version_decimal` is the locked
`projects.lock_version`, and directory
`project_state_lock_version_decimal` is the locked
`project_states.lock_version`. `authoring_scope_locks.lock_version` supplies
outline `scope_lock_version_decimal`; `content_current_heads.lock_version`
supplies `ContentHeadDependencyV1.lock_version_decimal`. Each snapshot value
uses the same full-precision canonical decimal-string rule as storage BIGINTs.

Counters have one exact mutation rule:

- any change to project metadata, active style/template selection, referenced
  template content/status, or live material membership/checksum atomically
  increments `projects.lock_version`;
- every directory pointer/current-marker change increments
  `project_states.lock_version`;
- every outline current-marker change increments that outline scope's
  `authoring_scope_locks.lock_version`;
- every body head/manual-edit/legacy-head change increments both the content
  scope-lock version and `content_current_heads.lock_version`;
- counter update, affected business rows and resulting event are one
  transaction; overflow at unsigned BIGINT max is a terminal
  `AUTHORING_LOCK_VERSION_EXHAUSTED`.

Snapshot records the pre-mutation values. Approval re-locks and compares them;
positive/legacy commit includes those values in its CAS and increments exactly
once. A same-baseline second proposal therefore drifts instead of replacing a
newer current. Entity mappings and the schema contract include both new
columns; direct project/material/template writers are replaced by the
procedure-only paths in 4.3.

`authoring_scope_locks`:

- `project_id VARCHAR(36) NOT NULL`;
- `scope_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL` with
  named CHECK for
  `OUTLINE_NODE | CONTENT_NODE`;
- `scope_key CHAR(64) ascii_bin NOT NULL`;
- `lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0`;
- `created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`;
- `updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ON UPDATE CURRENT_TIMESTAMP(6)`;
- primary key `(project_id, scope_kind, scope_key)`;
- project FK `ON DELETE RESTRICT ON UPDATE RESTRICT`.

Scope rows are inserted idempotently when the workflow snapshot is created,
so the first version has a stable row to lock. `scope_key` uses the tagged
digest rule from 6.7 with tag `authoring-scope-key.v1` over this closed union:

```ts
type AuthoringScopeKeyPreimageV1 =
  | {
      scope_kind: 'DIRECTORY';
      project_id: string;
    }
  | {
      scope_kind: 'OUTLINE_NODE';
      project_id: string;
      directory_node_id: string;
    }
  | {
      scope_kind: 'CONTENT_NODE';
      project_id: string;
      chapter_node_id: string;
      normalized_section_node_id: string;
    };
```

IDs use exact stored strings and the section sentinel is `''`; no locale or
case normalization is applied.

`content_current_heads`:

- `project_id VARCHAR(36) NOT NULL`;
- `chapter_node_id VARCHAR(100) NOT NULL` and
  `normalized_section_node_id VARCHAR(100) NOT NULL`, matching existing
  writing-result node widths; chapter-only scope uses the fixed empty-string
  section sentinel;
- `result_id VARCHAR(36) NOT NULL`;
- `content_version_id VARCHAR(36) NOT NULL`;
- `lock_version BIGINT UNSIGNED NOT NULL DEFAULT 0`;
- `created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`;
- `updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ON UPDATE CURRENT_TIMESTAMP(6)`;
- primary key `(project_id, chapter_node_id,
  normalized_section_node_id)`;
- unique `content_version_id`;
- `writing_results` gains generated stored
  `normalized_section_node_id VARCHAR(100) AS
  (COALESCE(section_node_id,''))`;
- unique parent keys `writing_results(project_id,id)` and
  `writing_results(project_id,chapter_node_id,
  normalized_section_node_id,id)`, plus
  `content_versions(result_id,id)`;
- composite head FK
  `(project_id,chapter_node_id,normalized_section_node_id,result_id)` to the
  exact writing-result scope, and
  `(result_id,content_version_id)` to those keys, both
  `ON DELETE RESTRICT ON UPDATE RESTRICT`.

The scope/result FK makes a mismatched chapter/section/result impossible, and
the version FK makes `result A + version B` impossible.
For a never-written scope, the dependency snapshot uses
`{lock_version_decimal:'0',result_id:null,content_version_id:null}` after locking the
existing scope-lock row and proving no head row. Commit CAS requires the head
still absent, inserts it with `lock_version=1` and increments the scope lock.

Body version counters have two distinct, closed scopes:

- `writing_results.version_number` is the authoring-result ordinal for
  `(project_id,chapter_node_id,normalized_section_node_id)`. It starts at 1
  and is allocated only after locking that scope's
  `authoring_scope_locks` row. The schema adds
  `uq_writing_results_scope_version(project_id,chapter_node_id,
  normalized_section_node_id,version_number)`. Migration preflight rejects
  empty/missing chapter IDs and then reconciles
  `writing_results.chapter_node_id` to `VARCHAR(100) NOT NULL`.
- `content_versions.version_number` is the immutable edit ordinal inside one
  `writing_results.id`. It starts at 1 and remains protected by
  `uq_content_versions_scope_version(result_id,version_number)`.

A positive body workflow creates a new writing result at the next scope
ordinal and its initial content version at result-local ordinal 1. A legacy
body writer outside enforce follows the same scope lock and allocation rule.
A legacy manual PATCH keeps the same writing result, creates only the next
result-local content version and does not change
`writing_results.version_number`.

Directory current state is the invariant pair
`project_states.current_directory_version_id` plus the matching
`directory_versions.is_current=1`; neither is authoritative alone. Schema
adds unique parent key `directory_versions(project_id,id)` and replaces the
old single-column `project_states_current_directory_version_id_fkey` with
composite
`project_states_current_directory_project_fkey(project_id,
current_directory_version_id)` referencing that parent key
`ON DELETE RESTRICT ON UPDATE RESTRICT`. The existing unique current marker
per project remains.

Before adding the composite FK, migration locks/preflights each project:

1. reject a pointer to another project and more than one current marker;
2. if exactly one current marker exists, use it, require any non-null pointer
   to match, and fill a null pointer;
3. otherwise, if a valid same-project pointer exists, mark only that version
   current;
4. otherwise choose `version_number DESC,created_at DESC,id DESC`, or null
   when the project has no directory version;
5. update pointer and marker together, record selected IDs/digest, prove the
   invariant, then install the composite FK.

An existing mismatching non-null pointer/marker pair is
`DIRECTORY_CURRENT_BACKFILL_INCOMPATIBLE`; migration does not silently choose
between two asserted currents. Directory snapshot first idempotently creates
a missing `project_states` row with a null pointer. Every positive and legacy
directory commit locks the project and project-state row, allocates its
version, switches the old/new markers and updates the pointer in the same
transaction. Current-directory reads join the pointer to a same-project
version and require `is_current=1`; zero/multiple/mismatch is
`DIRECTORY_CURRENT_CORRUPT`, never a fallback query.

Outline and content commit lock their `authoring_scope_locks` row before
reading `MAX(version)`, switching current markers or changing a head.

Latest editor reads, export selection and rewrite/expand/compress parent
selection must join `content_current_heads`; they may not order arbitrary
`writing_results` or `content_versions` by creation/version time.

#### Existing-data head backfill

Before readers switch, migration backfills one head per existing content
scope using the legacy observable rule:

1. require non-empty `chapter_node_id`; normalize scope as
   `(project_id,chapter_node_id,section_node_id ?? '')`; a selected result with
   missing/empty chapter is incompatible even when section is present;
2. reconcile `writing_results.version_number` for every valid scope before
   creating its unique key: rows are ordered by `created_at ASC,id ASC` and
   assigned consecutive ordinals starting at 1; the migration records old and
   new ordinals in its reconciliation report, and any missing project/chapter
   or value outside the SQL `INT` range stops with
   `CONTENT_SCOPE_VERSION_BACKFILL_INCOMPATIBLE`;
3. preflight and create
   `uq_writing_results_scope_version`; also prove the existing
   `uq_content_versions_scope_version` has the exact columns, order and
   uniqueness contract;
4. consider only `writing_results.status='succeeded'`;
5. choose result by `completed_at DESC, created_at DESC, id DESC`;
6. within that result, require at most one `content_versions.is_current=1`;
   choose it, otherwise choose `version_number DESC, created_at DESC, id DESC`;
7. if the chosen result has no version, insert a deterministic baseline
   version with `version_number=1`, exact `writing_results.content_text`,
   `is_current=1` and `grounding_state='LEGACY_UNVERIFIED'`;
8. insert the scope lock and head to the selected result/version.

Duplicate current rows inside one result, duplicate version numbers, missing
node/project/result references or a selected version whose result scope
differs stop before reader cutover with
`CONTENT_HEAD_BACKFILL_INCOMPATIBLE`. The migration records counts and a digest
of selected IDs, not content bytes.

In off/shadow or non-allowlisted compatibility mode, every legacy body writer
must lock `authoring_scope_locks`, create/select its content version and
upsert `content_current_heads` in the same transaction. Legacy
directory/outline saves likewise lock `project_states` or their stable scope
row before version/current changes. In enforce, the common policy guard
rejects these writers before transaction entry.

#### Manual body edits

Both `writing_results.content_text` and `content_versions.content_text` are
reconciled to `MEDIUMTEXT NOT NULL` and their TypeORM entities use
`type:'mediumtext'`. Migration first proves every existing value is within the
16 MiB column limit, then alters without content conversion. The 4 MiB body
proposal cap therefore fits the business columns with headroom; exact UTF-8
byte checks still run before positive insert.

`content_versions` gains
`grounding_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
DEFAULT 'LEGACY_UNVERIFIED'` with values
`LEGACY_UNVERIFIED | ATOMIC_APPROVED`. Task 11 never mutates approved
`writing_results.content_text` or a version in place.

- For an enforce project, existing `PATCH /content/:resultId` returns
  `AUTHORING_MANUAL_EDIT_REQUIRES_WORKFLOW` and performs no write.
- Outside enforce, PATCH locks the current head, creates a new
  `LEGACY_UNVERIFIED` content version, switches the head/current marker and
  leaves the base result and existing ledgers immutable.
- GET-by-ID returns the requested immutable result/version plus
  `is_scope_current` and its grounding state; it never substitutes another
  result. Editor-latest, export and revision-parent selection render the scope
  head. Citation reads for a `LEGACY_UNVERIFIED` version return the stable
  unsupported status `CONTENT_UNVERIFIED`; they never reuse an older atomic
  ledger.
- Positive body commit writes `ATOMIC_APPROVED`. Rewrite/expand/compress may
  use only the head selected by scope; positive revision requires that head to
  be `ATOMIC_APPROVED`, otherwise it suspends with
  `AUTHORING_PARENT_UNVERIFIED`. Legacy revision retains the unverified path
  only outside enforce.

### 8.5 Grounding assignment invalidation

`grounding_assignments` gains:

- `generation_attempt INT UNSIGNED NOT NULL DEFAULT 0`;
- `invalidated_at DATETIME(6) NULL`;
- `invalidation_reason VARCHAR(64) NULL`.

The unique identity becomes `(workflow_job_id, generation_attempt)`; the
existing primary key is reconciled through a forward migration. Positive
commit accepts only the non-invalidated assignment whose generation attempt
matches the proposal.

Grounding/citation rows are version- and generation-bound:

- `grounding_claims` gains
  `content_version_id VARCHAR(36) NULL` and
  `generation_attempt INT UNSIGNED NOT NULL DEFAULT 0` and
  `ledger_contract_version VARCHAR(32) NOT NULL DEFAULT 'legacy:v0'`;
- `citation_maps` gains `content_version_id VARCHAR(36) NULL` and the same
  `ledger_contract_version`;
- allowed ledger contracts are `legacy:v0|atomic:v1`;
- atomic claims require non-null `content_version_id` and `atomic_claim`;
- atomic citation maps require non-null `content_version_id` and `claim_id`;
- legacy rows remain nullable and read as unverified.

Exact relational guards are:

- unique grounding assignment
  `(workflow_job_id,generation_attempt,project_id)`;
- reconciled FKs
  `grounding_assignments_workflow_fkey(workflow_job_id)`,
  `grounding_assignments_project_fkey(project_id)` and
  `grounding_assignments_run_fkey(retrieval_run_id)` all use
  `ON DELETE RESTRICT ON UPDATE RESTRICT`;
- claim composite FK
  `(workflow_job_id,generation_attempt,project_id)` to that assignment;
- claim composite FK `(project_id,result_id)` to
  `writing_results(project_id,id)`;
- claim composite FK `(result_id,content_version_id)` to
  `content_versions(result_id,id)`;
- unique claim closure
  `(claim_id,project_id,result_id,content_version_id)`;
- citation-map composite FK
  `(claim_id,project_id,result_id,content_version_id)` to that claim closure;
- citation-map composite FK `(result_id,content_version_id)` to the
  content-version key;
- atomic claim offset uniqueness
  `(content_version_id,output_char_start,output_char_end)`.

Migration backfills assignment generation zero. Existing legacy claim/map rows
keep null content-version IDs and cannot be reported as atomic supported.
Positive commit inserts version, claim and map rows with one matching
generation in the same transaction.
An existing claim without its job/project assignment or an existing non-null
map `claim_id` without a claim stops pre-DDL with
`GROUNDING_LEDGER_BACKFILL_INCOMPATIBLE`; the migration does not invent trust
links.

Citation controller/service, export and revision inheritance first resolve the
scope head/version, then join claim→assignment on exact job/generation/project
and require `invalidated_at IS NULL`; maps join that exact claim and content
version. A manual unverified head therefore cannot expose a prior version's
ledger even when it shares `result_id`.

### 8.6 Project and user tombstones

Authoring approvals are permanent audit facts, so Task 11 changes project
deletion to tombstoning rather than guessing a cascade order:

- `projects.deleted_at DATETIME(6) NULL` and
  `deleted_by VARCHAR(36) NULL` are added;
- `chk_projects_tombstone` requires both fields null or both non-null, and
  `idx_projects_user_deleted(user_id,deleted_at,id)` supports scoped reads;
- `ProjectService.remove()` locks the project and its non-terminal jobs; in one
  transaction it locks jobs in ID order, sets `cancel_requested_at`, changes
  those jobs to STOPPED, clears leases, appends stop events, then sets the
  tombstone and project deletion event. Any running worker loses its fence
  before business commit;
- normal list/read/access policy treats a tombstoned project as not found;
- authoring proposal/approval/head/business FKs use
  `ON DELETE RESTRICT ON UPDATE RESTRICT`;
- a project with an APPROVED proposal gets an approval invalidation before the
  proposal is superseded/stopped in the same tombstone transaction.

User deletion is also a tombstone:

- add `users.deleted_at DATETIME(6) NULL` and
  `users.disabled_at DATETIME(6) NULL`;
- replace existing `projects_user_id_fkey ON DELETE CASCADE` with
  `ON DELETE RESTRICT ON UPDATE RESTRICT` in the forward migration and exact
  application schema contract;
- `UserService.remove()` locks the user/projects/jobs, tombstones every active
  project in project-ID order and jobs in job-ID order using the transaction
  above, revokes refresh tokens, then sets both user timestamps;
- project creation locks its user row and rechecks both user tombstone fields
  before inserting, so it serializes with user deletion;
- auth/login/refresh and all normal user/project queries require null user and
  project tombstones;
- physical user/project delete is unsupported by runtime services. Task 11
  reconciles the authoring-domain relationships
  `project_states→projects`, `directory_versions→projects`,
  `outline_versions→projects`, `writing_results→projects`,
  `content_versions→writing_results` and `source_files→projects` from their
  legacy CASCADE/SET NULL
  actions to `ON DELETE RESTRICT ON UPDATE RESTRICT`; the directory current
  pointer becomes the composite RESTRICT FK in 8.4. Unrelated legacy
  document/chunk/session/message relationships retain their current schema
  actions but cannot be reached by an application physical-project delete.

Physical privacy purge/anonymization is a separately authorized operation and
is not implemented by Task 11. No current delete path silently destroys an
approval or digest trail. Retained email/actor identity is an explicit
remaining privacy risk documented in the final report.

### 8.7 Migration/reconciliation contract

The forward migration and `application-schema-contract.ts` must describe every
column, generated expression, default, nullability, CHECK, index order, FK
action, engine, charset and collation above. Reconciliation is named-step and
idempotent: each auto-committed DDL step introspects first and either proves
the exact contract, repairs a compatible partial step, or stops with
`SCHEMA_RECONCILIATION_REQUIRED`.

Task 11 schema reconciliation has a mandatory offline maintenance window.
Before preflight, operators stop API, worker and broker authoring ingress,
drain or stop all jobs, revoke the legacy application login/role and kill its
remaining database sessions. Only the named migration-administrator identity
may write until enrollment completes. This fence stays in place across every
DDL/backfill/probe step; old and new writers are never live together.

Reconciliation order is fixed:

1. preflight exact legacy object names/actions plus orphan, duplicate,
   cross-project, range and payload-shape data without changing schema;
2. add only nullable columns and non-conflicting support indexes needed by
   backfill; do not add current/version uniqueness yet;
3. backfill directory pointer/current-marker pairs,
   `writing_results.version_number`, content heads, generation attempts and
   all other deterministic closures, recording reconciliation digests;
4. revalidate every backfilled row and canonical/digest invariant;
5. add final generated columns, exact unique/current indexes, composite parent
   keys, named RESTRICT FKs, CHECKs and triggers; drop only a recognized legacy
   FK/index immediately before its exact replacement;
6. compare the complete schema contract and execute invariant probes;
7. install storage tables, roles, routines and protected ownership, migrate
   blobs, activate `storage_control` while enrollment remains empty, and run
   the 4.4 negative/positive probes;
8. start only the broker-aware new API/worker fleet in commit-off mode, prove
   runtime/storage manifests, then enroll allowlisted projects and reopen
   ingress.

Unknown same-purpose FKs, a missing required legacy parent index, partial
composite columns or any incompatible row stop before the first destructive
DDL. After storage activation, a failed probe leaves protected storage and
the active control row in place, keeps ingress stopped and enrolls no project;
operators repair forward rather than restoring the legacy writer.

Required migration tests:

- fresh MySQL;
- current schema with Task 10B rows;
- every partial-DDL interruption point;
- old binary insert omitting all new job columns;
- exact post-migration schema diff;
- incompatible data/constraint rejection.

The safe application rollback floor is the first Task11 broker-aware binary
that understands stored workflow definitions. Protected-store ownership,
broker DB roles and storage intents are never rolled back while any migrated
blob or enrolled project exists. Rolling back to `1ed3a5b` or older is
forbidden after storage activation; before activation it is allowed only after
setting commit mode off, stopping workers and proving there are no non-legacy,
queued/running/waiting jobs. Schema history is not rewritten.

### 8.8 Exact named-object registry

The migration uses these names and exact semantics; different same-looking
objects are schema drift:

**CHECK constraints**

- `chk_workflow_jobs_definition` enumerates the four definitions in 4.1;
- `chk_workflow_jobs_authoring_mode` enumerates
  `off,shadow,enforce_allowlist`;
- `chk_workflow_jobs_entrypoint` enumerates
  `legacy_api,workflow_api,internal`;
- `chk_workflow_jobs_client_contract` permits null or
  `authoring-approval-ui.v1`;
- `chk_workflow_jobs_policy_payload` requires snapshot+64-lowercase-hex digest
  together for both deterministic definitions and both null otherwise;
- `chk_workflow_events_transition_identity` requires transition instance/key
  to be both null or both non-null;
- `chk_authoring_proposals_artifact_kind`,
  `chk_authoring_proposals_state`,
  `chk_authoring_proposals_payload_state` and
  `chk_authoring_proposals_artifact_digests` implement the exact combinations
  in 8.2;
- `chk_authoring_approvals_version` permits
  `grounded-authoring-approval.v1|structured-authoring-approval.v1`;
- `chk_authoring_approvals_artifact_kind` permits `BODY|DIRECTORY|OUTLINE`
  and requires the approval-version/artifact pairing;
- `chk_authoring_approvals_capability` requires
  `authoring-commit-capability.v1`;
- `chk_authoring_scope_locks_kind` permits
  `OUTLINE_NODE|CONTENT_NODE`;
- `chk_content_versions_grounding_state` permits
  `LEGACY_UNVERIFIED|ATOMIC_APPROVED`;
- `chk_projects_tombstone` requires deleted time/actor together;
- `chk_projects_lock_version` and `chk_project_states_lock_version` require
  the unsigned lock counters to remain within their declared BIGINT range;
- `chk_users_tombstone` requires deleted/disabled timestamps together;
- `chk_source_files_tombstone` requires deleted time/actor together;
- `chk_file_upload_outbox_storage_intent` requires null intent for
  `storage_preparing`, non-null intent for `storage_pending`, and null intent
  for `pending|published`;
- `chk_file_upload_outbox_status` enumerates
  `storage_preparing|storage_pending|pending|published`;
- `chk_grounding_assignments_invalidation` requires
  `invalidated_at` and `invalidation_reason` to be both null or both non-null;
- `chk_grounding_claims_atomic_version` and
  `chk_citation_maps_atomic_version` require version/generation bindings for
  atomic rows;
- `chk_grounding_claims_ledger_contract` and
  `chk_citation_maps_ledger_contract` enumerate `legacy:v0|atomic:v1`;
- `chk_workflow_domain_commits_authoring_receipt` requires proposal, approval,
  commit digest and terminal event sequence all null for legacy or all
  non-null for authoring;
- `chk_authoring_enforced_projects_runtime_contract` requires exact
  `runtime_contract_version='authoring-workflow.v1'` and
  `storage_contract_version='storage-broker.v1'`;
- storage CHECKs are exactly
  `chk_storage_control_singleton`,
  `chk_storage_control_contract`,
  `chk_storage_objects_state`,
  `chk_storage_operation_intents_kind`,
  `chk_storage_operation_intents_status` and
  `chk_storage_operation_intents_authorization` and
  `chk_storage_operation_intents_shape`, with values and cross-column
  combinations from 4.4.

**Unique/index objects**

- proposals:
  `uq_authoring_proposals_job_sequence(workflow_job_id,proposal_sequence)`,
  `uq_authoring_proposals_job_active(workflow_job_id,active_marker)`,
  `uq_authoring_proposals_identity(id,workflow_job_id,project_id,
  proposal_sequence)`,
  `idx_authoring_proposals_project_state_expiry(project_id,state,expires_at)`,
  `idx_authoring_proposals_sweep(state,payload_scrubbed_at,
  payload_scrub_after,updated_at)`;
- approvals:
  `uq_authoring_approvals_proposal(proposal_id)`,
  `uq_authoring_approvals_nonce(approval_nonce)`,
  `uq_authoring_approvals_digest(approval_digest)`,
  `idx_authoring_approvals_job(workflow_job_id,created_at)`;
- scope/head:
  primary scope lock `(project_id,scope_kind,scope_key)`,
  primary content head
  `(project_id,chapter_node_id,normalized_section_node_id)`,
  `uq_project_states_project_id(project_id)`,
  `idx_project_states_current_directory(project_id,
  current_directory_version_id)`,
  `idx_directory_versions_project_id(project_id)`,
  `uq_directory_versions_project_id(project_id,id)`,
  `uq_directory_versions_current(project_id,current_marker)`,
  `uq_directory_versions_scope_version(project_id,version_number)`,
  `idx_outline_versions_project_id(project_id)`,
  `idx_outline_versions_project_chapter_section(project_id,chapter_node_id,
  section_node_id)`,
  `idx_outline_versions_scope(project_id,chapter_node_id,
  scope_section_node_id)`,
  `uq_outline_versions_scope_version(project_id,chapter_node_id,
  scope_section_node_id,version_number)`,
  `uq_outline_versions_current(project_id,chapter_node_id,
  scope_section_node_id,current_marker)`,
  `uq_content_current_heads_version(content_version_id)`,
  `idx_writing_results_project_id(project_id)`,
  `idx_writing_results_chapter(project_id,chapter_node_id)`,
  `idx_writing_results_session_id(session_id)`,
  `uq_writing_results_scope_version(project_id,chapter_node_id,
  normalized_section_node_id,version_number)` and
  `idx_content_versions_result_id(result_id)`,
  `uq_content_versions_scope_version(result_id,version_number)` and
  `uq_content_versions_current(result_id,current_marker)`;
- grounding assignments:
  primary `(workflow_job_id,generation_attempt)`,
  `idx_grounding_assignments_run(retrieval_run_id)` and
  `idx_grounding_assignments_project(project_id)`;
- ledger:
  `uq_grounding_assignments_generation_project(workflow_job_id,
  generation_attempt,project_id)`,
  `uq_grounding_claims_version_offsets(content_version_id,output_char_start,
  output_char_end)`,
  `uq_grounding_claims_closure(claim_id,project_id,result_id,
  content_version_id)`,
  `uq_writing_results_project_id(project_id,id)`,
  `uq_writing_results_scope_id(project_id,chapter_node_id,
  normalized_section_node_id,id)` and
  `uq_content_versions_result_id(result_id,id)`; the old
  `uq_grounding_claims_result_offsets` is removed only after compatible-data
  preflight;
- domain receipt:
  `uq_workflow_domain_commits_approval(approval_id)` and
  `uq_workflow_domain_commits_digest(commit_digest)`; nullable legacy values
  remain compatible;
- workflow events:
  `uq_workflow_events_job_transition(job_id,transition_key)`; existing null
  transition keys remain compatible;
- enforcement:
  primary `authoring_enforced_projects(project_id)`,
  `uq_authoring_enforced_projects_epoch_project(deployment_epoch,project_id)`
  and
  `idx_authoring_enforced_projects_activated_by(activated_by)`;
- storage:
  `uq_storage_objects_key(storage_key)`,
  `uq_storage_control_active_epoch(active_epoch)`,
  `uq_source_files_project_id(project_id,id)`,
  `uq_storage_objects_file_generation(source_file_id,generation)`,
  `uq_storage_objects_intent_identity(id,project_id,generation,storage_key)`,
  `uq_storage_operation_intents_idempotency(idempotency_key)`,
  `idx_storage_operation_intents_claim(status,next_attempt_at,
  lease_expires_at)`,
  `idx_file_upload_outbox_storage_intent(storage_intent_id)` and
  `idx_source_files_project_deleted(project_id,deleted_at,id)`;
- projects: `idx_projects_user_deleted(user_id,deleted_at,id)`;
- users: `idx_users_deleted(deleted_at,id)`.

**Foreign keys**

- `authoring_proposals_workflow_fkey`,
  `authoring_proposals_project_fkey`;
- `authoring_approvals_proposal_identity_fkey`,
  `authoring_approvals_workflow_fkey`,
  `authoring_approvals_project_fkey`,
  `authoring_approvals_user_fkey`;
- `authoring_approval_invalidations_approval_fkey`,
  `authoring_approval_invalidations_user_fkey`;
- `authoring_scope_locks_project_fkey`;
- `content_current_heads_project_fkey`,
  `content_current_heads_scope_result_fkey`,
  `content_current_heads_result_version_fkey`;
- `grounding_assignments_workflow_fkey`,
  `grounding_assignments_project_fkey`,
  `grounding_assignments_run_fkey`;
- `grounding_claims_assignment_generation_fkey`,
  reconciled `grounding_claims_workflow_fkey`,
  reconciled `grounding_claims_project_fkey`,
  reconciled `grounding_claims_result_fkey`,
  `grounding_claims_project_result_fkey`,
  `grounding_claims_result_version_fkey`,
  `citation_maps_result_version_fkey`,
  `citation_maps_claim_closure_fkey`;
- `workflow_domain_commits_proposal_fkey`,
  `workflow_domain_commits_approval_fkey`,
  reconciled `workflow_domain_commits_job_id_fkey` with RESTRICT;
- `project_states_project_id_fkey`,
  `project_states_current_directory_project_fkey`,
  `directory_versions_project_id_fkey`,
  `outline_versions_project_id_fkey`,
  `writing_results_project_id_fkey`,
  `writing_results_parent_project_fkey(project_id,parent_result_id)` to
  `writing_results(project_id,id)`,
  `content_versions_result_id_fkey`,
  `source_files_project_id_fkey`;
- `authoring_enforced_projects_project_fkey`,
  `authoring_enforced_projects_activated_by_fkey`,
  `authoring_enforced_projects_storage_epoch_fkey`;
- `projects_deleted_by_fkey`;
- `source_files_deleted_by_fkey`,
  `file_upload_outbox_storage_intent_fkey`,
  `storage_objects_project_fkey`,
  `storage_objects_project_file_fkey`,
  `storage_operation_intents_project_fkey`,
  `storage_operation_intents_storage_epoch_fkey`,
  `storage_operation_intents_object_fkey`;
- reconciled `projects_user_id_fkey` is
  `ON DELETE RESTRICT ON UPDATE RESTRICT`.

Every listed FK is `ON DELETE RESTRICT ON UPDATE RESTRICT`; this explicitly
includes the six reconciled project-state/directory/outline/writing/content
and source-file relationships and both enforcement-table relationships.
`authoring_scope_locks_project_fkey` is RESTRICT under tombstone deletion.
Nullable `invalidated_by`/`deleted_by` remain RESTRICT, not SET NULL. ID
columns copy the referenced column's type/charset/collation exactly. Digests use
`CHAR(64) CHARACTER SET ascii COLLATE ascii_bin`; canonical envelopes/policy/
proposal bytes use BLOB columns and therefore have no collation.

Recognized legacy grounding FKs
`grounding_assignments_workflow_fkey`,
`grounding_assignments_project_fkey`,
`grounding_assignments_run_fkey`,
`grounding_claims_workflow_fkey`,
`grounding_claims_project_fkey` and `grounding_claims_result_fkey` are each
dropped only after preflight and recreated under the same name with RESTRICT.
The new composite assignment/version closures are then added; they do not
leave a CASCADE synonym behind. Existing
`workflow_domain_commits_job_id_fkey` is likewise reconciled from CASCADE to
RESTRICT. The nullable parent-result composite FK uses the existing
`uq_writing_results_project_id(project_id,id)` parent key, so null remains
legal but a cross-project revision parent is impossible.

**Triggers, routines, roles and view**

- immutable proposal guard:
  `trg_authoring_proposals_immutable_bi` and
  `trg_authoring_proposals_immutable_bu`;
- authoring business invariant guards:
  `trg_directory_versions_authoring_bi`,
  `trg_directory_versions_authoring_bu`,
  `trg_outline_versions_authoring_bi`,
  `trg_outline_versions_authoring_bu`,
  `trg_writing_results_authoring_bi`,
  `trg_writing_results_authoring_bu`,
  `trg_content_versions_authoring_bi`,
  `trg_content_versions_authoring_bu`,
  `trg_project_states_authoring_bi` and
  `trg_project_states_authoring_bu`;
- storage request/worker routines:
  trigger `trg_storage_operation_intents_terminal_bu`,
  `sp_storage_request_promote_v1`,
  `sp_storage_request_delete_quarantine_v1`,
  `sp_storage_request_delete_blob_v1`,
  `sp_storage_request_abort_promotion_v1`,
  `sp_storage_claim_v1` and `sp_storage_complete_v1`;
- storage authority:
  locked definer `'wa_storage_definer_v1'@'localhost'`, roles
  `'wa_app_role_v1'`, `'wa_authoring_worker_role_v1'` and
  `'wa_storage_broker_role_v1'`, mTLS accounts
  `'wa_app_v1'@'%'`, `'wa_authoring_worker_v1'@'%'` and
  `'wa_storage_broker_v1'@'%'`, and view
  `v_storage_intent_execution_v1`.

- authoring procedures:
  `sp_workflow_create_v1`, `sp_workflow_control_transition_v1`,
  `sp_workflow_worker_transition_v1`,
  `sp_authoring_seal_v1`, `sp_authoring_approve_v1`,
  `sp_authoring_commit_v1`, `sp_legacy_commit_directory_v1`,
  `sp_legacy_commit_outline_v1`, `sp_legacy_commit_content_v1`,
  `sp_legacy_patch_content_v1`, `sp_project_mutate_v1`,
  `sp_material_mutate_v1`, `sp_style_template_mutate_v1`,
  `sp_authoring_enroll_v1` and `sp_authoring_deactivate_v1`;
- authoring authority:
  locked definer `'wa_authoring_definer_v1'@'localhost'`, role/account
  `'wa_authoring_commit_role_v1'` /
  `'wa_authoring_commit_v1'@'%'` with mTLS subject
  `/CN=write-agent-authoring-commit-v1`, and the 4.3 app/committer/admin
  EXECUTE allowlists; committer additionally has SELECT only on
  `v_authoring_commit_candidate_v1`.

Their exact signatures, SQL SECURITY mode, grant allowlist and normalized
golden definitions are the 4.3/4.4 contracts. A missing, extra or same-purpose
differently named object is schema/readiness drift.

### 8.9 Database enforcement boundary

`authoring_enforced_projects` is InnoDB/utf8mb4 with:

- `project_id VARCHAR(36) PRIMARY KEY`, project FK RESTRICT;
- `deployment_epoch CHAR(36) ascii_bin NOT NULL`;
- `runtime_contract_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin
  NOT NULL` fixed to
  `authoring-workflow.v1`;
- `storage_epoch CHAR(36) ascii_bin NOT NULL`, FK to unique
  `storage_control.active_epoch` RESTRICT;
- `storage_contract_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin
  NOT NULL` fixed to `storage-broker.v1`;
- `policy_digest CHAR(64) ascii_bin NOT NULL`;
- `activated_by VARCHAR(36) NOT NULL`, user FK RESTRICT;
- `activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`;
- unique `(deployment_epoch,project_id)`.

Exact trigger names are
`trg_directory_versions_authoring_bi`,
`trg_directory_versions_authoring_bu`,
`trg_outline_versions_authoring_bi`,
`trg_outline_versions_authoring_bu`,
`trg_writing_results_authoring_bi`,
`trg_writing_results_authoring_bu`,
`trg_content_versions_authoring_bi` and
`trg_content_versions_authoring_bu`, plus
`trg_project_states_authoring_bi` and
`trg_project_states_authoring_bu`.

These triggers enforce relational/current-state invariants only: legal
version/marker transitions, same-project scope, exact lock-version increment
and directory pointer/current-marker pairing. The content-version trigger
joins `result_id` to `writing_results`; zero/multiple or cross-project
resolution signals schema corruption. Project-state triggers require every
non-null pointer change to identify the exact same-project current directory
version in the transaction. They never inspect caller-set variables or treat
them as authority.

Authorization and approval consumption are enforced by the 4.3
SQL SECURITY DEFINER procedures and grants. The app/worker roles cannot issue
direct protected DML; the commit role can only call
`sp_authoring_commit_v1`; migration admin alone can enroll/deactivate.
Procedure execution additionally requires the stored deployment/storage epoch
to match the enrolled row before mutation.

Migration installs triggers before any project can be enrolled.
Rollback/removal of a trigger is refused while this table is non-empty.
Migration and integration tests execute real old-style inserts/updates with
the revoked legacy login and the new app login: legacy authentication fails,
and app direct DML fails with privilege denial. Forged `@wa_authoring_*`
variables change neither result. Invalid calls through a procedure return the
stable `AUTHORING_DB_CAPABILITY_REQUIRED` signal.

## 9. Approval envelopes and capability

### 9.1 Body approval

Task10B's approval envelope is not Task11 positive authority because it lacks
proposal and outer-snapshot identity. Task11 uses a new contract while
embedding the Task10B candidate unchanged:

```ts
interface GroundedAuthoringApprovalPreimageV1 {
  approval_version: 'grounded-authoring-approval.v1';
  capability_version: 'authoring-commit-capability.v1';
  workflow_job_id: string;
  project_id: string;
  workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
  generation_attempt: number;
  proposal_id: string;
  proposal_sequence: number;
  artifact_kind: 'body';
  sealed_payload_version: 'authoring-sealed-payload.v1';
  sealed_payload_digest: string;
  authoring_envelope_digest: string;
  artifact_schema_version: 'sealed-grounded-candidate.v1';
  artifact_digest: string;
  candidate_envelope_digest: string;
  proposal_digest: string;
  render_context_digest: string;
  render_digest: string;
  candidate_assignment_digest: string;
  ledger_digest: string;
  input_snapshot_version: 'authoring-input-snapshot.v1';
  input_digest: string;
  dependency_snapshot_version: 'authoring-dependency-snapshot.v1';
  dependency_digest: string;
  retrieval_snapshot_version: 'authoring-retrieval-snapshot.v1';
  retrieval_digest: string;
  index_snapshot_version: 'authoring-index-snapshot.v1';
  index_digest: string;
  assignment_snapshot_version: 'body-assignment-binding.v1';
  assignment_digest: string;
  grounding_contract_version: 'atomic:v1';
  schema_version: 'grounded-draft.v1';
  canonical_json_version: 'canonical-json.v1';
  canonicalizer_version: 'atomic-canonicalizer.v1';
  quantity_lexer_version: 'quantity-lexer.v1';
  plain_text_escape_version: 'escape-plain-text.v1';
  renderer_version: 'atomic-renderer.v1';
  verifier_version: 'atomic-verifier.v1';
  approved_by: string;
  approved_at: string;
  approval_nonce: string;
}

type GroundedAuthoringApprovalEnvelopeV1 =
  GroundedAuthoringApprovalPreimageV1 & {
    approval_digest: string;
  };
```

`approval_digest` uses tag `grounded-authoring-approval.v1` over
`GroundedAuthoringApprovalPreimageV1`.
Any mismatch in field, version, digest, actor, scope, nonce or canonical bytes
rejects capability mint with `AUTHORING_APPROVAL_MISMATCH`.
Legacy `grounded-approval.v1` bytes never enter `authoring_approvals` and can
never mint a Task11 capability.

### 9.2 Structured approval

Directory/outline use the separate closed contract:

```ts
interface StructuredAuthoringApprovalCommonPreimageV1 {
  approval_version: 'structured-authoring-approval.v1';
  capability_version: 'authoring-commit-capability.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  proposal_id: string;
  proposal_sequence: number;
  sealed_payload_version: 'authoring-sealed-payload.v1';
  sealed_payload_digest: string;
  authoring_envelope_digest: string;
  artifact_digest: string;
  structured_proposal_digest: string;
  persistence_artifact_digest: string;
  evidence_sidecar_digest: string;
  input_snapshot_version: 'authoring-input-snapshot.v1';
  input_digest: string;
  dependency_snapshot_version: 'authoring-dependency-snapshot.v1';
  dependency_digest: string;
  retrieval_snapshot_version: 'authoring-retrieval-snapshot.v1';
  retrieval_digest: string;
  index_snapshot_version: 'authoring-index-snapshot.v1';
  index_digest: string;
  assignment_snapshot_version: 'structured-assignment-snapshot.v1';
  assignment_digest: string;
  canonical_json_version: 'canonical-json.v1';
  canonicalizer_version: 'structured-authoring-canonicalizer.v1';
  projector_version: 'structured-persistence-projector.v1';
  validator_version: 'structured-authoring-validator.v1';
  reviewer_version: 'structured-authoring-reviewer.v1';
  approved_by: string;
  approved_at: string;
  approval_nonce: string;
}

type StructuredAuthoringApprovalPreimageV1 =
  | (StructuredAuthoringApprovalCommonPreimageV1 & {
      workflow_type: 'directory';
      artifact_kind: 'directory';
      schema_version: 'directory-proposal.v1';
    })
  | (StructuredAuthoringApprovalCommonPreimageV1 & {
      workflow_type: 'outline';
      artifact_kind: 'outline';
      schema_version: 'outline-proposal.v1';
    });

type StructuredAuthoringApprovalEnvelopeV1 =
  StructuredAuthoringApprovalPreimageV1 & {
    approval_digest: string;
  };
```

`approved_at` in both approval schemas is UTC RFC 3339 with exactly six
fractional digits (`YYYY-MM-DDTHH:mm:ss.SSSSSSZ`) derived from locked MySQL
time. Structured `approval_digest` uses tag
`structured-authoring-approval.v1` over
`StructuredAuthoringApprovalPreimageV1`. Golden bytes/digests are fixtures.

Database mapping is unambiguous:

- row `authoring_envelope_digest` is the outer
  `AuthoringProposalEnvelopeV1` digest;
- row `sealed_payload_digest` binds the complete canonical payload wrapper;
- row `proposal_digest` maps to
  `SealedGroundedCandidateV1.digests.proposal_digest` for body and to
  `structured_proposal_digest` for directory/outline;
- `candidate_envelope_digest` exists only for body;
- row `artifact_digest` maps to `persistence_artifact_digest` for
  directory/outline and the candidate envelope digest for body;
- `evidence_sidecar_digest` exists only for directory/outline.

Body approvals may not be parsed as structured approvals or vice versa.
Capability mint reconstructs the applicable preimage only from locked
proposal/payload/snapshot/approval rows; the request supplies none of these
fields.

### 9.3 Once-only commit capability

`AuthoringCommitCapabilityProvider` holds a module-private
`WeakMap<object, CapabilityBinding>` whose binding contains:

- operation
  `COMMIT_DIRECTORY | COMMIT_OUTLINE | COMMIT_CONTENT`;
- job, proposal, approval and project IDs;
- fencing token and deployment epoch;
- `consumed: boolean`.

The capability is an opaque object with no public constructor or fields. Mint
is available only in the committer process and requires a closed read from
`v_authoring_commit_candidate_v1` plus a locally revalidated approval
envelope. The positive method verifies the binding, sets `consumed=true`
before calling `sp_authoring_commit_v1`, and supplies only the four
identity/fence arguments from 4.3. The procedure owns its MySQL transaction and
returns the closed commit receipt. A second use always throws
`AUTHORING_CAPABILITY_CONSUMED`. If the procedure rolls back or returns an
unknown result, recovery re-reads the database receipt contract before a new
capability can be minted.

Capabilities never appear in JSON, DTOs, checkpoints, events or logs.

## 10. Approval and positive commit transactions

### 10.1 Proposal read and approval API

New owned route:

```text
GET /api/projects/:projectId/workflows/:jobId/proposal
```

It returns the current ACTIVE proposal view, exact display bytes/structure,
proposal ID, sequence, expiry and non-authoritative metadata. Access uses
`ProjectAccessPolicy`; terminal/superseded proposals are not returned as
current.

Existing approval route remains:

```text
POST /api/projects/:projectId/workflows/:jobId/approve
```

Its body is empty. In one transaction it:

1. locks the owned project and job in the section 11 order;
2. if status is `QUEUED | RUNNING | SUCCEEDED`, reads its latest
   APPROVED/COMMITTED proposal and approval; when actor, proposal ID/sequence,
   envelope and digest match, returns the existing receipt without dispatch,
   otherwise fails closed;
3. otherwise requires `WAITING_APPROVAL`, locks the highest-sequence proposal
   regardless of state, returns `AUTHORING_PROPOSAL_EXPIRED` for EXPIRED,
   `AUTHORING_PROPOSAL_SUPERSEDED` for SUPERSEDED, and only then requires
   ACTIVE; it rejects cancellation/invalidation and detects snapshot drift;
4. reconstructs the relevant approval envelope from locked server rows;
5. inserts the immutable approval and changes proposal state to APPROVED;
6. changes job status to QUEUED and appends `workflow.approved`;
7. clears any stale lease fields.

After commit, dispatch is requested. Duplicate calls return the same approval
only when proposal and identity match, and duplicate-key races re-read that
same receipt. Replays never dispatch twice. Otherwise they fail closed. If locked
snapshots have drifted, the same transaction changes ACTIVE to SUPERSEDED,
moves the job to `WAITING_MATERIAL`, appends a bounded drift event and commits
without creating an approval; the controller then returns
`AUTHORING_PROPOSAL_DRIFTED`.

### 10.2 Positive commit

The committer reads `v_authoring_commit_candidate_v1`, reconstructs and
revalidates the proposal locally, consumes its once-only capability, then
calls `sp_authoring_commit_v1`. The procedure owns one short transaction and
locks:

1. owned project, workflow job, active APPROVED proposal and approval;
2. grounding assignment;
3. the stable scope lock (`project_states` for directory);
4. current business head/version and referenced
   retrieval/index/dependency rows;
5. parent result/head for revision workflows.

It then:

1. verifies lease/fencing, stored definition/mode/policy, cancellation and
   absence of approval invalidation;
2. re-parses canonical proposal and approval bytes;
3. recomputes all digests and exact server rendering;
4. verifies the procedure arguments against those locked rows and accepts no
   business payload parameter;
5. allocates the next version only after the stable
   scope lock;
6. writes exact business rows and, for body, exact grounding/citation ledgers;
7. writes `workflow_domain_commits`;
8. changes the artifact's authoritative current state and proposal to
   COMMITTED: directory/outline unset their prior scope current marker and set
   the new version, and directory also updates
   `project_states.current_directory_version_id` to that exact same-project
   version; body inserts version 1 as current inside the new result and
   switches only `content_current_heads`, leaving every prior immutable
   result/version marker untouched;
9. fences `RUNNING`, sets the job `SUCCEEDED`, clears its lease, sets
   `completed_at` and appends `authoring.business_committed` plus the one
   terminal `workflow.succeeded` event.

For body, the procedure extracts one verified `server_output.text` value from
the locked sealed payload and binds that same SQL value to
`writing_results.content_text` and `content_versions.content_text`. UTF-8 byte
length and render digest are checked immediately before insert.
`normalizeGeneratedContent()` and all other mutators are forbidden in this
path.

The transaction commits all steps or none. Model/retrieval/review calls never
run while locks are held. On commit the executor returns
`COMPLETED_PERSISTED`; the engine must not call `store.complete()`.

If the committer crashes after this transaction, recovery sees the terminal job and
does not claim it. If delivery is repeated before the terminal observation,
the matching `workflow_domain_commits` row and terminal event are returned;
no second business write or terminal event is appended.

### 10.3 Domain commit receipt

`workflow_domain_commits` gains nullable legacy-compatible
`proposal_id VARCHAR(36)`, `approval_id VARCHAR(36)`,
`commit_digest CHAR(64) ascii_bin` and
`terminal_event_seq INT UNSIGNED`. A positive authoring row requires all four.
`commit_payload` stores this closed value:

```ts
interface AuthoringDomainCommitReceiptCommonPreimageV1 {
  receipt_version: 'authoring-domain-commit-receipt.v1';
  workflow_job_id: string;
  project_id: string;
  proposal_id: string;
  proposal_sequence: number;
  approval_id: string;
  sealed_payload_digest: string;
  authoring_envelope_digest: string;
  approval_digest: string;
  artifact_digest: string;
  input_digest: string;
  dependency_digest: string;
  retrieval_digest: string;
  index_digest: string;
  assignment_digest: string;
  resource_id: string;
  version_id: string;
  head_scope_key: string;
  fencing_token: string;
  terminal_event_seq: number;
}

type AuthoringDomainCommitReceiptPreimageV1 =
  | (AuthoringDomainCommitReceiptCommonPreimageV1 & {
      workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
      artifact_kind: 'body';
      schema_version: 'sealed-grounded-candidate.v1';
      evidence_sidecar_digest: null;
      render_digest: string;
      ledger_digest: string;
    })
  | (AuthoringDomainCommitReceiptCommonPreimageV1 & {
      workflow_type: 'directory';
      artifact_kind: 'directory';
      schema_version: 'directory-proposal.v1';
      evidence_sidecar_digest: string;
      render_digest: null;
      ledger_digest: null;
    })
  | (AuthoringDomainCommitReceiptCommonPreimageV1 & {
      workflow_type: 'outline';
      artifact_kind: 'outline';
      schema_version: 'outline-proposal.v1';
      evidence_sidecar_digest: string;
      render_digest: null;
      ledger_digest: null;
    });

type AuthoringDomainCommitReceiptV1 =
  AuthoringDomainCommitReceiptPreimageV1 & {
    commit_digest: string;
  };
```

`commit_digest` uses tag `authoring-domain-commit-receipt.v1` over
`AuthoringDomainCommitReceiptPreimageV1`.
Legacy receipts have null new columns and cannot satisfy this parser.
`head_scope_key` is the tagged `authoring-scope-key.v1` digest from 8.4;
directory uses the same digest rule over
`{project_id,scope_kind:'DIRECTORY'}` while locking `project_states`.
Under the locked job, the transaction reserves consecutive event sequences
for `authoring.business_committed` and `workflow.succeeded`; the latter is
placed in the receipt before its digest and all three rows are inserted in the
same transaction.

For an unknown transaction result, recovery reads by
`workflow_job_id`, closed-parses `commit_payload`, re-canonicalizes it and
verifies its digest against the columns, then
requires the referenced proposal COMMITTED, approval valid, resource/version/
head rows exact, job SUCCEEDED and exactly one
`workflow.succeeded` event at `terminal_event_seq`. A complete match returns
the existing receipt. Any missing/mismatched component fails closed with
`AUTHORING_COMMIT_RECEIPT_MISMATCH`; it never replays positive SQL.
For directory, “head rows exact” means both the unique current marker and
same-project `project_states` pointer equal `version_id`; checking only one is
insufficient.

### 10.4 Version conflict rules

The two body version unique constraints from 8.4 and the directory/outline
scope-version constraints remain final guards. On duplicate
version/head/domain commit:

1. roll back the transaction;
2. re-read `workflow_domain_commits` once;
3. if it matches the job/proposal/digests, return the existing success;
4. otherwise return a `SUSPENDED_WAITING_MATERIAL` outcome with
   `AUTHORING_VERSION_CONFLICT`; `store.suspend()` releases the lease without
   changing proposal/approval, appends the
   `VERSION_CONFLICT_SUSPEND/workflow.waiting_material` transition, and only
   owner resume may invalidate/requeue it.

There is no unbounded SQL retry. First-version races are serialized by the
stable scope row.

## 11. Lifecycle, resume, expiry and cancellation

Transition identity is a closed discriminated union:

```ts
type AuthoringProposalStateV1 =
  | 'ACTIVE' | 'APPROVED' | 'COMMITTED'
  | 'SUPERSEDED' | 'EXPIRED' | 'SHADOW_COMPLETED';

type AuthoringTransitionReasonCodeV1 =
  | 'AUTHORING_PROPOSAL_EXPIRED'
  | 'AUTHORING_DEPENDENCY_DRIFT'
  | 'AUTHORING_MATERIAL_GAP'
  | 'AUTHORING_CANCEL_REQUESTED'
  | 'AUTHORING_VERSION_CONFLICT'
  | 'AUTHORING_OPERATION_AMBIGUOUS'
  | 'PROJECT_TOMBSTONED'
  | 'USER_TOMBSTONED';

type WorkflowTransitionSubjectV1 =
  | {
      subject_kind: 'GRAPH_OPERATION';
      operation_fingerprint: string;
      node_attempt_ordinal: number;
    }
  | {
      subject_kind: 'PROPOSAL_SEAL';
      proposal_id: string;
      proposal_sequence: number;
      authoring_envelope_digest: string;
    }
  | {
      subject_kind: 'APPROVAL';
      proposal_id: string;
      approval_id: string;
      approved_by: string;
    }
  | {
      subject_kind: 'DOMAIN_COMMIT';
      proposal_id: string;
      approval_id: string;
      commit_digest: string;
    }
  | { subject_kind: 'EXPIRY'; proposal_id: string }
  | {
      subject_kind: 'RESUME';
      source_generation_attempt: number;
      proposal_id: string | null;
      proposal_state: AuthoringProposalStateV1 | null;
    }
  | {
      subject_kind: 'DEPENDENCY_DRIFT';
      proposal_id: string;
      observed_dependency_digest: string;
    }
  | { subject_kind: 'CANCEL'; cancel_scope: 'JOB' }
  | {
      subject_kind: 'VERSION_CONFLICT';
      proposal_id: string;
      approval_id: string;
    }
  | {
      subject_kind: 'TERMINAL_FAILURE';
      operation_fingerprint: string;
      error_code: 'AUTHORING_OPERATION_AMBIGUOUS';
    }
  | { subject_kind: 'PROJECT_TOMBSTONE'; tombstoned_project_id: string }
  | {
      subject_kind: 'USER_TOMBSTONE';
      tombstoned_user_id: string;
      tombstoned_project_id: string;
    };

interface WorkflowTransitionInstancePreimageV1 {
  instance_version: 'workflow-transition-instance.v1';
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  transition_kind:
    | 'GRAPH_NODE_EVENT'
    | 'SEAL_WAITING_APPROVAL' | 'SHADOW_SUCCEEDED'
    | 'APPROVE_REQUEUE' | 'POSITIVE_COMMIT'
    | 'EXPIRE_PROPOSAL' | 'RESUME_EXPIRED'
    | 'DRIFT_BEFORE_APPROVAL' | 'DRIFT_AFTER_APPROVAL'
    | 'SUSPEND_WAITING_MATERIAL' | 'RESUME_WAITING_MATERIAL'
    | 'VERSION_CONFLICT_SUSPEND' | 'OPERATION_AMBIGUOUS_FAIL'
    | 'CANCEL_BEFORE_PROPOSAL' | 'CANCEL_ACTIVE'
    | 'CANCEL_APPROVED' | 'CANCEL_WAITING_MATERIAL'
    | 'CANCEL_EXPIRED' | 'CANCEL_SHADOW'
    | 'PROJECT_TOMBSTONE' | 'USER_TOMBSTONE';
  from_job_status:
    | 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_MATERIAL'
    | 'SUCCEEDED' | 'FAILED' | 'STOPPED';
  to_job_status:
    | 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'WAITING_MATERIAL'
    | 'SUCCEEDED' | 'FAILED' | 'STOPPED';
  proposal_id: string | null;
  from_proposal_state: AuthoringProposalStateV1 | null;
  to_proposal_state: AuthoringProposalStateV1 | null;
  fencing_token: string | null;
  reason_code: AuthoringTransitionReasonCodeV1 | null;
  subject: WorkflowTransitionSubjectV1;
}

interface WorkflowTransitionPreimageV1 {
  transition_version: 'workflow-transition.v1';
  transition_instance_key: string;
  event_type:
    | 'authoring.snapshot_created' | 'authoring.evidence_ready'
    | 'authoring.proposal_sealed' | 'authoring.review_failed'
    | 'authoring.repair_started' | 'authoring.proposal_expired'
    | 'authoring.business_committed'
    | 'workflow.waiting_approval' | 'workflow.waiting_material'
    | 'workflow.approved' | 'workflow.resumed'
    | 'workflow.succeeded' | 'workflow.failed'
    | 'workflow.stopped'
    | 'project.tombstoned' | 'user.tombstoned';
  event_ordinal: number;
}
```

The checked-in `authoring-transition-registry.v1` is exhaustive:

| kind | job before→after | proposal before→after | subject | event types in ordinal order |
|---|---|---|---|---|
| GRAPH_NODE_EVENT | RUNNING→RUNNING | null→null | GRAPH_OPERATION | exactly the node event |
| SEAL_WAITING_APPROVAL | RUNNING→WAITING_APPROVAL | null→ACTIVE | PROPOSAL_SEAL | authoring.proposal_sealed, workflow.waiting_approval |
| SHADOW_SUCCEEDED | RUNNING→SUCCEEDED | null→SHADOW_COMPLETED | PROPOSAL_SEAL | authoring.proposal_sealed, workflow.succeeded |
| APPROVE_REQUEUE | WAITING_APPROVAL→QUEUED | ACTIVE→APPROVED | APPROVAL | workflow.approved |
| POSITIVE_COMMIT | RUNNING→SUCCEEDED | APPROVED→COMMITTED | DOMAIN_COMMIT | authoring.business_committed, workflow.succeeded |
| EXPIRE_PROPOSAL | WAITING_APPROVAL→WAITING_APPROVAL | ACTIVE→EXPIRED | EXPIRY | authoring.proposal_expired |
| RESUME_EXPIRED | WAITING_APPROVAL→QUEUED | EXPIRED→EXPIRED | RESUME | workflow.resumed |
| DRIFT_BEFORE_APPROVAL | WAITING_APPROVAL→WAITING_MATERIAL | ACTIVE→SUPERSEDED | DEPENDENCY_DRIFT | workflow.waiting_material |
| DRIFT_AFTER_APPROVAL | RUNNING→WAITING_MATERIAL | APPROVED→APPROVED | DEPENDENCY_DRIFT | workflow.waiting_material |
| SUSPEND_WAITING_MATERIAL | RUNNING→WAITING_MATERIAL | null→null | GRAPH_OPERATION | workflow.waiting_material |
| RESUME_WAITING_MATERIAL | WAITING_MATERIAL→QUEUED | null/APPROVED→null/SUPERSEDED | RESUME | workflow.resumed |
| VERSION_CONFLICT_SUSPEND | RUNNING→WAITING_MATERIAL | APPROVED→APPROVED | VERSION_CONFLICT | workflow.waiting_material |
| OPERATION_AMBIGUOUS_FAIL | RUNNING→FAILED | null→null | TERMINAL_FAILURE | workflow.failed |
| CANCEL_BEFORE_PROPOSAL | QUEUED/RUNNING→STOPPED | null→null | CANCEL | workflow.stopped |
| CANCEL_ACTIVE | WAITING_APPROVAL→STOPPED | ACTIVE→SUPERSEDED | CANCEL | workflow.stopped |
| CANCEL_APPROVED | QUEUED/RUNNING/WAITING_MATERIAL→STOPPED | APPROVED→SUPERSEDED | CANCEL | workflow.stopped |
| CANCEL_WAITING_MATERIAL | WAITING_MATERIAL→STOPPED | null→null | CANCEL | workflow.stopped |
| CANCEL_EXPIRED | WAITING_APPROVAL→STOPPED | EXPIRED→EXPIRED | CANCEL | workflow.stopped |
| CANCEL_SHADOW | RUNNING→STOPPED | null→null | CANCEL | workflow.stopped |
| PROJECT_TOMBSTONE | QUEUED/RUNNING/WAITING_APPROVAL/WAITING_MATERIAL→STOPPED | null/ACTIVE/APPROVED/EXPIRED→null/SUPERSEDED/SUPERSEDED/EXPIRED | PROJECT_TOMBSTONE | workflow.stopped, project.tombstoned |
| USER_TOMBSTONE | QUEUED/RUNNING/WAITING_APPROVAL/WAITING_MATERIAL→STOPPED | same mapping as project tombstone | USER_TOMBSTONE | workflow.stopped, user.tombstoned |

“Exactly the node event” is one of the closed `authoring.*` graph event values
above and is selected by the node registry, never caller text. The only
slash-separated cells above expand to the explicitly paired alternatives in
the same order; all other combinations are rejected. Reason code is null when
the row has no named error and otherwise is the one corresponding to its kind.
Tombstone creates one transition instance per affected job, so job and
generation are never absent. `transition_instance_key` and `transition_key`
use their matching tags over the two preimages above. Golden fixtures cover
every registry row/alternative, subject branch, repair counter and fence
variant.

Every lifecycle mutation—seal, shadow completion, approve, positive commit,
resume, cancel, drift, expiry sweeper and project/user tombstone—uses one
`workflow-transition.v1` protocol:

1. lock rows in this total order when present: user gate for user tombstone;
   owned project gate; workflow jobs in ID order; each job's latest/current
   proposal; approval and invalidation; grounding assignment; stable scope
   lock and dependency/business-head rows. Single-job transitions therefore
   use project→job→proposal→approval/invalidation→assignment→scope. Project
   and user tombstones use the same order across all jobs rather than a
   separate inversion;
2. every UPDATE/DELETE includes the expected prior status/state and
   `cancel_requested_at IS NULL`; a running-worker transition additionally
   includes the claimed lease owner, lease expiry and fencing token;
3. require `affectedRows===1`. If it is not 1, re-read the target rows once
   under the same lock order. An already-identical target state returns the
   existing idempotent result; any other state returns the stable
   `WORKFLOW_TRANSITION_CONFLICT` or `WORKFLOW_FENCE_LOST` result and performs
   no remaining mutation;
4. before any side effect, the caller derives the exact transition-instance
   preimage above. Graph branches use the checkpointed operation fingerprint;
   lifecycle branches use their closed subject. The instance preimage/key is
   stored in the checkpoint before external work or in the same state/event
   transaction for lifecycle calls;
5. every persisted event computes `transition_key` with tag
   `workflow-transition.v1` over `WorkflowTransitionPreimageV1`.
   `event_ordinal` is zero-based inside a multi-event transition. The database
   contract is in 8.1. A duplicate key is re-read and accepted only when
   transition instance, event type, sequence and canonical bounded payload
   match exactly, otherwise it is
   `WORKFLOW_EVENT_DEDUP_MISMATCH`.

Transitions that do not run under a worker use a null fence but still use the
same CAS and event-key rules. Multi-row transitions insert their events and
all state changes in one transaction. No lifecycle route has a private lock
order or append-only event shortcut.

| Trigger/current state | Transactional result |
|---|---|
| seal / RUNNING | insert next ACTIVE proposal; suspend WAITING_APPROVAL; release lease |
| shadow seal / RUNNING | insert SHADOW_COMPLETED proposal; finish SUCCEEDED; zero business writes |
| approve / WAITING_APPROVAL | insert approval; ACTIVE→APPROVED; job→QUEUED; dispatch after commit |
| positive commit / RUNNING | business transaction; APPROVED→COMMITTED; job→SUCCEEDED |
| proposal TTL / WAITING_APPROVAL | ACTIVE→EXPIRED; keep job WAITING_APPROVAL; append `authoring.proposal_expired`; approval returns `AUTHORING_PROPOSAL_EXPIRED` |
| owner resume expired proposal | invalidate any approval, keep EXPIRED, invalidate assignment/checkpoint, increment generation attempt, job→QUEUED |
| dependency drift before approval | approve check commits ACTIVE→SUPERSEDED and job→WAITING_MATERIAL; owner resume invalidates assignment/checkpoint and requeues |
| dependency drift after approval | commit check suspends job in WAITING_MATERIAL with no business write; owner resume inserts approval invalidation, changes APPROVED→SUPERSEDED, invalidates assignment/checkpoint and requeues |
| material gap / RUNNING | suspend WAITING_MATERIAL; no business write |
| owner resume WAITING_MATERIAL | invalidate proposal/approval/assignment/checkpoint, increment generation attempt, job→QUEUED |
| cancel QUEUED or RUNNING before proposal | set cancel time and STOPPED, clear lease, append one stop event; AbortSignal stops external work |
| cancel ACTIVE before approval | ACTIVE→SUPERSEDED; job→STOPPED; no approval/business write |
| cancel APPROVED before commit | insert approval invalidation; APPROVED→SUPERSEDED; job→STOPPED; no business write |
| cancel WAITING_MATERIAL without proposal | invalidate assignment/checkpoint; job→STOPPED |
| cancel WAITING_MATERIAL with APPROVED proposal | insert invalidation; APPROVED→SUPERSEDED; invalidate assignment/checkpoint; job→STOPPED |
| cancel WAITING_APPROVAL with EXPIRED proposal | keep EXPIRED audit row; job→STOPPED |
| cancel deterministic shadow before seal | job→STOPPED, no SHADOW_COMPLETED proposal |
| cancel after SUCCEEDED/FAILED/STOPPED | idempotently return terminal job; append no event |
| cancel racing commit | locked job/cancel predicate decides; either full commit then SUCCEEDED, or full rollback then STOPPED, never both |

`WAITING_MATERIAL` never changes directly to `SUCCEEDED`. Only the
owner-scoped resume transaction can invalidate the prior attempt and move the
job to QUEUED; a new execution may later succeed.

The existing resume route is extended to accept `WAITING_APPROVAL` only when
its locked current proposal is EXPIRED or SUPERSEDED; all other waiting-
approval resumes return `AUTHORING_APPROVAL_REQUIRED`. It continues to accept
`WAITING_MATERIAL` under the invalidation transaction above.
`AUTHORING_OPERATION_AMBIGUOUS` uses
`OPERATION_AMBIGUOUS_FAIL/workflow.failed`, is terminal `FAILED` with no
proposal or business write, and replay requires a new idempotency key/job.

Proposal sweeper behavior is exact:

- batch size defaults to 100;
- for each candidate it locks project, job and proposal in the section 11
  order, requires job=WAITING_APPROVAL, proposal=ACTIVE, no cancellation and
  `expires_at<=NOW(6)`, then CAS-updates ACTIVE→EXPIRED and appends the event
  in one transaction; waiting jobs have no lease, so no fictitious worker
  fence is required;
- it sets `sealed_payload=NULL` and `payload_scrubbed_at=NOW(6)` only when
  state is `COMMITTED | SUPERSEDED | EXPIRED | SHADOW_COMPLETED`,
  `payload_scrubbed_at IS NULL` and immutable
  `payload_scrub_after<=NOW(6)`;
- before that update it locks project, job and proposal in the standard order,
  closed-parses and re-canonicalizes the stored sealed payload, verifies its
  envelope/payload/artifact and row digest bindings, and requires the row
  `payload_scrub_after` to equal the sealed envelope value; any mismatch is
  `AUTHORING_PROPOSAL_PAYLOAD_CORRUPT` and leaves bytes untouched;
- the final CAS includes proposal ID, unchanged state, non-null payload,
  null scrub timestamp and the scrub-after predicate. The immutable trigger
  independently enforces the same-state, due-time, one-way nulling shape;
- ACTIVE and APPROVED payloads are never scrubbed. If their scrub time passes,
  they become eligible only after a later transition reaches an eligible
  terminal proposal state;
- audit rows and digests are retained indefinitely; no proposal, approval or
  invalidation row is deleted.

Project/user tombstone uses the same
user→project→job→proposal→approval lock order:
ACTIVE becomes SUPERSEDED, APPROVED first gets an invalidation then becomes
SUPERSEDED, EXPIRED remains EXPIRED, and every non-terminal job becomes
STOPPED. This covers waiting, queued and running jobs without an unlisted
proposal state.

## 12. API events and compatibility

New persisted events:

- `authoring.snapshot_created`
- `authoring.evidence_ready`
- `authoring.proposal_sealed`
- `authoring.review_failed`
- `authoring.repair_started`
- `workflow.waiting_approval`
- `workflow.waiting_material`
- `workflow.approved`
- `workflow.resumed`
- `authoring.proposal_expired`
- `authoring.business_committed`
- `workflow.succeeded`
- `workflow.failed`
- `workflow.stopped`
- `project.tombstoned`
- `user.tombstoned`

Events expose IDs, versions, bounded reason codes and low-cardinality metrics.
They never expose capability data, approval nonce/digest, prompts, raw model
output or evidence bodies. SSE keeps persisted sequence IDs and
`Last-Event-ID` recovery.

Legacy routes retain their existing response contract and never select
`deterministic-authoring.v1` before Task 12. No auto-approval compatibility
shortcut is permitted.

## 13. Module boundaries

New backend module: `backend/src/authoring/`.

- `contracts/`: closed proposal, checkpoint, outcome and approval schemas;
- `graph/`: versioned transitions and executor;
- `nodes/`: access, snapshot, retrieval, generation, validation, review and
  repair;
- `proposals/`: canonicalizers, store, recovery and sweeper;
- `approval/`: proposal view, approval service and capability provider;
- `committer/`: no-HTTP PM2 entrypoint, commit-candidate view parser and sole
  `sp_authoring_commit_v1` caller;
- `db-authority/`: golden authoring procedures, grants, invariant triggers and
  schema-contract probes;
- `persistence/`: pure artifact projectors and procedure request/receipt
  adapters; positive SQL lives only in the golden definer procedure;
- `validators/`: schema, domain, evidence, style and consistency gates;
- `rollout/`: exact config parser, policy digest and definition selector;
- `metrics/`: bounded node, repair, approval, latency, cost and failure data.

The workflow module owns dispatch, leases, suspension, status and events. The
authoring module owns graph semantics and positive persistence authority.
Content modules expose bounded repository primitives and current-head reads;
they do not decide workflow transitions or authorization.

## 14. Test and acceptance matrix

### Authority and security

- forged client/input/checkpoint authority fields;
- approval by another user/project;
- stale, expired, invalidated or superseded proposal;
- direct positive call without a real capability;
- serialization, replay, wrong operation/job/proposal/approval/fence/digest;
- second use of a consumed capability;
- API/worker/committer grant separation, direct protected-DML denial and
  forged session-variable non-authority;
- app cannot seal/commit, worker cannot approve/commit, and committer cannot
  seal/approve;
- existing Task 10B direct atomic commit rejection remains green.

### Selection and compatibility

- every row of the selection matrix;
- exhaustive selector Cartesian product and mixed-binary Redis gate;
- old-binary login revoked and new app/worker direct writes rejected by grants
  for all protected tables; invariant triggers reject malformed procedure
  effects;
- configuration case/empty/unknown safe-off outcomes and UUID/bound
  rejections;
- enforce legacy generation/save/current/PATCH bypass attempts;
- stored definition survives environment/allowlist changes and restart;
- stored policy/pricing/estimator snapshot survives configuration changes;
- exactly one executor per job;
- legacy SSE never waits for approval;
- deterministic shadow emits sealed bytes, writes no business rows and ends
  SUCCEEDED.

### Graph and lifecycle

- all six authoring workflows;
- structured repair 1, targeted revision 1, review repair 2;
- exhaustive nine-attempt path and prohibition on post-review targeted
  revision;
- call/token/cost budgets before and after provider usage;
- suspension outcomes do not call `complete()`;
- proposal insert/checkpoint/suspension and shadow-complete crash points are
  atomic;
- material gap, expiry, owner resume, drift, cancellation and lease loss at
  each node;
- checkpoint recovery without ambiguous operation replay;
- no STOPPED/FAILED/WAITING state reversal.

### Approval and persistence

- body proposal viewable before approval and absent from all business tables;
- directory/outline absent from business tables before approval;
- evidence coverage and `STRUCTURAL_ONLY` restrictions;
- exact approval envelopes and canonical digest goldens;
- full input/dependency/index/retrieval/assignment/outer/payload goldens for
  all six workflow types, including proposal ID/sequence and every component
  digest mutation attack;
- legacy Task10B approval/source digest cannot mint or substitute for a Task11
  approval/assignment digest;
- exact directory/outline runtime schema, evidence sidecars, artifact-kind
  mapping and canonical goldens;
- sealed directory UUIDs and exact DirectoryNodeDto/OutlineContentDto
  projector bytes survive approval unchanged;
- approval dispatch, duplicate approval and invalidation;
- atomic exact-byte business/ledger/head commit;
- concurrent first and later version allocation;
- two proposals from the same project/scope/head lock version cannot both
  promote; every project/material/template/directory/outline/body mutation
  increments the exact counter once;
- existing data head backfill, legacy head maintenance and enforce head guard;
- directory pointer/current-marker composite-FK backfill, split-brain
  rejection and commit/receipt equality;
- approved-body PATCH rejection and legacy unverified edit semantics;
- content-version/generation-bound claim/map reads and inheritance;
- cross-project/result/version/scope composite-FK attack matrix;
- 4 MiB body commit succeeds through reconciled MEDIUMTEXT columns;
- project tombstone and user/project FK retention behavior;
- duplicate delivery/domain commit recovery;
- commit receipt unknown-outcome match/mismatch and terminal event sequence;
- expired approval lookup and approved-cancel invalidation;
- exhaustive cancel/sweeper/tombstone state-lock matrix;
- repeated structured/review repair events in one generation have distinct
  transition-instance/event keys and idempotent replay;
- proposal-envelope preimage golden proves digest is not self-referential;
- latest/editor/export/revision-parent read the scope head only and surface its
  approved/unverified state;
- transaction rollback at every write boundary.

### Database and operations

- fresh/current/partial MySQL migrations and exact schema contract;
- old binary omitted-column insert;
- real service-identity permission tests prove old API/cleanup/move binaries,
  including a process started after activation census, cannot mutate/unlink
  protected blobs;
- storage promote/delete crash matrix, stale epoch/lease/fence, DB-role denial,
  symlink/path attacks and absence of protected rw Docker mounts;
- storage_preparing→storage_pending→pending outbox atomicity, definer
  column-grant golden, and rollback when outbox release affects zero rows;
- MySQL accepts every same-row CHECK, while cross-table storage state attacks
  are rejected by request/complete procedures;
- incompatible schema/data rejection and documented rollback floor;
- expiry/scrub batches with 1/30/365-day persisted policies,
  `payload_scrub_after` boundary CAS and indefinite digest/audit retention;
- bounded metrics with no content leakage;
- backend targeted/full tests, build, lint, Docker and PM2 health.

## 15. Implementation decomposition

After this specification is approved, Task 11 is planned and implemented as
independently reviewed increments:

1. storage broker, DB roles/intents, protected-path migration and OS/Docker
   isolation gates;
2. authoring procedure-only DB authority, API/worker/committer identities,
   lock counters and offline schema reconciliation;
3. stored selection, exact config parser, migration and schema contract;
4. executor outcome/suspension protocol and recovery tests;
5. proposal tables, stores, lifecycle and structured directory/outline
   schemas;
6. deterministic validators, review, budget and shadow graph;
7. approval envelopes, proposal API, invalidation and once-only capability;
8. directory/outline positive transactions and stable scope locks;
9. body exact-byte procedure transaction, grounding ledger and content heads;
10. lifecycle resume/expiry/cancel integration and legacy adapters;
11. full security, migration, concurrency and E2E verification.

Each increment follows RED → GREEN → refactor, receives a separate commit and
independent spec/quality review, and leaves the branch runnable.
