# 教材编写 Agent 全面优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有教材编写应用升级为安全、可部署、可恢复、具备 Hybrid RAG 和受控写作工作流的系统。

**Architecture:** 保留 NestJS/Next.js 模块化单体，拆分 API、worker、web 进程。MySQL 保存业务与 workflow 状态，Redis/Bull 调度任务，Qdrant 保存可重建的 dense 索引；LLM 通过自有 ModelGateway 接入确定性状态图。

**Tech Stack:** NestJS 11、TypeORM、MySQL 8.4、Bull/Redis、Qdrant、Next.js 14、Zustand、Jest、Vitest、Playwright。

## Global Constraints

- 仅修改和提交本地 `codex/full-optimization` 分支，不推送、不部署。
- 保留用户、refresh token 和 user settings；执行数据库 reconciliation 前确认所有业务表仍为空。
- 不提交 `.omc/`、coverage、SQL 备份、Playwright 快照和导出文件，不重写 Git 历史。
- 保持旧业务 API 的成功响应兼容，前端迁移完成前不删除旧生成接口。
- 每个行为变更严格执行 RED → GREEN → REFACTOR，并在独立提交前运行覆盖该任务的测试与构建。

---

### Task 1: 仓库卫生、配置校验与进程边界

**Files:**
- Modify: `.gitignore`
- Modify: `backend/package.json`
- Create: `backend/src/config/environment.ts`
- Create: `backend/src/config/environment.spec.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/.env.example`
- Modify: `docker-compose.yml`
- Modify: `ecosystem.config.cjs`
- Delete: tracked `*.backup` source copies

**Interfaces:**
- Produces: `validateEnvironment(config: Record<string, unknown>): Environment`
- Produces: PM2 processes `write-agent-api`, `write-agent-worker`, `write-agent-web`

- [ ] **Step 1: Write failing environment tests**

```ts
expect(() => validateEnvironment({ NODE_ENV: 'production', JWT_SECRET: '' }))
  .toThrow('JWT_SECRET');
expect(validateEnvironment(validConfig).DATABASE_PORT).toBe(3306);
```

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/config/environment.spec.ts --runInBand`
Expected: FAIL because `validateEnvironment` does not exist.

- [ ] **Step 3: Implement typed environment validation**

Require database, Redis, JWT and selected LLM provider variables. Allow documented local defaults only in development. Wire `ConfigModule.forRoot({ validate: validateEnvironment })`.

- [ ] **Step 4: Add non-mutating lint and align local services**

Add `"lint:check": "eslint \"{src,apps,libs,test}/**/*.ts\""`; bind MySQL, Redis and Qdrant to `127.0.0.1`; use environment interpolation for secrets. Configure PM2 API/worker/web names without starting Docker services.

- [ ] **Step 5: Clean Git index**

Remove tracked SQL backups, `.playwright-cli`, `.playwright-mcp`, exported DOCX and source backup copies from the index while keeping ignored local data. Do not touch untracked `README.md` or `AGENTS.md`.

- [ ] **Step 6: Verify and commit**

Run: `cd backend && npx jest src/config/environment.spec.ts --runInBand && npm run build && npm run lint:check`
Run: `docker compose config -q && git diff --check`
Commit: `chore: establish repository and configuration baseline`

### Task 2: 统一项目授权与资源归属

**Files:**
- Create: `backend/src/project/project-access.policy.ts`
- Create: `backend/src/project/project-access.policy.spec.ts`
- Modify: content and style-template controllers/services
- Modify: `backend/src/project/project.module.ts`

**Interfaces:**
- Produces: `ProjectAccessPolicy.assertOwner(userId: string, projectId: string): Promise<Project>`
- Produces: resource service methods requiring `(userId, projectId, resourceId)`

- [ ] **Step 1: Write failing ownership tests**

Cover owner success, foreign project 403, directory/outline/content/style resource outside owned project 404, and style creation unable to delete another project's templates.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/project/project-access.policy.spec.ts src/content/content.service.spec.ts --runInBand`
Expected: FAIL on missing policy and unguarded resource calls.

- [ ] **Step 3: Implement policy and propagate actor context**

All affected controllers receive `@CurrentUser()`. Services assert project ownership before repository access and include `project_id` in resource lookup/update predicates.

- [ ] **Step 4: Verify and commit**

Run: `cd backend && npm test -- --runInBand && npm run build`
Commit: `fix: enforce project resource ownership`

