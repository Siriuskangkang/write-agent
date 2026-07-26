# Task 4 Report — Structured Gateway and Atomic Grounding Coordinator

## Status

Implemented Task10B-4 on baseline `29a9304`.

Scope delivered:

- `ModelGateway` owns a non-optional completion audit, overwrites forged
  provider audit fields, hides structured JSON deltas, and preserves final
  repair/run/UTF-8 byte facts.
- `groundedDraftChain` uses only `response_mode: structured` with
  `GROUNDED_DRAFT_SCHEMA`, one structured repair, bounded output, timeout,
  cancellation and workflow trace.
- `AgentService.generateGroundedDraft()` returns the complete
  `GroundedDraftGenerationResult`, including the real gateway audit.
- `ApprovedRenderContextService` performs project-scoped reads of workflow
  input, current directory/outline and active style template, normalizes and
  validates the closed context, and sorts by `structure_id`.
- `AtomicGroundingCoordinator` performs assignment/context validation,
  schema parse, deterministic verification, server rendering and sealing in
  order. It supports one targeted revision and checkpoint recovery without a
  model call.
- Closed low-cardinality metrics own all label construction. No prompt,
  claim/evidence text, workflow/project/claim/evidence ID, or model run ID is
  admitted into labels.
- `ContentGenerationService` shares ownership/project/original/outline/style/
  retrieval preparation between legacy text generation and the atomic path.
  `ContentService.generateAtomicGroundingCandidate()` returns one buffered
  outcome.

Explicitly out of scope and unchanged: workflow executor integration,
runtime mode parsing, database/domain commit, approval capability and Task 11
enforcement.

## TDD Evidence

### RED

1. Structured gateway/chain RED:
   - command: targeted chain, AgentService and ModelGateway Jest suites
   - result: `3` failed suites; `3` failed / `39` passed tests
   - expected failures: missing chain and AgentService method, structured
     `text_delta` exposure, absent completion audit.
2. Context/coordinator/metrics/façade RED:
   - command: targeted context, coordinator, metrics and ContentService suites
   - result: `4` failed suites before test execution
   - expected failures: all three new modules and façade were absent.
3. Review-discovered RED cases:
   - outline query not scoped by workflow chapter/section:
     `1` failed / `6` passed.
   - persisted directory `content` node-array shape rejected:
     `1` failed / `6` passed.
   - workflow ID and unknown revision/provider fields leaked into the prompt:
     `2` failed / `2` passed.

### GREEN

- structured chain + AgentService + ModelGateway: `3` suites,
  `58/58` tests passed.
- context + coordinator + metrics + ContentService: `4` suites,
  `65/65` tests passed before the final directory-shape regression was split
  into its own case.
- coordinator targeted revision/recovery suite: `10/10` tests passed.

## Final Verification

### Targeted and regression tests

```text
npx jest \
  src/agent/chains/grounded-draft.chain.spec.ts \
  src/agent/agent.service.spec.ts \
  src/citation/atomic-grounding \
  src/llm/model-gateway.spec.ts \
  src/content/content.service.spec.ts \
  --runInBand --no-coverage

Test Suites: 16 passed, 16 total
Tests:       343 passed, 343 total
```

The expected existing `OutlineService` invalid-JSON test log and Node
`--localstorage-file` warning appeared; neither is a test failure.

### Build

```text
npm run build
> nest build
exit 0
```

### Lint

```text
npm run lint
exit 0
31 warnings, 0 errors
```

The warnings are existing unsafe-`any`/floating-promise warnings in legacy
tests and unrelated source files; Task 4 introduces no lint errors.

### Diff

```text
git diff --check
exit 0
```

## Independent Re-review Fix Round 3

The remaining precedence issue in `task-4-rereview2.md` was fixed without
changing current-dependency classification, previously closed findings, or
Task 5 behavior.

### Round 3 RED

