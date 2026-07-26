# Atomic Grounding Task 10B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 content、rewrite、expand、compress 建立 `grounded-draft.v1` 原子结构化候选链路，使服务端能够确定性验真、渲染并恢复完整 `SealedGroundedCandidateV1`，同时在 Task 10B 中保证所有 atomic 候选只能 shadow、不能产生任何业务提交。

**Architecture:** 在现有 legacy `GroundingVerifier` 旁新增物理隔离的 `backend/src/citation/atomic-grounding/` 纯确定性内核；它只消费已通过 runtime schema 的 atom 和 sealed evidence，不调用自由文本 parser、连接词 splitter、相似度或 semantic reviewer。现有 `ModelGateway.complete()` 负责一次 structured repair 和运行审计，`AtomicGroundingCoordinator` 负责证据/结构上下文、验真、server-only render、envelope seal/recovery；`WorkflowGenerationExecutor` 只在 `shadow_no_persist` 生成及恢复候选，executor 和 `WorkflowDomainCommitService` 分别建立停止门和最终拒绝门。

**Tech Stack:** NestJS 11、TypeScript 5.7、TypeORM 0.3、MySQL 8.4、现有 `ModelGateway`/Anthropic/OpenAI-compatible adapters、Jest 30、Node `crypto`；不新增 runtime dependency。

## Global Constraints

- 范围严格止于 Task 10B：只实现 structured candidate、atomic verifier、server renderer、sealed checkpoint/recovery、legacy fail-closed、`off|shadow_no_persist` 和双重负向 commit guard。
- 不实现 `authoring-commit-capability.v1`、`GroundedApprovalEnvelopeV1` parser、`enforce`、人工批准、正向 atomic persist、Task 11 workflow graph 或 atomic compress 正向提交。
- 固定版本值：`grounded-draft.v1`、`canonical-json.v1`、`canonical-atomic-claim.v1`、`atomic-canonicalizer.v1`、`quantity-lexer.v1`、`escape-plain-text.v1`、`atomic-renderer.v1`、`atomic-verifier.v1`、`approved-render-context.v1`、`sealed-grounded-candidate.v1`、assignment contract `atomic:v1|legacy:v0`。
- runtime 只接受 `off` 和 `shadow_no_persist`；空值、`enforce`、大小写变体和任何未知值都解析为 `off`，不得因配置错误获得新权限。
- public `strict_citation !== false` 映射到 `atomic_strict_v1`；`strict_citation === false` 映射到 non-strict `legacy:v0`，其最高决策只能是 `ALLOW_WITH_UNSUPPORTED`，claim 最高状态只能是 `UNVERIFIABLE`。
- `grounded-draft.v1` 使用 `additionalProperties: false`；每 proposal 最多 500 claims、2,000 fragments、4 MiB UTF-8；claim 最多 1,000 UTF-8 bytes；每 claim 绑定 1–3 个唯一 evidence IDs；offset 均为 UTF-16 `[start,end)`。
- atomic strict 的 `SUPPORTED` 只能来自 `atomic_extract_exact` 或 `atomic_typed_equivalent`；每个已列 evidence 必须独立支持完整 atom，禁止跨 evidence mosaic。
- canonical identity 只做 NFC，不做 NFKC；canonical JSON key 按 JavaScript UTF-16 code unit 排序，只允许 safe integer number，digest 为 `sha256(version_tag + "\0" + canonical_utf8)` 小写 hex。
- renderer 不接受 literal fragment。唯一可见正文数据来自通过验证的 claim；Markdown/HTML-like/model comment bytes 按 `escape-plain-text.v1` 作为普通数据转义；column/paragraph control comments 只能由 renderer 从 sealed allowlist 产生。
- `server_output.text` 是 token 事件、checkpoint 和 Task 11 未来正文持久化的唯一 bytes；Task 10B 不得调用 `normalizeGeneratedContent()` 处理 atomic output。
- checkpoint 必须保存完整 `SealedGroundedCandidateV1`；只保存 digest、裸 output、缺 version 的 envelope 或任一 digest/assignment/context 漂移都 fail closed。
- legacy parser、`splitCoordinatedPropositions()`、bigram/embedding similarity 和 `SemanticGroundingReviewService` 不得位于 atomic strict 到 `SUPPORTED` 的可达调用路径。
- 保持 workflow REST、legacy generation routes、`X-Workflow-Job-Id`、SSE `meta|token|done|error` data shape、citation DTO 字段及停止/恢复 API 兼容；shadow `done` 明确 `server_saved:false` 且无 domain resource。
- 日志/事件只暴露 workflow ID、版本、digest、candidate claim key、reason code 和低基数指标；不得记录 raw prompt、provider raw output、claim text 或 evidence content。
- migration 只做加法并支持 fresh/current/部分 DDL 重跑；旧二进制省略 `contract_version` insert 必须得到 `legacy:v0`；安全 rollback 不得恢复 legacy `SUPPORTED` 权限。
- 所有承重测试直接调用真实 schema parser、renderer、atomic verifier/sealer；不得 mock 掉确定性授权逻辑。每个任务严格 RED → 最小 GREEN → 回归 → 独立提交。

---

## Locked File Structure and Boundaries

| 文件 | 单一职责 |
|---|---|
| `backend/src/citation/atomic-grounding/contracts.ts` | 唯一导出全部 v1 proposal/canonical/render/envelope/diagnostic TypeScript contracts 和固定 version constants。 |
| `backend/src/citation/atomic-grounding/grounded-draft.schema.ts` | `StructuredOutputSchema<GroundedDraftProposal>` 的 JSON Schema 与 runtime parse；执行 union、上限、ID、span、graph/order 校验。 |
| `backend/src/citation/atomic-grounding/canonical-json.ts` | NFC、普通对象/safe integer 校验、UTF-16 key sort、canonical UTF-8 和 version-tagged SHA-256。 |
| `backend/src/citation/atomic-grounding/quantity-lexer.ts` | 闭合数量 lexer、十进制定点/base unit 转换和全部 UTF-16 occurrence 返回；不解析命题。 |
| `backend/src/citation/atomic-grounding/atomic-grounding.verifier.ts` | server field recomputation、exact/typed comparison、每 evidence 独立判定和 proposal decision；不渲染、不持久化。 |
| `backend/src/citation/atomic-grounding/failure-policy.ts` | 39 个 exact reason 的穷尽 internal/public/transition 映射和唯一 unknown fail-closed catch-all。 |
| `backend/src/citation/atomic-grounding/atomic-renderer.ts` | plain-text escape、allowlisted structure controls、唯一 output bytes 与每 claim 全局 UTF-16 offsets。 |
| `backend/src/citation/atomic-grounding/sealed-grounded-candidate.ts` | candidate/persisted IDs、revision invariants、ledger/evidence/envelope digests、seal 和 crash recovery 重验。 |
| `backend/src/citation/atomic-grounding/approved-render-context.service.ts` | 从当前 workflow input、directory/outline/style snapshot 构造排序且校验后的 `SealedApprovedRenderContextV1`。 |
| `backend/src/citation/atomic-grounding/atomic-grounding-coordinator.service.ts` | 唯一组合 ModelGateway、assignment、render context、verifier、renderer、sealer 的应用服务；返回 sealed/revision/material-gap union。 |
| `backend/src/citation/atomic-grounding/atomic-grounding-mode.ts` | 无副作用地解析 `ATOMIC_GROUNDING_MODE`；任何非精确 allowlist 值返回 `off`。 |
| `backend/src/citation/atomic-grounding/atomic-grounding.metrics.ts` | 低基数 counters/histograms 的 closed recorder API 与安全 label 构造。 |
| `backend/src/agent/chains/grounded-draft.chain.ts` | 生成隔离的 atomic messages，并把 `ModelGateway` proposal + repair/bytes/run audit 原样映射为 `GroundedDraftGenerationResult`。 |
| `backend/migrations/1713330000000-AddAtomicGroundingContracts.ts` | 加法新增 `grounding_assignments.contract_version` 与 `grounding_claims.atomic_claim`，显式 backfill 和可重跑收紧。 |
| `backend/test/atomic-grounding-shadow.e2e-spec.ts` | 自建 MySQL 8.4 的六用例 shadow/recovery/五表零写入验收；不可条件跳过。 |
| `backend/scripts/run-atomic-grounding-e2e.mjs` | 执行 atomic E2E 并强制 tests=6、passed=6、pending/skipped=0。 |
| `docs/operations/atomic-grounding-safe-rollback.md` | 固定最低安全 binary capability，禁止 destructive schema rollback。 |
| `docs/operations/atomic-grounding-shadow-rollout.md` | 规定 metrics label allowlist、聚合查询和 shadow rollout dashboard。 |
| 现有 `grounding-verifier.ts`/`citation.service.ts`/`sql-grounding-evidence.store.ts` | 仅保留 legacy 读取、降级和 assignment ownership/snapshot 职责；不得导入 atomic verifier 的授权结果来“修补” legacy。 |
| 现有 `workflow-generation.executor.ts`/`workflow-domain-commit.service.ts` | 前者在 atomic seal 后停止且不调 committer，后者拒绝任何 `atomic:v1` commit；两道门互不依赖。 |

---

### Task 1: Versioned Contracts, Canonical JSON, Quantity Lexer, and Atomic Verifier

**Files:**
- Create: `backend/src/citation/atomic-grounding/contracts.ts`
- Create: `backend/src/citation/atomic-grounding/grounded-draft.schema.ts`
- Create: `backend/src/citation/atomic-grounding/grounded-draft.schema.spec.ts`
- Create: `backend/src/citation/atomic-grounding/canonical-json.ts`
- Create: `backend/src/citation/atomic-grounding/canonical-json.spec.ts`
- Create: `backend/src/citation/atomic-grounding/quantity-lexer.ts`
- Create: `backend/src/citation/atomic-grounding/quantity-lexer.spec.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding.verifier.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding.attack.spec.ts`
- Create: `backend/src/citation/atomic-grounding/failure-policy.ts`
- Create: `backend/src/citation/atomic-grounding/failure-policy.spec.ts`

