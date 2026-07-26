# Task 9 修复实施报告

基线：`98ed427`
分支：`codex/full-optimization`
日期：2026-07-26

## RED → GREEN

- Dense index fencing RED：旧实现仍调用无 token 的 `markRunning()`，旧 attempt
  在 embedding 阻塞后可以继续删除、upsert 和发布 READY。
- READY coverage / MMR RED：查询未读取 active ingestion 的 index 状态，Qdrant
  返回的 document vector 未进入 candidate。
- Pipeline terminalization RED：neighbor/context 异常直接抛出并留下 RUNNING；
  legacy 异常没有 canonical ERROR。
- Evaluation gate RED：任意手写 v1 JSON 可授权，symlink/path/digest/config 均未校验。
- Metrics RED：重复 ranked/relevant IDs 未被拒绝。

对应 GREEN：

- `retrieval_index_versions` 增加数据库 claim token、lease、attempt、max attempt、
  next retry；所有时间判断使用 MySQL `CURRENT_TIMESTAMP(6)`。
- dispatcher 分配唯一 attempt/job identity；Redis publish 失败释放 durable claim；
  hung `QUEUED/RUNNING` 由 lease 恢复，terminal FAILED 不再伪装 QUEUED。
- Qdrant point 使用 attempt namespace ID；只有仍持有 token 且仍是 active ingestion
  的 attempt 可以发布 READY。搜索只允许当前 active ingestion 的 READY index
  record IDs，并返回真实 document vector 给 MMR。
- retrieval run 持久化实际 mode/gate/canonical/shadow、两条路径独立状态/延迟/
  数量/错误、collection/model/dimension/config hash、embedding usage/cost，以及
  使用过的 index-version 关联。
- corpus/judgments fixture 不包含 rankings。离线 runner 实际执行 ingestion、
  embedding、sparse、dense、RRF 和 context pipeline，输出逐 query trace，但
  `source=offline-deterministic-v1`，不能签发授权 artifact；gate 只接受真实
  MySQL+Qdrant harness 的 `source=mysql-qdrant-production-v1`。回归测试还覆盖
  “离线结果即使被正确 HMAC 签名也不能伪装成生产评测来源”。
- hybrid gate 校验 HMAC、artifact SHA-256、allowed regular file、no symlink/path
  escape、dataset/code/config/index/collection/model/dimension binding、sample
  count、freshness/expiry 和当前 latency budget。仓库不再包含 passing report。
- MySQL ngram 不可用时 migration fail closed；Evidence exact span 提取最相关句段
  并保留绝对 offset。

## 独立真实环境

- MySQL container：`write-agent-task9fix-mysql`
- MySQL image：`mysql:8.4`
- 临时数据库：`rag_test`
- 端口：`127.0.0.1:33316`
- Qdrant container：`write-agent-task9fix-qdrant`
- Qdrant image：`qdrant/qdrant:v1.13.2`
- 端口：`127.0.0.1:6337`
- 未连接或修改本地 `textweaver`。
- 验证完成后仅删除上述 `write-agent-task9fix-*` 容器和测试 backend image。

真实 MySQL + Qdrant 测试包含：

1. 旧 ingestion A 获得 claim 后阻塞在 embedding。
2. 新 ingestion B 成为 active，获得新 claim 并发布 READY。
3. A 恢复后被 fence 为 terminal FAILED，不能 upsert、删除或发布。
4. 查询只返回 B 的 point 和真实 vector。
5. expired RUNNING claim 使用新 token/attempt 恢复，旧 token 无法执行。

## 验证证据

- Retrieval unit：17 suites / 59 tests passed（另 2 integration suites、9 tests
  按环境跳过）。
- Real MySQL + Qdrant：7/7 passed。
- Real Qdrant adapter：2/2 passed。
- Fresh MySQL 全迁移：passed。
- `rag:evaluate`：passed，且基线 gate 明确为 `passed=false`。
- Backend full Jest：62 suites / 482 tests passed，44 skipped。
- Backend build：passed。
- `lint:check`：0 errors，31 个基线 warnings。
- Docker production image build：passed；镜像内没有评测报告或授权 artifact。
- `docker compose config --quiet`：passed。
- `git diff --check 98ed427`：passed。

## 评测结果与切换决定

