import { InjectQueue } from '@nestjs/bull';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type * as Bull from 'bull';
import type { CreateWorkflowDto } from './dto/create-workflow.dto.js';
import type { WorkflowJob } from './entities/workflow-job.entity.js';
import { WORKFLOW_QUEUE, WORKFLOW_RUN_JOB } from './workflow.processor.js';
import { WorkflowService } from './workflow.service.js';
import type { ServerEntrypoint } from '../authoring/rollout/authoring-rollout.js';

export const WORKFLOW_DISPATCH_OPTIONS = Symbol('WORKFLOW_DISPATCH_OPTIONS');

export interface WorkflowDispatchOptions {
  acknowledgementTimeoutMs?: number;
}

@Injectable()
export class WorkflowDispatchService {
  private readonly logger = new Logger(WorkflowDispatchService.name);
  private readonly acknowledgementTimeoutMs: number;
  private readonly pendingDeliveries = new Map<
    string,
    Promise<Bull.Job<{ jobId: string }>>
  >();

  constructor(
    private readonly workflowService: WorkflowService,
    @InjectQueue(WORKFLOW_QUEUE)
    private readonly queue: Bull.Queue<{ jobId: string }>,
    @Optional()
    @Inject(WORKFLOW_DISPATCH_OPTIONS)
    options: WorkflowDispatchOptions = {},
  ) {
    this.acknowledgementTimeoutMs = Math.max(
      1,
      options.acknowledgementTimeoutMs ?? 2_000,
    );
  }

  async createAndDispatch(
    userId: string,
    projectId: string,
    dto: CreateWorkflowDto,
    onPersisted?: (job: WorkflowJob) => void | Promise<void>,
    serverEntrypoint: ServerEntrypoint = 'workflow_api',
  ): Promise<WorkflowJob> {
    const job =
      serverEntrypoint === 'workflow_api'
        ? await this.workflowService.create(userId, projectId, dto)
        : await this.workflowService.create(
            userId,
            projectId,
            dto,
            serverEntrypoint,
          );
    await onPersisted?.(job);
    await this.dispatch(job.id);
    return job;
  }

  async dispatch(jobId: string): Promise<boolean> {
    let delivery = this.pendingDeliveries.get(jobId);
    if (!delivery) {
      const newDelivery = this.queue.add(
        WORKFLOW_RUN_JOB,
        { jobId },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 1,
        },
      );
      delivery = newDelivery;
      this.pendingDeliveries.set(jobId, newDelivery);
      void newDelivery.then(
        () => this.clearPendingDelivery(jobId, newDelivery),
        (error: unknown) => {
          this.clearPendingDelivery(jobId, newDelivery);
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Workflow ${jobId} persisted but Bull trigger failed: ${message}`,
          );
        },
      );
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        delivery,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new WorkflowDispatchTimeoutError()),
            this.acknowledgementTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      if (error instanceof WorkflowDispatchTimeoutError) {
        this.clearPendingDelivery(jobId, delivery);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Workflow ${jobId} persisted but Bull trigger failed: ${message}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clearPendingDelivery(
    jobId: string,
    delivery: Promise<Bull.Job<{ jobId: string }>>,
  ): void {
    if (this.pendingDeliveries.get(jobId) === delivery) {
      this.pendingDeliveries.delete(jobId);
    }
  }
}

class WorkflowDispatchTimeoutError extends Error {
  constructor() {
    super('Redis delivery acknowledgement timed out; recovery will retry');
    this.name = 'WorkflowDispatchTimeoutError';
  }
}
