# 本地运行与可观测性

## 进程

```bash
docker compose up -d mysql redis qdrant
npm --prefix backend run build
npm --prefix frontend run build
pm2 start ecosystem.config.cjs
```

PM2 进程固定为：

- `write-agent-api`
- `write-agent-worker`
- `write-agent-web`
- `write-agent-storage-broker`（仅在完成 storage authority preflight 与独立激活后启用）

storage authority 默认保持 `legacy`，激活脚本当前为 fail-closed，不会修改生产权限。

## 健康检查

- `GET /api/health/live`：只证明 API 进程可响应。
- `GET /api/health/ready`：分别检查 MySQL、Redis、Bull worker 心跳、Qdrant 和所选 LLM 配置。任一依赖不可用时返回 HTTP 503，并只输出错误类型，不输出连接串、密钥或素材内容。
- `GET /api/health/metrics`：输出 workflow 状态/延迟、模型 token/成本、检索状态/延迟以及 Bull 队列计数。只包含聚合数据。
- Worker 进程每 10 秒写一次 Redis 心跳，30 秒未刷新即判定 worker 不可用。

所有 API 响应带 `X-Request-Id`；请求日志仅记录 request ID、方法、路径、状态码和耗时，不记录请求正文、素材、Cookie 或 Authorization。

## 本地限制

Docker Compose 默认只启动 MySQL、Redis 和 Qdrant。应用容器位于 `app` profile：

```bash
docker compose --profile app up -d
```

本地 PM2 与 Compose 应用 profile 二选一，避免重复占用 3002/8002。
