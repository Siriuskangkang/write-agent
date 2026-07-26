# Task 10B-3 Implementation Report

## Outcome

Implemented the additive atomic-grounding schema contract, fail-closed legacy
authorization/read behavior, assignment contract binding, and atomic-only
compress inheritance gate.

Baseline: `cd5e103`

Implementation commit: recorded in the final handoff

## Schema and Rollback Contract

- Added migration `1713330000000-AddAtomicGroundingContracts`.
- Added
  `grounding_assignments.contract_version VARCHAR(32) NOT NULL DEFAULT
  'legacy:v0'`.
- Added nullable `grounding_claims.atomic_claim JSON`.
- Existing/null assignments are backfilled to `legacy:v0`; unknown contract
  values abort with `ATOMIC_GROUNDING_UNKNOWN_CONTRACT_VERSION`.
- The migration is resumable after the first ALTER, idempotent on old rows,
  and does not manufacture historical atomic claims.
- `down()` performs no DDL/DML and rejects with
  `ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN`.
- The rollback runbook pins the minimum safe binary capability to
  `legacy-grounding-fail-closed.v1`, requires leaving the migration applied,
  and forbids dropping or rewriting either new column.

## Authorization and Read Behavior

- Legacy verification retains marker parsing only for diagnostics, caps every
  claim to `UNVERIFIABLE/0/legacy_unverifiable`, never invokes semantic review
  as an upgrade path, and never returns `ALLOW` in strict mode.
- Public citation reads preserve `SUPPORTED/1` only for an `atomic:v1`
  assignment joined through workflow/project ownership, an exact closed
  `PersistedAtomicClaimV1`, exact allowlisted versions, and exact allowlisted
  verification methods. Missing, legacy, malformed, open, unknown-version,
  unknown-method, and non-unit-score rows are capped.
- Assignment snapshot digests now bind `contract_version`, so changing only
  `legacy:v0`/`atomic:v1` invalidates a persisted snapshot.
- Assignment insert, targeted replacement, and inheritance writes carry an
  explicit contract version.
- Compress inheritance accepts only `atomic:v1` parents whose persisted claims
  and citation maps pass the negative SQL gate: closed atomic version fields,
  `SUPPORTED`, allowlisted atomic method, evidence IDs, and snapshot digests.
  Legacy or incomplete parents fail closed; Task 11 atomic persistence was not
  added.

## TDD Evidence

### Migration RED

Initial real-MySQL migration execution failed before implementation because
`1713330000000-AddAtomicGroundingContracts` did not exist:

```text
FAIL test/migrations.e2e-spec.ts
Cannot find module ../migrations/1713330000000-AddAtomicGroundingContracts.js
Test Suites: 1 failed, 1 total
EXIT_CODE=1
```

During integration, two additional RED results identified test-fixture
compatibility gaps:

```text
Tests: 1 failed, 44 passed, 45 total
```

The first used a predecessor schema without grounding tables; the second still
expected three upgrade migrations after the new fourth migration was added.
Both fixtures were corrected without weakening production checks.

### Legacy/Read/Inheritance RED

The new policy/version suites initially failed because the modules did not
exist. Updating the existing verifier to the new contract then produced the
expected legacy-authorization failures:

```text
Test Suites: 3 failed
Tests: 76 failed, 6 passed, 82 total
```

The combined store/read/inheritance run then exposed twelve expected failures
from absent assignment contract writes, absent read caps, and absent
atomic-only inheritance gates:

```text
Test Suites: 2 failed, 4 passed, 6 total
Tests: 12 failed, 120 passed, 132 total
```

### GREEN

Final focused unit command:

```bash
cd backend
npx jest \
  src/citation/grounding-read-policy.spec.ts \
  src/citation/grounding-safety-version.spec.ts \
  src/citation/grounding-verifier.spec.ts \
  src/citation/citation-ledger.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  src/citation/citation.service.spec.ts \
  --runInBand --no-coverage
```

```text
Test Suites: 6 passed, 6 total
Tests: 133 passed, 133 total
EXIT_CODE=0
```

Final real MySQL 8.4 migration command:

```bash
cd backend
npm run test:e2e -- migrations.e2e-spec.ts --runInBand
```

```text
Test Suites: 1 passed, 1 total
Tests: 45 passed, 45 total
Time: 125.878 s
EXIT_CODE=0
```

