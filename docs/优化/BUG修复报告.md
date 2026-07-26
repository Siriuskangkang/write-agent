# BUG 修复报告

> 生成时间：2026-03-19
> 修复方式：Agent Team 并行执行

---

## 修复概览

| BUG | 优先级 | 状态 | 负责 Agent |
|-----|--------|------|-----------|
| BUG-04 文件名中文乱码 | 高 | ✅ 已修复 | worker-backend |
| BUG-05.1 上传限制 20→50 | 中 | ✅ 已修复 | worker-backend |
| BUG-05.2 素材解析中提示 | 中 | ✅ 已修复 | worker-frontend-b |
| BUG-06 没有登出功能 | 高 | ✅ 已修复 | worker-frontend-a |
| BUG-03 素材支撑度标签无意义 | 中 | ✅ 已修复 | worker-frontend-a |
| BUG-02 AI 对话框显示原始 JSON | 中 | ✅ 已修复 | worker-frontend-a |
| BUG-01 左侧区域显示不完整 | 高 | ✅ 已修复 | worker-frontend-b |
| BUG-07 内容不可编辑 | 高 | ✅ 已修复 | worker-backend + worker-frontend-b |

**总计**：8 个 BUG 全部修复完成

---

## 修改文件统计

### 后端（4 个文件）

| 文件 | 修改行数 | 涉及 BUG |
|------|---------|---------|
| `backend/src/file/file.service.ts` | +28 | BUG-04 |
| `backend/src/file/file.controller.ts` | +30 | BUG-05.1 |
| `backend/src/content/content.controller.ts` | +73 | BUG-07 |
| `backend/src/content/content.service.ts` | +44 | BUG-07 |

**后端总计**：+175 行

### 前端（6 个文件）

| 文件 | 修改行数 | 涉及 BUG |
|------|---------|---------|
| `frontend/src/app/projects/[id]/page.tsx` | +168 | BUG-01, BUG-06, BUG-07 |
| `frontend/src/app/projects/page.tsx` | +37 | BUG-06 参考 |
| `frontend/src/components/workbench/DirectorySidebar.tsx` | +178 | BUG-03, BUG-07 |
| `frontend/src/components/workbench/ChatPanel.tsx` | +64 | BUG-02, BUG-05.2 |
| `frontend/src/hooks/useSSE.ts` | +25 | BUG-02 |
| `frontend/src/services/contentService.ts` | +18 | BUG-07 |

**前端总计**：+490 行

**全项目总计**：+665 行（净增）

---

## 详细修复内容

### BUG-04：文件名中文乱码 ✅

**文件**：`backend/src/file/file.service.ts:62-75`

**修复**：
```typescript
// 修改前
file_name: file.originalname,

// 修改后
const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_');
// ...
file_name: originalName,
```

**测试建议**：上传中文名文件（如 `测试文档.pdf`），在素材列表中确认文件名正常显示。

---

### BUG-05.1：上传文件数量限制 ✅

**文件**：`backend/src/file/file.controller.ts:52`

**修复**：
```typescript
// 修改前
@UseInterceptors(FilesInterceptor('files', 20, { storage: memoryStorage() }))

// 修改后
@UseInterceptors(FilesInterceptor('files', 50, { storage: memoryStorage() }))
```

**测试建议**：上传 21-50 个文件，确认不报错。

---

### BUG-05.2：素材解析中提示 ✅

**文件**：`frontend/src/components/workbench/ChatPanel.tsx`

**修复**：在快捷操作按钮区域上方，检测文件解析状态，若有 pending/parsing 文件则显示 Alert 提示：
> "部分素材仍在解析中，建议等待解析完成后再生成，以获得更好效果。"

**测试建议**：上传文件后立即进入工作台，确认出现解析中提示。

---

### BUG-06：没有登出功能 ✅

**文件**：`frontend/src/app/projects/[id]/page.tsx`

**修复**：在工作台页面 Header 右侧添加用户头像下拉菜单，包含"退出登录"按钮。点击后调用 `POST /api/auth/logout`，清空 cookie 和本地状态，跳转到登录页。

**测试建议**：在工作台页面点击右上角头像 → 点击"退出登录" → 确认跳转到登录页。

---

### BUG-03：素材支撑度标签无意义 ✅

**文件**：`frontend/src/components/workbench/DirectorySidebar.tsx`

**修复**：给素材支撑度 Tag 包裹 `<Tooltip>`，悬停时显示说明：
- 充足：素材支撑度充足：该小节在已上传素材中有较多参考内容
- 一般：素材支撑度一般：该小节在已上传素材中有少量参考内容
- 不足：素材支撑度不足：该小节在已上传素材中几乎没有参考内容

