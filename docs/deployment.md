# 部署指南

## 支持的基线

当前推荐单机拓扑：

- Linux 主机运行 PM2、Node.js 和 Nginx
- Docker 运行 MySQL、Redis、Qdrant
- PM2 运行 API、Worker、Web
- 上传、导出、MySQL 和 Qdrant 使用持久化磁盘

不再使用仓库中旧的固定 IP、Codeup webhook 或 rsync 脚本。部署目标、域名和密钥必须由环境或私有配置提供。

## 资源建议

- 最低：4GB 内存，只适合低并发与小素材库
- 推荐：4 核 8GB 内存、2–4GB Swap
- 多用户、大 PDF 或大规模向量：8 核 16GB 以上
- 磁盘：至少 40GB，并为上传文件、MySQL、Qdrant 单独监控容量

## 首次部署

```bash
git clone https://github.com/Siriuskangkang/write-agent.git
cd write-agent

npm ci
npm --prefix backend ci
npm --prefix frontend ci

cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

生产环境必须修改：

- 数据库与 Redis 密码
- `JWT_SECRET`
- 所选 LLM API Key
- `FRONTEND_URL`
- 可选的 Embedding Key、模型价格和 RAG 评测配置

不要在仓库、Shell 历史或部署日志中打印真实密钥。

## 基础设施与迁移

```bash
docker compose up -d
docker compose ps

npm --prefix backend run migration:run
```

迁移脚本当前依赖开发工具，应在 `npm prune --omit=dev` 之前执行。生产升级前必须备份 MySQL、Qdrant 和上传目录。

## 构建与启动

```bash
npm --prefix backend run build
NEXT_PUBLIC_API_URL=https://your-domain.example npm --prefix frontend run build

NODE_ENV=production pm2 start ecosystem.config.cjs --update-env
pm2 save
```

`ecosystem.config.cjs` 使用自身所在目录定位前后端，不要求固定服务器路径。

## 反向代理

Nginx 至少应满足：

- `/` 转发到 `127.0.0.1:8002`
- `/api/` 转发到 `127.0.0.1:3002`
- SSE 路径关闭 buffering，并设置足够长的 read timeout
- 上传大小与 `MAX_FILE_SIZE` 一致
- 仅通过 HTTPS 暴露站点
- `/api/health/metrics` 仅允许运维网络访问

不要直接暴露 3306、6379、6333、6334 或 9465。

## 上线验证

```bash
curl -fsS https://your-domain.example/api/health/live
curl -fsS https://your-domain.example/api/health/ready
pm2 status
pm2 logs --lines 100
```

至少完成登录、上传、解析、目录、大纲、正文、停止任务和导出烟雾测试。

## 升级与回滚

升级顺序：

1. 备份数据和上传目录。
2. 拉取确定的 Git commit。
3. 安装依赖并构建。
4. 运行前向迁移。
5. 重启 PM2。
6. 检查 readiness 和主要用户流程。

应用回滚可以切回上一 commit 并重新构建。数据库迁移默认只提供前向 reconciliation；涉及 schema 回退时必须先评估数据兼容性，不能直接执行破坏性降级。

Storage Broker 当前不属于支持的公开部署路径，保持 `STORAGE_AUTHORITY_MODE=legacy`。
