# 教材编写Agent 接口与数据库契约

> 面向后端 DTO、Swagger/OpenAPI、前后端联调与数据库 Migration 的契约文档。后续补充将以这份文档为主。

---

## 一、契约总则

### 1.1 访问路径

- 所有业务接口统一挂在 `/api`
- 浏览器通过同源路径访问
- `/api/*` 由 Nginx 反代到 NestJS

### 1.2 认证方式

- 登录成功后后端写入：
  - `wa_access_token`
  - `wa_refresh_token`
- 两者均为 httpOnly Cookie
- 前端请求必须带 `credentials: "include"`
- MVP 不使用 `Authorization: Bearer <token>`

### 1.3 统一响应格式

普通 JSON 接口统一：

成功：

```json
{
  "success": true,
  "data": {},
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
    "items": [],
    "total": 100,
    "page": 1,
    "page_size": 20
  }
}
```

### 1.4 稳定标识

所有主资源统一使用 UUID：

- `user_id`
- `project_id`
- `session_id`
- `file_id`
- `document_id`
- `chunk_id`
- `outline_id`
- `result_id`
- `citation_id`
- `export_id`

目录树节点使用稳定 `node_id`：

- 章节点：`chapter_node_id`
- 节节点：`section_node_id`

### 1.5 时间格式

- 所有时间字段统一返回 ISO 8601 UTC 字符串
- 示例：`2026-03-17T10:00:00Z`

### 1.6 保存与并发

- 保存类接口后续统一支持乐观并发控制
- MVP 约定保留 `version_number` 字段
- 生成类接口一次请求只生成一个 `writing_result`

---

## 二、DTO 与 OpenAPI 生成约定

### 2.1 NestJS DTO 命名规范

建议后端按以下命名方式生成 DTO：

说明：

- 以下 TypeScript 代码块为 DTO / Swagger 草案，省略 import 语句
- 默认依赖 `class-validator`、`class-transformer`、`@nestjs/swagger`

- 请求体：`CreateProjectDto`、`GenerateContentDto`
- 查询参数：`ListProjectsQueryDto`、`ListChunksQueryDto`
- 路径参数：`ProjectIdParamDto`、`ContentResultParamDto`
- 响应体：`ProjectDetailResponseDto`、`PagedProjectListResponseDto`
- SSE 事件：`ContentStreamMetaEventDto`、`ContentStreamTokenEventDto`

### 2.2 校验规则默认约定

除非接口单独覆盖，所有 DTO 默认遵循以下约束：

| 类型 | 规则 |
|:---|:---|
| UUID | `@IsUUID('4')` |
| 邮箱 | `@IsEmail()` + `@MaxLength(255)` |
| 密码 | `@MinLength(8)` + `@MaxLength(32)` |
| 标题/名称 | `@IsString()` + `@MaxLength(255)` |
| 描述/正文 | `@IsString()`，长文本不设过小上限 |
| 分页页码 | `@IsInt()` + `@Min(1)` |
| 分页大小 | `@IsInt()` + `@Min(1)` + `@Max(100)` |
| 布尔值 | `@IsBoolean()` |
| 枚举 | `@IsEnum(...)` |
| 可选字段 | `@IsOptional()` |

### 2.3 Swagger / OpenAPI 约定

建议 Swagger 配置：

- `title`: `Writing Agent API`
- `version`: `1.0.0`
- `basePath`: `/api`
- `securitySchemes`：
  - `cookieAuth`: `type: apiKey`, `in: cookie`, `name: wa_access_token`
- `tags`：
  - `Auth`
  - `Projects`
  - `Files`
  - `Chunks`
  - `Retrieval`
  - `Directory`
  - `Outline`
  - `Content`
  - `Citations`
  - `Sessions`
  - `Export`
  - `Settings`

文档生成约定：

- JSON 接口统一声明 `application/json`
- 上传接口声明 `multipart/form-data`
- 流式接口声明 `text/event-stream`
- 受保护接口统一挂 `@ApiCookieAuth('wa_access_token')`

### 2.4 通用分页 DTO 草案