### Task 3: 上传前授权、文件校验和失败清理

**Files:**
- Create: `backend/src/file/guards/project-upload.guard.ts`
- Create: `backend/src/file/file-upload.spec.ts`
- Modify: `backend/src/file/file.controller.ts`
- Modify: `backend/src/file/file.service.ts`
- Modify: `backend/src/file/file.module.ts`

**Interfaces:**
- Produces: guard validating project ownership before Multer interceptor
- Produces: upload limits of 50 files/request, 50 MiB/file and configurable per-user quota

- [ ] **Step 1: Write failing upload tests**

Verify foreign project and unsupported MIME/extension leave no file, valid upload moves from quarantine to project storage, and service exceptions clean temporary files.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/file/file-upload.spec.ts --runInBand`
Expected: FAIL because files are currently written before authorization and not cleaned.

- [ ] **Step 3: Implement guard and quarantine flow**

Guards run before interceptors. Write authorized uploads into a temporary quarantine directory, validate extension, MIME and magic bytes, then atomically move. Always unlink temporary files on error.

- [ ] **Step 4: Verify and commit**

Run: `cd backend && npx jest src/file/file-upload.spec.ts --runInBand && npm run build`
Commit: `fix: secure file upload lifecycle`

### Task 4: 修复迁移基线与版本并发

**Files:**
- Modify: `backend/migrations/1710700000000-InitSchema.ts`
- Modify: later historical migrations to be idempotent
- Create: `backend/migrations/1712100000000-ReconcileApplicationSchema.ts`
- Create: `backend/test/migrations.e2e-spec.ts`
- Modify: directory/outline/content version services

**Interfaces:**
- Produces: fresh and existing-empty-schema migration paths
- Produces: unique scoped version constraints and transactional current pointer updates

- [ ] **Step 1: Write failing migration and concurrency tests**

The migration test starts MySQL, runs all migrations from empty, compares required columns/indexes, and upgrades a fixture matching the inspected current schema. Concurrency tests create two versions simultaneously and assert unique version numbers plus one current version.

- [ ] **Step 2: Run RED**

Run: `cd backend && npm run test:e2e -- migrations.e2e-spec.ts`
Expected: FAIL on duplicate columns and entity/schema drift.

- [ ] **Step 3: Implement safe reconciliation**

Preserve auth tables. Abort if any application-domain table contains rows. Rebuild empty application tables to match entities, add foreign keys/indexes, and make historical fresh-install migrations idempotent.

- [ ] **Step 4: Make version writes transactional**

Use a transaction and locking/unique constraints instead of `count + 1`; change current version and project state in the same transaction.

- [ ] **Step 5: Verify and commit**

Run: migration E2E on fresh and current-schema fixture, `npm test -- --runInBand`, `npm run build`.
Commit: `fix: establish reproducible schema and versioning`

### Task 5: Workflow persistence model and API

**Files:**
- Create: `backend/src/workflow/` module, entities, DTOs, controller and service
- Create: workflow migration
- Create: `backend/src/workflow/workflow.service.spec.ts`
- Modify: `backend/src/app.module.ts`

**Interfaces:**
- `POST /api/projects/:projectId/workflows`
- `GET /api/projects/:projectId/workflows/:jobId`
- `GET /api/projects/:projectId/workflows/:jobId/events`
- `POST /api/projects/:projectId/workflows/:jobId/cancel`
- `POST /api/projects/:projectId/workflows/:jobId/approve`
- Event: `{ id, job_id, seq, type, data, created_at }`

- [ ] **Step 1: Write failing job state and idempotency tests**

Cover create, duplicate idempotency key returning the same job, ownership, legal transitions, cancel request and monotonically increasing event sequence.

- [ ] **Step 2: Run RED**

Run: `cd backend && npx jest src/workflow/workflow.service.spec.ts --runInBand`
Expected: FAIL because workflow module does not exist.

- [ ] **Step 3: Implement entities, state machine and endpoints**

Create `workflow_jobs`, `workflow_events`, `model_runs`; enforce transition guards and project ownership. Event SSE reads persisted rows after `Last-Event-ID`.

- [ ] **Step 4: Verify and commit**

Run workflow tests, full backend tests/build and migration smoke.
Commit: `feat: add persistent workflow jobs`

### Task 6: Worker execution、SSE recovery and cancellation

**Files:**
- Create: `backend/src/worker-main.ts`
- Create: `backend/src/workflow/workflow.processor.ts`
- Modify: LLM providers for AbortSignal
- Modify: legacy generation controllers as compatibility adapters
- Create: workflow recovery integration tests

**Interfaces:**
- Produces: `WorkflowEngine.run(jobId: string): Promise<void>`
- Produces: persisted cancel token and provider AbortSignal

- [ ] **Step 1: Write failing recovery tests**

Cover disconnect/reconnect after cursor, process restart from checkpoint, cancel during streaming, no STOPPED→SUCCEEDED reversal, and legacy endpoint compatibility.

- [ ] **Step 2: Run RED**

Run targeted workflow integration suite; expect recovery and cancellation failures.

- [ ] **Step 3: Implement processor and compatibility layer**

API creates jobs; worker consumes them. Every node and stream loop checks cancellation. Legacy endpoints delegate without removing old routes.

- [ ] **Step 4: Verify and commit**

Run workflow integration, full backend tests/build.
Commit: `feat: make generation workflows recoverable`

### Task 7: Typed ModelGateway and structured output

**Files:**
- Create: `backend/src/llm/model-gateway.ts`
- Create: `backend/src/llm/model-types.ts`
- Modify: Anthropic and DeepSeek adapters
- Modify: agent chains to consume provider-neutral events
- Create: LLM contract tests

**Interfaces:**
- `ModelRequest` includes messages, schema, temperature, max tokens, timeout, signal and trace metadata
- `ModelEvent` includes text delta, tool call, usage, completion and provider error

- [ ] **Step 1: Write failing adapter contract tests**

Both providers must emit identical model events, honor AbortSignal and expose usage/finish reason.

- [ ] **Step 2: Run RED**

Run LLM contract tests; expect failure on `AsyncIterable<any>` and Anthropic-shaped DeepSeek output.

- [ ] **Step 3: Implement ModelGateway**

Normalize providers, validate structured output against schema, retry only timeout/429/5xx with bounded backoff, and persist model run metrics.

- [ ] **Step 4: Verify and commit**

Run LLM/agent tests and backend build.
Commit: `refactor: introduce typed model gateway`

### Task 8: Versioned document AST and idempotent ingestion

**Files:**
- Modify: document/chunk/source-file entities and migration
- Create: AST contracts and parser fixtures
- Modify: PDF/DOCX/PPTX/Markdown parsers
- Modify: parse worker and chunk service

**Interfaces:**
- AST block: `{ block_id, type, text, heading_path, page_start, page_end, offsets, metadata }`
- Chunk identity: file checksum + parser version + chunk version + chunk index

- [ ] **Step 1: Write failing parser and duplicate-consumption tests**

Fixtures assert heading path, page/slide range, tables/lists when available, stable offsets and no duplicate document/chunks after repeated jobs.

- [ ] **Step 2: Run RED**

Run parser/ingestion tests; expect missing AST metadata and duplicate writes.

- [ ] **Step 3: Implement AST and token-aware parent-child chunking**

Preserve structural boundaries, store parent/child relationships and token counts, and atomically switch active ingestion version.

- [ ] **Step 4: Verify and commit**

Run parser, chunk, worker tests and backend build.
Commit: `feat: add versioned structured ingestion`

### Task 9: Hybrid retrieval、Qdrant and evaluation

**Files:**
- Add Qdrant service/config
- Create sparse, dense, fusion, rerank and context-builder components
- Create retrieval run entities/migration
- Create `backend/evaluation/rag/` fixtures and runner

**Interfaces:**
- `EvidenceItem` includes evidence ID, chunk, source metadata, sparse/dense/fusion/rerank scores and exact span
- Pipeline: sparse top40 + dense top40 → RRF → rerank → MMR/source cap → top8–12

- [ ] **Step 1: Write failing retrieval tests**

Cover task-aware queries, Chinese term cap, deterministic RRF, source diversity, Qdrant degradation, strict error states and context token budget.

- [ ] **Step 2: Run RED**

Run retrieval unit/integration tests; expect current LIKE-only path to fail requirements.

- [ ] **Step 3: Implement shadow hybrid pipeline**

Use MySQL FULLTEXT sparse candidates and Qdrant dense candidates. Record retrieval runs and compare old/new results without changing production selection.

- [ ] **Step 4: Establish baseline and switch**

Run Chinese教材 evaluation; record Recall@K, nDCG, context precision, latency and cost. Switch canonical path only when hybrid is not worse on relevance and stays within documented latency budget.

- [ ] **Step 5: Verify and commit**

Run retrieval tests, evaluation and backend build.
Commit: `feat: add evaluated hybrid retrieval`

### Task 10: Claim-evidence ledger and strict grounding

**Files:**
- Modify citation entities/migration/service
- Modify content prompt/context contracts
- Create grounding verifier tests

**Interfaces:**
- Citation stores claim text, exact evidence span, offsets, retrieval run, rank/scores, support status and support score
- Retrieval states: `NO_HIT | DEGRADED | ERROR | READY`

- [ ] **Step 1: Write failing citation support tests**

Verify foreign/missing evidence rejection, unsupported claim detection, exact span persistence, material gap on strict mode and deterministic GB/T rendering.

- [ ] **Step 2: Run RED**

Run citation/grounding tests; expect hardcoded confidence behavior to fail.

- [ ] **Step 3: Implement evidence IDs and verifier**

Writer may cite only assigned evidence IDs. Validate ownership and offsets, then run bounded semantic support review; unsupported claims trigger retrieval/revision or material gap.

- [ ] **Step 4: Verify and commit**

Run citation/content tests and backend build.
Commit: `feat: make citations evidence verifiable`

### Task 11: Deterministic authoring workflow graph

**Files:**
- Create workflow nodes and typed state
- Refactor directory/outline/content/revision services into workflow tools
- Add schema, domain, style and consistency validators
- Create workflow graph tests

**Interfaces:**
- Graph nodes: access → snapshot → plan retrieval → retrieve → evidence gate → draft → validate → review → repair(max 2) → approval → persist
- Directory/outline require approval; content remains draft until accepted

- [ ] **Step 1: Write failing graph tests**

Cover success path, schema repair, maximum repair count, evidence gap pause, cancellation, approval, revision constraints and transactional persist.

- [ ] **Step 2: Run RED**

Run graph tests; expect current single-call chains to fail.

- [ ] **Step 3: Implement typed graph**

LLM nodes return structured proposals only. Authorization, transitions, versioning, validation and persistence remain deterministic services.

- [ ] **Step 4: Verify and commit**

Run workflow/agent/content tests and backend build.
Commit: `feat: orchestrate grounded authoring workflows`

### Task 12: Frontend workflow migration and feature boundaries

**Files:**
- Create feature modules for authoring/workflows/materials/citations
- Split `useChatOperations.ts` and `EditorPane.tsx`
- Generate or update typed API client
- Add workflow store and E2E tests

**Interfaces:**
- Frontend creates workflow, subscribes by job ID/cursor, restores active jobs after refresh, cancels/approves by job ID

- [ ] **Step 1: Write failing store and E2E tests**

Cover refresh recovery, cancel, approval, server-authoritative directory save, error/material-gap UI and normal login→upload→directory→outline→content→export path.

- [ ] **Step 2: Run RED**

Run Vitest and selected Playwright tests; expect current request-bound SSE behavior to fail.

- [ ] **Step 3: Implement feature modules and migration**

Keep visual behavior stable. Move orchestration out of components, consume generated contracts and make server versions authoritative.

- [ ] **Step 4: Verify and commit**

Run frontend tests/build/E2E and backend compatibility tests.
Commit: `refactor: migrate web app to persistent workflows`

### Task 13: Observability、health checks and final report

**Files:**
- Add health/readiness and structured logging modules
- Add workflow/retrieval/model metrics
- Update operational documentation
- Create final optimization report

**Interfaces:**
- Health covers API, MySQL, Redis, Bull worker, Qdrant and selected LLM configuration
- Logs correlate request ID, job ID, node, model run and retrieval run without logging source documents or secrets

- [ ] **Step 1: Write failing health and redaction tests**

Assert dependency-specific readiness, correlation propagation and secret/document redaction.

- [ ] **Step 2: Implement observability**

Add structured logs and metrics for workflow success, latency, recovery, cancellation, token/cost, retrieval quality and material gaps.

- [ ] **Step 3: Run final verification**

Run backend tests/build/lint, frontend tests/build/E2E, fresh/current migration smoke, Docker health, PM2 status and main user flow.

- [ ] **Step 4: Write report and commit**

Report commits, architecture changes, test evidence, RAG before/after metrics, dependency audit findings, remaining risks and recommended next work.
Commit: `docs: report full project optimization`
