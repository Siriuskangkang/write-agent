import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RagEvaluationGate } from './evaluation-gate.js';
import { signEvaluationPayload } from './evaluation-runner.js';

describe('RagEvaluationGate', () => {
  const secret = 'a-secure-evaluation-secret-that-is-long-enough';
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rag-evaluation-gate-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('allows only an HMAC-attested artifact bound to current runtime config', async () => {
    const { report, digest } = await writeArtifact(directory, secret);
    const gate = new RagEvaluationGate(config(report, digest, secret) as never);

    await expect(gate.canUseHybrid()).resolves.toBe(true);
    expect(gate.lastDecision).toMatchObject({
      allowed: true,
      code: 'ATTESTATION_VALID',
    });
  });

  it('rejects an unsigned hand-written perfect report', async () => {
    const report = join(directory, 'forged.json');
    const raw = JSON.stringify({
      schema_version: 'rag-eval-v2',
      hybrid: { recall_at_k: 1, ndcg_at_k: 1, latency_p95_ms: 1 },
      legacy: { recall_at_k: 0, ndcg_at_k: 0 },
      gate_observation: { passed: true },
    });
    await writeFile(report, raw);
    const gate = new RagEvaluationGate(
      config(report, sha256(raw), secret) as never,
    );

    await expect(gate.canUseHybrid()).resolves.toBe(false);
  });

  it('rejects a validly signed offline evaluation source', async () => {
    const { report, digest } = await writeArtifact(
      directory,
      secret,
      'offline-deterministic-v1',
    );
    const gate = new RagEvaluationGate(config(report, digest, secret) as never);

    await expect(gate.canUseHybrid()).resolves.toBe(false);
    expect(gate.lastDecision).toMatchObject({
      allowed: false,
      code: 'BINDING_MISMATCH',
    });
  });

  it('rejects symlinks even when the target is inside the allowed directory', async () => {
    const { report, digest } = await writeArtifact(directory, secret);
    const link = join(directory, 'link.json');
    await symlink(report, link);
    const gate = new RagEvaluationGate(config(link, digest, secret) as never);

    await expect(gate.canUseHybrid()).resolves.toBe(false);
    expect(gate.lastDecision.code).toBe('ARTIFACT_NOT_REGULAR');
  });

  it.each([
    ['wrong digest', { artifactDigest: '0'.repeat(64) }],
    ['stale commit', { codeCommit: 'different' }],
    ['wrong collection', { collection: 'other' }],
    ['current latency budget exceeded', { maxLatency: 20 }],
    ['insufficient sample count', { minSamples: 20 }],
  ])('rejects %s', async (_name, override) => {
    const { report, digest } = await writeArtifact(directory, secret);
    const gate = new RagEvaluationGate(
      config(report, digest, secret, override) as never,
    );
    await expect(gate.canUseHybrid()).resolves.toBe(false);
  });

  it('fails closed when the report is absent', async () => {
    const gate = new RagEvaluationGate(
      config(join(directory, 'missing.json'), '0'.repeat(64), secret) as never,
    );
    await expect(gate.canUseHybrid()).resolves.toBe(false);
  });

  it.each([
    [
      'sample count differs from unique traces',
      (payload: ArtifactPayload) => {
        payload.sample_count += 1;
      },
    ],
    [
      'a trace contains duplicate ranked chunks',
      (payload: ArtifactPayload) => {
        payload.traces[0].hybrid.ranked_chunk_ids = ['chunk-0', 'chunk-0'];
      },
    ],
    [
      'signed aggregate metrics do not recompute from traces',
      (payload: ArtifactPayload) => {
        payload.hybrid.recall_at_k = 0.5;
      },
    ],
    [
      'the reported positive judgment count differs from the traces',
      (payload: ArtifactPayload) => {
        payload.positive_judgment_count += 1;
      },
    ],
  ])('rejects an HMAC-valid artifact when %s', async (_name, mutate) => {
    const { report, digest } = await writeArtifact(
      directory,
      secret,
      'mysql-qdrant-production-v1',
      mutate,
    );
    const gate = new RagEvaluationGate(config(report, digest, secret) as never);

    await expect(gate.canUseHybrid()).resolves.toBe(false);
    expect(gate.lastDecision.code).toBe('ARTIFACT_SCHEMA_INVALID');
  });

  it('rejects an HMAC-valid artifact whose traces have no positive relevance judgments', async () => {
    const { report, digest } = await writeArtifact(
      directory,
      secret,
      'mysql-qdrant-production-v1',
      (payload) => {
        payload.positive_judgment_count = 0;
        for (const trace of payload.traces) {
          trace.relevant_chunk_ids = [];
          trace.legacy.ranked_chunk_ids = [];
          trace.hybrid.ranked_chunk_ids = [];
          trace.hybrid.sparse_ranked_chunk_ids = [];
          trace.hybrid.dense_ranked_chunk_ids = [];
        }
      },
    );
    const gate = new RagEvaluationGate(config(report, digest, secret) as never);

    await expect(gate.canUseHybrid()).resolves.toBe(false);
    expect(gate.lastDecision.code).toBe('ARTIFACT_SCHEMA_INVALID');
  });

  it('rejects an old or overlong artifact even when its HMAC is valid', async () => {
    const { report, digest } = await writeArtifact(
      directory,
      secret,
      'mysql-qdrant-production-v1',
      (payload) => {
        payload.generated_at = new Date(
          Date.now() - 49 * 60 * 60_000,
        ).toISOString();
        payload.expires_at = new Date(
          Date.now() + 15 * 24 * 60 * 60_000,
        ).toISOString();
      },
    );
    const gate = new RagEvaluationGate(
      config(report, digest, secret, {
        maxAgeHours: 48,
        maxTtlHours: 7 * 24,
      }) as never,
    );

    await expect(gate.canUseHybrid()).resolves.toBe(false);
    expect(gate.lastDecision.code).toBe('ARTIFACT_EXPIRED');
  });
});

