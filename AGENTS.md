# Project Agent Guide

本文件是仓库内唯一的 Agent 协作入口。不要新增 Claude/Codex 专用副本，也不要提交会话、计划、检查点或测试账号。

## 项目

教材编写 Web 应用：上传素材，生成目录、大纲和正文，管理引用、体例与导出。当前架构和功能状态以 [README](./README.md) 与 [文档索引](./docs/README.md) 为准。

## 运行

```bash
docker compose up -d
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run migration:run
npm --prefix backend run build
npm --prefix frontend run build
pm2 start ecosystem.config.cjs
```

端口：API `3002`、Web `8002`、MySQL `3306`、Redis `6379`、Qdrant `6333/6334`。

## 修改规则

- 先阅读受影响模块和对应当前文档，不使用旧计划推断现状。
- 项目资源必须校验 `userId + projectId + resourceId`。
- 耗时工作由 Worker 执行，API 只创建任务和提供查询/SSE。
- LLM 调用经过 ModelGateway，并传递 timeout、usage、retry 和 AbortSignal。
- 数据库使用前向迁移，禁止开启 TypeORM `synchronize`。
- Hybrid RAG、确定性写作和 Atomic Grounding 保持 fail-safe 默认值。
- 不提交 `.env`、上传素材、导出物、coverage、`.omc/` 或 `.superpowers/`。

## 验证

```bash
npm run docs:check
npm --prefix backend run lint:check
npm --prefix backend run test
npm --prefix backend run build
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

按风险选择相关检查；涉及数据库、队列、解析、RAG 或工作流恢复时补对应集成测试。
