# BUG 修复计划

> 基于 `待修复问题.md` 的详细修复计划，按优先级和依赖关系排序。

**制定日期**：2026-03-19
**执行原则**：先修高优先级，单个 BUG 完整修复后再进入下一个，每个 BUG 修复后立即验证。

---

## 修复顺序

按优先级和改动复杂度排序：

1. **BUG-04** 素材文件名中文乱码（高优先级，改动小，已完成 ✅）
2. **BUG-06** 没有登出功能（高优先级，改动小，进行中 🔄）
3. **BUG-07** 内容不可编辑（高优先级，改动大，核心功能缺失）
4. **BUG-02** AI 对话框显示原始 JSON（中优先级，改动小，建议与 BUG-01 一起做）
5. **BUG-01** 左侧区域显示不完整（高优先级，改动中等，依赖 BUG-02 的 Tab 结构）
6. **BUG-03** 目录素材支撑度标签无意义（中优先级，改动小）
7. **BUG-05** 素材未被感知用于生成 + 大量文件支持（中优先级，改动中等）

---

## BUG-04 素材文件名中文乱码 ✅

**状态**：已完成

**改动文件**：
- `backend/src/file/file.service.ts`

**修复内容**：
```typescript
// 修复 multer latin1 解码中文文件名乱码
const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_');

const entity = this.fileRepo.create({
  project_id: projectId,
  file_name: originalName,  // 使用转码后的文件名
  // ...
});
```

**验证步骤**：
1. 上传含中文名的文件（如 `测试文档.pdf`）
2. 检查素材列表中文件名显示是否正常
3. 检查数据库 `source_files.file_name` 字段是否正确存储中文

---

## BUG-06 没有登出功能 🔄

**状态**：进行中

**优先级**：高（安全性问题）

**改动文件**：
- `frontend/src/services/authService.ts` — 新增 `logout()` 方法
- `frontend/src/stores/authStore.ts` — 新增 `logout` action
- `frontend/src/app/projects/page.tsx` — 添加登出按钮（或用户菜单）

### 实施步骤

#### 1. 后端接口确认

后端已有 `POST /api/auth/logout` 接口：
- 路径：`backend/src/auth/auth.controller.ts:71`
- 功能：清除 `wa_access_token` 和 `wa_refresh_token` cookie，使 refresh token 失效
- 鉴权：需要 `JwtAuthGuard`，需携带有效 cookie

#### 2. 前端 authService 新增方法

在 `frontend/src/services/authService.ts` 中添加：

```typescript
async logout(): Promise<ApiResponse<void>> {
  return api.post('auth/logout').json();
}
```

#### 3. authStore 新增 logout action

在 `frontend/src/stores/authStore.ts` 中添加：

```typescript
logout: () => {
  set({ user: null });
  // 清空其他 store 的状态（可选）
}
```

#### 4. 前端 UI 添加登出入口

**方案 A**：在项目列表页右上角添加用户菜单（推荐）

在 `frontend/src/app/projects/page.tsx` 中：

```tsx
import { Dropdown, Avatar, Space } from 'antd';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons';
import { useAuthStore } from '@/stores/authStore';
import { authService } from '@/services/authService';

// 在 ProjectListContent 组件中
const { user, logout: clearAuth } = useAuthStore();

const handleLogout = async () => {
  try {
    await authService.logout();
    clearAuth();
    message.success('已退出登录');
    router.push('/login');
  } catch {
    message.error('退出失败');
  }
};

const userMenu = {
  items: [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: handleLogout,
    },
  ],
};

// 在页面右上角渲染
<Dropdown menu={userMenu} placement="bottomRight">
  <Space style={{ cursor: 'pointer' }}>
    <Avatar icon={<UserOutlined />} />
    <span>{user?.username}</span>
  </Space>
</Dropdown>
```

**方案 B**：在工作台侧边栏底部添加登出按钮

在 `frontend/src/components/workbench/DirectorySidebar.tsx` 底部添加登出按钮（与"素材管理"按钮并列）。

**推荐方案 A**，因为项目列表页和工作台都需要登出功能，用户菜单更通用。

### 验证步骤

1. 登录后，在项目列表页右上角看到用户头像和用户名
2. 点击用户头像，下拉菜单显示"退出登录"
3. 点击"退出登录"，提示"已退出登录"，跳转到登录页
4. 检查浏览器 DevTools → Application → Cookies，确认 `wa_access_token` 和 `wa_refresh_token` 已清除
5. 尝试直接访问 `/projects`，应自动跳转到登录页（AuthGuard 生效）

---

## BUG-01 左侧区域显示不完整

**优先级**：高

**问题描述**：用户需要能查看完整的教材结构（目录 + 大纲 + 正文），对话区只用于显示对话记录，不应该是查看内容的主要入口。

**当前实现分析**：
- 左侧 `DirectorySidebar`：只有目录树
- 中间 `ChatPanel`：对话记录 + 快捷操作按钮，大纲/正文生成后存入 `editorStore`（`currentOutline`、`currentResult`），但没有独立的展示区域
- 右侧 `CitationPanel`：引用来源，默认折叠
- `editorStore` 中已有 `currentOutline`（`OutlineVersion`）和 `currentResult`（`WritingResult`）两个状态，数据是现成的，只缺展示入口

