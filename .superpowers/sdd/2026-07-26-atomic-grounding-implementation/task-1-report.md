# Task 1 Report: Versioned Contracts, Canonical JSON, Quantity Lexer, and Atomic Verifier

## Status

`DONE_WITH_CONCERNS`

Task 1 is implemented on baseline `75af2b3ad79ef460e8fb4632aa54a527c15c0494`.
The implementation remains limited to contracts, schema parsing, canonical JSON,
failure policy, quantity lexing/recomputation, and deterministic atomic
verification. It does not implement the renderer, sealed envelope, runtime
coordinator, migration, persistence, recovery, or Task 11.

## Takeover boundary

This task was taken over from an interrupted implementation agent.

- At takeover, `HEAD` was exactly `75af2b3` and the only working-tree content
  was the untracked `backend/src/citation/atomic-grounding/` directory with the
  12 Task 1 files.
- There was no Task 1 report and no commit.
- The upstream controller reported that the prior agent created schema,
  canonical JSON, failure-policy, and quantity tests before their production
  files, then verifier/attack tests before verifier production. I did not
  personally observe those earlier RED runs and do not claim them as verified
  TDD evidence.
- My first action after reading the brief and approved design was to run the
  complete targeted command against the inherited state. It was already GREEN:
  6 suites and 111 tests passed.
- Every behavior I added or changed after takeover was driven by a newly added
  failing test, with the RED and GREEN results recorded below.

## Authoritative sources used

- Root `AGENTS.md`
- `.superpowers/sdd/2026-07-26-atomic-grounding-implementation/task-1-brief.md`
- `docs/superpowers/specs/2026-07-26-atomic-grounding-design.md`,
  especially sections 4.2 through 4.5, plus the directly referenced schema
  limits in 4.1 and verifier rules in 5.1 through 5.2
- `docs/superpowers/plans/2026-07-26-atomic-grounding-implementation.md`

The approved contracts were treated as authoritative over the inherited
implementation.

## Delivered files

- `backend/src/citation/atomic-grounding/contracts.ts`
- `backend/src/citation/atomic-grounding/grounded-draft.schema.ts`
- `backend/src/citation/atomic-grounding/grounded-draft.schema.spec.ts`
- `backend/src/citation/atomic-grounding/canonical-json.ts`
- `backend/src/citation/atomic-grounding/canonical-json.spec.ts`
- `backend/src/citation/atomic-grounding/quantity-lexer.ts`
- `backend/src/citation/atomic-grounding/quantity-lexer.spec.ts`
- `backend/src/citation/atomic-grounding/atomic-grounding.verifier.ts`
- `backend/src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts`
- `backend/src/citation/atomic-grounding/atomic-grounding.attack.spec.ts`
- `backend/src/citation/atomic-grounding/failure-policy.ts`
- `backend/src/citation/atomic-grounding/failure-policy.spec.ts`

## Contract and architecture results

### Versioned contracts and failure policy

- `contracts.ts` is the authority for the Task 1 version literals:
  `atomic:v1`, `grounded-draft.v1`, `canonical-json.v1`,
  `atomic-canonicalizer.v1`, `quantity-lexer.v1`, `atomic-verifier.v1`,
  `canonical-atomic-claim.v1`, and `candidate-claim-key.v1`.
- The exact proposal, canonical claim base, verifier input/result, verdict,
  method, and evidence-ref types are present.
- The exact 39-member `ATOMIC_GROUNDING_REASON_CODES` tuple is duplicate-free.
- `dispositionForAtomicFailure()` uses an exhaustive switch ending in
  `assertNever(reason)`.
- The only untyped exception conversion is
  `failClosedUnknownAtomicError()`, which returns
  `INTERNAL_FAIL_CLOSED / ATOMIC_GROUNDING_FAILED / FAILED` without copying the
  caught message.

### Closed grounded-draft schema

- Runtime parsing rejects unknown fields and symbol authority fields.
- Provider JSON Schema is recursively closed with
  `additionalProperties:false`.
- Runtime and provider limits now match the approved design:
  500 claims, 2,000 render fragments, 4 MiB proposal JSON, 1,000 raw UTF-8
  bytes per claim, and 1 to 3 unique evidence IDs per claim.
