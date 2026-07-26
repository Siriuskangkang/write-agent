import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ListWorkflowEventsQueryDto } from './dto/list-workflow-events-query.dto.js';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import type { PublicGenerationWorkflowType } from './dto/create-workflow.dto.js';
import { WorkflowService } from './workflow.service.js';

@Injectable()
export class WorkflowLegacyBridgeService {
  private readonly logger = new Logger(WorkflowLegacyBridgeService.name);

  constructor(
    private readonly dispatchService: WorkflowDispatchService,
    private readonly eventStream: WorkflowEventStreamService,
    private readonly workflowService: WorkflowService,
  ) {}

  async run(
    userId: string,
    projectId: string,
    workflowType: PublicGenerationWorkflowType,
    input: Record<string, unknown>,
    request: Request,
    response: Response,
  ): Promise<void> {
    const rawRequestId = request.headers['x-request-id'];
    const requestId =
      typeof rawRequestId === 'string' ? rawRequestId.trim() : undefined;
    let persistedJobId: string | undefined;
    let clientDisconnected = request.aborted || response.destroyed;
    let normalCompletion = false;
    let listenersAttached = false;
    let cancellation: Promise<void> | undefined;
    const cancelPersistedJob = (): Promise<void> => {
      if (!persistedJobId || normalCompletion) {
        return Promise.resolve();
      }
      cancellation ??= this.workflowService
        .cancel(userId, projectId, persistedJobId)
        .then(() => undefined)
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Could not cancel disconnected legacy workflow ${persistedJobId}: ${message}`,
          );
        });
      return cancellation;
    };
    const onRequestAborted = () => {
      clientDisconnected = true;
      void cancelPersistedJob();
    };
    const onResponseClose = () => {
      if (normalCompletion || response.writableEnded) return;
      clientDisconnected = true;
      void cancelPersistedJob();
    };
    const attachDisconnectListeners = () => {
      if (listenersAttached) return;
      listenersAttached = true;
      request.once('aborted', onRequestAborted);
      response.once('close', onResponseClose);
    };
    const detachDisconnectListeners = () => {
      if (!listenersAttached) return;
      listenersAttached = false;
      request.off('aborted', onRequestAborted);
      response.off('close', onResponseClose);
    };

    try {
      const job = await this.dispatchService.createAndDispatch(
        userId,
        projectId,
        {
          workflow_type: workflowType,
          ...(requestId ? { idempotency_key: requestId.slice(0, 128) } : {}),
          input: toPlainJsonRecord(input),
        },
        async (persistedJob) => {
          persistedJobId = persistedJob.id;
          attachDisconnectListeners();
          if (request.aborted || response.destroyed) {
            clientDisconnected = true;
            await cancelPersistedJob();
            return;
          }
          response.setHeader('X-Workflow-Job-Id', persistedJob.id);
          this.eventStream.prepareResponse(response);
        },
        'legacy_api',
      );
      if (clientDisconnected || request.aborted || response.destroyed) {
        clientDisconnected = true;
        await cancelPersistedJob();
        return;
      }
      const query: ListWorkflowEventsQueryDto = { limit: 200 };
      const rawLastEventId = request.headers['last-event-id'];
      const lastEventId =
        typeof rawLastEventId === 'string' && rawLastEventId.trim() !== ''
          ? rawLastEventId.trim()
          : undefined;
      await this.eventStream.stream(
        userId,
        projectId,
        job.id,
        query,
        lastEventId,
        request,
        response,
        { legacyDataOnly: true },
      );
      if (!clientDisconnected) {
        normalCompletion = true;
      }
    } finally {
      if (clientDisconnected) {
        await cancelPersistedJob();
      }
      detachDisconnectListeners();
    }
  }

  async cancelLegacyResult(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<boolean> {
    return this.workflowService.cancelByLegacyResult(
      userId,
      projectId,
      resultId,
    );
  }
}

function toPlainJsonRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = JSON.stringify(input);
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}
