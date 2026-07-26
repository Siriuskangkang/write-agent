# Task 7 Implementation Report

## Outcome

Task 7 now exposes a provider-neutral terminal contract, rejects incomplete or
filtered generations before domain persistence, records durable and
concurrency-safe model attempts, and reconciles the model-run schema without
partial DDL.

## RED evidence

- `npm test -- --runInBand src/llm/model-gateway.spec.ts src/llm/providers/provider-contract.spec.ts src/workflow/workflow-generation.executor.spec.ts`
  - 22 new assertions failed against `c4b0905`.
  - Failures demonstrated that `length`, `max_tokens`, `content_filter`,
    unknown and missing stop reasons were accepted as successful completions.
  - The installed OpenAI SDK `Headers` and nested `APIConnectionError.cause`
    shapes were not handled.
- `npm test -- --runInBand src/workflow/model-run.service.spec.ts`
  - 5 new assertions failed.
  - A terminal row could be overwritten, and free-form schema/trace values
    passed metadata validation.
- Real-MySQL tests were added for partial/exact/drift/data migration states,
  concurrent attempt allocation, the database uniqueness constraint and
  terminal-update fencing. These cases exercise behavior absent from the
  reviewed implementation.

## Implementation

- Restricted successful finish reasons to provider-neutral `stop` and
  `tool_call`.
- Normalized provider terminal states:
  - truncation/pause -> `INCOMPLETE_OUTPUT`;
  - filtering/refusal -> `CONTENT_FILTERED`;
  - provider error, unknown and missing reason -> `PROVIDER_ERROR`.
- Applied the terminal fence before structured-output validation or repair.
  Failed terminal states mark `model_runs` as `FAILED`; generation iterators
  throw before the workflow domain committer is reached.
- Added WHATWG `Headers.get()` Retry-After support for seconds and HTTP dates,
  with a 60-second clamp.
- Added bounded nested-cause traversal for transient socket errors and explicit
  installed OpenAI/Anthropic SDK abort, timeout and connection classes.
- Moved attempt-number allocation into a MySQL transaction:
  - lock the parent `workflow_jobs` row;
  - allocate `MAX(attempt_number) + 1` within `workflow_job_id +
    workflow_node`;
  - enforce `UNIQUE(workflow_job_id, workflow_node, attempt_number)`.
- Persisted `attempt_kind`, `generation_attempt`, `network_attempt` and
  `repair_attempt` as dedicated typed columns.
- Made `finishAttempt` conditional on `status = RUNNING`. Identical terminal
  replay is idempotent; conflicting terminal replay raises `ConflictException`.
- Reworked migration `171260` into a complete preflight plus one atomic MySQL
  `ALTER TABLE`. It validates type, nullability, default, ordinal position,
  charset/collation and index shape before DDL; partial schema with data fails
  closed.
- Restricted `response_schema_id`, `trace_id`, workflow node and schema IDs to
  bounded identifier syntax.

## Verification

- Targeted LLM/ModelRun/workflow tests: 4 suites, 72/72 passed.
- Full backend unit tests: 41 suites, 327 passed; 2 MySQL-gated suites and 35
  tests skipped in the default run.
- Real MySQL workflow suite: 13/13 passed, including 12 concurrent allocations
  from three `ModelRunService` instances.
- Real MySQL migration suite: 33/33 passed, including fresh, partial, exact
  no-op, drift zero-DDL and non-empty fail-closed cases.
- Backend build: passed.
- `lint:check`: 0 errors, 38 pre-existing warnings.
- `git diff --check`: passed.

## Scope notes

- Earlier migrations `171205` through `171250` were not changed.
- No production database, deployment or remote repository was touched.
- Temporary Task 7 MySQL containers and schemas were removed after
  verification.

## Round 2: non-empty upgrade and response-mode exclusivity

### RED evidence

- Gateway/provider/workflow contract tests exposed nine failures:
  - text and structured requests accepted `tool_call`;
  - valid JSON plus a tool terminal was accepted as structured success;
  - a tool terminal with no tool event was accepted;
  - `complete()` discarded valid tool calls.
- A real MySQL predecessor-schema test inserted three legacy runs for the same
  workflow job. The old migration rejected the ordinary upgrade with
  `model_runs contains 3 rows`.
- A runtime-boundary test showed an unknown response mode was admitted as text.

### Implementation

- Added explicit `text | structured | tool` response modes while retaining
  schema-based structured-mode inference for compatible callers.
