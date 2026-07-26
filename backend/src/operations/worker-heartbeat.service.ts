import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import type * as Bull from 'bull';
import { WORKFLOW_QUEUE } from '../workflow/workflow.processor.js';

export const WORKER_HEARTBEAT_KEY = 'write-agent:worker:heartbeat:v1';
const HEARTBEAT_TTL_SECONDS = 30;
const HEARTBEAT_INTERVAL_MS = 10_000;

@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectQueue(WORKFLOW_QUEUE)
    private readonly queue: Bull.Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.isWorker()) return;
    await this.writeHeartbeat();
    this.timer = setInterval(() => {
      void this.writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private isWorker(): boolean {
    return this.config.get<string>('WORKER_MODE', 'false') === 'true';
  }

  private async writeHeartbeat(): Promise<void> {
    await this.queue.isReady();
    await this.queue.client.set(
      WORKER_HEARTBEAT_KEY,
      JSON.stringify({ observed_at: new Date().toISOString() }),
      'EX',
      HEARTBEAT_TTL_SECONDS,
    );
  }
}