```ts
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number = 20;
}

export class ApiSuccessResponseDto<T> {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty()
  data!: T;

  @ApiProperty({ nullable: true, example: null })
  message!: string | null;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ nullable: true, example: null })
  data!: null;

  @ApiProperty({ example: '错误描述' })
  message!: string;

  @ApiProperty({ example: 'PROJECT_NOT_FOUND' })
  error_code!: string;
}
```

### 2.5 枚举定义草案

```ts
export enum ProjectStatus {
  DRAFT = 'draft',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export enum FileType {
  PDF = 'pdf',
  DOCX = 'docx',
  PPTX = 'pptx',
  MD = 'md',
  TXT = 'txt',
}

export enum ParseStatus {
  PENDING = 'pending',
  PARSING = 'parsing',
  DONE = 'done',
  FAILED = 'failed',
}

export enum NodeType {
  CHAPTER = 'chapter',
  SECTION = 'section',
}

export enum MaterialSupport {
  HIGH = '充足',
  MEDIUM = '一般',
  LOW = '不足',
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum MessageType {
  CHAT = 'chat',
  DIRECTORY = 'directory',
  OUTLINE = 'outline',
  CONTENT = 'content',
}

export enum TaskType {
  GENERATE = 'generate',
  REWRITE = 'rewrite',
  EXPAND = 'expand',
  COMPRESS = 'compress',
}

export enum WritingResultStatus {
  STREAMING = 'streaming',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

export enum CitationUseType {
  REWRITE = 'rewrite',
  SUMMARIZE = 'summarize',
  SYNTHESIZE = 'synthesize',
  TRANSITION = 'transition',
  UNSUPPORTED = 'unsupported',
}

export enum ExportFormat {
  DOCX = 'docx',
  MARKDOWN = 'markdown',
}

export enum ExportScope {
  FULL = 'full',
  CHAPTERS = 'chapters',
}
```

### 2.6 OpenAPI operationId 建议

| 接口 | operationId |
|:---|:---|
| `POST /api/auth/register` | `register` |
| `POST /api/auth/login` | `login` |
| `POST /api/projects` | `createProject` |
| `GET /api/projects` | `listProjects` |
| `POST /api/projects/:id/content/generate` | `generateContent` |
| `POST /api/projects/:id/directory/generate` | `generateDirectory` |
| `POST /api/projects/:id/outline/generate` | `generateOutline` |
| `POST /api/projects/:id/export` | `createExportJob` |

---

## 三、关键资源模型

### 3.1 目录节点

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

### 3.2 大纲内容

```json
{
  "objectives": ["目标1", "目标2"],
  "key_points": [
    {
      "point": "关系模型的核心概念",
      "source": "数据库基础.pdf:15"
    }
  ],
  "structure": [
    {
      "section": "3.1 关系模型概述",
      "summary": "介绍关系模型及其基本元素。"
    }
  ],
  "case_suggestions": ["分析一个简单选课系统的关系模式"],
  "highlights": {
    "key_points": ["关系、元组、属性"],
    "difficulties": ["规范化的理解"]
  },
  "source_refs": [
    {
      "file": "数据库基础.pdf",
      "pages": "15-18",
      "relevance": "高"
    }
  ]
}
```

### 3.3 正文结果

```json
{
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
```

### 3.4 引用项

```json
{
  "id": "uuid",
  "paragraph_key": "p1",
  "chunk_id": "uuid",
  "file_name": "教材素材A.pdf",
  "page_number": 15,
  "section_title": "第二章 基础概念",
  "use_type": "rewrite",
  "evidence_text": "原文片段摘要...",
  "confidence_score": 0.92
}
```

---

## 四、API 接口清单

### 4.1 认证接口

| 方法 | 路径 | 说明 | 认证 |
|:---|:---|:---|:---|
| POST | `/api/auth/register` | 用户注册 | 否 |
| POST | `/api/auth/login` | 用户登录 | 否 |
| POST | `/api/auth/refresh` | 刷新 token | 否 |
| POST | `/api/auth/logout` | 退出登录 | 是 |
| PUT | `/api/auth/password` | 修改密码 | 是 |

