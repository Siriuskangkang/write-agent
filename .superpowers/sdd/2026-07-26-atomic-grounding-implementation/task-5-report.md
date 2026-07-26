# Task 5 Report: Off/Shadow Runtime and Double Commit Guard

## Scope and baseline

- Baseline: `f40ba56` (`fix: verify sealed checkpoint before recovery`)
- Runtime modes implemented: `off | shadow_no_persist`
- Unknown, empty, case-variant, and `enforce` values canonicalize to `off`
- Task 10B adds no capability provider, approval envelope, `enforce` branch,
  positive atomic domain commit, or atomic persistence path
- PM2 configuration impact: none; `ecosystem.config.cjs` was not changed

## TDD evidence

### Mode parser and environment

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/atomic-grounding-mode.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/config/environment.spec.ts \
  --runInBand --no-coverage)
```

RED result: 2 suites failed, 1 passed; 5 tests failed because the parser module
was missing and environment values remained uncanonicalized.

GREEN result: 3 suites passed, 46 tests passed.

### Executor shadow/off/recovery/revision runtime

RED command:

```bash
(cd backend && npx jest \
  src/workflow/workflow-generation.executor.spec.ts \
  src/workflow/workflow-material-gap.spec.ts \
  src/workflow/workflow-legacy-bridge.service.spec.ts \
  --runInBand --no-coverage)
```

RED result: 9 new runtime assertions failed while the two regression suites
passed. The old executor still invoked legacy text generation and omitted the
legacy contract discriminant.

GREEN result: 3 suites passed, 28 tests passed. A separate
`atomic_revision_retrieved` crash-window test was then observed failing
(19 pass, 1 fail) and passed after the retrieved checkpoint event was added
(20/20 executor tests).

Coverage includes:

- all four content-like types fail closed in strict `off`
- explicit non-strict input keeps the legacy route
- sealed server bytes only, UTF-16-safe chunks of at most 16 KiB UTF-8
- `atomic_sealed` checkpoint before token emission
- `atomic_shadow_complete` with `server_saved:false`, empty citations
- sealed recovery revalidation, identical bytes, zero model/domain calls
- drift produces no token or done
- one targeted structured revision with stable keys/reasons
- TTFT recorded once immediately before a real rendered token on fresh and
  recovered execution

### Domain commit guard

RED result: 4 atomic guard variants incorrectly resolved instead of rejecting;
the legacy grounding test passed.

GREEN result: 5/5 passed. A valid envelope, `approved_at`, forged checkpoint
capability, forged input capability, and `ATOMIC_GROUNDING_MODE=enforce` all
reject with `ATOMIC_COMMIT_NOT_AUTHORIZED` before `findCommitted()` or
`DataSource.transaction()`.

### Failure persistence

RED result: 4 atomic dispositions were incorrectly collapsed to
`FAILED / WORKFLOW_FAILED`.

GREEN result: 7/7 passed. Internal reason, public code, transition, stable
candidate keys, safe events, and checkpoint fields are preserved. Unknown
atomic failures map only to
`INTERNAL_FAIL_CLOSED / ATOMIC_GROUNDING_FAILED / FAILED`.

### Dedicated real-MySQL runner

Initial RED:

```text
npm error Missing script: "test:e2e:atomic-grounding"
```

The first complete runner invocation started Docker/MySQL, ran all six
non-skippable tests, and reported 3 passed/3 failed. Those failures caught:

- the executor passing the checkpoint wrapper instead of `sealed_candidate`
  to recovery;
- unrealistic drift fixtures that changed assignment fields without changing
  the snapshot digest;
- a test helper default that turned `undefined` mode into shadow.

After correction:

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
atomic grounding E2E count gate: 6 passed, 0 skipped, 0 failed
```

The runner parses Jest JSON and requires exactly
`numTotalTests=6`, `numPassedTests=6`, `numPendingTests=0`,
`numFailedTests=0`, and `success=true`.

Every test asserts zero rows in:

- `writing_results`
- `content_versions`
- `directory_versions`
- `outline_versions`
- `citation_maps`

It additionally asserts zero `workflow_domain_commits` and
`grounding_claims`.

## Verification evidence

Targeted Task 1-5 regression:

```text
Test Suites: 23 passed, 23 total
Tests:       540 passed, 540 total
```

Full backend unit regression:

```text
Test Suites: 4 skipped, 91 passed, 91 of 95 total
Tests:       48 skipped, 1024 passed, 1072 total
```

The skipped suites are pre-existing conditional suites; Task 5's dedicated
six-test MySQL suite is plain `describe`, non-skippable, and separately gated.

Migration E2E:

```text
Test Suites: 1 passed, 1 total
Tests:       45 passed, 45 total
```

Build:

```text
npm run build
exit 0
```

Lint:

```text
npm run lint:check
exit 0; 0 errors
```

The 31 printed warnings are pre-existing warnings outside Task 5 files.
Task 5 changed-file ESLint completed with zero errors and zero warnings.

Static boundaries:

- Task 11 production-only reference scan: no matches
- legacy authority dependency scan: no matches
- all ten rollout metric names: present
- `git diff --check`: no output

Docker cleanup:

- `docker ps -a` filtered by `write-agent-atomic-shadow` and
  `write-agent-migration-e2e` returned no containers after both E2E commands
- each suite stops only its exact generated container name in `afterAll`

## Rollout artifact

`docs/operations/atomic-grounding-shadow-rollout.md` contains:

