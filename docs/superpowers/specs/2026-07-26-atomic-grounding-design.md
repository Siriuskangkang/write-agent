# 原子化 Grounding 设计

日期：2026-07-26
状态：已批准方向的实现设计
范围：Task 10B；为 Task 11 提供严格 grounding 节点契约，不实现工作流图

## 1. 决策摘要

严格放行链路废弃“从模型自由文本中切句、猜测连接词边界、再推断命题”的做法。
正文、改写、扩写和精简在 strict 模式下必须通过现有 `ModelGateway` 的
`structured` response mode 返回 `GroundedDraftProposal`。模型显式提出原子声明、
声明字段、证据 ID 和渲染顺序；服务端校验 JSON Schema、证据 allowlist、字段与
原文的一致性，使用不切句、不拆协调结构的确定性 canonicalizer 逐条核验，最后由
服务端渲染正文并计算持久化 claim ID、全局 offset 和 ledger。

strict v1 的安全边界是：

1. 自由文本 parser、连接词 splitter、bigram 相似度和 semantic reviewer **均无权**
   产生 `SUPPORTED`。
2. 每条 atom 的每个 evidence ID 必须独立支持整条 atom；禁止把多个不完整证据拼成
   一个事实。
3. 渲染器只接受 `claim_ref` 和服务端 allowlist 中的结构引用，不接受模型提供的
   任意 literal fragment。这样未登记事实无法从“过渡句”或注释旁路进入可见正文。
4. 旧自由文本和旧 marker 继续可读、可通过现有 API 返回，但只能得到
   `UNVERIFIABLE`/`UNSUPPORTED`；non-strict 可显式
   `ALLOW_WITH_UNSUPPORTED`，strict 必须 fail closed。
5. Task 10B 生产模式只有 `off` 和 `shadow_no_persist`。只有 Task 11 提供
   `authoring-commit-capability.v1`、验真 digest-bound approval envelope，且 commit
   边界二次校验通过后，才存在 `enforce`。环境变量未知值一律解析为 `off`。

这是一个保守 MVP：它优先消灭错误放行，接受更多 material gap 和较弱的行文衔接。
不引入 LangGraph、通用自治 Agent 或外部中文 NLP 依赖。

## 2. 现状证据与失败样本

### 2.1 已核对的真实接口

- `ModelGateway` 已支持 `response_mode: 'structured'`、
  `StructuredOutputSchema<T>.parse()`、buffered validation、一次定向 repair、
  provider/network retry、usage/cost 和 `model_runs` 审计。无需新增模型 SDK。
- 当前 content/rewrite/expand/compress 仍由 `AgentService.generateStream()` 调用
  text mode，模型输出可见 Markdown 和
  `<!-- claim_evidence:{...} -->` marker。
- `GroundingVerifier.verify()` 当前先执行 `parseVisibleOutput()` 和
  `extractVisibleStatements()`，再由 `comparePropositions()`、
  `splitCoordinatedPropositions()`、数量/否定/量词规则和词面相似度推断支持关系。
- 现有稳定 evidence ID 已绑定 retrieval run、chunk、exact absolute offsets 和
  exact-span digest；`SqlGroundingEvidenceStore` 已有 ownership、active ingestion、
  multi-run、legacy ID 歧义、assignment digest、commit-time `FOR UPDATE` 重验。
  新方案复用这些能力。
- `CitationLedgerService.prepare()` 是 content 类任务 domain commit 前的 gate；
  `WorkflowDomainCommitService` 在同一事务中写 writing result、content version、
  grounding claims、citation maps 和 workflow domain commit。
- 持久工作流已有 `REVISION_REQUIRED`、`WAITING_MATERIAL`、
  `WAITING_APPROVAL`、cancel/resume、lease/fencing 和 checkpoint；旧
  `/directory|outline|content/...` SSE 路由已由 `WorkflowLegacyBridgeService`
  代理到持久工作流，并返回 `X-Workflow-Job-Id`。

### 2.2 为什么第五轮启发式修复仍不能承重

Task 10 在五轮修复中依次补过 exact span、semantic 降级、数量/单位、否定、协调
结构、量词、comparator、stable evidence ID、multi-run revision 和 legacy
collision。最终独立复审仍为 `Spec compliance: FAIL`，因为“删除协调词后两边都可
解析”并不能证明该字符真的是连接词。

以下样本在最终复审中都错误得到 strict `ALLOW / SUPPORTED /
deterministic_proposition_entailment`：

| claim | evidence | 不可接受原因 |
|---|---|---|
| `系统支持并网运行。` | `系统支持，网运行` | 删除术语“并网”的首字符“并” |
| `系统支持和田基地运行。` | `系统支持，田基地运行` | 删除实体“和田”的首字符“和” |
| `系统支持与会人员使用。` | `系统支持，会人员使用` | 删除术语“与会”的首字符“与” |
| `系统支持及格率提高。` | `系统支持，格率提高` | 删除指标“及格率”的首字符“及” |

之前复审还稳定复现过：

- `甲容量为300MW和乙容量为400MW` 被
  `甲容量为400MW和乙容量为300MW` 支持；
- `不是所有系统都可以运行` 被 `所有系统都不能运行` 支持；
- `建设周期为1年` 被 `建设周期为1年半` 或 `1年以上` 支持；
- `完成比例为50%` 被 `完成比例为50%以上` 支持；
- `项目已完成` 被 `项目已完成一半` 支持。

这些不是保守误拒，而是会把错误事实写入教材的承重错误。继续扩大连接词、实体、
量词和谓词词典只会把开放世界中文语义伪装成可穷举规则。

## 3. 方案比较

### 方案 A：继续修中文启发式

做法是为当前 `splitCoordinatedPropositions()` 增加词法边界、实体保护、更多量词和
谓词规则。

优点：

- 改动最小，保留流式自由文本；
- 当前单测和 ledger 数据模型可直接复用。

缺点：

- 连接词是否属于实体无法靠局部字符规则证明；
- 每修一个攻击样本都可能创造新的删除、合并或作用域错误；
- 测试只能证明有限样本，不能给 strict gate 提供闭世界保证；
- 五轮修复后的 Critical 证明该路线已不适合承重。

结论：拒绝作为 strict 放行方案。可保留少量 parser 只做 legacy 展示和降级诊断，
但它永远不能返回 `SUPPORTED`。

### 方案 B：通用 NLP 或第二个 LLM 判定

做法是引入中文分词、依存句法/语义角色标注，或让 reviewer LLM 判断 claim 是否由
evidence 支持。

优点：

- 对自然中文、同义改写和长句更宽容；
- 比项目内手写连接词表有更高召回率。

缺点：

- 外部中文 NLP 仍是概率模型，版本、词典和领域漂移会改变放行结果；
- LLM reviewer 可受 prompt injection、模型错误、成本和供应商故障影响；
- 语义判断不可作为事务内可重放的确定性授权；
- 增加新的运行时依赖、延迟和运维面，不符合本项目最小可行约束。