**方案：在中间区域增加内容面板，与对话区 Tab 切换**

工作台布局改为：左侧目录树 + 中间主区域（Tab 切换"对话"和"内容预览"）+ 右侧引用面板。

```
┌──────────┬──────────────────────────────────┬──────────┐
│          │  [对话]  [内容预览]               │          │
│  目录树  ├──────────────────────────────────┤  引用    │
│          │  对话模式：消息流 + 快捷操作      │  面板    │
│          │  内容预览模式：大纲 + 正文        │ (可折叠) │
└──────────┴──────────────────────────────────┴──────────┘
```

**改动文件**：
- `frontend/src/app/projects/[id]/page.tsx` — 中间区域改为 Tabs 布局
- `frontend/src/components/workbench/ChatPanel.tsx` — 抽出快捷操作按钮，保留对话区
- 新增 `frontend/src/components/workbench/ContentPreviewPanel.tsx` — 内容预览面板

### 实施步骤

#### 1. 新增 ContentPreviewPanel 组件

从 `editorStore` 读取 `currentOutline` 和 `currentResult`，分两个区块展示：

```tsx
// frontend/src/components/workbench/ContentPreviewPanel.tsx
import { useEditorStore } from '@/stores/editorStore';
import { Typography, Divider, Empty, Tag } from 'antd';
import ReactMarkdown from 'react-markdown';

export default function ContentPreviewPanel() {
  const { currentOutline, currentResult, directoryNodes,
          selectedChapterNodeId, selectedSectionNodeId } = useEditorStore();

  const chapterNode = directoryNodes.find(n => n.node_id === selectedChapterNodeId);
  const sectionNode = directoryNodes.find(n => n.node_id === selectedSectionNodeId);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '16px 24px' }}>
      {/* 大纲区块 */}
      <section>
        <Typography.Title level={5}>
          大纲{chapterNode ? ` — ${chapterNode.title}` : ''}
        </Typography.Title>
        {currentOutline ? (
          <OutlineView outline={currentOutline} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无大纲，请先选择章节并生成" />
        )}
      </section>

      <Divider />

      {/* 正文区块 */}
      <section>
        <Typography.Title level={5}>
          正文{sectionNode ? ` — ${sectionNode.title}` : ''}
        </Typography.Title>
        {currentResult?.content_text ? (
          <div className="content-preview">
            <ReactMarkdown>{currentResult.content_text}</ReactMarkdown>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无正文，请先选择小节并生成" />
        )}
      </section>
    </div>
  );
}
```

大纲 `OutlineContent` 结构（`objectives`、`key_points`、`structure` 等字段）渲染为可读的列表格式。

#### 2. 修改工作台页面，中间区域改为 Tabs

在 `frontend/src/app/projects/[id]/page.tsx` 的 `<Content>` 区域：

```tsx
import { Tabs } from 'antd';
import ContentPreviewPanel from '@/components/workbench/ContentPreviewPanel';

// 替换原来的 <ChatPanel>
<Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
  <Tabs
    defaultActiveKey="chat"
    style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    tabBarStyle={{ margin: '0', padding: '0 16px', borderBottom: '1px solid #f0f0f0' }}
    items={[
      {
        key: 'chat',
        label: '对话',
        children: <ChatPanel projectId={projectId} onShowCitations={() => setRightCollapsed(false)} />,
      },
      {
        key: 'preview',
        label: '内容预览',
        children: <ContentPreviewPanel />,
      },
    ]}
  />
</Content>
```

### 验证步骤

1. 工作台中间区域顶部出现"对话"和"内容预览"两个 Tab
2. 生成大纲后，切换到"内容预览"Tab，能看到大纲内容（结构化展示，非 JSON）
3. 生成正文后，切换到"内容预览"Tab，能看到正文内容（Markdown 渲染）
4. 切换目录树节点后，内容预览随之更新
5. "对话"Tab 功能不受影响

---

## BUG-03 目录素材支撑度标签无意义

**优先级**：中

**改动文件**：
- `frontend/src/components/workbench/DirectorySidebar.tsx`

### 实施步骤

#### 1. 给 Tag 加 Tooltip

修改 `NodeTitle` 组件：

```tsx
import { Tooltip } from 'antd';

const supportLabelMap: Record<MaterialSupport, string> = {
  [MaterialSupport.HIGH]: '素材充足',
  [MaterialSupport.MEDIUM]: '素材一般',
  [MaterialSupport.LOW]: '素材不足',
};

const supportTooltipMap: Record<MaterialSupport, string> = {
  [MaterialSupport.HIGH]: '该小节在已上传素材中有充足的参考内容',
  [MaterialSupport.MEDIUM]: '该小节在已上传素材中有一定参考内容',
  [MaterialSupport.LOW]: '该小节在已上传素材中的参考内容较少，建议补充相关素材',
};

function NodeTitle({ node }: { node: DirectoryNode }) {
  const color = node.material_support ? supportColorMap[node.material_support] : undefined;
  const label = node.material_support ? supportLabelMap[node.material_support] : undefined;
  const tooltip = node.material_support ? supportTooltipMap[node.material_support] : undefined;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {node.title}
      {node.material_support && (
        <Tooltip title={tooltip}>
          <Tag color={color} style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>
            {label}
          </Tag>
        </Tooltip>
      )}
    </span>
  );
}
```

