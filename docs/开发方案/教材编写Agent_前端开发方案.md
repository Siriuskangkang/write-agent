# 教材编写Agent 前端开发方案

> 面向前端开发与联调的实施文档。聚焦页面、组件、状态、交互、流式渲染与前端任务拆解。

---

## 一、前端职责边界

MVP 阶段前端采用 Next.js 14（App Router）作为页面与客户端交互层，职责固定如下：

- 负责页面渲染、路由、组件组织、状态管理
- 通过同源 `/api/*` 访问后端 NestJS
- 不承担业务型 BFF 职责
- 不在前端持久化 access token / refresh token
- 认证通过 httpOnly Cookie + `credentials: "include"` 完成

固定约束：

- 生成类接口统一使用 `POST`
- 流式响应统一使用 `fetch` + `ReadableStream`
- 目录/大纲/正文节点均使用后端返回的稳定 UUID，不使用标题作为业务主键

---

## 二、前端技术栈

| 选项 | 选型 | 说明 |
|:---|:---|:---|
| 框架 | Next.js 14 (App Router) | 页面路由、客户端渲染、后续可扩展 SSR |
| 组件库 | Ant Design 5.x | Tree、Table、Tabs、Form 适合工作台场景 |
| 状态管理 | Zustand | 轻量，适合中等复杂度状态 |
| 流式渲染 | `fetch` + `ReadableStream` | 支持 `POST`、Cookie 认证和 `AbortController` |
| Markdown 渲染 | `react-markdown` + `rehype-highlight` | 展示教材正文与结构化内容 |
| 富文本编辑 | Tiptap | 预留到 Phase 2，MVP 不强依赖 |
| HTTP 客户端 | ky | 统一封装 `/api` 调用 |

---

## 三、信息架构与页面设计

### 3.1 页面清单

| 页面 | 路径 | 说明 |
|:---|:---|:---|
| 登录页 | `/login` | 邮箱密码登录 |
| 注册页 | `/register` | 用户注册 |
| 项目列表页 | `/projects` | 教材项目列表 |
| 写作工作台 | `/projects/[id]` | 三栏布局主页面 |
| 素材管理页 | `/projects/[id]/files` | 文件上传、解析状态、素材列表 |
| 项目设置页 | `/projects/[id]/settings` | 项目级默认参数 |
| 个人设置页 | `/settings` | 昵称、密码、默认写作设置 |

### 3.2 写作工作台布局

工作台采用三栏结构：

- 左栏：目录树、素材快捷入口、任务进度
- 中栏：消息列表、正文区域、输入区、快捷操作按钮
- 右栏：出处面板、检索结果、原文片段预览
- 顶部：项目名称、阶段状态、导出按钮

### 3.3 用户流程

MVP 核心流程：

1. 登录进入项目列表
2. 创建项目
3. 上传素材并等待解析
4. 生成目录
5. 选择章节生成大纲
6. 选择小节生成正文
7. 查看出处与引用
8. 导出 Word / Markdown

---

## 四、核心模块拆解

### 4.1 用户系统

- 登录页、注册页
- 登录态仅保存用户信息与鉴权状态，不保存 token 原文
- 未登录页面通过路由守卫跳转登录
- token 过期依赖后端 refresh cookie 静默刷新

### 4.2 项目管理

- 项目列表卡片展示
- 新建项目弹窗表单
- 最近编辑优先排序
- 删除操作二次确认

### 4.3 素材上传与管理

- 拖拽上传，支持批量
- 素材列表展示文件名、大小、格式、解析状态、时间
- 解析状态轮询更新
- 支持删除、重新解析

### 4.4 目录树

MVP：

- 生成后以结构化树形展示
- 支持折叠、展开、切换版本
- 节点显示素材支撑度标签

Phase 2：

- 拖拽排序
- 增删改节点
- 版本差异对比

### 4.5 大纲面板

- 点击章节点后展示大纲区域
- 流式显示目标、知识点、结构安排、案例建议
- 结构化卡片展示，不用纯文本堆叠

### 4.6 正文区

MVP：

- Markdown 预览 + 基础文本编辑
- 支持生成、改写、扩写、精简
- 支持版本切换与回退

Phase 2：

- Tiptap 富文本编辑
- 正文与出处联动高亮

### 4.7 出处面板

- 增量显示 citation 结果
- 展示文件名、页码、相关度、使用方式
- 点击查看原文片段
- 对素材不足显示显著警告

---

## 五、前端状态设计

建议 Zustand store 划分：

| Store | 职责 |
|:---|:---|
| `authStore` | 用户信息、登录态、鉴权初始化 |
| `projectStore` | 当前项目、项目列表、项目设置 |
| `editorStore` | 当前目录、大纲、正文、版本信息 |
| `chatStore` | 会话、消息、当前流式状态 |

建议最小状态结构：