登录成功响应：

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

DTO 草案：

```ts
export class RegisterDto {
  @ApiProperty({ example: 'user@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'StrongPass123', minLength: 8, maxLength: 32 })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  password!: string;

  @ApiPropertyOptional({ example: '张三', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'StrongPass123' })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  password!: string;
}

export class RefreshTokenDto {
  // Cookie 模式下请求体为空，DTO 仅作为 Swagger 占位说明
}

export class LogoutDto {
  // Cookie 模式下请求体为空，DTO 仅作为 Swagger 占位说明
}

export class UpdatePasswordDto {
  @ApiProperty({ example: 'OldPass123' })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  old_password!: string;

  @ApiProperty({ example: 'NewPass123', minLength: 8, maxLength: 32 })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  new_password!: string;
}

export class AuthUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ nullable: true })
  nickname!: string | null;
}

export class LoginResponseDataDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
```

### 4.2 项目接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects` | 创建项目 |
| GET | `/api/projects` | 项目列表 |
| GET | `/api/projects/:id` | 项目详情 |
| PUT | `/api/projects/:id` | 更新项目 |
| DELETE | `/api/projects/:id` | 删除项目 |
| GET | `/api/projects/:id/state` | 获取项目状态 |
| PUT | `/api/projects/:id/state` | 更新项目状态 |
| PUT | `/api/projects/:id/settings` | 更新项目设置 |

DTO 草案：

```ts
export class ListProjectsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({ example: '数据库' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;
}

export class CreateProjectDto {
  @ApiProperty({ example: '数据库原理教材', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: '本科教材', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ example: '计算机科学与技术专业本科生' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  target_audience?: string;

  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  target_chapters?: number;

  @ApiPropertyOptional({ example: '教材', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  style?: string;

  @ApiPropertyOptional({ example: '面向数据库课程教学' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
}

export class UpdateProjectDto extends PartialType(CreateProjectDto) {}

export class UpdateProjectStateDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  completed_chapters?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  in_progress_chapter?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  in_progress_section?: string;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  pending_items?: Array<Record<string, unknown>>;
}

export class UpdateProjectSettingsDto {
  @ApiPropertyOptional({ example: '教材' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  default_style?: string;

  @ApiPropertyOptional({ example: 2000, minimum: 100, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10000)
  default_word_count?: number;
}
```

### 4.3 文件接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/files` | 上传素材 |
| GET | `/api/projects/:id/files` | 素材列表 |
| GET | `/api/projects/:id/files/:fileId` | 素材详情 |
| GET | `/api/projects/:id/files/:fileId/parse-result` | 解析结果 |
| POST | `/api/projects/:id/files/:fileId/reparse` | 重新解析 |
| DELETE | `/api/projects/:id/files/:fileId` | 删除素材 |

OpenAPI 说明：

- 上传接口使用 `multipart/form-data`
- 字段名固定为 `files`
- 支持一次上传多个文件

DTO 草案：

```ts
export class ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  id!: string;
}

export class ProjectFileParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  fileId!: string;
}

export class ListFilesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParseStatus })
  @IsOptional()
  @IsEnum(ParseStatus)
  parse_status?: ParseStatus;

  @ApiPropertyOptional({ enum: FileType })
  @IsOptional()
  @IsEnum(FileType)
  file_type?: FileType;
}

export class UploadFilesRequestDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    isArray: true,
  })
  files!: Express.Multer.File[];
}
```

### 4.4 素材片段接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/projects/:id/chunks` | 片段列表 |
| GET | `/api/projects/:id/chunks/:chunkId` | 片段详情 |

DTO 草案：

```ts
export class ProjectChunkParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  chunkId!: string;
}

export class ListChunksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  file_id?: string;

  @ApiPropertyOptional({ example: '关系模型' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;
}
```

### 4.5 检索接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/retrieve` | 手动检索素材 |

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

DTO 草案：