- exact metric names and closed label allowlists
- ID/prompt/output/claim/evidence text prohibition
- proposal, claim, fail-closed, material-gap, revision, and repair aggregates
- p50/p95 proposal bytes, claim count, render latency, and TTFT queries

## Residual concerns

- `shadow_no_persist` buffers and validates the complete structured proposal
  before the first rendered token, so TTFT may increase. The rollout exposes
  this explicitly.
- Task 10B intentionally has no positive atomic commit path. Enabling
  persistence requires a separately reviewed capability plus digest-bound
  approval in Task 11.

## Fix Round 1/5 — independent review findings

Baseline: `feb6604` (`feat: shadow atomic grounding without persistence`).
This round addresses all 2 Critical and 5 Important findings recorded in
`task-5-review.md`.

### RED evidence

The first executor regression run failed 7 assertions and passed 19. The
failures proved that all four durable atomic phases could be routed through
legacy commit when `strict_citation` was false/missing/forged, TTFT was
recorded before progress persistence, and atomic token checkpoints had no
recoverable UTF-16 offset.

The first workflow-store regression run failed 2 assertions and passed 7. It
proved that caller-supplied `public_code`/`transition` fields were trusted and
that persisting `atomic_revision_required` did not reserve
`targeted_revision_attempts`.

The worker exporter endpoint test initially failed at module resolution because
no production worker metrics listener existed.

The second recovery-focused RED run failed 4 assertions and passed 39. It
proved that non-content workflows could still accept atomic checkpoints, that
the model-success crash boundary was not exercised, and that failure
classification still depended on an inferred transition instead of an
explicit revision attempt.

An independent verification pass then rejected an intermediate
`atomic_revision_model_completed` design because it persisted the structured
provider proposal as a naked alternate output. That checkpoint, its recovery
branch, and its tests were removed. The final regression instead proves the
locked boundary: the coordinator completes schema parsing, verification,
revision-invariant validation, rendering, and sealing, then awaits persistence
of the full sealed candidate before it can return. After this correction, the
targeted run passed 6 suites and 161 tests.

### Resolution by finding

1. Atomic checkpoint routing is checkpoint-first. Every persisted
   `atomic_revision_required`, `atomic_revision_retrieved`, `atomic_sealed`, or
   `atomic_shadow_complete` phase stays on the atomic path independently of
   mutable request strictness. A non-content workflow paired with any atomic
   phase fails closed before generation or commit. Mode-off recovery also fails
   closed and never reaches legacy model/domain writes.
2. `MysqlWorkflowExecutionStore.persistProgress()` now reserves
   `targeted_revision_attempts: 0 -> 1`, clears the stale assignment digest, and
   persists the revision-required checkpoint/event in one fenced transaction.
   An exact retry is idempotent. Revision generation has a dedicated
   `ContentService`/`ContentGenerationService` path which loads the merged
   assignment and does not perform initial retrieval or compress inheritance.
3. Every token progress checkpoint persists cumulative `emitted_utf16`.
   Recovery validates that the offset is in range and not inside a surrogate
   pair, then emits only the remaining suffix.
4. A revision-1 sealed candidate is persisted through the engine's fenced
   progress callback inside the coordinator boundary before the coordinator
   returns. Recovery starts from the digest-bound `atomic_sealed` candidate and
   makes zero repeated structured-model calls. No structured provider proposal,
   raw provider output, or naked alternate output is persisted.
5. TTFT is attached to the first token event as an idempotent post-persist
   callback. The engine invokes it only after `persistProgress()` succeeds;
   cancellation or lease loss before that write records no sample.
6. Atomic execution failures are accepted only as trusted typed failure
   instances. The store derives public code and workflow transition from the
   closed reason policy; forged structural objects fall back to the generic
   safe workflow failure.
7. The metrics sink token is bound to the concrete in-memory Prometheus
   exporter. Because generation runs in the separate worker process, that same
   worker exporter is exposed at a dedicated loopback-only `/metrics` listener
   (default `127.0.0.1:9465`). The listener mounts no application routes.
   PM2, Docker Compose, `.env.example`, and the rollout runbook document the
   real scrape target and all exposed low-cardinality series.

### Real MySQL recovery proof

The non-skippable exact-six MySQL 8.4 suite remains exactly six tests. Its
recovery case now persists a real first-token event through
`MysqlWorkflowExecutionStore`, expires/reclaims the lease, and proves
`prefix + recoveredSuffix` is byte-identical with no second model call. Its
assignment case now proves the revision CAS and identical retry against MySQL,
replaces evidence through the real `SqlGroundingEvidenceStore`, verifies the
merged retrieval-run references, and invokes the real `ContentService`
revision facade over that assignment.

```text
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
atomic grounding E2E count gate: 6 passed, 0 skipped, 0 failed
```

The suite continues to assert zero domain writes after every test.

### Round 1 verification

```text
Targeted coordinator/content/executor suites: 6 passed, 161 tests passed
Metrics/worker suites: 5 passed, 23 tests passed
Full backend unit: 93 passed, 4 conditional suites skipped;
  1044 passed, 48 conditional tests skipped
Atomic exact-six MySQL: 1 suite passed, 6 passed, 0 skipped, 0 failed
Migration E2E: 1 suite passed, 45 tests passed
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Task 11 production scan: no matches
Legacy authority production scan: no matches
Naked provider/revision-result production scan: no matches
git diff --check: no output
```

