Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '3306',
  DATABASE_NAME: 'textweaver',
  DATABASE_USER: 'textweaver',
  DATABASE_PASSWORD: 'database-password',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'redis-password',
  JWT_SECRET: 'access-token-secret',
  LLM_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'deepseek-api-key',
});
