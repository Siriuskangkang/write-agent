import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  ProductionEvaluationPipeline,
  datasetDigest,
  runEvaluation,
  signEvaluationPayload,
} from '../dist/src/retrieval/evaluation-runner.js';
import {
  buildRetrievalConfigBinding,
  retrievalConfigHash,
} from '../dist/src/retrieval/retrieval-config.js';

const fixturePath = resolve(
  process.argv[2] ?? 'evaluation/rag/fixtures/chinese-textbook-shadow-v1.json',
);
const outputPath = process.argv[3] ? resolve(process.argv[3]) : null;
const threshold = positive(
  process.env.RAG_MAX_LATENCY_P95_MS ?? 500,
  'RAG_MAX_LATENCY_P95_MS',
);
const dimension = positive(
  process.env.EMBEDDING_DIMENSION ?? 64,
  'EMBEDDING_DIMENSION',
);
const dataset = JSON.parse(await readFile(fixturePath, 'utf8'));
const minPositiveJudgments = positive(
  process.env.RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS ??
    dataset.judgments?.length ??
    1,
  'RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS',
);
const generatedAt = new Date();
const expiresAt = new Date(
  generatedAt.getTime() +
    positive(
      process.env.RAG_EVALUATION_TTL_DAYS ?? 30,
      'RAG_EVALUATION_TTL_DAYS',
    ) *
      86_400_000,
);
const config = buildRetrievalConfigBinding({
  collection_name:
    process.env.QDRANT_COLLECTION ?? 'write_agent_chunks',
  embedding_model:
    process.env.EMBEDDING_MODEL ?? 'deterministic-evaluation-v1',
  embedding_dimension: dimension,
  index_version: process.env.RAG_INDEX_VERSION ?? 'rag-v1',
});
const currentRetrievalConfigHash = retrievalConfigHash(config);
const pipeline = new ProductionEvaluationPipeline(
  dimension,
  Number(process.env.EMBEDDING_PRICE_PER_MILLION_USD ?? 0),
);
const payload = await runEvaluation(
  dataset,
  pipeline,
  {
    max_latency_p95_ms: threshold,
    min_positive_judgments: minPositiveJudgments,
  },
  {
    code_commit: process.env.RAG_CODE_COMMIT ?? 'unattested-local-run',
    index_version: config.index_version,
    collection_name: config.collection_name,
    embedding_model: config.embedding_model,
    embedding_dimension: dimension,
    retrieval_config_hash: currentRetrievalConfigHash,
    generated_at: generatedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  },
);

process.stdout.write(
  `${JSON.stringify(
    {
      ...payload,
      runtime_configuration: {
        dataset_digest: datasetDigest(dataset),
        retrieval_config_hash: currentRetrievalConfigHash,
      },
    },
    null,
    2,
  )}\n`,
);

if (outputPath) {
  if (payload.source !== 'mysql-qdrant-production-v1') {
    throw new Error(
      'Offline evaluation cannot write an authorization artifact; run the MySQL+Qdrant production evaluation harness',
    );
  }
  const secret = process.env.RAG_EVALUATION_HMAC_SECRET;
  if (!secret) {
    throw new Error(
      'RAG_EVALUATION_HMAC_SECRET is required to write an authorization artifact',
    );
  }
  const artifact = signEvaluationPayload(payload, secret);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact)}\n`, {
    mode: 0o600,
  });
  const artifactDigest = createHash('sha256')
    .update(`${JSON.stringify(artifact)}\n`)
    .digest('hex');
  process.stderr.write(
    `Signed artifact: ${outputPath}\n` +
      `RAG_EVALUATION_ARTIFACT_SHA256=${artifactDigest}\n` +
      `RAG_EVALUATION_DATASET_DIGEST=${datasetDigest(dataset)}\n` +
      `RAG_RETRIEVAL_CONFIG_HASH=${currentRetrievalConfigHash}\n`,
  );
}

if (
  !payload.gate_observation.passed &&
  process.env.RAG_REQUIRE_GATE_PASS === '1'
) {
  process.exitCode = 2;
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}
