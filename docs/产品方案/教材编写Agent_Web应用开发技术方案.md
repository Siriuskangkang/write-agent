# 教材编写Agent Web应用开发技术方案

> 基于《教材编写Agent》系列产品文档，面向AI开发团队（Claude Code / Codex）的可执行开发方案

> 已按职责拆分为三份独立文档，建议后续优先维护拆分版：
> - [教材编写Agent_前端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_前端开发方案.md)
> - [教材编写Agent_后端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_后端开发方案.md)
> - [教材编写Agent_接口与数据库契约.md](/Users/kang/Desktop/write-agent/教材编写Agent_接口与数据库契约.md)

---

## 一、系统架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户浏览器（SPA）                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ 项目管理  │  │ 素材管理  │  │ 写作工作台 │  │ 导出/设置    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       └──────────────┴─────────────┴───────────────┘           │
│                          │ HTTP/SSE                             │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                     Nginx 反向代理                               │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                   后端 API 服务 (Node.js)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ 认证模块  │  │ 项目服务  │  │ 文件服务  │  │ 导出服务     │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ 解析服务  │  │ 检索服务  │  │ 写作服务  │  │ 引用服务     │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────────┘   │
│       │             │             │                             │
│       ▼             ▼             ▼                             │
│  ┌──────────────────────────────────────┐                      │
│  │         Agent 核心引擎 (LangChain)    │                      │
│  │  ┌────────┐ ┌────────┐ ┌──────────┐ │                      │
│  │  │目录Agent│ │大纲Agent│ │正文Agent  │ │                      │
│  │  └────────┘ └────────┘ └──────────┘ │                      │
│  └──────────────────────────────────────┘                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                       数据层                                     │
│  ┌──────────┐  ┌──────────────┐  ┌────────┐  ┌─────────────┐  │
│  │PostgreSQL │  │Milvus/Qdrant │  │ Redis  │  │ MinIO/本地   │  │
│  │ 业务数据  │  │  向量检索     │  │ 缓存   │  │ 文件存储     │  │
│  └──────────┘  └──────────────┘  └────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────┐
│                     外部服务                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ LLM API      │  │ Embedding API │  │ 文件解析服务          │  │
│  │ (Claude等)   │  │ (OpenAI等)    │  │ (PDF/DOCX/PPTX)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1.1 架构边界决策（MVP固定方案）

为避免前后端重复实现一层 BFF，本项目在 MVP 阶段采用以下固定边界：

- **前端渲染层**：Next.js 14，仅负责页面渲染、路由、客户端状态管理，不承载业务型 BFF
- **后端业务层**：NestJS 统一提供全部业务 API、SSE 流式接口、文件上传接口
- **对外访问入口**：Nginx 统一暴露域名；页面请求转发到 Next.js，`/api/*` 统一反向代理到 NestJS
- **浏览器调用方式**：前端始终使用同源相对路径调用后端，例如 `/api/projects`、`/api/auth/login`
- **认证传递方式**：浏览器与后端通过 httpOnly Cookie 传递 access token / refresh token，不在前端持久化 token

因此，文档中提到的 “Next.js API Routes 可做 BFF” 仅作为后续扩展预留，不纳入 MVP 实施范围。

### 1.2 核心流程：用户发消息全链路

```
用户输入 "为第三章生成正文"
       │
       ▼
[前端] 解析意图 → 构造请求 → POST /api/projects/{id}/content/generate
       │
       ▼
[后端] 认证校验 → 参数校验 → 路由到写作服务
       │
       ▼
[写作服务] 识别任务类型(正文生成) → 构造检索查询
       │
       ▼
[检索服务] 关键词检索 + 语义检索 → 多路召回 → 重排序 → 返回 Top-K chunks
       │
       ▼
[Agent引擎] 组装上下文(项目定位+目录+大纲+检索结果) → 调用LLM → 流式生成
       │
       ▼
[引用服务] 记录 citation_map(正文段落 ↔ 素材chunk映射)
       │
       ▼
[后端] SSE 流式推送正文 + 引用信息 → 前端
       │
       ▼
[前端] 打字机效果渲染正文 + 右侧栏展示出处 + 保存到本地状态
```

### 1.3 多轮对话上下文维护机制

教材编写Agent不是通用聊天，而是项目制长任务。上下文分三层管理：

| 层级 | 内容 | 存储位置 | 生命周期 |
|:---|:---|:---|:---|
| 项目上下文 | 教材定位、目标读者、风格要求 | PostgreSQL `projects` 表 | 项目存续期 |
| 结构上下文 | 当前目录版本、已完成章节、大纲 | PostgreSQL `project_state` 表 | 随项目迭代更新 |
| 会话上下文 | 当前对话的最近N轮消息 | Redis + PostgreSQL `messages` 表 | 会话级，滑动窗口截断 |

截断策略：会话消息保留最近20轮，超出后按时间淘汰，但始终注入项目上下文和当前章节上下文作为 system prompt。

### 1.4 错误处理与降级方案

| 场景 | 用户体验设计 | 技术方案 |
|:---|:---|:---|
| LLM API 超时 | 显示"生成中，请稍候..."，30s后提示重试 | SSE 心跳保活，超时自动重试1次 |
| LLM API 不可用 | 提示"AI服务暂时不可用"，保留用户输入 | 降级到缓存的上次生成结果 |
| 文件解析失败 | 标记文件为"解析失败"，提示用户检查格式 | 异步队列重试3次，记录错误日志 |
| 检索无结果 | 提示"当前素材中未找到相关内容" | 返回空结果+素材不足标记 |
| 网络中断 | 前端自动重连，恢复未完成的流式响应 | SSE 断线重连 + 消息ID续传 |

补充约束：

- 目录/大纲/正文生成在 MVP 阶段为**在线直连流式任务**，不进入 BullMQ 队列
- BullMQ 仅用于文件解析和导出任务；生成类任务的并发控制由后端内存信号量或 Redis 分布式锁实现
- “降级到缓存的上次生成结果”仅适用于用户主动重新打开历史结果，不适用于一次新的生成请求自动替代

---

## 二、技术栈选型

### 2.1 前端层

| 选项 | 选型 | 理由 |
|:---|:---|:---|
| 框架 | Next.js 14 (App Router) | SSR/SSG支持、文件路由、React生态成熟；MVP阶段不承担BFF职责 |
| UI组件库 | Ant Design 5.x | 中文友好、表格/树/表单组件丰富、适合工作台类应用 |
| 状态管理 | Zustand | 轻量、无boilerplate、适合中等复杂度状态管理 |
| 流式响应 | `fetch` + `ReadableStream` 解析 SSE 事件流 | 生成接口均为 `POST`，便于携带请求体、Cookie认证和 `AbortController` 中断 |
| Markdown渲染 | react-markdown + rehype-highlight | 支持代码高亮、表格、自定义组件扩展 |
| 富文本编辑 | Tiptap | 基于ProseMirror，可扩展性强，支持协同编辑预留 |
| HTTP客户端 | ky (基于fetch) | 轻量、支持hooks、TypeScript友好 |
| 会话存储 | 服务端为主 + localStorage缓存 | 多设备同步，离线时有本地缓存兜底 |

设计理由：教材编写是重交互的工作台应用，不是简单聊天界面。Ant Design的Tree、Table、Tabs组件天然适合目录树、素材列表、多标签写作区。MVP阶段由 NestJS 直接承载业务接口，减少前后端职责重叠。

### 2.2 后端层

| 选项 | 选型 | 理由 |
|:---|:---|:---|
| API框架 | NestJS (Node.js) | TypeScript原生、模块化架构、依赖注入、适合中大型项目 |
| Agent框架 | LangChain.js + 自定义Chain | 成熟的RAG链路支持、Tool调用、流式输出、TypeScript生态 |
| LLM调用 | Claude API (主) / OpenAI (备) | Claude长上下文能力强，适合教材长文本生成 |
| 文件解析 | pdf-parse + mammoth + pptx-parser | 覆盖PDF/DOCX/PPTX三大格式，Node.js原生 |
| 任务队列 | BullMQ (Redis) | 文件解析异步化、导出任务异步化 |
| 认证 | JWT + bcrypt | 简单可靠，适合MVP阶段 |
| API文档 | Swagger (NestJS内置) | 自动生成，前后端联调效率高 |

设计理由：NestJS的模块化架构天然适合按文档中定义的服务拆分（项目服务、文件服务、解析服务、检索服务、写作服务、引用服务、导出服务）。LangChain.js提供成熟的RAG pipeline，避免从零搭建检索增强生成链路。

### 2.3 数据层

| 选项 | 选型 | 理由 |
|:---|:---|:---|
| 主数据库 | PostgreSQL 16 | 成熟稳定、JSON支持好、pgvector扩展可做向量检索 |
| 向量检索 | pgvector (MVP) → Qdrant (扩展) | MVP阶段用pgvector减少运维复杂度，后续可迁移到专用向量库 |
| 缓存 | Redis 7 | 会话缓存、任务队列、热点数据缓存 |
| 文件存储 | MinIO (自建) / 本地文件系统 (MVP) | MVP用本地存储快速启动，后续迁移到MinIO支持分布式 |
| Embedding | OpenAI text-embedding-3-small | 性价比高、中文支持好、1536维 |

### 2.4 部署与运维

| 选项 | 选型 | 理由 |
|:---|:---|:---|
| 容器化 | Docker + Docker Compose | 一键启动全部服务，AI团队友好 |
| 反向代理 | Nginx | SSL终止、静态资源、负载均衡 |
| 进程管理 | PM2 (Node.js) | 自动重启、日志管理、集群模式 |
| 环境变量 | .env + dotenv | 简单直接，敏感信息不入库 |
| 日志 | Pino (结构化日志) | 高性能、JSON格式、便于后续接入ELK |
| 监控 | 健康检查API + PM2 monitor | MVP阶段够用 |