- IDs use a bounded ASCII safe-character grammar.
- Claim text rejects CR/LF/control bytes and Markdown fences while leaving
  Markdown/HTML-like ordinary data to the future renderer.
- Draft/material-gap discriminants, fixed decimal grammar, range ends, local
  spans, exact anchors, unique quantity IDs, unique evidence IDs, unique claim
  and fragment IDs, one-to-one claim refs, and complete ordering are enforced.
- Canonical proposal order follows the design: ordering is preserved,
  render fragments are sorted by ordering ordinal, claims by their claim
  fragment ordinal, quantities by UTF-16 start, and evidence IDs by direct
  UTF-16 order.

### Canonical JSON

- Strings and keys are NFC-normalized; NFKC is not used.
- Object keys are emitted by direct UTF-16 comparison, including integer-like
  keys such as `"10"` and `"2"` that normal `JSON.stringify(object)` would
  reorder.
- Arrays preserve order; sparse arrays and array `undefined` are rejected.
- Object-valued `undefined` is omitted.
- Non-finite and non-safe-integer numbers, non-ordinary prototypes, accessors,
  symbol keys, cycles, and root `undefined` are rejected.
- `-0` serializes as `0`.
- Digests use
  `sha256(NFC(version_tag) + "\0" + canonical_utf8)` and pass fixed golden
  vectors.

### Quantity lexer and atom recomputation

- The scanner advances left-to-right by UTF-16 index and returns all
  non-overlapping occurrences.
- Covered families include Arabic and Chinese numbers, nested `万/亿`,
  percentages, power, energy, duration, currency, count, length, mass, and
  temperature units.
- Fixed decimal and base-unit conversion use `bigint`, not floating-point
  arithmetic.
- Unicode minus `−`, Chinese negative numbers, astral-character offsets,
  comparators, ranges, and range endpoints are covered.
- Exponent form, malformed repeated decimal points, mixed comparators,
  overlapping proposal spans, and out-of-range proposal offsets fail closed.
- Subject and predicate anchors are exact, non-empty, in range, and
  non-overlapping.
- Polarity and quantifier are recomputed from a closed whole-atom lexer.
  `some`, `other`, and conflicting polarity occurrences are exact-only.
- Every proposed quantity must match recomputed cardinality, order, offsets,
  surface, dimension, value, unit, comparator, and range end.
- Coordinator characters such as `和/与/及/并/但/而/、` are never deleted or
  treated as split authority.

### Atomic verifier and authority boundary

- Candidate keys use the specified versioned SHA-256 formula.
- Exact comparison runs first; typed comparison requires equal quantity count
  and order, closed polarity/quantifier equality, identical non-quantity
  skeleton, and identical canonical quantity tuples.
- `some`, `other`, `approx`, `range`, dimension `other`, and conflicting
  polarity do not enter typed equivalence.
- Every referenced evidence record independently supports the whole atom.
  No averaging, partial verdict, cross-evidence mosaic authorization, semantic
  similarity, or LLM review exists.
- Unknown evidence, duplicate assigned evidence IDs, missing snapshot digest,
  missing exact span text, project mismatch, and invalid assignment digest
  return stable fail-closed outcomes.
- The support comparison function is not constructor-injectable. A caller
  cannot replace the deterministic authorization function.
- Initial attempts reject non-null revision candidate metadata. Deeper targeted
  revision allowlist and one-to-one invariants remain Task 2.
- Schema-proposed support status, score, output offsets, and retrieval metadata
  are rejected before support evaluation.
- The architecture test imports the atomic graph with a mocked legacy module
  and proves no runtime module load or call reaches `parseVisibleOutput`,
  `extractVisibleStatements`, `splitCoordinatedPropositions`,
  `GroundingVerifier.verify`, or `SemanticGroundingReviewer.review`.
- Production imports `AssignedEvidenceSnapshot` only as a TypeScript type.

## TDD evidence observed during takeover

### Inherited-state audit

Command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 6 passed, 6 total
Tests:       111 passed, 111 total
Snapshots:   0 total
```

This proves only that the inherited state was GREEN at takeover. It does not
prove the prior agent's RED phase.

### Takeover cycle 1: schema limits/order and canonical integer-like keys

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 2 failed, 2 total
Tests:       10 failed, 29 passed, 39 total
```

