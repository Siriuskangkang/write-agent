import { createHash, createHmac } from 'node:crypto';
import { buildEvidenceContext } from './context-builder.js';
import {
  aggregateEvaluation,
  evaluateRanking,
  evaluateRetrievalGate,
  type EvaluationSampleMetrics,
} from './evaluation-metrics.js';
import { reciprocalRankFusion } from './fusion.js';
import { planRetrievalQuery } from './query-planner.js';
import type { FusedCandidate, RetrievalCandidate } from './types.js';
import type { LegacyRetrieverPort } from './types.js';
import type { HybridRetriever } from './hybrid-retriever.js';

export interface RetrievalEvaluationDataset {
  dataset: string;
  k: number;
  corpus: Array<{
    chunk_id: string;
    file_id: string;
    content: string;
    heading_path?: string[];
  }>;
  judgments: Array<{
    id: string;
    query: string;
    relevant_chunk_ids: string[];
  }>;
}

export interface EvaluationBinding {
  code_commit: string;
  index_version: string;
  collection_name: string;
  embedding_model: string;
  embedding_dimension: number;
  retrieval_config_hash: string;
  generated_at: string;
  expires_at: string;
}

export interface EvaluationTrace {
  sample_id: string;
  query: string;
  relevant_chunk_ids: string[];
  legacy: {
    ranked_chunk_ids: string[];
    latency_ms: number;
    cost_usd: number;
  };
  hybrid: {
    ranked_chunk_ids: string[];
    sparse_ranked_chunk_ids: string[];
    dense_ranked_chunk_ids: string[];
    latency_ms: number;
    cost_usd: number;
  };
}

export interface EvaluationPipeline {
  readonly source: 'mysql-qdrant-production-v1' | 'offline-deterministic-v1';
  ingest(corpus: RetrievalEvaluationDataset['corpus']): Promise<void>;
  retrieveLegacy(
    query: string,
    k: number,
  ): Promise<{
    ranked_chunk_ids: string[];
    latency_ms: number;
    cost_usd: number;
  }>;
  retrieveHybrid(
    query: string,
    k: number,
  ): Promise<{
    ranked_chunk_ids: string[];
    sparse_ranked_chunk_ids: string[];
    dense_ranked_chunk_ids: string[];
    latency_ms: number;
    cost_usd: number;
  }>;
}

export interface EvaluationCorpusIndexer {
  replaceCorpus(corpus: RetrievalEvaluationDataset['corpus']): Promise<void>;
}

/**
 * Production evaluation adapter. Its collaborators are the real MySQL
 * FULLTEXT, Qdrant dense and legacy ports, while the indexer writes the fixed
 * corpus through the same ingestion/indexing path used by the application.
 */
export class MysqlQdrantEvaluationPipeline implements EvaluationPipeline {
  readonly source = 'mysql-qdrant-production-v1' as const;

  constructor(
    private readonly projectId: string,
    private readonly indexer: EvaluationCorpusIndexer,
    private readonly hybrid: HybridRetriever,
    private readonly legacy: LegacyRetrieverPort,
  ) {}

  ingest(corpus: RetrievalEvaluationDataset['corpus']): Promise<void> {
    return this.indexer.replaceCorpus(corpus);
  }

  async retrieveLegacy(query: string, k: number) {
    const startedAt = performance.now();
    const plan = planRetrievalQuery({ query, task_type: 'content' });
    const candidates = await this.legacy.search({
      project_id: this.projectId,
      terms: plan.terms,
      limit: k,
    });
    return {
      ranked_chunk_ids: candidates.map((item) => item.chunk_id),
      latency_ms: Math.max(1, Math.ceil(performance.now() - startedAt)),
      cost_usd: 0,
    };
  }