结论：不作为授权源。未来可以作为只降级、不升级的 advisory signal；其输出不得
改变 strict `SUPPORTED`。

### 方案 C：原子结构声明（推荐）

模型在一次 structured response 中显式列出 atom、字段、evidence IDs 和 render
plan。服务端不再从成品自由文本发现命题，而是验证模型提交的闭合对象。

优点：

- claim 边界由 schema 明示，不再消费或删除中文连接字符；
- evidence allowlist、字段、渲染、offset 和持久化均可确定性重放；
- 失败能定位到具体 claim ID，直接驱动 targeted retrieval/revision；
- 复用现有 ModelGateway、assignment snapshot、ledger 和 workflow 状态机；
- 无外部 NLP 依赖。

代价：

- structured output 必须完整缓冲，legacy SSE 首个 `token` 会晚于当前 text stream；
- v1 对同义改写非常保守，会增加 material gap；
- 为杜绝 prose 偷渡事实，strict v1 行文只由 atoms 和服务端结构片段组成，可能较
  生硬。

结论：选择方案 C。上述代价属于可观测、可逐版扩展的可用性问题，不是错误放行。

## 4. 精确数据契约

### 4.1 Schema 版本和基本限制

首版 schema ID 固定为 `grounded-draft.v1`，JSON Schema 使用
`additionalProperties: false`。限制：

- 每份 proposal 最多 500 条 claims、2,000 个 render fragments、4 MiB UTF-8；
- `claim_text` 最多 1,000 UTF-8 字节，禁止换行、控制字符和 Markdown fence；
  Markdown/HTML-like 文本（包括 comment-like 字节）只能作为待转义的普通数据；
- 每条 claim 绑定 1 到 3 个唯一 evidence IDs；
- 所有 ID 均有长度上限和安全字符正则；
- 所有 offset 使用 JavaScript/DOM 一致的 UTF-16 code unit，区间为
  `[start, end)`。

### 4.2 `AtomicClaimProposal`

```ts
type Polarity = 'affirmed' | 'negated';

type Quantifier =
  | 'plain'
  | 'all'
  | 'none'
  | 'not_all'
  | 'not_none'
  | 'some'
  | 'other';

type Comparator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'approx' | 'range';

type QuantityDimension =
  | 'count'
  | 'ratio'
  | 'duration'
  | 'power'
  | 'energy'
  | 'currency'
  | 'length'
  | 'mass'
  | 'temperature'
  | 'other';

interface QuantityProposal {
  quantity_id: string;       // proposal 内唯一，例如 q1
  surface: string;           // claim_text 中唯一、逐字匹配的数量表达
  start_utf16: number;
  end_utf16: number;
  dimension: QuantityDimension;
  value: string;             // 十进制定点字符串，不允许指数形式
  unit: string | null;       // 原始单位；无单位数量为 null
  comparator: Comparator;
  range_end: string | null;  // comparator=range 时必填，否则必须为 null
}

interface SurfaceAnchorProposal {
  surface: string;
  start_utf16: number;
  end_utf16: number;
}

interface AtomicClaimProposal {
  proposal_claim_id: string; // proposal 内局部 ID，例如 c1；不持久化为 claim_id
  revision_of_candidate_claim_key: string | null;
  claim_text: string;        // 一条可见 atom，包含结束标点
  span: {
    fragment_id: string;     // 必须指向唯一 claim_ref fragment
    start_utf16: 0;          // v1 atom 占满自己的 fragment
    end_utf16: number;       // 必须等于 claim_text.length
  };
  subject: SurfaceAnchorProposal;
  predicate: SurfaceAnchorProposal;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: QuantityProposal[];
  evidence_ids: string[];
}
```

字段语义：

- `proposal_claim_id` 只解决一次模型返回中的引用。模型无法选择 candidate key 或
  数据库主键。
- `revision_of_candidate_claim_key` 仅在 targeted revision schema 中允许非 null，
  且必须属于服务端给出的待修订 candidate-key allowlist。非目标 claim 必须为 null。
- `subject`/`predicate` 明确只是模型指出的 **surface anchors**，不声称服务端已经
  证明其语法或语义角色。服务端只验证 `[start,end)` 精确切出 `surface`、非空且
  两个 anchor 不重叠；它们不能单独授权 `SUPPORTED`。
- `polarity`、`quantifier`、quantity 的 value/unit/dimension/comparator 都是模型
  proposal，不是可信结论。服务端依据 claim_text 中的闭合词法和 quantity
  `surface` 独立重算；不一致即拒绝。
- `some`/`other` 可以表达模型无法归入闭合 enum 的语义，但 v1 只有全文 extractive
  等价时可支持；不得走 typed normalization。

现有稳定 evidence ID
`evidence:<sha256(run + chunk + absolute span + span digest)>` 原样复用。旧
`legacy:*` ID 只在 assignment loader 能证明唯一 run 和唯一完整 snapshot digest
时可引用；跨 run/candidate/span 歧义继续 fail closed。

### 4.3 Render fragments 与 ordering

```ts
type RenderFragmentProposal =
  | {
      fragment_id: string;
      kind: 'claim_ref';
      claim_id: string; // AtomicClaimProposal.proposal_claim_id
      presentation: 'sentence' | 'bullet' | 'ordered_item';
    }
  | {
      fragment_id: string;
      kind: 'structure_ref';
      structure_id: string; // 服务端 ApprovedRenderContext 的 allowlisted ID
      presentation: 'heading_1' | 'heading_2' | 'heading_3' | 'column';
    }
  | {
      fragment_id: string;
      kind: 'separator';
      token: 'space' | 'line_break' | 'paragraph_break';
    };

interface GroundedDraftProposal {
  schema_version: 'grounded-draft.v1';
  status: 'draft' | 'material_gap';
  claims: AtomicClaimProposal[];
  render_fragments: RenderFragmentProposal[];
  ordering: string[]; // 每个 fragment_id 恰好出现一次
  material_gap: null | {
    reason_code:
      | 'NO_EVIDENCE'
      | 'INSUFFICIENT_EVIDENCE'
      | 'AMBIGUOUS_EVIDENCE'
      | 'UNSUPPORTED_QUANTIFIER';
    missing_topics: string[];
  };
}
```

不提供 `literal` fragment。`structure_ref` 只能引用服务端根据项目、当前目录/大纲和
体例模板建立的 `ApprovedRenderContext`，模型不能提交 heading/column 的自由文本。
renderer 按 `ordering` 解析结构引用、插入固定 Markdown 前缀和分隔符，再插入完整
`rendered_claim_text`。每条 claim 必须且只能被一个 `claim_ref` 使用。

`atomic-renderer.v1` 保留现有 column UI，但严格区分控制面和数据面：

- 只有 renderer 可根据 sealed、allowlisted `structure_id` 生成固定
  `<!-- column:<label> -->` 和 `<!-- paragraph_key:pN -->` control comments；
