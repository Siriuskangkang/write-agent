# Task 10 实施报告：可核验 Claim-evidence Ledger

基线：`3a8452b`
Round 2 修复基线：`698c07d`
分支：`codex/full-optimization`
日期：2026-07-26

## 严格 grounding

- 先从输出中移除全部控制注释，再按可见文本生成稳定 offset。每个
  `claim_evidence` marker 必须紧邻、唯一且完整匹配上一条可见声明；无 marker 的
  其余事实句统一写为 `UNVERIFIABLE`，strict 模式禁止提交。
- 支持判断只使用已持久化的 exact evidence span，不再使用 chunk 其他位置补证。
  实体、否定、阿拉伯/中文数值、单位、比例和时间矛盾均为 deterministic veto。
  词面相似度只能得到 `PARTIAL`，不能直接得到 `SUPPORTED`。
- semantic reviewer 只能降级 deterministic verdict 或补充 `PARTIAL` 原因，绝不
  将 `PARTIAL`/`UNSUPPORTED` 升级为 `SUPPORTED`。strict 放行只来自
  deterministic exact/normalized entailment；北京/上海等未被实体正则识别的专名
  替换也无法借语义模型越权。未知价格、worst-case 预估超预算、缺失 usage 或实际
  费用超预算时，语义结果不会参与判断。
- quantity verifier 先做量纲和值规范化：支持千分位、负数/小数、W/kW/MW/GW、
  Wh/kWh/MWh/GWh、年/月、比例/%/百分之和中文复合大数，并用相对容差比较。
  否定按子句作用域和奇偶性比较，`并非不能运行` 与 `可以运行` 可确定性等价。
- Markdown fence 控制行和 heading 作为结构跳过；fence 内事实及 table data row
  在 strict 模式仍必须绑定 marker，语言名和 table header 不再误判为 claim。
- content/rewrite/expand/compress 缺少 grounding assignment 时 fail closed。
  compress 从父正文继承已提交 ledger，并重新验证当前 active evidence。
- prompt 示例从真实 evidence allowlist 动态渲染。NO_HIT 不展示虚构 ID，只输出
  结构化 material-gap 信号。

## 快照、事务和状态机

- 迁移 `1713310000000-HardenGroundingWorkflow` 为
  `grounding_assignments` 与 `citation_maps` 增加 SHA-256 snapshot digest。
  两个 ALTER 均以 `hasColumn` 防护，真实 MySQL 注入“第一条 DDL 已提交、第二条
  失败”后可原地重跑。新迁移 `1713320000000-AddGroundingRevisionRunRefs` 保存
  revision assignment 的 sealed old/new retrieval run refs。
- assignment digest 绑定 strict mode、完整 evidence ID 集合、全部 run refs 和真实
  terminal run states，以及每个 assigned evidence 的 exact span、候选 rank/score、
  active ingestion 和 run-index snapshot。
- ledger 与正文在同一事务提交前，以 `FOR UPDATE` 锁定 assignment 和全部真实
  retrieval runs，并重新加载所有 assigned candidates（包括最终正文未引用者）和
  index snapshot 后重算 digest。run state、exact-span JSON、rank/score、index
  version、strict mode、evidence IDs 或 active ingestion 任一漂移都会整体回滚。
- assignment 只保存数据库锁定行的 terminal retrieval state；加载时要求 run state
  与 assignment state 完全一致。
- 新增可执行 `REVISION_REQUIRED` 状态和可恢复 checkpoint：
  unsupported claims → 一次定向检索 → 受约束重写 → 再次完整 grounding。定向
  检索不再覆盖原 assignment，而是合并 old/new run refs 和 evidence IDs；已支持
  claim 的旧 marker 保持 allowlisted，仅待修订 claim 使用新证据。
  attempt 在 MySQL 中原子地从 0 递增为 1；第二次仍失败进入
  `WAITING_MATERIAL`，不会回到 `SUCCEEDED`。
- worker 重启可从 revision checkpoint 恢复；补充素材后可调用 resume 清理旧
  assignment 并重新排队，取消覆盖 queued/running/revision/waiting-material 状态。

## 引用 API、导出和权限

- citation list、citation ledger 和 material-gap 均先校验项目 owner，再校验
  `projectId + resultId`。他人项目返回 403，资源不属于当前项目返回 404。
- 新增 `GET /api/projects/:projectId/content/:resultId/citation-ledger`，返回白名单 DTO、
  稳定 GB/T 7714 编号、同一 source 去重和 claim → reference links。
- Markdown/DOCX 导出接入同一 ledger renderer，保留稳定编号、参考文献和关联声明；
  不再只在孤立单测中调用 formatter。

## 测试与验证