  async retrieveHybrid(query: string, k: number) {
    const startedAt = performance.now();
    const result = await this.hybrid.retrieve({
      project_id: this.projectId,
      query,
      task_type: 'content',
      top_k: k,
      token_budget: 6_000,
      mode: 'hybrid',
      gate_decision: true,
    });
    if (result.state === 'ERROR' || result.state === 'DEGRADED') {
      throw new Error(
        `Production hybrid retrieval unavailable: ${result.error_code ?? 'unknown'}`,
      );
    }
    return {
      ranked_chunk_ids: result.evidence.map((item) => item.chunk_id),
      sparse_ranked_chunk_ids: result.sparse_ranked_chunk_ids ?? [],
      dense_ranked_chunk_ids: result.dense_ranked_chunk_ids ?? [],
      latency_ms: Math.max(1, Math.ceil(performance.now() - startedAt)),
      cost_usd: Number(result.embedding_cost_usd ?? 0),
    };
  }
}

export async function runEvaluation(
  dataset: RetrievalEvaluationDataset,
  pipeline: EvaluationPipeline,
  thresholds: {
    max_latency_p95_ms: number;
    min_positive_judgments?: number;
  },
  binding: EvaluationBinding,
) {
  const positiveJudgmentCount = validateDataset(
    dataset,
    thresholds.min_positive_judgments ?? dataset.judgments.length,
  );
  validateBinding(binding);
  await pipeline.ingest(dataset.corpus);
  const traces: EvaluationTrace[] = [];
  for (const judgment of dataset.judgments) {
    const [legacy, hybrid] = await Promise.all([
      pipeline.retrieveLegacy(judgment.query, dataset.k),
      pipeline.retrieveHybrid(judgment.query, dataset.k),
    ]);
    evaluateRanking(
      legacy.ranked_chunk_ids,
      judgment.relevant_chunk_ids,
      dataset.k,
    );
    evaluateRanking(
      hybrid.ranked_chunk_ids,
      judgment.relevant_chunk_ids,
      dataset.k,
    );
    traces.push({
      sample_id: judgment.id,
      query: judgment.query,
      relevant_chunk_ids: [...judgment.relevant_chunk_ids],
      legacy,
      hybrid,
    });
  }
  const legacy = aggregateEvaluation(
    traces.map((trace, index) =>
      sampleMetrics(
        trace.legacy,
        dataset.judgments[index]?.relevant_chunk_ids ?? [],
        dataset.k,
      ),
    ),
  );
  const hybrid = aggregateEvaluation(
    traces.map((trace, index) =>
      sampleMetrics(
        trace.hybrid,
        dataset.judgments[index]?.relevant_chunk_ids ?? [],
        dataset.k,
      ),
    ),
  );
  const payload = {
    schema_version: 'rag-eval-v2' as const,
    generated_at: binding.generated_at,
    expires_at: binding.expires_at,
    dataset: dataset.dataset,
    dataset_digest: datasetDigest(dataset),
    sample_count: dataset.judgments.length,
    positive_judgment_count: positiveJudgmentCount,
    k: dataset.k,
    source: pipeline.source,
    binding: {
      code_commit: binding.code_commit,
      index_version: binding.index_version,
      collection_name: binding.collection_name,
      embedding_model: binding.embedding_model,
      embedding_dimension: binding.embedding_dimension,
      retrieval_config_hash: binding.retrieval_config_hash,
    },
    traces,
    legacy,
    hybrid,
    gate_observation: evaluateRetrievalGate(legacy, hybrid, thresholds),
  };
  return payload;
}

export function signEvaluationPayload(
  payload: object,
  secret: string,
): { payload: object; signature: string } {
  if (secret.length < 32) {
    throw new Error(
      'RAG evaluation HMAC secret must be at least 32 characters',
    );
  }
  return {
    payload,
    signature: createHmac('sha256', secret)
      .update(stableJson(payload))
      .digest('hex'),
  };
}

