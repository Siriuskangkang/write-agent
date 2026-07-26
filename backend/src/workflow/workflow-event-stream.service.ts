import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ListWorkflowEventsQueryDto } from './dto/list-workflow-events-query.dto.js';
import {
  type WorkflowEventEnvelope,
  WorkflowService,
} from './workflow.service.js';
import {
  TERMINAL_WORKFLOW_STATUSES,
  WorkflowStatus,
} from './workflow.types.js';

export interface WorkflowEventStreamOptions {
  legacyDataOnly?: boolean;
}

export const WORKFLOW_EVENT_STREAM_TIMING = Symbol(
  'WORKFLOW_EVENT_STREAM_TIMING',
);

export interface StreamTiming {
  pollMs?: number;
  heartbeatMs?: number;
}

@Injectable()
export class WorkflowEventStreamService {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly workflowService: WorkflowService,
    @Optional()
    @Inject(WORKFLOW_EVENT_STREAM_TIMING)
    timing: StreamTiming = {},
  ) {
    this.pollMs = Math.max(1, timing.pollMs ?? 500);
    this.heartbeatMs = Math.max(1, timing.heartbeatMs ?? 15_000);
  }

  async stream(
    userId: string,
    projectId: string,
    jobId: string,
    query: ListWorkflowEventsQueryDto,
    lastEventId: string | undefined,
    request: Request,
    response: Response,
    options: WorkflowEventStreamOptions = {},
  ): Promise<void> {
    let disconnected = request.aborted || response.destroyed;
    let pollTimer: NodeJS.Timeout | undefined;
    let pollResolve: (() => void) | undefined;
    const close = () => {
      disconnected = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollResolve?.();
    };
    request.once('aborted', close);
    response.once('close', close);
    let pendingEvents: WorkflowEventEnvelope[];
    try {
      pendingEvents = await this.workflowService.listEvents(
        userId,
        projectId,
        jobId,
        query,
        lastEventId,
      );
    } catch (error) {
      request.off('aborted', close);
      response.off('close', close);
      throw error;
    }
    if (request.aborted || response.destroyed) close();
    if (disconnected) {
      request.off('aborted', close);
      response.off('close', close);
      return;
    }

    this.prepareResponse(response);

    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (!disconnected && !heartbeatPending) {
        heartbeatPending = true;
        void this.writeWithBackpressure(
          response,
          ': heartbeat\n\n',
          () => disconnected,
        ).finally(() => {
          heartbeatPending = false;
        });
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    let cursor = lastEventId;
    try {
      while (!disconnected) {
        const events = pendingEvents;
        pendingEvents = [];
        for (const event of events) {
          cursor = event.id;
          if (options.legacyDataOnly && !LEGACY_EVENT_TYPES.has(event.type)) {
            continue;
          }
          await this.writeEvent(
            response,
            event,
            options.legacyDataOnly === true,
            () => disconnected,
          );
          if (disconnected) return;
        }

        if (events.length === 0) {
          const job = await this.workflowService.findOne(
            userId,
            projectId,
            jobId,
          );
          if (isTerminal(job.status)) {
            response.end();
            return;
          }
        }

        await new Promise<void>((resolve) => {
          pollResolve = resolve;
          pollTimer = setTimeout(resolve, this.pollMs);
          pollTimer.unref?.();
        });
        pollResolve = undefined;
        pollTimer = undefined;
        if (!disconnected) {
          pendingEvents = await this.workflowService.listEvents(
            userId,
            projectId,
            jobId,
            query,
            cursor,
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (pollTimer) clearTimeout(pollTimer);
      request.off('aborted', close);
      response.off('close', close);
    }
  }

  prepareResponse(response: Response): void {
    if (response.headersSent) return;
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
  }

  private async writeEvent(
    response: Response,
    event: WorkflowEventEnvelope,
    legacyDataOnly: boolean,
    disconnected: () => boolean,
  ): Promise<void> {
    const payload = legacyDataOnly ? event.data : event;
    const frame = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(
      payload,
    )}\n\n`;
    await this.writeWithBackpressure(response, frame, disconnected);
  }

  private async writeWithBackpressure(
    response: Response,
    frame: string,
    disconnected: () => boolean,
  ): Promise<void> {
    if (disconnected() || response.write(frame)) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        response.off('drain', done);
        response.off('close', done);
        resolve();
      };
      response.once('drain', done);
      response.once('close', done);
    });
  }
}

const LEGACY_EVENT_TYPES = new Set([
  'meta',
  'reset',
  'token',
  'citation',
  'done',
  'error',
]);

function isTerminal(status: WorkflowStatus): boolean {
  if (status === WorkflowStatus.WAITING_MATERIAL) return true;
  return (TERMINAL_WORKFLOW_STATUSES as readonly WorkflowStatus[]).includes(
    status,
  );
}