实际执行的 `chinese-textbook-shadow-v2`：

- Legacy Recall@8：0.9333
- Hybrid Recall@8：0.9333
- Legacy nDCG@8：0.9531
- Hybrid nDCG@8：0.8725
- Hybrid p95：2 ms（离线确定性 evaluation pipeline）

Hybrid nDCG 低于 legacy，因此真实 gate 结果为 `passed=false`。默认及当前决定保持
`shadow`；没有生成或提交可授权 hybrid 的 artifact。后续必须改善 rerank/MMR 并在
更大的真实教材集上重新运行、签名和装配 artifact，才能切换主链路。

## Round 2：独立复审缺陷修复

基线：`57a802b`

### Dense index 生命周期

- winning worker 不再执行按 `file_id` 的 broad cleanup。新增独立
  `DenseIndexGcService`，仅消费 MySQL 明确声明的 stale
  `published_namespace`，Qdrant 只按该 namespace 精确删除。
- GC claim 使用独立 `gc_token + gc_lease_expires_at`；删除前、删除后均在事务中
  重新校验 source file 当前 active ingestion、当前 READY namespace、stale
  namespace 和 GC token。更新 ingestion 的 READY namespace 不会成为删除目标。
- worker 在整个 chunk load / embedding / Qdrant upsert 周期持续用 MySQL
  `CURRENT_TIMESTAMP(6)` 续租；续租失败会触发 `AbortSignal`，并传入 embedding
  provider 和 Qdrant 请求。
- fence 失败区分 `STALE_INGESTION`、`LEASE_EXPIRED` 和 superseded attempt；
  lease 过期且未耗尽 attempt budget 可重新 claim，最后一次 crash 由 dispatcher
  原子终结为 `FAILED / LEASE_EXPIRED_MAX_ATTEMPTS`。

### 物理 coverage 与用量

- Dense 查询先对每个 active READY namespace 执行 Qdrant exact count，并与
  MySQL `point_count` 比较。物理点丢失返回
  `DEGRADED / INDEX_POINTS_MISSING`，不再误报 `NO_HIT`。
- run-index snapshot 现在保存每个 active file 的 READY、PENDING、FAILED 或
  MISSING 状态，并记录 expected/observed point count；缺失 index 可使用 nullable
  `index_version_id` 审计。
- Embedding gateway 新增 detailed API，返回 vectors 与 provider usage，同时保留
  原 `generateEmbedding(s)` 兼容方法。provider 返回 usage 时写 actual token/cost；
  缺失 usage 时只写 estimated token/cost，并设置 estimated flag。
- OpenAI-compatible embedding 请求固定 `encoding_format=float` 并支持
  `EMBEDDING_BASE_URL`；测试发现并修复了 SDK 默认 base64 解码导致兼容服务返回空
  vector 的问题。

### 可信评测

- artifact schema 强制包含 traces；`sample_count` 必须等于唯一 sample ID 数量。
  每条 trace 包含绑定的 relevant judgments，所有 ranking 必须无重复。
- gate 在 HMAC 校验成功后仍逐 trace 重算 Recall/nDCG/context precision，并重新
  聚合 latency/cost；signed aggregate 与重算结果不一致即拒绝。
- freshness 新增 max age、max TTL 和 future skew 配置，并强制
  `generated_at < expires_at`。
- `MysqlQdrantEvaluationPipeline` 直接调用线上 `HybridRetriever`，因此实际复用
  query planner、sparse/dense、RRF、本地 rerank、neighbor expansion 和 context
  selection，不再维护一条手写近似链路。
- 新增可执行 `npm run rag:evaluate:production`：创建临时 user/project/files/
  documents/chunks，通过正常 dense indexing 等待 READY，运行 production
  orchestration，签名 artifact，并在 `finally` 精确清理 MySQL 数据和 Qdrant
  namespaces。`npm run rag:evaluate` 仍明确禁止生成授权 artifact。

### Round 2 验证

- 新增 targeted RED：winner broad cleanup、缺少 GC fence、无 worker heartbeat、
  READY 物理点缺失、coverage 未保存 missing、provider usage 仅字符估算、HMAC-valid
  空/伪 traces、重复 ranking、伪造 aggregate、超 age/TTL、production evaluator
  偏离线上 orchestration。
