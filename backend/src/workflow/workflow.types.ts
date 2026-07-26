import { ConflictException } from '@nestjs/common';

export enum WorkflowType {
  FILE_PARSE = 'file_parse',
  INDEX = 'index',
  DIRECTORY = 'directory',
  OUTLINE = 'outline',
  CONTENT = 'content',
  REWRITE = 'rewrite',
  EXPAND = 'expand',
  COMPRESS = 'compress',
  EXPORT = 'export',
}

export enum WorkflowStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  REVISION_REQUIRED = 'REVISION_REQUIRED',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  WAITING_MATERIAL = 'WAITING_MATERIAL',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  STOPPED = 'STOPPED',
}

export const TERMINAL_WORKFLOW_STATUSES = [
  WorkflowStatus.SUCCEEDED,
  WorkflowStatus.FAILED,
  WorkflowStatus.STOPPED,
] as const;

const ALLOWED_TRANSITIONS: Readonly<
  Record<WorkflowStatus, readonly WorkflowStatus[]>
> = {
  [WorkflowStatus.QUEUED]: [
    WorkflowStatus.RUNNING,
    WorkflowStatus.FAILED,
    WorkflowStatus.STOPPED,
  ],
  [WorkflowStatus.RUNNING]: [
    WorkflowStatus.REVISION_REQUIRED,
    WorkflowStatus.WAITING_APPROVAL,
    WorkflowStatus.WAITING_MATERIAL,
    WorkflowStatus.SUCCEEDED,
    WorkflowStatus.FAILED,
    WorkflowStatus.STOPPED,
  ],
  [WorkflowStatus.REVISION_REQUIRED]: [
    WorkflowStatus.RUNNING,
    WorkflowStatus.QUEUED,
    WorkflowStatus.WAITING_MATERIAL,
    WorkflowStatus.FAILED,
    WorkflowStatus.STOPPED,
  ],
  [WorkflowStatus.WAITING_APPROVAL]: [
    WorkflowStatus.QUEUED,
    WorkflowStatus.FAILED,
    WorkflowStatus.STOPPED,
  ],
  [WorkflowStatus.WAITING_MATERIAL]: [
    WorkflowStatus.QUEUED,
    WorkflowStatus.FAILED,
    WorkflowStatus.STOPPED,
  ],
  [WorkflowStatus.SUCCEEDED]: [],
  [WorkflowStatus.FAILED]: [],
  [WorkflowStatus.STOPPED]: [],
};

export function assertWorkflowTransition(
  current: WorkflowStatus,
  next: WorkflowStatus,
): void {
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new ConflictException(`工作流状态不能从 ${current} 变更为 ${next}`);
  }
}
