import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stableJson } from './evaluation-runner.js';
import {
  aggregateEvaluation,
  evaluateRanking,
  type EvaluationSampleMetrics,
  type EvaluationSummary,
} from './evaluation-metrics.js';

interface EvaluationTrace {
  sample_id: string;
  query: string;
  relevant_chunk_ids: string[];
  legacy: EvaluationTraceResult;
  hybrid: EvaluationTraceResult & {
    sparse_ranked_chunk_ids: string[];
    dense_ranked_chunk_ids: string[];
  };
}

interface EvaluationTraceResult {
  ranked_chunk_ids: string[];
  latency_ms: number;
  cost_usd: number;
}

interface EvaluationPayload {
  schema_version: 'rag-eval-v2';
  generated_at: string;
  expires_at: string;
  dataset_digest: string;
  sample_count: number;
  positive_judgment_count: number;
  k: number;
  source: string;
  binding: {
    code_commit: string;
    index_version: string;
    collection_name: string;
    embedding_model: string;
    embedding_dimension: number;
    retrieval_config_hash: string;
  };
  traces: EvaluationTrace[];
  legacy: EvaluationSummary;
  hybrid: EvaluationSummary;
}

interface AttestedArtifact {
  payload: EvaluationPayload;
  signature: string;
}

export interface EvaluationGateDecision {
  allowed: boolean;
  code: string;
  detail: string;
}

@Injectable()
export class RagEvaluationGate implements OnModuleInit {
  private readonly logger = new Logger(RagEvaluationGate.name);
  private readonly reportPath: string | null;
  private readonly allowedDirectory: string | null;
  private readonly artifactDigest: string | null;
  private readonly hmacSecret: string | null;
  private readonly datasetDigest: string | null;
  private readonly codeCommit: string | null;
  private readonly indexVersion: string;
  private readonly collection: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimension: number;
  private readonly configHash: string | null;
  private readonly minSamples: number;
  private readonly minPositiveJudgments: number;
  private readonly maxLatencyP95Ms: number;
  private readonly maxArtifactAgeMs: number;
  private readonly maxArtifactTtlMs: number;
  private readonly futureSkewMs: number;
  private readonly mode: string;

  lastDecision: EvaluationGateDecision = {
    allowed: false,
    code: 'NOT_EVALUATED',
    detail: 'Evaluation gate has not run',
  };

  constructor(config: ConfigService) {
    this.reportPath = text(config.get('RAG_EVALUATION_REPORT'));
    this.allowedDirectory = text(config.get('RAG_EVALUATION_DIR'));
    this.artifactDigest = text(config.get('RAG_EVALUATION_ARTIFACT_SHA256'));
    this.hmacSecret = text(config.get('RAG_EVALUATION_HMAC_SECRET'));
    this.datasetDigest = text(config.get('RAG_EVALUATION_DATASET_DIGEST'));
    this.codeCommit = text(config.get('RAG_CODE_COMMIT'));
    this.indexVersion = String(config.get('RAG_INDEX_VERSION', 'rag-v1'));
    this.collection = String(
      config.get('QDRANT_COLLECTION', 'write_agent_chunks'),
    );
    this.embeddingModel = String(
      config.get('EMBEDDING_MODEL', 'text-embedding-3-small'),
    );
    this.embeddingDimension = positive(
      config.get('EMBEDDING_DIMENSION', 1536),
      1536,
    );
    this.configHash = text(config.get('RAG_RETRIEVAL_CONFIG_HASH'));
    this.minSamples = positive(
      config.get('RAG_EVALUATION_MIN_SAMPLES', 20),
      20,
    );
    this.minPositiveJudgments = positive(
      config.get('RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS', this.minSamples),
      this.minSamples,
    );
    this.maxLatencyP95Ms = positive(
      config.get('RAG_MAX_LATENCY_P95_MS', 500),
      500,
    );
    this.maxArtifactAgeMs =
      positive(config.get('RAG_EVALUATION_MAX_AGE_HOURS', 48), 48) *
      60 *
      60_000;
    this.maxArtifactTtlMs =
      positive(config.get('RAG_EVALUATION_MAX_TTL_HOURS', 168), 168) *
      60 *
      60_000;
    this.futureSkewMs =
      positive(config.get('RAG_EVALUATION_FUTURE_SKEW_SECONDS', 300), 300) *
      1_000;
    this.mode = String(config.get('RETRIEVAL_MODE', 'shadow'));
  }