Round-1 precommit verification concluded `APPROVED` after confirming the
sealed-before-return crash boundary, zero-model recovery, checkpoint-first
non-content fail-closed behavior, explicit revision-attempt failure mapping,
and the absence of naked provider output in production code.
The subsequent formal controller review found 4 Important recovery/idempotency
gaps and 1 Minor test-fidelity issue; those findings drove fix round 2.

Task 10B remains `off | shadow_no_persist`. This round does not add an
approval capability, an `enforce` branch, a positive atomic domain commit, or
writing/version/claim/citation persistence.

## Fix Round 2/5 — operation idempotency and complete recovery

Baseline: `aa44cff` (`fix: close atomic shadow recovery gaps`). This round
addresses the remaining 4 Important and 1 Minor findings from the first
fix-round review.

### RED evidence

The initial five-suite regression run failed 10 assertions and passed 48. It
proved that a revision model operation could be dispatched again after a
provider-success ambiguity, terminal targeted retrieval was not reusable
between retrieval completion and assignment replacement, completed
checkpoints bypassed recovery validation, identical revision reservations
wrote duplicate events, and the MySQL Unicode recovery fixture did not use a
legitimately sealed candidate.

The first independent verification pass then found a second retry layer: both
installed provider SDKs defaulted to two internal transport retries. Two
provider contract tests failed while the revision request carried only a
correlation header. The adapters now set request-level `maxRetries: 0` whenever
the stable operation key is present; the same tests pass while ordinary
non-revision requests retain their existing SDK behavior.

### Resolution by finding

1. Before revision provider I/O, the executor durably records
   `atomic_revision_model_started` with a canonical SHA-256 operation key.
   `model_runs.operation_key` is unique and queryable through the real model
   recorder. A recorded or uninspectable operation without a sealed candidate
   is ambiguous and fails closed; only a proven-absent operation may dispatch.
   Revision calls disable gateway retry, provider-SDK retry, and structured
   repair, so the model is invoked at most once for the operation. Provider
   request headers are correlation metadata only and are not treated as replay
   guarantees.
2. Targeted retrieval carries the stable `(workflow_job_id,
   revision_attempt=1)` scope through `ContentService`,
   `ContentGenerationService`, `ContentSharedService`, `RetrievalService`, and
   `HybridRetriever`. `RetrievalPersistenceService.startIdempotent()` locks the
   real workflow job, digest-binds the complete request and retrieval config,
   creates at most one run, and reconstructs terminal evidence from MySQL.
   A terminal run is reused after a crash before assignment replacement;
   digest mismatch or a `RUNNING` ambiguity fails closed without another
   backend call.
3. `atomic_shadow_complete` now rechecks mode, an explicit strict contract,
   the sealed envelope, current assignment and render dependencies,
   generation/revision identity, and the exact full UTF-16 offset before
   returning success. Missing, forged, corrupt, stale, partial, or mode-off
   checkpoints fail closed.
4. The `atomic_revision_required` reservation returns whether the CAS changed
   state. An identical persisted retry returns before the job update and event
   append, producing exactly one revision-required event.
5. The exact-six MySQL Unicode case now creates a large valid proposal and
   evidence set, seals it with the production `sealGroundedCandidateV1`,
   persists a real partial token checkpoint, and recovers through the real
   `ContentService` and `AtomicGroundingCoordinator`. It no longer mutates
   sealed output or mocks recovery.

The additive `1713340000000-HardenAtomicOperationIdempotency` migration adds
the model operation key and targeted-retrieval scope/digest with unique keys
and a workflow ownership foreign key. Its destructive `down()` path is
explicitly forbidden. Migration compatibility covers both the predecessor
schema and the current 45-migration schema.

### Round 2 verification

```text
Focused model/provider/retrieval/executor/store regression:
  6 suites, 110 tests passed
Full backend unit: 94 passed, 4 conditional suites skipped;
  1061 passed, 48 conditional tests skipped
Atomic exact-six MySQL: 1 suite passed, 6 passed, 0 skipped, 0 failed
Migration E2E: 1 suite passed, 45 tests passed
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Task 11 production scan: no matches
Legacy authority production scan: no matches
Naked provider/revision-result production scan: no matches
Docker residue: none
git diff --check: no output
```

Round-2 precommit verification concluded `APPROVED`. The verifier confirmed
that revision gateway retries, structured repair, and both provider-SDK retry
layers are disabled; ordinary requests without an operation key are unchanged.
Its fresh review run passed 4 focused suites / 129 tests and the exact-six
MySQL gate / 6 tests, with no remaining findings.
The subsequent formal controller review found 2 Important gaps in complete
model-request fingerprinting and the closed migration/schema contract.

## Fix Round 3/5 — complete model identity and closed schema contract

Baseline: `536379e` (`fix: make atomic recovery operations idempotent`). This
round addresses the two Important findings from the second fix-round review.

### RED evidence

The model-gateway RED run failed 2 new assertions and passed 42 existing
assertions: no provider-free prepared operation existed, so provider/model,
schema, merged messages and response parameters could not form the durable
operation identity. The model-run RED then rejected the new safe schema
metadata, proving that recovery could not compare a complete recorded
identity.

The MySQL 8.4 RED run failed both new tests. Fresh schema lacked
`model_runs.request_fingerprint`, and the migration silently accepted a
same-name `operation_key VARCHAR(63)` instead of failing before DDL.

The independent precommit pass then found two further concrete gaps. A
post-prepare mutation regression failed 1 assertion while 45 gateway tests
passed: the fingerprint retained the original schema digest while the adapter
received the caller-mutated schema. A real MySQL weak same-name CHECK
regression failed 1 test while 47 were filtered: removing all parentheses
during comparison made a CHECK with `IS TRUE` attached only to the targeted
branch look identical to the required whole-predicate guard.