---

## 三、功能模块详细拆解

### 3.1 用户系统

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 登录页（邮箱+密码）、注册页（邮箱+密码+确认密码）；MVP阶段不做“忘记密码”页；登录态用 Zustand 管理用户信息，认证凭证仅由浏览器自动携带 Cookie；未登录自动跳转登录页 |
| 后端实现 | `AuthModule`：注册（bcrypt加密存储）、登录（签发 access token + refresh token）、刷新token、退出登录、修改密码；`AuthGuard` 全局守卫校验token |
| API接口 | `POST /api/auth/register` 注册<br>`POST /api/auth/login` 登录<br>`POST /api/auth/refresh` 刷新token<br>`POST /api/auth/logout` 退出登录<br>`PUT /api/auth/password` 修改密码 |
| 数据结构 | `users` 表：id, email, password_hash, nickname, created_at, updated_at |
| 用户体验 | 登录后直接进入项目列表页；token过期静默刷新，用户无感知；密码强度实时提示；刷新页面不丢登录态 |
| 验收标准 | 注册→登录→进入系统→刷新页面不掉线→退出登录 全流程通过 |

### 3.2 项目管理

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 项目列表页（卡片式布局，展示教材名称/类型/进度/更新时间）；新建项目弹窗（表单：教材名称、类型、面向对象、目标章节数、风格要求）；项目详情页即写作工作台入口 |
| 后端实现 | `ProjectModule`：CRUD操作 + 项目状态管理；每个项目独立的 project_state 记录当前进度 |
| API接口 | `POST /api/projects` 创建项目<br>`GET /api/projects` 项目列表<br>`GET /api/projects/:id` 项目详情<br>`PUT /api/projects/:id` 更新项目<br>`DELETE /api/projects/:id` 删除项目<br>`GET /api/projects/:id/state` 获取项目状态 |
| 数据结构 | `projects` 表：id, user_id, name, type, target_audience, target_chapters, style, status(draft/in_progress/completed), created_at, updated_at<br>`project_states` 表：id, project_id, current_directory_version_id, completed_chapters(jsonb), pending_items(jsonb), updated_at |
| 用户体验 | 项目卡片一眼看到进度（已完成3/10章）；最近编辑的项目排最前；删除需二次确认 |
| 验收标准 | 创建项目→项目列表展示→进入项目→更新信息→状态正确显示 |

### 3.3 素材上传与管理

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 拖拽上传区域（支持批量）；素材列表表格（文件名、类型、大小、解析状态、上传时间）；解析状态实时轮询更新（pending→parsing→done/failed）；支持删除和重新解析 |
| 后端实现 | `FileModule`：文件接收（multer）→ 存储到本地/MinIO → 记录元数据 → 推入BullMQ解析队列<br>`ParseWorker`：消费队列 → 根据文件类型调用对应解析器(pdf-parse/mammoth/pptx-parser) → 提取文本+元数据 → 写入documents表 |
| API接口 | `POST /api/projects/:id/files` 上传文件(multipart/form-data)<br>`GET /api/projects/:id/files` 素材列表<br>`GET /api/projects/:id/files/:fileId/parse-result` 解析结果<br>`POST /api/projects/:id/files/:fileId/reparse` 重新解析<br>`DELETE /api/projects/:id/files/:fileId` 删除素材 |
| 数据结构 | `source_files` 表：id, project_id, file_name, file_type(pdf/docx/pptx/md/txt), file_size, file_path, parse_status(pending/parsing/done/failed), error_message, uploaded_at<br>`documents` 表：id, file_id, project_id, title, content_text, page_count, sections(jsonb), parsed_at |
| 用户体验 | 上传后立即显示在列表中（状态：解析中）；解析完成自动刷新状态；失败文件红色标记+错误原因提示；支持5种格式的图标区分 |
| 验收标准 | 批量上传PDF/DOCX/PPTX/MD/TXT → 全部解析成功 → 列表正确展示 → 删除后列表更新 |

### 3.4 切块与知识库构建

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 素材详情页可查看切块结果列表（chunk内容预览、来源页码、关键词标签）；支持按关键词筛选chunk |
| 后端实现 | `ChunkModule`：文档解析完成后自动触发切块 → 按标题/段落切分(每块300-800字) → 提取关键词 → 调用Embedding API生成向量 → 写入chunks表+pgvector索引 |
| API接口 | `GET /api/projects/:id/chunks` 素材片段列表(支持keyword/file_id筛选)<br>`GET /api/projects/:id/chunks/:chunkId` 片段详情 |
| 数据结构 | `chunks` 表：id, project_id, file_id, document_id, chunk_index, content, section_title, page_number, keywords(text[]), search_terms(text[]), embedding(vector(1536)), created_at |
| 用户体验 | 用户一般不直接操作此模块，但可在素材详情中查看"系统如何理解了这份素材"，增强信任感 |
| 验收标准 | 一份20页PDF → 切分为30-60个chunk → 每个chunk有关键词和向量 → 可按关键词检索到 |

### 3.5 对话界面（写作工作台）

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 三栏布局工作台：<br>**左栏**：项目目录树（可折叠章节）+ 素材列表快捷入口 + 任务进度<br>**中栏**：写作交互区（对话式，上方为历史消息/生成结果，下方为输入框+快捷操作按钮）<br>**右栏**：检索结果与出处面板（当前生成内容关联的素材片段、来源文件、页码、使用方式）<br>顶部：项目名称 + 当前阶段标签 + 导出按钮 |
| 后端实现 | `ConversationModule`：管理会话消息历史；每条消息关联 project_id + session_id；消息类型区分(user/assistant/system) |
| API接口 | `POST /api/projects/:id/sessions` 创建会话<br>`GET /api/projects/:id/sessions` 会话列表<br>`GET /api/projects/:id/sessions/:sessionId/messages` 消息历史 |
| 数据结构 | `sessions` 表：id, project_id, user_id, title, created_at, updated_at<br>`messages` 表：id, session_id, role(user/assistant/system), content, message_type(chat/directory/outline/content), metadata(jsonb), created_at |
| 用户体验 | 工作台而非聊天窗口——用户始终能看到项目全貌（左栏目录树）和内容依据（右栏出处）；输入框上方有快捷按钮："生成目录"、"生成大纲"、"生成正文"、"改写"、"扩写"、"精简" |
| 验收标准 | 三栏布局响应式适配 → 左栏目录树可折叠 → 中栏消息正确渲染 → 右栏出处与中栏内容联动 |

### 3.6 流式响应与打字机效果

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 使用 `fetch` + `ReadableStream` 接收 `text/event-stream` 响应；逐字/逐句渲染到写作区；生成过程中显示"正在生成..."动画+停止按钮；通过 `AbortController` 主动中断请求；生成完毕后自动触发出处面板更新 |
| 后端实现 | 写作服务调用LLM时使用 `stream: true`；通过 SSE 事件流逐段推送给前端；事件类型固定为 `meta` / `token` / `citation` / `done` / `error` / `heartbeat`；正文生成过程中允许在段落完成后提前推送 citation 事件，支持右栏同步更新 |
| API接口 | 所有生成类接口（目录/大纲/正文/改写/扩写/精简）均支持流式返回<br>请求头：`Accept: text/event-stream`<br>`POST /api/projects/:id/content/generate` |
| 用户体验 | 打字机效果让用户感知"AI正在思考和写作"，而非等待空白；生成过程中可随时点击"停止"中断；右栏出处允许边生成边增量显示；生成完成后内容自动保存，无需手动操作 |
| 验收标准 | 发起生成请求 → 1秒内开始出现文字 → 逐字流畅渲染无卡顿 → 点击停止可中断 → 生成完毕自动保存 |

### 3.7 目录生成模块

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 点击"生成目录"按钮 → 弹窗确认教材定位信息（可修改）→ 流式生成目录 → MVP阶段先渲染为可浏览树形结构；目录版本历史下拉可切换；拖拽排序、增删改节点放入 Phase 2 |
| 后端实现 | `DirectoryModule`：接收生成请求 → 检索全项目素材主题分布 → 组装Prompt（项目定位+素材主题+教学逻辑要求）→ 调用LLM生成结构化目录JSON → 为每个章/节节点生成稳定 `node_id` → 保存为 `directory_version` → 记录各章对应素材依据 |
| API接口 | `POST /api/projects/:id/directory/generate` 生成目录(SSE)<br>`GET /api/projects/:id/directory` 获取当前目录<br>`POST /api/projects/:id/directory/save` 保存用户编辑后的目录<br>`GET /api/projects/:id/directory/versions` 目录版本列表 |
| 数据结构 | `directory_versions` 表：id, project_id, version_number, content(jsonb: [{node_id, parent_node_id, node_type, order_index, title, description, material_support, source_files[]}]), is_current(boolean), created_at |
| 用户体验 | 目录生成后不是纯文本，而是结构化树形视图；MVP阶段先支持浏览和版本切换，每章旁边显示"素材支撑度"标签（充足/一般/不足）；更细的目录编辑能力在 Phase 2 完成 |
| 验收标准 | 生成目录 → 树形展示 → 版本切换 → 保存当前版本 → 内容正确恢复 |

