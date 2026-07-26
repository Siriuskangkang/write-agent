# 教材编写 Agent 全面优化报告

日期：2026-07-27  
基线：`5b61f93`  
优化分支：`codex/full-optimization`  
报告前提交：`d2ef4d1`

## 结论

本轮以兼容现有 NestJS、Next.js、MySQL、Redis/Bull 技术栈为前提，完成了安全边界、可靠上传、数据库迁移、持久任务、模型网关、结构化解析、Hybrid RAG、可信引用、确定性写作编排、前端任务恢复和运行可观测性改造。

旧生成接口仍保留兼容层；新的目录、大纲和正文链路可以使用持久 workflow、服务端权威版本、人工批准和事务提交。高风险能力默认保持 fail-closed：storage authority 未自动激活，Hybrid RAG 未通过评测门禁时不会切为主链路。

## 主要变化

### 安全与数据一致性

- 项目、素材、目录、大纲、正文、体例和导出资源统一执行用户与项目归属校验。
- 上传在写盘前校验权限、数量、单文件和用户总容量；异常上传具备清理或持久恢复记录。
- 上传元数据、outbox 和 storage PROMOTE 请求位于同一数据库事务。
- broker 模式下，文件 tombstone、文档/切块停用和 DELETE_BLOB intent 位于同一事务；失败时资源仍可见。
- MySQL schema contract 覆盖列、索引、外键、CHECK、字符集和迁移阶段差异；空库迁移可复现。

### 持久任务与模型调用

- 增加 `workflow_jobs`、`workflow_events`、`model_runs`、检查点、事件序号、取消和批准状态。
- API 只创建/查询任务，独立 Bull worker 执行生成；任务支持幂等提交、恢复、取消和事件游标续传。
- 引入类型化 `ModelGateway`，统一 structured output、超时、重试、usage、cost、AbortSignal 和安全请求指纹。
- 防止停止后的状态反转、重复 domain commit 和不完整模型运行记录。

### RAG 与可信引用

- 文档解析保存结构化 AST、checksum、parser/chunk version、标题路径、页码、offset 和块类型。
- 增加 parent-child token-aware chunking、MySQL sparse、Qdrant dense、RRF、rerank、MMR、邻块扩展和来源配额。
- 保存 retrieval run、候选分数、索引快照、延迟和 embedding 成本。
- claim-evidence ledger 保存 claim、精确 evidence span、rank、score、retrieval run 和支持状态。
- 原子化 grounding 以 fail-closed 方式验证、封存、恢复和继承引用；批准正文会事务写入 `grounding_claims` 与 `citation_maps`。

### 确定性写作编排

- 目录、大纲、正文使用固定状态图，不引入自由自治 Agent。
- 节点覆盖权限、输入快照、检索、证据门、结构化草稿、校验、引用审查、风格审查、最多两次定向修订、人工确认和事务提交。
- proposal、批准和提交均验证 owner/project/job scope，支持幂等提交。
- 正文以精确字节保存，正文列扩展为 `MEDIUMTEXT`；rewrite/expand/compress 保留父版本链。

### 前端与运行边界

- 前端新增 workflows、authoring、materials、citations feature 边界。
- 工作台按 job ID 和事件 cursor 恢复活动任务，支持取消、批准、material gap、错误状态和服务端权威版本回读。
- `useChatOperations` 与 `EditorPane` 的主要职责已拆分，现有视觉和旧接口兼容行为保留。
- PM2 配置为 `write-agent-api`、`write-agent-worker`、`write-agent-web`；broker 仅在 `STORAGE_AUTHORITY_MODE=broker` 时加入。
- 增加 `/api/health/live`、`/api/health/ready`、`/api/health/metrics`、worker Redis 心跳、`X-Request-Id` 和不记录正文/密钥的请求日志。

## 集中验证

| 检查 | 结果 |
|---|---|
| 后端 Jest 全量 | 104 suites、1567 tests 通过；6 suites、69 tests 为显式环境条件跳过 |
| 后端构建 | 通过 |
| 后端 lint check | 0 errors，31 warnings |
| 前端 Vitest | 4 files、18 tests 通过 |
| 前端生产构建 | 通过，9 个页面生成成功 |
| MySQL 8.4 storage/schema integration | 2 suites、21 tests 通过 |
| Go broker | `go test -race ./...` 与 `go vet ./...` 通过 |
| 运维与 Compose 契约 | 9 tests 通过；默认和 `app` profile 配置均通过 |
| Git | 工作树干净，`git diff --check` 通过 |
| Docker Desktop | MySQL、Redis、Qdrant 均 healthy |

未执行会调用真实外部 LLM 的完整 Playwright 用户旅程，也未执行 production RAG 签名评测。

## RAG 离线对比

固定中文教材数据集：5 个 query、11 个正相关判断、K=8。

| 指标 | Legacy | Hybrid |
|---|---:|---:|
| Recall@K | 0.9333 | 0.9333 |
| nDCG@K | 0.9531 | 0.8725 |
| Context precision | 0.6933 | 0.2500 |
| P95 latency | 6 ms | 2 ms |
| 评测成本 | $0 | $0 |

当前 Hybrid 延迟更低，但排序质量和上下文精度变差，因此评测门禁结果为 `passed=false`。系统应继续保持 legacy/shadow，不应把 Hybrid 切为权威检索。下一步应优先调整 dense 权重、reranker 和 MMR/来源配额，再运行真实 MySQL + Qdrant production harness。

## 依赖审计

- 后端 production dependency audit：25 项（15 high、10 moderate）。
- 前端 production dependency audit：6 项（3 high、3 moderate）。
- 当前审计结果包含 NestJS/Express/Multer/TypeORM、解析 ZIP/XML 依赖、Next.js/PostCSS/DOMPurify 等上游问题，多项暂无自动修复版本。

不建议直接执行无审查的 `npm audit fix`。应建立单独升级分支，优先处理上传解析面和 Next.js，再跑文件攻击样例与完整 E2E。

## 尚未激活或仍需后续工作

- Storage authority 默认仍为 `legacy`，激活脚本保持禁用和 fail-closed；尚未完成生产 OS 用户、目录权限、独立 DB principal、broker 二进制安装及负向探针。
- broker 模式的项目级删除和重新解析仍会分别返回 `STORAGE_PROJECT_DELETE_REQUIRES_TOMBSTONE`、`STORAGE_REPARSE_REQUIRES_NEW_OBJECT_GENERATION`，避免在对象世代流程完成前误删。
- authoring commit 已具备事务和引用账本，但完整的 procedure-only authoring DB principal/mTLS 权限架构未落地。
- Hybrid RAG 尚未通过质量门禁，不能切换为主链路。
- 当前 PM2 在线的是原主工作区中的 `write-agent-backend`、`write-agent-frontend`；优化分支未替换正在使用的本地服务，避免中断现有登录状态。
- 31 个 lint warning 和依赖审计问题应作为后续收敛项，不影响本轮构建。

## 建议的上线顺序

1. 将优化分支合并到主工作区，在数据库副本上运行全量迁移和 schema diff。
2. 使用优化后的 PM2 三进程配置启动 API、worker、web，验证 `/api/health/ready`。
3. 完成登录→上传→目录→批准→大纲→批准→正文→批准→导出的本地 Playwright 流程。
4. 调优 Hybrid RAG，只有 production signed evaluation 通过后才切换。
5. 单独完成 storage authority 的 OS/数据库权限准备和负向探针，再启用 broker。