### Resolution by finding

1. `groundedDraftChain` now has one pure request builder. Revision preparation
   loads and retains the exact assignment, approved render context, authoring
   context and merged evidence, builds one real `ModelRequest`, then asks the
   gateway for an opaque prepared handle. Preparation resolves and locks the
   actual adapter/provider/model but performs no recorder write or provider
   I/O.
2. The canonical request fingerprint covers normalized messages, actual
   provider/model, response mode, schema id/version/JSON digest, tools and tool
   choice, temperature, maximum tokens, timeout, retry/repair/delay policy and
   the single-dispatch policy version. The operation key additionally binds
   the workflow job, node and generation attempt. The prepared handle can be
   dispatched only once. Preparation canonical-clones and deep-freezes nested
   messages, schema JSON, tools, tool choice and trace metadata, captures the
   schema parser, and freezes the exact dispatch request, so later caller
   mutation cannot separate the identity from the provider request.
3. The executor durably persists only the safe operation identity before
   dispatch. Recovery rebuilds through the same preparation chain and compares
   operation key, request fingerprint, prompt digest, provider/model and every
   schema identity field before querying `model_runs`. Recorded, mismatched or
   unknown states fail closed without a second provider call; only an exact
   rebuilt identity with a proven-absent run may dispatch.
4. `model_runs` stores the safe request fingerprint and allowlisted schema
   version/digest metadata. It never stores messages, authoring/render/evidence
   bodies or provider output. Its lookup returns `mismatch` unless the complete
   safe identity is equal.
5. Migration `171334` now preflights every existing same-name object before
   DDL, adds and immediately verifies the model fingerprint plus atomic
   retrieval columns, and rejects incompatible column types/nullability/
   collation, index uniqueness/order/type, FK source/target/actions and CHECK
   semantics. Existing duplicate operations/revisions, orphan workflow jobs
   and invalid scope rows fail with stable closed errors.
6. The enforced retrieval CHECK admits only either three NULL generic scope
   fields or a targeted scope with a non-NULL workflow job, exactly
   `revision_attempt=1`, and a lowercase 64-hex request digest. The entire
   predicate is wrapped in `IS TRUE`, so MySQL's normal CHECK acceptance of
   `UNKNOWN` cannot admit partial rows. A narrow reusable atomic-operation
   schema contract performs the same canonical verification outside the
   migration glob. Its shared token/parser comparison preserves AND/OR
   grouping and the exact attachment of `IS TRUE` while accepting MySQL 8.4's
   harmless backticks, charset introducers, escaped quotes and redundant
   parentheses.

### Round 3 verification

```text
Focused model/coordinator/content/executor regression:
  7 suites, 222 tests passed
Full backend unit: 94 passed, 4 conditional suites skipped;
  1066 passed, 48 conditional tests skipped
Atomic exact-six MySQL: 1 suite passed, 6 passed, 0 skipped, 0 failed
Migration E2E: 1 suite passed, 48 tests passed
Documented ts-node migration command: passed
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Task 11 production scan: no matches
Legacy authority production scan: no matches
Naked provider/revision-result production scan: no matches
Docker residue: none
git diff --check: no output
```

Task 10B remains `off | shadow_no_persist`. This round does not add approval,
enforcement, positive atomic domain commit or publication capability.

Round-3 precommit verification concluded `APPROVED` with zero findings.
The verifier independently passed the gateway 46-test suite, a built-code
post-prepare schema/tool mutation probe, 107 downstream
grounded-chain/coordinator/executor tests, both the valid and weak same-name
real-MySQL CHECK probes, build, production scans, diff check and Docker-residue
check.
The subsequent formal controller review found 3 Important edge cases in numeric
request validation, MySQL regex-literal semantics and pre-DDL incompatible-data
checks.

## Fix Round 4/5 — numeric request closure and pre-DDL safety

Baseline: `26658f9` (`fix: bind atomic operations to complete requests`). This
round addresses the three Important findings from the third fix-round review.

### RED evidence

The numeric boundary table initially failed 57 assertions while 47 gateway
tests passed. `temperature`, `max_tokens` and `trace.attempt` admitted invalid
runtime values; fields that were already rejected by `validateRequest()` still
caused the ordinary stream path to create its provider first.
An expanded independent boundary table then failed 48 assertions while 108
LLM tests passed, proving that `estimateWorstCaseCost()` also created its
provider before validating the same invalid request values.

The CHECK literal regression failed 1 assertion while 48 migration tests were
filtered: the clause parser removed the semantic backslash from
`^[0-9a\\-f]{64}$` and treated it as the required lowercase-hex regex.

Two independent real-MySQL partial-schema tests each failed 1 assertion while
50 tests were filtered. Their `information_schema` plus `SHOW CREATE TABLE`
snapshots showed that rejection had already added
`model_runs.request_fingerprint` and the missing retrieval scope columns.

### Resolution by finding

1. Every numeric `ModelRequest` field that affects dispatch or operation
   identity is validated before factory creation: finite `temperature` in
   `[0,2]`, positive safe-integer `max_tokens`, positive safe-integer
   `trace.attempt`, and the existing bounded timeout/retry/repair/delay
   integers. `null`, strings, NaN, infinities, fractions and out-of-range
   values fail before factory, provider or recorder I/O in preparation,
   streaming and worst-case cost estimation. Prepared requests normalize
   negative zero and all explicit/omitted defaults before both fingerprinting
   and dispatch.
