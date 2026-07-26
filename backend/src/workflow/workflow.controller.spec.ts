import { WorkflowController } from './workflow.controller.js';
import { toPublicWorkflowJob } from './dto/workflow-response.dto.js';
import type { WorkflowJob } from './entities/workflow-job.entity.js';
import type { WorkflowService } from './workflow.service.js';
import type { WorkflowDispatchService } from './workflow-dispatch.service.js';
import type { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import type { AuthoringProposalService } from '../authoring/proposal/authoring-proposal.service.js';
import type { Request, Response } from 'express';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';

const USER = {
  sub: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
};
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

describe('WorkflowController public response boundary', () => {
  it.each(['create', 'findOne', 'cancel'] as const)(
    '%s never serializes private workflow state',
    async (method) => {
      const entity = fullInternalJob();
      const workflowService: Pick<
        WorkflowService,
        'create' | 'findOne' | 'cancel' | 'toPublicJob'
      > = {
        create: () => Promise.resolve(entity),
        findOne: () => Promise.resolve(entity),
        cancel: () => Promise.resolve(entity),
        toPublicJob: (job) => toPublicWorkflowJob(job),
      };
      const controller = new WorkflowController(
        workflowService as WorkflowService,
      );

      const response =
        method === 'create'
          ? await controller.create(USER, PROJECT_ID, {
              workflow_type: WorkflowType.CONTENT,
              input: { secret: 'request input' },
            })
          : await controller[method](USER, PROJECT_ID, JOB_ID);

      expect(response.data).toEqual({
        id: JOB_ID,
        project_id: PROJECT_ID,
        workflow_type: WorkflowType.CONTENT,
        status: WorkflowStatus.FAILED,
        cancel_requested_at: null,
        approved_at: null,
        started_at: null,
        completed_at: entity.completed_at,
        created_at: entity.created_at,
        updated_at: entity.updated_at,
        error: {
          code: 'MODEL_UNAVAILABLE',
          message: '模型暂时不可用，请稍后重试',
        },
      });
      for (const forbidden of [
        'user_id',
        'idempotency_key',
        'request_hash',
        'input',
        'checkpoint',
        'error_code',
        'error_message',
        'public_error_code',
        'public_error_message',
      ]) {
        expect(response.data).not.toHaveProperty(forbidden);
      }
    },
  );

  it('maps a raw failure without a public message to a stable generic error', async () => {
    const entity = fullInternalJob();
    entity.public_error_code = null;
    entity.public_error_message = null;
    const workflowService: Pick<WorkflowService, 'findOne' | 'toPublicJob'> = {
      findOne: () => Promise.resolve(entity),
      toPublicJob: (job) => toPublicWorkflowJob(job),
    };
    const controller = new WorkflowController(
      workflowService as WorkflowService,
    );

    const response = await controller.findOne(USER, PROJECT_ID, JOB_ID);

    expect(response.data.error).toEqual({
      code: 'WORKFLOW_FAILED',
      message: '任务执行失败，请稍后重试或联系管理员',
    });
    expect(JSON.stringify(response)).not.toContain('UPSTREAM_PROVIDER_529');
    expect(JSON.stringify(response)).not.toContain('raw provider stack');
  });

  it('persists and dispatches a created job through the queue adapter', async () => {
    const entity = fullInternalJob();
    entity.status = WorkflowStatus.QUEUED;
    const workflowService: Pick<WorkflowService, 'toPublicJob'> = {
      toPublicJob: (job) => toPublicWorkflowJob(job),
    };
    const dispatch: Pick<WorkflowDispatchService, 'createAndDispatch'> = {
      createAndDispatch: jest.fn().mockResolvedValue(entity),
    };
    const controller = new WorkflowController(
      workflowService as WorkflowService,
      dispatch as WorkflowDispatchService,
    );

    await controller.create(USER, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      input: { section_node_id: 'section-1' },
    });

    expect(dispatch.createAndDispatch).toHaveBeenCalledWith(
      USER.sub,
      PROJECT_ID,
      expect.objectContaining({ workflow_type: WorkflowType.CONTENT }),
    );
  });

  it('approves, dispatches, and returns the queued public job', async () => {
    const entity = fullInternalJob();
    entity.status = WorkflowStatus.QUEUED;
    entity.error_code = null;
    entity.error_message = null;
    entity.public_error_code = null;
    entity.public_error_message = null;
    entity.completed_at = null;
    const workflowService: Pick<WorkflowService, 'findOne' | 'toPublicJob'> = {
      findOne: jest.fn().mockResolvedValue(entity),
      toPublicJob: (job) => toPublicWorkflowJob(job),
    };
    const dispatch: Pick<WorkflowDispatchService, 'dispatch'> = {
      dispatch: jest.fn().mockResolvedValue(true),
    };
    const proposals: Pick<AuthoringProposalService, 'approve'> = {
      approve: jest.fn().mockResolvedValue({ id: 'proposal-1' }),
    };
    const controller = new WorkflowController(
      workflowService as WorkflowService,
      dispatch as WorkflowDispatchService,
      undefined,
      proposals as AuthoringProposalService,
    );

    const response = await controller.approve(USER, PROJECT_ID, JOB_ID);

    expect(proposals.approve).toHaveBeenCalledWith(
      USER.sub,
      PROJECT_ID,
      JOB_ID,
    );
    expect(dispatch.dispatch).toHaveBeenCalledWith(JOB_ID);
    expect(workflowService.findOne).toHaveBeenCalledWith(
      USER.sub,
      PROJECT_ID,
      JOB_ID,
    );
    expect(response.data).toMatchObject({
      id: JOB_ID,
      status: WorkflowStatus.QUEUED,
    });
    expect(response.data).not.toHaveProperty('payload');
  });

  it('uses a resumable event stream when the client accepts SSE', async () => {
    const workflowService = {};
    const eventStream: Pick<WorkflowEventStreamService, 'stream'> = {
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new WorkflowController(
      workflowService as WorkflowService,
      undefined,
      eventStream as WorkflowEventStreamService,
    );
    const request = {};
    const response = {};

    await controller.listEvents(
      USER,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      EVENT_CURSOR,
      'text/event-stream',
      request as Request,
      response as Response,
    );

    expect(eventStream.stream).toHaveBeenCalledWith(
      USER.sub,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      EVENT_CURSOR,
      request,
      response,
    );
  });
});

const EVENT_CURSOR = '55555555-5555-4555-8555-555555555555';

function fullInternalJob(): WorkflowJob {
  const createdAt = new Date('2026-07-25T00:00:00.000Z');
  const completedAt = new Date('2026-07-25T00:00:02.000Z');
  return {
    id: JOB_ID,
    user_id: USER.sub,
    project_id: PROJECT_ID,
    workflow_type: WorkflowType.CONTENT,
    idempotency_key: 'private-key',
    request_hash: 'a'.repeat(64),
    status: WorkflowStatus.FAILED,
    input: { private: true },
    checkpoint: { retrieved_evidence: 'private' },
    cancel_requested_at: null,
    approved_at: null,
    error_code: 'UPSTREAM_PROVIDER_529',
    error_message: 'raw provider stack and request identifiers',
    public_error_code: 'MODEL_UNAVAILABLE',
    public_error_message: '模型暂时不可用，请稍后重试',
    started_at: null,
    completed_at: completedAt,
    created_at: createdAt,
    updated_at: completedAt,
  };
}
