# 教材编写Agent 后端开发方案

> 面向 NestJS、任务队列、RAG、流式生成与部署的实施文档。聚焦模块边界、服务职责、任务流与后端排期。

---

## 一、后端职责边界

MVP 阶段由 NestJS 统一承载业务后端：

- 认证、项目、文件、解析、检索、写作、引用、导出、会话管理
- 统一对外暴露 `/api/*`
- 统一负责 SSE 流式接口
- 统一管理数据库、Redis、文件存储与 LLM 接入

固定约束：

- 目录/大纲/正文生成为在线直连流式任务
- BullMQ 仅用于文件解析与导出
- 生成类并发由进程内并发上限或 Redis 分布式锁控制

---

## 二、后端技术栈

| 选项 | 选型 | 说明 |
|:---|:---|:---|
| API 框架 | NestJS | 模块化、依赖注入、Swagger 集成 |
| ORM | TypeORM | Migration 与实体管理 |
| 数据库 | PostgreSQL 16 + pgvector | 结构化数据 + 向量检索 |
| 缓存/队列 | Redis 7 + BullMQ | 解析与导出异步任务 |
| Agent | LangChain.js + 自定义 Chain | 目录/大纲/正文生成 |
| 文件解析 | pdf-parse、mammoth、pptx-parser | PDF / DOCX / PPTX |
| 日志 | Pino | 结构化日志 |

---

## 三、系统架构与核心流程

### 3.1 服务链路

1. 前端调用 `/api/*`
2. Nginx 反代到 NestJS
3. NestJS 进行认证、参数校验、业务调度
4. 检索服务完成素材召回
5. Agent 引擎组装上下文后调用 LLM
6. 生成结果通过 SSE 流式输出
7. 引用映射增量入库
8. 最终结果落库并返回结果 ID

### 3.2 多轮上下文

上下文三层：

- 项目上下文：`projects`
- 结构上下文：`project_states` + 当前目录/大纲版本
- 会话上下文：`messages` + Redis 滑动窗口

策略：

- 保留最近 20 轮会话消息
- 始终注入项目定位与当前章节上下文
- 历史消息超限后按时间淘汰

---

## 四、后端模块拆解

### 4.1 AuthModule

职责：

- 注册
- 登录
- refresh token 刷新
- 退出登录
- 修改密码

关键点：

- access token / refresh token 通过 httpOnly Cookie 返回
- refresh token 只存 hash，不存明文
- 退出登录时撤销 refresh token

### 4.2 ProjectModule

职责：

- 项目 CRUD
- 项目状态管理
- 当前目录版本绑定
- 项目级设置维护

### 4.3 FileModule + ParseWorker

职责：

- 接收文件上传
- 保存文件元数据
- 推入解析队列
- 执行 PDF / DOCX / PPTX / MD / TXT 解析
- 产出 `documents`

关键点：

- 文件表先写入，解析异步进行
- 解析状态：`pending/parsing/done/failed`
- 重解析时需清理旧 `documents/chunks/citations` 关联数据

### 4.4 ChunkModule

职责：

- 文档切块
- 关键词提取
- 搜索词归一化
- embedding 写入

MVP 检索数据准备：

- `keywords`
- `search_terms`
- `embedding`

### 4.5 RetrievalModule

职责：

- 查询预处理
- 应用层中文分词
- `ILIKE` / `search_terms` 关键词召回
- pgvector 语义召回
- RRF 混合排序

关键点：

- MVP 不依赖 PostgreSQL 中文分词扩展
- 统一返回 chunk、分数、文件信息、页码

### 4.6 AgentModule

职责：

- 统一调度目录、大纲、正文三类 Chain
- 组织 Prompt
- 注入项目/目录/大纲/素材上下文
- 控制流式生成输出

子模块：

- `directory.chain.ts`
- `outline.chain.ts`
- `content.chain.ts`

### 4.7 ContentModule

职责：

- 正文生成
- 改写 / 扩写 / 精简
- 正文结果保存
- 正文版本链维护

关键点：

- 每次生成请求对应一条 `writing_results`
- AI 初始内容保存为首个 `content_versions`
- 用户人工编辑后可继续新增版本

### 4.8 CitationModule

职责：

- 接收段落级引用信息
- 增量写入 `citation_maps`
- 生成结束后做完整校验

关键点：

- 使用 `paragraph_key` 对齐正文段落
- 低置信度引用标记待人工确认

### 4.9 ExportModule

职责：

- 创建导出任务
- 汇总目录、大纲、正文、引用
- 生成 Word / Markdown
- 返回下载链接

关键点：

- 导出异步进行
- Word 文档需要统一样式模板

### 4.10 SessionModule

职责：

- 创建/列出/删除会话
- 获取消息历史
- 维护工作台上下文

---

## 五、SSE 与生成任务设计

### 5.1 事件类型