### 3.8 章节大纲生成模块

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 在目录树中点击某章 → 右侧展示大纲生成区 → 点击"生成大纲" → 流式输出大纲（本章目标、知识点、结构安排、案例建议、素材依据）→ 大纲可编辑 |
| 后端实现 | `OutlineModule`：接收章节节点标识 → 检索该章相关素材chunk → 组装Prompt（章节定位+检索结果+教学大纲模板）→ LLM生成 → 保存 `outline_version` → 记录引用 |
| API接口 | `POST /api/projects/:id/outline/generate` 生成大纲(SSE)<br>请求体：`{chapter_node_id}`<br>`GET /api/projects/:id/outline/:outlineId` 获取大纲<br>`POST /api/projects/:id/outline/save` 保存编辑后大纲 |
| 数据结构 | `outline_versions` 表：id, project_id, chapter_node_id, chapter_index, chapter_title, version_number, content(jsonb: {objectives, key_points[], structure[], case_suggestions[], source_refs[]}), is_current, created_at |
| 用户体验 | 大纲以结构化卡片展示（目标卡片、知识点列表、结构安排列表、案例建议列表），而非纯文本；每个知识点旁标注素材来源 |
| 验收标准 | 选择章节 → 生成大纲 → 包含目标/知识点/结构/案例 → 可编辑保存 → 出处正确关联 |

### 3.9 正文生成模块（Agent核心引擎）

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 在大纲中点击某节 → 进入正文写作区 → 配置参数（字数要求、风格、是否严格引用素材）→ 点击"生成正文" → 流式输出；MVP阶段正文区以 Markdown 预览 + 基础文本编辑为主，Tiptap 富文本编辑放入 Phase 2；工具栏提供"改写"、"扩写"、"精简"按钮 |
| 后端实现 | `ContentModule` + `AgentEngine`：<br>1. 任务配置解析（章节节点、小节节点、字数、风格）<br>2. 构造检索查询 → 调用检索服务召回相关chunk<br>3. 组装Agent上下文（项目定位+目录+大纲+检索结果+写作约束）<br>4. 调用LLM流式生成正文<br>5. 后处理：提取引用关系 → 写入 `citation_map` → 保存 `writing_result` 和首个 `content_version`<br>改写/扩写/精简：基于已有正文+新指令重新调用Agent，生成新的 `writing_result`，并保留版本链 |
| API接口 | `POST /api/projects/:id/content/generate` 生成正文(SSE)<br>请求体：`{session_id, chapter_node_id, section_node_id, word_count, style, strict_citation}`<br>`POST /api/projects/:id/content/:resultId/rewrite` 改写(SSE)<br>`POST /api/projects/:id/content/:resultId/expand` 扩写(SSE)<br>`POST /api/projects/:id/content/:resultId/compress` 精简(SSE)<br>`GET /api/projects/:id/content/:resultId` 获取正文版本 |
| 数据结构 | `writing_results` 表：id, project_id, session_id, chapter_node_id, section_node_id, chapter_index, section_title, task_type(generate/rewrite/expand/compress), status(streaming/succeeded/failed/stopped), content_text, word_count, style, version_number, parent_result_id(改写时关联上一版), error_message, created_at, completed_at<br>`content_versions` 表：id, result_id, version_number, editor_source(ai/user), content_text, created_at |
| 用户体验 | 正文生成时右栏同步展示"本段引用了哪些素材"；素材不足的段落用黄色底色标记并提示"此部分缺少直接素材支撑"；改写/扩写/精简操作保留版本历史，可一键回退 |
| 验收标准 | 生成正文 → 教材风格 → 引用出处正确 → 改写后内容变化 → 扩写字数增加 → 精简字数减少 → 版本可回退 |

### 3.10 检索与出处引用模块

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 右侧栏"出处面板"：<br>- 检索命中素材列表（文件名+页码+相关度评分）<br>- 点击某条展开原文片段预览<br>- 使用方式标签（直接改写/多源归纳/衔接表达/缺少依据）<br>- 素材不足时顶部红色警告条 |
| 后端实现 | `RetrievalModule`：应用层中文分词 + 关键词召回(`keywords` / `ILIKE`) + 语义检索(pgvector余弦相似度) → 混合排序(RRF融合) → 返回Top-10 chunks<br>`CitationModule`：正文生成时按段落接收结构化引用信息，增量写入 `citation_map`；生成结束后再做一次完整校验 |
| API接口 | `POST /api/projects/:id/retrieve` 手动检索<br>请求体：`{query, task_type, top_k}`<br>`GET /api/projects/:id/content/:resultId/citations` 获取正文引用清单<br>`GET /api/projects/:id/citations/:citationId` 引用详情（含原文片段） |
| 数据结构 | `citation_maps` 表：id, project_id, result_id, paragraph_key, chunk_id, file_id, use_type(rewrite/summarize/synthesize/transition/unsupported), evidence_text, page_number, section_title, confidence_score, created_at |
| 用户体验 | 出处不是事后查看，而是与正文生成同步展示——用户边看正文边看依据，建立信任感；点击出处可跳转查看原文上下文 |
| 验收标准 | 生成正文 → 右栏展示引用列表 → 点击查看原文 → use_type标签正确 → 素材不足有警告 |

### 3.11 导出模块

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 顶部"导出"按钮 → 弹窗选择导出范围（全书/指定章节）和格式（Word/Markdown）→ 是否包含引用清单 → 提交后显示进度 → 完成后自动下载 |
| 后端实现 | `ExportModule`：接收导出请求 → 推入BullMQ队列 → Worker汇总目录+大纲+正文+引用 → 使用docx库生成Word / 拼接Markdown → 存储到文件系统 → 返回下载链接 |
| API接口 | `POST /api/projects/:id/export` 创建导出任务<br>请求体：`{format: "docx"|"markdown", scope: "full"|"chapters", chapter_ids[], include_citations}`<br>`GET /api/projects/:id/export/:exportId` 查询导出状态+下载链接 |
| 数据结构 | `export_jobs` 表：id, project_id, format, scope, status(pending/processing/done/failed), file_path, download_url, created_at, completed_at |
| 用户体验 | 导出是异步的（大教材可能需要几秒），用进度条而非阻塞等待；导出的Word文档结构清晰，标题层级正确，可直接用于后续编辑 |
| 验收标准 | 导出Word → 文件可正常打开 → 标题层级正确 → 中文显示正常 → 引用清单附在末尾 → Markdown格式同理 |

### 3.12 设置页面

| 维度 | 详细说明 |
|:---|:---|
| 前端实现 | 个人设置：修改昵称、密码<br>项目设置：修改教材定位信息、默认写作风格、默认字数<br>系统级设置（如 LLM API Key、Embedding 模型）不在 MVP 页面提供，仍由部署环境变量维护 |
| 后端实现 | `SettingsModule`：用户级设置存 `user_settings` 表；项目级设置存 `projects` 表；系统级设置从环境变量读取，不支持在线改写 |
| API接口 | `GET /api/settings` 获取用户设置<br>`PUT /api/settings` 更新用户设置<br>`PUT /api/projects/:id/settings` 更新项目设置 |
| 数据结构 | `user_settings` 表：id, user_id, default_style, default_word_count, preferences(jsonb), updated_at |
| 用户体验 | 用户级/项目级设置即时生效无需重启；系统级配置变更需通过运维方式发布 |
| 验收标准 | 修改设置 → 新建写作任务时默认值已更新 |

---

## 四、开发阶段规划

### Phase 1：最小可行产品（MVP） — 核心闭环

**目标**：打通"素材导入 → 知识检索 → 目录生成 → 大纲生成 → 正文编写 → 出处输出 → 文档导出"的完整链路，形成可演示的闭环产品。

**包含模块**：
1. 用户系统（登录/注册）
2. 项目管理（创建/列表/详情）
3. 素材上传与解析（PDF/DOCX/PPTX/MD/TXT）
4. 切块与知识库构建（文本切分+向量索引）
5. 检索服务（关键词+语义混合检索）
6. 目录生成（流式输出+树形展示）
7. 章节大纲生成（流式输出+结构化展示）
8. 正文生成（流式输出+基础编辑）
9. 出处引用（citation_map+右栏展示）
10. 导出（Word/Markdown）

**可演示内容**：
- 新建教材项目 → 上传5份素材 → 自动解析 → 生成10章目录 → 选择第3章生成大纲 → 选择3.1节生成正文 → 右栏展示引用出处 → 导出Word文档
- 全流程端到端可跑通

**前端任务清单**：

| 序号 | 任务 | 产出 |
|:---|:---|:---|
| F1 | 项目脚手架搭建（Next.js + Ant Design + Zustand） | 可运行的空项目 |
| F2 | 登录/注册页面 | 认证流程可用 |
| F3 | 项目列表页（卡片布局） | 项目CRUD可操作 |
| F4 | 新建项目弹窗表单 | 表单提交到后端 |
| F5 | 写作工作台三栏布局骨架 | 左中右三栏可见 |
| F6 | 左栏：目录树组件 | 树形展示+折叠 |
| F7 | 左栏：素材列表组件 | 文件列表+上传入口 |
| F8 | 中栏：文件上传拖拽区 | 批量上传+状态显示 |
| F9 | 中栏：对话消息列表 | 消息渲染+滚动 |
| F10 | 中栏：输入框+快捷操作按钮 | 发送消息+快捷按钮 |
| F11 | 中栏：SSE流式渲染（打字机效果） | 逐字输出+停止按钮 |
| F12 | 中栏：Markdown渲染 | 正文格式化展示 |
| F13 | 右栏：出处引用面板 | 引用列表+原文预览 |
| F14 | 导出弹窗 | 格式选择+下载 |
| F15 | 全局：路由守卫+会话管理 | 未登录跳转+静默刷新 |

**后端任务清单**：