  onModuleInit(): void {
    if (this.mode !== 'hybrid') return;
    void this.canUseHybrid().then((allowed) => {
      const message = `Hybrid retrieval gate ${allowed ? 'allowed' : 'denied'}: ${this.lastDecision.code} (${this.lastDecision.detail})`;
      if (allowed) this.logger.log(message);
      else this.logger.warn(message);
    });
  }

  async canUseHybrid(): Promise<boolean> {
    try {
      this.requireConfiguration();
      const reportPath = resolve(this.reportPath as string);
      const allowedDirectory = await realpath(
        resolve(this.allowedDirectory as string),
      );
      const reportStat = await lstat(reportPath);
      if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
        return this.deny(
          'ARTIFACT_NOT_REGULAR',
          'Artifact must be a regular non-symlink file',
        );
      }
      const canonicalReport = await realpath(reportPath);
      const pathWithinAllowed = relative(allowedDirectory, canonicalReport);
      if (
        pathWithinAllowed === '' ||
        pathWithinAllowed === '..' ||
        pathWithinAllowed.startsWith(`..${pathSeparator()}`) ||
        isAbsolute(pathWithinAllowed)
      ) {
        return this.deny(
          'ARTIFACT_PATH_DENIED',
          'Artifact path is outside the allowed directory',
        );
      }
      const raw = await readFile(canonicalReport);
      const digest = createHash('sha256').update(raw).digest('hex');
      if (!safeEqual(digest, this.artifactDigest as string)) {
        return this.deny(
          'ARTIFACT_DIGEST_MISMATCH',
          'Artifact SHA-256 does not match runtime configuration',
        );
      }
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isAttestationEnvelope(parsed)) {
        return this.deny(
          'ARTIFACT_SCHEMA_INVALID',
          'Artifact envelope is invalid',
        );
      }
      const expectedSignature = createHmac('sha256', this.hmacSecret as string)
        .update(stableJson(parsed.payload))
        .digest('hex');
      if (!safeEqual(expectedSignature, parsed.signature)) {
        return this.deny(
          'ATTESTATION_INVALID',
          'Artifact HMAC signature is invalid',
        );
      }
      const payloadError = validateEvaluationPayload(parsed.payload);
      if (payloadError) {
        return this.deny('ARTIFACT_SCHEMA_INVALID', payloadError);
      }
      const bindingError = this.validateBinding(parsed.payload);
      if (bindingError) return this.deny('BINDING_MISMATCH', bindingError);
      const now = Date.now();
      const generatedAt = Date.parse(parsed.payload.generated_at);
      const expiresAt = Date.parse(parsed.payload.expires_at);
      if (
        !Number.isFinite(generatedAt) ||
        !Number.isFinite(expiresAt) ||
        generatedAt > now + this.futureSkewMs ||
        now - generatedAt > this.maxArtifactAgeMs ||
        expiresAt <= generatedAt ||
        expiresAt - generatedAt > this.maxArtifactTtlMs ||
        expiresAt <= now
      ) {
        return this.deny(
          'ARTIFACT_EXPIRED',
          'Artifact timestamps are invalid or expired',
        );
      }
      if (parsed.payload.sample_count < this.minSamples) {
        return this.deny(
          'SAMPLE_COUNT_INSUFFICIENT',
          `Artifact has ${parsed.payload.sample_count} samples, requires ${this.minSamples}`,
        );
      }
      if (parsed.payload.positive_judgment_count < this.minPositiveJudgments) {
        return this.deny(
          'POSITIVE_JUDGMENT_COUNT_INSUFFICIENT',
          `Artifact has ${parsed.payload.positive_judgment_count} positive judgments, requires ${this.minPositiveJudgments}`,
        );
      }
      const relevanceNotWorse =
        parsed.payload.hybrid.recall_at_k >=
          parsed.payload.legacy.recall_at_k &&
        parsed.payload.hybrid.ndcg_at_k >= parsed.payload.legacy.ndcg_at_k;
      if (!relevanceNotWorse) {
        return this.deny(
          'RELEVANCE_REGRESSION',
          'Hybrid relevance is worse than legacy',
        );
      }
      if (parsed.payload.hybrid.latency_p95_ms > this.maxLatencyP95Ms) {
        return this.deny(
          'LATENCY_BUDGET_EXCEEDED',
          `Hybrid p95 ${parsed.payload.hybrid.latency_p95_ms}ms exceeds current ${this.maxLatencyP95Ms}ms budget`,
        );
      }
      this.lastDecision = {
        allowed: true,
        code: 'ATTESTATION_VALID',
        detail: 'Artifact signature, binding, freshness and metrics passed',
      };
      return true;
    } catch (error) {
      return this.deny(
        'ARTIFACT_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private requireConfiguration(): void {
    const missing = [
      ['RAG_EVALUATION_REPORT', this.reportPath],
      ['RAG_EVALUATION_DIR', this.allowedDirectory],
      ['RAG_EVALUATION_ARTIFACT_SHA256', this.artifactDigest],
      ['RAG_EVALUATION_HMAC_SECRET', this.hmacSecret],
      ['RAG_EVALUATION_DATASET_DIGEST', this.datasetDigest],
      ['RAG_CODE_COMMIT', this.codeCommit],
      ['RAG_RETRIEVAL_CONFIG_HASH', this.configHash],
    ]
      .filter((entry) => !entry[1])
      .map((entry) => entry[0]);
    if (missing.length > 0) {
      throw new Error(
        `Missing hybrid gate configuration: ${missing.join(', ')}`,
      );
    }
    if ((this.hmacSecret as string).length < 32) {
      throw new Error(
        'RAG_EVALUATION_HMAC_SECRET must be at least 32 characters',
      );
    }
  }

  private validateBinding(payload: EvaluationPayload): string | null {
    const expected: Record<string, string | number> = {
      dataset_digest: this.datasetDigest as string,
      code_commit: this.codeCommit as string,
      index_version: this.indexVersion,
      collection_name: this.collection,
      embedding_model: this.embeddingModel,
      embedding_dimension: this.embeddingDimension,
      retrieval_config_hash: this.configHash as string,
    };
    const actual: Record<string, string | number> = {
      dataset_digest: payload.dataset_digest,
      ...payload.binding,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        return `${key} does not match current runtime`;
      }
    }
    if (payload.source !== 'mysql-qdrant-production-v1') {
      return 'artifact source is not the MySQL and Qdrant production pipeline';
    }
    return null;
  }

  private deny(code: string, detail: string): false {
    this.lastDecision = { allowed: false, code, detail };
    return false;
  }
}

