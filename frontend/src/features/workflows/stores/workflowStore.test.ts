import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowService } from '../services/workflowService';
import type {
  AuthoringProposal,
  WorkflowEvent,
  WorkflowJob,
} from '../types';
import {
  createWorkflowStore,
  type WorkflowStorage,
} from './workflowStore';

const PROJECT_ID = 'project-1';
const JOB_ID = 'job-1';

describe('workflowStore', () => {
  let service: WorkflowService;
  let storage: WorkflowStorage;
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    };
    service = {
      create: vi.fn(),
      getJob: vi.fn(),
      listEvents: vi.fn(),
      getProposal: vi.fn(),
      cancel: vi.fn(),
      approve: vi.fn(),
      resume: vi.fn(),
    };
  });

  it('restores an active job after refresh using its job id and cursor', async () => {
    values.set(
      'write-agent:active-workflow:project-1',
      JSON.stringify({
        job_id: JOB_ID,
        cursor: 'event-1',
        workflow_type: 'content',
        resource_id: null,
        version_id: null,
      }),
    );
    vi.mocked(service.getJob).mockResolvedValue(job('RUNNING'));
    vi.mocked(service.listEvents).mockResolvedValue([
      event('event-2', 'token', { type: 'token', content: '恢复内容' }),
    ]);

    const store = createWorkflowStore({ service, storage });
    const recovered = await store.getState().recoverProject(PROJECT_ID);

    expect(service.listEvents).toHaveBeenCalledWith(
      PROJECT_ID,
      JOB_ID,
      'event-1',
    );
    expect(recovered).toMatchObject({
      cursor: 'event-2',
      streamContent: '恢复内容',
      job: { id: JOB_ID, status: 'RUNNING' },
    });
    expect(
      JSON.parse(values.get('write-agent:active-workflow:project-1') ?? '{}'),
    ).toMatchObject({ job_id: JOB_ID, cursor: 'event-2' });
  });

  it('creates the approval-capable workflow contract and durably cancels it', async () => {
    vi.mocked(service.create).mockResolvedValue(job('QUEUED'));
    vi.mocked(service.cancel).mockResolvedValue(job('STOPPED'));
    const store = createWorkflowStore({ service, storage });

    await store
      .getState()
      .createWorkflow(PROJECT_ID, 'outline', { chapter_node_id: 'chapter-1' });
    const stopped = await store.getState().cancelProject(PROJECT_ID);

    expect(service.create).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        workflow_type: 'outline',
        client_contract_version: 'authoring-approval-ui.v1',
      }),
    );
    expect(service.cancel).toHaveBeenCalledWith(PROJECT_ID, JOB_ID);
    expect(stopped?.job.status).toBe('STOPPED');
    expect(values.has('write-agent:active-workflow:project-1')).toBe(false);
  });

  it('loads the sealed proposal and approves only by project and job id', async () => {
    vi.mocked(service.create).mockResolvedValue(job('WAITING_APPROVAL'));
    vi.mocked(service.getJob).mockResolvedValue(job('WAITING_APPROVAL'));
    vi.mocked(service.listEvents).mockResolvedValue([]);
    vi.mocked(service.getProposal).mockResolvedValue(proposal());
    vi.mocked(service.approve).mockResolvedValue(job('QUEUED'));
    const store = createWorkflowStore({ service, storage });

    await store.getState().createWorkflow(PROJECT_ID, 'directory');
    await store.getState().refreshProject(PROJECT_ID);
    const approved = await store.getState().approveProject(PROJECT_ID);

    expect(service.getProposal).toHaveBeenCalledWith(PROJECT_ID, JOB_ID);
    expect(service.approve).toHaveBeenCalledWith(PROJECT_ID, JOB_ID);
    expect(approved).toMatchObject({
      job: { status: 'QUEUED' },
      proposal: { id: 'proposal-1', status: 'APPROVED' },
      actionPending: null,
    });
  });
});

function job(status: WorkflowJob['status']): WorkflowJob {
  return {
    id: JOB_ID,
    project_id: PROJECT_ID,
    workflow_type: 'content',
    status,
    cancel_requested_at: status === 'STOPPED' ? '2026-07-27T00:00:00Z' : null,
    approved_at: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    error: null,
  };
}

function event(
  id: string,
  type: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  return {
    id,
    job_id: JOB_ID,
    seq: 2,
    type,
    data,
    created_at: '2026-07-27T00:00:00Z',
  };
}

function proposal(): AuthoringProposal {
  return {
    id: 'proposal-1',
    job_id: JOB_ID,
    sequence: '1',
    artifact_kind: 'directory',
    schema_version: 'authoring-directory.v1',
    status: 'ACTIVE',
    payload: [{ node_id: 'chapter-1', title: '第一章' }],
    payload_sha256: 'a'.repeat(64),
    payload_utf8_bytes: '42',
    expires_at: '2026-07-28T00:00:00Z',
    approved_at: null,
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
  };
}