后端生成类接口统一发送：

- `meta`
- `token`
- `citation`
- `done`
- `error`
- `heartbeat`

### 5.2 生成状态

`writing_results.status` 取值：

- `streaming`
- `succeeded`
- `failed`
- `stopped`

### 5.3 中断处理

- 前端中断请求后，后端应尽快停止上游流
- 已生成内容可以保留
- 最终结果状态需落库

---

## 六、项目结构建议

```text
backend/
├── src/
│   ├── auth/
│   ├── project/
│   ├── file/
│   ├── chunk/
│   ├── retrieval/
│   ├── agent/
│   ├── content/
│   ├── citation/
│   ├── export/
│   ├── session/
│   ├── common/
│   └── config/
├── migrations/
└── tests/
```

关键实体：

- `project.entity.ts`
- `source-file.entity.ts`
- `document.entity.ts`
- `chunk.entity.ts`
- `directory-version.entity.ts`
- `outline-version.entity.ts`
- `writing-result.entity.ts`
- `content-version.entity.ts`
- `citation-map.entity.ts`
- `export-job.entity.ts`
- `session.entity.ts`
- `message.entity.ts`
- `refresh-token.entity.ts`

---

## 七、环境变量与部署

### 7.1 环境变量

```env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=writing_agent
DATABASE_USER=postgres
DATABASE_PASSWORD=your_password

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
ACCESS_TOKEN_COOKIE_NAME=wa_access_token
REFRESH_TOKEN_COOKIE_NAME=wa_refresh_token

LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_api_key
ANTHROPIC_MODEL=claude-sonnet-4-20250514
OPENAI_API_KEY=your_backup_api_key

EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

UPLOAD_DIR=./uploads
MAX_FILE_SIZE=50mb

PORT=3001
FRONTEND_URL=http://localhost:3000
API_BASE_PATH=/api
NODE_ENV=development
```

### 7.2 Docker Compose

MVP 服务：

- `postgres`
- `redis`
- `backend`
- `frontend`
- `nginx`

### 7.3 Nginx 职责

- 页面流量转发给 Next.js
- `/api/*` 转发给 NestJS
- 统一处理 HTTPS / 域名入口

---

## 八、后端开发计划

### 8.1 MVP 任务

| 编号 | 任务 | 产出 |
|:---|:---|:---|
| B1 | NestJS + TypeORM + PostgreSQL 脚手架 | 可运行空服务 |
| B2 | Migration 与 Schema | 表结构就绪 |
| B3 | AuthModule | 登录注册刷新退出可用 |
| B4 | ProjectModule | 项目 CRUD 可用 |
| B5 | FileModule | 文件上传与元数据记录 |
| B6 | ParseWorker | 文件解析队列 |
| B7 | ChunkModule | 切块与 embedding |
| B8 | RetrievalModule | 混合检索可用 |
| B9 | DirectoryModule | 目录生成与版本 |
| B10 | OutlineModule | 大纲生成与版本 |
| B11 | ContentModule | 正文/改写/扩写/精简 |
| B12 | CitationModule | 引用映射与查询 |
| B13 | ExportModule | Word / Markdown 导出 |
| B14 | SSE 基础设施 | 统一流式输出 |
| B15 | BullMQ 队列 | 解析与导出异步执行 |

### 8.2 执行顺序

- Week 1：B1 → B2 → B3 → B4 → B5 → B6
- Week 2：B7 → B8 → B9 → B10 → B11 → B14
- Week 3：B12 → B13 → B15 + 联调

---

## 九、测试建议

| 类型 | 工具 | 重点 |
|:---|:---|:---|
| 单元测试 | Jest | 检索、切块、引用、JWT |
| 集成测试 | Supertest | 认证、项目、文件、导出 |
| 性能测试 | 自定义压测 | 检索时间、SSE 首字节、导出速度 |

重点验证：

- 文件上传 → 解析 → 切块全链路
- 检索 → 生成 → 引用全链路
- Cookie 鉴权流程
- 流式正文与中断后的状态一致性

---

## 十、风险与实现注意事项

| 风险 | 处理方式 |
|:---|:---|
| 扫描版 PDF 解析差 | MVP 只保证文字型 PDF，扫描版提示 OCR |
| 中文全文检索效果差 | 应用层分词 + `search_terms`，不依赖 PG 中文扩展 |
| LLM 脱离素材发挥 | Prompt 约束 + 引用覆盖率校验 |
| 长文本重复/截断 | 分段生成 + 后处理检查 |
| 并发生成过高 | Redis 锁或并发上限控制 |

---

## 十一、与其他文档关系

- 前端实现细节见 [教材编写Agent_前端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_前端开发方案.md)
- 接口、DTO、数据库契约见 [教材编写Agent_接口与数据库契约.md](/Users/kang/Desktop/write-agent/教材编写Agent_接口与数据库契约.md)