| 序号 | 任务 | 产出 |
|:---|:---|:---|
| B1 | 项目脚手架搭建（NestJS + TypeORM + PostgreSQL） | 可运行的空服务 |
| B2 | 数据库Schema设计与Migration | 全部表结构就绪 |
| B3 | AuthModule（注册/登录/JWT） | 认证接口可用 |
| B4 | ProjectModule（CRUD+状态管理） | 项目接口可用 |
| B5 | FileModule（上传+元数据记录） | 文件上传接口可用 |
| B6 | ParseWorker（PDF/DOCX/PPTX/MD/TXT解析） | 异步解析队列可用 |
| B7 | ChunkModule（切块+关键词提取+向量生成） | chunk入库可查 |
| B8 | RetrievalModule（关键词+语义混合检索） | 检索接口可用 |
| B9 | DirectoryModule（目录生成+版本管理） | 目录生成SSE可用 |
| B10 | OutlineModule（大纲生成+版本管理） | 大纲生成SSE可用 |
| B11 | ContentModule（正文生成+改写/扩写/精简） | 正文生成SSE可用 |
| B12 | CitationModule（引用映射+出处查询） | 引用接口可用 |
| B13 | ExportModule（Word/Markdown导出） | 导出接口可用 |
| B14 | SSE流式推送基础设施 | 全部生成接口支持流式 |
| B15 | BullMQ任务队列（解析+导出） | 异步任务可靠执行 |

**建议执行顺序**：
- Week 1：B1→B2→B3→B4→B5→B6（数据底座） + F1→F2→F3→F4（基础页面）
- Week 2：B7→B8→B9→B10→B11→B14（检索+生成链路） + F5→F6→F7→F8→F9→F10（工作台骨架）
- Week 3：B12→B13→B15（引用+导出） + F11→F12→F13→F14→F15（流式渲染+出处+导出） + 联调

### Phase 2：体验完善

**目标**：提升检索精度、写作质量和交互体验，让产品从"能用"变为"好用"。

**包含模块**：
1. 目录树可编辑（拖拽排序、增删改节点）
2. 正文富文本编辑（Tiptap集成）
3. 多轮改写增强（保留版本历史、一键回退）
4. 检索精度优化（查询改写、重排序调优）
5. 素材不足自动提示（黄色标记+建议补充方向）
6. 正文与出处联动高亮（点击出处定位到正文对应段落）
7. 项目进度看板（已完成/进行中/待开始章节可视化）
8. 会话管理（多会话切换、会话标题自动生成）

**可演示内容**：
- 生成目录后拖拽调整章节顺序 → 生成正文后点击"改写"调整风格 → 点击出处跳转原文 → 查看项目进度看板

### Phase 3：工具集成与高级功能

**目标**：增强Agent能力，支持更复杂的教材编写场景。

**包含模块**：
1. 自动习题生成（选择题/填空题/简答题）
2. 教学案例自动推荐
3. 实训任务书生成
4. 素材质量评估报告
5. 教材风格模板（高职/本科/培训）
6. 批量章节生成（队列化处理整本教材）
7. 审稿模式（无出处内容自动标记）

**可演示内容**：
- 选择某章 → 自动生成配套习题 → 切换教材风格模板 → 一键生成整本教材初稿 → 审稿模式标记问题段落

### Phase 4：生产化与规模化

**目标**：支撑多用户并发使用，具备生产环境部署能力。

**包含模块**：
1. 多用户权限体系（管理员/编辑/查看者）
2. 多人协作（同一教材项目多人编辑）
3. 文件存储迁移到MinIO
4. 向量检索迁移到Qdrant
5. 日志监控体系（ELK/Grafana）
6. API限流与安全加固
7. 多版本对比（diff视图）
8. 跨教材项目知识库融合

**可演示内容**：
- 多用户同时编辑同一教材 → 版本对比查看修改差异 → 监控面板查看系统状态

---

## 五、测试方案

### 5.1 单元测试

| 维度 | 说明 |
|:---|:---|
| 工具 | 前端：Vitest + React Testing Library<br>后端：Jest + Supertest |
| 覆盖率目标 | 核心模块 ≥ 80%（检索服务、引用服务、切块逻辑） |
| 重点范围 | chunk切块逻辑（边界case：空文档、超长段落、无标题文档）<br>检索排序逻辑（RRF融合算法正确性）<br>citation_map构建逻辑（use_type判定准确性）<br>JWT认证（token签发/校验/过期/刷新）<br>导出格式拼装（Word标题层级、Markdown语法） |
| 方法 | 每个Service类对应一个.spec.ts文件；Mock外部依赖（LLM API、数据库）；CI中自动运行 |

### 5.2 集成测试

| 测试用例 | 验证内容 |
|:---|:---|
| 文件上传→解析→切块全链路 | 上传一份10页PDF，验证：文件记录入库 → 解析任务执行 → document记录生成 → chunk数量合理(15-30个) → 每个chunk有embedding |
| 检索→生成→引用全链路 | 给定project_id和查询词，验证：检索返回相关chunk → 生成接口调用成功 → writing_result入库 → citation_map记录≥1条 |
| 项目CRUD全链路 | 创建项目 → 更新信息 → 获取详情 → 删除项目 → 关联素材同步清理 |
| 认证全链路 | 注册 → 登录写入Cookie → 带Cookie访问受保护接口 → token过期 → 刷新token → 继续访问 |
| 导出全链路 | 项目有目录+大纲+正文 → 发起导出 → 任务状态变更(pending→processing→done) → 下载文件可打开 |

### 5.3 E2E测试

| 核心用户路径 | 操作步骤 |
|:---|:---|
| 新用户首次使用 | 注册 → 登录 → 创建项目 → 上传素材 → 等待解析完成 → 生成目录 → 生成大纲 → 生成正文 → 查看出处 → 导出Word |
| 多轮改写场景 | 生成正文 → 点击"改写"调整风格 → 点击"扩写"增加内容 → 点击"精简"压缩篇幅 → 查看版本历史 → 回退到第一版 |
| 素材管理场景 | 批量上传5个文件 → 查看解析状态 → 删除1个文件 → 重新解析1个失败文件 → 查看chunk列表 |

工具：Playwright，运行环境：CI中使用headless Chromium。

### 5.4 AI特性专项测试

| 测试项 | 方法 |
|:---|:---|
| 检索相关性 | 准备标注数据集（10个查询+对应正确chunk），计算Recall@10 ≥ 0.7 |
| 出处准确性 | 人工抽检20条citation_map，验证use_type标注正确率 ≥ 80% |
| 素材不足检测 | 构造无相关素材的查询，验证系统返回"素材不足"提示而非凭空生成 |
| 多轮上下文保持 | 连续5轮对话，验证第5轮仍能正确引用第1轮确定的教材定位信息 |
| 生成风格一致性 | 同一章节用"教材风格"和"培训讲义风格"分别生成，人工验证风格差异明显 |
| 长文本生成稳定性 | 要求生成3000字正文，验证不截断、不重复、结构完整 |

### 5.5 性能测试

| 指标 | 目标值 |
|:---|:---|
| 首屏加载时间（LCP） | ≤ 2s |
| SSE首字节延迟 | ≤ 2s（从点击"生成"到第一个字出现） |
| 文件上传速度 | 10MB文件 ≤ 5s |
| 文件解析速度 | 20页PDF ≤ 30s |
| 检索响应时间 | ≤ 500ms（1000个chunk规模） |
| 并发用户数 | 单机支撑 ≥ 20并发写作会话 |
| 导出速度 | 10章教材Word导出 ≤ 10s |

---

## 六、潜在风险与避坑指南

| 风险点 | 具体描述 | 解决方案建议 |
|:---|:---|:---|
| PDF解析质量不稳定 | 扫描版PDF无法提取文字；复杂排版PDF段落错乱；表格/图片内文字丢失 | MVP阶段优先支持文字型PDF，扫描版提示用户先OCR；使用pdf-parse + 备选pdf2json双链路，取质量更好的结果；表格暂以纯文本形式提取 |
| PPTX解析信息丢失 | PPT以视觉为主，文字碎片化，提取后缺乏上下文连贯性 | 按slide为单位拼接文本，保留slide标题作为section_title；备注栏内容一并提取；提示用户PPT素材质量可能低于Word |
| 检索结果不准导致正文偏题 | 语义检索在专业领域可能召回不相关内容；关键词检索可能遗漏同义表达 | 混合检索(关键词+语义)互补；加入查询改写(query rewriting)，用LLM扩展查询词；检索结果展示给用户，允许手动筛选后再生成 |
| LLM生成脱离素材自由发挥 | 即使提供了检索结果，LLM仍可能忽略素材自行编造内容 | Prompt中强制要求"仅基于以下素材内容写作，不得引入素材外信息"；要求LLM输出时标注每段对应的chunk_id；后处理校验引用覆盖率，不足时标记警告 |
| 长文本生成截断或重复 | Claude/GPT在生成3000+字时可能出现内容重复或中途截断 | 分段生成策略：将长文本拆为多个小节，每节独立生成后拼接；设置max_tokens足够大；生成后做去重和连贯性检查 |
| SSE连接不稳定 | 移动网络或弱网环境下SSE连接容易断开，导致生成内容丢失 | 实现SSE断线重连机制（带last-event-id）；后端缓存完整生成结果，断线后可通过GET接口获取完整内容；前端本地缓存已接收的部分内容 |
| 多轮交互后上下文膨胀 | 教材项目持续数天，对话历史不断增长，超出LLM上下文窗口 | 滑动窗口截断（保留最近20轮）；项目级上下文（定位/目录/大纲）始终注入但做摘要压缩；会话级上下文按相关性筛选而非全量注入 |
| 引用映射不准确 | LLM输出的引用标注可能与实际使用的素材不一致 | 双重校验：LLM自标注 + 后处理文本相似度比对；对每条citation计算confidence_score，低于阈值的标记为"待人工确认" |
| 向量维度与存储成本 | 大量chunk的embedding存储和检索可能成为性能瓶颈 | MVP阶段用pgvector足够（万级chunk）；超过10万chunk时迁移到Qdrant；embedding使用1536维而非3072维，平衡精度和成本 |
| 并发生成请求阻塞 | 多用户同时发起正文生成，LLM API调用排队导致响应慢 | MVP阶段使用进程内并发上限或 Redis 分布式锁控制生成并发；超出阈值时直接返回"系统繁忙，请稍后重试"；如后续需要排队体验，再在 Phase 4 将生成任务队列化 |
| Word导出格式问题 | 导出的Word文档标题层级错乱、中文字体缺失、样式不统一 | 使用docx库预定义样式模板（标题1-3级、正文、引用块）；指定中文字体（宋体/微软雅黑）；导出前做格式校验 |