type ArtifactPayload = Awaited<ReturnType<typeof artifactPayload>>;

async function writeArtifact(
  directory: string,
  secret: string,
  source = 'mysql-qdrant-production-v1',
  mutate?: (payload: ArtifactPayload) => void,
) {
  const report = join(directory, 'report.json');
  const payload = artifactPayload(source);
  mutate?.(payload);
  const raw = JSON.stringify(signEvaluationPayload(payload, secret));
  await writeFile(report, raw);
  return { report, digest: sha256(raw) };
}

function artifactPayload(source: string) {
  const generatedAt = new Date();
  const traces = Array.from({ length: 10 }, (_, index) => ({
    sample_id: `sample-${index}`,
    query: `query-${index}`,
    relevant_chunk_ids: [`chunk-${index}`],
    legacy: {
      ranked_chunk_ids: [`chunk-${index}`],
      latency_ms: 10,
      cost_usd: 0,
    },
    hybrid: {
      ranked_chunk_ids: [`chunk-${index}`],
      sparse_ranked_chunk_ids: [`chunk-${index}`],
      dense_ranked_chunk_ids: [`chunk-${index}`],
      latency_ms: 40,
      cost_usd: 0.001,
    },
  }));
  return {
    schema_version: 'rag-eval-v2',
    generated_at: generatedAt.toISOString(),
    expires_at: new Date(
      generatedAt.getTime() + 24 * 60 * 60_000,
    ).toISOString(),
    dataset: 'fixture',
    dataset_digest: 'd'.repeat(64),
    sample_count: 10,
    positive_judgment_count: 10,
    k: 8,
    source,
    binding: {
      code_commit: 'abcdef123456',
      index_version: 'rag-v1',
      collection_name: 'chunks',
      embedding_model: 'embedding-v1',
      embedding_dimension: 3,
      retrieval_config_hash: 'c'.repeat(64),
    },
    traces,
    legacy: {
      recall_at_k: 1,
      ndcg_at_k: 1,
      context_precision: 1,
      latency_p95_ms: 10,
      cost_usd: 0,
    },
    hybrid: {
      recall_at_k: 1,
      ndcg_at_k: 1,
      context_precision: 1,
      latency_p95_ms: 40,
      cost_usd: 0.01,
    },
    gate_observation: {
      relevance_not_worse: true,
      latency_within_budget: true,
      passed: true,
    },
  };
}

function config(
  report: string,
  digest: string,
  secret: string,
  override: Record<string, unknown> = {},
) {
  const values: Record<string, unknown> = {
    RAG_EVALUATION_REPORT: report,
    RAG_EVALUATION_DIR: directoryOf(report),
    RAG_EVALUATION_ARTIFACT_SHA256: override.artifactDigest ?? digest,
    RAG_EVALUATION_HMAC_SECRET: secret,
    RAG_EVALUATION_DATASET_DIGEST: 'd'.repeat(64),
    RAG_CODE_COMMIT: override.codeCommit ?? 'abcdef123456',
    RAG_INDEX_VERSION: 'rag-v1',
    QDRANT_COLLECTION: override.collection ?? 'chunks',
    EMBEDDING_MODEL: 'embedding-v1',
    EMBEDDING_DIMENSION: 3,
    RAG_RETRIEVAL_CONFIG_HASH: 'c'.repeat(64),
    RAG_EVALUATION_MIN_SAMPLES: override.minSamples ?? 5,
    RAG_MAX_LATENCY_P95_MS: override.maxLatency ?? 50,
    RAG_EVALUATION_MAX_AGE_HOURS: override.maxAgeHours ?? 48,
    RAG_EVALUATION_MAX_TTL_HOURS: override.maxTtlHours ?? 168,
    RAG_EVALUATION_FUTURE_SKEW_SECONDS: override.futureSkewSeconds ?? 300,
  };
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  };
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
