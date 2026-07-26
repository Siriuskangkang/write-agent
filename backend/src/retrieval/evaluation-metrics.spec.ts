import {
  aggregateEvaluation,
  evaluateRanking,
  evaluateRetrievalGate,
} from './evaluation-metrics.js';

describe('RAG evaluation metrics', () => {
  it('rejects duplicate ranking ids and duplicate judgments', () => {
    expect(() => evaluateRanking(['a', 'a'], ['a'], 8)).toThrow(
      'duplicate ranked chunk id',
    );
    expect(() => evaluateRanking(['a'], ['a', 'a'], 8)).toThrow(
      'duplicate relevant chunk id',
    );
  });

  it('always emits bounded relevance metrics', () => {
    const result = evaluateRanking(['a', 'b'], ['a'], 8);
    expect(result.recall_at_k).toBeGreaterThanOrEqual(0);
    expect(result.recall_at_k).toBeLessThanOrEqual(1);
    expect(result.ndcg_at_k).toBeGreaterThanOrEqual(0);
    expect(result.ndcg_at_k).toBeLessThanOrEqual(1);
    expect(result.context_precision).toBeGreaterThanOrEqual(0);
    expect(result.context_precision).toBeLessThanOrEqual(1);
  });
  it('computes Recall@K, nDCG and context precision from judged chunks', () => {
    const metrics = evaluateRanking(
      ['relevant-a', 'irrelevant', 'relevant-b'],
      ['relevant-a', 'relevant-b'],
      3,
    );

    expect(metrics.recall_at_k).toBe(1);
    expect(metrics.context_precision).toBeCloseTo(2 / 3);
    expect(metrics.ndcg_at_k).toBeGreaterThan(0.9);
    expect(metrics.ndcg_at_k).toBeLessThan(1);
  });

  it('aggregates latency p95 and explicit embedding/reranker cost', () => {
    const summary = aggregateEvaluation([
      {
        recall_at_k: 1,
        ndcg_at_k: 0.9,
        context_precision: 0.8,
        latency_ms: 100,
        cost_usd: 0.001,
      },
      {
        recall_at_k: 0.5,
        ndcg_at_k: 0.4,
        context_precision: 0.3,
        latency_ms: 400,
        cost_usd: 0.002,
      },
    ]);

    expect(summary).toMatchObject({
      recall_at_k: 0.75,
      ndcg_at_k: 0.65,
      context_precision: 0.55,
      latency_p95_ms: 400,
      cost_usd: 0.003,
    });
  });

  it('passes only when hybrid relevance is not worse and latency is in budget', () => {
    expect(
      evaluateRetrievalGate(
        { recall_at_k: 0.8, ndcg_at_k: 0.7 },
        { recall_at_k: 0.8, ndcg_at_k: 0.75, latency_p95_ms: 450 },
        { max_latency_p95_ms: 500 },
      ),
    ).toEqual({
      relevance_not_worse: true,
      latency_within_budget: true,
      passed: true,
    });
    expect(
      evaluateRetrievalGate(
        { recall_at_k: 0.8, ndcg_at_k: 0.7 },
        { recall_at_k: 0.79, ndcg_at_k: 0.75, latency_p95_ms: 450 },
        { max_latency_p95_ms: 500 },
      ).passed,
    ).toBe(false);
  });
});
