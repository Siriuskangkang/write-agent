import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { WorkflowLegacyBridgeService } from './workflow-legacy-bridge.service.js';
import type { WorkflowDispatchService } from './workflow-dispatch.service.js';
import type { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';
import type { WorkflowService } from './workflow.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

describe('WorkflowLegacyBridgeService', () => {
  it('uses the legacy request id as a durable idempotency key and streams the original event shape', async () => {
    const durableJob = {
      id: JOB_ID,
      status: WorkflowStatus.QUEUED,
    };
    const dispatch: Pick<WorkflowDispatchService, 'createAndDispatch'> = {
      createAndDispatch: jest
        .fn()
        .mockImplementation(
          async (
            _userId,
            _projectId,
            _dto,
            onPersisted?: (job: typeof durableJob) => void | Promise<void>,
          ) => {
            await onPersisted?.(durableJob);
            return durableJob;
          },
        ),
    };
    const eventStream: Pick<
      WorkflowEventStreamService,
      'prepareResponse' | 'stream'
    > = {
      prepareResponse: jest.fn(),
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const bridge = new WorkflowLegacyBridgeService(
      dispatch as WorkflowDispatchService,
      eventStream as WorkflowEventStreamService,
      {
        cancel: jest.fn(),
      } as unknown as WorkflowService,
    );
    const request = Object.assign(new EventEmitter(), {
      headers: {
        'x-request-id': ' legacy-request-1 ',
        'last-event-id': '44444444-4444-4444-8444-444444444444',
      },
      aborted: false,
    });
    const response = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
      destroyed: false,
      writableEnded: false,
    });

    await bridge.run(
      USER_ID,
      PROJECT_ID,
      WorkflowType.OUTLINE,
      { chapter_node_id: 'chapter-1' },
      request as Request,
      response as Response,
    );

    expect(dispatch.createAndDispatch).toHaveBeenCalledWith(
      USER_ID,
      PROJECT_ID,
      {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'legacy-request-1',
        input: { chapter_node_id: 'chapter-1' },
      },
      expect.any(Function),
      'legacy_api',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Workflow-Job-Id',
      JOB_ID,
    );
    expect(eventStream.prepareResponse).toHaveBeenCalledWith(response);
    expect(eventStream.stream).toHaveBeenCalledWith(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      expect.any(Object),
      '44444444-4444-4444-8444-444444444444',
      request,
      response,
      { legacyDataOnly: true },
    );
  });

  it('maps a legacy writing result stop to the active durable workflow', async () => {
    const dispatch = {};
    const eventStream = {};
    const workflowService: Pick<WorkflowService, 'cancelByLegacyResult'> = {
      cancelByLegacyResult: jest.fn().mockResolvedValue(true),
    };
    const bridge = new WorkflowLegacyBridgeService(
      dispatch as WorkflowDispatchService,
      eventStream as WorkflowEventStreamService,
      workflowService as WorkflowService,
    );

    await expect(
      bridge.cancelLegacyResult(USER_ID, PROJECT_ID, 'result-1'),
    ).resolves.toBe(true);
    expect(workflowService.cancelByLegacyResult).toHaveBeenCalledWith(
      USER_ID,
      PROJECT_ID,
      'result-1',
    );
  });

  it('stops a job persisted after the client already aborted the handshake', async () => {
    const durableJob = {
      id: JOB_ID,
      status: WorkflowStatus.QUEUED,
    };
    const dispatch: Pick<WorkflowDispatchService, 'createAndDispatch'> = {
      createAndDispatch: jest
        .fn()
        .mockImplementation(
          async (
            _userId,
            _projectId,
            _dto,
            onPersisted?: (job: typeof durableJob) => void | Promise<void>,
          ) => {
            await onPersisted?.(durableJob);
            return durableJob;
          },
        ),
    };
    const eventStream: Pick<
      WorkflowEventStreamService,
      'prepareResponse' | 'stream'
    > = {
      prepareResponse: jest.fn(),
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const workflowService: Pick<WorkflowService, 'cancel'> = {
      cancel: jest.fn().mockResolvedValue({
        ...durableJob,
        status: WorkflowStatus.STOPPED,
      }),
    };
    const bridge = new WorkflowLegacyBridgeService(
      dispatch as WorkflowDispatchService,
      eventStream as WorkflowEventStreamService,
      workflowService as WorkflowService,
    );

    await bridge.run(
      USER_ID,
      PROJECT_ID,
      WorkflowType.DIRECTORY,
      {},
      Object.assign(new EventEmitter(), {
        headers: { 'x-request-id': 'aborted-before-persistence' },
        aborted: true,
      }) as Request,
      Object.assign(new EventEmitter(), {
        destroyed: true,
        writableEnded: false,
        setHeader: jest.fn(),
      }) as unknown as Response,
    );

    expect(workflowService.cancel).toHaveBeenCalledWith(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
    );
    expect(eventStream.prepareResponse).not.toHaveBeenCalled();
  });

  it('keeps a durable disconnect listener active while Bull acknowledgement is pending', async () => {
    const durableJob = {
      id: JOB_ID,
      status: WorkflowStatus.QUEUED,
    };
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const request = Object.assign(requestEvents, {
      headers: { 'x-request-id': 'disconnect-during-dispatch' },
      aborted: false,
    }) as unknown as Request;
    const response = Object.assign(responseEvents, {
      destroyed: false,
      writableEnded: false,
      setHeader: jest.fn(),
    }) as unknown as Response;
    const dispatch: Pick<WorkflowDispatchService, 'createAndDispatch'> = {
      createAndDispatch: jest
        .fn()
        .mockImplementation(
          async (
            _userId,
            _projectId,
            _dto,
            onPersisted?: (job: typeof durableJob) => void | Promise<void>,
          ) => {
            await onPersisted?.(durableJob);
            responseEvents.emit('close');
            await Promise.resolve();
            return durableJob;
          },
        ),
    };
    const eventStream: Pick<
      WorkflowEventStreamService,
      'prepareResponse' | 'stream'
    > = {
      prepareResponse: jest.fn(),
      stream: jest.fn().mockResolvedValue(undefined),
    };
    const workflowService: Pick<WorkflowService, 'cancel'> = {
      cancel: jest.fn().mockResolvedValue({
        ...durableJob,
        status: WorkflowStatus.STOPPED,
      }),
    };
    const bridge = new WorkflowLegacyBridgeService(
      dispatch as WorkflowDispatchService,
      eventStream as WorkflowEventStreamService,
      workflowService as WorkflowService,
    );

    await bridge.run(
      USER_ID,
      PROJECT_ID,
      WorkflowType.DIRECTORY,
      {},
      request,
      response,
    );

    expect(workflowService.cancel).toHaveBeenCalledWith(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
    );
    expect(eventStream.stream).not.toHaveBeenCalled();
    expect(requestEvents.listenerCount('aborted')).toBe(0);
    expect(responseEvents.listenerCount('close')).toBe(0);
  });

  it('does not interpret a normal completed SSE response close as cancellation', async () => {
    const durableJob = {
      id: JOB_ID,
      status: WorkflowStatus.QUEUED,
    };
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const request = Object.assign(requestEvents, {
      headers: { 'x-request-id': 'normal-close' },
      aborted: false,
    }) as unknown as Request;
    const response = Object.assign(responseEvents, {
      destroyed: false,
      writableEnded: false,
      setHeader: jest.fn(),
    }) as unknown as Response;
    const dispatch: Pick<WorkflowDispatchService, 'createAndDispatch'> = {
      createAndDispatch: jest
        .fn()
        .mockImplementation(
          async (
            _userId,
            _projectId,
            _dto,
            onPersisted?: (job: typeof durableJob) => void | Promise<void>,
          ) => {
            await onPersisted?.(durableJob);
            return durableJob;
          },
        ),
    };
    const eventStream: Pick<
      WorkflowEventStreamService,
      'prepareResponse' | 'stream'
    > = {
      prepareResponse: jest.fn(),
      stream: jest.fn().mockImplementation(() => {
        Object.assign(response, { writableEnded: true, destroyed: true });
        responseEvents.emit('close');
        return Promise.resolve();
      }),
    };
    const workflowService: Pick<WorkflowService, 'cancel'> = {
      cancel: jest.fn(),
    };
    const bridge = new WorkflowLegacyBridgeService(
      dispatch as WorkflowDispatchService,
      eventStream as WorkflowEventStreamService,
      workflowService as WorkflowService,
    );

    await bridge.run(
      USER_ID,
      PROJECT_ID,
      WorkflowType.DIRECTORY,
      {},
      request,
      response,
    );

    expect(workflowService.cancel).not.toHaveBeenCalled();
  });
});
