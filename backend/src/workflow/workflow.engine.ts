import { Inject, Injectable, Optional } from '@nestjs/common';
import { WorkflowType } from './workflow.types.js';
import type {
  AuthoringMode,
  AuthoringPolicySnapshotV1,
  ServerEntrypoint,
  WorkflowDefinition,
} from '../authoring/rollout/authoring-rollout.js';

export const WORKFLOW_EXECUTION_STORE = Symbol('WORKFLOW_EXECUTION_STORE');
export const WORKFLOW_TASK_EXECUTOR = Symbol('WORKFLOW_TASK_EXECUTOR');
export const WORKFLOW_ENGINE_OPTIONS = Symbol('WORKFLOW_ENGINE_OPTIONS');

export interface ClaimedWorkflowJob {
  id: string;
  userId: string;
  projectId: string;
  workflowType: WorkflowType;
  input: Record<string, unknown> | null;
  checkpoint: Record<string, unknown> | null;
  leaseToken: string;
  fencingToken: number;
  generationAttempt: number;
  workflowDefinition?: WorkflowDefinition;
  authoringMode?: AuthoringMode;
  rolloutPolicyVersion?: string;
  rolloutPolicySnapshot?: AuthoringPolicySnapshotV1;
  rolloutPolicyDigest?: string;
  serverEntrypoint?: ServerEntrypoint;
  clientContractVersion?: 'authoring-approval-ui.v1' | null;
}

export type WorkflowControlState = 'active' | 'cancelled' | 'lease_lost';

export interface WorkflowExecutionStore {
  claim(jobId: string, workerId: string): Promise<ClaimedWorkflowJob | null>;
  inspectControl(job: ClaimedWorkflowJob): Promise<WorkflowControlState>;
  persistProgress(
    job: ClaimedWorkflowJob,
    type: string,
    data: Record<string, unknown> | null,
    checkpoint: Record<string, unknown>,
  ): Promise<void>;
  suspend(
    job: ClaimedWorkflowJob,
    reason: WorkflowSuspensionReason,
  ): Promise<void>;
  complete(job: ClaimedWorkflowJob): Promise<void>;
  fail(job: ClaimedWorkflowJob, error: unknown): Promise<void>;
}

export interface WorkflowExecutionEvent {
  type: string;
  data: Record<string, unknown> | null;
  checkpoint: Record<string, unknown>;
  onPersisted?: () => void;
}

export interface WorkflowTaskContext {
  signal: AbortSignal;
  persistProgress?: (event: WorkflowExecutionEvent) => Promise<void>;
}

export interface WorkflowTaskExecutor {
  execute(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    WorkflowExecutionOutcome | void,
    void
  >;
}

export type WorkflowSuspensionReason =
  | 'WAITING_APPROVAL'
  | 'WAITING_MATERIAL'
  | 'SHADOW_COMPLETED';

export type WorkflowExecutionOutcome =
  | { kind: 'COMPLETED' }
  | { kind: 'SUSPENDED'; reason: WorkflowSuspensionReason };

export interface WorkflowEngineOptions {
  workerId?: string;
  cancelPollMs?: number;
}

export class WorkflowCancelledError extends Error {
  constructor() {
    super('Workflow was cancelled');
    this.name = 'WorkflowCancelledError';
  }
}

export class WorkflowLeaseLostError extends Error {
  constructor() {
    super('Workflow execution lease was lost');
    this.name = 'WorkflowLeaseLostError';
  }
}

@Injectable()
export class WorkflowEngine {
  private readonly workerId: string;
  private readonly cancelPollMs: number;

  constructor(
    @Inject(WORKFLOW_EXECUTION_STORE)
    private readonly store: WorkflowExecutionStore,
    @Inject(WORKFLOW_TASK_EXECUTOR)
    private readonly executor: WorkflowTaskExecutor,
    @Optional()
    @Inject(WORKFLOW_ENGINE_OPTIONS)
    options: WorkflowEngineOptions = {},
  ) {
    this.workerId =
      options.workerId ??
      process.env.WORKFLOW_WORKER_ID ??
      `worker-${process.pid}`;
    this.cancelPollMs = Math.max(1, options.cancelPollMs ?? 250);
  }

  async run(jobId: string): Promise<void> {
    const job = await this.store.claim(jobId, this.workerId);
    if (!job) return;

    const abortController = new AbortController();
    let monitorStopped = false;
    const monitor = this.monitorControl(job, abortController, () => {
      return monitorStopped;
    });

    try {
      const persistProgress = async (
        event: WorkflowExecutionEvent,
      ): Promise<void> => {
        if (abortController.signal.aborted) {
          throw new WorkflowCancelledError();
        }
        await this.store.persistProgress(
          job,
          event.type,
          event.data,
          event.checkpoint,
        );
        event.onPersisted?.();
      };
      const iterator = this.executor.execute(job, {
        signal: abortController.signal,
        persistProgress,
      });
      let outcome: WorkflowExecutionOutcome | void;
      while (true) {
        const step = await iterator.next();
        if (step.done) {
          outcome = step.value;
          break;
        }
        await persistProgress(step.value);
      }
      if (outcome?.kind === 'SUSPENDED') {
        await this.store.suspend(job, outcome.reason);
      } else {
        await this.store.complete(job);
      }
    } catch (error) {
      if (
        isExecutionFenceError(error) ||
        (isAbortError(error) && abortController.signal.aborted)
      ) {
        return;
      }
      try {
        await this.store.fail(job, error);
      } catch (failureError) {
        if (
          !isExecutionFenceError(failureError) &&
          !(isAbortError(failureError) && abortController.signal.aborted)
        ) {
          throw failureError;
        }
      }
    } finally {
      monitorStopped = true;
      abortController.abort();
      await monitor;
    }
  }

  private async monitorControl(
    job: ClaimedWorkflowJob,
    controller: AbortController,
    stopped: () => boolean,
  ): Promise<void> {
    while (!stopped() && !controller.signal.aborted) {
      await delay(this.cancelPollMs);
      if (stopped() || controller.signal.aborted) return;
      try {
        const state = await this.store.inspectControl(job);
        if (state !== 'active') {
          controller.abort(
            state === 'cancelled'
              ? new WorkflowCancelledError()
              : new WorkflowLeaseLostError(),
          );
          return;
        }
      } catch {
        // A transient control-plane read must not terminate a model request.
        // Progress writes remain fenced by MySQL and are the final authority.
      }
    }
  }
}

function isExecutionFenceError(error: unknown): boolean {
  return (
    error instanceof WorkflowCancelledError ||
    error instanceof WorkflowLeaseLostError
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
