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
