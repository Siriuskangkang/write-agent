import { InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as Bull from 'bull';
import { INDEX_VERSION_RECORDER } from './injection-tokens.js';
import type { IndexVersionRecorder } from './types.js';

@Injectable()
export class DenseIndexDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DenseIndexDispatcher.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(INDEX_VERSION_RECORDER)
    private readonly recorder: IndexVersionRecorder,
    @InjectQueue('dense-index') private readonly queue: Bull.Queue,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKER_MODE !== 'true') return;
    void this.dispatchPending();
    this.timer = setInterval(() => void this.dispatchPending(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async dispatchPending(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.dispatchBatch().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async dispatchBatch(): Promise<void> {
    const records = await this.recorder.claimDispatchBatch(20);
    for (const record of records) {
      try {
        await this.queue.add(
          'index',
          {
            indexVersionId: record.id,
            attemptToken: record.attempt_token,
            attempt: record.attempt_count,
          },
          {
            jobId: `dense-index:${record.id}:${record.attempt_count}:${record.attempt_token}`,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      } catch (error) {
        await this.recorder.releaseDispatchClaim(
          record.id,
          record.attempt_token,
          error instanceof Error ? error.message : String(error),
        );
        this.logger.error(
          `Failed to dispatch dense index ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
