# 项目文档

这里仅保存与当前代码一致、能够指导开发和运行的文档。阶段计划、Agent 对话、审查轮次、临时测试报告和已完成任务不作为长期文档保留；需要追溯时使用 Git 历史、Issue 或 Release。

## 权威入口

| 文档 | 适用读者 | 内容 |
| --- | --- | --- |
| [项目 README](../README.md) | 所有人 | 项目定位、功能状态和快速启动 |
| [产品范围](./product-overview.md) | 产品、研发 | 用户流程、稳定能力与渐进能力 |
| [系统架构](./architecture.md) | 研发、架构 | 进程、模块、数据流和安全开关 |
| [开发指南](./development.md) | 贡献者 | 本地环境、命令、测试和变更约束 |
| [部署指南](./deployment.md) | 运维 | 单机部署基线、升级与回滚 |
| [运维手册](./operations.md) | 运维、值班 | 健康检查、日志、备份和排障 |
| [贡献指南](../CONTRIBUTING.md) | 贡献者 | 提交要求和质量门槛 |

## 专项文档

- [RAG 评测与激活](../backend/evaluation/rag/README.md)
- [结构化素材解析契约](../backend/src/file/structured-ingestion.md)
- [Atomic Grounding Shadow 发布](./operations/atomic-grounding-shadow-rollout.md)
- [Atomic Grounding 安全回滚](./operations/atomic-grounding-safe-rollback.md)
- API 契约以运行时 Swagger `/api/docs` 和当前 DTO 为准。
- 数据库结构以 `backend/migrations/` 和实体定义为准。

## 文档治理

- 一个主题只保留一个当前版本，不复制大段代码或环境变量清单。
- 计划放 Issue，架构结论写入当前架构文档，操作步骤写入运维文档。
- 不提交 `.omc/`、`.superpowers/`、Claude/Codex 会话状态或本机权限配置。
- 不记录测试账号密码、真实服务器 IP、SSH 公钥、API Key 或生产目录。
- 修改端口、进程、环境变量、API 或数据流时，同步修改对应文档。
- 提交前运行 `npm run docs:check`。

最后核对日期：2026-07-27。