#### 2. 在目录树顶部添加说明

在 `DirectorySidebar` 的目录树上方添加一行小字：

```tsx
<Text type="secondary" style={{ fontSize: 12, padding: '0 8px', display: 'block', marginBottom: 8 }}>
  目录结构
</Text>
<Text type="secondary" style={{ fontSize: 11, padding: '0 8px', display: 'block', marginBottom: 4, color: '#999' }}>
  标签颜色表示该节的素材支撑度
</Text>
```

### 验证步骤

1. 生成目录后，查看目录树中的标签
2. 鼠标悬停在标签上，应显示 Tooltip 说明
3. 标签文字应为"素材充足"/"素材一般"/"素材不足"，而非原始枚举值

---

## BUG-05 素材未被感知用于生成 + 大量文件支持

**优先级**：中

**改动文件**：
- `frontend/src/components/workbench/ChatPanel.tsx` — 生成目录按钮添加解析状态检查
- `frontend/src/app/projects/[id]/materials/page.tsx` — 添加说明文字 + 分页支持
- `backend/src/file/file.controller.ts` — 提升单次上传上限

### 实施步骤

#### 5.1 前端生成目录前检查素材解析状态

在 `ChatPanel` 的"生成目录"按钮点击时，先检查是否有文件处于 `pending`/`parsing` 状态：

```tsx
const handleGenerateDirectory = async () => {
  // 检查素材解析状态
  const filesRes = await fileService.listFiles(projectId, { page: 1, page_size: 100 });
  if (filesRes.success) {
    const parsingFiles = filesRes.data.items.filter(
      f => f.parse_status === ParseStatus.PENDING || f.parse_status === ParseStatus.PARSING
    );
    if (parsingFiles.length > 0) {
      Modal.confirm({
        title: '提示',
        content: `当前有 ${parsingFiles.length} 个素材文件仍在解析中，建议等待解析完成后再生成，以获得更好效果。是否继续？`,
        onOk: () => doGenerateDirectory(),
      });
      return;
    }
  }
  doGenerateDirectory();
};
```

#### 5.2 素材管理页面添加说明

在 `materials/page.tsx` 的上传区域下方添加说明：

```tsx
<Alert
  message="素材说明"
  description="已上传的素材将在解析完成后自动用于内容生成。每次生成时，系统会根据关键词检索最相关的素材内容。"
  type="info"
  showIcon
  style={{ marginBottom: 16 }}
/>
```

#### 5.3 提升单次上传上限

修改 `backend/src/file/file.controller.ts:52`：

```typescript
@UseInterceptors(FilesInterceptor('files', 50, { storage: memoryStorage() }))
```

#### 5.4 前端素材列表支持分页

修改 `materials/page.tsx`：

```tsx
const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });

const fetchFiles = useCallback(async () => {
  const res = await fileService.listFiles(projectId, {
    page: pagination.current,
    page_size: pagination.pageSize,
  });
  if (res.success) {
    setFiles(res.data.items);
    setTotal(res.data.total);
  }
}, [projectId, pagination]);

<Table
  columns={columns}
  dataSource={files}
  rowKey="id"
  loading={loading}
  pagination={{
    current: pagination.current,
    pageSize: pagination.pageSize,
    total: total,
    showSizeChanger: true,
    showTotal: (total) => `共 ${total} 个文件`,
    onChange: (page, pageSize) => setPagination({ current: page, pageSize }),
  }}
/>
```

### 验证步骤

1. 上传 30 个文件，检查是否全部成功
2. 素材列表应支持分页，每页显示 20 条
3. 刚上传完文件立即点"生成目录"，应弹出提示"部分素材仍在解析中"
4. 等待解析完成后再生成，应正常使用素材

---

## BUG-02 AI 对话框显示原始 JSON

**优先级**：中

**问题描述**：点击"生成目录"、"生成大纲"等按钮后，AI 回复的消息内容是原始 JSON 字符串，直接显示在对话框里，用户体验差。

**当前实现分析**：

`ChatPanel.tsx` 的 `onDone` 回调（第 387 行）在生成完成后，会把 `finalContent`（即 AI 输出的原始 JSON 字符串）通过 `persistMessage` 存入数据库，`content` 字段就是 JSON 文本。消息列表渲染时（第 744 行）直接用 `ReactMarkdown` 渲染 `msg.content`，JSON 就原样显示出来了。

触发场景：
- 生成目录：AI 输出 `{"chapters": [...]}` 格式 JSON
- 生成大纲：AI 输出 `{"objectives": [...], "key_points": [...], ...}` 格式 JSON
- 生成正文/改写/扩写/精简：AI 输出 Markdown 正文，**不受此问题影响**

**方案：存消息时替换为友好文案，JSON 数据通过 metadata 保留**

