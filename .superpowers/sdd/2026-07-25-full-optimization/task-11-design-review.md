# Task 11 design review record

Specification:
`docs/superpowers/specs/2026-07-27-deterministic-authoring-workflow-design.md`

Scope: deterministic directory, outline and body authoring; persisted
proposal/approval/commit lifecycle; exact evidence and digest contracts;
version/current concurrency; storage and database authority; migration,
compatibility and recovery.

No Task 11 product implementation was started during this design work.

## Review history

The specification was revised through eight independent read-only review
rounds. Reviews deliberately treated any Critical or Important ambiguity as a
design blocker.

- Round 6 snapshot: 1 Critical / 6 Important.
- Round 7 snapshot
  `940cffb48db3be0038092977bee06e50ee19d8be1d76d67356bd94d0098d5d10`:
  0 Critical / 7 Important.
- Round 8 frozen snapshot
  `b01e49ee88df5927ac64ee17a2af57afabd1d874c784a30d343b2e48f8b772ed`:
  4 Critical / 6 Important.

At the user's request, Round 8 was the final independent review. No Round 9
was opened.

## Final Round 8 correction traceability

| Finding | Final correction |
|---|---|
| Missing project/project-state lock counters and increment semantics | Added full-precision `projects.lock_version` and `project_states.lock_version`, exact snapshot mappings, atomic increment rules for project/material/template/directory/outline/body writers, first-head semantics, backfill and schema checks. |
| App DB principal could forge epoch variables and bypass the in-memory capability | Removed connection variables as authority. Protected tables are procedure-only under a locked definer. Split mTLS API, worker and committer roles so no login can seal, approve and commit. Positive SQL is available only through `sp_authoring_commit_v1`; app/worker direct DML is denied. |
| Storage CHECK required impossible cross-table reads | Restricted `chk_storage_operation_intents_shape` to same-row expressions. Cross-table object/authorization/generation checks are exact definer-procedure preconditions under fixed locks. |
| PROMOTE completion could not release parse outbox with declared grants | Added `storage_preparing → storage_pending → pending`, intent binding FK/CHECK/index, precise outbox CAS, column-level definer grants and rollback on zero/multiple release rows. |
| Storage signatures/preimage/full-precision mismatch | Aligned source-file and authorization arguments, defined authorization ID derivation, and represented unsigned BIGINT values as bounded canonical decimal strings. |
| Request/runtime/operation identity incomplete | Added exact runtime-manifest and model-request preimages/tags, role-specific manifest contracts, node ID/version/ordinal/model-call registry and golden rules. |
| Transition identity contained open strings and omitted failure paths | Closed proposal/reason unions; added version-conflict and ambiguous-operation transitions, `workflow.resumed`/`workflow.failed`, and an exhaustive kind/state/subject/event registry. |
| Proposal retention index/insert/state machine inconsistent | Unified the due-time sweep index; added immutable BEFORE INSERT/UPDATE triggers, exact initial shapes, closed forward transitions, terminal immutability and byte/digest revalidation before scrub. |
| Storage claim lock order impossible | Made claim's `SKIP LOCKED` intent selection an explicit short-transaction exception; complete performs a non-locking identity read then re-locks control→project→source→object→intent and revalidates the fence. |
| Existing CASCADE FKs and cross-project revision parent were not reconciled | Named the legacy grounding/domain-commit FKs and their RESTRICT replacements, prohibited leftover CASCADE synonyms, and added the nullable same-project revision-parent composite FK. |

## Bounded closeout evidence

Final reviewed-and-corrected working copy:

- SHA-256:
  `be2db90c30ab1f2bf833332c9f8fb8389c2399a718171c56c88ef3fed1e0b319`
- Lines: 3,791
- Markdown code fences: 48, balanced
- Placeholder scan: no `TBD`, `TODO`, `FIXME` or `placeholder`
- Whitespace validation: `git diff --no-index --check` clean
- Stale-contract scan: no old session-variable authority, old generic
  transition procedure, old scrub index, or unimplemented privacy-purge
  authorization value

The final correction pass was locally checked but was intentionally not sent
into a ninth review cycle. The next gate is the user's review and approval of
the complete written specification. Only after that approval may a detailed
implementation plan be written.