**Interfaces:**
- Consumes: existing `AssignedEvidenceSnapshot` from `backend/src/citation/grounding-verifier.ts`; stable evidence IDs and exact spans are already validated by `SqlGroundingEvidenceStore`.
- Produces: `GROUNDED_DRAFT_SCHEMA: StructuredOutputSchema<GroundedDraftProposal>`.
- Produces: `canonicalJsonV1(value: unknown): Buffer` and `digestCanonicalV1(versionTag: string, value: unknown): string`.
- Produces: `lexQuantitiesV1(text: string): CanonicalQuantityOccurrenceV1[]` and `recomputeAtomV1(claim: AtomicClaimProposal): RecomputedAtomV1`.
- Produces: `AtomicGroundingVerifier.verify(input: AtomicVerificationInput): AtomicVerificationResult`.
- Produces exact result union:

```ts
interface AtomicVerificationInput {
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  revision_attempt: 0 | 1;
  proposal: GroundedDraftProposal;
  assignment_digest: string;
  evidence: AssignedEvidenceSnapshot[];
}

interface AtomicVerifiedClaimV1 {
  candidate_claim_key: string;
  canonical_claim_base: Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'>;
  support_status: 'SUPPORTED' | 'UNSUPPORTED' | 'UNVERIFIABLE';
  support_score: '1' | '0';
  verification_method:
    | 'atomic_extract_exact'
    | 'atomic_typed_equivalent'
    | 'atomic_unsupported'
    | 'atomic_unverifiable';
  evidence_refs: Array<{
    evidence_id: string;
    evidence_snapshot_digest: string;
  }>;
  reason_codes: AtomicGroundingReasonCode[];
}

interface AtomicVerificationResult {
  decision: 'ALLOW' | 'TARGETED_RETRIEVAL_REVISION' | 'WAITING_MATERIAL';
  canonical_proposal: GroundedDraftProposal;
  claims: AtomicVerifiedClaimV1[];
  material_gap_reason: AtomicGroundingReasonCode | null;
}
```

- Produces the only allowed reason-code type:

```ts
export const ATOMIC_GROUNDING_REASON_CODES = [
  'SCHEMA_INVALID',
  'NO_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
  'AMBIGUOUS_EVIDENCE',
  'UNSUPPORTED_QUANTIFIER',
  'EMPTY_STRICT_DRAFT',
  'RENDER_GRAPH_INVALID',
  'ASSIGNMENT_MISSING',
  'ASSIGNMENT_CONTRACT_MISMATCH',
  'ASSIGNMENT_PROJECT_MISMATCH',
  'ASSIGNMENT_SNAPSHOT_DRIFT',
  'NO_HIT',
  'RETRIEVAL_STATE_INVALID',
  'EVIDENCE_UNKNOWN',
  'EVIDENCE_OWNERSHIP_INVALID',
  'EVIDENCE_NOT_SELECTED',
  'EVIDENCE_INGESTION_INACTIVE',
  'EVIDENCE_OFFSET_DRIFT',
  'EVIDENCE_RUN_DRIFT',
  'EVIDENCE_LEGACY_AMBIGUOUS',
  'EVIDENCE_SNAPSHOT_DRIFT',
  'ATOM_ANCHOR_MISMATCH',
  'ATOM_POLARITY_MISMATCH',
  'ATOM_QUANTIFIER_MISMATCH',
  'ATOM_QUANTITY_MISMATCH',
  'ATOM_EXACT_MISMATCH',
  'ATOM_TYPED_SKELETON_MISMATCH',
  'ATOM_EVIDENCE_MOSAIC_UNSUPPORTED',
  'RENDER_CONTEXT_INVALID',
  'RENDER_FAILED',
  'REVISION_INVARIANT_VIOLATION',
  'REVISION_EXHAUSTED',
  'ENVELOPE_INVALID',
  'ENVELOPE_DIGEST_MISMATCH',
  'RECOVERY_ASSIGNMENT_DRIFT',
  'RECOVERY_RENDER_CONTEXT_DRIFT',
  'ATOMIC_GROUNDING_DISABLED',
  'ATOMIC_COMMIT_NOT_AUTHORIZED',
  'INTERNAL_FAIL_CLOSED',
] as const;

export type AtomicGroundingReasonCode =
  (typeof ATOMIC_GROUNDING_REASON_CODES)[number];

export type AtomicGroundingTransition =
  | 'REVISION_REQUIRED'
  | 'WAITING_MATERIAL'
  | 'FAILED';

export interface AtomicFailureDisposition {
  internal_reason: AtomicGroundingReasonCode;
  public_code:
    | 'STRUCTURED_OUTPUT_INVALID'
    | 'GROUNDING_REVISION_REQUIRED'
    | 'MATERIAL_GAP'
    | 'ATOMIC_GROUNDING_UNAVAILABLE'
    | 'ATOMIC_COMMIT_NOT_AUTHORIZED'
    | 'ATOMIC_GROUNDING_FAILED';
  transition: AtomicGroundingTransition;
}

export function dispositionForAtomicFailure(
  reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
): AtomicFailureDisposition;

export function failClosedUnknownAtomicError(): AtomicFailureDisposition;
```

`contracts.ts` owns the tuple/type. `failure-policy.ts` owns the exhaustive
`switch` and must end with `assertNever(reason)`, not a permissive default.
Only `failClosedUnknownAtomicError()` converts an untyped caught exception to
`INTERNAL_FAIL_CLOSED / ATOMIC_GROUNDING_FAILED / FAILED`; it never copies the
exception message and never falls back to legacy.

The exact failure mapping is:

| Failure source | Internal reason | Public code | Workflow transition |
|---|---|---|---|
| schema/version/extra-field/limit/repair exhausted | `SCHEMA_INVALID` | `STRUCTURED_OUTPUT_INVALID` | `WAITING_MATERIAL` |
| model material gap `NO_EVIDENCE` | `NO_EVIDENCE` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| model material gap `INSUFFICIENT_EVIDENCE` | `INSUFFICIENT_EVIDENCE` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| model material gap `AMBIGUOUS_EVIDENCE` | `AMBIGUOUS_EVIDENCE` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| model material gap `UNSUPPORTED_QUANTIFIER` | `UNSUPPORTED_QUANTIFIER` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| empty strict draft | `EMPTY_STRICT_DRAFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| dangling/duplicate/order-invalid fragment graph | `RENDER_GRAPH_INVALID` | `STRUCTURED_OUTPUT_INVALID` | `WAITING_MATERIAL` |
| no assignment row | `ASSIGNMENT_MISSING` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| assignment is not `atomic:v1` | `ASSIGNMENT_CONTRACT_MISMATCH` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| assignment belongs to another project | `ASSIGNMENT_PROJECT_MISMATCH` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| assignment digest changes before seal | `ASSIGNMENT_SNAPSHOT_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| retrieval state `NO_HIT` | `NO_HIT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| retrieval run is non-terminal/error/drifted | `RETRIEVAL_STATE_INVALID` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| proposal references unknown evidence | `EVIDENCE_UNKNOWN` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| evidence project/owner mismatch | `EVIDENCE_OWNERSHIP_INVALID` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| evidence was not a selected candidate | `EVIDENCE_NOT_SELECTED` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| inactive document/chunk ingestion | `EVIDENCE_INGESTION_INACTIVE` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| exact document/chunk offsets no longer match | `EVIDENCE_OFFSET_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| retrieval run/candidate state changes | `EVIDENCE_RUN_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| legacy evidence ID maps to multiple runs/spans | `EVIDENCE_LEGACY_AMBIGUOUS` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| evidence snapshot digest changes | `EVIDENCE_SNAPSHOT_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| anchor offset/surface/overlap mismatch | `ATOM_ANCHOR_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| closed polarity recomputation mismatch | `ATOM_POLARITY_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| closed quantifier recomputation mismatch | `ATOM_QUANTIFIER_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| quantity count/order/offset/value/unit/comparator mismatch | `ATOM_QUANTITY_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| full extract differs | `ATOM_EXACT_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| typed non-quantity skeleton differs | `ATOM_TYPED_SKELETON_MISMATCH` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| evidence records only support separate halves | `ATOM_EVIDENCE_MOSAIC_UNSUPPORTED` | `GROUNDING_REVISION_REQUIRED` at attempt 0, otherwise `MATERIAL_GAP` | `REVISION_REQUIRED` at attempt 0, otherwise `WAITING_MATERIAL` |
| approved structure snapshot/label invalid | `RENDER_CONTEXT_INVALID` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| deterministic renderer rejects input | `RENDER_FAILED` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| targeted revision changes forbidden target/non-target fields | `REVISION_INVARIANT_VIOLATION` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| second grounding attempt remains unsupported | `REVISION_EXHAUSTED` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| checkpoint is partial/naked/malformed/version-invalid | `ENVELOPE_INVALID` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| any stored envelope-local digest fails | `ENVELOPE_DIGEST_MISMATCH` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| current assignment differs during recovery | `RECOVERY_ASSIGNMENT_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| current render context differs during recovery | `RECOVERY_RENDER_CONTEXT_DRIFT` | `MATERIAL_GAP` | `WAITING_MATERIAL` |
| mode is empty/off/unknown/enforce | `ATOMIC_GROUNDING_DISABLED` | `ATOMIC_GROUNDING_UNAVAILABLE` | `WAITING_MATERIAL` |
| atomic candidate reaches domain committer | `ATOMIC_COMMIT_NOT_AUTHORIZED` | `ATOMIC_COMMIT_NOT_AUTHORIZED` | `FAILED` with zero writes |
| any unclassified caught exception | `INTERNAL_FAIL_CLOSED` | `ATOMIC_GROUNDING_FAILED` | `FAILED` with zero raw error leakage and zero legacy fallback |

- [ ] **Step 1: Write failing schema and canonical JSON golden tests**

Add table-driven tests with actual invalid payloads:

```ts
it.each([
  ['unknown version', { ...validDraft, schema_version: 'grounded-draft.v2' }],
  ['extra field', { ...validDraft, support_status: 'SUPPORTED' }],
  ['empty draft', { ...validDraft, claims: [], render_fragments: [], ordering: [] }],
  ['duplicate claim id', { ...validDraft, claims: [claimC1, claimC1] }],
  ['dangling claim ref', draftWithClaimRef('missing')],
  ['ordering duplicate', { ...validDraft, ordering: ['f1', 'f1'] }],
  ['literal fragment', draftWithFragment({ fragment_id: 'f2', kind: 'literal', text: '事实' })],
  ['material gap with claims', { ...validDraft, status: 'material_gap', material_gap: gap }],
])('rejects %s', (_name, value) => {
  expect(() => GROUNDED_DRAFT_SCHEMA.parse(value)).toThrow();
});
```