---

## 七、项目结构建议

```
writing-agent/
├── docker-compose.yml              # 一键启动全部服务
├── .env.example                     # 环境变量模板
├── packages/
│   └── contracts/                   # 前后端共享 DTO / 类型契约
│       ├── src/
│       │   ├── auth.ts
│       │   ├── project.ts
│       │   ├── directory.ts
│       │   ├── outline.ts
│       │   ├── content.ts
│       │   ├── citation.ts
│       │   └── common.ts
│       └── package.json
├── nginx/
│   └── nginx.conf                   # 反向代理配置
│
├── frontend/                        # 前端项目 (Next.js)
│   ├── package.json
│   ├── next.config.js
│   ├── tsconfig.json
│   ├── public/
│   │   └── favicon.ico
│   ├── src/
│   │   ├── app/                     # App Router 页面
│   │   │   ├── layout.tsx           # 根布局
│   │   │   ├── page.tsx             # 首页(重定向到项目列表)
│   │   │   ├── login/
│   │   │   │   └── page.tsx         # 登录页
│   │   │   ├── register/
│   │   │   │   └── page.tsx         # 注册页
│   │   │   ├── projects/
│   │   │   │   ├── page.tsx         # 项目列表页
│   │   │   │   └── [id]/
│   │   │   │       ├── page.tsx     # 写作工作台(三栏布局)
│   │   │   │       ├── files/
│   │   │   │       │   └── page.tsx # 素材管理页
│   │   │   │       └── settings/
│   │   │   │           └── page.tsx # 项目设置页
│   │   │   └── settings/
│   │   │       └── page.tsx         # 个人设置页
│   │   ├── components/              # 可复用组件
│   │   │   ├── layout/
│   │   │   │   ├── Header.tsx       # 顶部导航
│   │   │   │   ├── Sidebar.tsx      # 左侧栏容器
│   │   │   │   └── WorkbenchLayout.tsx # 三栏工作台布局
│   │   │   ├── project/
│   │   │   │   ├── ProjectCard.tsx  # 项目卡片
│   │   │   │   └── CreateProjectModal.tsx # 新建项目弹窗
│   │   │   ├── editor/
│   │   │   │   ├── DirectoryTree.tsx    # 目录树(可编辑)
│   │   │   │   ├── OutlinePanel.tsx     # 大纲面板
│   │   │   │   ├── ContentEditor.tsx    # 正文编辑区(Tiptap)
│   │   │   │   ├── ChatInput.tsx        # 输入框+快捷按钮
│   │   │   │   └── MessageList.tsx      # 对话消息列表
│   │   │   ├── citation/
│   │   │   │   ├── CitationPanel.tsx    # 出处面板
│   │   │   │   └── EvidencePreview.tsx  # 原文片段预览
│   │   │   ├── file/
│   │   │   │   ├── FileUploader.tsx     # 拖拽上传组件
│   │   │   │   └── FileList.tsx         # 素材列表
│   │   │   └── common/
│   │   │       ├── StreamRenderer.tsx   # SSE流式渲染
│   │   │       ├── MarkdownRenderer.tsx # Markdown渲染
│   │   │       └── ExportModal.tsx      # 导出弹窗
│   │   ├── stores/                  # Zustand 状态管理
│   │   │   ├── authStore.ts         # 认证状态
│   │   │   ├── projectStore.ts      # 项目状态
│   │   │   ├── editorStore.ts       # 编辑器状态(目录/大纲/正文)
│   │   │   └── chatStore.ts         # 对话状态
│   │   ├── services/                # API 调用层
│   │   │   ├── api.ts               # ky实例(baseURL=/api, credentials=include)
│   │   │   ├── authService.ts       # 认证API
│   │   │   ├── projectService.ts    # 项目API
│   │   │   ├── fileService.ts       # 文件API
│   │   │   ├── contentService.ts    # 生成API(含SSE)
│   │   │   ├── citationService.ts   # 引用API
│   │   │   └── exportService.ts     # 导出API
│   │   ├── hooks/                   # 自定义Hooks
│   │   │   ├── useSSE.ts            # SSE流式连接
│   │   │   ├── useAuth.ts           # 认证逻辑
│   │   │   └── useProject.ts        # 项目数据
│   │   ├── types/                   # TypeScript类型定义
│   │   │   ├── project.ts
│   │   │   ├── file.ts
│   │   │   ├── content.ts
│   │   │   ├── citation.ts
│   │   │   └── api.ts               # 通用API响应类型
│   │   └── utils/
│   │       ├── constants.ts
│   │       └── format.ts
│   └── tests/
│       ├── components/
│       └── e2e/
│
├── backend/                         # 后端项目 (NestJS)
│   ├── package.json
│   ├── tsconfig.json
│   ├── nest-cli.json
│   ├── src/
│   │   ├── main.ts                  # 入口
│   │   ├── app.module.ts            # 根模块
│   │   ├── common/                  # 公共模块
│   │   │   ├── guards/
│   │   │   │   └── auth.guard.ts    # JWT认证守卫
│   │   │   ├── interceptors/
│   │   │   │   └── response.interceptor.ts # 统一响应格式
│   │   │   ├── filters/
│   │   │   │   └── http-exception.filter.ts # 统一异常处理
│   │   │   ├── decorators/
│   │   │   │   └── current-user.decorator.ts
│   │   │   └── dto/
│   │   │       └── pagination.dto.ts
│   │   ├── auth/                    # 认证模块
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── refresh-token.entity.ts
│   │   │   └── dto/
│   │   │       ├── register.dto.ts
│   │   │       └── login.dto.ts
│   │   ├── project/                 # 项目模块
│   │   │   ├── project.module.ts
│   │   │   ├── project.controller.ts
│   │   │   ├── project.service.ts
│   │   │   └── entities/
│   │   │       ├── project.entity.ts
│   │   │       └── project-state.entity.ts
│   │   ├── file/                    # 文件模块
│   │   │   ├── file.module.ts
│   │   │   ├── file.controller.ts
│   │   │   ├── file.service.ts
│   │   │   ├── parse.worker.ts      # 解析Worker(BullMQ)
│   │   │   ├── parsers/             # 各格式解析器
│   │   │   │   ├── pdf.parser.ts
│   │   │   │   ├── docx.parser.ts
│   │   │   │   ├── pptx.parser.ts
│   │   │   │   ├── markdown.parser.ts
│   │   │   │   └── txt.parser.ts
│   │   │   └── entities/
│   │   │       ├── source-file.entity.ts
│   │   │       └── document.entity.ts
│   │   ├── chunk/                   # 切块模块
│   │   │   ├── chunk.module.ts
│   │   │   ├── chunk.service.ts
│   │   │   ├── chunk.controller.ts
│   │   │   ├── chunker.ts           # 切块策略
│   │   │   └── entities/
│   │   │       └── chunk.entity.ts
│   │   ├── retrieval/               # 检索模块
│   │   │   ├── retrieval.module.ts
│   │   │   ├── retrieval.controller.ts
│   │   │   ├── retrieval.service.ts
│   │   │   └── ranker.ts            # 重排序逻辑
│   │   ├── agent/                   # Agent核心引擎
│   │   │   ├── agent.module.ts
│   │   │   ├── agent.service.ts     # 统一Agent调度
│   │   │   ├── chains/
│   │   │   │   ├── directory.chain.ts   # 目录生成Chain
│   │   │   │   ├── outline.chain.ts     # 大纲生成Chain
│   │   │   │   └── content.chain.ts     # 正文生成Chain
│   │   │   └── prompts/
│   │   │       ├── directory.prompt.ts
│   │   │       ├── outline.prompt.ts
│   │   │       └── content.prompt.ts
│   │   ├── content/                 # 写作内容模块
│   │   │   ├── content.module.ts
│   │   │   ├── content.controller.ts
│   │   │   ├── content.service.ts
│   │   │   └── entities/
│   │   │       ├── writing-result.entity.ts
│   │   │       ├── content-version.entity.ts
│   │   │       ├── directory-version.entity.ts
│   │   │       └── outline-version.entity.ts
│   │   ├── citation/                # 引用模块
│   │   │   ├── citation.module.ts
│   │   │   ├── citation.controller.ts
│   │   │   ├── citation.service.ts
│   │   │   └── entities/
│   │   │       └── citation-map.entity.ts
│   │   ├── export/                  # 导出模块
│   │   │   ├── export.module.ts
│   │   │   ├── export.controller.ts
│   │   │   ├── export.service.ts
│   │   │   ├── export.worker.ts     # 导出Worker(BullMQ)
│   │   │   ├── generators/
│   │   │   │   ├── docx.generator.ts
│   │   │   │   └── markdown.generator.ts
│   │   │   └── entities/
│   │   │       └── export-job.entity.ts
│   │   ├── session/                 # 会话模块
│   │   │   ├── session.module.ts
│   │   │   ├── session.controller.ts
│   │   │   ├── session.service.ts
│   │   │   └── entities/
│   │   │       ├── session.entity.ts
│   │   │       └── message.entity.ts
│   │   └── config/                  # 配置
│   │       ├── database.config.ts
│   │       ├── redis.config.ts
│   │       ├── llm.config.ts
│   │       └── storage.config.ts
│   ├── migrations/                  # 数据库迁移
│   │   └── 001-init-schema.ts
│   └── tests/
│       ├── unit/
│       └── integration/
│
├── scripts/                         # 运维脚本
│   ├── init-db.sh                   # 初始化数据库+pgvector扩展
│   ├── seed.sh                      # 测试数据填充
│   └── backup.sh                    # 数据库备份
│
└── docs/                            # 项目文档(已有)
    ├── 1.教材编写Agent产品方案_2026-03-17.docx
    ├── ...
    └── 9.教材编写Agent_PRD完整版_2026-03-17.docx
```