```ts
export class RetrieveDto {
  @ApiProperty({ example: '关系模型的核心概念' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  query!: string;

  @ApiProperty({ enum: ['directory', 'outline', 'content'] })
  @IsString()
  @IsIn(['directory', 'outline', 'content'])
  task_type!: 'directory' | 'outline' | 'content';

  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  top_k?: number = 10;
}

export class RetrievalResultItemDto {
  @ApiProperty()
  chunk_id!: string;

  @ApiProperty()
  content!: string;

  @ApiProperty()
  file_name!: string;

  @ApiProperty({ nullable: true })
  page_number!: number | null;

  @ApiProperty({ nullable: true })
  section_title!: string | null;

  @ApiProperty()
  score!: number;

  @ApiProperty({ type: [String] })
  keywords!: string[];
}
```

### 4.6 目录接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/directory/generate` | 生成目录（SSE） |
| GET | `/api/projects/:id/directory` | 获取当前目录 |
| POST | `/api/projects/:id/directory/save` | 保存目录 |
| GET | `/api/projects/:id/directory/versions` | 目录版本列表 |

DTO 草案：

```ts
export class GenerateDirectoryDto {
  @ApiPropertyOptional({ example: '数据库原理教材' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: '本科教材' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ example: '计算机专业本科生' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  target_audience?: string;

  @ApiPropertyOptional({ example: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  target_chapters?: number;
}

export class DirectoryNodeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  node_id!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  parent_node_id?: string | null;

  @ApiProperty({ enum: NodeType })
  @IsEnum(NodeType)
  node_type!: NodeType;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  order_index!: number;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: MaterialSupport })
  @IsOptional()
  @IsEnum(MaterialSupport)
  material_support?: MaterialSupport;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  source_files?: string[];
}

export class SaveDirectoryDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  base_version_number!: number;

  @ApiProperty({ type: [DirectoryNodeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DirectoryNodeDto)
  nodes!: DirectoryNodeDto[];
}
```

### 4.7 大纲接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/outline/generate` | 生成大纲（SSE） |
| GET | `/api/projects/:id/outline/:outlineId` | 获取大纲 |
| POST | `/api/projects/:id/outline/save` | 保存大纲 |

请求体：

```json
{
  "chapter_node_id": "uuid"
}
```

DTO 草案：

```ts
export class GenerateOutlineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  chapter_node_id!: string;
}

export class OutlineContentDto {
  @ApiProperty({ type: [String] })
  objectives!: string[];

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  key_points!: Array<Record<string, unknown>>;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  structure!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [String] })
  case_suggestions!: string[];

  @ApiProperty({ type: 'object' })
  highlights!: Record<string, unknown>;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  source_refs!: Array<Record<string, unknown>>;
}

export class SaveOutlineDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  outline_id?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  chapter_node_id!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  base_version_number!: number;

  @ApiProperty({ type: OutlineContentDto })
  @ValidateNested()
  @Type(() => OutlineContentDto)
  content!: OutlineContentDto;
}
```

### 4.8 正文接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/content/generate` | 生成正文（SSE） |
| POST | `/api/projects/:id/content/:resultId/rewrite` | 改写（SSE） |
| POST | `/api/projects/:id/content/:resultId/expand` | 扩写（SSE） |
| POST | `/api/projects/:id/content/:resultId/compress` | 精简（SSE） |
| GET | `/api/projects/:id/content/:resultId` | 获取正文结果 |

请求体：

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

DTO 草案：

```ts
export class GenerateContentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  session_id!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  chapter_node_id!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  section_node_id!: string;

  @ApiProperty({ example: 2000, minimum: 100, maximum: 10000 })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10000)
  word_count!: number;

  @ApiProperty({ example: '教材', maxLength: 50 })
  @IsString()
  @MaxLength(50)
  style!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  strict_citation!: boolean;
}

export class RewriteContentDto {
  @ApiProperty({ example: '改写成更正式的教材风格' })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  rewrite_instruction!: string;
}

export class ExpandContentDto {
  @ApiProperty({ example: 2600, minimum: 100, maximum: 10000 })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10000)
  target_word_count!: number;
}

export class CompressContentDto {
  @ApiProperty({ example: 1200, minimum: 100, maximum: 10000 })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10000)
  target_word_count!: number;
}

export class ProjectContentResultParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  resultId!: string;
}
```

