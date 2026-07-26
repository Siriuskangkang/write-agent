# 教材编写 Agent 全面优化设计

## 目标

在不推倒现有 NestJS、Next.js、MySQL、Redis/Bull 技术栈的前提下，把项目改造成安全、可部署、可恢复、可评测的教材编写系统。改造按安全与数据库、持久任务、类型契约、Hybrid RAG、受控写作工作流、前端模块化的顺序推进。

## 核心决定

- 保持现有成功响应和旧生成接口兼容，新增 workflow API 后逐步迁移前端。
- 项目权限统一通过 `ProjectAccessPolicy`；访问他人项目返回 403，项目内资源不匹配返回 404。
- API、worker、web 由 PM2 分进程管理；MySQL、Redis、Qdrant 由 Docker Desktop 管理。
- 生成使用 Bull + MySQL 持久状态图，不使用自由自治多 Agent，也不在第一版引入 LangGraph。
- MySQL 是业务事实源，Qdrant 只保存可重建的向量索引。
- RAG 默认严格素材模式；证据不足时产生 material gap，不允许静默退化为无来源生成。
- 目录和大纲经人工批准后成为 current；正文先保存 draft，接受后切换 current。
- 不推送、不部署、不重写 Git 历史；敏感运行产物只从 Git 索引移除并保留本地副本。

## 数据与任务流

```text
上传与解析
→ 结构化 Document AST
→ 幂等 parent-child chunk
→ sparse/dense 索引
→ workflow job
→ 任务化检索
→ evidence packets
→ 结构化草稿
→ schema/grounding/style 校验
→ 最多两次定向修订
→ 人工批准
→ 事务保存版本
```

生成请求创建 `workflow_jobs`，每个节点完成后写 checkpoint，每个对外事件写入 `workflow_events`。SSE 只订阅任务事件并通过 `Last-Event-ID` 恢复。取消请求持久化，并通过 `AbortSignal` 传入模型 provider。

## 兼容与迁移

当前数据库只包含用户与 refresh token，业务表为空。实施时再次检查该前提；若业务表出现数据，停止重建并重新设计数据迁移。保留认证表，修复历史迁移的空库路径，并通过前向 reconciliation migration 重建空业务表。

旧目录、大纲、正文生成接口保留为兼容适配层，内部转交 workflow service。前端迁移完成前不删除旧接口。

## 质量门槛

- 每项行为变更先写失败测试，再写最小实现。
- 每个任务独立提交并接受规格与代码质量复核。
- 必须通过双用户越权、空库迁移、现有库副本升级、SSE 恢复、取消、并发版本、真实文件 fixture、Hybrid RAG 和主用户流程 E2E。
- 最终报告包含提交列表、架构变化、测试证据、RAG 指标、遗留风险和后续建议。