核心思路：`persistMessage` 存入数据库的 `content` 改为用户友好的提示文字，原始 JSON 不存入 `content`（已通过 `metadata.directory_version_id` / `metadata.outline_id` 关联到对应版本，不需要重复存）。

**改动文件**：
- `frontend/src/components/workbench/ChatPanel.tsx` — `onDone` 回调中修改目录/大纲消息的 `content`

### 实施步骤

#### 修改 ChatPanel.tsx 的 onDone 回调

在 `persistMessage` 调用前，根据 `currentTaskType` 替换 `content`：

```typescript
// 目录生成完成后（第 500 行附近）
await persistMessage({
  role: MessageRole.ASSISTANT,
  content: currentTaskType === 'directory'
    ? `目录已生成，共 ${nodes.filter(n => n.node_type === NodeType.CHAPTER).length} 章，可在左侧目录树查看。`
    : currentTaskType === 'outline'
    ? `大纲已生成，可切换到「内容预览」Tab 查看详情。`
    : finalContent,   // 正文/改写/扩写/精简保持原样
  message_type: messageType,
  metadata,
});
```

同时，流式输出阶段（`isStreaming && streamContent`，第 756 行）目录和大纲生成时显示的是实时 JSON token 流，也需要替换为加载提示：

```tsx
{isStreaming && streamContent && (
  <div ...>
    {currentTaskType === 'directory' || currentTaskType === 'outline' ? (
      <Text type="secondary">
        <LoadingOutlined /> 正在生成{currentTaskType === 'directory' ? '目录' : '大纲'}...
      </Text>
    ) : (
      <div className="chat-markdown">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{streamContent}</ReactMarkdown>
        <span className="typing-cursor" />
      </div>
    )}
  </div>
)}
```

历史消息渲染时，对 `message_type === 'directory'` 和 `message_type === 'outline'` 的消息，如果 `content` 仍是旧的 JSON 字符串（历史数据），也需要做兼容处理：

