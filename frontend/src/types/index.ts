// ===== 枚举 =====

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

// ===== 通用响应 =====

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string | null;
  error_code?: string;
}

export interface PagedData<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

// ===== 用户 =====

export interface User {
  id: string;
  email: string;
  nickname: string | null;
}

// ===== 项目 =====

export interface Project {
  id: string;
  name: string;
  type: string | null;
  target_audience: string | null;
  target_chapters: number;
  style: string;
  status: ProjectStatus;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectState {
  id: string;
  project_id: string;
  current_directory_version_id: string | null;
  completed_chapters: string[];
  in_progress_chapter: string | null;
  in_progress_section: string | null;
  pending_items: Array<Record<string, unknown>>;
  material_gaps: Array<Record<string, unknown>>;
  user_notes: string | null;
  updated_at: string;
}

// ===== 文件 =====

export interface SourceFile {
  id: string;
  project_id: string;
  file_name: string;
  file_type: FileType;
  file_size: number;
  parse_status: ParseStatus;
  error_message: string | null;
  uploaded_at: string;
}

// ===== 素材片段 =====

export interface Chunk {
  chunk_id: string;
  content: string;
  file_name: string;
  page_number: number | null;
  section_title: string | null;
  score: number;
  keywords: string[];
}

// ===== 目录 =====

export interface DirectoryNode {
  node_id: string;
  parent_node_id: string | null;
  node_type: NodeType;
  order_index: number;
  title: string;
  description?: string;
  material_support?: MaterialSupport;
  source_files?: string[];
  level_label?: string;
}

export interface DirectoryVersion {
  id: string;
  project_id: string;
  version_number: number;
  content: DirectoryNode[];
  is_current: boolean;
  created_at: string;
}

// ===== 大纲 =====

export interface OutlineSectionItem {
  column: string;
  required: boolean;
  writing_guide: string;
  length_suggestion: string;
  content_points: string[];
}

export interface OutlineContent {
  node_title?: string;
  level?: string;
  sections: OutlineSectionItem[];
  key_points?: string[];
  difficulties?: string[];
  source_refs?: Array<{ file: string; pages: string; relevance: string }>;
}

export interface OutlineVersion {
  id: string;
  project_id: string;
  chapter_node_id: string;
  section_node_id: string | null;
  chapter_index: number;
  chapter_title: string;
  version_number: number;
  content: OutlineContent;
  is_current: boolean;
  created_at: string;
}

// ===== 正文 =====

export interface WritingResult {
  id: string;
  project_id: string;
  session_id: string | null;
  chapter_node_id: string | null;
  section_node_id: string | null;
  task_type: TaskType;
  status: WritingResultStatus;
  content_text: string;
  word_count: number | null;
  version_number: number;
  latest_content_version_id: string | null;
  parent_result_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ===== 引用 =====

export interface Citation {
  id: string;
  paragraph_key: string;
  chunk_id: string;
  file_name: string;
  file_type?: FileType | null;
  page_number: number | null;
  section_title: string | null;
  use_type: CitationUseType;
  evidence_text: string | null;
  confidence_score: number;
  source_type?: string;
  reference_text?: string;
}

// ===== 会话 =====

export interface Session {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  message_type: MessageType;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ===== 导出 =====

export interface ExportJob {
  id: string;
  format: ExportFormat;
  scope: ExportScope;
  status: string;
  download_url: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

// ===== SSE 事件 =====

export interface SSEMetaEvent {
  type: 'meta';
  result_id: string;
  workflow_job_id?: string;
  task_type: string;
  started_at: string;
}

export interface SSEResetEvent {
  type: 'reset';
  superseded_attempt: number;
  generation_attempt: number;
  reason?: string;
}

export interface SSETokenEvent {
  type: 'token';
  content: string;
  paragraph_key: string;
}

export interface SSECitationEvent {
  type: 'citation';
  paragraph_key: string;
  citations: Citation[];
}

export interface SSEDoneEvent {
  type: 'done';
  result_id: string;
  outline_id?: string;
  directory_id?: string;
  server_saved?: boolean;
  workflow_job_id?: string;
  version_id?: string;
  status: string;
  citations: Citation[];
}

export interface SSEErrorEvent {
  type: 'error';
  message: string;
  error_code: string;
}

export interface SSEHeartbeatEvent {
  type: 'heartbeat';
  timestamp?: string;
}

export type SSEEvent =
  | SSEMetaEvent
  | SSEResetEvent
  | SSETokenEvent
  | SSECitationEvent
  | SSEDoneEvent
  | SSEErrorEvent
  | SSEHeartbeatEvent;