---

## 八、环境变量清单

```env
# ===== 数据库 =====
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=writing_agent
DATABASE_USER=postgres
DATABASE_PASSWORD=your_password

# ===== Redis =====
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# ===== JWT =====
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d
ACCESS_TOKEN_COOKIE_NAME=wa_access_token
REFRESH_TOKEN_COOKIE_NAME=wa_refresh_token

# ===== LLM =====
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_api_key
ANTHROPIC_MODEL=claude-sonnet-4-20250514
OPENAI_API_KEY=your_backup_api_key

# ===== Embedding =====
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

# ===== 文件存储 =====
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=50mb

# ===== 应用 =====
PORT=3001
FRONTEND_URL=http://localhost:3000
API_BASE_PATH=/api
NODE_ENV=development
```

---

## 九、Docker Compose 部署方案

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: writing_agent
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

  backend:
    build: ./backend
    ports:
      - "3001:3001"
    depends_on:
      - postgres
      - redis
    env_file:
      - .env
    volumes:
      - ./uploads:/app/uploads

  frontend:
    build: ./frontend
    ports:
      - "3000:3000"
    depends_on:
      - backend
    environment:
      - NEXT_PUBLIC_API_URL=/api

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - frontend
      - backend
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf

volumes:
  pgdata:
  redisdata:
```

---

## 十、AI开发团队分工建议

由于团队全部是AI（Claude Code / Codex），建议按以下方式并行分工：

| Agent角色 | 负责模块 | 并行度 |
|:---|:---|:---|
| Agent A（后端基础） | 项目脚手架 + 数据库Schema + AuthModule + ProjectModule | 独立启动 |
| Agent B（文件处理） | FileModule + 5种格式Parser + ChunkModule + 向量索引 | 依赖Schema完成后启动 |
| Agent C（Agent引擎） | RetrievalModule + AgentService + 3条Chain(目录/大纲/正文) + Prompt设计 | 依赖Chunk模块完成后启动 |
| Agent D（前端） | Next.js脚手架 + 全部页面 + 组件 + SSE流式渲染 + 状态管理 | 独立启动，Mock API先行 |
| Agent E（引用+导出） | CitationModule + ExportModule(Word/Markdown生成) + BullMQ Worker | 依赖Content模块完成后启动 |

关键协作点：
- Agent D（前端）先用Mock数据开发，后端接口就绪后切换到真实API
- Agent B 和 Agent C 有依赖关系（检索依赖chunk），但可以先定义好接口契约并行开发
- 前后端共享 DTO 不放在 `frontend/src/types` 中，而是抽到 `packages/contracts`，由前后端共同依赖，避免复制粘贴式维护

---

## 十一、数据库Schema设计（PostgreSQL）

### 11.1 用户表

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

### 11.1.1 Refresh Token表

```sql
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

### 11.2 项目表

```sql
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),                    -- 教材类型：高职教材/本科教材/培训教材/校本教材
    target_audience TEXT,                -- 面向对象
    target_chapters INTEGER DEFAULT 10,  -- 目标章节数
    style VARCHAR(50) DEFAULT '教材',    -- 写作风格
    status VARCHAR(20) DEFAULT 'draft',  -- draft/in_progress/completed
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_projects_user_id ON projects(user_id);
```

### 11.3 项目状态表

```sql
CREATE TABLE project_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    current_directory_version_id UUID,
    completed_chapters JSONB DEFAULT '[]',     -- ["第一章", "第二章"]
    in_progress_chapter VARCHAR(255),
    in_progress_section VARCHAR(255),
    pending_items JSONB DEFAULT '[]',          -- [{type, description}]
    material_gaps JSONB DEFAULT '[]',          -- [{chapter, description}]
    user_notes TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 11.4 素材文件表

```sql
CREATE TABLE source_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name VARCHAR(500) NOT NULL,
    file_type VARCHAR(20) NOT NULL,      -- pdf/docx/pptx/md/txt
    file_size BIGINT,
    file_path VARCHAR(1000) NOT NULL,
    parse_status VARCHAR(20) DEFAULT 'pending',  -- pending/parsing/done/failed
    error_message TEXT,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_source_files_project_id ON source_files(project_id);
CREATE INDEX idx_source_files_parse_status ON source_files(parse_status);
```

### 11.5 文档表（解析结果）

```sql
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(500),
    content_text TEXT,
    page_count INTEGER,
    sections JSONB DEFAULT '[]',         -- [{title, page, level}]
    parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_documents_project_id ON documents(project_id);
CREATE INDEX idx_documents_file_id ON documents(file_id);
```

### 11.6 素材片段表（Chunk）

```sql
-- 需要先启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    section_title VARCHAR(500),
    page_number INTEGER,
    keywords TEXT[] DEFAULT '{}',
    search_terms TEXT[] DEFAULT '{}',
    embedding vector(1536),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_chunks_project_id ON chunks(project_id);
CREATE INDEX idx_chunks_file_id ON chunks(file_id);
CREATE INDEX idx_chunks_keywords ON chunks USING GIN(keywords);
CREATE INDEX idx_chunks_search_terms ON chunks USING GIN(search_terms);
CREATE INDEX idx_chunks_embedding ON chunks USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
```

说明：

- MVP阶段中文关键词检索不依赖 PostgreSQL 中文分词扩展，统一在应用层完成分词后写入 `keywords` / `search_terms`
- `ILIKE`、`search_terms` 命中、向量检索三路召回后统一进入 RRF 重排序

### 11.7 会话与消息表

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) DEFAULT '新会话',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,           -- user/assistant/system
    content TEXT NOT NULL,
    message_type VARCHAR(30) DEFAULT 'chat',  -- chat/directory/outline/content
    metadata JSONB DEFAULT '{}',         -- {result_id, task_type, ...}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
```

### 11.8 目录版本表

```sql
CREATE TABLE directory_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    content JSONB NOT NULL,              -- [{node_id, parent_node_id, node_type, order_index, title, description, material_support, source_files[]}]
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_directory_versions_project_id ON directory_versions(project_id);

ALTER TABLE project_states
ADD CONSTRAINT fk_project_states_current_directory_version
FOREIGN KEY (current_directory_version_id) REFERENCES directory_versions(id);
```

### 11.9 大纲版本表

```sql
CREATE TABLE outline_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_node_id UUID NOT NULL,
    chapter_index INTEGER NOT NULL,
    chapter_title VARCHAR(500) NOT NULL,
    version_number INTEGER NOT NULL,
    content JSONB NOT NULL,              -- {objectives, key_points[], structure[], case_suggestions[], source_refs[]}
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_outline_versions_project_chapter ON outline_versions(project_id, chapter_index);
```

### 11.10 写作结果表

```sql
CREATE TABLE writing_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id),
    chapter_node_id UUID,
    section_node_id UUID,
    chapter_index INTEGER,
    chapter_title VARCHAR(500),
    section_title VARCHAR(500),
    task_type VARCHAR(30) NOT NULL,      -- generate/rewrite/expand/compress
    status VARCHAR(20) NOT NULL DEFAULT 'streaming', -- streaming/succeeded/failed/stopped
    content_text TEXT NOT NULL,
    word_count INTEGER,
    style VARCHAR(50),
    version_number INTEGER DEFAULT 1,
    parent_result_id UUID REFERENCES writing_results(id),  -- 改写时关联上一版
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_writing_results_project_id ON writing_results(project_id);
CREATE INDEX idx_writing_results_chapter ON writing_results(project_id, chapter_index);
```

### 11.10.1 正文版本表

```sql
CREATE TABLE content_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id UUID NOT NULL REFERENCES writing_results(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    editor_source VARCHAR(20) NOT NULL DEFAULT 'ai', -- ai/user
    content_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_content_versions_result_id ON content_versions(result_id);
```

### 11.11 引用映射表

```sql
CREATE TABLE citation_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    result_id UUID NOT NULL REFERENCES writing_results(id) ON DELETE CASCADE,
    paragraph_key VARCHAR(100) NOT NULL,
    chunk_id UUID NOT NULL REFERENCES chunks(id),
    file_id UUID NOT NULL REFERENCES source_files(id),
    use_type VARCHAR(30) NOT NULL,       -- rewrite/summarize/synthesize/transition/unsupported
    evidence_text TEXT,                  -- 原文片段
    page_number INTEGER,
    section_title VARCHAR(500),
    confidence_score FLOAT DEFAULT 0.8,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_citation_maps_result_id ON citation_maps(result_id);
CREATE INDEX idx_citation_maps_chunk_id ON citation_maps(chunk_id);
CREATE INDEX idx_citation_maps_paragraph_key ON citation_maps(paragraph_key);
```