The failures were the intended missing 500/2,000/1–3/1,000-byte/ID/control
limits, proposal ordering, and integer-like UTF-16 key ordering.

Actual GREEN after the minimal implementation:

```text
Test Suites: 2 passed, 2 total
Tests:       39 passed, 39 total
```

### Takeover cycle 2: authorization boundary

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 2 failed, 2 total
Tests:       5 failed, 67 passed, 72 total
```

The intended failures covered conflicting polarity still being typed-eligible,
missing exact span text escaping as an unknown internal failure, replaceable
constructor support authority, and revision metadata boundaries.

The first GREEN attempt exposed that my new revision test over-constrained
attempt 1 by requiring every claim to carry a target key. That contradicted the
approved rule that non-target claims remain null. I corrected the test and
implementation to reject non-null revision metadata only on attempt 0; Task 2
retains target allowlist authority.

Actual final GREEN:

```text
Test Suites: 2 passed, 2 total
Tests:       71 passed, 71 total
```

### Takeover cycle 3: closed numeric vocabulary and raw-byte limit

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 2 failed, 2 total
Tests:       4 failed, 71 passed, 75 total
```

The intended failures covered a raw decomposed claim over 1,000 UTF-8 bytes
that became shorter after NFC, Unicode minus, nested `一万亿`, and
`1.2.3MW`.

Actual GREEN:

```text
Test Suites: 2 passed, 2 total
Tests:       75 passed, 75 total
```

## Verification evidence

### Final Task 1 targeted suites

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual output before final report verification:

```text
Test Suites: 6 passed, 6 total
Tests:       128 passed, 128 total
Snapshots:   0 total
```

### Related legacy grounding regression

```bash
(cd backend && npx jest \
  src/citation/grounding-verifier.spec.ts \
  src/citation/semantic-grounding-review.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 3 passed, 3 total
Tests:       104 passed, 104 total
Snapshots:   0 total
```

### Backend full Jest

```bash
(cd backend && npm test -- --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 4 skipped, 81 passed, 81 of 85 total
Tests:       48 skipped, 751 passed, 799 total
Snapshots:   0 total
```

The ERROR/WARN log lines in this run came from existing failure-path fixtures;
the process exited 0.

### Build

```bash
(cd backend && npm run build)
```

Actual output:

```text
> backend@0.0.1 build
> nest build
```

Exit code: 0.

### Lint

```bash
(cd backend && npm run lint:check)
```

First run: exit 1 with 9 Task 1 errors (8 Prettier formatting errors and one
`no-control-regex`) plus 31 pre-existing warnings. After formatting the Task 1
files and replacing the control regex with explicit character-code scanning:

```text
✖ 31 problems (0 errors, 31 warnings)
```

Final lint exit code: 0. All 31 warnings are in pre-existing files outside
`atomic-grounding`.

### Diff check

```bash
git diff --check
```

Actual output: empty. Exit code: 0.

## Self-review

- Reviewed all 12 Task 1 files against the approved field shapes and reason
  mapping.
- Confirmed the production atomic directory contains no runtime import of the
  legacy grounding verifier or semantic reviewer.
- Confirmed the only legacy reference in production is an erased
  `import type` for `AssignedEvidenceSnapshot`.
- Confirmed no renderer, envelope, runtime mode, coordinator, migration,
  persistence, or Task 11 implementation was introduced.
- Confirmed no `PARTIAL` verdict and no legacy fallback exists in the atomic
  verifier.
- Confirmed deterministic tests use real schema, lexer, canonicalizer, failure
  policy, and verifier behavior; the legacy module is mocked only by the
  architecture isolation test to detect forbidden runtime loads.

## Concerns and explicit limitations

1. The prior agent's RED outputs are unavailable. The inherited test-first file
   creation sequence is controller-reported, not personally verified. This
   report claims TDD evidence only for the takeover cycles above.
2. The approved design requires a safe ID regex but does not give its exact
   character class. This implementation chooses the conservative ASCII grammar
   `[A-Za-z0-9][A-Za-z0-9._:-]{0,511}`. If a later approved render-context ID
   vocabulary requires another character, the contract must be deliberately
   versioned or amended rather than silently widened.