- context label 必须 NFC、无 CR/LF/control/`<`/`>`/`--` 且不超过 200 UTF-8 bytes，
  否则 render fail closed；模型、claim 和 evidence 中出现的 comment 字节永远不会
  原样进入 control position；
- model `claim_text` 被当作 plain text。`escape-plain-text.v1` 对 NFC source 从左
  到右扫描：若 code point 属于 ASCII punctuation ranges
  `U+0021..U+002F`、`U+003A..U+0040`、`U+005B..U+0060` 或
  `U+007B..U+007E`，就在该字符前插入一个 ASCII backslash；其他 code point
  原样复制。原始 backslash 因位于该集合中也只被前缀一次，不做二次 pass；
  `rendered_claim_text` 是转义后的确切 bytes，写入 canonical claim，且全局
  offsets 指向它；
- Markdown heading、bullet、ordered item 和 paragraph/column controls 只由
  `presentation` 与 renderer 生成。模型不能提交 raw Markdown/HTML。

因此“禁止 HTML comment”精确指 **禁止模型/evidence 提供控制 comment**，不禁止
renderer 自己发出上述两类固定 control token。

`status='material_gap'` 时 `claims`、`render_fragments` 和 `ordering` 必须为空；
`material_gap` 必填。`status='draft'` 时相反。模型 material gap 是信号，不会直接
持久化项目状态；服务端验证结果才是状态转换依据。

### 4.4 模型提出与服务端权威字段

| 字段 | 模型提出 | 服务端行为 |
|---|---:|---|
| schema version | 是 | 只接受部署 allowlist 中的精确版本 |
| proposal claim/quantity/fragment IDs | 是 | 校验局部唯一；不直接持久化为权威 ID |
| claim text、局部 span | 是 | NFC/限制校验；renderer 后重算全局 UTF-16 offsets |
| subject、predicate surface anchors | 是 | 按 offset 精确校验；只作审计 anchor，不声称语法语义 |
| polarity、quantifier | 是 | 用闭合词法在该 atom 内重算；不切句、不猜连接词 |
| quantity value/unit/dimension/comparator | 是 | 从唯一 surface 独立解析为 base value/unit 和 bounds |
| evidence IDs | 是 | 必须属于 sealed assignment allowlist 和 active snapshot |
| render fragments/order | 是 | 仅接受 union 中三类；服务端确定实际可见字节 |
| persistent claim ID、normalized text、output offsets | 否 | 服务端计算 |
| support status/score/method | 否 | 服务端计算；模型字段中不存在 |
| retrieval run、source、rank/score、snapshot digest | 否 | 从数据库 sealed snapshot 读取并在 commit 重验 |

摘要编码和 sealed candidate 的精确定义见 4.5、4.6；不得用未版本化的临时
`JSON.stringify()` 或实现者自选 Unicode normalization 替代。

### 4.5 固定 canonical encoding 与 claim identity

所有参与 ID/digest 的字符串固定做 **Unicode NFC**；NFKC 不参与 v1 identity，
因为它可能折叠有意义的兼容字符。`canonical-json.v1` 精确定义为：

1. 递归删除 `undefined`（数组中禁止出现），拒绝非有限数字和非普通对象；
2. 所有对象 key 按 JavaScript UTF-16 code unit 升序排列；
3. 数组保留契约声明的顺序；set-like 数组必须先按各自规则排序后才能编码；
4. JSON number 只允许 safe integer，使用无前导零十进制；数量值、score 和可能超出
   safe integer 的值都使用规范十进制字符串；
5. 字符串先 NFC，再使用 `JSON.stringify` 的标准 escaping；输出无空白的 UTF-8；
6. digest 一律为 `sha256(version_tag + "\0" + canonical_utf8)` 小写 hex。

`CanonicalAtomicClaimV1` 的精确 shape 为：

```ts
interface CanonicalTextAnchorV1 {
  surface_nfc: string;
  start_utf16: number;
  end_utf16: number;
}

interface CanonicalQuantityV1 {
  ordinal: number;                 // 按 start_utf16 升序，连续从 0 开始
  surface_nfc: string;
  start_utf16: number;
  end_utf16: number;
  dimension: QuantityDimension;
  base_value: string;              // 无指数、去多余前导/尾随零，负零写 "0"
  base_unit: string | null;
  comparator: Comparator;
  range_end_base_value: string | null;
  typed_equivalence_eligible: boolean;
}

interface CanonicalAtomicClaimV1 {
  canonical_claim_version: 'canonical-atomic-claim.v1';
  candidate_claim_key: string;
  source_claim_text_nfc: string;
  rendered_claim_text: string;
  subject_anchor: CanonicalTextAnchorV1;
  predicate_anchor: CanonicalTextAnchorV1;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: CanonicalQuantityV1[];       // start_utf16 升序
  evidence_ids: string[];                  // Unicode code-unit 升序、唯一
  fragment: {
    ordinal: number;
    presentation: 'sentence' | 'bullet' | 'ordered_item';
    previous_structure_id: string | null;
    next_structure_id: string | null;
  };
  revision: {
    attempt: 0 | 1;
    revision_of_candidate_claim_key: string | null;
  };
}
```

model proposal ID、provider attempt、score、rank 和全局 output offset 不属于
canonical claim JSON。verifier contract version、evidence snapshot digests 和全局
offset 属于 ledger/envelope。

初稿中服务端按 claim fragment ordinal 生成与全局 offset 无关的稳定 key：

```text
candidate_claim_key =
  sha256("candidate-claim-key.v1\0" +
         workflow_job_id + "\0" +
         generation_attempt + "\0" +
         initial_claim_fragment_ordinal)
```

targeted revision 必须复用目标的 `candidate_claim_key`；最终 render 后才生成数据库
claim ID：

```text
persisted_claim_id =
  sha256("persisted-claim-id.v1\0" +
         workflow_job_id + "\0" +
         verifier_version + "\0" +
         render_digest + "\0" +
         canonical_claim_json + "\0" +
         output_char_start + "\0" + output_char_end)
```

因此目标长度改变可移动后续 offsets 和 persisted IDs，但不会改变 candidate 内
revision allowlist。

### 4.6 `SealedGroundedCandidate`

Task 10B 的唯一成功产物是下面的 versioned checkpoint envelope，不是裸 output：