2. The MySQL CHECK parser now removes only harmless metadata quoting syntax;
   it preserves backslashes inside parsed string literal values. Raw clauses,
   MySQL escaped delimiters, charset introducers, backticks, redundant
   parentheses and doubled quotes remain covered without collapsing a regex
   that accepts hyphens and rejects `b` into the required lowercase-hex
   contract.
3. Migration `171334` collects and validates the existing object shape, then
   validates all existing data before the first `ALTER` or `CREATE`. Missing
   members of the retrieval scope triplet are evaluated as their future
   `NULL` values, so only rows that can safely complete are admitted.
   Duplicate model operations, duplicate targeted revisions, orphan workflow
   scopes, invalid attempts and invalid digests all fail against the partial
   schema without changing either information-schema metadata or `SHOW CREATE`
   output. Safe partial state completes and remains idempotent on rerun.

### Round 4 author verification

```text
Focused model/coordinator/content/executor regression:
  7 suites, 280 tests passed
Full backend unit: 94 passed, 4 conditional suites skipped;
  1124 passed, 48 conditional tests skipped
Atomic exact-six MySQL: exactly one invocation, 6 passed, 0 skipped, 0 failed
Migration E2E: 1 suite passed, 51 tests passed
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Task 11 production scan: no matches
Legacy authority production scan: no matches
Naked provider/revision-result production scan: no matches
Docker residue: none
git diff --check: no output
```

Task 10B remains `off | shadow_no_persist`. This round does not add approval,
enforcement, positive atomic domain commit or publication capability.

Round-4 precommit verification reported **Spec PASS / Quality APPROVED**, with
0 Critical, 0 Important and 0 Minor findings. The verifier freshly passed
156/156 LLM tests, 4/4 targeted real-MySQL migration tests, build, lint with
0 errors and 31 pre-existing warnings, all three production-boundary scans,
`git diff --check`, and Docker-residue checks. Exact-six was not rerun; the
author's sole round-4 invocation remains 6/6.

The subsequent formal controller review was **Spec FAIL / Quality CHANGES
REQUIRED**, with 2 Important and 1 Minor findings: the complete ModelGateway
public runtime boundary was not closed before dependency I/O, foreign-key name
preflight was incorrectly table-scoped even though MySQL foreign-key symbols
are schema-scoped, and the report/ledger conflated precommit verification with
formal controller approval.

## Fix Round 5/5 — closed runtime boundary and schema-global DDL preflight

Baseline: `99fda29` (`fix: close atomic operation edge cases`). This round
addresses all 2 Important and 1 Minor findings from the fourth formal review.

### RED evidence

The new public-boundary matrix initially failed 160 assertions while 74 passed.
It proved that malformed messages, schemas, traces, tools, signals and usage
could reach the provider factory, that direct and prepared dispatch used
different canonical state, and that `calculateUsageCost()` and
`inspectOperation()` accepted unvalidated runtime objects. After the boundary
was closed, a mutation test that relaxed each runtime cap by one produced the
three expected failures for `max_tokens=1000001`,
`timeout_ms=2147483648`, and `trace.attempt=4294967289`; restoring the exact
caps returned the 238-test boundary suite to green. A deferred-recorder probe
also mutates the caller's direct request while dependency I/O is awaited and
proves the adapter still receives the original canonical snapshot.
An adjacent adapter-descriptor RED then proved provider, model and stream
getters were read twice; the final resolver reads, validates and captures each
exactly once.
Fresh precommit adversarial probes found further instances of the same
Important boundary family: a role and idempotency-key object could exploit
implicit string coercion; an Array subclass could override `map()`; a tool
accessor could change between validation and cloning; a Proxy could change a
numeric field after descriptor inspection; and a branded AbortSignal could
override the listener method consumed after factory creation. Each built-code
probe was reproduced by an all-entrypoint RED and then closed.

The real-MySQL migration target initially failed 7 tests and passed only the
existing schema-global CHECK collision case. A same-schema foreign key on
another table reached MySQL's duplicate-symbol error after earlier DDL, while
wrong table collations, a mismatched referenced-column collation, a missing
referenced primary key, an incompatible engine and a missing `AFTER` anchor all
left partial atomic columns or indexes. Each test compares both
`information_schema` metadata and `SHOW CREATE TABLE` before and after failure.
A later cross-schema RED proved that a correctly named FK targeting
`other_schema.workflow_jobs(id)` was accepted as exact. The final contract now
also requires `REFERENCED_TABLE_SCHEMA = DATABASE()` and preserves both schema
snapshots on rejection.

### Resolution by finding

1. Every `ModelGateway` public entrypoint now validates and canonicalizes its
   complete input before factory, adapter, recorder or pricing I/O:
   `estimateWorstCaseCost()`, `calculateUsageCost()`,
   `prepareSingleDispatch()`, `completePrepared()`, `inspectOperation()`,
   `stream()` and `complete()`. The closed contracts cover exact object keys,
   dense bounded message arrays, NFC-normalized strings, finite bounded
   numerics, internally consistent usage, real native `AbortSignal` branding,
   bounded acyclic pure-JSON schema/tool data, and exact trace/operation
   identities. Pure-data records reject Proxies and accessors; arrays must use
   the native Array prototype; enum/digest fields require actual strings; and a
   signal must retain the current native AbortSignal/EventTarget methods.
   Direct and prepared requests share the same canonical snapshot, defaults and
   negative-zero representation. Adapter identity and dispatch function are
   captured exactly once, and invalid input cannot touch a dependency.