- Backend full Jest：75 suites / 570 tests passed；4 suites / 48 tests 按环境跳过。
- Real MySQL 8.4 migration E2E：40/40 passed。
  - fresh/current migration chain 与 schema/entity drift；
  - 旧 citation 保留；
  - 171331 部分 DDL 自动提交失败后的无人工恢复重跑；
  - assignment digest 封存后，未被正文引用的 assigned candidate 漂移仍导致正文和
    ledger 事务回滚；
  - 一个已支持 claim + 一个不支持 claim 完整经过 targeted retrieve → rewrite →
    full reverify → transaction commit，旧/新证据均保留；
  - revision → worker recovery → attempt 用尽 → WAITING_MATERIAL → resume → cancel，
    并以两个真实并发 resume 请求验证仅一个进入 QUEUED、事件只写入一次。
- Real MySQL + Redis 双用户 ownership E2E：6/6 passed，覆盖 citation list 和
  material-gap 的 403/404。
- Backend build：passed。
- `lint:check`：0 errors；31 个既有 warnings。
- `git diff --check`：passed。

## 剩余边界

- 可见声明 coverage 使用确定性中文标点/行结构切分，不等同于通用自然语言事实抽取；
  当前策略以误拒绝优先，无标点长段可能被当作一条完整声明。Markdown table 目前以
  data row 为最小声明，不拆分单元格级 claim。
- semantic review 的预算按单次 worst-case 与实际 usage 校验；若未来允许同一任务多次
  语义复核，还应增加工作流级原子累计预算。

## Round 3：命题级证据关系与跨检索继承

- 删除无边界 substring 和整句否定奇偶的 `SUPPORTED` 路径。claim 与 exact
  evidence 先按标点及连接词拆为 proposition，再逐项匹配 subject、predicate、
  polarity、quantity dimension/value 和 comparator/range；每个 claim proposition
  都必须找到同关系 evidence proposition 才能放行。无法可靠确定的表达最多进入
  `PARTIAL`/`UNVERIFIABLE`。
- 封堵主语与否定作用域互换、`1年`/`1年半`、`1年`/`1年以上`、
  `50%`/`50%以上`、`已完成`/`已完成一半` 的 strict 误放行。
- 数量词法将万/亿倍率与物理、货币单位分离，支持
  `1.23亿元 = 一亿二千三百万元`、`3万kW = 30MW`、
  `1.2亿kWh = 一亿二千万千瓦时`、`50% = 比例0.5`，并保留维度、数值和范围
  不兼容 veto。
- 新 evidence ID 为 SHA-256 稳定引用，绑定 retrieval run、chunk、exact absolute
  offsets 与 exact-span digest。同一 run/span 重复生成得到同一 ID；同一 chunk 的
  不同 run 或不同 exact span 得到不同 ID，因此 revision 合并不再静默覆盖旧证据。
  API 字段继续使用 `evidence_id`，已有短 ID 仍可读取；旧 ID 若在多个 run 中冲突则
  fail closed 并要求重新检索。
- compress 继承从每条 citation map 的真实 `retrieval_run_id` 重建 multi-run
  assignment，不再把全部 evidence 绑定到父 assignment 的主 run。真实 MySQL 回归
  已贯穿 revision → transaction commit → compress inherit → full reverify →
  transaction commit，并验证最终 citation maps 同时保留 old/new run。
- Round 3 fresh verification：相关 7 suites / 76 tests、Backend full Jest
  581 passed（48 个环境测试跳过）、真实 MySQL 8.4 migration E2E 40/40、build
  通过、`lint:check` 0 errors / 31 个既有 warnings、`git diff --check` 通过；
  测试容器已清理。

## Round 4：协调命题、量化否定与旧证据歧义

- 协调结构现在按 `和/与/及/以及`（同时覆盖 `、/并`）拆为独立 proposition，
  每条 proposition 分别绑定 subject、predicate、polarity 与至多一个 quantity。
  同一主体映射可跨顺序和谓词同义表达匹配；值关系允许后一分句继承省略的
  `value` predicate。主体间数量或极性交换会确定性判为 `UNSUPPORTED`，不再把
  quantity/polarity 当无序集合。
- 增加显式 quantifier 类型：`all / not_all / none / not_none / plain`。
  `不是所有/并非全部/并非没有/没有任何` 会先提取量词，再在对应
  subject-predicate scope 内比较 polarity。无法可靠建模的“部分/有些/某些”等
  量词表达最多进入 `PARTIAL`，不会借全句否定奇偶得到 `SUPPORTED`。
- assignment loader 不再让主 run 静默覆盖同名证据。相同 evidence ID 只有在
  retrieval run 与完整 evidence snapshot digest 都相同时才去重；跨 run、candidate
  或 exact span 的旧 ID 冲突会 fail closed。新稳定 evidence ID 的正常加载和
  multi-run compress 路径保持不变。
- comparator 同时从关系前缀和数值前后缀规范化，覆盖
  `至少为/至多为/不低于/不高于/不少于/不超过/超过/低于/约等于`，并验证
  equality、strict bound、compatible bound 与 conflicting bound。
- RED 复现了协调主体交换被放行、量化否定被误等价、常用 comparator 语序误拒和
  legacy ID 主 run 覆盖。GREEN 后 citation 定向测试 88/88 通过。