```ts
interface SealedEvidenceSnapshotV1 {
  evidence_id: string;
  retrieval_run_id: string;
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string | null;
  exact_span_text_nfc: string;
  exact_span_document_start: number | null;
  exact_span_document_end: number | null;
  candidate_rank: number;
  scores: {
    sparse: string | null;
    dense: string | null;
    fusion: string;
    rerank: string;
  };
  ranks: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  index_snapshot: Record<string, unknown>;
  evidence_snapshot_digest: string;
}

interface SealedApprovedRenderContextV1 {
  context_version: 'approved-render-context.v1';
  entries: Array<{
    structure_id: string;           // 升序
    source_kind: 'workflow_input' | 'directory' | 'outline' | 'style_template';
    source_id: string;
    source_version: string;
    label_nfc: string;
    presentation: 'heading_1' | 'heading_2' | 'heading_3' | 'column';
  }>;
}

interface SealedClaimV1 {
  candidate_claim_key: string;
  persisted_claim_id: string;
  canonical_claim: CanonicalAtomicClaimV1;
  output_char_start_utf16: number;
  output_char_end_utf16: number;
  support_status: 'SUPPORTED';
  support_score: '1';
  verification_method: 'atomic_extract_exact' | 'atomic_typed_equivalent';
  evidence_refs: Array<{
    evidence_id: string;             // 升序
    evidence_snapshot_digest: string;
  }>;
  non_target_invariant_digest: string;
}

interface SealedGroundedCandidateV1 {
  envelope_version: 'sealed-grounded-candidate.v1';
  contract_version: 'atomic:v1';
  schema_version: 'grounded-draft.v1';
  canonical_json_version: 'canonical-json.v1';
  canonicalizer_version: 'atomic-canonicalizer.v1';
  quantity_lexer_version: 'quantity-lexer.v1';
  plain_text_escape_version: 'escape-plain-text.v1';
  renderer_version: 'atomic-renderer.v1';
  verifier_version: 'atomic-verifier.v1';
  workflow: {
    workflow_job_id: string;
    project_id: string;
    workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
    generation_attempt: number;
    revision_attempt: 0 | 1;
  };
  canonical_proposal: GroundedDraftProposal; // 经 NFC、去未知字段并按下述规则排序
  render_context: SealedApprovedRenderContextV1;
  server_output: {
    text: string;                     // renderer 产生的唯一持久化 bytes
    utf8_byte_length: number;
    utf16_length: number;
  };
  claims: SealedClaimV1[];            // output start 升序
  evidence_snapshots: SealedEvidenceSnapshotV1[]; // evidence_id 升序
  digests: {
    proposal_digest: string;
    render_context_digest: string;
    render_digest: string;
    assignment_digest: string;
    ledger_digest: string;
    envelope_digest: string;
  };
}
```

摘要输入固定如下：

- `proposal_digest`：完整 `canonical_proposal`；
- `render_context_digest`：完整 `render_context`；
- `render_digest`：`renderer_version + "\0" + server_output.text` 的 UTF-8；
- `assignment_digest`：沿用数据库 sealed assignment digest，并加入
  `contract_version`；
- `ledger_digest`：claims（含 canonical claim、最终 IDs/offsets/verdict/method、
  evidence refs）按 output start 排序后的 canonical JSON；
- `envelope_digest`：除 `digests.envelope_digest` 本身外的完整 envelope canonical
  JSON。

checkpoint 必须保存完整 envelope；事件只暴露 IDs/digests。crash recovery 重新解析
envelope、重算全部局部 digest、重新读取 assignment/evidence snapshots，并要求
`envelope_digest` 不变。只有 digest 不能代替完整 envelope。

`canonical_proposal` 的数组规则固定为：`ordering` 保留模型声明的 render 顺序；
`render_fragments` 按其在 `ordering` 中的 ordinal 排序；`claims` 按对应
claim fragment ordinal 排序；每条 claim 的 `quantities` 按 `start_utf16` 排序，
`evidence_ids` 按 UTF-16 code unit 升序去重。除此以外不得实现者自行排序。

## 5. 确定性验证规则

### 5.1 Canonicalizer 的允许范围

`AtomicGroundingVerifier` 接收已通过 schema 的 atoms；它**不会**扫描渲染成品发现
claims，不会按 `和/与/及/并/但/而/、` 拆分，也不会删除连接字符。

每个 atom 必须先经过 `recomputeAtomV1()`，之后才允许选择 support method：

1. 对 `claim_text` 做 NFC；只统一 CRLF（schema 实际禁止换行）、ASCII/全角空格并裁剪
   首尾空白和一个末尾句号类标点。不做 NFKC，不删除内部标点或任意字符。
2. 按 proposal offset 精确重取 subject/predicate surface anchors；越界、重叠或
   surface 不一致均为 contract invalid。anchors 只用于审计，不参与语义授权。
3. 用闭合 polarity/quantifier lexer 在整条 atom 上重算 enum，并要求等于 proposal。
   多个互相冲突 occurrence、无法唯一归类或 `some/other` 均标记 exact-only。
4. 用 `quantity-lexer.v1` 扫描 claim **全部**数量 occurrences。每个 occurrence 包含
   `[start_utf16,end_utf16)`、surface、dimension、base value/unit、comparator 和
   range end；按 start 升序。其 cardinality、顺序、offset、surface 和 canonical
   values 必须与 proposal 一一一致，不能忽略额外数字。
5. v1 不做 subject/predicate 同义词、实体别名、连接词或任意非数量词归一化。

即使 claim 与 evidence 字节完全相同，字段重算失败也不能得到 `SUPPORTED`，不能把
模型伪造的 canonical fields 写入 `atomic_claim`。

`quantity-lexer.v1` 只识别已有测试覆盖的阿拉伯/中文数字、万/亿倍率、百分比、
W/kW/MW/GW、Wh/kWh/MWh/GWh、年/月和已列货币单位，以及紧邻 comparator。它不做
命题、主语或谓词解析。evidence exact span 也由它扫描全部 occurrences，并保留原始
UTF-16 offsets。

typed comparison 先把 claim/evidence 的全部 quantity occurrences 按顺序替换为
`__Q0__`、`__Q1__`……，要求：

- 数量 cardinality 和 ordinal 完全相同；
- polarity/quantifier 闭合 lexer 结果相同；
- 除 quantity occurrences 外的 NFC skeleton byte-for-byte 相同；
- 每对 quantity 的 dimension、base value/unit、comparator 和 range end 完全相同。

evidence 多出、少一个或调整数量顺序均 fail closed。`approx`、`range`、
`dimension='other'`、`quantifier='some|other'` 在 v1 没有严格集合语义，只能走
full extract exact，禁止进入 typed equivalence。

### 5.2 产生 `SUPPORTED` 的唯一条件

每个 evidence ID 都先经过现有 ownership、run、selected candidate、exact offset、
active ingestion、legacy collision 和 snapshot digest 检查。随后该 evidence 的
**完整 exact span** 必须独立满足以下之一：

- `atomic_extract_exact`：atom 已通过全部 server field recomputation，随后 claim 与
  exact span 只做 NFC、空格和末尾标点规则后完全相等；
- `atomic_typed_equivalent`：atom 已通过全部 server field recomputation，claim 与
  exact span 再通过 5.1 的 quantity cardinality/order/non-quantity skeleton 和
  canonical quantity 全等规则。

