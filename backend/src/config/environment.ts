import {
  parseAtomicGroundingMode,
  type AtomicGroundingMode,
} from '../citation/atomic-grounding/atomic-grounding-mode.js';

export type LlmProvider = 'anthropic' | 'deepseek';

export interface Environment extends Record<string, unknown> {
  NODE_ENV: 'development' | 'test' | 'production';
  DATABASE_HOST: string;
  DATABASE_PORT: number;
  DATABASE_NAME: string;
  DATABASE_USER: string;
  DATABASE_PASSWORD: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  JWT_SECRET: string;
  LLM_PROVIDER: LlmProvider;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_MODEL?: string;
  EMBEDDING_DIMENSION: number;
  QDRANT_URL: string;
  QDRANT_COLLECTION: string;
  QDRANT_TIMEOUT_MS: number;
  QDRANT_API_KEY?: string;
  RETRIEVAL_MODE: 'legacy' | 'shadow' | 'hybrid';
  ATOMIC_GROUNDING_MODE: AtomicGroundingMode;
  RAG_INDEX_VERSION: string;
  RAG_EVALUATION_REPORT?: string;
  RAG_EVALUATION_DIR?: string;
  RAG_EVALUATION_ARTIFACT_SHA256?: string;
  RAG_EVALUATION_HMAC_SECRET?: string;
  RAG_EVALUATION_DATASET_DIGEST?: string;
  RAG_CODE_COMMIT?: string;
  RAG_RETRIEVAL_CONFIG_HASH?: string;
  RAG_MAX_LATENCY_P95_MS: number;
  RAG_EVALUATION_MIN_SAMPLES: number;
  RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS: number;
}

const LOCAL_DEFAULTS = {
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: 3306,
  DATABASE_NAME: 'textweaver',
  DATABASE_USER: 'textweaver',
  DATABASE_PASSWORD: 'textweaver_local',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
} as const;

function readString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
}

function requireString(config: Record<string, unknown>, key: string): string {
  const value = readString(config, key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function readPort(config: Record<string, unknown>, key: string): number {
  const value = requireString(config, key);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Environment variable ${key} must be a valid port number`);
  }
  return port;
}

function readPositiveInteger(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = readString(config, key) ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Environment variable ${key} must be a positive integer`);
  }
  return parsed;
}

function readEnvironment(
  config: Record<string, unknown>,
): Environment['NODE_ENV'] {
  const value = readString(config, 'NODE_ENV') ?? 'development';
  if (value === 'development' || value === 'test' || value === 'production') {
    return value;
  }
  throw new Error('NODE_ENV must be development, test, or production');
}

function readProvider(config: Record<string, unknown>): LlmProvider {
  const provider = requireString(config, 'LLM_PROVIDER');
  if (provider === 'anthropic' || provider === 'deepseek') {
    return provider;
  }
  throw new Error('LLM_PROVIDER must be anthropic or deepseek');
}

