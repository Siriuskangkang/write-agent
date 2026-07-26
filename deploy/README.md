# 部署方案

## 架构

```
本地 main 分支 → ./deploy/deploy.sh → codeup deploy 分支
                                              ↓ webhook push 事件
                                    https://textweaver.kaike.com/webhook
                                              ↓ nginx 转发
                                    127.0.0.1:9000 (textweaver-webhook PM2)
                                              ↓ execFile
                                    /home/TextWeaver/scripts/server-deploy.sh
                                              ↓
                                    拉取产物 → 迁移 → pm2 restart
```

## 服务器架构

- **Nginx**：systemd 系统服务，配置 `/etc/nginx/sites-enabled/textweaver.kaike.com`
- **PostgreSQL**：本机直接安装（非 Docker）
- **Redis**：Docker 容器
- **Backend/Frontend**：PM2（`delete + start` 保证配置生效）
- **Webhook Server**：PM2（`textweaver-webhook`，监听 `127.0.0.1:9000`）

## 使用方式

### 日常部署
```bash
./deploy/deploy.sh
```

自动执行：
1. 检查 git 状态（有未提交改动则拒绝）
2. 本地构建后端（`npm run build`）和前端（含 `NEXT_PUBLIC_API_URL`）
3. 将产物暂存到临时目录
4. 切换到 `deploy` 孤立分支，写入产物
5. 强推到 Codeup `deploy` 分支
6. 切回 `main`
7. 服务器 webhook 自动触发：拉取 → 同步产物 → 迁移 → 重启 PM2

### 回滚
```bash
# 查看部署历史并选择回滚
./deploy/rollback.sh

# 直接指定 commit
./deploy/rollback.sh abc1234
```

### 查看部署日志
```bash
ssh root@121.40.71.70 'tail -f /home/TextWeaver/logs/deploy.log'
ssh root@121.40.71.70 'pm2 logs textweaver-webhook'
```

## 首次配置（已完成）

- [x] 服务器生成 SSH 密钥 `~/.ssh/id_ed25519`
- [x] Webhook server 上传并启动（PM2：`textweaver-webhook`）
- [x] Nginx 追加 `/webhook` location
- [ ] **待操作**：将服务器公钥添加到 Codeup 仓库部署密钥
- [ ] **待操作**：在 Codeup 配置 Webhook（URL + Secret）

## 待完成配置

### 1. 添加服务器公钥到 Codeup

服务器公钥：
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEc1o/1H7ebF+5LQs7rxl4MBKAXqxmJn3Qvga3u31/Qb textweaver-server
```

路径：Codeup 仓库 → 设置 → 部署密钥 → 添加（读权限即可）

### 2. 在 Codeup 配置 Webhook

- URL：`https://textweaver.kaike.com/webhook`
- 触发事件：`Push`
- Secret（可选）：设置后同步到服务器 `WEBHOOK_SECRET` 环境变量

```bash
# 服务器设置 secret（如果 Codeup 端配置了 secret）
pm2 set textweaver-webhook:WEBHOOK_SECRET <your-secret>
pm2 restart textweaver-webhook --update-env
```

## 注意事项

- `.env` 文件不在版本控制中，部署时 `rsync` 会跳过，需手动维护
- `uploads/` 目录同样跳过，不受部署影响
- 数据库迁移在每次部署时自动执行（幂等，无新迁移则跳过）
