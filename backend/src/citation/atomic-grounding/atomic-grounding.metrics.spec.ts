import {
  AtomicGroundingMetricsRecorder,
  AtomicGroundingPrometheusExporter,
  type AtomicMetricPoint,
} from './atomic-grounding.metrics.js';
import { ATOMIC_GROUNDING_REASON_CODES } from './contracts.js';

describe('AtomicGroundingMetricsRecorder', () => {
  it('exposes every documented shadow-mode series without content or identity labels', () => {
    const exporter = new AtomicGroundingPrometheusExporter();
    const recorder = new AtomicGroundingMetricsRecorder(exporter);

    recorder.proposal('content', 'draft', 'grounded-draft.v1', 7_777, 2, 1);
    recorder.claim('rewrite', 'atomic_extract_exact', 'SUPPORTED');
    recorder.failClosed('expand', 'ATOM_EXACT_MISMATCH');
    recorder.revision('required');
    recorder.materialGap('NO_EVIDENCE');
    recorder.renderLatency('compress', 12);
    recorder.firstRenderedToken('content', 13);

    const exposition = exporter.exposition();

    for (const name of [
      'grounding_proposal_total',
      'grounding_claim_total',
      'grounding_fail_closed_total',
      'grounding_revision_total',
      'grounding_material_gap_total',
      'grounding_structured_repair_total',
      'grounding_proposal_bytes',
      'grounding_proposal_claim_count',
      'grounding_render_latency_ms',
      'grounding_time_to_first_rendered_token_ms',
    ]) {
      expect(exposition).toContain(`# TYPE ${name} `);
    }
    expect(exposition).toContain(
      'grounding_proposal_total{schema="grounded-draft.v1",status="draft",workflow_type="content"} 1',
    );
    expect(exposition).toContain(
      'grounding_time_to_first_rendered_token_ms_count{workflow_type="content"} 1',
    );
    expect(exposition).not.toMatch(
      /(?:content|prompt|workflow|project|claim|evidence)(?:_id|_text)?=/,
    );
  });

  it('emits every closed metric with only allowlisted low-cardinality labels', () => {
    const points: AtomicMetricPoint[] = [];
    const recorder = new AtomicGroundingMetricsRecorder({
      record: (point) => points.push(point),
    });

    recorder.proposal('content', 'draft', 'grounded-draft.v1', 7_777, 2, 1);
    recorder.claim('rewrite', 'atomic_extract_exact', 'SUPPORTED');
    recorder.failClosed('expand', 'ATOM_EXACT_MISMATCH');
    recorder.revision('required');
    recorder.materialGap('NO_EVIDENCE');
    recorder.renderLatency('compress', 12);
    recorder.firstRenderedToken('content', 13);

    expect(points.map((point) => point.name)).toEqual([
      'grounding_proposal_total',
      'grounding_proposal_bytes',
      'grounding_proposal_claim_count',
      'grounding_structured_repair_total',
      'grounding_claim_total',
      'grounding_fail_closed_total',
      'grounding_revision_total',
      'grounding_material_gap_total',
      'grounding_render_latency_ms',
      'grounding_time_to_first_rendered_token_ms',
    ]);
    const allowedKeys = new Set([
      'schema',
      'status',
      'workflow_type',
      'method',
      'verdict',
      'reason',
      'outcome',
    ]);
    for (const point of points) {
      expect(Number.isFinite(point.value)).toBe(true);
      expect(point.value).toBeGreaterThanOrEqual(0);
      expect(
        Object.keys(point.labels).every((key) => allowedKeys.has(key)),
      ).toBe(true);
    }
    expect(
      points.find((point) => point.name === 'grounding_proposal_bytes'),
    ).toEqual(
      expect.objectContaining({
        kind: 'histogram',
        value: 7_777,
        labels: {
          schema: 'grounded-draft.v1',
          status: 'draft',
          workflow_type: 'content',
        },
      }),
    );
    expect(
      points.find(
        (point) => point.name === 'grounding_structured_repair_total',
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'counter',
        value: 1,
        labels: {
          schema: 'grounded-draft.v1',
          workflow_type: 'content',
        },
      }),
    );
  });

  it.each([
    ['workflow type', () => callUnsafe('proposal', 'directory')],
    ['proposal status', () => callUnsafe('proposal', 'content', 'raw')],
    [
      'schema',
      () => callUnsafe('proposal', 'content', 'draft', 'future-schema'),
    ],
    ['method', () => callUnsafe('claim', 'content', 'semantic', 'SUPPORTED')],
    [
      'verdict',
      () => callUnsafe('claim', 'content', 'atomic_extract_exact', 'PARTIAL'),
    ],
    ['reason', () => callUnsafe('failClosed', 'content', 'SECRET_REASON')],
    ['outcome', () => callUnsafe('revision', 'retrying')],
    ['NaN', () => callUnsafe('renderLatency', 'content', Number.NaN)],
    ['negative', () => callUnsafe('firstRenderedToken', 'content', -1)],
    [
      'fractional proposal bytes',
      () =>
        callUnsafe(
          'proposal',
          'content',
          'draft',
          'grounded-draft.v1',
          1.5,
          1,
          0,
        ),
    ],
    [
      'unsafe proposal bytes',
      () =>
        callUnsafe(
          'proposal',
          'content',
          'draft',
          'grounded-draft.v1',
          Number.MAX_SAFE_INTEGER + 1,
          1,
          0,
        ),
    ],
    [
      'fractional proposal claim count',
      () =>
        callUnsafe(
          'proposal',
          'content',
          'draft',
          'grounded-draft.v1',
          1,
          1.25,
          0,
        ),
    ],
    [
      'fractional structured repair count',
      () =>
        callUnsafe(
          'proposal',
          'content',
          'draft',
          'grounded-draft.v1',
          1,
          1,
          0.5,
        ),
    ],
    [
      'structured repair count above one',
      () =>
        callUnsafe(
          'proposal',
          'content',
          'draft',
          'grounded-draft.v1',
          1,
          1,
          2,
        ),
    ],
  ])('rejects unknown or unsafe %s values', (_label, invoke) => {
    expect(invoke).toThrow('ATOMIC_METRIC_INVALID');
  });

  it('accepts every exact reason and never serializes nearby sensitive values', () => {
    const points: AtomicMetricPoint[] = [];
    const recorder = new AtomicGroundingMetricsRecorder({
      record: (point) => points.push(point),
    });
    for (const reason of ATOMIC_GROUNDING_REASON_CODES) {
      recorder.failClosed('content', reason);
    }
    const nearby = {
      prompt: 'PROMPT_SECRET_123',
      claim_text: 'CLAIM_SECRET_123',
      evidence: 'EVIDENCE_SECRET_123',
      workflow_job_id: 'workflow-secret-id',
      project_id: 'project-secret-id',
      points,
    };
    const serializedPoints = JSON.stringify(nearby.points);

    expect(points).toHaveLength(ATOMIC_GROUNDING_REASON_CODES.length);
    expect(serializedPoints).not.toContain(nearby.prompt);
    expect(serializedPoints).not.toContain(nearby.claim_text);
    expect(serializedPoints).not.toContain(nearby.evidence);
    expect(serializedPoints).not.toContain(nearby.workflow_job_id);
    expect(serializedPoints).not.toContain(nearby.project_id);
  });
});

function callUnsafe(method: string, ...args: unknown[]): void {
  const recorder = new AtomicGroundingMetricsRecorder({ record: jest.fn() });
  (recorder as unknown as Record<string, (...values: unknown[]) => void>)[
    method
  ](...args);
}