```tsx
// 渲染消息内容时
function renderMessageContent(msg: Message) {
  // 兼容历史数据：如果是目录/大纲消息且内容是 JSON，替换为友好提示
  if (msg.message_type === MessageType.DIRECTORY) {
    const isJson = msg.content.trim().startsWith('{') || msg.content.trim().startsWith('```');
    return isJson ? '目录已生成，可在左侧目录树查看。' : msg.content;
  }
  if (msg.message_type === MessageType.OUTLINE) {
    const isJson = msg.content.trim().startsWith('{') || msg.content.trim().startsWith('```');
    return isJson ? '大纲已生成，可切换到「内容预览」Tab 查看详情。' : msg.content;
  }
  return msg.content;
}
```

### 验证步骤

1. 点击"生成目录"，流式输出阶段显示"正在生成目录..."，不显示 JSON token 流
2. 目录生成完成后，对话框显示"目录已生成，共 X 章，可在左侧目录树查看。"
3. 点击"生成大纲"，完成后显示"大纲已生成，可切换到「内容预览」Tab 查看详情。"
4. 生成正文/改写/扩写/精简，对话框仍正常显示 Markdown 正文内容（不受影响）
5. 刷新页面后，历史消息中的目录/大纲消息也显示友好文案，不显示 JSON

---

## BUG-07 内容不可编辑（目录/大纲/正文均无手动修改入口）

**优先级**：高

**问题描述**：目录生成后无法手动修改节点标题、增删章节/小节；大纲生成后无法手动调整；正文生成后只能通过 AI 改写/扩写/精简，无法直接编辑文字。整个创作流程是单向的，不闭合。

**全面排查结果**：

| 内容类型 | 后端是否有修改接口 | 前端是否有修改入口 | 结论 |
|---------|-----------------|-----------------|------|
| 目录节点（增/删/改/排序） | ❌ 无 PUT/PATCH/DELETE | ❌ 无 | 完全不可编辑 |
| 大纲内容 | ❌ 无更新接口，只有 save（覆盖写） | ❌ 无 | 完全不可编辑 |
| 正文内容 | ❌ 无直接更新接口 | ❌ 无富文本编辑器 | 只能靠 AI 改写 |
| 项目基础信息 | ✅ `PUT /projects/:id` | ✅ 项目设置页 | 已支持 |
| 项目备注 | ✅ `PUT /projects/:id/state` | ✅ 项目设置页 | 已支持 |

**三类内容的修复方案各不相同，分开实施：**

---

### 7.1 目录手动编辑

**现状**：`DirectorySidebar` 只是一个只读树，没有任何编辑操作。后端 `saveDirectory` 接口接受完整的 `nodes` 数组覆盖写入，**不需要新增后端接口**，只需前端构造修改后的 nodes 再调用 `saveDirectory`。

**方案**：在目录树节点上增加右键菜单或行内操作按钮，支持：
- 重命名章节/小节（双击标题进入编辑态）
- 新增小节（在章节下方）
- 新增章节（在末尾）
- 删除节点（带确认）
- 上移/下移（调整 `order_index`）

**改动文件**：
- `frontend/src/components/workbench/DirectorySidebar.tsx` — 树节点增加编辑操作

**核心实现思路**：

```tsx
// 双击标题进入编辑态
function NodeTitle({ node, onRename }: { node: DirectoryNode; onRename: (id: string, title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(node.title);

  if (editing) {
    return (
      <Input
        size="small"
        value={value}
        autoFocus
        onChange={e => setValue(e.target.value)}
        onBlur={() => { onRename(node.node_id, value); setEditing(false); }}
        onPressEnter={() => { onRename(node.node_id, value); setEditing(false); }}
        onClick={e => e.stopPropagation()}
        style={{ width: 140 }}
      />
    );
  }
  return <span onDoubleClick={() => setEditing(true)}>{node.title}</span>;
}

// 修改后调用 saveDirectory 持久化
const handleRename = async (nodeId: string, newTitle: string) => {
  const updated = directoryNodes.map(n =>
    n.node_id === nodeId ? { ...n, title: newTitle } : n
  );
  const res = await projectService.saveDirectory(projectId, {
    base_version_number: currentVersionNumber,
    nodes: updated,
  });
  if (res.success) {
    setDirectoryNodes(res.data.content);
    setCurrentDirectoryVersionId(res.data.id);
  }
};
```

节点的增删改都遵循同样模式：在本地修改 `directoryNodes` 数组，然后调用 `saveDirectory` 一次性保存。

---

### 7.2 大纲手动编辑

**现状**：大纲是结构化 JSON（`OutlineContent`：`objectives`、`key_points`、`structure`、`case_suggestions` 等字段），目前只能重新生成覆盖。后端 `saveOutline` 同样是覆盖写，**不需要新增后端接口**。

**方案**：在 BUG-01 的"内容预览"Tab 中，大纲区块增加编辑模式，各字段用可编辑列表展示：

```tsx
// 大纲编辑态示例（objectives 字段）
<List
  dataSource={outline.content.objectives}
  renderItem={(item, index) => (
    <List.Item
      actions={[
        <Button size="small" icon={<DeleteOutlined />} onClick={() => removeObjective(index)} />,
      ]}
    >
      <Input
        value={item}
        onChange={e => updateObjective(index, e.target.value)}
        variant="borderless"
      />
    </List.Item>
  )}
  footer={
    <Button size="small" icon={<PlusOutlined />} onClick={addObjective}>
      添加目标
    </Button>
  }
/>
```

编辑完成后点"保存大纲"，调用 `contentService.saveOutline` 持久化。

**改动文件**：
- `frontend/src/components/workbench/ContentPreviewPanel.tsx`（BUG-01 新增的组件）— 大纲区块增加编辑/保存功能

---

### 7.3 正文手动编辑

**现状**：正文是 Markdown 纯文本，存在 `WritingResult.content_text`。后端没有直接更新 `content_text` 的接口，只有 AI 改写/扩写/精简（每次都创建新的 `WritingResult` 记录）。

**方案**：

**后端**：新增 `PATCH /projects/:projectId/content/:resultId` 接口，允许直接更新 `content_text`（手动编辑场景，不走 AI）：

```typescript
// content.controller.ts 新增
@Patch(':resultId')
async updateContent(
  @CurrentUser() user: JwtPayload,
  @Param('projectId', ParseUUIDPipe) projectId: string,
  @Param('resultId', ParseUUIDPipe) resultId: string,
  @Body() dto: { content_text: string },
) {
  const result = await this.contentService.updateContentText(user.sub, projectId, resultId, dto.content_text);
  return ok(result);
}
```

```typescript
// content.service.ts 新增
async updateContentText(userId: string, projectId: string, resultId: string, contentText: string) {
  await this.projectService.findOne(userId, projectId);
  await this.writingResultRepo.update(
    { id: resultId, project_id: projectId },
    { content_text: contentText, word_count: contentText.length },
  );
  return this.getWritingResult(projectId, resultId);
}
```

**前端**：在"内容预览"Tab 的正文区块，增加"编辑"按钮，点击后切换为 `Input.TextArea`（或轻量 Markdown 编辑器），编辑完成后调用新接口保存：

```tsx
const [editingContent, setEditingContent] = useState(false);
const [contentDraft, setContentDraft] = useState('');

const handleSaveContent = async () => {
  const res = await contentService.updateContent(projectId, currentResult.id, contentDraft);
  if (res.success) {
    setCurrentResult(res.data);
    setEditingContent(false);
    message.success('正文已保存');
  }
};
```

**改动文件**：
- `backend/src/content/content.controller.ts` — 新增 PATCH 接口
- `backend/src/content/content.service.ts` — 新增 `updateContentText` 方法
- `frontend/src/services/contentService.ts` — 新增 `updateContent` 方法
- `frontend/src/components/workbench/ContentPreviewPanel.tsx` — 正文区块增加编辑/保存功能

---

### 验证步骤

**目录编辑**：
1. 双击目录树中的章节标题，进入编辑态，修改后回车保存
2. 刷新页面，目录树显示修改后的标题
3. 点击"新增小节"，输入标题后保存，目录树出现新节点
4. 删除一个小节，确认后节点消失，刷新后仍不存在

**大纲编辑**：
1. 生成大纲后，切换到"内容预览"Tab
2. 点击"编辑大纲"，各字段变为可编辑状态
3. 修改某个学习目标，点"保存大纲"
4. 刷新页面，大纲显示修改后的内容

**正文编辑**：
1. 生成正文后，切换到"内容预览"Tab
2. 点击"编辑正文"，正文变为可编辑的文本框
3. 修改部分内容，点"保存"
4. 刷新页面，正文显示修改后的内容
5. 保存后仍可继续使用 AI 改写/扩写/精简（基于修改后的内容）

---

## 验收标准

每个 BUG 修复后，必须通过以下验收：

1. **功能验收**：按验证步骤逐项检查，全部通过
2. **回归验收**：确保修复未引入新问题，核心流程（登录、创建项目、上传素材、生成目录/大纲/正文）仍正常
3. **代码审查**：改动符合项目编码规范，无明显性能或安全问题
4. **文档更新**：如有必要，更新 `CLAUDE.md` 或开发文档

---

## 执行时间估算

| BUG | 预计工时 | 状态 |
|-----|---------|------|
| BUG-04 | 0.5h | ✅ 已完成 |
| BUG-06 | 1h | 🔄 进行中 |
| BUG-07 | 4h | ⏳ 待开始 |
| BUG-02 | 1h | ⏳ 待开始 |
| BUG-01 | 2h | ⏳ 待开始 |
| BUG-03 | 1h | ⏳ 待开始 |
| BUG-05 | 2h | ⏳ 待开始 |

**总计**：约 11.5h

---

## 新增问题修复计划（BUG-13 / BUG-14 / FEAT-03 / FEAT-04 / FEAT-05 / FEAT-06）

> 基于 2026-03-25 补充的待修复清单，结合当前代码实际状态制定。

### 修复顺序

1. **BUG-13** scrollTo 空指针（高优先级，改动极小）
2. **BUG-14** 标签页与操作不匹配缺少拦截（中优先级，改动小）
3. **FEAT-06** 我的账单入口占位（低优先级，改动极小）
4. **FEAT-03** 正文引用格式（高优先级，改动中等，仅 prompt + CitationPanel）
5. **FEAT-04** 目录/大纲/正文强关联生成（高优先级，改动较大，涉及后端 prompt 链）
6. **FEAT-05** 目录节点拖拽排序（中优先级，改动中等，前端为主）

---

## BUG-13 更新目录名称时报 scrollTo 空指针

**状态**：待修复

**根因**（基于代码分析）：

`DirectorySidebar.tsx` 中 `Tree` 组件没有传 `ref`，但 `@rc-component/tree` 内部在节点 `Input` 触发 `onBlur` → `onFocus` 时会调用 `Tree.scrollTo`，此时 tree 内部的滚动容器 ref 可能尚未就绪（首次渲染后立即进入编辑态时概率更高）。

**改动文件**：
- `frontend/src/components/workbench/DirectorySidebar.tsx`

**实施步骤**：

#### 1. 给 Tree 加 `virtual={false}` 禁用虚拟滚动

虚拟滚动模式下 `scrollTo` 依赖内部容器 ref，禁用后改为原生滚动，彻底规避该问题：

```tsx
<Tree
  showIcon
  defaultExpandAll
  virtual={false}
  selectedKeys={...}
  treeData={treeData}
  onSelect={handleSelect}
  style={{ background: 'transparent' }}
/>
```

`virtual={false}` 对节点数量不多的目录树（通常 < 50 节点）无性能影响。

**验证步骤**：
1. 生成目录后，hover 节点，点击编辑图标进入编辑态
2. 修改标题后按 Enter 或点击其他区域触发 onBlur
3. 控制台不再出现 `TypeError: Cannot read properties of null (reading 'scrollTo')`
4. 标题正常保存

---

## BUG-14 标签页与操作不匹配时缺少前端拦截提示

**状态**：待修复

**根因**（基于代码分析）：

当前 `ChatPanel.tsx` 的 `handleQuickAction`（第 728 行）对 `outline` 和 `content` 操作只检查了"是否选中节点"，没有检查当前激活 tab 的类型。

关键逻辑：
- `editorStore` 中 `activeTabId` 对应当前激活的 tab
- `tabs` 数组中每个 tab 有 `nodeType`（`NodeType.CHAPTER` 或 `NodeType.SECTION`）
- 生成大纲应在 `CHAPTER` tab 下触发；生成正文应在 `SECTION` tab 下触发

**改动文件**：
- `frontend/src/components/workbench/ChatPanel.tsx`

**实施步骤**：

在 `handleQuickAction` 的 `outline` 和 `content` 分支中，增加对当前激活 tab 类型的检查：

```typescript
// ChatPanel.tsx handleQuickAction 中，在现有 selectedChapterNodeId 检查之前插入

case 'outline': {
  // 新增：检查当前激活 tab 是否为章节 tab
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab && activeTab.nodeType !== NodeType.CHAPTER) {
    message.warning('请先在目录树中选择一个章节（非小节），再生成大纲');
    return;
  }
  // 原有逻辑不变...
}

case 'content': {
  // 新增：检查当前激活 tab 是否为小节 tab
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab && activeTab.nodeType !== NodeType.SECTION) {
    message.warning('请先在目录树中选择一个小节，再生成正文');
    return;
  }
  // 原有逻辑不变...
}
```

`ChatPanel` 已从 `useEditorStore` 中解构了 `tabs` 和 `activeTabId`（可在文件顶部确认），无需额外引入。

**验证步骤**：
1. 点击目录树中的章节，激活章节 tab，点击"生成正文" → 弹出提示"请先选择一个小节"
2. 点击目录树中的小节，激活小节 tab，点击"生成大纲" → 弹出提示"请先选择一个章节"
3. 章节 tab 下点击"生成大纲" → 正常触发
4. 小节 tab 下点击"生成正文" → 正常触发

---

## FEAT-06 新增"我的账单"入口（占位）

**状态**：待开发

**改动文件**：
- `frontend/src/components/layout/AppShell.tsx`

**实施步骤**：

在 `navItems` 数组中新增账单入口，点击后用 `message.warning` 提示无权限（无需新建页面）：

```tsx
// AppShell.tsx navItems 定义处
import { CreditCardOutlined } from '@ant-design/icons';