3. The initial inherited internal-space deletion concern was resolved in
   independent review fix round 1/5 below: full-width spaces map one-for-one to
   ASCII, only boundaries are trimmed, and internal spaces remain
   byte-significant.
4. Full Jest has 4 skipped suites / 48 skipped tests under the current local
   test configuration. All executed suites pass, but skipped integration
   coverage is not claimed as executed.
5. Jest consistently prints the environment warning
   ``--localstorage-file` was provided without a valid path`. It is unrelated
   to Task 1 and does not fail tests.
6. `lint:check` exits 0 with 31 pre-existing warnings outside Task 1.

## Independent review fix round 1/5

Review source:

```text
.superpowers/sdd/2026-07-26-atomic-grounding-implementation/task-1-review.md
```

The independent review found two Critical fail-open paths and one Minor reason
classification issue. This round fixes only the two Critical findings as
directed. The Minor `ATOM_EVIDENCE_MOSAIC_UNSUPPORTED` classification is
explicitly deferred and was not changed.

### C1 RED: internal spaces were deleted before exact and typed comparison

Added real-verifier coverage for:

- claim `容量为发电量。` versus evidence `容量为发 电量`;
- claim `容量为发电量。` versus evidence `容量为发　电量`;
- typed claim `容量为0.3GW。` versus evidence `容量 为300MW`;
- a positive representation check proving an internal ASCII space and
  full-width space at the same location remain equivalent after mapping.

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 1 failed, 1 total
Tests:       3 failed, 28 passed, 31 total
```

The three failures returned the unsafe results named by the reviewer:
`atomic_extract_exact / SUPPORTED` for both exact-space cases and
`atomic_typed_equivalent / SUPPORTED` for the typed skeleton case.

Minimal fix:

1. NFC-normalize.
2. Map each full-width space to one ASCII space.
3. Trim only leading/trailing ASCII spaces.
4. Remove at most one terminal sentence punctuation token.
5. Preserve every internal space and every other skeleton byte.

GREEN command: identical to the RED command.

Actual GREEN:

```text
Test Suites: 1 passed, 1 total
Tests:       31 passed, 31 total
```

### C2 RED: malformed repeated Chinese multipliers were canonicalized

Added lexer rejection coverage for:

- `一亿亿瓦`;
- `一万万瓦`;
- repeated small unit `一百百瓦`;
- out-of-order small units `一十百瓦`;
- repeated implicit small unit `十十瓦`.

Also added the reviewer's end-to-end verifier attack pair:

```text
claim:    容量为一亿亿瓦。
evidence: 容量为200兆瓦
```

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 2 failed, 2 total
Tests:       6 failed, 57 passed, 63 total
```

All five malformed lexer inputs failed to throw, and the verifier attack
incorrectly returned a `SUPPORTED` claim.

Minimal fix:

- `万亿` is the only allowed compound large-unit token and remains covered by
  the existing valid `一万亿瓦 = 1000000000000 W` fixture.
- Outside that compound, `亿` and `万` may each occur at most once and only in
  descending order (`亿` before `万`).
- Each large-unit section must be a closed value from 0 through 9,999; a
  multiplier coefficient must be non-zero.
- Small units must descend strictly through `千 > 百 > 十`; repetition,
  reversal, invalid zero coefficients, and repeated implicit units are
  rejected.
- Malformed numeric surfaces therefore fail during lexical recomputation
  before typed comparison can run.

GREEN command: identical to the RED command.

Actual GREEN:

```text
Test Suites: 2 passed, 2 total
Tests:       63 passed, 63 total
```

### Round 1 regression and verification

