import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bull';
import type * as Bull from 'bull';
import { DataSource } from 'typeorm';
import { WORKFLOW_QUEUE } from '../workflow/workflow.processor.js';
import { safeOperationalError } from './request-correlation.js';
import { WORKER_HEARTBEAT_KEY } from './worker-heartbeat.service.js';

export interface DependencyStatus {
  status: 'up' | 'down';
  detail?: string;
}

@Injectable()
export class OperationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectQueue(WORKFLOW_QUEUE)
    private readonly workflowQueue: Bull.Queue,
  ) {}

  async readiness(): Promise<{
    status: 'ready' | 'not_ready';
    dependencies: Record<string, DependencyStatus>;
  }> {
    const [mysql, redis, worker, qdrant] = await Promise.all([
      this.checkMysql(),
      this.checkRedis(),
      this.checkWorker(),
      this.checkQdrant(),
    ]);
    const llm = this.checkLlmConfiguration();
    const dependencies = { mysql, redis, bull_worker: worker, qdrant, llm };
    return {
      status: Object.values(dependencies).every(
        (dependency) => dependency.status === 'up',
      )
        ? 'ready'
        : 'not_ready',
      dependencies,
    };
  }

  async metrics(): Promise<Record<string, unknown>> {
    const [workflow, model, retrieval, queue] = await Promise.all([
      this.dataSource.query<Array<Record<string, unknown>>>(
        `SELECT status,COUNT(*) AS count,
                ROUND(AVG(TIMESTAMPDIFF(MICROSECOND,created_at,
                  COALESCE(completed_at,updated_at)))/1000) AS avg_latency_ms
           FROM workflow_jobs
          GROUP BY status`,
      ),
      this.dataSource.query<Array<Record<string, unknown>>>(
        `SELECT status,COUNT(*) AS count,
                COALESCE(SUM(cost_usd),0) AS cost_usd,
                COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(
                  usage,'$.total_tokens')) AS UNSIGNED)),0) AS tokens
           FROM model_runs
          GROUP BY status`,
      ),
      this.dataSource.query<Array<Record<string, unknown>>>(
        `SELECT state,COUNT(*) AS count,
                ROUND(AVG(latency_ms)) AS avg_latency_ms,
                COALESCE(SUM(embedding_cost_usd),0) AS embedding_cost_usd
           FROM retrieval_runs
          GROUP BY state`,
      ),
      this.workflowQueue.getJobCounts(),
    ]);
    return {
      generated_at: new Date().toISOString(),
      workflow,
      model,
      retrieval,
      queue,
    };
  }

  private async checkMysql(): Promise<DependencyStatus> {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', detail: safeOperationalError(error) };
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    try {
      await this.workflowQueue.isReady();
      const pong = await this.workflowQueue.client.ping();
      return pong === 'PONG'
        ? { status: 'up' }
        : { status: 'down', detail: 'UnexpectedResponse' };
    } catch (error) {
      return { status: 'down', detail: safeOperationalError(error) };
    }
  }

  private async checkWorker(): Promise<DependencyStatus> {
    try {
      await this.workflowQueue.isReady();
      const heartbeat =
        await this.workflowQueue.client.get(WORKER_HEARTBEAT_KEY);
      return heartbeat
        ? { status: 'up' }
        : { status: 'down', detail: 'HeartbeatMissing' };
    } catch (error) {
      return { status: 'down', detail: safeOperationalError(error) };
    }
  }

  private async checkQdrant(): Promise<DependencyStatus> {
    try {
      const baseUrl = this.config.getOrThrow<string>('QDRANT_URL');
      const timeout = Math.min(
        this.config.get<number>('QDRANT_TIMEOUT_MS', 5_000),
        5_000,
      );
      const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/readyz`, {
        signal: AbortSignal.timeout(timeout),
        headers: this.qdrantHeaders(),
      });
      return response.ok
        ? { status: 'up' }
        : { status: 'down', detail: `HTTP_${response.status}` };
    } catch (error) {
      return { status: 'down', detail: safeOperationalError(error) };
    }
  }

  private checkLlmConfiguration(): DependencyStatus {
    const provider = this.config.get<string>('LLM_PROVIDER');
    const key =
      provider === 'anthropic'
        ? this.config.get<string>('ANTHROPIC_API_KEY')
        : provider === 'deepseek'
          ? this.config.get<string>('DEEPSEEK_API_KEY')
          : undefined;
    return key
      ? { status: 'up', detail: provider }
      : { status: 'down', detail: 'ConfigurationMissing' };
  }

  private qdrantHeaders(): Record<string, string> {
    const apiKey = this.config.get<string>('QDRANT_API_KEY');
    return apiKey ? { 'api-key': apiKey } : {};
  }
}