Golden vectors must assert NFC equivalence, UTF-16 object-key order, array order preservation, undefined object-field deletion, array undefined rejection, non-finite/safe-integer rejection, `-0` JSON number normalization, and exact hex digests. Include astral keys (`"😀"`) and decomposed `"e\u0301"` so tests exercise JavaScript code-unit ordering and NFC.

`failure-policy.spec.ts` must iterate every member of
`ATOMIC_GROUNDING_REASON_CODES` at revision attempts 0 and 1, compare each
result to the exact mapping table above, assert the tuple has no duplicates,
and assert `failClosedUnknownAtomicError()` returns exactly
`INTERNAL_FAIL_CLOSED / ATOMIC_GROUNDING_FAILED / FAILED` without including a
fixture secret error message.

- [ ] **Step 2: Run schema/canonical RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL with module resolution errors for `grounded-draft.schema` and `canonical-json`.

- [ ] **Step 3: Implement contracts, runtime schema, canonical JSON, and digest primitives**

Put every version literal in `contracts.ts`; consumers import constants instead of repeating strings. `GROUNDED_DRAFT_SCHEMA.json_schema` must fully describe the discriminated unions and use `additionalProperties:false` recursively. `parse()` must independently enforce limits that provider JSON Schema cannot safely enforce:

```ts
export const GROUNDED_DRAFT_SCHEMA = {
  id: GROUNDED_DRAFT_SCHEMA_VERSION,
  json_schema: groundedDraftJsonSchema,
  parse(value: unknown): GroundedDraftProposal {
    assertProposalUtf8Bytes(value, 4 * 1024 * 1024);
    const draft = parseClosedProposalObject(value);
    assertUniqueIdsAndClosedRenderGraph(draft);
    assertClaimSpansAndAnchors(draft);
    return canonicalizeProposalOrder(draft);
  },
} satisfies StructuredOutputSchema<GroundedDraftProposal>;
```

`canonicalJsonV1()` recursively copies ordinary objects, drops object-valued `undefined`, rejects `undefined` in arrays, rejects prototypes other than `Object.prototype|null`, sorts keys by direct UTF-16 `<` comparison, NFC-normalizes every string, and returns whitespace-free UTF-8. Do not reuse the weaker workflow idempotency `stableJsonStringify()`.

- [ ] **Step 4: Write failing quantity lexer and field-recomputation tests**

Cover every supported family and all occurrences:

```ts
expect(lexQuantitiesV1('甲为0.3GW，乙为300MW，周期12个月，占比50%。'))
  .toMatchObject([
    { ordinal: 0, dimension: 'power', base_value: '300000000', base_unit: 'W', comparator: 'eq' },
    { ordinal: 1, dimension: 'power', base_value: '300000000', base_unit: 'W', comparator: 'eq' },
    { ordinal: 2, dimension: 'duration', base_value: '12', base_unit: 'month', comparator: 'eq' },
    { ordinal: 3, dimension: 'ratio', base_value: '0.5', base_unit: null, comparator: 'eq' },
  ]);
```

Add Arabic/Chinese numerals, 万/亿, percent, W/kW/MW/GW, Wh/kWh/MWh/GWh, 年/月, listed currency units, count/length/mass/temperature fixtures already covered by current verifier tests, and `超过|大于|不少于|至少|小于|不超过|约|范围` comparators. Assert exact UTF-16 offsets around emoji and reject exponent form, ambiguous mixed comparator, malformed decimal, overlapping occurrence and out-of-range proposal offsets.

- [ ] **Step 5: Run quantity RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because `lexQuantitiesV1` and `recomputeAtomV1` do not exist.

- [ ] **Step 6: Implement the closed lexer and recomputation**

Port only the already tested numeric/unit vocabulary from the legacy verifier into a standalone scanner. The scanner advances left-to-right by UTF-16 index, returns every non-overlapping occurrence, canonicalizes decimal strings without floating-point math, and never deletes or classifies `和/与/及/并/但/而/、`.

`recomputeAtomV1()` must:

1. NFC-normalize source text and validate no CR/LF/control/fence.
2. Re-slice subject/predicate anchors using proposal offsets; require non-empty exact surface equality and no overlap.
3. Recompute polarity/quantifier from a closed whole-atom lexer; conflicting or `some|other` makes the atom exact-only.
4. Compare every quantity occurrence against proposal cardinality, order, offsets, surface, dimension, base value/unit, comparator and range end.
5. Produce a canonical atom only after all server fields agree.

- [ ] **Step 7: Write failing verifier positives, negatives, no-mosaic, and authority tests**

Build real `AssignedEvidenceSnapshot` fixtures with `evidence_snapshot_digest`. Test:

- full extract exact;
- typed equivalents `0.3GW/300MW`, `12个月/1年`, `50%/0.5`, `超过300MW/大于300MW` only when non-quantity skeleton is byte-equal;
- extra/missing/reordered quantity, wrong adjacent value, `>=` versus `>`, different skeleton, polarity/quantifier mismatch, approx/range/other typed comparison all reject;
- each evidence supports the whole atom; two half-evidence records reject, and one irrelevant evidence among three rejects;
- unknown evidence, duplicate evidence ID, missing snapshot digest and assignment/project mismatch become stable fail-closed results;
- every verifier failure uses the exact Task 1 disposition table at revision
  attempts 0 and 1; an injected unknown exception maps only to
  `INTERNAL_FAIL_CLOSED` and never includes its message;
- schema-proposed `support_status`, score, output offset and retrieval metadata are rejected before verifier;
- spy/architecture test imports atomic modules and asserts no call/import edge to `parseVisibleOutput`, `extractVisibleStatements`, `splitCoordinatedPropositions`, `GroundingVerifier.verify`, or `SemanticGroundingReviewer.review`.

The attack table must contain these exact pairs and assert no claim is `SUPPORTED` and decision is not `ALLOW`:

```ts
[
  ['系统支持并网运行。', '系统支持，网运行'],
  ['系统支持和田基地运行。', '系统支持，田基地运行'],
  ['系统支持与会人员使用。', '系统支持，会人员使用'],
  ['系统支持及格率提高。', '系统支持，格率提高'],
  ['甲容量为300MW和乙容量为400MW。', '甲容量为400MW和乙容量为300MW。'],
  ['不是所有系统都可以运行。', '所有系统都不能运行。'],
  ['建设周期为1年。', '建设周期为1年半。'],
  ['建设周期为1年。', '建设周期为1年以上。'],
  ['完成比例为50%。', '完成比例为50%以上。'],
  ['项目已完成。', '项目已完成一半。'],
]
```

- [ ] **Step 8: Run verifier RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because `AtomicGroundingVerifier.verify()` and the closed support methods are missing.

- [ ] **Step 9: Implement minimal atomic verifier**

Generate `candidate_claim_key` from workflow ID, generation attempt and initial claim-fragment ordinal. For each evidence ID, independently perform exact comparison first, then typed comparison; one failure fails the claim. Never average scores and never return `PARTIAL`.
The verifier returns `canonical_claim_base`; Task 2 is the only layer that
adds `rendered_claim_text` after `escapePlainTextV1()` has produced the actual
bytes. This prevents pre-render code from guessing renderer-owned data.

```ts
const perEvidence = evidenceRefs.map((evidence) =>
  compareOneEvidence(recomputed, evidence.exact_span_text),
);
const supported = perEvidence.length > 0 && perEvidence.every((x) => x.supported);
```

`compareOneEvidence()` may normalize NFC, the specified ASCII/full-width spaces and one terminal sentence punctuation only. Typed comparison replaces all quantities in order with `__Q0__`, `__Q1__`, then requires equal count/order, equal closed polarity/quantifier, exact non-quantity skeleton and exact canonical quantity tuples. `some|other`, `approx|range` and dimension `other` never enter typed equivalence.

- [ ] **Step 10: Run GREEN and regression**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/grounded-draft.schema.spec.ts \
  src/citation/atomic-grounding/canonical-json.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/citation/atomic-grounding/quantity-lexer.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.verifier.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.attack.spec.ts \
  --runInBand --no-coverage)
(cd backend && npm run build)
git diff --check
```

Expected: all selected suites PASS, TypeScript build PASS, diff check emits no output.

- [ ] **Step 11: Commit**

```bash
git add backend/src/citation/atomic-grounding
git commit -m "feat: add deterministic atomic grounding verifier"
```

---

### Task 2: Server Renderer, Sealed Envelope, Digests, Revision Invariants, and Recovery

**Files:**
- Create: `backend/src/citation/atomic-grounding/atomic-renderer.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-renderer.spec.ts`
- Create: `backend/src/citation/atomic-grounding/sealed-grounded-candidate.ts`
- Create: `backend/src/citation/atomic-grounding/sealed-grounded-candidate.spec.ts`
- Create: `backend/src/citation/atomic-grounding/sealed-grounded-candidate.recovery.spec.ts`
- Modify: `backend/src/citation/atomic-grounding/contracts.ts`

**Interfaces:**
- Consumes: `AtomicVerificationResult`,
  `Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'>`,
  `canonicalJsonV1()`, and `digestCanonicalV1()` from Task 1.
- Produces: `escapePlainTextV1(sourceNfc: string): string`.
- Produces: `renderAtomicDraftV1(input: AtomicRenderInput): AtomicRenderResult`.
- Produces: `sealGroundedCandidateV1(input: SealGroundedCandidateInput): SealedGroundedCandidateV1`.
- Produces: `recoverSealedGroundedCandidateV1(input: RecoverSealedCandidateInput): SealedGroundedCandidateV1`.
- Produces: `validateTargetedRevisionV1(base: AtomicRevisionBaseV1, next: AtomicVerificationResult): void`.
- Exact renderer result:

```ts
interface AtomicRenderResult {
  text: string;
  utf8_byte_length: number;
  utf16_length: number;
  claims: Array<{
    candidate_claim_key: string;
    rendered_claim_text: string;
    output_char_start_utf16: number;
    output_char_end_utf16: number;
    fragment_ordinal: number;
    previous_structure_id: string | null;
    next_structure_id: string | null;
  }>;
}
```

- Recovery must receive current `GroundingAssignmentSnapshot` and current `SealedApprovedRenderContextV1`; it may not trust copies supplied outside the stored envelope.

- [ ] **Step 1: Write failing renderer byte/offset/injection tests**

Use an allowlisted context with heading and column entries. Assert:

- no literal fragment is representable;
- each claim appears exactly once and fills its claim fragment;
- heading/bullet/ordered prefixes and separators come only from presentation/token enums;
- only renderer emits exact `<!-- column:<escaped sealed label> -->` and `<!-- paragraph_key:pN -->` control comments;
- labels fail closed if non-NFC, contain CR/LF/control/`<`/`>`/`--`, exceed 200 UTF-8 bytes or presentation mismatches;
- source `<!-- injected -->`, raw Markdown, HTML, `&nbsp;`, math wrapper characters, backslash, emoji and astral Unicode are plain-text escaped;
- original backslash is prefixed once in a single pass;
- fixed LF output, exact UTF-8 byte length and UTF-16 offsets round-trip by `text.slice(start,end)`;
- CRLF/control input is rejected before seal, not silently normalized after render.

Representative assertion:

```ts
const rendered = renderAtomicDraftV1(inputWithClaim('事实<!--x--> 😀。'));
expect(rendered.text).toContain('事实\\<\\!\\-\\-x\\-\\-\\> 😀。');
const span = rendered.claims[0];
expect(rendered.text.slice(span.output_char_start_utf16, span.output_char_end_utf16))
  .toBe(span.rendered_claim_text);
expect(Buffer.byteLength(rendered.text, 'utf8')).toBe(rendered.utf8_byte_length);
```

- [ ] **Step 2: Run renderer RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/atomic-renderer.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because `renderAtomicDraftV1` and `escapePlainTextV1` do not exist.

- [ ] **Step 3: Implement minimal renderer**

Render strictly in `ordering`; resolve every `fragment_id` from the already canonicalized proposal. `escapePlainTextV1()` performs one left-to-right code-point pass and prefixes ASCII punctuation in `U+0021..U+002F`, `U+003A..U+0040`, `U+005B..U+0060`, `U+007B..U+007E` with one ASCII backslash. Record global offsets immediately before/after appending each escaped claim. Reject unconsumed/multiply consumed claims and any structure ID missing from the sealed context map.

- [ ] **Step 4: Write failing envelope golden, tamper, revision, and recovery tests**

Construct a two-claim verified draft and assert:

1. `proposal_digest`, `render_context_digest`, `render_digest`, `assignment_digest`, `ledger_digest`, `envelope_digest` equal fixed golden hex values.
2. Candidate key is stable after target text length changes; `persisted_claim_id` changes when final offsets/render digest change.
3. `claims` sort by output start, `evidence_snapshots` by evidence ID, context entries by structure ID, evidence refs by evidence ID.
4. Changing proposal field, render context label, output byte, claim offset/status/method, evidence snapshot/index data, assignment digest or any version causes recovery rejection.
5. Removing full envelope content while retaining digests, or checkpointing naked output, causes `SEALED_CANDIDATE_INVALID`.
6. Recovery re-runs schema parse, canonical proposal, renderer, ledger and every digest against current assignment/context without a model call.
7. Revision requires one-to-one replacement of allowed candidate keys; rejects add/delete/reorder, changed non-target text/evidence, changed target fragment ordinal/presentation/neighbouring structure refs, revision attempt other than 1 and stale base digest.
8. Non-target invariant remains equal when only target length moves later offsets.

- [ ] **Step 5: Run envelope/recovery RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/sealed-grounded-candidate.spec.ts \
  src/citation/atomic-grounding/sealed-grounded-candidate.recovery.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because seal, digest and recovery functions are missing.

- [ ] **Step 6: Implement envelope seal, identity, and recovery**

Use the exact formulas:

```ts
candidate_claim_key = sha256Utf8(
  `candidate-claim-key.v1\0${workflowJobId}\0${generationAttempt}\0${initialOrdinal}`,
);

persisted_claim_id = sha256Utf8(
  `persisted-claim-id.v1\0${workflowJobId}\0${ATOMIC_VERIFIER_VERSION}\0` +
  `${renderDigest}\0${canonicalClaimJson}\0${start}\0${end}`,
);
```

`render_digest` hashes `atomic-renderer.v1 + "\0" + server_output.text`. Assignment digest is the store-provided sealed digest bound to `atomic:v1`. `ledger_digest` covers ordered claims including canonical claim, final ID/offset/verdict/method/evidence refs. `envelope_digest` canonicalizes the complete envelope with only `digests.envelope_digest` omitted.

After rendering, join each renderer span back to the verifier result by
`candidate_claim_key` and create the full `CanonicalAtomicClaimV1` by adding
the exact `rendered_claim_text`. Convert evidence score numbers to canonical
decimal strings before constructing `SealedEvidenceSnapshotV1`; reject
non-finite values instead of serializing JavaScript floating-point anomalies.

Seal only when `verification.decision === 'ALLOW'`, every claim is `SUPPORTED`, at least one claim exists, all evidence snapshots have digests, and renderer spans round-trip. `recoverSealedGroundedCandidateV1()` first closed-parses the envelope, then reconstructs rather than mutating the stored object, and constant-time compares expected digests where lengths match.

- [ ] **Step 7: Run GREEN and Task 1 regression**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding \
  --runInBand --no-coverage)
(cd backend && npm run build)
git diff --check
```

Expected: all atomic suites PASS, build PASS, diff check clean.

- [ ] **Step 8: Commit**

```bash
git add backend/src/citation/atomic-grounding
git commit -m "feat: seal recoverable grounded candidates"
```

---

### Task 3: Additive Migration, Legacy Fail-Closed Reads, and Atomic-Only Inheritance

**Files:**
- Create: `backend/migrations/1713330000000-AddAtomicGroundingContracts.ts`
- Modify: `backend/migrations/support/application-schema-contract.ts`
- Modify: `backend/test/migrations.e2e-spec.ts`
- Modify: `backend/src/citation/entities/grounding-assignment.entity.ts`
- Modify: `backend/src/citation/entities/grounding-claim.entity.ts`
- Modify: `backend/src/citation/citation-ledger.service.ts`
- Modify: `backend/src/citation/citation-ledger.service.spec.ts`
- Modify: `backend/src/citation/grounding-verifier.ts`
- Modify: `backend/src/citation/grounding-verifier.spec.ts`
- Create: `backend/src/citation/grounding-read-policy.ts`
- Create: `backend/src/citation/grounding-read-policy.spec.ts`
- Create: `backend/src/citation/grounding-safety-version.ts`
- Create: `backend/src/citation/grounding-safety-version.spec.ts`
- Modify: `backend/src/citation/citation.service.ts`
- Modify: `backend/src/citation/citation.service.spec.ts`
- Modify: `backend/src/citation/sql-grounding-evidence.store.ts`
- Modify: `backend/src/citation/sql-grounding-evidence.store.spec.ts`
- Modify: `backend/src/content/content-shared.service.ts`
- Create: `docs/operations/atomic-grounding-safe-rollback.md`

**Interfaces:**
- Consumes: existing assignment ownership/run/selected/active-ingestion/snapshot loader and existing public citation DTO.
- Produces: DB `grounding_assignments.contract_version VARCHAR(32) NOT NULL DEFAULT 'legacy:v0'`.
- Produces: DB `grounding_claims.atomic_claim JSON NULL`.
- Produces: `GroundingAssignmentSnapshot.contract_version: 'atomic:v1' | 'legacy:v0'`.
- Produces:

```ts
interface PersistedAtomicClaimV1 {
  canonicalizer_version: 'atomic-canonicalizer.v1';
  quantity_lexer_version: 'quantity-lexer.v1';
  verifier_version: 'atomic-verifier.v1';
  canonical_claim: CanonicalAtomicClaimV1;
}
```

- Changes: `AssignGroundingEvidenceInput`, `ReplaceGroundingEvidenceInput`, inherited assignment writes require an explicit `contract_version`.
- Produces: `capPersistedGroundingForRead(input: PersistedGroundingReadInput): PersistedGroundingReadVerdict`.
- Legacy invariant: `GroundingVerifier.verify()` can return `ALLOW_WITH_UNSUPPORTED` only for `strict:false`; every returned claim is capped to `UNVERIFIABLE`, score `0`, method `legacy_unverifiable`. For `strict:true`, it returns revision/material-gap and never `ALLOW`.
- Produces:

```ts
export const MINIMUM_SAFE_GROUNDING_BINARY =
  'legacy-grounding-fail-closed.v1' as const;
