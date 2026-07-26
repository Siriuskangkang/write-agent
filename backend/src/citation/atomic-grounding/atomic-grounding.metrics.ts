import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ATOMIC_GROUNDING_REASON_CODES,
  GROUNDED_DRAFT_SCHEMA_VERSION,
  type AtomicGroundingReasonCode,
  type AtomicVerificationResult,
  type GroundedDraftProposal,
} from './contracts.js';

export type AtomicWorkflowType = 'content' | 'rewrite' | 'expand' | 'compress';

export type AtomicCounterName =
  | 'grounding_proposal_total'
  | 'grounding_claim_total'
  | 'grounding_fail_closed_total'
  | 'grounding_revision_total'
  | 'grounding_material_gap_total'
  | 'grounding_structured_repair_total';

export type AtomicHistogramName =
  | 'grounding_proposal_bytes'
  | 'grounding_proposal_claim_count'
  | 'grounding_render_latency_ms'
  | 'grounding_time_to_first_rendered_token_ms';

export interface AtomicMetricPoint {
  name: AtomicCounterName | AtomicHistogramName;
  kind: 'counter' | 'histogram';
  value: number;
  labels: Readonly<Record<string, string>>;
}

export interface AtomicGroundingMetricSink {
  record(point: AtomicMetricPoint): void;
}

export const ATOMIC_GROUNDING_METRIC_SINK = Symbol(
  'ATOMIC_GROUNDING_METRIC_SINK',
);

const WORKFLOW_TYPES = ['content', 'rewrite', 'expand', 'compress'] as const;
const PROPOSAL_STATUSES = ['draft', 'material_gap'] as const;
const METHODS = [
  'atomic_extract_exact',
  'atomic_typed_equivalent',
  'atomic_unsupported',
  'atomic_unverifiable',
] as const;
const VERDICTS = ['SUPPORTED', 'UNSUPPORTED', 'UNVERIFIABLE'] as const;
const REVISION_OUTCOMES = ['required', 'sealed', 'exhausted'] as const;

const COUNTER_NAMES = new Set<AtomicCounterName>([
  'grounding_proposal_total',
  'grounding_claim_total',
  'grounding_fail_closed_total',
  'grounding_revision_total',
  'grounding_material_gap_total',
  'grounding_structured_repair_total',
]);

const HISTOGRAM_BUCKETS: Readonly<
  Record<AtomicHistogramName, readonly number[]>
> = {
  grounding_proposal_bytes: [
    1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304,
  ],
  grounding_proposal_claim_count: [1, 5, 10, 25, 50, 100, 250, 500],
  grounding_render_latency_ms: [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000,
  ],
  grounding_time_to_first_rendered_token_ms: [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000,
  ],
};

const METRIC_LABEL_KEYS: Readonly<
  Record<AtomicMetricPoint['name'], readonly string[]>
> = {
  grounding_proposal_total: ['schema', 'status', 'workflow_type'],
  grounding_proposal_bytes: ['schema', 'status', 'workflow_type'],
  grounding_proposal_claim_count: ['schema', 'status', 'workflow_type'],
  grounding_structured_repair_total: ['schema', 'workflow_type'],
  grounding_claim_total: ['method', 'verdict', 'workflow_type'],
  grounding_fail_closed_total: ['reason', 'workflow_type'],
  grounding_revision_total: ['outcome'],
  grounding_material_gap_total: ['reason'],
  grounding_render_latency_ms: ['workflow_type'],
  grounding_time_to_first_rendered_token_ms: ['workflow_type'],
};

type HistogramAggregate = {
  count: number;
  sum: number;
  buckets: number[];
};

/**
 * The production sink for atomic-grounding rollout metrics. It is deliberately
 * in-memory: metrics are operational telemetry, never workflow/domain state.
 */
@Injectable()
export class AtomicGroundingPrometheusExporter implements AtomicGroundingMetricSink {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramAggregate>();

