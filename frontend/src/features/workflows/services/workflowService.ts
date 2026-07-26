import api from '@/services/api';
import type { ApiResponse } from '@/types';
import type {
  AuthoringProposal,
  CreateWorkflowRequest,
  WorkflowEvent,
  WorkflowJob,
} from '../types';

export interface WorkflowService {
  create(projectId: string, request: CreateWorkflowRequest): Promise<WorkflowJob>;
  getJob(projectId: string, jobId: string): Promise<WorkflowJob>;
  listEvents(
    projectId: string,
    jobId: string,
    cursor: string | null,
  ): Promise<WorkflowEvent[]>;
  getProposal(projectId: string, jobId: string): Promise<AuthoringProposal>;
  cancel(projectId: string, jobId: string): Promise<WorkflowJob>;
  approve(projectId: string, jobId: string): Promise<WorkflowJob>;
  resume(projectId: string, jobId: string): Promise<WorkflowJob>;
}

async function unwrap<T>(request: Promise<ApiResponse<T>>): Promise<T> {
  const response = await request;
  if (!response.success) {
    throw new Error(response.message ?? response.error_code ?? '请求失败');
  }
  return response.data;
}

export const workflowService: WorkflowService = {
  create(projectId, request) {
    return unwrap(
      api
        .post(`projects/${projectId}/workflows`, { json: request })
        .json<ApiResponse<WorkflowJob>>(),
    );
  },

  getJob(projectId, jobId) {
    return unwrap(
      api
        .get(`projects/${projectId}/workflows/${jobId}`, {
          cache: 'no-store',
        })
        .json<ApiResponse<WorkflowJob>>(),
    );
  },

  listEvents(projectId, jobId, cursor) {
    return unwrap(
      api
        .get(`projects/${projectId}/workflows/${jobId}/events`, {
          searchParams: { limit: 200 },
          headers: cursor ? { 'Last-Event-ID': cursor } : undefined,
          cache: 'no-store',
        })
        .json<ApiResponse<WorkflowEvent[]>>(),
    );
  },

  getProposal(projectId, jobId) {
    return unwrap(
      api
        .get(`projects/${projectId}/workflows/${jobId}/proposal`, {
          cache: 'no-store',
        })
        .json<ApiResponse<AuthoringProposal>>(),
    );
  },

  cancel(projectId, jobId) {
    return unwrap(
      api
        .post(`projects/${projectId}/workflows/${jobId}/cancel`)
        .json<ApiResponse<WorkflowJob>>(),
    );
  },

  approve(projectId, jobId) {
    return unwrap(
      api
        .post(`projects/${projectId}/workflows/${jobId}/approve`)
        .json<ApiResponse<WorkflowJob>>(),
    );
  },

  resume(projectId, jobId) {
    return unwrap(
      api
        .post(`projects/${projectId}/workflows/${jobId}/resume`)
        .json<ApiResponse<WorkflowJob>>(),
    );
  },
};
