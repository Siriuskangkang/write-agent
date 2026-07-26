import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { WorkflowService } from './workflow.service.js';
import { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';

describe('WorkflowEventStreamService', () => {
  it('resumes after Last-Event-ID, waits for backpressure, then closes at terminal state', async () => {
    const service = workflowService();
    service.listEvents
      .mockResolvedValueOnce([
        {
          id: EVENT_ID,
          job_id: JOB_ID,
          seq: 8,
          type: 'token',
          data: { type: 'token', content: '恢复' },
          created_at: new Date('2026-07-25T00:00:00Z'),
        },
      ])
      .mockResolvedValue([]);
    service.findOne
      .mockResolvedValueOnce(job(WorkflowStatus.RUNNING))
      .mockResolvedValue(job(WorkflowStatus.SUCCEEDED));
    const stream = new WorkflowEventStreamService(service as WorkflowService, {
      pollMs: 1,
      heartbeatMs: 60_000,
    });
    const response = new FakeResponse();
    response.backpressureOnce = true;
    response.onFirstBackpressure = () =>
      setImmediate(() => response.emit('drain'));

    await stream.stream(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      '55555555-5555-4555-8555-555555555555',
      new EventEmitter() as Request,
      response as unknown as Response,
    );

    expect(service.listEvents).toHaveBeenNthCalledWith(
      1,
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      '55555555-5555-4555-8555-555555555555',
    );
    expect(response.body).toContain(`id: ${EVENT_ID}`);
    expect(response.body).toContain('event: token');
    expect(response.body).toContain(`"job_id":"${JOB_ID}"`);
    expect(response.ended).toBe(true);
    expect(response.headers['Content-Type']).toBe('text/event-stream');
  });

  it('releases timers and stops polling when the client disconnects', async () => {
    const service = workflowService();
    service.listEvents.mockResolvedValue([]);
    service.findOne.mockResolvedValue(job(WorkflowStatus.RUNNING));
    const stream = new WorkflowEventStreamService(service as WorkflowService, {
      pollMs: 50,
      heartbeatMs: 50,
    });
    const request = new EventEmitter();
    const response = new FakeResponse();

    const running = stream.stream(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      undefined,
      request as Request,
      response as unknown as Response,
    );
    await new Promise((resolve) => setImmediate(resolve));
    request.emit('aborted');
    await running;
    const callsAfterClose = service.listEvents.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(service.listEvents).toHaveBeenCalledTimes(callsAfterClose);
    expect(response.ended).toBe(false);
  });

  it('does not start an SSE response when disconnect happens during initial lookup', async () => {
    let resolveLookup!: (value: []) => void;
    const service = workflowService();
    service.listEvents.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const stream = new WorkflowEventStreamService(service as WorkflowService, {
      pollMs: 10,
      heartbeatMs: 10,
    });
    const request = new FakeRequest();
    const response = new FakeResponse();

    const running = stream.stream(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      undefined,
      request as unknown as Request,
      response as unknown as Response,
    );
    request.aborted = true;
    request.emit('aborted');
    resolveLookup([]);
    await running;

    expect(response.flushed).toBe(false);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('does not treat a completed legacy POST request close as a client disconnect', async () => {
    let resolveLookup!: (value: []) => void;
    const service = workflowService();
    service.listEvents
      .mockReturnValueOnce(
        new Promise<[]>((resolve) => {
          resolveLookup = resolve;
        }),
      )
      .mockResolvedValue([]);
    service.findOne.mockResolvedValue(job(WorkflowStatus.SUCCEEDED));
    const stream = new WorkflowEventStreamService(service as WorkflowService, {
      pollMs: 1,
      heartbeatMs: 60_000,
    });
    const request = new FakeRequest();
    const response = new FakeResponse();

    const running = stream.stream(
      USER_ID,
      PROJECT_ID,
      JOB_ID,
      { limit: 100 },
      undefined,
      request as unknown as Request,
      response as unknown as Response,
    );
    request.complete = true;
    request.destroyed = true;
    request.emit('close');
    resolveLookup([]);
    await running;

    expect(response.flushed).toBe(true);
    expect(response.ended).toBe(true);
  });
});

function workflowService() {
  return {
    listEvents: jest.fn(),
    findOne: jest.fn(),
  };
}

function job(status: WorkflowStatus) {
  const now = new Date();
  return {
    id: JOB_ID,
    user_id: USER_ID,
    project_id: PROJECT_ID,
    workflow_type: WorkflowType.CONTENT,
    idempotency_key: 'private',
    request_hash: 'a'.repeat(64),
    status,
    input: null,
    checkpoint: null,
    cancel_requested_at: null,
    approved_at: null,
    error_code: null,
    error_message: null,
    public_error_code: null,
    public_error_message: null,
    started_at: now,
    completed_at:
      status === WorkflowStatus.RUNNING || status === WorkflowStatus.QUEUED
        ? null
        : now,
    created_at: now,
    updated_at: now,
  };
}

class FakeResponse extends EventEmitter {
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  destroyed = false;
  flushed = false;
  backpressureOnce = false;
  onFirstBackpressure?: () => void;

  status() {
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  flushHeaders() {
    this.flushed = true;
  }

  write(chunk: string): boolean {
    this.body += chunk;
    if (this.backpressureOnce) {
      this.backpressureOnce = false;
      this.onFirstBackpressure?.();
      return false;
    }
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  aborted = false;
  complete = false;
}