2. The conservative cost estimator includes the complete canonical request,
   including schema and tools. Explicit upper bounds prevent timer clamping,
   impractical token allocations and generation-attempt overflow after retry
   and repair offsets.
3. Migration `171334` now queries a foreign-key symbol across the whole current
   schema and verifies that the sole match belongs to `retrieval_runs`; the
   reusable schema-contract checker uses the same scope and exact referenced
   schema. MySQL documents
   foreign-key symbols as unique in a database, while CHECK constraints use a
   separate schema-wide per-constraint-type namespace:
   <https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html> and
   <https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html>.
4. Before the first DDL statement, the migration verifies all three tables are
   non-partitioned InnoDB tables with the required default collation; validates
   both `AFTER` anchors; validates `workflow_jobs.id` and its exact primary key;
   rejects incompatible existing column order and descending/invisible/prefix
   indexes; and emits explicit charset/collation on every new character column.
   All conflict and prerequisite cases now fail with stable schema-drift errors
   and byte-for-byte equivalent schema snapshots.
5. The ledger and this report now label independent author-lane checks as
   precommit verification. Only the later controller review can grant formal
   task approval; round-5 formal review remains pending.

### Round 5 author verification

```text
Gateway boundary + regression: 2 suites passed, 367 tests passed
Focused global/prerequisite/cross-schema migration matrix: 9 tests passed
Full backend unit: 95 passed, 4 conditional suites skipped;
  1387 passed, 48 conditional tests skipped
Atomic exact-six MySQL: exactly one invocation, 6 passed, 0 skipped, 0 failed
Migration E2E: 1 suite passed, 60 tests passed
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Production boundary scans: all three returned no matches
Docker residue: none
Temporary Jest JSON residue: none
git diff --check: no output
```

Task 10B remains `off | shadow_no_persist`. This round does not add approval,
enforcement, positive atomic domain commit or publication capability.

Round-5 independent precommit verification: **Spec PASS / Quality APPROVED**,
with 0 Critical, 0 Important and 0 Minor findings. Its fresh evidence included
367/367 Gateway tests, all five built-code coercion/descriptor/Proxy/signal
attacks rejected before dependency I/O, the 9/9 focused migration matrix,
60/60 full migration E2E, 1387 unit tests, build, lint, production scans,
diff/residue checks and an explicit confirmation that exact-six was not rerun.

Formal controller review: **Spec FAIL / Quality CHANGES REQUIRED**, with one
Important finding. A genuine signal could be validated and then gain
behaviorally hostile own/prototype properties while `startAttempt()` was
awaited; the canonical request retained the caller object and later invoked
those mutable properties. Task 5 exhausted its five repair rounds, so the
remaining finding moved to the separately bounded Task 5R below.

## Task 5R — TOCTOU-safe AbortSignal boundary

Baseline: `61725eb` (`fix: close gateway and migration boundaries`).
Scope was limited to the remaining ModelGateway AbortSignal finding. No
migration, workflow, grounding, provider-adapter or domain-persistence behavior
was reopened.

### RED evidence

The initial direct/prepared adversarial matrix produced exactly:

```text
Gateway boundary: 266 passed, 6 failed
  caller own aborted/reason/add/remove invoked after startAttempt: 2 failed
  EventTarget prototype remove invoked after startAttempt: 2 failed
  forged post-validation abort reason reached provider: 2 failed
```

The failures occurred only after the request had passed validation and
recorder persistence had begun, reproducing the formal TOCTOU finding rather
than an input-shape failure.

### Resolution

1. Module initialization captures the native `AbortSignal.aborted`,
   `AbortSignal.reason`, `AbortSignal.throwIfAborted` and
   `EventTarget.addEventListener/removeEventListener` intrinsics. All later
   calls use `Reflect.apply` with the branded signal as receiver.
2. Request canonicalization no longer retains caller-resolved signal
   properties or methods. It performs native internal-slot brand probes,
   rejects Proxy/duck signals and initially overridden protected members before
   dependency I/O, then stores only a frozen trusted-helper snapshot. It does
   not rely on prototype identity or `instanceof`.
3. Every dispatch creates a gateway-owned native signal mirror. Its public
   getters and listener methods are non-configurable wrappers over the captured
   intrinsics, and the mirror is non-extensible before reaching the provider.
4. Initial dispatch, prepared dispatch, recorder awaits, provider await,
   success/error persistence, retry delay, abort reason propagation and
   listener cleanup use the same trusted helpers. Listener registration follows
   add-then-recheck ordering, and every attempt removes its external listener
   in `finally`.
5. The regression matrix now covers all public request entrypoints for
   dependency-zero rejection; direct/prepared cancellation before dispatch,
   during provider execution and during retry delay; own/prototype mutation in
   every material await window; already-aborted signals; exact provider-visible
   reason; and repeated completion/error cleanup.

The Node test VM exposes no independent Web `AbortController`/`EventTarget`
realm, so no fake cross-realm fixture was claimed. The production check is
realm-agnostic where the runtime supports compatible native internal slots:
it uses captured native getter/EventTarget brand checks, not duck typing,
constructor equality or prototype identity.

### Task 5R author verification

```text
Gateway boundary + core regression: 2 suites, 409 tests passed
Task 10B proportional regression: 19 suites, 789 tests passed
Full backend unit: 95 passed suites, 4 conditional suites skipped;
  1429 passed, 48 conditional tests skipped
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Signal direct-property production scan: no matches
Task 11 and legacy-authority production scans: no matches
Migration diff from 61725eb: empty
git diff --check: no output
```