### 11.12 导出任务表

```sql
CREATE TABLE export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    format VARCHAR(20) NOT NULL,         -- docx/markdown
    scope VARCHAR(20) NOT NULL,          -- full/chapters
    chapter_ids JSONB DEFAULT '[]',
    include_citations BOOLEAN DEFAULT true,
    status VARCHAR(20) DEFAULT 'pending', -- pending/processing/done/failed
    file_path VARCHAR(1000),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_export_jobs_project_id ON export_jobs(project_id);
```

### 11.13 用户设置表

```sql
CREATE TABLE user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    default_style VARCHAR(50) DEFAULT '教材',
    default_word_count INTEGER DEFAULT 2000,
    preferences JSONB DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

---

## 十二、核心Prompt设计

### 12.1 System Prompt（全局注入）

```text
你是一位专业的教材编写助手，专注于帮助用户完成教材的目录设计、章节大纲生成和正文撰写。

核心工作原则：
1. 【素材优先】所有内容必须优先基于用户提供的素材生成，不得脱离素材自由发挥
2. 【先检索后写作】每次生成前，系统已从素材库中检索了相关内容，你必须基于这些检索结果进行写作
3. 【出处可追溯】生成内容时，必须标注每段内容所依据的素材来源（文件名、页码、章节）
4. 【素材不足时明确提示】如果检索结果不足以支撑当前写作任务，必须明确告知用户"当前素材不足"，而不是凭空编造
5. 【教材风格】输出内容应符合教材写作规范：结构清晰、逻辑严谨、语言规范、适合教学使用

当前教材项目信息：
- 教材名称：{project_name}
- 教材类型：{project_type}
- 面向对象：{target_audience}
- 写作风格：{style}
```

### 12.2 目录生成Prompt

```text
请根据以下教材定位和素材内容，生成教材目录建议方案。

【教材定位】
- 教材名称：{project_name}
- 教材类型：{project_type}
- 面向对象：{target_audience}
- 目标章节数：{target_chapters}

【素材主题分布】
{retrieved_topics_summary}

【要求】
1. 输出一级目录和二级目录
2. 每章附带简要内容说明（1-2句话）
3. 标注每章的主要素材支撑情况（充足/一般/不足）
4. 目录结构应符合教学逻辑：由浅入深、循序渐进
5. 章节数量控制在{target_chapters}章左右

请以JSON格式输出：
[
  {
    "chapter_index": 1,
    "title": "章标题",
    "description": "本章内容说明",
    "sections": ["节标题1", "节标题2"],
    "material_support": "充足|一般|不足",
    "source_files": ["文件名1", "文件名2"]
  }
]
```

### 12.3 章节大纲生成Prompt

```text
请为以下章节生成教材化大纲。

【章节信息】
- 所属教材：{project_name}
- 章节标题：{chapter_title}
- 章节序号：第{chapter_index}章
- 前一章：{prev_chapter_title}
- 后一章：{next_chapter_title}

【本章相关素材】
{retrieved_chunks}

【要求】
1. 本章教学目标（3-5条）
2. 核心知识点列表（每个知识点附带素材来源标注）
3. 章节结构安排（各节标题+内容概要）
4. 案例/实训建议（基于素材中的案例）
5. 本章重点与难点
6. 素材依据说明

请以JSON格式输出：
{
  "objectives": ["目标1", "目标2"],
  "key_points": [
    {"point": "知识点", "source": "来源文件:页码"}
  ],
  "structure": [
    {"section": "节标题", "summary": "内容概要"}
  ],
  "case_suggestions": ["案例1"],
  "highlights": {"key_points": ["重点"], "difficulties": ["难点"]},
  "source_refs": [{"file": "文件名", "pages": "页码范围", "relevance": "高|中"}]
}
```

### 12.4 正文生成Prompt

```text
请为以下小节生成教材正文。

【写作任务】
- 所属教材：{project_name}
- 章节：{chapter_title}
- 小节：{section_title}
- 字数要求：约{word_count}字
- 写作风格：{style}
- 是否严格引用素材：{strict_citation}

【本节大纲要点】
{outline_points}

【检索到的相关素材】
---素材片段1---
[来源：{file_name}，第{page}页，章节：{section}]
{chunk_content_1}

---素材片段2---
[来源：{file_name}，第{page}页，章节：{section}]
{chunk_content_2}

...

【写作要求】
1. 正文内容必须基于上述素材片段进行组织和表达
2. 使用教材规范语言，避免口语化
3. 结构清晰，段落分明，适合教学阅读
4. 在每段末尾用 [来源：文件名, p.页码] 格式标注出处
5. 如果某段内容缺乏素材支撑，用 [⚠️ 素材不足] 标记
6. 控制总字数在{word_count}字左右

【输出格式】
直接输出教材正文内容（Markdown格式），每段末尾附带出处标注。

同时在正文之后，输出引用清单：
---引用清单---
[
  {
    "paragraph_key": "p1",
    "use_type": "rewrite|summarize|synthesize|transition|unsupported",
    "source_file": "文件名",
    "page": 页码,
    "evidence": "原文摘要片段"
  }
]
```

### 12.5 改写/扩写/精简Prompt模板

```text
【改写】请对以下教材正文进行改写，要求：{rewrite_instruction}
保持核心内容不变，调整表达方式和结构。保留出处标注。

【扩写】请对以下教材正文进行扩写，要求：
- 在现有内容基础上补充更多细节和解释
- 目标字数增加到约{target_word_count}字
- 优先使用以下补充素材：{additional_chunks}
- 新增内容同样需要标注出处

