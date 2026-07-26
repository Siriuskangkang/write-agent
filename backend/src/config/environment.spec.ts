import { validateEnvironment } from './environment.js';

const validConfig = {
  NODE_ENV: 'production',
  DATABASE_HOST: 'db.internal',
  DATABASE_PORT: '3306',
  DATABASE_NAME: 'textweaver',
  DATABASE_USER: 'textweaver',
  DATABASE_PASSWORD: 'database-password',
  REDIS_HOST: 'redis.internal',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'redis-password',
  JWT_SECRET: 'access-token-secret',
  LLM_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'deepseek-api-key',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
};

describe('validateEnvironment', () => {
  it.each([
    ['shadow_no_persist', 'shadow_no_persist'],
    ['off', 'off'],
    [undefined, 'off'],
    ['', 'off'],
    ['enforce', 'off'],
    ['SHADOW_NO_PERSIST', 'off'],
    ['unexpected', 'off'],
  ] as const)(
    'canonicalizes ATOMIC_GROUNDING_MODE=%p to %s',
    (value, expected) => {
      expect(
        validateEnvironment({
          ...validConfig,
          ATOMIC_GROUNDING_MODE: value,
        }).ATOMIC_GROUNDING_MODE,
      ).toBe(expected);
    },
  );

  it('rejects a blank JWT secret in production', () => {
    expect(() =>
      validateEnvironment({ ...validConfig, JWT_SECRET: '' }),
    ).toThrow('JWT_SECRET');
  });

  it('parses configured service ports as numbers', () => {
    expect(validateEnvironment(validConfig).DATABASE_PORT).toBe(3306);
  });

  it('uses documented local service defaults only in development', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'development',
        JWT_SECRET: 'access-token-secret',
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'anthropic-api-key',
        ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
      }),
    ).toMatchObject({
      DATABASE_HOST: 'localhost',
      DATABASE_PORT: 3306,
      REDIS_HOST: 'localhost',
      REDIS_PORT: 6379,
    });
  });

  it('requires database and Redis settings outside development', () => {
    expect(() =>
      validateEnvironment({ ...validConfig, DATABASE_HOST: '' }),
    ).toThrow('DATABASE_HOST');
  });

  it('requires a Redis password outside development', () => {
    expect(() =>
      validateEnvironment({ ...validConfig, REDIS_PASSWORD: '' }),
    ).toThrow('REDIS_PASSWORD');
  });

  it('requires credentials for the selected LLM provider', () => {
    expect(() =>
      validateEnvironment({ ...validConfig, DEEPSEEK_API_KEY: '' }),
    ).toThrow('DEEPSEEK_API_KEY');
  });

  it.each([
    ['DATABASE_HOST'],
    ['DATABASE_NAME'],
    ['DATABASE_USER'],
    ['DATABASE_PASSWORD'],
    ['REDIS_HOST'],
    ['REDIS_PORT'],
    ['REDIS_PASSWORD'],
  ])('requires %s outside development', (key) => {
    expect(() => validateEnvironment({ ...validConfig, [key]: '' })).toThrow(
      key,
    );
  });

  it.each([
    ['DATABASE_PORT', '0'],
    ['DATABASE_PORT', '65536'],
    ['REDIS_PORT', 'not-a-port'],
  ])('rejects an invalid %s value', (key, value) => {
    expect(() => validateEnvironment({ ...validConfig, [key]: value })).toThrow(
      key,
    );
  });

  it.each([
    ['invalid NODE_ENV', { ...validConfig, NODE_ENV: 'staging' }, 'NODE_ENV'],
    [
      'invalid provider',
      { ...validConfig, LLM_PROVIDER: 'openai' },
      'LLM_PROVIDER',
    ],
    [
      'missing Anthropic API key',
      {
        ...validConfig,
        LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: '',
      },
      'ANTHROPIC_API_KEY',
    ],
  ])('rejects %s', (_name, config, expectedMessage) => {
    expect(() => validateEnvironment(config)).toThrow(expectedMessage);
  });

  it('treats an omitted NODE_ENV as development for local launchers', () => {
    const configWithoutNodeEnv = { ...validConfig };
    delete configWithoutNodeEnv.NODE_ENV;
    expect(
      validateEnvironment({
        ...configWithoutNodeEnv,
        DATABASE_HOST: '',
        DATABASE_PORT: '',
        DATABASE_NAME: '',
        DATABASE_USER: '',
        DATABASE_PASSWORD: '',
        REDIS_HOST: '',
        REDIS_PORT: '',
        REDIS_PASSWORD: '',
      }),
    ).toMatchObject({
      NODE_ENV: 'development',
      DATABASE_HOST: 'localhost',
      REDIS_PASSWORD: 'redis_local',
    });
  });

  it('defaults retrieval to shadow and validates local Qdrant settings', () => {
    expect(validateEnvironment(validConfig)).toMatchObject({
      RETRIEVAL_MODE: 'shadow',
      QDRANT_URL: 'http://127.0.0.1:6333',
      QDRANT_COLLECTION: 'write_agent_chunks',
      EMBEDDING_DIMENSION: 1536,
    });
  });

  it.each([
    ['RETRIEVAL_MODE', 'autonomous'],
    ['EMBEDDING_DIMENSION', '0'],
    ['QDRANT_TIMEOUT_MS', 'not-a-number'],
  ])('rejects invalid retrieval setting %s', (key, value) => {
    expect(() => validateEnvironment({ ...validConfig, [key]: value })).toThrow(
      key,
    );
  });
});