A valid sealed candidate was copied and only its digested
`workflow.revision_attempt` was changed from `0` to `1`, leaving the stored
envelope digest and current assignment/context unchanged. Recovery returned:

```text
RECOVERY_ASSIGNMENT_DRIFT
```

The test also demonstrated that assignment loading occurred before the stored
envelope integrity failure was detected.

### Round 3 GREEN

`parseSealedGroundedCandidateWorkflowV1()` now closed-parses the checkpoint
and verifies its stored envelope digest before returning any workflow field to
the coordinator. A mismatch produces `ENVELOPE_DIGEST_MISMATCH`; assignment
and render-context dependencies are not called.

The integrity-passing controls still map real current SQL assignment drift to
`RECOVERY_ASSIGNMENT_DRIFT` and real missing/stale approved render context to
`RECOVERY_RENDER_CONTEXT_DRIFT`.

### Round 3 verification

```text
Coordinator + sealed candidate:
Test Suites: 3 passed, 3 total
Tests:       113 passed, 113 total

Task 4 regression plus real SQL assignment loader:
Test Suites: 17 passed, 17 total
Tests:       447 passed, 447 total

npm run build
exit 0

npm run lint
exit 0, 0 errors, 31 existing warnings

git diff --check
exit 0
```

## Audit and Safety Notes

- Structured responses never fall back to text mode.
- Structured provider deltas are buffered and never exposed as visible model
  tokens.
- `repair_attempts`, proposal UTF-8 bytes and final model run ID come only
  from the successful gateway attempt; provider-supplied audit is overwritten.
- Coordinator metrics consume the exact generation audit and never
  reserialize the proposal to derive proposal bytes.
- Assignment is loaded once per generate/recover operation and must be
  `atomic:v1`, strict, project/job matched, terminal, sealed and backed by
  active snapshot-shaped evidence.
- All known failures use the existing 39-reason closed policy. Unknown thrown
  values become only `INTERNAL_FAIL_CLOSED` / `ATOMIC_GROUNDING_FAILED`;
  thrown text is not logged or returned.
- Recovery rebuilds the current approved render context and assignment and
  makes zero model calls.

## Concerns / Follow-up Boundary

- The repository lint baseline still reports 31 warnings; they are outside
  this task's behavior and do not block lint exit status.
- Executor checkpoint/event integration and any persistence gate must be
  implemented and verified by Task 5. Exact-byte commit and authorization
  remain Task 11 only.

## Independent Review Fix Round 1

All five findings in `task-4-review.md` were reproduced with failing tests
before production changes and fixed without adding Task 5 executor/checkpoint
emission or Task 11 commit behavior.

### Review RED evidence

1. Revision-1 recovery returned `ASSIGNMENT_SNAPSHOT_DRIFT`; the coordinator
   fabricated generation/revision attempt zero instead of parsing the sealed
   workflow envelope.
2. Approved render context had `6` intended failures: unrelated
   chapter/section entries were admitted, absent/mis-parented target sections
   were accepted, and missing pinned directory/outline/style rows were
   silently omitted.
3. Metrics/coordinator had `6` intended failures: fractional/unsafe byte and
   count values, repair values outside `0|1`, and a first-rendered-token point
   emitted before any executor token boundary.
4. Typed reason/recovery boundary RED had `49` intended failures: the closed
   failure object did not exist and envelope/assignment/context recovery
   failures all collapsed to `ENVELOPE_INVALID`.
5. The real SQL assignment loader had `4` intended failures: unselected,
   inactive-ingestion and run drift were untyped, while exact-span offset
   drift was accepted.
6. A final mutation test showed a forged reason outside the 39-member tuple
   could construct a closed failure object.

### Review fixes

- Recovery closed-parses the checkpoint workflow first, carries its exact
  generation and revision attempts into assignment loading, and recovers a
  revision-1 candidate with zero model calls.
- Directory entries are restricted to the target node and its validated
  ancestor chain. Missing targets, duplicate/cyclic/missing-parent structure,
  and target/chapter inconsistencies fail closed.
