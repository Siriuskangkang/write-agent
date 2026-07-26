import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { ModelRun } from './entities/model-run.entity.js';
import { ModelRunService } from './model-run.service.js';

const WORKFLOW_JOB_ID = '11111111-1111-4111-8111-111111111111';

describe('ModelRunService', () => {
  let saved: ModelRun[];
  let service: ModelRunService;

  beforeEach(() => {
    saved = [];
    const repository = {
      create: (value: Partial<ModelRun>) =>
        ({ id: `run-${saved.length + 1}`, ...value }) as ModelRun,
      save: (value: ModelRun) => {
        saved.push(value);
        return Promise.resolve(value);
      },
      update: (
        criteria: { id: string; status?: string },
        value: Partial<ModelRun>,
      ) => {
        const existing = saved.find(
          (item) =>
            item.id === criteria.id &&
            (criteria.status === undefined || item.status === criteria.status),
        );
        if (!existing) return Promise.resolve({ affected: 0 });
        Object.assign(existing, value);
        return Promise.resolve({ affected: 1 });
      },
      findOneBy: ({ id }: { id: string }) =>
        Promise.resolve(saved.find((item) => item.id === id) ?? null),
      findOne: ({
        where,
      }: {
        where: { workflow_job_id: string; operation_key: string };
      }) =>
        Promise.resolve(
          saved.find(
            (item) =>
              item.workflow_job_id === where.workflow_job_id &&
              item.operation_key === where.operation_key,
          ) ?? null,
        ),
    } as unknown as Repository<ModelRun>;
    Object.assign(repository, {
      manager: {
        transaction: async <T>(
          callback: (manager: {
            query: (sql: string) => Promise<unknown>;
            getRepository: () => Repository<ModelRun>;
          }) => Promise<T>,
        ) =>
          callback({
            query: (sql: string) => {
              if (sql.includes('FROM workflow_jobs')) {
                return Promise.resolve([{ id: WORKFLOW_JOB_ID }]);
              }
              if (sql.includes('MAX(attempt_number)')) {
                const max = saved.reduce(
                  (value, item) => Math.max(value, item.attempt_number ?? 0),
                  0,
                );
                return Promise.resolve([{ nextAttempt: max + 1 }]);
              }
              throw new Error(`unexpected SQL: ${sql}`);
            },
            getRepository: () => repository,
          }),
      },
    });
    service = new ModelRunService(repository);
  });

  it('persists only typed safe metadata, numeric usage and decimal cost', async () => {
    await service.create({
      workflow_job_id: WORKFLOW_JOB_ID,
      provider: 'anthropic',
      model: 'claude-test',
      request_metadata: {
        temperature: 0.2,
        max_output_tokens: 2048,
        response_schema_id: 'outline-v1',
        tags: ['workflow-node:draft', 'shadow'],
      },
      prompt_sha256: 'a'.repeat(64),
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        total_tokens: 125,
        cached_input_tokens: 40,
      },
      cost_usd: '0.001250',
      status: 'SUCCEEDED',
    });

    expect(saved).toEqual([
      expect.objectContaining({
        prompt_sha256: 'a'.repeat(64),
        cost_usd: '0.001250',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          cached_input_tokens: 40,
        },
      }),
    ]);
  });

  it('records a sanitized running row and completes the same attempt', async () => {
    const run = await service.startAttempt({
      workflow_job_id: WORKFLOW_JOB_ID,
      provider: 'deepseek',
      model: 'deepseek-test',
      workflow_node: 'draft',
      attempt_kind: 'network_retry',
      generation_attempt: 3,
      network_attempt: 1,
      repair_attempt: 0,
      request_metadata: {
        workflow_node: 'draft',
        generation_attempt: 3,
        retry_attempt: 1,
      },
      prompt_sha256: 'd'.repeat(64),
    });

    await service.finishAttempt(run.id, {
      status: 'SUCCEEDED',
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
      },
      cost_usd: '0.000081',
      error_code: null,
      error_message: null,
      latency_ms: 24,
      completed_at: new Date('2026-07-25T00:00:00.000Z'),
    });

    expect(saved[0]).toMatchObject({
      workflow_job_id: WORKFLOW_JOB_ID,
      provider: 'deepseek',
      model: 'deepseek-test',
      attempt_number: 1,
      workflow_node: 'draft',
      attempt_kind: 'network_retry',
      generation_attempt: 3,
      network_attempt: 1,
      repair_attempt: 0,
      status: 'SUCCEEDED',
      latency_ms: 24,
      request_metadata: {
        workflow_node: 'draft',
        generation_attempt: 3,
        retry_attempt: 1,
      },
    });
    expect(JSON.stringify(saved[0])).not.toContain('secret prompt');
  });

  it('matches a recorded operation only when its complete safe request identity is identical', async () => {
    const identity = {
      request_fingerprint: '1'.repeat(64),
      prompt_sha256: '2'.repeat(64),
      provider: 'deepseek',
      model: 'deepseek-test',
      schema_id: 'grounded-draft',
      schema_version: 'v1',
      schema_sha256: '3'.repeat(64),
    };
    await service.startAttempt({
      workflow_job_id: WORKFLOW_JOB_ID,
      provider: identity.provider,
      model: identity.model,
      workflow_node: 'atomic_grounded_revision',
      attempt_kind: 'initial',
      generation_attempt: 1,
      network_attempt: 0,
      repair_attempt: 0,
      request_metadata: {
        response_schema_id: identity.schema_id,
        response_schema_version: identity.schema_version,
        response_schema_sha256: identity.schema_sha256,
      },
      prompt_sha256: identity.prompt_sha256,
      request_fingerprint: identity.request_fingerprint,
      operation_key: '4'.repeat(64),
    });

    await expect(
      service.findOperationState(WORKFLOW_JOB_ID, '4'.repeat(64), identity),
    ).resolves.toBe('recorded');
    for (const mismatch of [
      { ...identity, request_fingerprint: '5'.repeat(64) },
      { ...identity, prompt_sha256: '5'.repeat(64) },
      { ...identity, provider: 'anthropic' },
      { ...identity, model: 'other-model' },
      { ...identity, schema_id: 'other-schema' },
      { ...identity, schema_version: 'v2' },
      { ...identity, schema_sha256: '5'.repeat(64) },
    ]) {
      await expect(
        service.findOperationState(WORKFLOW_JOB_ID, '4'.repeat(64), mismatch),
      ).resolves.toBe('mismatch');
    }
  });

  it('keeps a terminal attempt immutable and allows only an identical replay', async () => {
    const run = await service.startAttempt({
      workflow_job_id: WORKFLOW_JOB_ID,
      provider: 'deepseek',
      model: 'deepseek-test',
      workflow_node: 'draft',
      attempt_kind: 'initial',
      generation_attempt: 1,
      network_attempt: 0,
      repair_attempt: 0,
      request_metadata: null,
      prompt_sha256: 'd'.repeat(64),
    });
    const terminal = {
      status: 'SUCCEEDED' as const,
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        total_tokens: 15,
      },
      cost_usd: '0.000081',
      error_code: null,
      error_message: null,
      latency_ms: 24,
      completed_at: new Date('2026-07-25T00:00:00.000Z'),
    };

    await service.finishAttempt(run.id, terminal);
    await expect(
      service.finishAttempt(run.id, terminal),
    ).resolves.toBeUndefined();
    await expect(
      service.finishAttempt(run.id, {
        ...terminal,
        status: 'FAILED',
        error_code: 'LATE_FAILURE',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saved[0]).toMatchObject({
      status: 'SUCCEEDED',
      error_code: null,
    });
  });

  it.each([
    { response_schema_id: 'full schema instructions here' },
    { response_schema_id: '教材目录 schema' },
    { trace_id: 'raw source text must not persist' },
    { trace_id: '含有素材正文' },
  ])('rejects free-form persisted identifiers %#', async (metadata) => {
    await expect(
      service.create({
        workflow_job_id: WORKFLOW_JOB_ID,
        provider: 'anthropic',
        model: 'claude-test',
        request_metadata: metadata,
        prompt_sha256: 'b'.repeat(64),
        usage: null,
        cost_usd: null,
        status: 'FAILED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toHaveLength(0);
  });

  it.each([
    { prompt: 'plaintext' },
    { tags: { messages: ['plaintext'] } },
    { tags: { nested: { content: 'plaintext' } } },
    { tags: { prompt_text: 'SECRET FULL PROMPT' } },
    { tags: [{ systemInstruction: 'SECRET SYSTEM INSTRUCTION' }] },
    { tags: [{ nested: [{ 'raw-message': 'SECRET RAW MESSAGE' }] }] },
  ])('recursively rejects sensitive request metadata %#', async (metadata) => {
    await expect(
      service.create({
        workflow_job_id: WORKFLOW_JOB_ID,
        provider: 'anthropic',
        model: 'claude-test',
        request_metadata: metadata as never,
        prompt_sha256: 'b'.repeat(64),
        usage: null,
        cost_usd: null,
        status: 'FAILED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toHaveLength(0);
  });

  it.each([
    {
      name: 'too many tags',
      metadata: {
        tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`),
      },
    },
    {
      name: 'an overlong tag',
      metadata: { tags: ['x'.repeat(65)] },
    },
    {
      name: 'a free-form tag value',
      metadata: { tags: ['full prompt text must not be persisted'] },
    },
    {
      name: 'an over-deep nested value',
      metadata: { tags: [[[[['too-deep']]]]] },
    },
    {
      name: 'metadata larger than the byte budget',
      metadata: {
        tags: Array.from(
          { length: 16 },
          (_, index) => `${index}-${'x'.repeat(300)}`,
        ),
      },
    },
  ])('rejects $name', async ({ metadata }) => {
    await expect(
      service.create({
        workflow_job_id: WORKFLOW_JOB_ID,
        provider: 'anthropic',
        model: 'claude-test',
        request_metadata: metadata as never,
        prompt_sha256: 'b'.repeat(64),
        usage: null,
        cost_usd: null,
        status: 'FAILED',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toHaveLength(0);
  });

  it('rejects unknown metadata even when it is not a sensitive key', async () => {
    await expect(
      service.create({
        workflow_job_id: WORKFLOW_JOB_ID,
        provider: 'anthropic',
        model: 'claude-test',
        request_metadata: { arbitrary_provider_payload: true } as never,
        prompt_sha256: null,
        usage: null,
        cost_usd: null,
        status: 'RUNNING',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    {
      name: 'a malformed prompt hash',
      override: { prompt_sha256: 'not-a-sha256' },
    },
    {
      name: 'a JavaScript number cost',
      override: { cost_usd: 0.1 as unknown as string },
    },
    {
      name: 'an exponent decimal',
      override: { cost_usd: '1e-6' },
    },
    {
      name: 'fractional token usage',
      override: {
        usage: {
          input_tokens: 1.5,
          output_tokens: 2,
          total_tokens: 3.5,
        },
      },
    },
    {
      name: 'an inconsistent total token count',
      override: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 14,
        },
      },
    },
    {
      name: 'an unsafe input token integer',
      override: {
        usage: {
          input_tokens: Number.MAX_SAFE_INTEGER + 1,
          output_tokens: 0,
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    },
    {
      name: 'an unsafe optional token integer',
      override: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cached_input_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    },
    {
      name: 'a total different from input plus output',
      override: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 16,
        },
      },
    },
  ])('rejects $name', async ({ override }) => {
    await expect(
      service.create({
        workflow_job_id: WORKFLOW_JOB_ID,
        provider: 'anthropic',
        model: 'claude-test',
        request_metadata: null,
        prompt_sha256: 'c'.repeat(64),
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          total_tokens: 3,
        },
        cost_usd: '0.100000',
        status: 'SUCCEEDED',
        ...override,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toHaveLength(0);
  });
});
