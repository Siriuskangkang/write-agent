import { createServer, type Server } from 'node:http';
import { AtomicGroundingPrometheusExporter } from './atomic-grounding.metrics.js';

export const DEFAULT_ATOMIC_GROUNDING_METRICS_PORT = 9465;

export function readAtomicGroundingMetricsPort(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_ATOMIC_GROUNDING_METRICS_PORT;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('ATOMIC_GROUNDING_METRICS_PORT_INVALID');
  }
  return port;
}

export function startAtomicGroundingMetricsServer(
  exporter: AtomicGroundingPrometheusExporter,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (
      request.method !== 'GET' ||
      request.url?.split('?', 1)[0] !== '/metrics'
    ) {
      response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('Not Found\n');
      return;
    }
    const body = exporter.exposition();
    response.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'no-store',
    });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      resolve(server);
    });
  });
}