  record(point: AtomicMetricPoint): void {
    assertExportablePoint(point);
    const key = metricKey(point.name, point.labels);

    if (point.kind === 'counter') {
      this.counters.set(key, (this.counters.get(key) ?? 0) + point.value);
      return;
    }

    const buckets = histogramBuckets(point.name);
    const aggregate = this.histograms.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    aggregate.count += 1;
    aggregate.sum += point.value;
    buckets.forEach((boundary, index) => {
      if (point.value <= boundary) aggregate.buckets[index] += 1;
    });
    this.histograms.set(key, aggregate);
  }

  exposition(): string {
    const lines: string[] = [];
    for (const name of COUNTER_NAMES) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of this.counters) {
        const [metricName, labels] = parseMetricKey(key);
        if (metricName === name)
          lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }
    for (const [name, buckets] of Object.entries(HISTOGRAM_BUCKETS) as [
      AtomicHistogramName,
      readonly number[],
    ][]) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, aggregate] of this.histograms) {
        const [metricName, labels] = parseMetricKey(key);
        if (metricName !== name) continue;
        buckets.forEach((boundary, index) => {
          lines.push(
            `${name}_bucket${formatLabels({ ...labels, le: String(boundary) })} ${aggregate.buckets[index]}`,
          );
        });
        lines.push(
          `${name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${aggregate.count}`,
          `${name}_sum${formatLabels(labels)} ${aggregate.sum}`,
          `${name}_count${formatLabels(labels)} ${aggregate.count}`,
        );
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

@Injectable()
export class AtomicGroundingMetricsRecorder {
  constructor(
    @Optional()
    @Inject(ATOMIC_GROUNDING_METRIC_SINK)
    private readonly sink?: AtomicGroundingMetricSink,
  ) {}

  proposal(
    workflowType: AtomicWorkflowType,
    status: GroundedDraftProposal['status'],
    schema: typeof GROUNDED_DRAFT_SCHEMA_VERSION,
    bytes: number,
    claimCount: number,
    repairAttempts: number,
  ): void {
    closed(workflowType, WORKFLOW_TYPES);
    closed(status, PROPOSAL_STATUSES);
    closed(schema, [GROUNDED_DRAFT_SCHEMA_VERSION] as const);
    safeIntegerObservation(bytes);
    safeIntegerObservation(claimCount);
    repairObservation(repairAttempts);
    const labels = {
      schema,
      status,
      workflow_type: workflowType,
    } as const;
    this.record('grounding_proposal_total', 'counter', 1, labels);
    this.record('grounding_proposal_bytes', 'histogram', bytes, labels);
    this.record(
      'grounding_proposal_claim_count',
      'histogram',
      claimCount,
      labels,
    );
    this.record(
      'grounding_structured_repair_total',
      'counter',
      repairAttempts,
      {
        schema,
        workflow_type: workflowType,
      },
    );
  }

  claim(
    workflowType: AtomicWorkflowType,
    method: AtomicVerificationResult['claims'][number]['verification_method'],
    verdict: AtomicVerificationResult['claims'][number]['support_status'],
  ): void {
    closed(workflowType, WORKFLOW_TYPES);
    closed(method, METHODS);
    closed(verdict, VERDICTS);
    this.record('grounding_claim_total', 'counter', 1, {
      method,
      verdict,
      workflow_type: workflowType,
    });
  }

  failClosed(
    workflowType: AtomicWorkflowType,
    reason: AtomicGroundingReasonCode,
  ): void {
    closed(workflowType, WORKFLOW_TYPES);
    closed(reason, ATOMIC_GROUNDING_REASON_CODES);
    this.record('grounding_fail_closed_total', 'counter', 1, {
      reason,
      workflow_type: workflowType,
    });
  }

  revision(outcome: 'required' | 'sealed' | 'exhausted'): void {
    closed(outcome, REVISION_OUTCOMES);
    this.record('grounding_revision_total', 'counter', 1, { outcome });
  }

  materialGap(reason: AtomicGroundingReasonCode): void {
    closed(reason, ATOMIC_GROUNDING_REASON_CODES);
    this.record('grounding_material_gap_total', 'counter', 1, { reason });
  }

  renderLatency(workflowType: AtomicWorkflowType, milliseconds: number): void {
    closed(workflowType, WORKFLOW_TYPES);
    observation(milliseconds);
    this.record('grounding_render_latency_ms', 'histogram', milliseconds, {
      workflow_type: workflowType,
    });
  }

  firstRenderedToken(
    workflowType: AtomicWorkflowType,
    milliseconds: number,
  ): void {
    closed(workflowType, WORKFLOW_TYPES);
    observation(milliseconds);
    this.record(
      'grounding_time_to_first_rendered_token_ms',
      'histogram',
      milliseconds,
      { workflow_type: workflowType },
    );
  }

  private record(
    name: AtomicMetricPoint['name'],
    kind: AtomicMetricPoint['kind'],
    value: number,
    labels: Readonly<Record<string, string>>,
  ): void {
    observation(value);
    this.sink?.record({
      name,
      kind,
      value,
      labels: Object.freeze({ ...labels }),
    });
  }
}

function observation(value: number): void {
  if (!Number.isFinite(value) || value < 0) metricInvalid();
}

function safeIntegerObservation(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) metricInvalid();
}