一条 claim 的所有已列 evidence IDs 都必须独立通过；不得用 evidence A 支持主语、
evidence B 支持数量。任一个不通过，整条 claim 为 `UNSUPPORTED` 或
`UNVERIFIABLE`。strict proposal 中所有 claims 都通过且至少有一条 claim，整个
proposal 才是 `ALLOW`。

原子路径的 verdict 固定为：

| 情况 | status | score |
|---|---|---:|
| 每个 evidence 都通过 exact 或 typed equivalent | `SUPPORTED` | 1 |
| schema 合法但 canonical claim 与 evidence 不等价 | `UNSUPPORTED` | 0 |
| 字段无法唯一重算、legacy snapshot 歧义或 contract 不完整 | `UNVERIFIABLE` | 0 |

atomic strict 不产生 `PARTIAL`。该状态只为历史/non-strict DTO 兼容保留。

明确禁止的升级源：

- `parseVisibleOutput()`、`extractVisibleStatements()`、
  `splitCoordinatedPropositions()` 或任何自由文本 parser；
- bigram、embedding、reranker 或字符串相似度；
- semantic reviewer/第二次 LLM 判断；
- 模型自报 `support_status`、score、offset 或 retrieval metadata。

advisory reviewer 仍可把初步 `PARTIAL` 降为 `UNSUPPORTED`，但在 atomic strict
结果中无升级用途。

## 6. 数据流

```text
sealed retrieval assignment
  -> evidence allowlist + ApprovedRenderContext
  -> ModelGateway.complete(response_mode=structured,
                           schema=grounded-draft.v1)
  -> JSON Schema/runtime parse (最多一次 targeted repair)
  -> proposal limits / ID / graph validation
  -> evidence allowlist + ownership + active snapshot validation
  -> server canonicalize each declared atom and each exact span
  -> per-atom deterministic verdict
  -> server-only renderer
  -> recompute global offsets, persistent claim IDs, ledger/digests
  -> seal SealedGroundedCandidate in checkpoint
  -> Task 10B shadow_no_persist STOP (event/checkpoint only)
  -> [Task 11 capability] validate/review/repair/approval
  -> [Task 11] transaction: lock + reverify + exact-byte domain/ledger persist
```

structured output 由 `ModelGateway` 缓冲，所以 strict path 不再把 provider 的原始
delta 直接发给客户端。验证和渲染成功后，executor 将服务端渲染文本按固定大小分块
产生现有 `token` events；`meta`、`token`、`done/error`、`X-Workflow-Job-Id` 和
legacy SSE data shape 保持不变。新 workflow event 可额外发送
`grounding.proposal_validated`、`grounding.material_gap`，旧客户端会忽略未知事件。

checkpoint 保存完整 `SealedGroundedCandidateV1`，而不是若干 digest 加裸 output。
恢复时从 envelope 重算 proposal/render context/render/ledger/envelope digests，并
重新核对 assignment/evidence snapshot。provider 原始自由文本不进入权威 checkpoint。

`server_output.text` 是 SSE token 拼接、checkpoint 和未来数据库正文的唯一 bytes。
`atomic-renderer.v1` 已包含全部 newline/plain-text/control normalization；atomic
commit 禁止再调用 `normalizeGeneratedContent()` 或任何后处理。

## 7. Strict、legacy 与迁移

### 7.1 行为矩阵

| 模式 | 输入 | `SUPPORTED` 权限 | Task 10B 产物 |
|---|---|---|---|
| `atomic_strict_v1` | `GroundedDraftProposal` | 仅 AtomicGroundingVerifier | 全部 atoms 通过时只 seal candidate；不 commit |
| `legacy_fail_closed` | 旧 Markdown/markers | 无 | material gap/稳定错误；不 commit |
| non-strict legacy | 旧 Markdown/markers | 无 | 可显式 `ALLOW_WITH_UNSUPPORTED`；与 atomic candidate 无关 |

现有 public DTO 的 `strict_citation` 保留：`!== false` 映射
`atomic_strict_v1`，`false` 映射 non-strict legacy。服务端在
`grounding_assignments.contract_version` 持久化 `atomic:v1` 或 `legacy:v0` 并
纳入 snapshot digest，不能由模型改变。

Task 10B 的 runtime mode parser 只认识：

- `off`：不生成 atomic candidate；
- `shadow_no_persist`：可生成/恢复 sealed candidate 和发观测事件，但 executor 必须
  在 domain commit 前停止。

空值、`enforce` 和任何未知值在 Task 10B binary 中都解析为 `off`。Task 11 才能扩展
`enforce`，且必须同时检测到 `authoring-commit-capability.v1` provider；单独设置环境
变量没有效果。

### 7.2 API 兼容

- 保留现有 workflow REST、legacy generation routes、SSE event 名称、停止接口、
  citation list 和 citation-ledger 响应字段；
- 首版不要求修改 public citation DTO；schema/contract 先保存在内部 ledger，
  evidence IDs 和现有响应字段不改名；
- public read adapter JOIN claim assignment：只有
  `contract_version='atomic:v1'`、合法非 null `atomic_claim` 且 verifier version
  allowlisted 时才返回 persisted support。缺任一条件时，无论旧列存的是
  `SUPPORTED` 还是何种 method，都在响应层 cap 为
  `UNVERIFIABLE / score=0 / legacy_unverifiable`；
- 旧 `claim_evidence` marker parser 仅用于读取/展示旧结果和 non-strict 诊断，输出
  status 上限是 `UNVERIFIABLE`；
- strict structured validation 失败时绝不 fallback 到 text mode。

### 7.3 分阶段迁移

1. **先切断授权**：发布 `legacy_fail_closed`，确保自由文本 parser 无
   `SUPPORTED` 代码路径；严格旧请求进入 material gap，而不是继续危险放行。
2. **加法迁移**：`grounding_assignments.contract_version VARCHAR(...) NOT NULL
   DEFAULT 'legacy:v0'`；migration 显式 backfill 旧行并验证无 null。atomic writer
   必须显式写 `atomic:v1`。`grounding_claims.atomic_claim JSON NULL` 保存 canonical
   claim + versions；旧行保持 null。proposal/render/ledger/envelope digests 保存在
   完整 checkpoint，成功提交后复制到现有 `workflow_domain_commits.commit_payload`，
   不新增独立表。
3. **继承收紧**：compress inheritance SQL 只接受父 assignment
   `contract_version='atomic:v1'`、非 null 且版本合法的 `gc.atomic_claim`、
   `gc.support_status='SUPPORTED'` 和完整 evidence refs。legacy parent 一律 material
   gap；Task 11 才增加 atomic compress 的正向 persist。
4. **shadow_no_persist**：在 staging/生产 shadow job 生成和恢复 envelope，记录
   verdict/latency/material-gap rate；executor/commit 负向 gate 保证零 domain commit。
5. **Task 11 enforce**：先 content，再 rewrite/expand，最后 compress；每阶段必须有
   capability + approval envelope + commit 二次校验，并复用旧 API bridge。