Per the bounded recovery scope, atomic exact-six MySQL and migration E2E were
not rerun: neither migrations nor database/runtime workflow code changed.

The fresh read-only precommit verifier first found one Important test-coverage
gap. After adding the Proxy, initial-own-key, provider-await, retry-delay and
success/error persistence matrices, it returned **Spec PASS / Quality
APPROVED**, with 0 findings and fresh 409/409 focused tests plus build and diff
checks.

Task 5R formal controller review: **Spec FAIL / Quality CHANGES REQUIRED**,
with one Important finding. The caller signal was isolated, but the internal
mirror still invoked mutable `AbortController.prototype.abort` dynamically.
Changing that prototype during an await window could execute attacker code,
leave the provider mirror un-aborted and turn a real cancellation into a
successful completion. Timeout used the same mutable path.

## Task 5R Fix Round 1/5 — captured controller abort intrinsic

Baseline: `320d5d4` (`fix: harden model gateway abort signals`).
This round changes only the remaining controller-abort primitive and its
adversarial regression matrix.

### RED evidence

The expanded direct/prepared matrix kept the attack function terminating by
delegating to a test-module-captured native abort. That avoided hangs and
proved the failure was specifically the attacker method invocation:

```text
Gateway + boundary: 413 total, 399 passed, 14 failed
  startAttempt persistence: 2 failed
  provider await prototype mutation: 2 failed
  finishAttempt success/error persistence: 4 failed
  retry delay cancellation: 2 failed
  timeout after validation: 2 failed
  AbortController prototype already tampered before request: 2 failed
```

Every failure observed exactly one attacker call. Provider cancellation,
reason and terminal behavior remained executable only because the attacker
explicitly delegated to the native method.

### Resolution

1. Module initialization captures `AbortController.prototype.abort` beside the
   existing AbortSignal/EventTarget intrinsics.
2. Both gateway-owned controller termination paths—external cancellation relay
   and timeout—call one `abortGatewayOwnedController()` helper, which invokes
   the captured method with `Reflect.apply`.
3. Production `model-gateway.ts` now contains zero dynamic `.abort(` calls and
   exactly one `AbortController.prototype.abort` lookup, at module
   initialization.
4. The regression matrix tampers the abort prototype after validation during
   `startAttempt`, provider await, success/error `finishAttempt`, retry delay
   and timeout, for direct and prepared operations. It also covers an already
   tampered prototype before request validation/dispatch.
5. Tests assert zero attacker calls, a truly aborted provider mirror, original
   external reason identity, exact `TimeoutError`, stable `ABORTED`/`TIMEOUT`
   terminal codes, no retry, and zero remaining caller-signal abort listeners
   through Node's read-only `getEventListeners()` inspection.

### Fix Round 1 author verification

```text
Gateway boundary + core regression: 2 suites, 413 tests passed
Task 10B proportional regression: 19 suites, 793 tests passed
Full backend unit: 95 passed suites, 4 conditional suites skipped;
  1433 passed, 48 conditional tests skipped
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Production dynamic .abort scan: no matches
AbortController.prototype.abort lookup: exactly one module-init capture
Migration diff from 320d5d4: empty
git diff --check: no output
```

The fresh read-only precommit verifier returned **Spec PASS / Quality
APPROVED**, with 0 findings. Its independent evidence included 415/415
Gateway/boundary/provider-abort tests, build, diff checks, and 30 repeated
executions of the timing-sensitive direct/prepared timeout case. It confirmed
the only gateway-owned controller abort paths are the external relay and
timeout helper and that both are intrinsic-bound.

Atomic exact-six MySQL and migration E2E were not rerun because this bounded
round changes no migration, database, workflow, grounding or provider-adapter
production code.

Task 5R fix-round-1 formal controller review: **Spec FAIL / Quality CHANGES
REQUIRED**, with one Important finding. Although abort invocation was captured,
`combineAbortSignals()` still dynamically executed `new AbortController()` and
read `controller.signal`. A post-import replacement of the global constructor
or mutation of the original prototype's signal getter could execute attacker
code and reverse a real cancellation into a successful completion.

## Task 5R Fix Round 2/5 — captured constructor and signal getter

Baseline: `e96704c` (`fix: bind gateway abort controller intrinsic`).
This round changes only the two remaining gateway-owned controller sources and
their adversarial regression coverage.

### RED evidence

```text
Gateway + boundary: 416 total, 413 passed, 3 failed
  direct post-import constructor/getter attack: 1 failed
  prepared prepare-to-execute constructor/getter attack: 1 failed
  pre-import malicious subclass fail-closed boundary: 1 failed
```

The direct and prepared paths each invoked the malicious constructor once.
The isolated pre-import module load accepted the malicious subclass instead of
failing closed.

### Resolution

1. Module initialization captures the trusted `AbortController` constructor,
   its own `signal` getter, and its own `abort` method.
2. `combineAbortSignals()` creates gateway-owned controllers only through the
   captured constructor. It reads the owned signal only by applying the
   captured getter with `Reflect.apply`.
3. Production `model-gateway.ts` contains no `new AbortController()`, no
   `controller.signal`, and no `AbortController.prototype` lookup. The global
   constructor is read exactly once at module initialization.
4. Direct and prepared regressions replace `globalThis.AbortController` after
   module import with a malicious native subclass and simultaneously replace
   the original prototype signal getter. The prepared case mutates strictly
   between prepare and execution.
