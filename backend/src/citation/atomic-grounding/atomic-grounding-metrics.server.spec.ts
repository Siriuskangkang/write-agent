import { request } from 'node:http';
import {
  AtomicGroundingMetricsRecorder,
  AtomicGroundingPrometheusExporter,
} from './atomic-grounding.metrics.js';
import { startAtomicGroundingMetricsServer } from './atomic-grounding-metrics.server.js';

describe('atomic-grounding worker metrics server', () => {
  it('exposes the worker exporter over a loopback Prometheus endpoint', async () => {
    const exporter = new AtomicGroundingPrometheusExporter();
    const recorder = new AtomicGroundingMetricsRecorder(exporter);
    recorder.proposal('content', 'draft', 'grounded-draft.v1', 321, 1, 0);
    const server = await startAtomicGroundingMetricsServer(
      exporter,
      0,
      '127.0.0.1',
    );

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP metrics listener');
      }
      const response = await get(address.port, '/metrics');

      expect(response.status).toBe(200);
      expect(response.contentType).toBe(
        'text/plain; version=0.0.4; charset=utf-8',
      );
      expect(response.body).toContain(
        'grounding_proposal_total{schema="grounded-draft.v1",status="draft",workflow_type="content"} 1',
      );
      expect(response.body).not.toMatch(
        /(?:workflow_job_id|project_id|claim_text|evidence_id)=/u,
      );
    } finally {
      await close(server);
    }
  });

  it('does not expose application routes from the worker listener', async () => {
    const server = await startAtomicGroundingMetricsServer(
      new AtomicGroundingPrometheusExporter(),
      0,
      '127.0.0.1',
    );

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP metrics listener');
      }
      expect((await get(address.port, '/api/citations')).status).toBe(404);
    } finally {
      await close(server);
    }
  });
});

async function get(
  port: number,
  path: string,
): Promise<{ status: number; contentType: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            contentType: incoming.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function close(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