### 4.9 引用接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/projects/:id/content/:resultId/citations` | 获取引用列表 |
| GET | `/api/projects/:id/citations/:citationId` | 获取引用详情 |
| POST | `/api/projects/:id/content/:resultId/material-gap` | 标记素材不足 |

DTO 草案：

```ts
export class ProjectCitationParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  citationId!: string;
}

export class MarkMaterialGapDto {
  @ApiProperty({ example: '当前素材缺少该小节的直接案例支撑' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}
```

### 4.10 会话接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/sessions` | 创建会话 |
| GET | `/api/projects/:id/sessions` | 会话列表 |
| GET | `/api/projects/:id/sessions/:sessionId/messages` | 消息历史 |
| DELETE | `/api/projects/:id/sessions/:sessionId` | 删除会话 |

DTO 草案：

```ts
export class CreateSessionDto {
  @ApiPropertyOptional({ example: '第三章写作会话', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

export class ProjectSessionParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  sessionId!: string;
}

export class ListMessagesQueryDto extends PaginationQueryDto {}
```

### 4.11 导出接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| POST | `/api/projects/:id/export` | 创建导出任务 |
| GET | `/api/projects/:id/export/:exportId` | 查询导出状态 |

请求体：

```json
{
  "format": "docx",
  "scope": "full",
  "chapter_ids": [],
  "include_citations": true
}
```

DTO 草案：

```ts
export class CreateExportJobDto {
  @ApiProperty({ enum: ExportFormat })
  @IsEnum(ExportFormat)
  format!: ExportFormat;

  @ApiProperty({ enum: ExportScope })
  @IsEnum(ExportScope)
  scope!: ExportScope;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  chapter_ids?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  include_citations?: boolean = true;
}

export class ProjectExportParamDto extends ProjectIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  exportId!: string;
}
```

### 4.12 设置接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/api/settings` | 获取用户设置 |
| PUT | `/api/settings` | 更新用户设置 |

DTO 草案：

```ts
export class UpdateUserSettingsDto {
  @ApiPropertyOptional({ example: '教材', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  default_style?: string;

  @ApiPropertyOptional({ example: 2000, minimum: 100, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10000)
  default_word_count?: number;

  @ApiPropertyOptional({ type: 'object' })
  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;
}
```

### 4.13 典型响应 DTO 草案

```ts
export class ProjectSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true })
  type!: string | null;

  @ApiProperty({ enum: ProjectStatus })
  status!: ProjectStatus;

  @ApiProperty()
  updated_at!: string;
}

export class PagedProjectListDataDto {
  @ApiProperty({ type: [ProjectSummaryDto] })
  items!: ProjectSummaryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  page_size!: number;
}

export class SourceFileDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  file_name!: string;

  @ApiProperty({ enum: FileType })
  file_type!: FileType;

  @ApiProperty({ enum: ParseStatus })
  parse_status!: ParseStatus;

  @ApiProperty({ nullable: true })
  error_message!: string | null;

  @ApiProperty()
  uploaded_at!: string;
}

export class WritingResultDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: TaskType })
  task_type!: TaskType;

  @ApiProperty({ enum: WritingResultStatus })
  status!: WritingResultStatus;

  @ApiProperty()
  content_text!: string;

  @ApiProperty()
  version_number!: number;

  @ApiProperty({ nullable: true })
  completed_at!: string | null;
}

export class ExportJobDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ExportFormat })
  format!: ExportFormat;

  @ApiProperty({ enum: ExportScope })
  scope!: ExportScope;

  @ApiProperty()
  status!: string;

  @ApiProperty({ nullable: true })
  download_url!: string | null;
}
```

### 4.14 Swagger 注解建议

控制器建议：

- 所有 controller 增加 `@ApiTags(...)`
- 所有受保护接口增加 `@ApiCookieAuth('wa_access_token')`
- JSON 接口使用：
  - `@ApiOkResponse`
  - `@ApiBadRequestResponse`
  - `@ApiUnauthorizedResponse`
  - `@ApiNotFoundResponse`
- 上传接口增加：
  - `@ApiConsumes('multipart/form-data')`
