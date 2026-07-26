import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { WorkerModule } from './worker.module.js';
import { AtomicGroundingPrometheusExporter } from './citation/atomic-grounding/atomic-grounding.metrics.js';
import {
  readAtomicGroundingMetricsPort,
  startAtomicGroundingMetricsServer,
} from './citation/atomic-grounding/atomic-grounding-metrics.server.js';

interface WorkerBootstrapOptions {
  startMetricsServer?: (
    exporter: AtomicGroundingPrometheusExporter,
    port: number,
    host: string,
  ) => Promise<Server | undefined>;
}

export async function bootstrapWorker(
  options: WorkerBootstrapOptions = {},
): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule);
  const exporter = context.get(AtomicGroundingPrometheusExporter);
  await (options.startMetricsServer ?? startAtomicGroundingMetricsServer)(
    exporter,
    readAtomicGroundingMetricsPort(process.env.ATOMIC_GROUNDING_METRICS_PORT),
    process.env.ATOMIC_GROUNDING_METRICS_HOST ?? '127.0.0.1',
  );
}

if (!process.env.JEST_WORKER_ID) {
  void bootstrapWorker();
}
