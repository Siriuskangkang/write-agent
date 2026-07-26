import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';

export const WORKFLOW_RECOVERY_OPTIONS = Symbol('WORKFLOW_RECOVERY_OPTIONS');

export interface WorkflowRecoveryOptions {
  intervalMs?: number;
  maxConcurrency?: number;
  failureBackoffMs?: number;
}

@Injectable()
export class WorkflowRecoveryDispatcher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WorkflowRecoveryDispatcher.name);
  private readonly intervalMs: number;
  private readonly maxConcurrency: number;
  private readonly failureBackoffMs: number;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private readonly retryAfter = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatchService: WorkflowDispatchService,
    @Optional()
    @Inject(WORKFLOW_RECOVERY_OPTIONS)
    options: WorkflowRecoveryOptions = {},
  ) {
    this.intervalMs = Math.max(100, options.intervalMs ?? 5_000);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.failureBackoffMs = Math.max(
      this.intervalMs,
      options.failureBackoffMs ?? 15_000,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.recoverNow();
    this.timer = setInterval(() => {
      void this.recoverNow().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Workflow recovery scan failed: ${message}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async recoverNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scanAndDispatch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async scanAndDispatch(): Promise<void> {
    const rows: unknown = await this.dataSource.query(
      `SELECT id
         FROM workflow_jobs
        WHERE status = 'QUEUED'
           OR status = 'REVISION_REQUIRED'
           OR (
             status = 'RUNNING'
             AND (
               lease_expires_at IS NULL
               OR lease_expires_at <= CURRENT_TIMESTAMP(6)
             )
           )
        ORDER BY created_at ASC
        LIMIT 100`,
    );
    if (!Array.isArray(rows)) {
      throw new Error('Workflow recovery query returned an invalid result');
    }
    const now = Date.now();
    const jobIds = rows.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string') return [];
      if ((this.retryAfter.get(id) ?? 0) > now) return [];
      return [id];
    });
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobIds.length) {
        const index = cursor;
        cursor += 1;
        const jobId = jobIds[index];
        try {
          const delivered = await this.dispatchService.dispatch(jobId);
          if (delivered === false) {
            this.retryAfter.set(jobId, Date.now() + this.failureBackoffMs);
          } else {
            this.retryAfter.delete(jobId);
          }
        } catch (error) {
          this.retryAfter.set(jobId, Date.now() + this.failureBackoffMs);
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Workflow ${jobId} recovery dispatch failed: ${message}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.maxConcurrency, jobIds.length) }, () =>
        worker(),
      ),
    );
    for (const [jobId, retryAt] of this.retryAfter) {
      if (retryAt + this.failureBackoffMs < now) {
        this.retryAfter.delete(jobId);
      }
    }
  }
}