- SSE 接口增加：
  - `@ApiProduces('text/event-stream')`
  - `@ApiOkResponse({ schema: { type: 'string', example: 'event: token\\ndata: {...}\\n\\n' } })`

流式接口建议在 OpenAPI 中单独注明：

- 不保证 `data` 为完整 JSON 数组
- `done` 事件才表示任务完成
- `error` 事件后客户端应停止继续解析

---

## 五、SSE 契约

### 5.1 事件类型

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

### 5.2 语义说明

| 事件 | 说明 |
|:---|:---|
| `meta` | 流开始，返回 `result_id` |
| `token` | 增量正文内容 |
| `citation` | 段落对应引用信息 |
| `done` | 流结束，结果已落库 |
| `error` | 流中异常 |

---

## 六、数据库 Schema

### 6.1 用户与认证

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    nickname VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 6.2 项目与状态

```sql
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50),
    target_audience TEXT,
    target_chapters INTEGER DEFAULT 10,
    style VARCHAR(50) DEFAULT '教材',
    status VARCHAR(20) DEFAULT 'draft',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE project_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    current_directory_version_id UUID,
    completed_chapters JSONB DEFAULT '[]',
    in_progress_chapter VARCHAR(255),
    in_progress_section VARCHAR(255),
    pending_items JSONB DEFAULT '[]',
    material_gaps JSONB DEFAULT '[]',
    user_notes TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 6.3 文件、文档、切块

```sql
CREATE TABLE source_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_name VARCHAR(500) NOT NULL,
    file_type VARCHAR(20) NOT NULL,
    file_size BIGINT,
    file_path VARCHAR(1000) NOT NULL,
    parse_status VARCHAR(20) DEFAULT 'pending',
    error_message TEXT,
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title VARCHAR(500),
    content_text TEXT,
    page_count INTEGER,
    sections JSONB DEFAULT '[]',
    parsed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
```

### 6.4 会话、目录、大纲

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
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    message_type VARCHAR(30) DEFAULT 'chat',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE directory_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    content JSONB NOT NULL,
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE outline_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_node_id UUID NOT NULL,
    chapter_index INTEGER NOT NULL,
    chapter_title VARCHAR(500) NOT NULL,
    version_number INTEGER NOT NULL,
    content JSONB NOT NULL,
    is_current BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 6.5 正文、版本、引用、导出

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
    task_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'streaming',
    content_text TEXT NOT NULL,
    word_count INTEGER,
    style VARCHAR(50),
    version_number INTEGER DEFAULT 1,
    parent_result_id UUID REFERENCES writing_results(id),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE content_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id UUID NOT NULL REFERENCES writing_results(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    editor_source VARCHAR(20) NOT NULL DEFAULT 'ai',
    content_text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE citation_maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    result_id UUID NOT NULL REFERENCES writing_results(id) ON DELETE CASCADE,
    paragraph_key VARCHAR(100) NOT NULL,
    chunk_id UUID NOT NULL REFERENCES chunks(id),
    file_id UUID NOT NULL REFERENCES source_files(id),
    use_type VARCHAR(30) NOT NULL,
    evidence_text TEXT,
    page_number INTEGER,
    section_title VARCHAR(500),
    confidence_score FLOAT DEFAULT 0.8,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    format VARCHAR(20) NOT NULL,
    scope VARCHAR(20) NOT NULL,
    chapter_ids JSONB DEFAULT '[]',
    include_citations BOOLEAN DEFAULT true,
    status VARCHAR(20) DEFAULT 'pending',
    file_path VARCHAR(1000),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);
```

### 6.6 用户设置

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

### 6.7 Migration 约束与索引补充

除上面的基础 DDL 外，Migration 建议补充以下约束：