**测试建议**：在工作台目录树中，悬停在支撑度 Tag 上，确认出现说明 Tooltip。

---

### BUG-02：AI 对话框显示原始 JSON ✅

**文件**：`frontend/src/components/workbench/ChatPanel.tsx`、`frontend/src/hooks/useSSE.ts`

**修复**：在渲染 assistant 消息时，检测内容是否为 JSON：
- 含 `node_type`/`children` 字段 → 显示"✅ 目录已生成，请查看左侧目录树"
- 含 `outline` 字段 → 显示"✅ 大纲已生成"
- 其他 JSON → 显示"✅ 内容已生成"
- 非 JSON 正常渲染

**测试建议**：触发目录/大纲生成，确认对话框中不出现原始 JSON，而是友好提示文字。

---

### BUG-01：左侧区域显示不完整 ✅

**文件**：`frontend/src/app/projects/[id]/page.tsx`

**修复**：在左侧 Sider 下方（DirectorySidebar 下方）增加折叠面板（Ant Design Collapse），展示：
- 当前选中章节的大纲（`currentOutline`）
- 当前选中小节的正文（`currentResult`）

**测试建议**：选中目录树中的章节/小节，确认左侧下方出现对应大纲和正文内容。

---

### BUG-07：内容不可编辑 ✅

**后端文件**：
- `backend/src/content/content.controller.ts`
- `backend/src/content/content.service.ts`

**后端修复**：新增 4 个接口：
- `PATCH /api/content/writing-result/:id` → 更新正文
- `PATCH /api/content/outline/:id` → 更新大纲
- `PATCH /api/content/directory-node/:id` → 更新目录节点标题
- `DELETE /api/content/directory-node/:id` → 删除目录节点

**前端文件**：
- `frontend/src/app/projects/[id]/page.tsx`
- `frontend/src/components/workbench/DirectorySidebar.tsx`
- `frontend/src/services/contentService.ts`

**前端修复**：
1. **正文编辑**：在正文展示区加"编辑"按钮，点击后切换为 textarea 可编辑模式，保存时调用 `PATCH /api/content/writing-result/:id`
2. **大纲编辑**：同上，调用 `PATCH /api/content/outline/:id`
3. **目录节点编辑**：节点 hover 时显示编辑/删除图标，支持标题内联编辑和节点删除

**测试建议**：
- 生成正文后，点击编辑，修改文字，保存，刷新页面确认内容持久化
- 修改目录节点标题，确认树节点更新
- 删除目录节点，确认节点从树中移除

---

## 编译验证

### 后端编译 ✅
```bash
cd backend && npm run build
```
**结果**：编译通过，无错误

### 前端类型检查 ✅
```bash
cd frontend && npx tsc --noEmit
```
**结果**：类型检查通过，无错误

---

## 测试建议

### 手动测试流程

1. **启动服务**
   ```bash
   pm2 start ecosystem.config.cjs
   ```

2. **登录系统**
   - 访问 http://localhost:8002
   - 登录账号

3. **测试 BUG-06（登出）**
   - 进入工作台
   - 点击右上角头像 → 退出登录
   - 确认跳转到登录页

4. **测试 BUG-04（中文文件名）**
   - 上传中文名文件（如 `测试文档.pdf`）
   - 在素材管理页面确认文件名正常显示

5. **测试 BUG-05（上传限制 + 解析提示）**
   - 上传 25 个文件，确认不报错
   - 上传后立即进入工作台，确认出现解析中提示

6. **测试 BUG-03（Tooltip）**
   - 在工作台目录树中，悬停在支撑度 Tag 上
   - 确认出现说明 Tooltip

7. **测试 BUG-02（JSON 显示）**
   - 点击"生成目录"
   - 确认对话框中不出现原始 JSON，而是"✅ 目录已生成，请查看左侧目录树"

8. **测试 BUG-01（左侧预览）**
   - 选中目录树中的章节/小节
   - 确认左侧下方出现对应大纲和正文内容

9. **测试 BUG-07（内容编辑）**
   - 生成正文后，点击正文面板的编辑图标
   - 修改文字，点击保存
   - 刷新页面，确认内容持久化
   - 在目录树节点上 hover，点击编辑图标
   - 修改标题，回车保存
   - 确认树节点更新

### 自动化测试（可选）

使用 Playwright 编写 E2E 测试：
```bash
cd frontend && npx playwright test
```

---

## 总结

✅ 所有 8 个 BUG 已修复完成  
✅ 后端编译通过  
✅ 前端类型检查通过  
✅ 代码质量良好，无明显问题  

**建议**：在部署到生产环境前，进行完整的手动回归测试，确保所有功能正常工作。
