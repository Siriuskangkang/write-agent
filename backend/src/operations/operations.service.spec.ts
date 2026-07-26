import type { ConfigService } from '@nestjs/config';
import type * as Bull from 'bull';
import type { DataSource } from 'typeorm';
import {
  normalizeRequestId,
  safeOperationalError,
} from './request-correlation.js';
import { OperationsService } from './operations.service.js';

describe('OperationsService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports dependency readiness without exposing secret error messages', async () => {
    const dataSource = {
      query: jest.fn().mockResolvedValue([{ ok: 1 }]),
    } as unknown as DataSource;
    const redis = {
      ping: jest.fn().mockResolvedValue('PONG'),
      get: jest.fn().mockResolvedValue('heartbeat'),
    };
    const queue = {
      isReady: jest.fn().mockResolvedValue(undefined),
      client: redis,
    } as unknown as Bull.Queue;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => {
        const values: Record<string, unknown> = {
          QDRANT_URL: 'http://qdrant.test',
          QDRANT_TIMEOUT_MS: 100,
          LLM_PROVIDER: 'deepseek',
          DEEPSEEK_API_KEY: 'must-not-appear',
        };
        return values[key] ?? fallback;
      }),
      getOrThrow: jest.fn(() => 'http://qdrant.test'),
    } as unknown as ConfigService;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      new OperationsService(dataSource, config, queue).readiness(),
    ).resolves.toEqual({
      status: 'ready',
      dependencies: {
        mysql: { status: 'up' },
        redis: { status: 'up' },
        bull_worker: { status: 'up' },
        qdrant: { status: 'up' },
        llm: { status: 'up', detail: 'deepseek' },
      },
    });
  });

  it('uses safe request ids and redacts operational error details', () => {
    expect(normalizeRequestId('trace-123')).toBe('trace-123');
    expect(normalizeRequestId('bad\nheader')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(safeOperationalError(new Error('secret document contents'))).toBe(
      'Error',
    );
  });
});
