# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

教材编写 Agent —— 一个 AI 驱动的教材编写 Web 应用。用户上传素材文件，AI 基于素材生成目录、大纲、正文，并支持改写/扩写/精简，最终导出 DOCX 或 Markdown。

## Services & Ports

| 服务 | 端口 | 说明 |
|------|------|------|
| Backend (NestJS) | 3002 | API 服务，前缀 `/api` |
| Frontend (Next.js) | 8002 | Web UI |
| MySQL | 3306 | 主数据库（textweaver，utf8mb4） |
| Redis | 6379 | Bull 队列 |

PM2 管理：`pm2 start ecosystem.config.cjs`（根目录）

## Commands

### Backend (`cd backend`)
```bash
npm run start:dev     # 开发模式（watch）
npm run build         # 编译
npm run test          # 单元测试（Jest）
npm run test:cov      # 测试覆盖率
npm run test:e2e      # E2E 测试
npm run lint          # ESLint + 自动修复
npm run migration:run # 运行数据库迁移
```

### Frontend (`cd frontend`)
```bash
npm run dev           # 开发模式（port 8002）
npm run build         # 构建
npm run typecheck     # TypeScript 类型检查（会触发 next build）
```

### 运行单个后端测试
```bash
cd backend && npx jest src/chunk/chunker.spec.ts --no-coverage
```

## Architecture

### Backend (NestJS + TypeORM)

模块职责：

- **auth** — JWT 认证，cookie 存储 `wa_access_token`，refresh token 机制
- **project** — 项目 CRUD，状态管理
- **file** — 文件上传（multer），Bull 队列异步解析，支持 PDF/DOCX/PPTX/MD/TXT
- **chunk** — 文件解析后切块，bigram 分词写入 `search_terms`，供关键词检索使用
- **retrieval** — 关键词检索（MySQL `LIKE` + 命中词数排序，`retrieval.service.ts`）；`embedding` 模块提供向量化，当前未接入检索主链路
- **agent** — LLM 编排层：`AgentService.generateStream()` 按 `LLM_PROVIDER`（anthropic/deepseek）经 `LLMFactory` 创建 provider，分发到 6 条 chain（directory/outline/content + rewrite/expand/compress）；chain 在 `src/agent/chains/`，prompt 在 `src/agent/prompts/`
- **content** — 目录/大纲/正文生成的 SSE 流控制器，版本管理（`DirectoryVersion`/`OutlineVersion`/`ContentVersion`/`WritingResult`）
- **session** — 会话与消息持久化（工作台对话历史）
- **citation** — 引用来源记录与查询
- **export** — Bull 队列异步导出，生成 DOCX/Markdown 文件
- **embedding** — 向量化服务（`EMBEDDING_PROVIDER`/`EMBEDDING_MODEL`/`EMBEDDING_DIMENSION`）；当前检索主链路走关键词，向量检索未启用

### SSE 生成链路

前端 `useSSE` hook → POST 到生成接口 → 后端 `initSse()` 建立流 → `AgentService.generateStream()` 经 LLM provider（`LLM_PROVIDER`，当前 deepseek）流式生成 → 逐 token 写 SSE event（`meta` → `token` → `done`/`error`）。

目录/大纲生成完成后，前端 `onDone` 回调负责调用 save 接口落库（`/directory/save`、`/outline/save`）。正文生成由后端直接写 `WritingResult` 实体。

### Frontend (Next.js 14 App Router + Zustand + Ant Design)

状态管理（`src/stores/`）：
- `authStore` — 登录用户信息
- `projectStore` — 项目列表
- `editorStore` — 工作台核心状态：目录树节点、当前大纲、当前正文结果、引用列表、选中节点
- `chatStore` — 会话列表、消息列表

关键组件（`src/components/workbench/`）：
- `ChatPanel` — 快捷操作按钮（生成目录/大纲/正文/改写/扩写/精简）+ 消息流展示，调用 `useSSE`
- `DirectorySidebar` — 目录树，选中章节/节后触发大纲/正文生成
- `EditorPane` / `EditorTabs` — 正文展示与编辑（多 Tab）

API 调用统一走 `src/services/api.ts`（基于 ky），credentials 为 `include`（cookie 认证）。

### 数据库迁移

迁移文件在 `backend/migrations/`，使用 TypeORM CLI，`synchronize: false`（生产安全）。

## Environment Variables

后端 `.env`（`backend/.env`）关键变量：
```
DATABASE_HOST / DATABASE_PORT / DATABASE_USER / DATABASE_PASSWORD / DATABASE_NAME   # MySQL，默认 3306
REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
LLM_PROVIDER         # anthropic | deepseek（决定走哪个 provider）
ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL   # 默认 claude-sonnet-4-6
DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL     # 默认 deepseek-chat
EMBEDDING_PROVIDER / EMBEDDING_MODEL / EMBEDDING_DIMENSION # 向量化（当前检索未启用）
FRONTEND_URL         # CORS 白名单，默认 http://localhost:8002
UPLOAD_DIR           # 文件上传目录，默认 ./uploads
JWT_SECRET / JWT_REFRESH_SECRET / JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN
```

前端 `.env.local`（`frontend/.env.local`）：
```
NEXT_PUBLIC_API_URL=http://localhost:3002
```

## Test Accounts

所有账号密码统一为 `Test1234!`

| 邮箱 | 昵称 |
|------|------|
| verify@test.com | 验证用户 |
| m15test16170@test.com | M15测试 |
| m15user2_5569@test.com | 第二用户 |
| attacker@test.com | 攻击者 |
| newuser_1773820759@test.com | 新用户 |
| test@test.com | — |
| m15test@test.com | M15测试 |

## Key Patterns

- **文件解析**：上传后入 Bull 队列 `file-parse`，`parse.worker.ts` 消费，调用 `src/file/parsers/` 下对应解析器，解析结果写 `Document` 实体，再由 `ChunkService` 切块
- **切块**：`chunker.ts` 按段落合并，`search-tokenizer.ts` 生成 bigram 写 `search_terms` 字段
- **导出**：Bull 队列 `export`，`export.worker.ts` 消费，`src/export/generators/` 生成文件
- **SSE 心跳**：后端每 15s 发一次 heartbeat，前端 60s 无响应触发重连（最多 3 次）
- **目录保存时机**：目录 SSE done 后前端解析 JSON 并调 `/directory/save`，不是后端自动保存