- Text and structured modes now fail with `UNEXPECTED_TOOL_CALL` on either a
  tool event or tool terminal. Tool mode requires at least one complete,
  unique, JSON-object tool call, validates an optional allowlist and requires a
  tool terminal. Model completions return the validated tool-call collection.
- Anthropic and DeepSeek adapters apply the same mode and completeness fences;
  the gateway repeats them as a provider-neutral trust boundary.
- All authoring chains and the legacy completion bridge explicitly request text
  mode, so tool-only model output cannot reach a workflow domain commit.
- Reworked migration `171260` as a resumable upgrade:
  - preflight all existing schema/data before persistent DDL;
  - add missing attempt columns in a nullable staging shape;
  - deterministically number legacy rows per job by
    `started_at, created_at, id`;
  - backfill `workflow_node=legacy`, `attempt_kind=legacy` and typed counters;
  - preserve every pre-existing status, usage, cost, error and timestamp;
  - validate uniqueness, then atomically finalize nullability/defaults and the
    unique index.
- A retry after either staging DDL or backfill is idempotent. Populated
  non-legacy partial rows must be complete and collision-free before any new
  DDL is issued.

### Round 2 verification

- Gateway/provider/agent/workflow targeted suites: 5 suites, 69/69 passed.
- Full backend unit suite: 41 suites, 339 passed; 35 MySQL-gated tests skipped.
- Real MySQL migration suite: 34/34 passed, including multi-row data
  preservation and nullable-stage recovery.
- Real MySQL workflow suite: 13/13 passed, including concurrent attempt
  allocation.
- Backend build: passed.
- `lint:check`: 0 errors, 38 pre-existing warnings.
- `git diff --check`: passed.
- Temporary MySQL containers and schemas: removed.

## Round 3: provider tool definitions and streamed tool integrity

### RED evidence

- `npm test -- --runInBand src/llm/providers/provider-contract.spec.ts src/llm/model-gateway.spec.ts`
  - 25 assertions failed against `c993ee2`.
  - Neither provider sent `tools` or `tool_choice`.
  - Anthropic `{}` plus `input_json_delta` yielded no valid tool call.
  - DeepSeek accepted missing IDs by inventing `tool-0`.
  - Gateway accepted missing, duplicate, unsafe and oversized definitions and
    returned completion-order rather than stable index-order calls.
- A follow-up RED cycle caught two boundary regressions:
  - ordinary Anthropic text block stops were misclassified as malformed tool
    stops;
  - DeepSeek emitted a tool call before an incomplete terminal error.

### Implementation

- Added provider-neutral `ToolDefinition` and `ModelToolChoice` contracts:
  - tool definitions contain exactly `name`, `description` and
    object-shaped `input_schema`;
  - tool choices support `auto`, `required`, `none` and a specific tool name.
- The gateway now validates unique safe tool names, bounded descriptions,
  bounded pure-JSON schemas and exact definition fields. Tool mode requires
  definitions, rejects `none`, and derives every allowed response name from
  the supplied definitions.
- Anthropic mapping:
  - sends native `tools` with `input_schema`;
  - maps `auto -> auto`, `required -> any`, `none -> none` and a named choice
    to `type: tool`;
  - buffers tool blocks until `content_block_stop`, treats start `{}` as a
    streaming placeholder, accepts complete start input, validates final JSON,
    and emits multiple calls in index order.
- DeepSeek/OpenAI-compatible mapping:
  - sends native function tools and native `tool_choice`;
  - requires the provider to supply the initial stable ID and name for each
    index;
  - validates continuation consistency, duplicate IDs, final JSON and names
    derived from definitions without manufacturing correlation IDs.
- Both adapters fail closed for missing IDs/names, duplicate IDs/indexes,
  invalid JSON, conflicting fragments and incomplete terminal responses.
  `ModelGateway.complete()` returns calls in stable index order.

### Round 3 verification

- Provider/Gateway targeted suites: 2 suites, 85/85 passed.
- Provider/Gateway/Agent/workflow targeted suites: 4 suites, 106/106 passed
  before the final two boundary assertions were added; the narrower final
  suites passed afterward.
- Full backend unit suite: 41 suites, 377 passed; 35 MySQL-gated tests skipped
  in the default run.
- Backend build: passed.
- `lint:check`: 0 errors, 38 pre-existing warnings.
- `git diff --check`: passed.
- No schema or migration files changed; no database container was required.
