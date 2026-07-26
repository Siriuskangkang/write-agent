# 运维手册

## 进程与依赖

```bash
docker compose up -d
npm --prefix backend run build
npm --prefix frontend run build
pm2 start ecosystem.config.cjs
```

PM2 进程：

- `write-agent-api`
- `write-agent-worker`
- `write-agent-web`

MySQL、Redis、Qdrant 由 Docker Compose 管理。Storage Broker 当前不属于支持的部署路径，保持 `STORAGE_AUTHORITY_MODE=legacy`。

## 健康检查

| 接口 | 含义 |
| --- | --- |
| `GET /api/health/live` | API 进程可以响应 |
| `GET /api/health/ready` | MySQL、Redis、Worker 心跳、Qdrant、LLM 配置均正常 |
| `GET /api/health/metrics` | workflow、模型、检索和队列聚合指标 |

```bash
curl -fsS http://127.0.0.1:3002/api/health/live
curl -fsS http://127.0.0.1:3002/api/health/ready
```

`metrics` 当前没有应用层鉴权，只能通过 Nginx、ACL 或防火墙向运维网络开放。

Worker 每 10 秒写一次 Redis 心跳，30 秒未刷新即判定不可用。所有 API 响应带 `X-Request-Id`；日志不得记录请求正文、素材、Cookie 或 Authorization。

## 日志和状态

```bash
pm2 status
pm2 logs write-agent-api --lines 100
pm2 logs write-agent-worker --lines 100
pm2 logs write-agent-web --lines 100

docker compose ps
docker compose logs --tail 100 mysql redis qdrant
```

排障时使用 `X-Request-Id`、workflow job ID 和事件序号关联日志，不复制用户素材到 Issue。

## 常见故障

| 现象 | 首要检查 |
| --- | --- |
| readiness 返回 503 | 响应中的依赖状态、Worker 心跳、LLM Key |
| 上传后长期解析中 | Worker、Redis、文件隔离目录权限、解析 lease |
| 素材不足暂停 | 文件解析状态、active chunks、retrieval run 状态 |
| 生成任务失败 | workflow events、model run 错误类型、模型配额 |
| Qdrant 无结果 | `OPENAI_API_KEY`、dense index 状态、collection |
| 页面刷新后任务丢失 | job ID、本地 workflow store、events 恢复请求 |
| 导出失败 | Worker、导出目录权限、磁盘容量 |

## 备份

至少备份：

- MySQL 全库
- Qdrant collection snapshot 或数据卷
- 上传目录
- 后端与前端环境变量的加密副本

Redis 主要承载队列，不替代 MySQL 工作流状态，但仍建议保留持久化卷。备份必须与当前 Git commit 和迁移版本一起记录。

## 恢复

1. 停止 API 和 Worker，避免恢复过程中继续写入。
2. 恢复 MySQL、Qdrant 和上传目录到一致时间点。
3. 核对环境变量、文件路径和数据库迁移版本。
4. 启动 API 与 Worker。
5. 检查 readiness、队列积压和随机素材引用。

不要只恢复数据库而遗漏上传文件或 Qdrant，否则引用和检索结果可能不一致。

## 升级

```bash
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run build
npm --prefix frontend run build
npm --prefix backend run migration:run
NODE_ENV=production pm2 restart ecosystem.config.cjs --update-env
```

升级前备份，升级后检查健康接口和主要用户流程。迁移使用前向 reconciliation，不假设可以无损降级。

## 容量

- 单文件上限默认 50MB。
- 用户素材配额默认 500MB。
- 监控上传目录、MySQL、Qdrant、PM2 Worker RSS 和 Bull backlog。
- 单机生产建议至少 8GB 内存；大规模向量或并发解析建议 16GB 以上。

## 专项操作

- [Atomic Grounding Shadow 发布](./operations/atomic-grounding-shadow-rollout.md)
- [Atomic Grounding 安全回滚](./operations/atomic-grounding-safe-rollback.md)