function withDevelopmentDefault(
  config: Record<string, unknown>,
  key: keyof typeof LOCAL_DEFAULTS,
  nodeEnv: Environment['NODE_ENV'],
): string {
  return (
    readString(config, key) ??
    (nodeEnv === 'development'
      ? String(LOCAL_DEFAULTS[key])
      : requireString(config, key))
  );
}

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const NODE_ENV = readEnvironment(config);
  const LLM_PROVIDER = readProvider(config);
  const DATABASE_HOST = withDevelopmentDefault(
    config,
    'DATABASE_HOST',
    NODE_ENV,
  );
  const DATABASE_PORT = readPort(
    {
      DATABASE_PORT: withDevelopmentDefault(config, 'DATABASE_PORT', NODE_ENV),
    },
    'DATABASE_PORT',
  );
  const DATABASE_NAME = withDevelopmentDefault(
    config,
    'DATABASE_NAME',
    NODE_ENV,
  );
  const DATABASE_USER = withDevelopmentDefault(
    config,
    'DATABASE_USER',
    NODE_ENV,
  );
  const DATABASE_PASSWORD = withDevelopmentDefault(
    config,
    'DATABASE_PASSWORD',
    NODE_ENV,
  );
  const REDIS_HOST = withDevelopmentDefault(config, 'REDIS_HOST', NODE_ENV);
  const REDIS_PORT = readPort(
    { REDIS_PORT: withDevelopmentDefault(config, 'REDIS_PORT', NODE_ENV) },
    'REDIS_PORT',
  );
  const REDIS_PASSWORD =
    readString(config, 'REDIS_PASSWORD') ??
    (NODE_ENV === 'development'
      ? 'redis_local'
      : requireString(config, 'REDIS_PASSWORD'));

  const JWT_SECRET = requireString(config, 'JWT_SECRET');
  const providerApiKey =
    LLM_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'DEEPSEEK_API_KEY';
  const apiKey = requireString(config, providerApiKey);
  const EMBEDDING_DIMENSION = readPositiveInteger(
    config,
    'EMBEDDING_DIMENSION',
    1536,
  );
  const QDRANT_TIMEOUT_MS = readPositiveInteger(
    config,
    'QDRANT_TIMEOUT_MS',
    5_000,
  );
  const QDRANT_URL =
    readString(config, 'QDRANT_URL') ?? 'http://127.0.0.1:6333';
  try {
    const parsed = new URL(QDRANT_URL);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new Error('QDRANT_URL must be an http or https URL');
  }
  const QDRANT_COLLECTION =
    readString(config, 'QDRANT_COLLECTION') ?? 'write_agent_chunks';
  const retrievalMode = readString(config, 'RETRIEVAL_MODE') ?? 'shadow';
  if (
    retrievalMode !== 'legacy' &&
    retrievalMode !== 'shadow' &&
    retrievalMode !== 'hybrid'
  ) {
    throw new Error('RETRIEVAL_MODE must be legacy, shadow, or hybrid');
  }
  const RAG_INDEX_VERSION = readString(config, 'RAG_INDEX_VERSION') ?? 'rag-v1';
  const RAG_MAX_LATENCY_P95_MS = readPositiveInteger(
    config,
    'RAG_MAX_LATENCY_P95_MS',
    500,
  );
  const RAG_EVALUATION_MIN_SAMPLES = readPositiveInteger(
    config,
    'RAG_EVALUATION_MIN_SAMPLES',
    20,
  );
  const RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS = readPositiveInteger(
    config,
    'RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS',
    RAG_EVALUATION_MIN_SAMPLES,
  );
  const gateConfig = {
    RAG_EVALUATION_REPORT: readString(config, 'RAG_EVALUATION_REPORT'),
    RAG_EVALUATION_DIR: readString(config, 'RAG_EVALUATION_DIR'),
    RAG_EVALUATION_ARTIFACT_SHA256: readString(
      config,
      'RAG_EVALUATION_ARTIFACT_SHA256',
    ),
    RAG_EVALUATION_HMAC_SECRET: readString(
      config,
      'RAG_EVALUATION_HMAC_SECRET',
    ),
    RAG_EVALUATION_DATASET_DIGEST: readString(
      config,
      'RAG_EVALUATION_DATASET_DIGEST',
    ),
    RAG_CODE_COMMIT: readString(config, 'RAG_CODE_COMMIT'),
    RAG_RETRIEVAL_CONFIG_HASH: readString(config, 'RAG_RETRIEVAL_CONFIG_HASH'),
  };
  if (retrievalMode === 'hybrid') {
    for (const [key, value] of Object.entries(gateConfig)) {
      if (!value)
        throw new Error(`Missing required environment variable: ${key}`);
    }
    if ((gateConfig.RAG_EVALUATION_HMAC_SECRET ?? '').length < 32) {
      throw new Error(
        'RAG_EVALUATION_HMAC_SECRET must be at least 32 characters',
      );
    }
  }

  return {
    ...config,
    NODE_ENV,
    DATABASE_HOST,
    DATABASE_PORT,
    DATABASE_NAME,
    DATABASE_USER,
    DATABASE_PASSWORD,
    REDIS_HOST,
    REDIS_PORT,
    REDIS_PASSWORD,
    JWT_SECRET,
    LLM_PROVIDER,
    EMBEDDING_DIMENSION,
    QDRANT_URL,
    QDRANT_COLLECTION,
    QDRANT_TIMEOUT_MS,
    QDRANT_API_KEY: readString(config, 'QDRANT_API_KEY'),
    RETRIEVAL_MODE: retrievalMode,
    ATOMIC_GROUNDING_MODE: parseAtomicGroundingMode(
      config.ATOMIC_GROUNDING_MODE,
    ),
    RAG_INDEX_VERSION,
    ...gateConfig,
    RAG_MAX_LATENCY_P95_MS,
    RAG_EVALUATION_MIN_SAMPLES,
    RAG_EVALUATION_MIN_POSITIVE_JUDGMENTS,
    [providerApiKey]: apiKey,
  };
}