```sql
CREATE UNIQUE INDEX uq_directory_versions_project_current
ON directory_versions(project_id)
WHERE is_current = true;

CREATE UNIQUE INDEX uq_outline_versions_project_chapter_current
ON outline_versions(project_id, chapter_node_id)
WHERE is_current = true;

CREATE UNIQUE INDEX uq_content_versions_result_version
ON content_versions(result_id, version_number);

CREATE INDEX idx_sessions_project_id ON sessions(project_id);
CREATE INDEX idx_source_files_uploaded_at ON source_files(uploaded_at DESC);
CREATE INDEX idx_writing_results_session_id ON writing_results(session_id);
CREATE INDEX idx_export_jobs_status ON export_jobs(status);
```

枚举字段建议使用 `CHECK` 约束：

```sql
ALTER TABLE projects
ADD CONSTRAINT chk_projects_status
CHECK (status IN ('draft', 'in_progress', 'completed'));

ALTER TABLE source_files
ADD CONSTRAINT chk_source_files_type
CHECK (file_type IN ('pdf', 'docx', 'pptx', 'md', 'txt'));

ALTER TABLE source_files
ADD CONSTRAINT chk_source_files_parse_status
CHECK (parse_status IN ('pending', 'parsing', 'done', 'failed'));

ALTER TABLE writing_results
ADD CONSTRAINT chk_writing_results_task_type
CHECK (task_type IN ('generate', 'rewrite', 'expand', 'compress'));

ALTER TABLE writing_results
ADD CONSTRAINT chk_writing_results_status
CHECK (status IN ('streaming', 'succeeded', 'failed', 'stopped'));

ALTER TABLE citation_maps
ADD CONSTRAINT chk_citation_maps_use_type
CHECK (use_type IN ('rewrite', 'summarize', 'synthesize', 'transition', 'unsupported'));

ALTER TABLE export_jobs
ADD CONSTRAINT chk_export_jobs_format
CHECK (format IN ('docx', 'markdown'));

ALTER TABLE export_jobs
ADD CONSTRAINT chk_export_jobs_scope
CHECK (scope IN ('full', 'chapters'));
```

说明：

- `chapter_node_id` / `section_node_id` 来源于目录 JSON 节点，数据库层不做外键约束，由应用层校验其存在性
- `directory_versions.is_current`、`outline_versions.is_current` 使用部分唯一索引，避免同一资源存在多个当前版本
- `content_versions` 使用 `(result_id, version_number)` 唯一约束，保证版本号单调递增

---

## 七、错误码

| 错误码 | HTTP 状态码 | 说明 |
|:---|:---|:---|
| AUTH_INVALID_CREDENTIALS | 401 | 邮箱或密码错误 |
| AUTH_TOKEN_EXPIRED | 401 | Token 已过期 |
| AUTH_EMAIL_EXISTS | 409 | 邮箱已注册 |
| PROJECT_NOT_FOUND | 404 | 项目不存在 |
| FILE_NOT_FOUND | 404 | 文件不存在 |
| FILE_TYPE_UNSUPPORTED | 400 | 不支持的文件格式 |
| FILE_TOO_LARGE | 413 | 文件超过大小限制 |
| PARSE_FAILED | 500 | 文件解析失败 |
| RETRIEVAL_NO_RESULTS | 200 | 检索无结果 |
| GENERATION_FAILED | 500 | LLM 生成失败 |
| GENERATION_TIMEOUT | 504 | LLM 生成超时 |
| EXPORT_FAILED | 500 | 导出失败 |
| RATE_LIMIT_EXCEEDED | 429 | 请求频率超限 |

---

## 八、剩余可补充项

当前文档已经足够直接产出后端 DTO 与 OpenAPI 草案。剩余建议补充项如下：

1. 为所有列表接口统一补 `sort_by`、`sort_order` 枚举
2. 为每个响应 DTO 补完整嵌套结构，而不只保留代表性草案
3. 将 SSE 事件进一步拆成独立 `oneOf` OpenAPI schema
4. 将错误响应按 HTTP 状态码生成统一 `ErrorResponseDto`
5. 将 SQL DDL 同步转写为 TypeORM Entity 字段清单与 Migration 步骤

---

## 九、与其他文档关系

- 前端实现见 [教材编写Agent_前端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_前端开发方案.md)
- 后端实现见 [教材编写Agent_后端开发方案.md](/Users/kang/Desktop/write-agent/教材编写Agent_后端开发方案.md)
