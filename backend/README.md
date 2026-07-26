# Write Agent Backend

NestJS API 与后台 Worker，共享 TypeORM 实体、模型网关、工作流和领域服务。

## 入口

- API：`src/main.ts`
- Worker：`src/worker-main.ts`
- API 模块：`src/app.module.ts`
- Worker 模块：`src/worker.module.ts`
- 数据源与迁移：`src/data-source.ts`、`migrations/`

## 开发

```bash
cp .env.example .env
npm ci
npm run migration:run
npm run start:dev
```

Worker 验证使用根目录 PM2 配置：

```bash
npm run build
cd ..
pm2 start ecosystem.config.cjs
```

## 检查

```bash
npm run lint:check
npm run test
npm run test:e2e
npm run build
```

涉及真实 MySQL、Qdrant 或 PDF fixture 的测试需要先启动对应依赖。RAG 激活流程见 [评测说明](./evaluation/rag/README.md)。

## 约束

- `synchronize` 必须保持关闭，schema 只通过迁移演进。
- API 不执行耗时解析、索引和导出；这些任务交给 Worker。
- 所有项目资源必须经过用户、项目和资源归属校验。
- 模型调用统一经过 `ModelGateway`。
- 默认运行模式是 `RETRIEVAL_MODE=shadow`、`AUTHORING_COMMIT_MODE=off`、`ATOMIC_GROUNDING_MODE=off`。

完整架构和运维说明见 [项目文档](../docs/README.md)。