5. Both paths assert zero attacker calls, a real external cancellation,
   terminal `ABORTED`, exact reason identity, one provider attempt, and zero
   remaining caller abort listeners.
6. An isolated module-load regression documents the trust boundary: an
   already-installed subclass without its own controller signal getter is
   rejected during import before it is instantiated. A completely forged
   JavaScript realm before module execution cannot be authenticated by this
   module and remains an explicit trusted-startup premise.

### Fix Round 2 author verification

```text
Gateway boundary + core regression: 2 suites, 416 tests passed
Task 10B proportional regression: 19 suites, 796 tests passed
Full backend unit: 95 passed suites, 4 conditional suites skipped;
  1436 passed, 48 conditional tests skipped
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Production new AbortController/controller.signal/prototype scan: no matches
Global AbortController value capture: exactly one module-init read
Migration diff from e96704c: empty
git diff --check: no output
```

Atomic exact-six MySQL and migration E2E were not rerun because this bounded
round changes no migration, database, workflow, grounding or provider-adapter
production code.

The fresh read-only precommit verifier returned **Spec PASS / Quality
APPROVED**, with 0 findings. Its independent evidence included 418/418
Gateway/boundary/provider-abort tests, build and diff checks, focused ESLint
with zero findings, source plus compiled-output scans, and 20 repeated
executions of all three new constructor/getter/module-load regressions. It also
confirmed the prepared mutation occurs strictly between prepare and execute.

Task 5R fix-round-2 formal controller review: **Spec FAIL / Quality CHANGES
REQUIRED**, with one Important finding. Although the AbortController
constructor, signal getter and abort method were fixed module-local references,
every invocation still dynamically resolved `Reflect.apply`. Replacing that
method or the global Reflect object after import could therefore execute
attacker code in validation, dispatch, abort relay and timeout paths.

## Task 5R Fix Round 3/5 — captured Reflect intrinsics

Baseline: `506d016` (`fix: capture gateway abort controller sources`).
This round closes the mutable invocation primitive and audits every direct
Reflect use in production ModelGateway.

### RED evidence

```text
Gateway + boundary: 431 total, 416 passed, 15 failed
  direct/prepared × apply-only/global replacement before execution: 4 failed
  direct/prepared × start/provider/finish/retry/timeout windows: 10 failed
  pre-import Reflect.apply replacement fail-closed boundary: 1 failed
```

Every runtime case completed far enough to prove the mutation was executable,
then failed its zero-attacker assertion. The isolated module load accepted the
already-replaced apply method.

### Resolution

1. Trusted module initialization reads the global Reflect object from its own
   data descriptor, then captures own `apply`, `get`, `getPrototypeOf` and
   `ownKeys` methods after checking their canonical native function source.
2. The captured methods are immutable module-local function references. All 13
   previous direct Reflect calls in validation, canonicalization, adapter
   dispatch, signal reads/listeners, abort relay, timeout and hardened provider
   signal behavior now invoke only those references.
3. Production contains no dynamic `Reflect.apply`, `Reflect.get`,
   `Reflect.getPrototypeOf` or `Reflect.ownKeys` property lookup after module
   initialization. Replacing either `Reflect.apply` or all of
   `globalThis.Reflect` after import cannot affect the gateway.
4. Direct validation-time and prepared prepare-to-execute tests exercise both
   an apply-only replacement and a whole-global replacement. A second matrix
   replaces the whole global object during start, provider, finish, retry and
   timeout windows for direct and prepared operations.
5. External cancellation paths assert zero attacker calls, `ABORTED`, exact
   reason identity, one provider attempt and zero source listeners. Timeout
   asserts exact `TimeoutError`/`TIMEOUT`, one attempt and cleanup. The finish
   persistence window preserves its established terminal result while proving
   the already-dispatched mirror receives the exact cancellation reason.
6. An isolated pre-import apply replacement is rejected before dispatch when
   its own method descriptor does not identify the expected intrinsic. As in
   earlier rounds, a completely forged realm before module execution is not
   internally authenticatable and remains the explicit trusted-startup
   premise.

### Fix Round 3 author verification

```text
Gateway boundary + core regression: 2 suites, 431 tests passed
Task 10B proportional regression: 19 suites, 811 tests passed
Full backend unit: 95 passed suites, 4 conditional suites skipped;
  1451 passed, 48 conditional tests skipped
Backend build: exit 0
Lint: exit 0, 0 errors, 31 pre-existing warnings
Dynamic production Reflect method lookup scan: no matches
Migration diff from 506d016: empty
git diff --check: no output
```

Atomic exact-six MySQL and migration E2E were not rerun because this bounded
round changes no migration, database, workflow, grounding or provider-adapter
production code.

The fresh read-only precommit verifier returned **Spec PASS / Quality
APPROVED**, with 0 findings. Its independent evidence included 433/433
Gateway/boundary/provider-abort tests, all 15 Reflect attacks repeated 20
times, build, focused ESLint with zero findings, source plus compiled-output
scans, and clean migration/workflow/retrieval diffs. It confirmed generated
decorator metadata touches Reflect only at module load and never enters the
post-import request path.

Task 5R fix-round-3 formal controller review: **Spec PASS / Quality
APPROVED**, with 0 Critical, 0 Important and 0 Minor findings. The independent
review re-ran 431 Gateway tests, 811 Task 10B tests and the 1451-test backend
suite, verified direct/prepared Reflect replacement attacks, exact abort and
timeout reasons, no retries, listener cleanup, build/lint/scans, and a clean
worktree. Task 5R is complete at `7108a0b`.