- Targeted retrieval/embedding/evaluation：全部通过。
- Real MySQL 8.4 + Qdrant 1.13.2：10/10 通过；包含 final-attempt crash、
  B/C READY GC 竞态、production harness 完整运行与清理。
- Real Qdrant adapter：2/2 通过。
- production CLI：按 README 等价命令独立执行成功，生成
  `source=mysql-qdrant-production-v1` artifact；临时 MySQL user/project/run 均为
  0 残留，Qdrant collection `points_count=0`。测试 artifact 未进入仓库。
- Offline artifact 攻击：命令退出非零且不创建文件。
- Backend full Jest：64 suites / 493 tests passed，47 skipped。
- Backend build：通过。
- `lint:check`：0 errors，31 个既有 warnings。
- `docker compose config --quiet`、`git diff --check`：通过。

本轮 production harness 使用本地假 embedding HTTP provider，仅验证真实
MySQL/Qdrant 生命周期、线上 orchestration、artifact 生成和清理；其 relevance
结果不用于授权。离线教材基线仍为 `passed=false`，继续保持 `shadow`。

## Round 3：删除竞态、物理覆盖与评测正例修复

基线：`eaee7c2`

### 在线 namespace 保留策略

- 证明了数据库锁无法覆盖 Qdrant 外部删除：旧 ingestion 在校验和删除之间可被
  structured ingestion 重新激活，删除后的二次校验无法恢复向量。
- 在线/自动 GC 不再注入 Qdrant，也不执行 namespace delete。旧的 claim、lease、
  completed 状态和接口已移除；前向 migration 将其替换为
  `retention_debt_recorded_at` / `retention_debt_reason`。
- stale READY namespace 只会被 active namespace allowlist 隔离，并以
  `REACTIVATABLE_NAMESPACE_RETAINED` 持久记录 retention debt。未来只有不可逆
  source/file tombstone 且持有 per-file destructive lock 的专用流程可以物理删除。
- 真实 MySQL+Qdrant 回归先记录 B 为 stale debt，再把 B 切回 active；B 与 C
  namespace 均保持 1 个 point，证明在线维护产生 0 次删除。

### Dense coverage

- READY metadata 的 `point_count > 0` 时，allowlisted nearest-neighbor search
  返回空即直接返回 `unavailable / INDEX_POINTS_MISSING`，不会再报告 READY/NO_HIT。
- run index snapshot 将该次有效搜索覆盖记录为 `observed_point_count=0`，保留
  expected count 和错误码。
- 真实 Qdrant 测试在 exact count 返回 1 后立即删除 point；后续 vector search
  为空，检索稳定降级并记录 coverage mismatch。

### 可信 relevance judgments

- 每条 trace/dataset judgment 必须至少包含一个、且 runner 侧确实存在于 corpus
  的 relevant chunk ID。
- artifact 新增 `positive_judgment_count`；gate 在 HMAC 验证后从 traces 重算并
  要求与签名字段一致，同时应用运行时
  `RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS` 总正例阈值。
- runner 在 ingestion 和任一 pipeline 调用前 fail fast；全空 judgments、正例总数
  不足、伪造 positive count 的 HMAC-valid artifact 均被拒绝。

### Round 3 验证

- RED：4 suites 中 8 个预期失败，分别复现在线 GC delete、count/search TOCTOU、
  HMAC-valid 空 judgments、伪 positive count 和 runner 过晚校验。
- Targeted GREEN：4 suites / 31 tests passed。
- Retrieval unit：18 suites / 73 tests passed，2 integration suites skipped。
- Real MySQL 8.4 + Qdrant 1.13.2：11/11 passed；独立 Qdrant adapter 2/2 passed。
- Production evaluation CLI：真实 MySQL/Qdrant harness 成功生成带
  `positive_judgment_count=11` 的临时签名 artifact；finally 后 evaluation
  users/projects/orphan runs 均为 0，collection points_count=0。artifact 未进入
  仓库且不用于授权。
- Offline evaluation：成功，Hybrid nDCG 仍低于 legacy，gate `passed=false`，
  保持 `shadow`。
- Backend full Jest：64 suites / 498 tests passed，48 skipped。
- Backend build：通过。
- `lint:check`：0 errors，31 个既有 warnings。
- `git diff --check`：通过。