function repairObservation(value: number): void {
  if (value !== 0 && value !== 1) metricInvalid();
}

function closed<T extends string>(
  value: unknown,
  values: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    metricInvalid();
  }
}

function metricInvalid(): never {
  throw new TypeError('ATOMIC_METRIC_INVALID');
}

function assertExportablePoint(point: AtomicMetricPoint): void {
  const isCounter = COUNTER_NAMES.has(point.name as AtomicCounterName);
  if (isCounter !== (point.kind === 'counter')) metricInvalid();
  observation(point.value);
  if (point.kind === 'counter') safeIntegerObservation(point.value);
  const expectedKeys = METRIC_LABEL_KEYS[point.name];
  const actualKeys = Object.keys(point.labels).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    metricInvalid();
  }
  for (const key of expectedKeys) assertLabelValue(key, point.labels[key]);
}

function assertLabelValue(key: string, value: string): void {
  if (
    (key === 'workflow_type' &&
      !WORKFLOW_TYPES.includes(value as AtomicWorkflowType)) ||
    (key === 'status' &&
      !PROPOSAL_STATUSES.includes(
        value as (typeof PROPOSAL_STATUSES)[number],
      )) ||
    (key === 'schema' && value !== GROUNDED_DRAFT_SCHEMA_VERSION) ||
    (key === 'method' &&
      !METHODS.includes(value as (typeof METHODS)[number])) ||
    (key === 'verdict' &&
      !VERDICTS.includes(value as (typeof VERDICTS)[number])) ||
    (key === 'reason' &&
      !ATOMIC_GROUNDING_REASON_CODES.includes(
        value as AtomicGroundingReasonCode,
      )) ||
    (key === 'outcome' &&
      !REVISION_OUTCOMES.includes(value as (typeof REVISION_OUTCOMES)[number]))
  ) {
    metricInvalid();
  }
}

function histogramBuckets(name: AtomicMetricPoint['name']): readonly number[] {
  if (!(name in HISTOGRAM_BUCKETS)) metricInvalid();
  return HISTOGRAM_BUCKETS[name as AtomicHistogramName];
}

function metricKey(
  name: AtomicMetricPoint['name'],
  labels: Readonly<Record<string, string>>,
): string {
  return JSON.stringify([
    name,
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function parseMetricKey(key: string): [string, Record<string, string>] {
  const [name, entries] = JSON.parse(key) as [string, [string, string][]];
  return [name, Object.fromEntries(entries)];
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 0
    ? ''
    : `{${entries.map(([key, value]) => `${key}="${value}"`).join(',')}}`;
}