- A workflow-pinned directory, outline or style source must still have one
  matching current row. Returned entries retain the exact source ID/version
  used for the authoring snapshot.
- `AtomicGroundingClosedFailure` carries only a runtime-validated member of
  the 39-reason tuple. The coordinator preserves it at dependency boundaries;
  SQL assignment validation now types unselected, ownership, ingestion,
  run, offset, legacy ambiguity and snapshot drift.
- Recovery distinguishes stored envelope digest mismatch, current assignment
  drift and current render-context drift while preserving the legacy direct
  recovery exception message.
- Proposal bytes and claim counts require safe non-negative integers;
  structured repair attempts require exactly `0|1`. Task 4 records render
  latency only; first-rendered-token remains available for the later Task 5
  token-emission boundary.

### Review verification

```text
5 focused suites:
Test Suites: 5 passed, 5 total
Tests:       169 passed, 169 total

Task 4 regression plus real SQL assignment loader:
Test Suites: 17 passed, 17 total
Tests:       432 passed, 432 total

npm run build
exit 0

npm run lint
exit 0, 0 errors, 31 existing warnings

git diff --check
exit 0
```

The existing `OutlineService` invalid-JSON fixture log and Node
`--localstorage-file` warning remained expected and non-failing.

## Independent Re-review Fix Round 2

The remaining P1 in `task-4-rereview.md` was fixed at the real producing
boundaries only. The four already closed findings and Task 5 behavior were
left unchanged.

### Round 2 RED evidence

- Eight real `SqlGroundingEvidenceStore` cases failed because assignment
  project/contract drift, primary retrieval state drift, omitted/malformed/
  disappeared run references, malformed assigned evidence IDs and duplicate
  assignment metadata still threw plain `BadRequestException`.
- A mutation run through the real SQL store and coordinator reproduced the
  reviewed terminal outcome: primary run state drift rejected with
  `ATOMIC_GROUNDING_FAILED` instead of returning
  `RETRIEVAL_STATE_INVALID`.
- Three real recovery dependency cases failed with the wrong reasons:
  current SQL run-state drift returned `RETRIEVAL_STATE_INVALID`, while
  `ApprovedRenderContextService.build()` with a missing or stale pinned
  directory returned `RENDER_CONTEXT_INVALID`.

### Round 2 GREEN

- Remaining metadata/run-reference/run-state branches now raise
  `AtomicGroundingClosedFailure` with exact closed reasons while preserving
  existing legacy exception messages:
  `ASSIGNMENT_PROJECT_MISMATCH`, `ASSIGNMENT_CONTRACT_MISMATCH`,
  `ASSIGNMENT_SNAPSHOT_DRIFT`, `EVIDENCE_RUN_DRIFT`, and
  `RETRIEVAL_STATE_INVALID`.
- Tests instantiate the real `SqlGroundingEvidenceStore` and pass its failures
  through `AtomicGroundingCoordinator.generate()`; they no longer rely on an
  AgentService-thrown reason as end-to-end evidence.
- Recovery converts current assignment dependency absence/validation/errors
  to `RECOVERY_ASSIGNMENT_DRIFT` and real approved-render-context build
  failures to `RECOVERY_RENDER_CONTEXT_DRIFT`.
- Stored checkpoint parsing and `recoverSealedGroundedCandidateV1()` remain
  outside those dependency catch boundaries, so stored envelope corruption
  still produces `ENVELOPE_DIGEST_MISMATCH`.

### Round 2 verification

```text
Store + coordinator focused:
Test Suites: 2 passed, 2 total
Tests:       101 passed, 101 total

Task 4 regression plus real SQL assignment loader:
Test Suites: 17 passed, 17 total
Tests:       446 passed, 446 total

npm run build
exit 0

npm run lint
exit 0, 0 errors, 31 existing warnings

git diff --check
exit 0
```
