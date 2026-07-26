export const WORKFLOW_TYPES = [
  'directory',
  'outline',
  'content',
  'rewrite',
  'expand',
  'compress',
] as const;

export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export type WorkflowStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'REVISION_REQUIRED'
  | 'WAITING_APPROVAL'
  | 'WAITING_MATERIAL'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'STOPPED';

export interface WorkflowError {
  code: string;
  message: string;
}

export interface WorkflowJob {
  id: string;
  project_id: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  cancel_requested_at: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  error: WorkflowError | null;
}

export interface WorkflowEvent {
  id: string;
  job_id: string;
  seq: number;
  type: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface AuthoringProposal {
  id: string;
  job_id: string;
  sequence: string;
  artifact_kind: 'directory' | 'outline' | 'body';
  schema_version: string;
  status: 'ACTIVE' | 'APPROVED';
  payload: unknown;
  payload_sha256: string;
  payload_utf8_bytes: string;
  expires_at: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkflowRequest {
  workflow_type: WorkflowType;
  input?: Record<string, unknown>;
  client_contract_version: 'authoring-approval-ui.v1';
}

export interface PersistedWorkflowRef {
  job_id: string;
  cursor: string | null;
  workflow_type: WorkflowType;
  resource_id: string | null;
  version_id: string | null;
}

export interface WorkflowRuntime {
  projectId: string;
  job: WorkflowJob;
  cursor: string | null;
  events: WorkflowEvent[];
  proposal: AuthoringProposal | null;
  streamContent: string;
  resourceId: string | null;
  versionId: string | null;
  actionPending: 'cancel' | 'approve' | 'resume' | null;
}

export const RUNNING_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'QUEUED',
  'RUNNING',
  'REVISION_REQUIRED',
];

export function isWorkflowRunning(status: WorkflowStatus): boolean {
  return RUNNING_WORKFLOW_STATUSES.includes(status);
}

export function isWorkflowTerminal(status: WorkflowStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'STOPPED';
}
