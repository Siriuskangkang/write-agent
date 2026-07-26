import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../dist/embedding/embedding.service.js';
import {
  datasetDigest,
  runEvaluation,
  signEvaluationPayload,
} from '../dist/src/retrieval/evaluation-runner.js';
import {
  ProductionEvaluationHarness,
  createProductionEvaluationDataSource,
} from '../dist/src/retrieval/production-evaluation-harness.js';
import { QdrantService } from '../dist/src/retrieval/qdrant.service.js';
import {
  buildRetrievalConfigBinding,
  retrievalConfigHash,
} from '../dist/src/retrieval/retrieval-config.js';

const fixturePath = resolve(
  process.argv[2] ?? 'evaluation/rag/fixtures/chinese-textbook-shadow-v1.json',
);
const outputPath = process.argv[3] ? resolve(process.argv[3]) : null;
if (!outputPath) {
  throw new Error(
    'Production evaluation requires an explicit authorization artifact output path',
  );
}
const secret = process.env.RAG_EVALUATION_HMAC_SECRET;
if (!secret) {
  throw new Error(
    'RAG_EVALUATION_HMAC_SECRET is required for production evaluation',
  );
}
const dataset = JSON.parse(await readFile(fixturePath, 'utf8'));
const minPositiveJudgments = positive(
  process.env.RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS ??
    dataset.judgments?.length ??
    1,
  'RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS',
);
const configService = new ConfigService(process.env);
const bindingConfig = buildRetrievalConfigBinding({
  collection_name:
    process.env.QDRANT_COLLECTION ?? 'write_agent_chunks',
  embedding_model:
    process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  embedding_dimension: positive(
    process.env.EMBEDDING_DIMENSION ?? 1536,
    'EMBEDDING_DIMENSION',
  ),
  index_version: process.env.RAG_INDEX_VERSION ?? 'rag-v1',
});
const configHash = retrievalConfigHash(bindingConfig);
const generatedAt = new Date();
const expiresAt = new Date(
  generatedAt.getTime() +
    positive(
      process.env.RAG_EVALUATION_TTL_HOURS ?? 24,
      'RAG_EVALUATION_TTL_HOURS',
    ) *
      60 *
      60_000,
);
const dataSource = createProductionEvaluationDataSource();
let harness;
let payload;
try {
  await dataSource.initialize();
  const embeddings = new EmbeddingService(configService);
  const qdrant = new QdrantService(configService);
  harness = new ProductionEvaluationHarness(
    dataSource,
    configService,
    embeddings,
    qdrant,
  );
  await harness.initialize();
  payload = await runEvaluation(
    dataset,
    harness.createPipeline(),
    {
      max_latency_p95_ms: positive(
        process.env.RAG_MAX_LATENCY_P95_MS ?? 500,
        'RAG_MAX_LATENCY_P95_MS',
      ),
      min_positive_judgments: minPositiveJudgments,
    },
    {
      code_commit: required('RAG_CODE_COMMIT'),
      index_version: bindingConfig.index_version,
      collection_name: bindingConfig.collection_name,
      embedding_model: bindingConfig.embedding_model,
      embedding_dimension: bindingConfig.embedding_dimension,
      retrieval_config_hash: configHash,
      generated_at: generatedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    },
  );
} finally {
  try {
    await harness?.cleanup();
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (!payload) throw new Error('Production evaluation did not produce a report');
const artifact = signEvaluationPayload(payload, secret);
const raw = `${JSON.stringify(artifact)}\n`;
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, raw, { mode: 0o600 });
const artifactDigest = createHash('sha256').update(raw).digest('hex');
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
process.stderr.write(
  `Signed production artifact: ${outputPath}\n` +
    `RAG_EVALUATION_ARTIFACT_SHA256=${artifactDigest}\n` +
    `RAG_EVALUATION_DATASET_DIGEST=${datasetDigest(dataset)}\n` +
    `RAG_RETRIEVAL_CONFIG_HASH=${configHash}\n`,
);
if (
  !payload.gate_observation.passed &&
  process.env.RAG_REQUIRE_GATE_PASS === '1'
) {
  process.exitCode = 2;
}

function required(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}