// 在 navItems 中追加（放在"个人设置"之前）
{ key: 'billing' as const, icon: <CreditCardOutlined />, label: '我的账单', href: null },
```

渲染时对 `href: null` 的项改为 `<button>` 而非 `<Link>`，点击触发提示：

```tsx
{navItems.map((item) =>
  item.href ? (
    <Link key={item.key} href={item.href} className={...}>...</Link>
  ) : (
    <button
      key={item.key}
      type="button"
      className="app-shell-sidebar-item"
      onClick={() => message.warning('暂无权限，请联系管理员开通')}
    >
      <span className="app-shell-sidebar-item-icon">{item.icon}</span>
      <span className="app-shell-sidebar-item-label">{item.label}</span>
    </button>
  )
)}
```

**验证步骤**：
1. 侧边栏出现"我的账单"菜单项
2. 点击后弹出"暂无权限，请联系管理员开通"
3. 不跳转页面，不报错

---

## FEAT-03 正文引用格式改为国内学术论文格式（GB/T 7714）

**状态**：待开发

**改动文件**：
- `backend/src/agent/prompts/content.prompt.ts`（或对应正文生成 prompt 文件）
- `frontend/src/components/workbench/CitationPanel.tsx`

**实施步骤**：

#### 1. 修改后端正文生成 prompt

在正文生成 prompt 的引用说明部分，明确要求使用 GB/T 7714 格式：

```
引用格式要求（GB/T 7714）：
- 著作：作者. 书名[M]. 出版地: 出版社, 年份: 页码.
- 期刊：作者. 文章题目[J]. 期刊名, 年份, 卷(期): 起止页码.
- 网络资源：作者. 标题[EB/OL]. (发布日期)[引用日期]. URL.
- 正文内引用使用上标数字标注，如：...研究表明[1]...
```

#### 2. CitationPanel 按 GB/T 7714 格式渲染

在 `CitationPanel.tsx` 中，根据引用的 `source_type` 字段拼接对应格式的引用字符串，替换当前的原始展示方式。

**验证步骤**：
1. 生成正文后，查看正文中的引用标注格式
2. 打开引用面板，确认引用条目按 GB/T 7714 格式展示
3. 著作、期刊、网络资源三种类型格式均正确

---

## FEAT-04 目录 / 大纲 / 正文强关联生成

**状态**：待开发

**改动文件**：
- `backend/src/agent/prompts/directory.prompt.ts`
- `backend/src/agent/prompts/outline.prompt.ts`
- `backend/src/agent/prompts/content.prompt.ts`
- `backend/src/content/content.service.ts`（生成大纲/正文时注入上下文）

**实施步骤**：

#### 1. 目录生成注入教材设置

在目录生成 prompt 中注入项目设置信息（课程名称、受众、章节数要求等），约束 AI 按设置生成：

```
教材基本信息：
- 课程名称：{project.name}
- 目标受众：{project.target_audience}
- 要求章节数：{project.chapter_count}（必须严格按此数量生成，不得多也不得少）
- 每章小节数：{project.sections_per_chapter}
```

#### 2. 大纲生成注入目录结构

在 `content.service.ts` 的大纲生成方法中，查询当前目录版本，将该章节的完整节点结构（章节标题 + 所有小节标题）注入 prompt：

```typescript
// 查询当前章节的所有小节
const chapterNode = directoryNodes.find(n => n.node_id === chapterNodeId);
const sectionNodes = directoryNodes.filter(
  n => n.parent_node_id === chapterNodeId && n.node_type === NodeType.SECTION
);