function isAttestationEnvelope(value: unknown): value is AttestedArtifact {
  if (!value || typeof value !== 'object') return false;
  const artifact = value as Partial<AttestedArtifact>;
  return (
    typeof artifact.signature === 'string' &&
    /^[a-f0-9]{64}$/u.test(artifact.signature) &&
    artifact.payload !== null &&
    typeof artifact.payload === 'object'
  );
}

function validateEvaluationPayload(value: unknown): string | null {
  const payload = value as Partial<EvaluationPayload>;
  if (
    payload?.schema_version !== 'rag-eval-v2' ||
    typeof payload.generated_at !== 'string' ||
    typeof payload.expires_at !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(payload.dataset_digest ?? '') ||
    !Number.isSafeInteger(payload.sample_count) ||
    (payload.sample_count ?? 0) < 1 ||
    !Number.isSafeInteger(payload.positive_judgment_count) ||
    (payload.positive_judgment_count ?? 0) < 1 ||
    !Number.isSafeInteger(payload.k) ||
    (payload.k ?? 0) < 1 ||
    (payload.source !== 'mysql-qdrant-production-v1' &&
      payload.source !== 'offline-deterministic-v1') ||
    typeof payload.binding?.code_commit !== 'string' ||
    typeof payload.binding?.index_version !== 'string' ||
    typeof payload.binding?.collection_name !== 'string' ||
    typeof payload.binding?.embedding_model !== 'string' ||
    !Number.isSafeInteger(payload.binding?.embedding_dimension) ||
    typeof payload.binding?.retrieval_config_hash !== 'string' ||
    !Array.isArray(payload.traces) ||
    !isSummary(payload.legacy) ||
    !isSummary(payload.hybrid)
  ) {
    return 'Artifact schema or metrics are invalid';
  }
  if (payload.sample_count !== payload.traces.length) {
    return 'sample_count must equal the number of traces';
  }
  const sampleIds = new Set<string>();
  const legacySamples: EvaluationSampleMetrics[] = [];
  const hybridSamples: EvaluationSampleMetrics[] = [];
  let positiveJudgmentCount = 0;
  const k = payload.k as number;
  for (const trace of payload.traces) {
    if (
      !trace ||
      typeof trace.sample_id !== 'string' ||
      !trace.sample_id ||
      sampleIds.has(trace.sample_id) ||
      typeof trace.query !== 'string' ||
      !trace.query.trim() ||
      !validPositiveIdList(trace.relevant_chunk_ids) ||
      !validTraceResult(trace.legacy) ||
      !validTraceResult(trace.hybrid) ||
      !validIdList(trace.hybrid.sparse_ranked_chunk_ids) ||
      !validIdList(trace.hybrid.dense_ranked_chunk_ids)
    ) {
      return `Trace ${trace?.sample_id ?? 'unknown'} is invalid`;
    }
    sampleIds.add(trace.sample_id);
    positiveJudgmentCount += trace.relevant_chunk_ids.length;
    try {
      legacySamples.push({
        ...evaluateRanking(
          trace.legacy.ranked_chunk_ids,
          trace.relevant_chunk_ids,
          k,
        ),
        latency_ms: trace.legacy.latency_ms,
        cost_usd: trace.legacy.cost_usd,
      });
      hybridSamples.push({
        ...evaluateRanking(
          trace.hybrid.ranked_chunk_ids,
          trace.relevant_chunk_ids,
          k,
        ),
        latency_ms: trace.hybrid.latency_ms,
        cost_usd: trace.hybrid.cost_usd,
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (payload.positive_judgment_count !== positiveJudgmentCount) {
    return 'positive_judgment_count must match trace judgments';
  }
  if (!sameSummary(payload.legacy, aggregateEvaluation(legacySamples))) {
    return 'Legacy aggregate does not match trace metrics';
  }
  if (!sameSummary(payload.hybrid, aggregateEvaluation(hybridSamples))) {
    return 'Hybrid aggregate does not match trace metrics';
  }
  return null;
}

function validIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function validPositiveIdList(value: unknown): value is string[] {
  return validIdList(value) && value.length > 0;
}

function validTraceResult(value: unknown): value is EvaluationTraceResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<EvaluationTraceResult>;
  return (
    validIdList(result.ranked_chunk_ids) &&
    isNonNegative(result.latency_ms) &&
    isNonNegative(result.cost_usd)
  );
}

function isSummary(value: unknown): value is EvaluationSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<EvaluationSummary>;
  return (
    isUnitMetric(summary.recall_at_k) &&
    isUnitMetric(summary.ndcg_at_k) &&
    isUnitMetric(summary.context_precision) &&
    isNonNegative(summary.latency_p95_ms) &&
    isNonNegative(summary.cost_usd)
  );
}

function sameSummary(
  actual: EvaluationSummary,
  expected: EvaluationSummary,
): boolean {
  return (
    close(actual.recall_at_k, expected.recall_at_k) &&
    close(actual.ndcg_at_k, expected.ndcg_at_k) &&
    close(actual.context_precision, expected.context_precision) &&
    close(actual.latency_p95_ms, expected.latency_p95_ms) &&
    close(actual.cost_usd, expected.cost_usd)
  );
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function isUnitMetric(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function text(value: unknown): string | null {
  const normalized =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return normalized || null;
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