【精简】请对以下教材正文进行精简，要求：
- 保留核心知识点和关键论述
- 目标字数压缩到约{target_word_count}字
- 删除冗余表述，保持逻辑完整
- 保留重要出处标注
```

---

## 十三、API接口完整清单

### 13.0 接口契约约定

1. **访问路径**
   - 浏览器统一通过同源路径访问后端，例如 `/api/projects`
   - Nginx 将 `/api/*` 反向代理到 NestJS

2. **认证方式**
   - 登录成功后后端写入 httpOnly Cookie：`wa_access_token`、`wa_refresh_token`
   - 前端请求统一带 `credentials: "include"`
   - MVP阶段不使用 `Authorization: Bearer <token>` 头

3. **响应结构**
   - 普通 JSON 接口统一使用 `success/data/message/error_code`
   - 文件上传接口同样返回 JSON 包装
   - SSE 接口不再包裹 `success` 字段，而是直接返回事件流

4. **稳定标识**
   - 项目、会话、文件、chunk、目录节点、正文结果均使用 UUID
   - 目录树中的章/节节点由后端生成稳定 `node_id`，前端不得自行拼接标题作为业务主键

5. **时间格式**
   - 所有时间字段统一返回 ISO 8601 UTC 字符串，例如 `2026-03-17T10:00:00Z`

6. **幂等与并发**
   - 保存类接口优先支持 `If-Match` / `version_number` 进行乐观并发控制
   - 生成类接口一次请求只对应一个 `writing_result`

### 13.1 认证接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/auth/register` | 用户注册 | 否 |
| POST | `/api/auth/login` | 用户登录 | 否 |
| POST | `/api/auth/refresh` | 刷新token | 否(需refresh_token) |
| POST | `/api/auth/logout` | 退出登录 | 是 |
| PUT | `/api/auth/password` | 修改密码 | 是 |

登录成功响应示例：
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "nickname": "张三"
    }
  },
  "message": null
}
```

### 13.2 项目接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects` | 创建项目 | 是 |
| GET | `/api/projects` | 项目列表 | 是 |
| GET | `/api/projects/:id` | 项目详情 | 是 |
| PUT | `/api/projects/:id` | 更新项目 | 是 |
| DELETE | `/api/projects/:id` | 删除项目 | 是 |
| GET | `/api/projects/:id/state` | 获取项目状态 | 是 |
| PUT | `/api/projects/:id/state` | 更新项目状态 | 是 |
| PUT | `/api/projects/:id/settings` | 更新项目设置 | 是 |

### 13.3 素材文件接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/files` | 上传素材(multipart) | 是 |
| GET | `/api/projects/:id/files` | 素材列表 | 是 |
| GET | `/api/projects/:id/files/:fileId` | 素材详情 | 是 |
| GET | `/api/projects/:id/files/:fileId/parse-result` | 解析结果 | 是 |
| POST | `/api/projects/:id/files/:fileId/reparse` | 重新解析 | 是 |
| DELETE | `/api/projects/:id/files/:fileId` | 删除素材 | 是 |

### 13.4 素材片段接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| GET | `/api/projects/:id/chunks` | 片段列表(支持keyword/file_id筛选) | 是 |
| GET | `/api/projects/:id/chunks/:chunkId` | 片段详情 | 是 |

### 13.5 检索接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/retrieve` | 检索相关素材 | 是 |

请求体：
```json
{
  "query": "检索关键词或主题描述",
  "task_type": "directory|outline|content",
  "top_k": 10
}
```

返回体：
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "chunk_id": "uuid",
        "content": "素材片段内容",
        "file_name": "来源文件名",
        "page_number": 5,
        "section_title": "章节标题",
        "score": 0.85,
        "keywords": ["关键词1", "关键词2"]
      }
    ],
    "total": 10
  }
}
```

### 13.6 目录接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/directory/generate` | 生成目录(SSE) | 是 |
| GET | `/api/projects/:id/directory` | 获取当前目录 | 是 |
| POST | `/api/projects/:id/directory/save` | 保存编辑后目录 | 是 |
| GET | `/api/projects/:id/directory/versions` | 目录版本列表 | 是 |

### 13.7 大纲接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/outline/generate` | 生成大纲(SSE) | 是 |
| GET | `/api/projects/:id/outline/:outlineId` | 获取大纲 | 是 |
| POST | `/api/projects/:id/outline/save` | 保存编辑后大纲 | 是 |

请求体（生成大纲）：
```json
{
  "chapter_node_id": "uuid"
}
```

### 13.8 正文接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/content/generate` | 生成正文(SSE) | 是 |
| POST | `/api/projects/:id/content/:resultId/rewrite` | 改写(SSE) | 是 |
| POST | `/api/projects/:id/content/:resultId/expand` | 扩写(SSE) | 是 |
| POST | `/api/projects/:id/content/:resultId/compress` | 精简(SSE) | 是 |
| GET | `/api/projects/:id/content/:resultId` | 获取正文版本 | 是 |

请求体（生成正文）：
```json
{
  "session_id": "uuid",
  "chapter_node_id": "uuid",
  "section_node_id": "uuid",
  "word_count": 2000,
  "style": "教材",
  "strict_citation": true
}
```

SSE事件格式：
```
event: meta
data: {"type":"meta","result_id":"uuid","task_type":"generate","started_at":"2026-03-17T10:00:00Z"}

event: token
data: {"type":"token","content":"教材正文的一个片段","paragraph_key":"p1"}

event: token
data: {"type":"token","content":"继续输出...","paragraph_key":"p1"}

event: citation
data: {"type":"citation","paragraph_key":"p1","citations":[{"chunk_id":"uuid","file_name":"教材素材A.pdf","page_number":15,"use_type":"rewrite","confidence_score":0.92}]}

event: done
data: {"type":"done","result_id":"uuid","status":"succeeded","citations":[...]}

event: error
data: {"type":"error","message":"LLM service timeout","error_code":"LLM_TIMEOUT"}
```

### 13.9 引用接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| GET | `/api/projects/:id/content/:resultId/citations` | 正文引用清单 | 是 |
| GET | `/api/projects/:id/citations/:citationId` | 引用详情 | 是 |
| POST | `/api/projects/:id/content/:resultId/material-gap` | 标记素材不足 | 是 |

返回体（引用清单）：
```json
{
  "success": true,
  "data": {
    "citations": [
      {
        "id": "uuid",
        "chunk_id": "uuid",
        "file_name": "教材素材A.pdf",
        "page_number": 15,
        "section_title": "第二章 基础概念",
        "use_type": "rewrite",
        "evidence_text": "原文片段摘要...",
        "confidence_score": 0.92
      }
    ]
  }
}
```

### 13.10 会话接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/sessions` | 创建会话 | 是 |
| GET | `/api/projects/:id/sessions` | 会话列表 | 是 |
| GET | `/api/projects/:id/sessions/:sessionId/messages` | 消息历史 | 是 |
| DELETE | `/api/projects/:id/sessions/:sessionId` | 删除会话 | 是 |

### 13.11 导出接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/projects/:id/export` | 创建导出任务 | 是 |
| GET | `/api/projects/:id/export/:exportId` | 查询导出状态+下载 | 是 |

请求体：
```json
{
  "format": "docx",
  "scope": "full",
  "chapter_ids": [],
  "include_citations": true
}
```

返回体（导出完成）：
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "done",
    "download_url": "/api/projects/:id/export/:exportId/download",
    "created_at": "2026-03-17T10:00:00Z",
    "completed_at": "2026-03-17T10:00:05Z"
  }
}
```

### 13.12 设置接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| GET | `/api/settings` | 获取用户设置 | 是 |
| PUT | `/api/settings` | 更新用户设置 | 是 |

### 13.13 统一响应格式

成功：
```json
{
  "success": true,
  "data": { ... },
  "message": null
}
```

失败：
```json
{
  "success": false,
  "data": null,
  "message": "错误描述",
  "error_code": "PROJECT_NOT_FOUND"
}
```

分页：
```json
{
  "success": true,
  "data": {
    "items": [...],
    "total": 100,
    "page": 1,
    "page_size": 20
  }
}
```

### 13.14 关键资源结构定义

目录节点（`directory_versions.content[]`）：
```json
{
  "node_id": "uuid",
  "parent_node_id": null,
  "node_type": "chapter",
  "order_index": 1,
  "title": "第三章 数据库设计基础",
  "description": "本章介绍关系模型与数据库设计基本方法。",
  "material_support": "充足",
  "source_files": ["数据库基础.pdf"]
}
```

正文结果（`GET /api/projects/:id/content/:resultId`）：
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "project_id": "uuid",
    "session_id": "uuid",
    "chapter_node_id": "uuid",
    "section_node_id": "uuid",
    "task_type": "generate",
    "status": "succeeded",
    "content_text": "### 3.1 关系模型概述 ...",
    "version_number": 1,
    "latest_content_version_id": "uuid",
    "created_at": "2026-03-17T10:00:00Z",
    "completed_at": "2026-03-17T10:00:18Z"
  }
}
```

### 13.14 错误码定义

| 错误码 | HTTP状态码 | 说明 |
|:---|:---|:---|
| AUTH_INVALID_CREDENTIALS | 401 | 邮箱或密码错误 |
| AUTH_TOKEN_EXPIRED | 401 | Token已过期 |
| AUTH_EMAIL_EXISTS | 409 | 邮箱已注册 |
| PROJECT_NOT_FOUND | 404 | 项目不存在 |
| FILE_NOT_FOUND | 404 | 文件不存在 |
| FILE_TYPE_UNSUPPORTED | 400 | 不支持的文件格式 |
| FILE_TOO_LARGE | 413 | 文件超过大小限制 |
| PARSE_FAILED | 500 | 文件解析失败 |
| RETRIEVAL_NO_RESULTS | 200 | 检索无结果（非错误，正常返回空） |
| GENERATION_FAILED | 500 | LLM生成失败 |
| GENERATION_TIMEOUT | 504 | LLM生成超时 |
| EXPORT_FAILED | 500 | 导出失败 |
| RATE_LIMIT_EXCEEDED | 429 | 请求频率超限 |

---

## 十四、关键技术实现要点

### 14.1 SSE流式推送实现（NestJS）

```typescript
// content.controller.ts
@Post(':id/content/generate')
@Sse()
async generateContent(
  @Param('id') projectId: string,
  @Body() dto: GenerateContentDto,
  @Res() res: Response,
) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = await this.contentService.generateStream(projectId, dto);

  for await (const chunk of stream) {
    res.write(`data: ${JSON.stringify({ type: 'token', content: chunk })}\n\n`);
  }

  const result = await this.contentService.saveResult(projectId, dto);
  res.write(`data: ${JSON.stringify({ type: 'done', result_id: result.id })}\n\n`);
  res.end();
}
```

### 14.2 混合检索实现（关键词 + 语义 + RRF融合）

```typescript
// retrieval.service.ts
async retrieve(projectId: string, query: string, topK: number = 10) {
  // 1. 关键词检索（PostgreSQL全文检索）
  const keywordResults = await this.chunkRepo.query(`
    SELECT id, content, ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $1)) as score
    FROM chunks WHERE project_id = $2
    ORDER BY score DESC LIMIT $3
  `, [query, projectId, topK * 2]);

  // 2. 语义检索（pgvector余弦相似度）
  const queryEmbedding = await this.embeddingService.embed(query);
  const semanticResults = await this.chunkRepo.query(`
    SELECT id, content, 1 - (embedding <=> $1::vector) as score
    FROM chunks WHERE project_id = $2
    ORDER BY embedding <=> $1::vector LIMIT $3
  `, [JSON.stringify(queryEmbedding), projectId, topK * 2]);

  // 3. RRF融合排序
  return this.rrfMerge(keywordResults, semanticResults, topK);
}

private rrfMerge(list1: any[], list2: any[], topK: number, k: number = 60) {
  const scores = new Map<string, number>();
  list1.forEach((item, i) => {
    scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + i + 1));
  });
  list2.forEach((item, i) => {
    scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + i + 1));
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }));
}
```

### 14.3 前端SSE流式渲染Hook

```typescript
// hooks/useSSE.ts
export function useSSE(url: string) {
  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (body: any) => {
    setContent('');
    setIsStreaming(true);
    abortRef.current = new AbortController();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
      signal: abortRef.current.signal,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'token') {
            setContent(prev => prev + data.content);
          } else if (data.type === 'done') {
            setResultId(data.result_id);
          }
        }
      }
    }
    setIsStreaming(false);
  }, [url]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  return { content, isStreaming, resultId, start, stop };
}
```

---

## 十五、总结

本方案基于9份产品文档，为"教材编写Agent"Web应用提供了从架构到实现的完整技术方案：

- 采用 Next.js + NestJS + PostgreSQL(pgvector) + Redis + LangChain.js 技术栈
- 核心差异化能力：检索驱动写作 + 出处追踪（citation_map）+ 素材不足提示
- 界面形态：三栏工作台（目录导航 + 写作交互 + 出处面板），而非简单聊天窗口
- MVP阶段3周可交付可演示版本，覆盖素材导入→检索→目录→大纲→正文→出处→导出全链路
- 全部由AI Agent团队并行开发，5个Agent角色分工明确，通过共享类型定义和接口契约协作

本方案可直接用于启动开发。