6. **清理**：稳定后删除 prompt 中的 marker 生成要求和 strict path 对旧 parser 的
   调用；保留只读 legacy adapter。

migration 回归必须覆盖 fresh/current、DDL 部分失败重跑、旧 binary 省略新列 insert
得到 `legacy:v0`、历史 `SUPPORTED` 读取降级、atomic writer 显式 version、legacy
compress 拒绝。安全 rollback 的最低版本必须已包含 `legacy_fail_closed` read/write
adapter；禁止回滚到旧 parser 仍有授权的 binary。

## 8. Revision、material gap、approval 与 persist

### 8.1 Revision

- schema/runtime/局部 span/render graph 错误由 `ModelGateway` 最多做一次 structured
  repair；仍失败为非重试 `STRUCTURED_OUTPUT_INVALID`，不能当作 supported draft。
- grounding 不足沿用一次 targeted retrieval/revision。错误对象携带 server
  `candidate_claim_key`、source claim text 和 reason code。
- revision prompt 得到旧 proposal、待修订 claim allowlist 和合并后的 old/new
  evidence allowlist。替换 claim 必须填写 `revision_of_candidate_claim_key`，且目标
  一对一替换，不能增加、删除或重排 claims。
- 每个 claim 的 `non_target_invariant_digest` 固定为
  `sha256("non-target-invariant.v1\0" + canonical-json.v1({candidate_claim_key,
  canonical_claim_without_revision, evidence_refs, fragment_ordinal,
  presentation, previous_structure_id, next_structure_id}))`。非目标 digest 必须逐项
  不变；目标必须保持 candidate key、fragment ordinal/presentation 和相邻 structure
  refs，只允许 source/canonical text、字段和 evidence refs 改变。
- revision 完成后重新 render，可重新计算所有 offset-based persisted claim IDs。
  后续非目标因目标长度变化而移动 offset 不算篡改。
- 第二次仍有不足进入 `WAITING_MATERIAL`，不得再次循环或降级提交。

### 8.2 Material gap

以下任一情况进入 material gap：NO_HIT、assignment 缺失/漂移、unknown evidence、
legacy ambiguity、unsupported atom、无法重算字段、render graph 不闭合、空 strict
draft。事件只暴露稳定 reason code 和 claim IDs；不向客户端泄露 prompt、provider
原始输出或内部 source content。

补充素材后的现有 `/resume` 行为继续删除旧 assignment 和 checkpoint，重新检索并
从头生成 atomic proposal。旧 approval 不可复用。

### 8.3 与 Task 11 的边界

Task 10B 负责：

- structured schema、atomic canonicalization/verification；
- server render、claim IDs/offsets、candidate ledger 和 digests；
- revision/material-gap 的 grounding 原因。

Task 11 负责：

- `access -> snapshot -> plan retrieval -> retrieve -> evidence gate ->
  draft -> validate -> review -> repair(max 2) -> approval -> persist` 的节点和转换；
- schema/domain/style/consistency validator；
- directory/outline 人工批准，以及 content/rewrite/expand/compress 在接受前保持
  draft；
- job lease、cancel、recovery、approval API 和 transactional persist 编排。

grounding 成功只产生 sealed candidate draft，**不等于批准或持久化**。approval
必须产生：

```ts
interface GroundedApprovalEnvelopeV1 {
  approval_version: 'grounded-approval.v1';
  capability_version: 'authoring-commit-capability.v1';
  workflow_job_id: string;
  project_id: string;
  candidate_envelope_digest: string;
  proposal_digest: string;
  render_context_digest: string;
  render_digest: string;
  assignment_digest: string;
  ledger_digest: string;
  schema_version: 'grounded-draft.v1';
  canonicalizer_version: 'atomic-canonicalizer.v1';
  plain_text_escape_version: 'escape-plain-text.v1';
  renderer_version: 'atomic-renderer.v1';
  verifier_version: 'atomic-verifier.v1';
  approved_by: string;
  approved_at: string;
  approval_nonce: string;
  approval_digest: string; // canonical-json.v1 of all previous fields
}
```

Task 11 capability provider 和 approval parser 都存在、全部 digest/version 与当前
sealed candidate 精确相等，才可解锁 `enforce`。Task 10B 可以落
schema/verifier/renderer/envelope 和 `shadow_no_persist`，但不能调用即时 commit。

### 8.4 事务边界

Task 10B 先在 `WorkflowDomainCommitService` 建立第二道负向门禁：
`contract_version='atomic:v1'` 时若 capability 不存在或 approval envelope 不合法，
抛 `ATOMIC_COMMIT_NOT_AUTHORIZED`；当前 `approved_at` 时间戳不满足条件。Task 10B
binary 没有 capability provider，因此所有 atomic commit 都被拒绝，即使环境变量误
配为 `enforce`。

Task 11 的最终 commit API 接收
`commit(job, sealedCandidate, approvalEnvelope)`，不接受可替换的裸
`output: string`。最终 persist 在一个 MySQL 事务中：

1. `FOR UPDATE` 锁 workflow job、grounding assignment、全部 referenced retrieval
   runs/candidates/index snapshots；
2. 校验 lease/fencing、capability、approval envelope/digest 和 cancellation；
3. 从 checkpoint envelope 与锁定行重算 canonical proposal、render context、
   server output、claims/evidence snapshots 及全部六个 digests；
4. 重新运行同版本 renderer，要求产物与 `server_output.text` byte-for-byte 相同；
   禁止调用 `normalizeGeneratedContent()` 或其他 mutator；
5. 写入 `writing_results.content_text`、`content_versions.content_text` 的参数必须是
   同一个 `server_output.text`，insert 前再次比较 UTF-8 byte length/render digest；
6. 写 domain version/result、`grounding_claims`、`citation_maps`、
   `workflow_domain_commits`；
7. 只有全部成功才把版本设为 current/accepted 并提交。

任何漂移整体回滚。模型调用和 advisory review 不在持锁事务内执行。

## 9. 安全、可观测性与成本

### 安全

- evidence material 视为不可信数据，prompt 中明确分隔；其内容不能改变 schema、
  allowlist 或 render context；
- schema `additionalProperties: false`、对象/数组/字符串/总字节上限防止资源耗尽；
- 禁止模型/evidence comment 和任意 literal fragment 获得控制权；只允许 renderer
  从 allowlisted structure 生成 4.3 的固定 control comments；
- ownership、project/result scope、stable evidence identity、active ingestion、
  run state 和 snapshot digest 沿用现有检查；
- persistent claim ID、offset、support status 和 scores 均由服务端生成；
- revision 和 approval 使用 allowlist + digest，防 TOCTOU、越权替换和旧批准重放；
- public error 只返回稳定 code；详细原因进入受控日志。

### 可观测性

新增低基数 metrics：

