import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { INDEX_VERSION_RECORDER } from './injection-tokens.js';
import type { IndexVersionRecorder } from './types.js';

@Injectable()
export class DenseIndexGcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DenseIndexGcService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(INDEX_VERSION_RECORDER)
    private readonly recorder: IndexVersionRecorder,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKER_MODE !== 'true') return;
    void this.collect();
    this.timer = setInterval(() => void this.collect(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collect(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.collectBatch().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async collectBatch(): Promise<void> {
    // A previously inactive ingestion can be reactivated by structured
    // ingestion. No database fence can safely span a Qdrant delete, so online
    // maintenance records durable retention debt and deliberately leaves the
    // namespace orphaned but unreachable by the active-namespace allowlist.
    const debts = await this.recorder.recordRetentionDebtBatch(20);
    for (const debt of debts) {
      this.logger.warn(
        `Dense namespace retained for ${debt.id} (${debt.namespace}): ${debt.reason}`,
      );
    }
  }
}