```

The runbook names that exact capability as the rollback floor. A binary that
does not export/announce `legacy-grounding-fail-closed.v1` is never an allowed
rollback target, even if schema rollback was attempted.

- [ ] **Step 1: Write failing migration E2E for fresh/current/partial/old-binary paths**

Register `AddAtomicGroundingContracts1713330000000` in the explicit migration array. Add real MySQL 8.4 cases:

- fresh migration yields exact column definitions/default/nullability;
- current populated ledger preserves row counts and backfills every assignment to `legacy:v0`;
- simulate successful first ALTER and absent second ALTER, rerun migration, then verify both columns;
- old SQL omitting `contract_version` inserts `legacy:v0`;
- atomic assignment writer must explicitly insert `atomic:v1`;
- changing only `contract_version` changes the assignment snapshot digest, and loading a snapshot persisted under the other contract fails closed;
- no row has null/unknown contract after migration;
- running the migration twice does not change old rows;
- `revertLastMigration()` rejects with the stable error
  `ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN`;
- after that rejected rollback, real MySQL still has both columns, the
  migration-table row, all `atomic_claim` JSON and all assignment
  `contract_version` values byte-for-byte unchanged;
- a SQL fixture representing the minimum safe old binary can still omit the
  new columns and receives `legacy:v0`;
- `grounding-safety-version.spec.ts` and the runbook both pin the rollback floor
  to exact capability `legacy-grounding-fail-closed.v1`.

- [ ] **Step 2: Run migration RED**

Run:

```bash
(cd backend && npm run test:e2e -- migrations.e2e-spec.ts --runInBand)
```

Expected: FAIL because migration `1713330000000` and schema-contract expectations do not exist.

- [ ] **Step 3: Implement idempotent additive migration and entity/schema contract**

Migration order is fixed:

1. Add `contract_version VARCHAR(32) NULL DEFAULT 'legacy:v0'` if absent.
2. `UPDATE ... SET contract_version='legacy:v0' WHERE contract_version IS NULL`.
3. Reject any value outside `legacy:v0|atomic:v1`.
4. Modify to `NOT NULL DEFAULT 'legacy:v0'`.
5. Add nullable `atomic_claim JSON` if absent.

Do not rewrite historical claims or manufacture atomic JSON. Update `application-schema-contract.ts` expected signatures and both TypeORM entities.
`down()` must not issue any DDL or DML:

```ts
public async down(): Promise<never> {
  throw new Error('ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
}
```

`docs/operations/atomic-grounding-safe-rollback.md` instructs operators to
leave migration `1713330000000` applied, deploy only a binary advertising
`legacy-grounding-fail-closed.v1` or newer, set atomic mode `off`, and verify
legacy reads/writes remain capped. It explicitly forbids dropping
`contract_version` or `atomic_claim`.

- [ ] **Step 4: Write failing legacy authorization/read/compress tests**

Tests must demonstrate:

```ts
expect(await legacyVerifier.verify({ ...input, strict: false })).toMatchObject({
  decision: 'ALLOW_WITH_UNSUPPORTED',
  claims: [expect.objectContaining({
    support_status: 'UNVERIFIABLE',
    support_score: 0,
    verification_method: 'legacy_unverifiable',
  })],
});
```

Also cover:

- strict legacy markers, even exact text, never return `ALLOW`;
- semantic reviewer returning `SUPPORTED` cannot upgrade legacy;
- persisted `SUPPORTED` row reads as-is only if joined assignment is `atomic:v1`, `atomic_claim` is a closed valid `PersistedAtomicClaimV1`, its nested canonical claim is `canonical-atomic-claim.v1`, and verifier version is exactly allowlisted;
- missing assignment join, `legacy:v0`, null/malformed/unknown-version atomic JSON, or unknown method caps response to `UNVERIFIABLE/0/legacy_unverifiable`;
- public citation fields and GB/T grouping remain present;
- compress inheritance query rejects legacy parent, null/malformed atomic claim, non-`SUPPORTED` claim, missing evidence refs and unsupported verifier version;
- atomic assignment insert/replace/inherit includes explicit `contract_version='atomic:v1'`; non-strict writes explicit `legacy:v0`;
- legacy evidence-ID collision and multi-run ambiguity remain fail closed.

- [ ] **Step 5: Run legacy/read/compress RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/grounding-verifier.spec.ts \
  src/citation/grounding-read-policy.spec.ts \
  src/citation/grounding-safety-version.spec.ts \
  src/citation/citation-ledger.service.spec.ts \
  src/citation/citation.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because legacy exact claims still obtain `SUPPORTED`, reads trust stored support columns, and inheritance SQL has no atomic contract filter.

- [ ] **Step 6: Implement fail-closed legacy and read policy**

Keep marker parsing only for display/diagnostic extraction. Before computing legacy decision, cap every parsed/unmarked claim:

```ts
const capped = claims.map((claim) => ({
  ...claim,
  support_status: 'UNVERIFIABLE' as const,
  support_score: 0,
  verification_method: 'legacy_unverifiable',
}));
```

Do not call `applySemanticReview()` as an upgrade path. `CitationService` must select `ga.contract_version` and `gc.atomic_claim` through `gc.workflow_job_id/project_id`; call `capPersistedGroundingForRead()` before `toPublicCitation()`. The read policy closed-parses only the minimal version/method fields required for authorization and otherwise returns the capped verdict.

Tighten `inheritEvidenceAssignment()` SQL with all of:

```sql
ga.contract_version = 'atomic:v1'
AND gc.atomic_claim IS NOT NULL
AND JSON_UNQUOTE(JSON_EXTRACT(
      gc.atomic_claim, '$.canonical_claim.canonical_claim_version'))
      = 'canonical-atomic-claim.v1'
AND JSON_UNQUOTE(JSON_EXTRACT(gc.atomic_claim, '$.verifier_version'))
      = 'atomic-verifier.v1'
AND gc.support_status = 'SUPPORTED'
AND gc.verification_method IN ('atomic_extract_exact', 'atomic_typed_equivalent')
AND cm.evidence_id IS NOT NULL
AND cm.snapshot_digest IS NOT NULL
```

This is a negative-only compress gate. Do not add Task 11 atomic compress persist.
Include `contract_version` in the canonical assignment snapshot object before
computing/validating `snapshot_digest`; a legacy/atomic contract flip must
invalidate recovery even when all run/evidence rows are unchanged.

- [ ] **Step 7: Run GREEN, real MySQL regression, and build**

Run:

```bash
(cd backend && npx jest \
  src/citation/grounding-verifier.spec.ts \
  src/citation/grounding-read-policy.spec.ts \
  src/citation/grounding-safety-version.spec.ts \
  src/citation/citation-ledger.service.spec.ts \
  src/citation/citation.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  --runInBand --no-coverage)
(cd backend && npm run test:e2e -- migrations.e2e-spec.ts --runInBand)
(cd backend && npm run build)
git diff --check
```

Expected: unit suites PASS; real MySQL fresh/current/partial/old-binary cases PASS; build PASS; diff check clean.

- [ ] **Step 8: Commit**

```bash
git add \
  backend/migrations/1713330000000-AddAtomicGroundingContracts.ts \
  backend/migrations/support/application-schema-contract.ts \
  backend/test/migrations.e2e-spec.ts \
  backend/src/citation \
  backend/src/content/content-shared.service.ts \
  docs/operations/atomic-grounding-safe-rollback.md
git commit -m "fix: fail closed legacy grounding authority"
```

---

### Task 4: Structured ModelGateway Proposal and Atomic Grounding Coordinator

**Files:**
- Create: `backend/src/agent/chains/grounded-draft.chain.ts`
- Create: `backend/src/agent/chains/grounded-draft.chain.spec.ts`
- Modify: `backend/src/agent/agent.service.ts`
- Modify: `backend/src/agent/agent.service.spec.ts`
- Modify: `backend/src/llm/model-types.ts`
- Modify: `backend/src/llm/model-gateway.ts`
- Modify: `backend/src/llm/model-gateway.spec.ts`
- Create: `backend/src/citation/atomic-grounding/approved-render-context.service.ts`
- Create: `backend/src/citation/atomic-grounding/approved-render-context.service.spec.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding-coordinator.service.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding-coordinator.service.spec.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding.metrics.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding.metrics.spec.ts`
- Modify: `backend/src/citation/citation.module.ts`
- Modify: `backend/src/content/content-generation.service.ts`
- Modify: `backend/src/content/content.service.ts`
- Modify: `backend/src/content/content.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 schema/verifier, Task 2 renderer/sealer, Task 3 contract-aware assignment loader, existing `ModelGateway.complete()`, existing retrieval/context preparation.
- Produces:

```ts
interface GroundedDraftModelInput {
  workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
  workflow_job_id: string;
  generation_attempt: number;
  revision_attempt: 0 | 1;
  authoring_context: Record<string, unknown>;
  approved_render_context: SealedApprovedRenderContextV1;
  evidence: Array<{
    evidence_id: string;
    exact_span_text: string;
    source_boundary: 'untrusted_evidence';
  }>;
  revision?: {
    base_proposal: GroundedDraftProposal;
    allowed_candidate_claim_keys: string[];
    non_target_invariant_digests: Record<string, string>;
  };
}

interface AtomicGroundingGenerationInput {
  workflow_job_id: string;
  project_id: string;
  workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
  generation_attempt: number;
  revision_attempt: 0 | 1;
  authoring_context: Record<string, unknown>;
  signal: AbortSignal;
  revision?: GroundedDraftModelInput['revision'];
}

AgentService.generateGroundedDraft(
  input: GroundedDraftModelInput,
  options: LLMStreamOptions,
): Promise<GroundedDraftGenerationResult>;

interface ModelCompletionAudit {
  repair_attempts: number;
  response_utf8_bytes: number;
  final_model_run_id: string | null;
}

interface GroundedDraftGenerationResult {
  proposal: GroundedDraftProposal;
  audit: {
    repair_attempts: 0 | 1;
    proposal_bytes: number;
    model_run_id: string | null;
  };
}

AtomicGroundingCoordinator.generate(
  input: AtomicGroundingGenerationInput,
): Promise<AtomicGroundingOutcome>;

type AtomicGroundingOutcome =
  | { kind: 'sealed'; candidate: SealedGroundedCandidateV1 }
  | {
      kind: 'revision_required';
      canonical_proposal: GroundedDraftProposal;
      unsupported_claims: Array<{
        candidate_claim_key: string;
        source_claim_text_nfc: string;
        reason_code: AtomicGroundingReasonCode;
      }>;
      non_target_invariant_digests: Record<string, string>;
    }
  | {
      kind: 'material_gap';
      reason_code: AtomicGroundingReasonCode;
      candidate_claim_keys: string[];
    };
```

- `ContentService.generateAtomicGroundingCandidate(...)` is the executor-facing façade; it returns one buffered outcome and never yields provider raw deltas.
- Extends every `ModelCompletion` with `audit: ModelCompletionAudit`.
  The provider-facing completed `ModelEvent` accepts optional
  `gateway_audit?: ModelCompletionAudit`; only `ModelGateway` may populate it,
  and `complete()` rejects a terminal event that exits the gateway without it.
  `ModelGateway` sets `repair_attempts` from its internal structured repair
  counter, `response_utf8_bytes` from the validated buffered response bytes,
  and `final_model_run_id` from the successful final run. Provider content
  cannot supply or overwrite these fields.
- Produces the metrics API:

```ts
type AtomicCounterName =
  | 'grounding_proposal_total'
  | 'grounding_claim_total'
  | 'grounding_fail_closed_total'
  | 'grounding_revision_total'
  | 'grounding_material_gap_total'
  | 'grounding_structured_repair_total';

type AtomicHistogramName =
  | 'grounding_proposal_bytes'
  | 'grounding_proposal_claim_count'
  | 'grounding_render_latency_ms'
  | 'grounding_time_to_first_rendered_token_ms';

interface AtomicMetricPoint {
  name: AtomicCounterName | AtomicHistogramName;
  kind: 'counter' | 'histogram';
  value: number;
  labels: Readonly<Record<string, string>>;
}

interface AtomicGroundingMetricSink {
  record(point: AtomicMetricPoint): void;
}

class AtomicGroundingMetricsRecorder {
  proposal(workflowType, status, schema, bytes, claimCount, repairAttempts): void;
  claim(workflowType, method, verdict): void;
  failClosed(workflowType, reason: AtomicGroundingReasonCode): void;
  revision(outcome: 'required' | 'sealed' | 'exhausted'): void;
  materialGap(reason: AtomicGroundingReasonCode): void;
  renderLatency(workflowType, milliseconds): void;
  firstRenderedToken(workflowType, milliseconds): void;
}
```

The recorder owns label construction. Allowed label keys are only `schema`,
`status`, `workflow_type`, `method`, `verdict`, `reason`, and `outcome`;
allowed values come only from version constants, workflow enums, verifier
enums, the exact reason tuple and closed outcome enums. Callers cannot pass
arbitrary label maps, workflow IDs, claim IDs or text.

- [ ] **Step 1: Write failing structured chain/gateway integration tests**

Use a real `ModelGateway` with fake provider events, not a mocked schema parser. Assert:

- request uses `response_mode:'structured'`, `GROUNDED_DRAFT_SCHEMA`, bounded `max_tokens`, timeout, signal and workflow trace;
- initial valid JSON returns parsed proposal;
- invalid first response triggers exactly one targeted repair and valid second response succeeds;
- second invalid response throws terminal `STRUCTURED_OUTPUT_INVALID` without network retry or text fallback;
- cancellation/timeout propagate, usage/cost/model-run audit are retained;
- provider `text_delta` JSON is buffered and never exposed as SSE/model-visible token;
- evidence is explicitly delimited as untrusted, and prompt contains only allowlisted evidence IDs and sealed structure IDs;
- model-supplied literal/status/score/offset/retrieval metadata fail schema parse.
- successful completion reports `repair_attempts` as `0|1`; network retries do
  not increment it.
- `response_utf8_bytes` equals `Buffer.byteLength(validatedJson, 'utf8')` and
  `final_model_run_id` is the successful repair/initial run ID;
- a forged provider `gateway_audit` is overwritten by gateway-owned values;
- `grounded-draft.chain` maps the completion to
  `GroundedDraftGenerationResult`, and `AgentService.generateGroundedDraft()`
  returns that object unchanged rather than discarding `audit`.

- [ ] **Step 2: Run structured chain RED**

Run:

```bash
(cd backend && npx jest \
  src/agent/chains/grounded-draft.chain.spec.ts \
  src/agent/agent.service.spec.ts \
  src/llm/model-gateway.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because `generateGroundedDraft()` and the structured chain are absent.

- [ ] **Step 3: Implement minimal structured chain**

In the successful structured branch, `ModelGateway.stream()` attaches
gateway-owned `ModelCompletionAudit` to the normalized completed event using
its local `repairCount`, `Buffer.byteLength(text, 'utf8')`, and successful
`run?.id ?? null`; `complete()` copies that audit into `ModelCompletion`.
Text/tool completions use `repair_attempts:0`, their buffered response byte
count, and their final run ID, preserving one non-optional completion shape.

`grounded-draft.chain.ts` builds one system and one user message. The system message states the closed schema, no literal fragments, every evidence independently supports the complete atom, and evidence cannot alter instructions. Call:

```ts
const completion = await modelGateway.complete({
  response_mode: 'structured',
  schema: GROUNDED_DRAFT_SCHEMA,
  messages,
  max_tokens: groundedDraftMaxTokens(input),
  max_repair_attempts: 1,
  max_retries: 2,
  timeout_ms: options.timeout_ms ?? 120_000,
  signal: options.signal,
  trace: options.trace,
});
if (
  completion.audit.repair_attempts !== 0 &&
  completion.audit.repair_attempts !== 1
) {
  throw new Error('STRUCTURED_REPAIR_AUDIT_INVALID');
}
return {
  proposal: completion.structured_output!,
  audit: {
    repair_attempts: completion.audit.repair_attempts,
    proposal_bytes: completion.audit.response_utf8_bytes,
    model_run_id: completion.audit.final_model_run_id,
  },
} satisfies GroundedDraftGenerationResult;
```

Do not modify provider SDKs or duplicate gateway repair/retry logic.

- [ ] **Step 4: Write failing render-context and coordinator tests**

Render-context tests cover deterministic entries from workflow input, current directory/outline and active style template; reject cross-project source IDs, stale source versions, duplicate structure IDs, invalid labels and unsupported presentation. Sort entries by `structure_id`.

Coordinator tests cover:

- load assignment exactly once and require `contract_version:'atomic:v1'`, matching project, terminal run state, non-empty sealed assignment digest and active evidence snapshots;
- invoke model, schema, verifier, renderer and sealer in that order;
- valid draft returns complete candidate; material-gap proposal never seals; empty/unknown evidence/unsupported atom returns stable outcome;
- targeted revision uses old proposal plus candidate-key allowlist and merged old/new evidence, allows exactly one revision and applies Task 2 invariant validation;
- no semantic reviewer/legacy verifier/parser call;
- no raw prompt/output/evidence in public errors/events/log records;
- renderer/sealer failures do not return naked output;
- coordinator recovery invokes `recoverSealedGroundedCandidateV1()` and performs zero model calls.
- every exact Task 1 failure reason produces the mapped public code/transition;
  an unknown thrown value records only `INTERNAL_FAIL_CLOSED` and returns the
  catch-all disposition without leaking the thrown text;
- the five required counters are emitted at their actual outcome boundaries;
  structured repair, proposal UTF-8 bytes, claim count and render latency are
  recorded exactly once with closed labels.
- coordinator receives a fixture `GroundedDraftGenerationResult` with
  nonzero `repair_attempts` and distinctive `proposal_bytes`, forwards those
  exact values to the recorder, and never substitutes `0`, reserializes the
  proposal or reads provider text; `model_run_id` remains audit-only and is
  never a metric label/log field.

`atomic-grounding.metrics.spec.ts` must enumerate every metric name and label
combination, reject unknown label values/non-finite or negative observations,
and serialize recorded points containing fixture prompt/claim/evidence strings
nearby. The serialized metric points and captured Nest logs must not contain
those strings, workflow/project/claim/evidence IDs, or keys outside the label
allowlist.

- [ ] **Step 5: Run coordinator RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/approved-render-context.service.spec.ts \
  src/citation/atomic-grounding/atomic-grounding-coordinator.service.spec.ts \
  src/citation/atomic-grounding/atomic-grounding.metrics.spec.ts \
  src/content/content.service.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because render-context builder, coordinator and content façade are absent.

- [ ] **Step 6: Implement context builder and coordinator**

`ApprovedRenderContextService.build(job)` must use its injected `DataSource` for
project-scoped reads of the workflow input plus current directory, current
outline and active style-template versions. It turns labels into NFC, attaches
immutable source IDs/versions and validates with the same function later used
during recovery. It must not import `ContentModule`, avoiding the existing
`ContentModule -> CitationModule` dependency becoming circular.

`AtomicGroundingCoordinator.generate()`:

1. Loads sealed assignment and render context.
2. Accepts the ownership-checked `authoring_context` prepared by
   `ContentGenerationService`, without importing content services or
   persisting.
3. Calls `AgentService.generateGroundedDraft()` and retains both
   `generated.proposal` and `generated.audit`.
4. Parses/canonicalizes `generated.proposal`, verifies every atom, and converts failures to revision/material-gap outcomes.
5. Renders and seals only an `ALLOW` result.
6. Records proposal/claim/fail-closed/revision/material-gap/count and
   render-latency points through `AtomicGroundingMetricsRecorder`; repair count
   and proposal bytes come exactly from `generated.audit`.
7. Returns the envelope; it does not access `WorkflowDomainCommitService`.

Refactor `ContentGenerationService` only enough to share its existing project/original/outline/style/retrieval preparation between text and atomic paths. Preserve legacy `generateWorkflowText()` for `strict_citation:false`.

- [ ] **Step 7: Run GREEN and full atomic/gateway regression**

Run:

```bash
(cd backend && npx jest \
  src/agent/chains/grounded-draft.chain.spec.ts \
  src/agent/agent.service.spec.ts \
  src/citation/atomic-grounding \
  src/llm/model-gateway.spec.ts \
  src/content/content.service.spec.ts \
  --runInBand --no-coverage)
(cd backend && npm run build)
git diff --check
```

Expected: all selected suites PASS, existing ModelGateway contract remains green, build PASS, diff check clean.

- [ ] **Step 8: Commit**

```bash
git add \
  backend/src/agent \
  backend/src/llm \
  backend/src/citation \
  backend/src/content
git commit -m "feat: generate sealed structured grounding candidates"
```

---

### Task 5: Off/Shadow Runtime, Sealed Checkpoint Recovery, and Double Commit Guard

**Files:**
- Create: `backend/src/citation/atomic-grounding/atomic-grounding-mode.ts`
- Create: `backend/src/citation/atomic-grounding/atomic-grounding-mode.spec.ts`
- Modify: `backend/src/config/environment.ts`
- Modify: `backend/src/config/environment.spec.ts`
- Modify: `backend/.env.example`
- Modify: `backend/src/workflow/workflow-generation.executor.ts`
- Modify: `backend/src/workflow/workflow-generation.executor.spec.ts`
- Modify: `backend/src/workflow/workflow-domain-commit.service.ts`
- Modify: `backend/src/workflow/workflow-domain-commit-grounding.spec.ts`
- Modify: `backend/src/workflow/worker-workflow.module.ts`
- Modify: `backend/src/workflow/mysql-workflow-execution.store.ts`
- Modify: `backend/src/workflow/workflow-material-gap.spec.ts`
- Create: `backend/test/atomic-grounding-shadow.e2e-spec.ts`
- Create: `backend/scripts/run-atomic-grounding-e2e.mjs`
- Modify: `backend/package.json`
- Create: `docs/operations/atomic-grounding-shadow-rollout.md`

**Interfaces:**
- Consumes: `ContentService.generateAtomicGroundingCandidate()` and `recoverSealedGroundedCandidateV1()` from Tasks 2/4.
- Produces: `type AtomicGroundingMode = 'off' | 'shadow_no_persist'`.
- Produces: `parseAtomicGroundingMode(value: unknown): AtomicGroundingMode`.
- Extends checkpoint phases with:

```ts
interface AtomicSealedCheckpoint extends Record<string, unknown> {
  phase: 'atomic_sealed' | 'atomic_shadow_complete';
  generation_attempt: number;
  revision_attempt: 0 | 1;
  sealed_candidate: SealedGroundedCandidateV1;
}
```

- Produces: `AtomicCommitNotAuthorizedError` with stable internal/public code `ATOMIC_COMMIT_NOT_AUTHORIZED`.
- Changes `WorkflowDomainCommitInput` to a closed union:

```ts
type WorkflowDomainCommitInput =
  | { contract_version: 'legacy:v0'; output: string; directoryNodes?: DirectoryNodeDto[] }
  | { contract_version: 'atomic:v1'; sealed_candidate: SealedGroundedCandidateV1 };
```

Task 10B implements no valid branch for the second member; it always throws before transaction/business writes.
`run-atomic-grounding-e2e.mjs` is the only Task 5 real-MySQL test entrypoint.
It runs one non-skippable E2E file, reads Jest JSON output and exits nonzero
unless `numTotalTests === 6`, `numPassedTests === 6`,
`numPendingTests === 0`, `numFailedTests === 0`, and `success === true`.

- [ ] **Step 1: Write failing mode parser and environment tests**

```ts
expect(parseAtomicGroundingMode('shadow_no_persist')).toBe('shadow_no_persist');
expect(parseAtomicGroundingMode('off')).toBe('off');
expect(parseAtomicGroundingMode(undefined)).toBe('off');
expect(parseAtomicGroundingMode('enforce')).toBe('off');
expect(parseAtomicGroundingMode('SHADOW_NO_PERSIST')).toBe('off');
expect(parseAtomicGroundingMode('unexpected')).toBe('off');
```

`validateEnvironment()` must return the canonical mode rather than reject unknown/enforce. `.env.example` documents only `off|shadow_no_persist`, default `off`, and states Task 10B never persists atomic output.
Table-drive every mode value through `dispositionForAtomicFailure()` and assert
empty/unknown/`enforce` produces
`ATOMIC_GROUNDING_DISABLED / ATOMIC_GROUNDING_UNAVAILABLE /
WAITING_MATERIAL`.

- [ ] **Step 2: Run mode RED**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding/atomic-grounding-mode.spec.ts \
  src/citation/atomic-grounding/failure-policy.spec.ts \
  src/config/environment.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because the parser and typed environment field are missing.

- [ ] **Step 3: Implement the fail-safe mode parser**

Use exact equality only:

```ts
export function parseAtomicGroundingMode(value: unknown): AtomicGroundingMode {
  return value === 'shadow_no_persist' ? 'shadow_no_persist' : 'off';
}
```

No boolean aliases, trimming, case folding or `enforce` branch.

- [ ] **Step 4: Write failing executor shadow/off/recovery/compatibility tests**

Add tests for all content-like workflow types:

- strict + `off`: coordinator/model not called; raises stable material-gap/unavailable error; domain committer not called;
- non-strict + `off`: existing legacy text route runs, but Task 3 ledger cannot authorize support;
- strict + `shadow_no_persist`: coordinator returns sealed envelope; executor emits existing `meta`, fixed-size `token` chunks whose concatenation exactly equals `server_output.text`, `grounding.proposal_validated`, and `done` with `server_saved:false`, empty citations and existing job/result identifiers;
- checkpoint contains full `sealed_candidate` and no provider raw output/naked alternate output;
- after `atomic_sealed` crash, recovery revalidates envelope/current assignment/context, re-emits the same server bytes, performs zero model calls, and never commits;
- digest/assignment/context tamper during recovery enters material gap with no token/done and no commit;
- revision outcome persists stable candidate keys/reason codes, performs at most one targeted retrieval/structured revision, then seals or enters `WAITING_MATERIAL`;
- unknown evidence/empty/invalid structured response never falls back to `generateWorkflowText()`;
- legacy routes/header and SSE event object keys remain accepted by existing bridge tests;
- spy proves `normalizeGeneratedContent()` is not invoked for atomic output.
- first rendered token records
  `grounding_time_to_first_rendered_token_ms{workflow_type}` once; sealed
  recovery and fresh generation both record a finite nonnegative value without
  workflow IDs or output text in labels/logs;
- every Task 5 runtime/recovery/commit failure is table-tested against the
  exact Task 1 public code and transition; unknown caught errors use only
  `INTERNAL_FAIL_CLOSED / ATOMIC_GROUNDING_FAILED / FAILED`.

Use fixed token chunking by UTF-16-safe code-point iteration with maximum 16 KiB UTF-8 per `token`, never split surrogate pairs, and verify concatenated bytes equal render digest input.

- [ ] **Step 5: Run executor RED**

Run:

```bash
(cd backend && npx jest \
  src/workflow/workflow-generation.executor.spec.ts \
  src/workflow/workflow-material-gap.spec.ts \
  src/workflow/workflow-legacy-bridge.service.spec.ts \
  --runInBand --no-coverage)
```

Expected: FAIL because executor always calls text generation followed by `domainCommitter.commit()`, and cannot parse/recover atomic checkpoints.

- [ ] **Step 6: Implement executor first guard and checkpoint recovery**

At the top of content-like execution, compute strictness from job input and canonical mode. Directory/outline remain unchanged. For atomic strict:

1. `off` throws `MaterialGapError('ATOMIC_GROUNDING_DISABLED')`.
2. `shadow_no_persist` recovers a stored envelope or calls the coordinator.
3. Revision/material-gap outcomes use existing store error transitions with candidate keys and stable public codes only.
4. A sealed candidate is checkpointed before token emission.
5. Emit tokens only from `sealed_candidate.server_output.text`.
6. Emit shadow `done` with `server_saved:false`.
7. Record TTFT immediately before the first rendered `token`; the recorder
   receives only workflow type and elapsed milliseconds.
8. Return before the first possible `domainCommitter.commit()` call.

Keep legacy `business_committed`/`done` recovery untouched for directory/outline and explicit non-strict legacy.

- [ ] **Step 7: Write failing commit-boundary unit and real MySQL zero-write tests**

Unit test direct invocation:

```ts
await expect(service.commit(job, {
  contract_version: 'atomic:v1',
  sealed_candidate: candidate,
})).rejects.toMatchObject({
  code: 'ATOMIC_COMMIT_NOT_AUTHORIZED',
});
expect(dataSource.transaction).not.toHaveBeenCalled();
```

Also prove `approved_at` on the job, `ATOMIC_GROUNDING_MODE=enforce`, forged capability fields inside checkpoint/input, or a valid envelope cannot unlock commit.

`atomic-grounding-shadow.e2e-spec.ts` must copy the proven Docker lifecycle
pattern from `migrations.e2e-spec.ts`: `docker run --rm mysql:8.4` on an
ephemeral host port, poll with `mysql2`, create an isolated database, run all
migrations, and always stop the exact generated container in `afterAll`.
It must use plain `describe`, never `describe.skip`, environment gating or an
early return when Docker is unavailable; missing Docker/MySQL is a test
failure. Its exactly six tests must:

1. create job/assignment/retrieval fixtures, execute shadow, crash after sealed
   checkpoint, resume and prove envelope digest/output bytes identical;
2. directly call atomic commit under `approved_at`, misconfigured `enforce`,
   forged capability fields and valid envelope variants; all reject;
3. table-drive assignment/run/index/ingestion/context drift during recovery;
4. prove off/empty/unknown/enforce mode performs no model/coordinator/domain
   write;
5. prove historical `SUPPORTED` reads downgrade and legacy compress parent
   inheritance rejects;
6. prove atomic assignment writes `atomic:v1`, old-binary omitted-column writes
   `legacy:v0`, and both remain snapshot-digest bound.

After every test, query the isolated database and expect exact zero counts from
all five tables:

```sql
SELECT
  (SELECT COUNT(*) FROM workflow_domain_commits) AS domain_commits,
  (SELECT COUNT(*) FROM writing_results) AS writing_results,
  (SELECT COUNT(*) FROM content_versions) AS content_versions,
  (SELECT COUNT(*) FROM grounding_claims) AS grounding_claims,
  (SELECT COUNT(*) FROM citation_maps) AS citation_maps
```

Where a historical citation fixture is needed, insert it inside a transaction
that is rolled back before the five-table assertion.

`run-atomic-grounding-e2e.mjs` invokes Jest with
`--runInBand --json --outputFile=<unique os.tmpdir file>`, forwards Jest
stdout/stderr, validates the exact six-test/no-skip fields above, then deletes
only its own report file. Add package script
`"test:e2e:atomic-grounding": "node scripts/run-atomic-grounding-e2e.mjs"`.

- [ ] **Step 8: Run commit-guard RED**

Run:

```bash
(cd backend && npx jest \
  src/workflow/workflow-domain-commit-grounding.spec.ts \
  --runInBand --no-coverage)
(cd backend && npm run test:e2e:atomic-grounding)
```

Expected: unit suite FAIL because atomic input is accepted; E2E command FAIL
because the non-skippable six-test suite/runner is absent or because any target
table is written. A skipped suite cannot satisfy the runner.

- [ ] **Step 9: Implement the independent commit guard**

`WorkflowDomainCommitService.commit()` checks the discriminant before `findCommitted()`, grounding preparation or transaction creation:

```ts
if (input.contract_version === 'atomic:v1') {
  throw new AtomicCommitNotAuthorizedError();
}
```

Do not inspect environment, `approved_at`, checkpoint fields or candidate validity to relax this rule. Task 10B has no capability provider, so there is no success branch. Legacy calls must pass `{contract_version:'legacy:v0', output,...}` explicitly. This guard remains effective even if executor code regresses.

Create `docs/operations/atomic-grounding-shadow-rollout.md` with the exact
metric names, label allowlists and copyable aggregate queries for:

- proposal status/rate by schema/workflow type;
- claim verdict/method rate;
- fail-closed and material-gap rate by exact reason;
- revision required/sealed/exhausted rate;
- structured repair rate;
- p50/p95 proposal bytes, claim count, render latency and
  time-to-first-rendered-token.

The artifact must state that workflow/project/claim/evidence IDs and
prompt/claim/evidence text are forbidden metric labels/log fields. Queries use
only the low-cardinality labels defined in Task 4.

- [ ] **Step 10: Run targeted GREEN, full backend verification, and static boundary scans**

Run:

```bash
(cd backend && npx jest \
  src/citation/atomic-grounding \
  src/citation/grounding-verifier.spec.ts \
  src/citation/citation-ledger.service.spec.ts \
  src/citation/citation.service.spec.ts \
  src/citation/sql-grounding-evidence.store.spec.ts \
  src/agent/chains/grounded-draft.chain.spec.ts \
  src/llm/model-gateway.spec.ts \
  src/workflow/workflow-generation.executor.spec.ts \
  src/workflow/workflow-domain-commit-grounding.spec.ts \
  src/workflow/workflow-material-gap.spec.ts \
  src/workflow/workflow-legacy-bridge.service.spec.ts \
  --runInBand --no-coverage)
(cd backend && npm run test:e2e:atomic-grounding)
(cd backend && npm run test:e2e -- migrations.e2e-spec.ts --runInBand)
(cd backend && npm test -- --runInBand)
(cd backend && npm run build)
(cd backend && npm run lint:check)
if rg -n --glob '!*.spec.ts' --glob '!*.test.ts' \
  "authoring-commit-capability|GroundedApprovalEnvelope|approval_digest|case ['\\\"]enforce" \
  backend/src backend/migrations; then
  echo "unexpected Task 11 implementation reference" >&2
  exit 1
fi
if rg -n --glob '!*.spec.ts' --glob '!*.test.ts' \
  "parseVisibleOutput|extractVisibleStatements|splitCoordinatedPropositions|SemanticGroundingReviewer" \
  backend/src/citation/atomic-grounding \
  backend/src/agent/chains/grounded-draft.chain.ts; then
  echo "unexpected legacy authority dependency" >&2
  exit 1
fi
for metric in \
  grounding_proposal_total \
  grounding_claim_total \
  grounding_fail_closed_total \
  grounding_revision_total \
  grounding_material_gap_total \
  grounding_structured_repair_total \
  grounding_proposal_bytes \
  grounding_proposal_claim_count \
  grounding_render_latency_ms \
  grounding_time_to_first_rendered_token_ms; do
  rg -q "$metric" docs/operations/atomic-grounding-shadow-rollout.md || exit 1
done
git diff --check
```

Expected:

- targeted/full Jest, migration E2E and the self-hosted atomic MySQL E2E PASS;
- atomic E2E JSON reports exactly 6 passed, 0 pending/skipped and 0 failed;
- build and lint PASS;
- first boundary scan returns no Task 11 implementation references in
  production sources while explicitly excluding `*.spec.ts|*.test.ts`;
- second authority scan returns no matches in production atomic
  modules/structured chain while architecture tests remain free to name the
  forbidden symbols;
- diff check emits no output.

- [ ] **Step 11: Commit**

```bash
git add \
  backend/src/citation/atomic-grounding/atomic-grounding-mode.ts \
  backend/src/citation/atomic-grounding/atomic-grounding-mode.spec.ts \
  backend/src/config \
  backend/.env.example \
  backend/src/workflow \
  backend/test/atomic-grounding-shadow.e2e-spec.ts \
  backend/scripts/run-atomic-grounding-e2e.mjs \
  backend/package.json \
  docs/operations/atomic-grounding-shadow-rollout.md
git commit -m "feat: shadow atomic grounding without persistence"
```

---

## Final Acceptance Gate

After all five task commits, run from repository root:

```bash
(cd backend && npm test -- --runInBand)
(cd backend && npm run test:e2e:atomic-grounding)
(cd backend && npm run test:e2e -- migrations.e2e-spec.ts --runInBand)
(cd backend && npm run build)
(cd backend && npm run lint:check)
if rg -n --glob '!*.spec.ts' --glob '!*.test.ts' \
  "authoring-commit-capability|GroundedApprovalEnvelope|approval_digest|case ['\\\"]enforce" \
  backend/src backend/migrations; then
  echo "unexpected Task 11 implementation reference" >&2
  exit 1
fi
if rg -n --glob '!*.spec.ts' --glob '!*.test.ts' \
  "parseVisibleOutput|extractVisibleStatements|splitCoordinatedPropositions|SemanticGroundingReviewer" \
  backend/src/citation/atomic-grounding \
  backend/src/agent/chains/grounded-draft.chain.ts; then
  echo "unexpected legacy authority dependency" >&2
  exit 1
fi
git diff --check
git status --short
```

Expected: all commands pass; the self-hosted MySQL runner reports exactly six
passed and zero skipped/pending; both production-only negative scans exclude
`*.spec.ts|*.test.ts`, produce no match and exit successfully;
`git status --short` is empty. Inspect the five commits and
confirm each is independently reviewable:

1. deterministic contracts/schema/canonical JSON/quantity lexer/verifier;
2. renderer/sealed envelope/recovery/revision invariants;
3. additive migration/legacy fail-closed/read and compress downgrade;
4. structured ModelGateway proposal/coordinator;
5. off/shadow runtime/checkpoint plus executor and commit double guard.

## Self-Review Result

- **Spec coverage:** Complete. Task 1 covers schema/version limits, canonical JSON, the exact exhaustive failure policy, server field recomputation, quantity lexer, exact/typed verifier, no-mosaic and all listed attacks. Task 2 covers server-owned render bytes, UTF-16 offsets, IDs, six digests, full envelope, tamper recovery and revision invariants. Task 3 covers migration defaults/backfill/partial retry, destructive-rollback refusal, fixed safe-binary floor, legacy authorization cap, public read downgrade and atomic-only compress inheritance. Task 4 covers the existing ModelGateway structured buffer/one repair/audit integration, sealed evidence/context, coordinator outcomes and low-cardinality metrics. Task 5 covers fail-safe mode parsing, checkpoint/recovery, SSE exact bytes, executor stop, independent commit refusal, TTFT, rollout queries and a non-skippable self-hosted MySQL zero-write proof.
- **Scope boundary:** Clean. No task creates capability provider, approval parser/envelope, `enforce` branch, positive atomic domain commit, Task 11 graph, approval transition or atomic compress persistence. References to Task 11 artifacts appear only in constraints/negative scans explaining what must remain absent.
- **Placeholder scan:** Clean. Every task names exact files, interfaces, RED command and expected failure, minimal implementation, GREEN/regression command and commit message; no deferred implementation language remains.
- **Type consistency:** Clean. `ModelGateway.complete()` returns
  `ModelCompletionAudit`; `grounded-draft.chain` maps it without loss into
  `GroundedDraftGenerationResult`; `AgentService` returns that exact result;
  coordinator consumes `proposal` and records the exact
  `repair_attempts/proposal_bytes` audit values. `GroundedDraftProposal` then
  flows to verifier/coordinator, `AtomicVerificationResult` flows to
  renderer/sealer, and only `SealedGroundedCandidateV1` enters checkpoint or
  the always-rejected atomic commit union. Version/property names, UTF-16
  offset suffixes, `candidate_claim_key`, `persisted_claim_id`, digest names
  and `atomic:v1|legacy:v0` discriminants are consistent across all five tasks.
- **Command executability:** Clean. Every backend command runs in its own
  `(cd backend && ...)` subshell, so sequential paste never reaches
  a nested backend directory. Both absence scans use explicit
  `if rg; then exit 1; fi` and exclude `*.spec.ts|*.test.ts`, so architecture
  tests can assert forbidden symbol names without tripping production gates;
  all fenced bash blocks pass shell syntax validation. The atomic MySQL command
  fails unless exactly six tests pass with zero pending/skipped.
- **Residual concern:** `shadow_no_persist` necessarily buffers structured output before first rendered token, so time-to-first-token increases. The plan preserves SSE shape and exact bytes while exposing latency/repair/material-gap metrics; any decision to enable positive persistence remains a separate Task 11 review.

## Independent Review Resolution Record

| Review item | Resolution in this plan |
|---|---|
| C1 destructive migration rollback | Task 3 `down()` now performs no DDL/DML and throws `ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN`; real MySQL asserts both columns, migration record and data survive. `legacy-grounding-fail-closed.v1` is the exact rollback floor documented by a tested constant and runbook. |
| I1 skipped MySQL proof | Task 5 no longer depends on conditional `workflow.mysql.spec.ts`. A dedicated E2E starts `mysql:8.4`, cannot skip, runs exactly six tests, and queries `workflow_domain_commits`, `writing_results`, `content_versions`, `grounding_claims`, and `citation_maps` for zero rows. Its runner rejects any pending/skipped test. |
| I2 non-copyable/overbroad commands | Every backend command is an independent subshell. Root scans use repository-qualified paths, expected absence is asserted with explicit shell control flow, and both production gates exclude `*.spec.ts|*.test.ts`; architecture-test strings therefore cannot create false failures. |
| I3 observability and repair audit chain | Task 4 defines a closed metrics recorder with the five required counters plus repair/bytes/count/render-latency/TTFT observations and secret-label tests. `ModelCompletionAudit -> GroundedDraftGenerationResult -> AgentService -> coordinator` preserves real repair count, response bytes and final model-run ID; the coordinator records repair/bytes only from that audit. Task 5 wires runtime TTFT and adds the rollout query/dashboard artifact. |
| I4 open-ended reason codes | Task 1 owns one exact 39-member tuple/type and exhaustive disposition function, including `NO_HIT`, four model gap codes, assignment/evidence/render/recovery/revision/runtime failures and `INTERNAL_FAIL_CLOSED`. Tasks 1, 4 and 5 table-test internal reason, public code and workflow transition. |