export function datasetDigest(dataset: RetrievalEvaluationDataset): string {
  return createHash('sha256').update(stableJson(dataset)).digest('hex');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic offline evaluator that executes the same query planning, RRF
 * and context selection functions as production. The corpus is ingested and
 * embedded during the run; fixtures never contain result rankings.
 */
export class ProductionEvaluationPipeline implements EvaluationPipeline {
  readonly source = 'offline-deterministic-v1' as const;
  private corpus: RetrievalEvaluationDataset['corpus'] = [];
  private vectors = new Map<string, number[]>();

  constructor(
    private readonly dimension: number,
    private readonly costPerMillionUsd = 0,
  ) {}

  ingest(corpus: RetrievalEvaluationDataset['corpus']): Promise<void> {
    this.corpus = corpus.map((item) => ({ ...item }));
    this.vectors = new Map(
      corpus.map((item) => [
        item.chunk_id,
        embed(item.content, this.dimension),
      ]),
    );
    return Promise.resolve();
  }

  retrieveLegacy(query: string, k: number) {
    const startedAt = performance.now();
    const terms = planRetrievalQuery({
      query,
      task_type: 'content',
    }).terms;
    const ranked = this.corpus
      .map((item) => ({
        id: item.chunk_id,
        score: lexicalScore(item.content, terms),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.id.localeCompare(right.id),
      )
      .slice(0, k)
      .map((item) => item.id);
    return Promise.resolve({
      ranked_chunk_ids: ranked,
      latency_ms: Math.max(1, Math.ceil(performance.now() - startedAt)),
      cost_usd: 0,
    });
  }

  retrieveHybrid(query: string, k: number) {
    const startedAt = performance.now();
    const plan = planRetrievalQuery({ query, task_type: 'content' });
    const sparse = this.corpus
      .map((item) =>
        toCandidate(item, lexicalScore(item.content, plan.terms), 'sparse'),
      )
      .filter((item) => item.source_score > 0)
      .sort(candidateOrder)
      .slice(0, 40);
    const queryVector = embed(plan.dense_query, this.dimension);
    const dense = this.corpus
      .map((item) => {
        const vector = this.vectors.get(item.chunk_id) ?? [];
        return {
          ...toCandidate(item, cosine(queryVector, vector), 'dense'),
          embedding: vector,
        };
      })
      .sort(candidateOrder)
      .slice(0, 40);
    const fused = reciprocalRankFusion(sparse, dense).map((item, index) => ({
      ...item,
      rerank_score: item.fusion_score,
      rerank_rank: index + 1,
    })) as FusedCandidate[];
    const context = buildEvidenceContext(fused, {
      top_k: k,
      token_budget: 6_000,
      max_per_source: 2,
      query_embedding: queryVector,
      query_terms: plan.terms,
    });
    const inputTokens = Math.max(1, Math.ceil(plan.dense_query.length / 2));
    return Promise.resolve({
      ranked_chunk_ids: context.items.map((item) => item.chunk_id),
      sparse_ranked_chunk_ids: sparse.map((item) => item.chunk_id),
      dense_ranked_chunk_ids: dense.map((item) => item.chunk_id),
      latency_ms: Math.max(1, Math.ceil(performance.now() - startedAt)),
      cost_usd: (inputTokens * this.costPerMillionUsd) / 1_000_000,
    });
  }
}

function sampleMetrics(
  result: { ranked_chunk_ids: string[]; latency_ms: number; cost_usd: number },
  relevantChunkIds: string[],
  k: number,
): EvaluationSampleMetrics {
  return {
    ...evaluateRanking(result.ranked_chunk_ids, relevantChunkIds, k),
    latency_ms: result.latency_ms,
    cost_usd: result.cost_usd,
  };
}

function validateDataset(
  dataset: RetrievalEvaluationDataset,
  minPositiveJudgments: number,
): number {
  if (!dataset.dataset.trim()) throw new Error('dataset is required');
  if (!Number.isSafeInteger(dataset.k) || dataset.k < 1) {
    throw new Error('k must be a positive integer');
  }
  if (dataset.corpus.length === 0 || dataset.judgments.length === 0) {
    throw new Error('evaluation corpus and judgments are required');
  }
  const corpusIds = new Set<string>();
  for (const item of dataset.corpus) {
    if (
      !item.chunk_id ||
      corpusIds.has(item.chunk_id) ||
      !item.content.trim()
    ) {
      throw new Error(`duplicate or invalid corpus chunk: ${item.chunk_id}`);
    }
    corpusIds.add(item.chunk_id);
  }
  const sampleIds = new Set<string>();
  let positiveJudgmentCount = 0;
  for (const judgment of dataset.judgments) {
    if (!judgment.id || sampleIds.has(judgment.id) || !judgment.query.trim()) {
      throw new Error(`duplicate or invalid judgment: ${judgment.id}`);
    }
    sampleIds.add(judgment.id);
    if (judgment.relevant_chunk_ids.length === 0) {
      throw new Error(
        `judgment ${judgment.id} must include at least one relevant chunk`,
      );
    }
    evaluateRanking([], judgment.relevant_chunk_ids, dataset.k);
    positiveJudgmentCount += judgment.relevant_chunk_ids.length;
    for (const relevant of judgment.relevant_chunk_ids) {
      if (!corpusIds.has(relevant)) {
        throw new Error(
          `judgment ${judgment.id} references unknown chunk ${relevant}`,
        );
      }
    }
  }
  if (!Number.isSafeInteger(minPositiveJudgments) || minPositiveJudgments < 1) {
    throw new Error('minimum positive relevance judgments must be positive');
  }
  if (positiveJudgmentCount < minPositiveJudgments) {
    throw new Error(
      `evaluation has ${positiveJudgmentCount} positive relevance judgments, requires ${minPositiveJudgments}`,
    );
  }
  return positiveJudgmentCount;
}

function validateBinding(binding: EvaluationBinding): void {
  if (
    !binding.code_commit ||
    !binding.index_version ||
    !binding.collection_name ||
    !binding.embedding_model ||
    !binding.retrieval_config_hash ||
    !Number.isSafeInteger(binding.embedding_dimension) ||
    binding.embedding_dimension < 1
  ) {
    throw new Error('evaluation binding is incomplete');
  }
  const generated = Date.parse(binding.generated_at);
  const expires = Date.parse(binding.expires_at);
  if (
    !Number.isFinite(generated) ||
    !Number.isFinite(expires) ||
    expires <= generated
  ) {
    throw new Error('evaluation binding timestamps are invalid');
  }
}

function toCandidate(
  item: RetrievalEvaluationDataset['corpus'][number],
  score: number,
  source: 'sparse' | 'dense',
): RetrievalCandidate {
  return {
    chunk_id: item.chunk_id,
    project_id: 'evaluation-project',
    file_id: item.file_id,
    document_id: `evaluation:${item.file_id}`,
    ingestion_key: 'evaluation-ingestion',
    content: item.content,
    section_title: item.heading_path?.at(-1) ?? null,
    heading_path: item.heading_path ?? [],
    page_start: null,
    page_end: null,
    char_start: 0,
    char_end: item.content.length,
    position: 0,
    token_count: Math.max(1, Math.ceil(item.content.length / 2)),
    source,
    source_score: score,
  };
}

function candidateOrder(
  left: RetrievalCandidate,
  right: RetrievalCandidate,
): number {
  return (
    right.source_score - left.source_score ||
    left.chunk_id.localeCompare(right.chunk_id)
  );
}

function lexicalScore(content: string, terms: string[]): number {
  const normalized = content.toLowerCase();
  return terms.reduce(
    (sum, term) => sum + (normalized.includes(term.toLowerCase()) ? 1 : 0),
    0,
  );
}

function embed(input: string, dimension: number): number[] {
  const vector = Array.from({ length: dimension }, () => 0);
  const normalized = input.replace(/\s+/g, '').toLowerCase();
  const tokens = Array.from(normalized).flatMap((char, index, chars) => [
    char,
    `${char}${chars[index + 1] ?? ''}`,
  ]);
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % dimension;
    vector[index] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}
