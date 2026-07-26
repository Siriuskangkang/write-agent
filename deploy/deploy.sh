#!/bin/bash
# TextWeaver 部署脚本
# 流程：推送源码到 codeup → 本地构建（跳过未变更部分）→ rsync 产物到服务器 → 重启服务
#
# 用法: ./deploy/deploy.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@121.40.71.70"
APP_DIR="/home/TextWeaver/app"
BUILD_VERSION_FILE="$REPO_ROOT/.build-version"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
skip() { echo -e "${YELLOW}[deploy]${NC} $1"; }
fail() { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

cd "$REPO_ROOT"

# 检查未提交改动
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "有未提交的改动，请先 commit 后再部署"
fi

VERSION=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=%s)
log "当前版本: $VERSION - $COMMIT_MSG"

# 读取上次构建版本
LAST_BACKEND_VER=""
LAST_FRONTEND_VER=""
if [ -f "$BUILD_VERSION_FILE" ]; then
  source "$BUILD_VERSION_FILE"
  LAST_BACKEND_VER=$BACKEND_VER
  LAST_FRONTEND_VER=$FRONTEND_VER
fi

# 检测源码是否有变更（对比上次构建的 commit）
backend_changed() {
  [ -z "$LAST_BACKEND_VER" ] && return 0
  [ -z "$(git diff --name-only "$LAST_BACKEND_VER" HEAD -- backend/)" ] && return 1
  return 0
}

frontend_changed() {
  [ -z "$LAST_FRONTEND_VER" ] && return 0
  [ -z "$(git diff --name-only "$LAST_FRONTEND_VER" HEAD -- frontend/)" ] && return 1
  return 0
}

# ── 1. 推送源码到远程（备份/版本管理）────────────────────────
log "推送源码到 codeup..."
git push codeup main --quiet

# ── 2. 本地构建（跳过未变更的部分）─────────────────────────────
if backend_changed; then
  log "构建后端..."
  cd "$REPO_ROOT/backend" && npm run build 2>&1 | tail -5
  cd "$REPO_ROOT"
else
  skip "后端无变更，跳过构建"
fi

if frontend_changed; then
  log "构建前端..."
  cd "$REPO_ROOT/frontend"
  NEXT_PUBLIC_API_URL=https://textweaver.kaike.com npm run build 2>&1 | tail -5
  cd "$REPO_ROOT"
else
  skip "前端无变更，跳过构建"
fi

# 记录本次构建版本
cat > "$BUILD_VERSION_FILE" << VEREOF
BACKEND_VER=$VERSION
FRONTEND_VER=$VERSION
VEREOF

# ── 3. rsync 产物到服务器 ──────────────────────────────────────
log "同步产物到服务器..."

rsync -az --delete \
  backend/dist/              $SERVER:$APP_DIR/backend/dist/

rsync -az --delete \
  --exclude='cache/' \
  frontend/.next/            $SERVER:$APP_DIR/frontend/.next/

rsync -az \
  frontend/public/           $SERVER:$APP_DIR/frontend/public/

rsync -az \
  backend/package.json \
  backend/package-lock.json  $SERVER:$APP_DIR/backend/

rsync -az \
  frontend/package.json \
  frontend/package-lock.json $SERVER:$APP_DIR/frontend/

rsync -az \
  ecosystem.config.cjs       $SERVER:$APP_DIR/

# ── 4. 服务器安装依赖、迁移、重启 ─────────────────────────────
log "服务器部署..."
ssh $SERVER bash << EOF
  set -e
  cd $APP_DIR/backend && npm ci --omit=dev --quiet
  cd $APP_DIR/frontend && npm ci --omit=dev --quiet
  cd $APP_DIR/backend && set -a && source .env && set +a && node -e "require('./dist/data-source').AppDataSource.initialize().then(ds => ds.runMigrations()).then(() => { console.log('Migrations complete'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); })"
  cd $APP_DIR && NODE_ENV=production pm2 start ecosystem.config.cjs --update-env
  pm2 save
EOF

log "✅ 部署完成！版本: $VERSION"
log "   查看日志: ssh $SERVER 'pm2 logs --lines 50'"