- `grounding_proposal_total{schema,status,workflow_type}`；
- `grounding_claim_total{method,verdict,workflow_type}`；
- `grounding_fail_closed_total{reason,workflow_type}`；
- `grounding_revision_total{outcome}`；
- `grounding_material_gap_total{reason}`；
- structured repair rate、proposal bytes、claim count、render latency、
  time-to-first-rendered-token。

日志记录 workflow ID、schema ID、proposal/render/assignment digest、claim ID 和
reason code；默认不记录 raw prompt、原始 evidence、claim text 或 provider raw
output。现有 `model_runs` 继续记录 provider/model、attempt、usage、cost、latency 和
prompt hash。

设置 structured request 的 max output token 和 worst-case cost；未知价格、缺 usage
或超预算不能触发额外 reviewer。atomic verifier 本身无模型成本。

## 10. 分阶段 TDD 测试矩阵

先写 RED，再实现最小 GREEN。测试必须直接调用真实 schema parser、renderer 和
AtomicGroundingVerifier，不能 mock 掉承重逻辑。

### 10.1 Task 10B 必须通过

| 层 | 必测内容 |
|---|---|
| schema | unknown version、extra property、空 draft、超限、重复 ID、悬空 claim/fragment、错误 ordering、错误局部 span、非法 material-gap union |
| allowlist | foreign project/run、未 selected evidence、unknown ID、inactive ingestion、offset 漂移、run state 漂移、legacy ID 跨 run/span 冲突 |
| canonical fields | exact 分支也必须先重算；anchor offset/surface、polarity/quantifier、全部 quantity occurrence 的 cardinality/order/offset/value/unit/comparator 不一致均拒绝 |
| quantity lexer | claim/evidence 均返回全部带 offset occurrences；额外/缺失/换序数量拒绝；非数量 skeleton 不同拒绝；approx/range/other 只能 full exact |
| attack regression | 本文四个“并网/和田/与会/及格”样本全部不可能 `SUPPORTED`；主体数量/极性交换、`不是所有`/`所有都不`、`1年`/`1年半`、`50%`/`50%以上`、`已完成`/`完成一半` 均拒绝 |
| positive grounding | exact extract；`0.3GW`/`300MW`、`12个月`/`1年`、`50%`/`0.5`、`超过300MW`/`大于300MW` 在完整 skeleton 相等时通过；相邻错误值和 `>=`/`>` 边界拒绝 |
| no mosaic | 两个 evidence 各支持半条 claim 仍拒绝；多 evidence 中任一个无关则整条拒绝 |
| renderer | 无 literal；只有 server-owned column/paragraph comments；model/evidence comments 与 Markdown/HTML 被 plain-text escape；每条 claim 恰好一次；CRLF 输入拒绝或在 seal 前唯一转换为 LF，首尾空白、`&nbsp;`、math wrapper、HTML-like text、emoji/扩展 Unicode 的 sealed bytes/digest/UTF-16 offsets 稳定 |
| envelope | canonical-json/version 排序与数值编码 golden vectors；所有六类 digest 和 envelope digest tamper tests；完整 checkpoint crash/recovery 重算；只剩 digest 或裸 output 必须拒绝 |
| revision | candidate key 在目标长度变化后稳定；非目标 invariant digest 不变；增删/重排/改非目标/evidence/structure neighbor 均拒绝；最终 persisted IDs 可随 offsets 重算 |
| authority | 用 spy/architectural test 证明 atomic strict 不调用旧 parser/splitter/semantic reviewer；模型提交 support score/status 被 schema 拒绝 |
| gateway | structured buffer、一次 repair、terminal invalid 不盲重试、取消、超时、usage/cost、raw delta 不外发 |
| no-persist gate | `off` 不生成；`shadow_no_persist` 只写 envelope checkpoint/event；空值/unknown/误配 `enforce` 均为 off；executor 不调用 domain committer；直接传 atomic candidate 到 commit 得 `ATOMIC_COMMIT_NOT_AUTHORIZED`，数据库无 domain commit |
| compatibility | 旧 routes/header/SSE shape、citation DTO；legacy parser 永不 `SUPPORTED`；strict 不 fallback；旧 persisted `SUPPORTED` 经 public read adapter 强制降级；legacy compress parent 拒绝 |
| migration/MySQL | `contract_version NOT NULL DEFAULT legacy:v0` 的 fresh/current/partial-DDL retry/旧 binary omit-column insert；旧数据保留且 read cap；atomic writer 显式 version；rollback 最低安全版本 |

### 10.2 Task 11 才执行

| 层 | 必测内容 |
|---|---|
| capability/approval | 只有 `authoring-commit-capability.v1` 解锁 enforce；approval envelope 全字段/digest/version/owner 校验；任一 candidate/context/ledger/assignment/version 改变使 approval 失效 |
| exact-byte commit | commit 只接 sealed candidate + approval；renderer 固定输出 LF，篡改为 CRLF 的 candidate 被拒绝；空白、`&nbsp;`、math wrapper、HTML-like text、emoji 的 SSE 拼接、checkpoint、数据库两份 content、render digest 和 offsets byte-for-byte 相同；atomic path 不调用 normalizer |
| transaction | commit 前 run/candidate/index/ingestion/context 漂移整体回滚；writing result 与 ledger 不可部分写入；lease/fencing/cancel 生效 |
| workflow/race | validate/review/repair(max 2)、WAITING_APPROVAL、批准、恢复、取消、并发 approval/resume/commit 和 digest invalidation |
| compress positive | 只从 atomic supported parent 继承；multi-run revision -> compress -> exact-byte persist |
| end-to-end | legacy bridge 和新 workflow API 的 content/rewrite/expand/compress 全路径、真实 MySQL rollback、build/lint/full Jest |

## 11. 分阶段验收标准

### 11.1 Task 10B 退出条件

1. atomic strict 生产代码中不存在从自由文本 parser、连接词 splitter、lexical
   similarity 或 semantic reviewer 到 `SUPPORTED` 的可达路径。
2. 本文列出的所有承重攻击通过真实 verifier 均不能得到 `ALLOW`；将字符 splitter
   恢复到旧实现也不会影响 atomic strict，因为它不在调用图中。
3. 每个 sealed candidate 可从 envelope 重建 schema/contract/tool versions、
   canonical claims、render context、server output/UTF-16 offsets、evidence
   snapshots、ledger 和全部 digests；crash recovery 重算一致。
4. renderer 输出中每个非 allowlisted structure 的可见正文字符都属于且只属于一条
   verified claim；column/paragraph comment 只可能来自 renderer。
5. strict invalid/unsupported/empty/unknown evidence 一律 revision 或
   `WAITING_MATERIAL`，绝不自动转 legacy 继续提交。
6. legacy public API 和历史 ledger 可用；历史行不会被升级为 atomic
   `SUPPORTED`。
7. candidate-stable key 与 offset-based persisted ID 分离；targeted revision 最多
   一次，非目标 invariant 和 old/new run refs 正确。