// 注入 prompt
const sectionList = sectionNodes
  .sort((a, b) => a.order_index - b.order_index)
  .map((s, i) => `  ${i + 1}. ${s.title}`)
  .join('\n');
```

prompt 约束：
```
本章目录结构（大纲必须严格按此结构生成，小节数量和标题与目录一一对应）：
章节：{chapterNode.title}
小节列表：
{sectionList}
```

#### 3. 正文生成注入大纲上下文

在正文生成时，查询该章节的最新大纲版本，将对应小节的大纲内容注入 prompt：

```typescript
// 查询该章节的最新大纲
const latestOutline = await this.outlineVersionRepo.findOne({
  where: { project_id: projectId, chapter_node_id: chapterNodeId },
  order: { created_at: 'DESC' },
});

// 从大纲中找到对应小节的结构
const sectionOutline = latestOutline?.content?.structure?.find(
  s => s.section_title === sectionNode.title
);
```

prompt 约束：
```
本小节在目录中的位置：{chapterNode.title} > {sectionNode.title}
本小节大纲要点：
{sectionOutline 的 key_points / sub_sections}

正文必须严格围绕以上大纲要点展开，不得偏离章节范围。
```

**验证步骤**：
1. 生成目录，确认章节数与项目设置一致
2. 选择某章节生成大纲，确认大纲中的小节数量与目录中该章节的小节数一致
3. 选择某小节生成正文，确认正文内容与该小节的大纲要点对应
4. 修改目录后重新生成大纲，确认大纲随目录更新

---

## FEAT-05 目录节点支持拖拽排序

**状态**：待开发

**改动文件**：
- `frontend/src/components/workbench/DirectorySidebar.tsx`
- `backend/src/content/content.controller.ts`（确认 saveDirectory 接口支持 order_index 更新）

**实施步骤**：

#### 1. 启用 Tree 的 draggable

```tsx
<Tree
  showIcon
  defaultExpandAll
  virtual={false}
  draggable={{ icon: false }}
  onDrop={handleDrop}
  selectedKeys={...}
  treeData={treeData}
  onSelect={handleSelect}
  style={{ background: 'transparent' }}
