# 开发指南

## 前置环境

- Node.js 20+
- npm 10+
- Docker Desktop
- PM2

## 初始化

```bash
npm ci
npm --prefix backend ci
npm --prefix frontend ci

cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local

docker compose up -d
npm --prefix backend run migration:run
```

在 `backend/.env` 中替换 JWT 和模型 Key。要运行 dense indexing，还需配置 `OPENAI_API_KEY`。

## 开发方式

前后端热更新：

```bash
npm --prefix backend run start:dev
npm --prefix frontend run dev
```

需要验证真实 Worker 行为时，先构建，再使用 PM2：

```bash
npm --prefix backend run build
npm --prefix frontend run build
pm2 start ecosystem.config.cjs
```

## 质量检查

```bash
# 文档
npm run docs:check

# 后端
npm --prefix backend run lint:check
npm --prefix backend run test
npm --prefix backend run build

# 前端
npm --prefix frontend run test
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

涉及 MySQL、Qdrant、文件解析或工作流恢复时，还应运行对应集成测试。真实 RAG 评测使用：

```bash
npm --prefix backend run rag:evaluate
```

## 变更约束

- API 路径和成功响应需要兼容时，保留显式适配层。
- 所有项目资源必须校验 `userId + projectId + resourceId`。
- Multer 前完成项目权限检查；隔离写盘后、正式激活前完成类型、大小和配额检查，失败时清理文件。
- LLM 调用统一经 ModelGateway，传递 timeout、retry、usage 和 AbortSignal。
- 不在前端承担权威 JSON 解析或版本提交。
- 新迁移只能前向追加，不启用 `synchronize`。
- 新的渐进能力必须默认 fail-safe，并提供观测、回滚和评测依据。

## 文档变更

实现变化后只修改对应的当前文档。不要新增按 Task、Round 或日期堆叠的执行计划。未来工作写入 GitHub Issue；历史结论由 Git 记录。
