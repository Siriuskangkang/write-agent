export interface RankingMetrics {
  recall_at_k: number;
  ndcg_at_k: number;
  context_precision: number;
}

export interface EvaluationSampleMetrics extends RankingMetrics {
  latency_ms: number;
  cost_usd: number;
}

export interface EvaluationSummary extends RankingMetrics {
  latency_p95_ms: number;
  cost_usd: number;
}

export function evaluateRanking(
  rankedChunkIds: string[],
  relevantChunkIds: string[],
  k: number,
): RankingMetrics {
  assertUnique(rankedChunkIds, 'ranked');
  assertUnique(relevantChunkIds, 'relevant');
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new Error('k must be a positive integer');
  }
  const relevant = new Set(relevantChunkIds);
  const ranked = rankedChunkIds.slice(0, k);
  const hits = ranked.filter((id) => relevant.has(id));
  const recall =
    relevant.size === 0
      ? ranked.length === 0
        ? 1
        : 0
      : new Set(hits).size / relevant.size;
  const dcg = ranked.reduce(
    (sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(relevant.size, k);
  const idealDcg = Array.from({ length: idealCount }).reduce<number>(
    (sum, _unused, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return {
    recall_at_k: bounded(recall),
    ndcg_at_k: bounded(idealDcg === 0 ? 1 : dcg / idealDcg),
    context_precision:
      ranked.length === 0
        ? relevant.size === 0
          ? 1
          : 0
        : bounded(hits.length / ranked.length),
  };
}

export function aggregateEvaluation(
  samples: EvaluationSampleMetrics[],
): EvaluationSummary {
  if (samples.length === 0) {
    return {
      recall_at_k: 0,
      ndcg_at_k: 0,
      context_precision: 0,
      latency_p95_ms: 0,
      cost_usd: 0,
    };
  }
  const sortedLatency = samples
    .map((sample) => sample.latency_ms)
    .sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(sortedLatency.length * 0.95) - 1);
  return {
    recall_at_k: average(samples.map((sample) => sample.recall_at_k)),
    ndcg_at_k: average(samples.map((sample) => sample.ndcg_at_k)),
    context_precision: average(
      samples.map((sample) => sample.context_precision),
    ),
    latency_p95_ms: sortedLatency[p95Index],
    cost_usd: samples.reduce((sum, sample) => sum + sample.cost_usd, 0),
  };
}

export function evaluateRetrievalGate(
  legacy: Pick<EvaluationSummary, 'recall_at_k' | 'ndcg_at_k'>,
  hybrid: Pick<
    EvaluationSummary,
    'recall_at_k' | 'ndcg_at_k' | 'latency_p95_ms'
  >,
  thresholds: { max_latency_p95_ms: number },
): {
  relevance_not_worse: boolean;
  latency_within_budget: boolean;
  passed: boolean;
} {
  const relevanceNotWorse =
    hybrid.recall_at_k >= legacy.recall_at_k &&
    hybrid.ndcg_at_k >= legacy.ndcg_at_k;
  const latencyWithinBudget =
    hybrid.latency_p95_ms <= thresholds.max_latency_p95_ms;
  return {
    relevance_not_worse: relevanceNotWorse,
    latency_within_budget: latencyWithinBudget,
    passed: relevanceNotWorse && latencyWithinBudget,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`duplicate ${label} chunk id: ${value}`);
    }
    seen.add(value);
  }
}

function bounded(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`evaluation metric out of bounds: ${String(value)}`);
  }
  return value;
}