8. Task 10B runtime 只有 off/shadow_no_persist；任何 atomic candidate 在 executor/
   commit 负测中都**绝不产生 domain commit**。
9. migration 默认/回填/read cap/legacy compress 拒绝和安全 rollback 回归通过。
10. backend targeted/full Jest、build、lint:check、migration E2E 和
   `git diff --check` 全部通过；既有 warning 必须与基线一致或更少。
11. rollout dashboard 能按 reason 定位 fail-closed、repair、revision、material-gap
    和 latency，不记录敏感正文/素材。

### 11.2 Task 11 生产 enforce 退出条件

1. capability + digest-bound approval envelope 是 enforce 的必要条件，commit 边界
   二次验证，现有裸 `approved_at` 无效。
2. transaction 从 sealed candidate 和锁定行重算全部内容；persisted content 是
   renderer 的 exact bytes，claim offsets round-trip。
3. 每条 persisted claim 可追到版本、canonical atomic JSON、evidence snapshot 和
   approved envelope；任一漂移整体回滚。
4. directory/outline/content 的 review/approval 语义、并发 race、atomic-only
   compress 和完整端到端回归通过。

## 12. 非目标

- 不在本任务实现 Task 11 的通用工作流图或替换现有状态机；
- 不引入 LangGraph、自治工具调用、多 Agent 编排；
- 不引入 jieba、HanLP、LTP、依存句法或外部中文 NLP 服务；
- 不解决任意中文同义改写、常识推理、跨证据综合或数学证明；
- 不改变 hybrid retrieval、evidence ID 生成或 GB/T 7714 renderer；
- 不把目录/大纲的非事实结构强行纳入正文 atomic ledger；
- 不在 v1 恢复 provider 原始 token 的实时转发；
- 不删除历史 marker、citation 或 legacy 数据。

## 13. 回滚策略

Task 10B 只使用 `ATOMIC_GROUNDING_MODE=off|shadow_no_persist` 分 workflow type
控制：

- `shadow_no_persist`：生成并验证 sealed candidate，只写 checkpoint/观测事件；
- `off`：关闭 atomic 生成时，strict 请求 fail closed 到
  `WAITING_MATERIAL`/稳定不可用错误；non-strict 可走 `legacy_fail_closed`；
- 空值、未知值和 `enforce` 一律解析为 `off`。Task 11 的 `enforce` 还必须同时具备
  capability provider 和当前 digest-bound approval，不能靠环境变量单独开启。

回滚只回滚可用性，不回滚安全边界：任何 flag 都不得重新赋予自由文本 parser
`SUPPORTED` 权限。数据库迁移只做加法：新增带 `legacy:v0` 默认值的非空
`contract_version` 和 nullable `atomic_claim`，不 drop/重写旧数据；旧二进制若需
短时回退必须依赖默认值并忽略新列，由入口开关停止 strict authoring jobs。已验证和
已持久化的 atomic ledger 保持只读可用，未批准 proposal 留在 checkpoint，不自动
提交。

## 14. 已知疑虑

- strict structured response 缓冲会增加 time-to-first-token；兼容层只能保留事件
  shape，无法同时保留 provider delta 的实时性。需要用指标验证可接受延迟。
- v1 不允许任意 prose fragment，也不做 subject/predicate 同义归一化，正文可能更
  短、更接近素材原句，material-gap 率会升高。这是有意的 fail-closed 取舍。
- `some/other` 量词和跨 evidence 综合暂不具备 typed support。真实教材若高频需要，
  应以新 schema version 和新攻击集扩展，不能在 v1 canonicalizer 中临时加启发式。

## 15. 独立审查逐项回应

| 审查项 | 设计修订与可验证落点 |
|---|---|
| C1 runtime hard gate | 1、6、7.1、8.3/8.4、10.1、11.1、13 明确 Task 10B 只有 `off`/`shadow_no_persist`，未知值及误配 `enforce` 均为 `off`；executor 在 commit 前停止，commit service 再拒绝无 capability/approval 的 atomic candidate；Task 10B 测试要求数据库零 domain commit。 |
| C2 完整 sealed envelope | 4.5/4.6 定义 versioned `SealedGroundedCandidateV1`，包含 canonical proposal/claims、render context、唯一 server output、UTF-16 offsets、完整 evidence snapshots、全部工具版本与六类 digest；checkpoint 保存完整 envelope，恢复时逐项重算。 |
| C3 persisted bytes 唯一来源 | 4.3、4.6、6、8.4 固定 `server_output.text` 为 SSE/checkpoint/未来数据库的唯一 bytes；Task 11 commit 只接 sealed candidate + approval，重跑 renderer 并 byte compare，禁止 `normalizeGeneratedContent()`。 |
| I1 server recomputation | 4.4、5.1/5.2 要求每个 atom 在 exact/typed 分支前都通过 `recomputeAtomV1()`；模型不能提供权威 verdict、score、offset 或 retrieval metadata。 |
| I2 quantity lexer | 4.2、5.1、10.1 固定 claim/evidence 全 occurrence + UTF-16 offset 扫描、cardinality/order/non-quantity skeleton 精确相等；approx/range/other 与开放量词仅允许 full exact。 |
| I3 canonicalization/versioning | 4.3、4.5、4.6 固定 NFC、canonical JSON、数值编码、plain-text escaping 及 canonicalizer/renderer/verifier/lexer versions；subject/predicate 仅是 surface anchors。 |
| I4 candidate/persisted identity | 4.5、8.1 分离稳定 candidate key 与含最终 offsets 的 persisted claim ID；revision 复用 candidate key，并以 exact invariant digest 约束非目标结构。 |
| I5 migration/read/compress | 7.2/7.3、10.1、11.1 固定 `contract_version NOT NULL DEFAULT 'legacy:v0'`、public read cap、atomic-only compress inheritance，以及 fresh/current/partial retry/旧 binary/rollback 回归。 |
| I6 column UI compatibility | 4.3 仅允许 renderer 从 sealed allowlist 生成固定 column/paragraph comments；模型/evidence 只按普通数据处理，Markdown/HTML/control position 均不可注入。 |
| I7 staged tests/acceptance | 10、11 分开 Task 10B 与 Task 11：前者验证无 domain commit、envelope/recovery/迁移；后者才验证 capability/approval/exact-byte persist/race/enforce。 |

保留并强化了原设计的七条安全性质：atomic strict 与旧
parser/splitter/semantic reviewer 物理隔离；每个 evidence 独立支持整条 atom、禁止
mosaic；模型不能提交 literal/status/score/offset/retrieval metadata；strict
structured invalid 不回退 text；legacy support 上限为 `UNVERIFIABLE`，non-strict
只能显式 `ALLOW_WITH_UNSUPPORTED`；ownership/selected/active/multi-run/exact
offset/`FOR UPDATE` commit-time revalidation 保留；攻击矩阵继续覆盖四个连接字符删除
样本、数量/极性/量词/范围、authority spy 与真实 MySQL rollback。