- 最终验证：Backend full Jest 612 passed、48 个环境测试跳过；真实 MySQL 8.4
  migration E2E 41/41；Backend build 通过；`lint:check` 0 errors / 31 个既有
  warnings；`git diff --check` 通过。全量 MySQL 测试使用随机临时库并完成清理，
  未连接或修改本地 `textweaver`，未推送、未部署。

## Round 5：协调词词法边界与严格 comparator 同阈值

修复基线：`306088e`

### RED

- 在 `grounding-verifier.spec.ts` 先加入真实 verifier 行为测试，覆盖
  `并网容量/和田基地/与会人数/及格率` 的词首协调字符，以及位于实体内部的
  `项目并网容量`。证据分别删除协调字符，或把实体拆成两个不相关命题；strict
  必须进入 `WAITING_MATERIAL`，不得得到 `SUPPORTED`。
- 加入严格 comparator 同阈值同义测试：
  `超过300MW` 可由 `大于300MW` 支持，`低于300MW` 可由 `小于300MW` 支持。
  同时补充弱边界与含等号边界反例：`>299` 不支持 `>300`，`<301` 不支持
  `<300`，`>=300` 不支持 `>300`，`<=300` 不支持 `<300`。
- 命令：
  `npx jest src/citation/grounding-verifier.spec.ts --runInBand --no-coverage`
- RED 结果：1 suite failed；6 failed / 75 passed。四个实体测试实际错误返回
  `ALLOW`，两个同阈值同义 comparator 测试实际错误返回 `WAITING_MATERIAL`；
  新增的弱边界和等号冲突反例在 RED 阶段已经保持拒绝。

### GREEN 与重构

- `splitPropositions()` 先只按明确标点切分，再把
  `和/与/及/以及/并` 等词作为候选协调边界保留。只有候选边界两侧均非空，且
  每个分句都可独立解析为可靠的结构化 proposition 时才真正拆分；否则返回原始
  整句，不再过滤空片段或删除实体字符。真实多主体重排、谓词省略、数量和极性
  绑定继续走命题级匹配；无法可靠解析的歧义结构保持 fail-closed。
- 将谓词省略继承提取为 `inheritOmittedValuePredicate()`，候选边界验证与最终解析
  使用同一规则，避免两套判断漂移。
- 严格下界改为区分 `gt` 与 `gte`：同类 `gt` 在阈值相等时集合相同，可相互蕴含；
  `gte` 只有阈值严格更强时才支持 `gt`。严格上界对 `lt/lte` 做对称处理。因此同
  阈值同义词通过，弱阈值和等号边界仍拒绝。
- 首次 GREEN：
  `npx jest src/citation/grounding-verifier.spec.ts --runInBand --no-coverage`
  为 81/81 passed；增加实体内部攻击并完成共享 helper 重构后，最终为
  82/82 passed。

### 回归与验证

- 核心攻击/承重回归：
  `npx jest src/citation/grounding-verifier.spec.ts src/citation/sql-grounding-evidence.store.spec.ts src/retrieval/context-builder.spec.ts --runInBand --no-coverage`
  → 3 suites / 103 tests passed。该组同时确认 stable evidence ID、legacy evidence
  ambiguity、复杂量词否定与 multi-run compress inheritance 未回归。
- Task10 相关 15 套件（content prompt、citation、export ledger、context builder
  与 workflow grounding/revision/recovery）→ 15 suites / 165 tests passed。
- Backend full Jest：
  `npm test -- --runInBand --no-coverage`
  → 75 suites / 623 tests passed；4 suites / 48 个环境测试按既有配置跳过。
- Backend build：`npm run build` → exit 0。
- Lint：`npm run lint:check` → exit 0，0 errors / 31 个既有 warnings。
- `git diff --check`（含本节报告变更）→ exit 0。
- 本轮只修改纯内存 grounding verifier 与其单测，未改 migration、SQL store、
  transaction、schema 或真实 MySQL 执行路径；按任务约定未重跑真实 MySQL 全套。
  基线 `306088e` 已有的真实 MySQL 8.4 migration E2E 41/41 结果仍记录于上一节，
  本轮不把该历史结果表述为重新验证。

### 自审

- 测试直接调用真实 `GroundingVerifier`，没有 mock 命题解析；回退为旧无边界
  `split` 会使实体攻击失败，回退 strict comparator 的 `>`/`<` 条件会使同阈值
  同义测试失败。
- 候选协调边界只有在所有分句均可可靠解析时才消费分隔字符，因此不会以删字方式
  获得 entailment；合法的 `和/与/及/以及` 多主体重排、谓词省略、数量/极性绑定
  由既有正向与反向测试继续覆盖。
- 剩余保守边界：若协调结构的一侧不是当前 parser 支持的结构化命题，即使自然语言
  实际可成立也会保持整句并 fail-closed，可能产生误拒，但不会在 strict 模式静默
  放行。未引入实体词典或面向样本的硬编码。