```ts
type AuthState = {
  currentUser: User | null;
  isAuthenticated: boolean;
  isBootstrapping: boolean;
};

type EditorState = {
  currentDirectoryVersionId: string | null;
  selectedChapterNodeId: string | null;
  selectedSectionNodeId: string | null;
  currentOutlineId: string | null;
  currentResultId: string | null;
  isStreaming: boolean;
};
```

---

## 六、接口接入约定

### 6.1 统一访问方式

- base URL 固定为 `/api`
- 所有请求默认 `credentials: "include"`
- JSON 接口遵循 `success/data/message/error_code`
- SSE 接口直接解析事件流

### 6.2 关键业务主键

前端必须使用以下主键：

- 项目：`project_id`
- 会话：`session_id`
- 文件：`file_id`
- 素材片段：`chunk_id`
- 目录节点：`node_id`
- 大纲：`outline_id`
- 正文结果：`result_id`

### 6.3 正文生成请求体

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

### 6.4 正文流式事件

```text
event: meta
data: {"type":"meta","result_id":"uuid","task_type":"generate","started_at":"2026-03-17T10:00:00Z"}

event: token
data: {"type":"token","content":"教材正文的一个片段","paragraph_key":"p1"}

event: citation
data: {"type":"citation","paragraph_key":"p1","citations":[...]}

event: done
data: {"type":"done","result_id":"uuid","status":"succeeded","citations":[...]}

event: error
data: {"type":"error","message":"LLM service timeout","error_code":"LLM_TIMEOUT"}
```

### 6.5 前端中止策略

- 生成时创建 `AbortController`
- 用户点击“停止”时主动 `abort`
- 中止后保留已接收内容
- 结果状态以重新请求 `GET /api/projects/:id/content/:resultId` 为准

---

## 七、项目结构建议

```text
frontend/
├── src/
│   ├── app/
│   │   ├── login/page.tsx
│   │   ├── register/page.tsx
│   │   ├── projects/page.tsx
│   │   ├── projects/[id]/page.tsx
│   │   ├── projects/[id]/files/page.tsx
│   │   ├── projects/[id]/settings/page.tsx
│   │   └── settings/page.tsx
│   ├── components/
│   │   ├── layout/
│   │   ├── project/
│   │   ├── editor/
│   │   ├── citation/
│   │   ├── file/
│   │   └── common/
│   ├── stores/
│   ├── services/
│   ├── hooks/
│   ├── types/
│   └── utils/
└── tests/
```

关键说明：

- `services/api.ts`：统一 ky 实例，`prefixUrl=/api`
- `hooks/useSSE.ts`：流式正文/目录/大纲的通用解析
- `components/editor/ContentEditor.tsx`：MVP 阶段先支持 Markdown 预览与基础编辑

---

## 八、前端开发计划

### 8.1 MVP 任务

| 编号 | 任务 | 产出 |
|:---|:---|:---|
| F1 | Next.js + Ant Design + Zustand 脚手架 | 可运行空项目 |
| F2 | 登录/注册页面 | 认证流程打通 |
| F3 | 项目列表页 | 项目 CRUD 可操作 |
| F4 | 新建项目弹窗表单 | 表单提交到后端 |
| F5 | 三栏布局骨架 | 工作台结构可见 |
| F6 | 目录树组件 | 树形展示与切换 |
| F7 | 素材列表组件 | 上传入口与状态展示 |
| F8 | 文件上传拖拽区 | 批量上传 |
| F9 | 消息列表 | 消息渲染与滚动 |
| F10 | 输入区 + 快捷按钮 | 触发目录/大纲/正文生成 |
| F11 | SSE 流式渲染 | 打字机效果与停止按钮 |
| F12 | Markdown 渲染 | 正文格式化展示 |
| F13 | 出处面板 | 引用列表与原文预览 |
| F14 | 导出弹窗 | 异步导出与下载 |
| F15 | 路由守卫 + 会话管理 | 登录保护与状态恢复 |

### 8.2 执行顺序

- Week 1：F1 → F2 → F3 → F4
- Week 2：F5 → F6 → F7 → F8 → F9 → F10
- Week 3：F11 → F12 → F13 → F14 → F15

---

## 九、前端测试建议

| 类型 | 工具 | 重点 |
|:---|:---|:---|
| 单元测试 | Vitest + RTL | 组件渲染、状态切换、表单校验 |
| E2E | Playwright | 注册登录、上传素材、生成正文、查看出处、导出 |

重点验证：

- SSE 首字节时间与增量渲染
- 停止按钮的中断行为
- Cookie 认证下页面刷新不掉线
- 工作台左中右三区域状态联动

---

## 十、与其他文档关系

- 后端实现细节见 [教材编写Agent_后端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_后端开发方案.md)
- 接口、DTO、数据库契约见 [教材编写Agent_接口与数据库契约.md](/Users/kang/Desktop/write-agent/教材编写Agent_接口与数据库契约.md)