This covers fresh/current/partial/old-binary paths, exact schema signatures,
row-count preservation/backfill, unknown-version rejection, rerun stability,
destructive rollback rejection with byte-preservation, snapshot contract
drift, strict rollback on failed generation, legacy evidence ambiguity, and
atomic-only inheritance.

## Static Verification and Cleanup

Build:

```text
> backend@0.0.1 build
> nest build
EXIT_CODE=0
```

Full backend lint:

```text
31 problems (0 errors, 31 warnings)
EXIT_CODE=0
```

The warnings are pre-existing and outside the Task 3 files.

Whitespace:

```text
git diff --check
EXIT_CODE=0
```

Docker cleanup:

```text
docker ps --format '{{.Names}}' | rg '^write-agent-migration-e2e-'
<no output>
```

The E2E harness removed its MySQL container and temporary schemas.

## Self-Review

- The migration follows the specified five-step additive order.
- No historical claim row is rewritten into atomic authority.
- Read authorization uses exact contract/version/method/shape checks and
  returns a fresh capped verdict on every failure path.
- Legacy semantic review cannot upgrade a claim.
- Strict legacy generation cannot authorize content.
- Contract version participates in assignment digest generation and
  validation.
- Inheritance is a negative-only gate and does not implement Task 11
  persistence.
- Public citation fields and GB/T grouping remain covered by regression tests.
- The only remaining lint output is the repository's known warning baseline.

## Fix Round 1/5

Independent review found two fail-open boundaries:

1. Compress inheritance filtered invalid parent claims/references out of the
   result set and could inherit the remaining valid subset.
2. Targeted replacement accepted a matching `legacy:v0`/non-strict input and
   entered its transaction.

### Round 1 RED

Focused store command:

```bash
cd backend
npx jest src/citation/sql-grounding-evidence.store.spec.ts \
  --runInBand --no-coverage
```

Observed before the fix:

```text
Test Suites: 1 failed, 1 total
Tests:       4 failed, 19 passed, 23 total
```

The inheritance query lacked a universal anti-join, and all three rejected API
shapes (`legacy:v0` strict, `legacy:v0` non-strict, and `atomic:v1`
non-strict) entered the transaction instead of throwing `MaterialGapError`.

Focused real-MySQL command:

```bash
cd backend
npm run test:e2e -- migrations.e2e-spec.ts --runInBand \
  -t "caps legacy reverify and inherits only a closed atomic claim ledger"
```

Observed before the fix:

```text
Test Suites: 1 failed, 1 total
Tests:       1 failed, 44 skipped, 45 total

mixedLegacyOutcome: "resolved"
nullRefOutcome: "resolved"
zeroCitationOutcome: "resolved"
```

This proved the real SQL inherited a valid subset from a result containing an
atomic claim plus a `legacy:v0`-assignment claim, a complete citation plus a
null-snapshot citation, or an otherwise valid claim with no citation map.

### Round 1 Fix

- Added a correlated `NOT EXISTS` anti-join across every claim in the parent
  result. A parent is rejected when any claim lacks an `atomic:v1`
  assignment, has a null/non-object/wrong-version atomic envelope, is not
  `SUPPORTED` with an allowlisted method, has no citation map, or has any
  citation with a null evidence ID/snapshot digest.
- Kept the existing per-row positive filters and evidence/run consistency
  checks after the universal gate.
- Added a pre-transaction targeted-replacement guard requiring both
  `contract_version === 'atomic:v1'` and `strict_mode === true`.
- Preserved the locked-row contract equality check as the TOCTOU guard.

### Round 1 GREEN

Focused store:

```text
Test Suites: 1 passed, 1 total
Tests:       23 passed, 23 total
EXIT_CODE=0
```

Focused real MySQL with the exact mixed/incomplete fixtures:

```text
Test Suites: 1 passed, 1 total
Tests:       1 passed, 44 skipped, 45 total
Time:        9.822 s
EXIT_CODE=0
```

All three invalid workflow IDs were also queried after rejection and had zero
`grounding_assignments` rows, proving no inheritance insert occurred.

Full Task 3 unit regression:

```text
Test Suites: 6 passed, 6 total
Tests:       136 passed, 136 total
EXIT_CODE=0
```

Build, lint, whitespace, and cleanup:

```text
npm run build: EXIT_CODE=0
npm run lint: 0 errors, 31 pre-existing warnings, EXIT_CODE=0
git diff --check: EXIT_CODE=0
write-agent-migration-e2e-* containers: none
```