/>
```

#### 2. 实现 handleDrop

```typescript
const handleDrop: TreeProps['onDrop'] = useCallback(
  async (info) => {
    const dragKey = String(info.dragNode.key);
    const dropKey = String(info.node.key);
    const dropPos = info.node.pos.split('-');
    const dropPosition = info.dropPosition - Number(dropPos[dropPos.length - 1]);

    const dragNode = directoryNodes.find((n) => n.node_id === dragKey);
    const dropNode = directoryNodes.find((n) => n.node_id === dropKey);
    if (!dragNode || !dropNode) return;

    // 不允许跨层级拖拽（章节不能拖到小节下，小节不能拖到章节层）
    if (dragNode.node_type !== dropNode.node_type && dropPosition !== -1) {
      message.warning('不支持跨层级拖拽');
      return;
    }

    // 重新计算 order_index
    const siblings = directoryNodes
      .filter((n) => n.parent_node_id === dragNode.parent_node_id && n.node_type === dragNode.node_type)
      .sort((a, b) => a.order_index - b.order_index);

    const withoutDrag = siblings.filter((n) => n.node_id !== dragKey);
    const dropIdx = withoutDrag.findIndex((n) => n.node_id === dropKey);
    const insertIdx = dropPosition === -1 ? dropIdx : dropIdx + 1;
    withoutDrag.splice(insertIdx, 0, dragNode);

    const updated = directoryNodes.map((n) => {
      const newIdx = withoutDrag.findIndex((s) => s.node_id === n.node_id);
      return newIdx >= 0 ? { ...n, order_index: newIdx } : n;
    });

    // 乐观更新 + 持久化
    setDirectoryNodes(updated);
    try {
      const res = await contentService.saveDirectory(projectId, {
        base_version_number: currentDirectoryVersionNumber,
        nodes: updated,
      });
      if (res.success) {
        setDirectoryNodes(res.data.content);
        setCurrentDirectoryVersionId(res.data.id);
      }
    } catch {
      message.error('排序保存失败');
      loadDirectory(); // 回滚
    }
  },
  [directoryNodes, projectId, currentDirectoryVersionNumber, setDirectoryNodes, setCurrentDirectoryVersionId, loadDirectory],
);
```

**验证步骤**：
1. 拖拽章节调整顺序，目录树实时更新
2. 拖拽小节在同章节内调整顺序，目录树实时更新
3. 刷新页面，顺序保持不变（已持久化）
4. 尝试跨层级拖拽，弹出提示"不支持跨层级拖拽"

---

## 更新后执行时间估算

| 问题 | 预计工时 | 状态 |
|------|---------|------|
| BUG-04 | 0.5h | ✅ 已完成 |
| BUG-06 | 1h | ✅ 已完成 |
| BUG-07 | 4h | ✅ 已完成 |
| BUG-02 | 1h | ✅ 已完成 |
| BUG-01 | 2h | ✅ 已完成 |
| BUG-03 | 1h | ✅ 已完成 |
| BUG-05 | 2h | ✅ 已完成 |
| BUG-15 | 0.5h | ✅ 已完成 |
| BUG-13 | 0.5h | ✅ 已完成 |
| BUG-14 | 1h | ✅ 已完成 |
| FEAT-06 | 0.5h | ✅ 已完成 |
| FEAT-03 | 2h | ✅ 已完成 |
| FEAT-04 | 4h | ✅ 已完成 |
| FEAT-05 | 3h | ✅ 已完成 |

**新增合计**：约 11h