Task 1 targeted command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 6 passed, 6 total
Tests:       138 passed, 138 total
Snapshots:   0 total
```

Affected legacy grounding regression:

```bash
(cd backend && npx jest \
  src/citation/grounding-verifier.spec.ts \
  src/citation/semantic-grounding-review.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 3 passed, 3 total
Tests:       104 passed, 104 total
Snapshots:   0 total
```

Build:

```bash
(cd backend && npm run build)
```

Actual output:

```text
> backend@0.0.1 build
> nest build
```

Exit code: 0.

Lint:

```bash
(cd backend && npm run lint:check)
```

Actual output:

```text
✖ 31 problems (0 errors, 31 warnings)
```

Exit code: 0. The warnings remain the pre-existing warnings outside
`atomic-grounding`.

Diff check:

```bash
git diff --check
```

Actual output: empty. Exit code: 0.

### Round 1 self-review

- Both exact and typed comparison still share one normalization function, so
  the internal-space preservation rule cannot drift between methods.
- Full-width spaces are mapped one-for-one, never deleted.
- Only boundary ASCII spaces are trimmed after mapping; internal skeleton
  spaces remain byte-significant.
- Only one terminal punctuation code point can be removed.
- The Chinese parser validates the complete matched numeric surface before
  returning a canonical value; it cannot fall back to a partial prefix.
- Existing valid fixtures for Chinese digits, small units, `万/亿`, nested
  `一万亿`, negative values, and decimal fractions pass unchanged.
- The verifier attack corpus now proves malformed repeated multipliers cannot
  become `SUPPORTED`.
- No legacy parser, splitter, similarity, or semantic reviewer was introduced.
- The deferred Minor mosaic reason branch is byte-for-byte unchanged in this
  review round.

## Independent review fix round 2/5

Review source:

```text
.superpowers/sdd/2026-07-26-atomic-grounding-implementation/task-1-rereview.md
```

Round 1 closed the malformed multiplier fail-open, but its initial `万亿`
branch rejected every additional lower-order `亿/万` token. Round 2 fixes only
that scoped Important false-negative regression. The closed C1 normalization
and deferred mosaic Minor were not changed.

### RED: valid descending lower-order tail after `万亿`

Added the legal positive vector:

```text
一万亿三千万瓦 = 1000030000000 W
```

Added adjacent guards that must remain invalid:

```text
一万亿三亿二亿瓦
一万亿三万二万瓦
一万亿三万二亿瓦
```

RED command:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  --runInBand --no-coverage)
```

Actual RED:

```text
Test Suites: 1 failed, 1 total
Tests:       1 failed, 55 passed, 56 total
```

The only failure was the intended valid positive vector, which threw
`TypeError: malformed quantity number`. All new repeated/reversed-unit guards
already failed closed.

### Minimal correction and GREEN

The `万亿` branch still requires:

- exactly one `万亿` compound token;
- a non-zero closed high-order coefficient from 1 through 9,999;
- no `亿/万` token before that compound;
- a lower-order value strictly below `万亿`.

The lower-order tail now reuses the already closed ordinary Chinese-integer
parser. It therefore accepts descending non-repeated `亿` then `万` tails, but
continues to reject repetition, reversal, malformed small units, and another
`万亿`.

GREEN command: identical to the RED command.

Actual GREEN:

```text
Test Suites: 1 passed, 1 total
Tests:       56 passed, 56 total
```

### Round 2 regression and verification

Quantity plus verifier attack corpus:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 2 passed, 2 total
Tests:       67 passed, 67 total
Snapshots:   0 total
```

Task 1 targeted:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Actual output:

```text
Test Suites: 6 passed, 6 total
Tests:       142 passed, 142 total
Snapshots:   0 total
```

Build:

```bash
(cd backend && npm run build)
```

Actual output:

```text
> backend@0.0.1 build
> nest build
```

Exit code: 0.

Lint:

```bash
(cd backend && npm run lint:check)
```

Actual output:

```text
✖ 31 problems (0 errors, 31 warnings)
```

Exit code: 0. The warnings remain pre-existing and outside
`atomic-grounding`.

Diff check:

```bash
git diff --check
```

Actual output: empty. Exit code: 0.

### Round 2 self-review

- The production change is confined to the existing `万亿` branch.
- A legal tail is parsed as a complete lower-order number and must remain below
  the high-order `万亿` place.
- Tail repetition and reversal use the same closed ordinary large-unit checks
  introduced in Round 1; no permissive alternate parser was added.
- Existing `一万亿瓦`, malformed `一亿亿/一万万`, small-unit guards, and the
  verifier attack corpus remain GREEN.
- No exact/typed text normalization code changed, so closed C1 remains
  untouched.
- The deferred mosaic reason branch is unchanged.
