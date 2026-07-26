/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import type { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { LLMFactory } from './llm.factory.js';
import { ModelGateway, ModelGatewayError } from './model-gateway.js';
import { ModelPricingCatalog, type ModelRunRecorder } from './model-pricing.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  StructuredOutputSchema,
  ToolDefinition,
} from './model-types.js';

const trace = {
  workflow_job_id: '11111111-1111-4111-8111-111111111111',
  node: 'draft',
  attempt: 3,
} as const;

const lookupTool: ToolDefinition = {
  name: 'lookup',
  description: 'Look up evidence for a query.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
};

describe('ModelGateway', () => {
  it('binds a prepared single-dispatch operation to the complete canonical request without provider I/O', () => {
    const adapter = scriptedAdapter([]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);
    const schema = {
      id: 'grounded-draft',
      version: 'v1',
      json_schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      parse: (value: unknown) => value,
    } satisfies StructuredOutputSchema<unknown> & { version: string };
    const baseRequest: ModelRequest = {
      response_mode: 'structured',
      schema,
      messages: [
        { role: 'system', content: 'alpha' },
        { role: 'user', content: 'A' },
      ],
      temperature: 0.2,
      max_tokens: 8192,
      timeout_ms: 12_345,
      max_retries: 0,
      max_repair_attempts: 0,
      retry_base_delay_ms: 17,
      trace,
    };
    const prepare = (
      request: ModelRequest,
    ): {
      identity: {
        operation_key: string;
        request_fingerprint: string;
        prompt_sha256: string;
        provider: string;
        model: string;
        schema_id: string | null;
        schema_version: string | null;
        schema_sha256: string | null;
      };
    } =>
      (
        gateway as unknown as {
          prepareSingleDispatch(request: ModelRequest): {
            identity: {
              operation_key: string;
              request_fingerprint: string;
              prompt_sha256: string;
              provider: string;
              model: string;
              schema_id: string | null;
              schema_version: string | null;
              schema_sha256: string | null;
            };
          };
        }
      ).prepareSingleDispatch(request);

    expect(
      typeof (gateway as { prepareSingleDispatch?: unknown })
        .prepareSingleDispatch,
    ).toBe('function');
    const first = prepare(baseRequest);
    const reorderedSchema = prepare({
      ...baseRequest,
      schema: {
        ...schema,
        json_schema: {
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          type: 'object',
        },
      },
    });
    expect(reorderedSchema.identity).toEqual(first.identity);

    const variants: ModelRequest[] = [
      {
        ...baseRequest,
        messages: [
          { role: 'system', content: 'beta' },
          { role: 'user', content: 'B' },
        ],
      },
      { ...baseRequest, temperature: 0.3 },
      { ...baseRequest, max_tokens: 4096 },
      { ...baseRequest, timeout_ms: 54_321 },
      { ...baseRequest, max_retries: 1 },
      { ...baseRequest, max_repair_attempts: 1 },
      { ...baseRequest, retry_base_delay_ms: 18 },
      { ...baseRequest, schema: { ...schema, id: 'grounded-draft-alt' } },
      { ...baseRequest, schema: { ...schema, version: 'v2' } },
      {
        ...baseRequest,
        schema: {
          ...schema,
          json_schema: {
            ...schema.json_schema,
            additionalProperties: false,
          },
        },
      },
    ];
    for (const variant of variants) {
      const prepared = prepare(variant);
      expect(prepared.identity.request_fingerprint).not.toBe(
        first.identity.request_fingerprint,
      );
      expect(prepared.identity.operation_key).not.toBe(
        first.identity.operation_key,
      );
    }
    expect(first.identity).toMatchObject({
      provider: 'fake',
      model: 'model-1',
      schema_id: 'grounded-draft',
      schema_version: 'v1',
      operation_key: expect.stringMatching(/^[0-9a-f]{64}$/u),
      request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      prompt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      schema_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(adapter.stream).not.toHaveBeenCalled();
    expect(recorder.startAttempt).not.toHaveBeenCalled();
  });

  it('changes the prepared request fingerprint when provider or model changes', () => {
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'same canonical request' }],
      trace,
    };
    const firstAdapter = scriptedAdapter([]);
    const secondAdapter = {
      ...scriptedAdapter([]),
      provider: 'other-provider',
      model: 'other-model',
    };
    const first = (
      createGateway(firstAdapter, fakeRecorder()) as unknown as {
        prepareSingleDispatch(request: ModelRequest): {
          identity: { request_fingerprint: string; operation_key: string };
        };
      }
    ).prepareSingleDispatch(request);
    const second = (
      createGateway(secondAdapter, fakeRecorder()) as unknown as {
        prepareSingleDispatch(request: ModelRequest): {
          identity: { request_fingerprint: string; operation_key: string };
        };
      }
    ).prepareSingleDispatch(request);

    expect(second.identity.request_fingerprint).not.toBe(
      first.identity.request_fingerprint,
    );
    expect(second.identity.operation_key).not.toBe(
      first.identity.operation_key,
    );
  });

  it.each([
    ['temperature', null],
    ['temperature', Number.NaN],
    ['temperature', Number.POSITIVE_INFINITY],
    ['temperature', Number.NEGATIVE_INFINITY],
    ['temperature', '0.2'],
    ['temperature', -0.01],
    ['temperature', 2.01],
    ['max_tokens', null],
    ['max_tokens', Number.NaN],
    ['max_tokens', Number.POSITIVE_INFINITY],
    ['max_tokens', Number.NEGATIVE_INFINITY],
    ['max_tokens', '128'],
    ['max_tokens', 0],
    ['max_tokens', -1],
    ['max_tokens', 1.5],
    ['max_tokens', Number.MAX_SAFE_INTEGER + 1],
    ['timeout_ms', null],
    ['timeout_ms', Number.NaN],
    ['timeout_ms', Number.POSITIVE_INFINITY],
    ['timeout_ms', Number.NEGATIVE_INFINITY],
    ['timeout_ms', '1000'],
    ['timeout_ms', 0],
    ['timeout_ms', -1],
    ['timeout_ms', 1.5],
    ['max_retries', null],
    ['max_retries', Number.NaN],
    ['max_retries', Number.POSITIVE_INFINITY],
    ['max_retries', Number.NEGATIVE_INFINITY],
    ['max_retries', '1'],
    ['max_retries', -1],
    ['max_retries', 1.5],
    ['max_retries', 6],
    ['max_repair_attempts', null],
    ['max_repair_attempts', Number.NaN],
    ['max_repair_attempts', Number.POSITIVE_INFINITY],
    ['max_repair_attempts', Number.NEGATIVE_INFINITY],
    ['max_repair_attempts', '1'],
    ['max_repair_attempts', -1],
    ['max_repair_attempts', 1.5],
    ['max_repair_attempts', 3],
    ['retry_base_delay_ms', null],
    ['retry_base_delay_ms', Number.NaN],
    ['retry_base_delay_ms', Number.POSITIVE_INFINITY],
    ['retry_base_delay_ms', Number.NEGATIVE_INFINITY],
    ['retry_base_delay_ms', '1'],
    ['retry_base_delay_ms', -1],
    ['retry_base_delay_ms', 1.5],
    ['retry_base_delay_ms', 30_001],
  ])(
    'rejects invalid numeric request field %s=%p before any model dependency I/O',
    async (field, value) => {
      const adapter = scriptedAdapter([]);
      const recorder = fakeRecorder();
      const factory = {
        createProvider: jest.fn().mockReturnValue(adapter),
      } as unknown as LLMFactory;
      const configService = {
        get: <T>(_key: string, fallback?: T) => fallback,
      } as ConfigService;
      const gateway = new ModelGateway(
        factory,
        recorder as unknown as ModelRunRecorder,
        new ModelPricingCatalog(configService),
      );
      const request = {
        messages: [{ role: 'user' as const, content: 'write' }],
        [field]: value,
      } as unknown as ModelRequest;

      expect(() => gateway.prepareSingleDispatch(request)).toThrow();
      await expect(gateway.stream(request).next()).rejects.toThrow();
      expect(() => gateway.estimateWorstCaseCost(request)).toThrow();
      expect(
        (factory as unknown as { createProvider: jest.Mock }).createProvider,
      ).not.toHaveBeenCalled();
      expect(adapter.stream).not.toHaveBeenCalled();
      expect(recorder.startAttempt).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '1',
    -1,
    0,
    1.5,
  ])(
    'rejects invalid trace attempt %p before any model dependency I/O',
    async (attempt) => {
      const adapter = scriptedAdapter([]);
      const recorder = fakeRecorder();
      const factory = {
        createProvider: jest.fn().mockReturnValue(adapter),
      } as unknown as LLMFactory;
      const configService = {
        get: <T>(_key: string, fallback?: T) => fallback,
      } as ConfigService;
      const gateway = new ModelGateway(
        factory,
        recorder as unknown as ModelRunRecorder,
        new ModelPricingCatalog(configService),
      );
      const request = {
        messages: [{ role: 'user' as const, content: 'write' }],
        trace: { ...trace, attempt },
      } as unknown as ModelRequest;

      expect(() => gateway.prepareSingleDispatch(request)).toThrow();
      await expect(gateway.stream(request).next()).rejects.toThrow();
      expect(() => gateway.estimateWorstCaseCost(request)).toThrow();
      expect(
        (factory as unknown as { createProvider: jest.Mock }).createProvider,
      ).not.toHaveBeenCalled();
      expect(adapter.stream).not.toHaveBeenCalled();
      expect(recorder.startAttempt).not.toHaveBeenCalled();
    },
  );

  it('normalizes omitted and explicit numeric defaults into identical dispatched requests', async () => {
    const adapter = scriptedAdapter([
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());
    const omitted = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'same request' }],
      trace,
    });
    const explicit = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'same request' }],
      temperature: undefined,
      max_tokens: undefined,
      timeout_ms: 120_000,
      max_retries: 2,
      max_repair_attempts: 1,
      retry_base_delay_ms: 250,
      trace,
    });
    const explicitUndefined = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'same request' }],
      temperature: undefined,
      max_tokens: undefined,
      timeout_ms: undefined,
      max_retries: undefined,
      max_repair_attempts: undefined,
      retry_base_delay_ms: undefined,
      trace,
    });

    expect(explicit.identity).toEqual(omitted.identity);
    expect(explicitUndefined.identity).toEqual(omitted.identity);
    await gateway.completePrepared(omitted);
    await gateway.completePrepared(explicit);
    await gateway.completePrepared(explicitUndefined);
    for (const [request] of adapter.stream.mock.calls) {
      expect(request).toMatchObject({
        timeout_ms: 120_000,
        max_retries: 2,
        max_repair_attempts: 1,
        retry_base_delay_ms: 250,
      });
      expect(request.temperature).toBeUndefined();
      expect(request.max_tokens).toBeUndefined();
    }
  });

  it('dispatches legal temperature and max token changes exactly as fingerprinted', async () => {
    const adapter = scriptedAdapter([
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());
    const first = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'same request' }],
      temperature: 0,
      max_tokens: 1,
      trace,
    });
    const second = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'same request' }],
      temperature: 2,
      max_tokens: 8_192,
      trace,
    });

    expect(second.identity.request_fingerprint).not.toBe(
      first.identity.request_fingerprint,
    );
    await gateway.completePrepared(first);
    await gateway.completePrepared(second);
    expect(adapter.stream.mock.calls[0]?.[0]).toMatchObject({
      temperature: 0,
      max_tokens: 1,
    });
    expect(adapter.stream.mock.calls[1]?.[0]).toMatchObject({
      temperature: 2,
      max_tokens: 8_192,
    });
  });

  it('executes a prepared handle with the locked adapter and records only its safe identity', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: 'ok', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);
    const prepared = gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'sensitive authoring context' }],
      max_tokens: 20,
      trace,
    });

    await expect(gateway.completePrepared(prepared)).resolves.toMatchObject({
      text: 'ok',
      finish_reason: 'stop',
    });
    expect(adapter.stream).toHaveBeenCalledTimes(1);
    expect(recorder.startAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: prepared.identity.provider,
        model: prepared.identity.model,
        operation_key: prepared.identity.operation_key,
        request_fingerprint: prepared.identity.request_fingerprint,
        prompt_sha256: prepared.identity.prompt_sha256,
      }),
    );
    expect(JSON.stringify(recorder.startAttempt.mock.calls)).not.toContain(
      'sensitive authoring context',
    );
    await expect(gateway.completePrepared(prepared)).rejects.toThrow(
      'MODEL_OPERATION_ALREADY_DISPATCHED',
    );
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it('locks nested schema and tool definitions against mutation after prepare', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          {
            type: 'text_delta',
            text: '{"answer":"ok"}',
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());
    const jsonSchema: Record<string, unknown> = {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    };
    const schema: StructuredOutputSchema<unknown> & {
      id: string;
      version: string;
    } = {
      id: 'grounded-draft',
      version: 'v1',
      json_schema: jsonSchema,
      parse: (value: unknown) => value,
    };
    const toolInputSchema: Record<string, unknown> = {
      type: 'object',
      properties: { query: { type: 'string' } },
    };
    const tool: ToolDefinition & {
      name: string;
      description: string;
    } = {
      name: 'lookup',
      description: 'Look up evidence.',
      input_schema: toolInputSchema,
    };
    const prepared = gateway.prepareSingleDispatch({
      response_mode: 'structured',
      schema,
      tools: [tool],
      tool_choice: 'none',
      messages: [{ role: 'user', content: 'write' }],
      max_repair_attempts: 0,
      trace,
    });
    const preparedIdentity = { ...prepared.identity };

    schema.id = 'mutated-schema';
    schema.version = 'v2';
    schema.parse = () => {
      throw new Error('mutated parser must not execute');
    };
    jsonSchema.properties = { changed: { type: 'number' } };
    tool.name = 'mutated_tool';
    tool.description = 'Mutated description.';
    toolInputSchema.properties = { changed: { type: 'boolean' } };

    await expect(gateway.completePrepared(prepared)).resolves.toMatchObject({
      structured_output: { answer: 'ok' },
    });
    expect(prepared.identity).toEqual(preparedIdentity);
    const dispatched = adapter.stream.mock.calls[0]?.[0];
    expect(dispatched?.schema).toMatchObject({
      id: 'grounded-draft',
      version: 'v1',
      json_schema: {
        properties: { answer: { type: 'string' } },
      },
    });
    expect(dispatched?.tools).toEqual([
      {
        name: 'lookup',
        description: 'Look up evidence.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ]);
  });

  it('retries a 429 before output, persists each attempt and prices usage exactly', async () => {
    const retry = Object.assign(new Error('busy'), {
      status: 429,
      headers: { 'retry-after': '0' },
    });
    const adapter = scriptedAdapter([
      () => throwingStream(retry),
      () =>
        events(
          { type: 'text_delta', text: 'ok', attempt: 0 },
          {
            type: 'usage',
            usage: {
              input_tokens: 100,
              output_tokens: 25,
              total_tokens: 125,
            },
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder, {
      MODEL_PRICING_JSON: JSON.stringify({
        fake: {
          'model-1': {
            input_per_million_usd: '3',
            output_per_million_usd: '15',
          },
        },
      }),
    });

    const result = await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'secret prompt' }],
        max_retries: 2,
        retry_base_delay_ms: 1,
        trace,
      }),
    );

    expect(result).toEqual([
      { type: 'text_delta', text: 'ok', attempt: 4 },
      expect.objectContaining({ type: 'usage', attempt: 4 }),
      expect.objectContaining({
        type: 'completed',
        finish_reason: 'stop',
        attempt: 4,
      }),
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(2);
    expect(recorder.startAttempt).toHaveBeenCalledTimes(2);
    expect(recorder.finishAttempt).toHaveBeenNthCalledWith(
      1,
      'run-1',
      expect.objectContaining({
        status: 'FAILED',
        error_code: 'RATE_LIMITED',
      }),
    );
    expect(recorder.finishAttempt).toHaveBeenNthCalledWith(
      2,
      'run-2',
      expect.objectContaining({
        status: 'SUCCEEDED',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
        },
        cost_usd: '0.000675',
      }),
    );
    expect(recorder.startAttempt.mock.calls[0][0].prompt_sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(recorder.startAttempt.mock.calls)).not.toContain(
      'secret prompt',
    );
  });

  it('does not retry a transient failure after text has been emitted', async () => {
    const adapter = scriptedAdapter([
      () =>
        (async function* () {
          await Promise.resolve();
          yield { type: 'text_delta', text: 'partial', attempt: 0 } as const;
          throw Object.assign(new Error('upstream failed'), { status: 503 });
        })(),
      () => events({ type: 'text_delta', text: 'duplicate', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          max_retries: 3,
          trace,
        }),
      ),
    ).toEqual([
      { type: 'text_delta', text: 'partial', attempt: 3 },
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        }),
        attempt: 3,
      },
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it('retries a silently truncated stream only before any output', async () => {
    const adapter = scriptedAdapter([
      () => events(),
      () =>
        events(
          { type: 'text_delta', text: 'complete', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          max_retries: 1,
          retry_base_delay_ms: 0,
          trace,
        }),
      ),
    ).toEqual([
      { type: 'text_delta', text: 'complete', attempt: 4 },
      expect.objectContaining({
        type: 'completed',
        finish_reason: 'stop',
        attempt: 4,
      }),
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(2);
  });

  it('combines an external abort signal and reports cancellation without retry', async () => {
    const adapter = waitingAdapter();
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);
    const controller = new AbortController();
    const output = collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 3,
        trace,
      }),
    );
    controller.abort(new DOMException('cancelled', 'AbortError'));

    expect(await output).toEqual([
      {
        type: 'error',
        error: {
          code: 'ABORTED',
          message: '模型请求已取消',
          retryable: false,
        },
        attempt: 3,
      },
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
    expect(recorder.finishAttempt).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'CANCELLED', error_code: 'ABORTED' }),
    );
  });

  it('removes its external abort listener after a successful request', async () => {
    let dispatchedSignal: AbortSignal | undefined;
    const adapter: jest.Mocked<ModelAdapter> = {
      provider: 'fake',
      model: 'model-1',
      stream: jest.fn((request: ModelRequest, attempt: number) => {
        dispatchedSignal = request.signal;
        return events({
          type: 'completed',
          finish_reason: 'stop',
          attempt,
        });
      }),
    };
    const controller = new AbortController();
    const gateway = createGateway(adapter, fakeRecorder());

    await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        trace,
      }),
    );

    expect(dispatchedSignal).toBeDefined();
    controller.abort(new DOMException('late cancellation', 'AbortError'));
    expect(dispatchedSignal?.aborted).toBe(false);
  });

  it('times out, cleans up and retries only within the configured bound', async () => {
    const adapter = waitingAdapter();
    const gateway = createGateway(adapter, fakeRecorder());

    const output = await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'write' }],
        timeout_ms: 5,
        max_retries: 1,
        retry_base_delay_ms: 1,
        trace,
      }),
    );

    expect(output).toEqual([
      {
        type: 'error',
        error: {
          code: 'TIMEOUT',
          message: '模型请求超时',
          retryable: true,
        },
        attempt: 4,
      },
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(2);
  });

  it('buffers structured output, runs one targeted repair and returns parsed data', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: '{"title":1}', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
      () =>
        events(
          { type: 'text_delta', text: '{"title":"教材"}', attempt: 0 },
          {
            type: 'usage',
            usage: {
              input_tokens: 5,
              output_tokens: 4,
              total_tokens: 9,
            },
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);
    const schema: StructuredOutputSchema<{ title: string }> = {
      id: 'title-v1',
      json_schema: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
      },
      parse(value) {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { title?: unknown }).title !== 'string'
        ) {
          throw new Error('title must be a string');
        }
        return value as { title: string };
      },
    };

    const output = await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'return JSON' }],
        schema,
        max_repair_attempts: 1,
        trace,
      }),
    );

    expect(output).toEqual([
      expect.objectContaining({ type: 'usage', attempt: 4 }),
      {
        type: 'completed',
        finish_reason: 'stop',
        structured_output: { title: '教材' },
        gateway_audit: {
          repair_attempts: 1,
          response_utf8_bytes: Buffer.byteLength('{"title":"教材"}', 'utf8'),
          final_model_run_id: 'run-2',
        },
        attempt: 4,
      },
    ]);
    expect(recorder.finishAttempt).toHaveBeenNthCalledWith(
      1,
      'run-1',
      expect.objectContaining({
        status: 'FAILED',
        error_code: 'STRUCTURED_OUTPUT_INVALID',
      }),
    );
    expect(adapter.stream).toHaveBeenCalledTimes(2);
    const repairedRequest = adapter.stream.mock.calls[1][0];
    expect(repairedRequest.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('title must be a string'),
      }),
    );
  });

  it('does not blindly retry a terminal structured validation failure', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: 'not-json', attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const schema: StructuredOutputSchema<{ ok: true }> = {
      id: 'never-valid',
      parse() {
        throw new Error('invalid');
      },
    };
    const gateway = createGateway(adapter, fakeRecorder());

    const output = await collect(
      gateway.stream({
        messages: [{ role: 'user', content: 'return JSON' }],
        schema,
        max_repair_attempts: 0,
        max_retries: 3,
        trace,
      }),
    );

    expect(output).toEqual([
      {
        type: 'error',
        error: {
          code: 'STRUCTURED_OUTPUT_INVALID',
          message: '结构化输出校验失败',
          retryable: false,
          details: expect.any(String),
        },
        attempt: 3,
      },
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it('owns completion audit and ignores a forged provider audit', async () => {
    const validJson = '{"title":"教材"}';
    const adapter = scriptedAdapter([
      () =>
        events({ type: 'text_delta', text: validJson, attempt: 0 }, {
          type: 'completed',
          finish_reason: 'stop',
          attempt: 0,
          gateway_audit: {
            repair_attempts: 2,
            response_utf8_bytes: 1,
            final_model_run_id: 'forged-provider-run',
          },
        } as ModelEvent),
    ]);
    const schema: StructuredOutputSchema<{ title: string }> = {
      id: 'title-audit-v1',
      parse(value) {
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { title?: unknown }).title !== 'string'
        ) {
          throw new Error('invalid title');
        }
        return value as { title: string };
      },
    };

    const completion = await createGateway(adapter, fakeRecorder()).complete({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'return JSON' }],
      schema,
      max_repair_attempts: 1,
      trace,
    });

    expect(completion.text).toBe('');
    expect(completion.audit).toEqual({
      repair_attempts: 0,
      response_utf8_bytes: Buffer.byteLength(validJson, 'utf8'),
      final_model_run_id: 'run-1',
    });
  });

  it('does not count network retries as structured repair attempts', async () => {
    const retry = Object.assign(new Error('temporary network failure'), {
      code: 'ECONNRESET',
    });
    const validJson = '{"title":"教材"}';
    const adapter = scriptedAdapter([
      () => throwingStream(retry),
      () =>
        events(
          { type: 'text_delta', text: validJson, attempt: 0 },
          { type: 'completed', finish_reason: 'stop', attempt: 0 },
        ),
    ]);
    const schema: StructuredOutputSchema<{ title: string }> = {
      id: 'title-network-audit-v1',
      parse(value) {
        return value as { title: string };
      },
    };

    const completion = await createGateway(adapter, fakeRecorder()).complete({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'return JSON' }],
      schema,
      max_retries: 1,
      retry_base_delay_ms: 0,
      trace,
    });

    expect(completion.audit).toEqual({
      repair_attempts: 0,
      response_utf8_bytes: Buffer.byteLength(validJson, 'utf8'),
      final_model_run_id: 'run-2',
    });
  });

  it('rejects a tool call in text mode and records the run as failed', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          {
            type: 'tool_call',
            tool_call: {
              id: 'tool-1',
              name: 'lookup',
              arguments_json: '{"query":"教材"}',
              index: 0,
            },
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'tool_call', attempt: 0 },
        ),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          response_mode: 'text',
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'UNEXPECTED_TOOL_CALL',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
    expect(recorder.finishAttempt).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'FAILED',
        error_code: 'UNEXPECTED_TOOL_CALL',
      }),
    );
  });

  it('does not accept structured JSON together with a tool-call completion', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: '{"ok":true}', attempt: 0 },
          {
            type: 'tool_call',
            tool_call: {
              id: 'tool-1',
              name: 'lookup',
              arguments_json: '{}',
              index: 0,
            },
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'tool_call', attempt: 0 },
        ),
    ]);
    const parse = jest.fn((value: unknown) => value as { ok: true });
    const gateway = createGateway(adapter, fakeRecorder());

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'return JSON' }],
          response_mode: 'structured',
          schema: { id: 'ok-v1', parse },
          max_repair_attempts: 0,
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'UNEXPECTED_TOOL_CALL',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
    expect(parse).not.toHaveBeenCalled();
  });

  it('requires a complete allowed tool call in tool mode', async () => {
    const adapter = scriptedAdapter([
      () =>
        events({
          type: 'completed',
          finish_reason: 'tool_call',
          attempt: 0,
        }),
    ]);
    const recorder = fakeRecorder();
    const gateway = createGateway(adapter, recorder);

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'look it up' }],
          response_mode: 'tool',
          tools: [lookupTool],
          tool_choice: 'required',
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'TOOL_CALL_REQUIRED',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
    expect(recorder.finishAttempt).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'FAILED',
        error_code: 'TOOL_CALL_REQUIRED',
      }),
    );
  });

  it('returns only validated tool calls from tool mode', async () => {
    const toolCall = {
      id: 'tool-1',
      name: 'lookup',
      arguments_json: '{"query":"教材"}',
      index: 0,
    };
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'tool_call', tool_call: toolCall, attempt: 0 },
          { type: 'completed', finish_reason: 'tool_call', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    await expect(
      gateway.complete({
        messages: [{ role: 'user', content: 'look it up' }],
        response_mode: 'tool',
        tools: [lookupTool],
        tool_choice: 'required',
        trace,
      }),
    ).resolves.toEqual({
      text: '',
      tool_calls: [toolCall],
      usage: null,
      finish_reason: 'tool_call',
      audit: {
        repair_attempts: 0,
        response_utf8_bytes: 0,
        final_model_run_id: 'run-1',
      },
    });
  });

  it('rejects a tool call whose name is absent from the supplied definitions', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          {
            type: 'tool_call',
            tool_call: {
              id: 'tool-1',
              name: 'summarize',
              arguments_json: '{}',
              index: 0,
            },
            attempt: 0,
          },
          { type: 'completed', finish_reason: 'tool_call', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'look it up' }],
          response_mode: 'tool',
          tools: [lookupTool],
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'UNEXPECTED_TOOL_CALL',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
  });

  it('returns validated tool calls in stable index order', async () => {
    const second = {
      id: 'tool-2',
      name: 'lookup',
      arguments_json: '{"query":"第二"}',
      index: 2,
    };
    const first = {
      id: 'tool-1',
      name: 'lookup',
      arguments_json: '{"query":"第一"}',
      index: 0,
    };
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'tool_call', tool_call: second, attempt: 0 },
          { type: 'tool_call', tool_call: first, attempt: 0 },
          { type: 'completed', finish_reason: 'tool_call', attempt: 0 },
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    await expect(
      gateway.complete({
        messages: [{ role: 'user', content: 'look it up' }],
        response_mode: 'tool',
        tools: [lookupTool],
        tool_choice: 'required',
        trace,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        tool_calls: [first, second],
      }),
    );
  });

  it('throws a typed error when consumers opt into completion collection', async () => {
    const adapter = scriptedAdapter([
      () =>
        throwingStream(
          Object.assign(new Error('bad request'), { status: 400 }),
        ),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    await expect(
      gateway.complete({
        messages: [{ role: 'user', content: 'write' }],
        trace,
      }),
    ).rejects.toBeInstanceOf(ModelGatewayError);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'max_tokens', 'content_filter', 'unknown_reason'])(
    'fails a malformed terminal reason %s instead of accepting partial output',
    async (finishReason) => {
      const adapter = scriptedAdapter([
        () =>
          events({ type: 'text_delta', text: 'partial', attempt: 0 }, {
            type: 'completed',
            finish_reason: finishReason,
            attempt: 0,
          } as never),
      ]);
      const recorder = fakeRecorder();
      const gateway = createGateway(adapter, recorder);

      expect(
        await collect(
          gateway.stream({
            messages: [{ role: 'user', content: 'write' }],
            trace,
          }),
        ),
      ).toEqual([
        { type: 'text_delta', text: 'partial', attempt: 3 },
        {
          type: 'error',
          error: expect.objectContaining({
            code:
              finishReason === 'content_filter'
                ? 'CONTENT_FILTERED'
                : finishReason === 'length' || finishReason === 'max_tokens'
                  ? 'INCOMPLETE_OUTPUT'
                  : 'PROVIDER_ERROR',
            retryable: false,
          }),
          attempt: 3,
        },
      ]);
      expect(recorder.finishAttempt).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'FAILED',
          error_code:
            finishReason === 'content_filter'
              ? 'CONTENT_FILTERED'
              : finishReason === 'length' || finishReason === 'max_tokens'
                ? 'INCOMPLETE_OUTPUT'
                : 'PROVIDER_ERROR',
        }),
      );
    },
  );

  it('does not repair structured output after an incomplete terminal reason', async () => {
    const adapter = scriptedAdapter([
      () =>
        events(
          { type: 'text_delta', text: '{"title":"partial"}', attempt: 0 },
          {
            type: 'completed',
            finish_reason: 'length',
            attempt: 0,
          } as never,
        ),
    ]);
    const recorder = fakeRecorder();
    const parse = jest.fn((value: unknown) => value as { title: string });
    const gateway = createGateway(adapter, recorder);

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'return JSON' }],
          schema: { id: 'title-v1', parse },
          max_repair_attempts: 2,
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'INCOMPLETE_OUTPUT',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
    expect(parse).not.toHaveBeenCalled();
    expect(adapter.stream).toHaveBeenCalledTimes(1);
    expect(recorder.finishAttempt).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        status: 'FAILED',
        error_code: 'INCOMPLETE_OUTPUT',
      }),
    );
  });

  it('honors Retry-After from the installed SDK Headers shape', async () => {
    jest.useFakeTimers();
    try {
      const retry = new OpenAI.RateLimitError(
        429,
        { message: 'busy' },
        'busy',
        new Headers({ 'Retry-After': '1' }),
      );
      const adapter = scriptedAdapter([
        () => throwingStream(retry),
        () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      ]);
      const gateway = createGateway(adapter, fakeRecorder());
      const output = collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          max_retries: 1,
          retry_base_delay_ms: 1,
          trace,
        }),
      );

      await jest.advanceTimersByTimeAsync(999);
      expect(adapter.stream).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(output).resolves.toEqual([
        expect.objectContaining({
          type: 'completed',
          finish_reason: 'stop',
          attempt: 4,
        }),
      ]);
      expect(adapter.stream).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('parses HTTP-date Retry-After and clamps it to the retry ceiling', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
    try {
      const retry = new OpenAI.RateLimitError(
        429,
        { message: 'busy' },
        'busy',
        new Headers({
          'retry-after': 'Sat, 25 Jul 2026 00:02:00 GMT',
        }),
      );
      const adapter = scriptedAdapter([
        () => throwingStream(retry),
        () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      ]);
      const gateway = createGateway(adapter, fakeRecorder());
      const output = collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          max_retries: 1,
          retry_base_delay_ms: 1,
          trace,
        }),
      );

      await jest.advanceTimersByTimeAsync(59_999);
      expect(adapter.stream).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(output).resolves.toEqual([
        expect.objectContaining({
          type: 'completed',
          finish_reason: 'stop',
          attempt: 4,
        }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])(
    'retries an installed SDK connection error with nested cause %s',
    async (code) => {
      const cause = Object.assign(new Error('socket failed'), { code });
      const connection = new OpenAI.APIConnectionError({
        cause,
      });
      const adapter = scriptedAdapter([
        () => throwingStream(connection),
        () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      ]);
      const gateway = createGateway(adapter, fakeRecorder());

      await expect(
        collect(
          gateway.stream({
            messages: [{ role: 'user', content: 'write' }],
            max_retries: 1,
            retry_base_delay_ms: 0,
            trace,
          }),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          type: 'completed',
          finish_reason: 'stop',
          attempt: 4,
        }),
      ]);
      expect(adapter.stream).toHaveBeenCalledTimes(2);
    },
  );

  it('never retries an installed SDK abort error', async () => {
    const adapter = scriptedAdapter([
      () => throwingStream(new OpenAI.APIUserAbortError()),
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    expect(
      await collect(
        gateway.stream({
          messages: [{ role: 'user', content: 'write' }],
          max_retries: 1,
          retry_base_delay_ms: 0,
          trace,
        }),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'ABORTED',
          retryable: false,
        }),
        attempt: 3,
      },
    ]);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      schema: {
        id: 'full schema prompt text',
        parse: (value: unknown) => value,
      },
    },
    {
      trace: {
        ...trace,
        trace_id: 'raw source text must not persist',
      },
    },
  ])('rejects unsafe persisted request identifiers %#', async (override) => {
    const adapter = scriptedAdapter([
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    await expect(
      gateway
        .stream({
          messages: [{ role: 'user', content: 'write' }],
          trace,
          ...override,
        })
        .next(),
    ).rejects.toThrow('安全标识符');
    expect(adapter.stream).not.toHaveBeenCalled();
  });

  it('rejects an unknown response mode at the runtime boundary', async () => {
    const adapter = scriptedAdapter([
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());
    const request = {
      messages: [{ role: 'user' as const, content: 'write' }],
      response_mode: 'freeform',
      trace,
    } as unknown as ModelRequest;

    await expect(gateway.stream(request).next()).rejects.toThrow(
      'response_mode',
    );
    expect(adapter.stream).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing definitions',
      {
        response_mode: 'tool',
      },
    ],
    [
      'duplicate names',
      {
        response_mode: 'tool',
        tools: [lookupTool, lookupTool],
      },
    ],
    [
      'unsafe name',
      {
        response_mode: 'tool',
        tools: [{ ...lookupTool, name: 'lookup source text' }],
      },
    ],
    [
      'empty description',
      {
        response_mode: 'tool',
        tools: [{ ...lookupTool, description: '' }],
      },
    ],
    [
      'non-object schema',
      {
        response_mode: 'tool',
        tools: [{ ...lookupTool, input_schema: [] }],
      },
    ],
    [
      'extra arbitrary field',
      {
        response_mode: 'tool',
        tools: [{ ...lookupTool, secret_prompt: 'do not persist this' }],
      },
    ],
    [
      'unknown specific choice',
      {
        response_mode: 'tool',
        tools: [lookupTool],
        tool_choice: { name: 'missing' },
      },
    ],
    [
      'none choice in required tool mode',
      {
        response_mode: 'tool',
        tools: [lookupTool],
        tool_choice: 'none',
      },
    ],
    [
      'definitions outside tool mode without none choice',
      {
        response_mode: 'text',
        tools: [lookupTool],
      },
    ],
  ])('rejects invalid tool request contract: %s', async (_name, override) => {
    const adapter = scriptedAdapter([
      () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
    ]);
    const gateway = createGateway(adapter, fakeRecorder());

    await expect(
      gateway
        .stream({
          messages: [{ role: 'user', content: 'look it up' }],
          trace,
          ...override,
        } as ModelRequest)
        .next(),
    ).rejects.toThrow(/tool|工具/);
    expect(adapter.stream).not.toHaveBeenCalled();
  });

  it.each([
    [
      'description',
      {
        ...lookupTool,
        description: 'x'.repeat(1_025),
      },
    ],
    [
      'schema',
      {
        ...lookupTool,
        input_schema: {
          type: 'object',
          description: 'x'.repeat(40_000),
        },
      },
    ],
  ])(
    'rejects an oversized tool %s before provider dispatch',
    async (_field, tool) => {
      const adapter = scriptedAdapter([
        () => events({ type: 'completed', finish_reason: 'stop', attempt: 0 }),
      ]);
      const gateway = createGateway(adapter, fakeRecorder());

      await expect(
        gateway
          .stream({
            messages: [{ role: 'user', content: 'look it up' }],
            response_mode: 'tool',
            tools: [tool],
            trace,
          })
          .next(),
      ).rejects.toThrow(/tool|工具/);
      expect(adapter.stream).not.toHaveBeenCalled();
    },
  );
});

function createGateway(
  adapter: jest.Mocked<ModelAdapter>,
  recorder: ReturnType<typeof fakeRecorder>,
  config: Record<string, string> = {},
): ModelGateway {
  const factory = {
    createProvider: jest.fn().mockReturnValue(adapter),
  } as unknown as LLMFactory;
  const configService = {
    get: <T>(key: string, fallback?: T) =>
      (config[key] as T | undefined) ?? fallback,
  } as ConfigService;
  return new ModelGateway(
    factory,
    recorder as unknown as ModelRunRecorder,
    new ModelPricingCatalog(configService),
  );
}

function scriptedAdapter(
  scripts: Array<() => AsyncIterable<ModelEvent>>,
): jest.Mocked<ModelAdapter> {
  let index = 0;
  return {
    provider: 'fake',
    model: 'model-1',
    stream: jest.fn(() => {
      const script = scripts[index++];
      if (!script) throw new Error('unexpected attempt');
      return script();
    }),
  };
}

function waitingAdapter(): jest.Mocked<ModelAdapter> {
  return {
    provider: 'fake',
    model: 'model-1',
    stream: jest.fn((request: ModelRequest, attempt: number) =>
      (async function* () {
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = () => reject(abortReason(request.signal));
          if (request.signal?.aborted) rejectAbort();
          else
            request.signal?.addEventListener('abort', rejectAbort, {
              once: true,
            });
        });
        yield { type: 'completed', finish_reason: 'stop', attempt };
      })(),
    ),
  };
}

function fakeRecorder() {
  let counter = 0;
  return {
    startAttempt: jest.fn(() => Promise.resolve({ id: `run-${++counter}` })),
    finishAttempt: jest.fn(() => Promise.resolve()),
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('aborted', 'AbortError');
}

function events(...items: ModelEvent[]): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* items;
    },
  };
}

function throwingStream(error: unknown): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      throw error;
      yield { type: 'completed', finish_reason: 'stop', attempt: 0 };
    },
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) result.push(item);
  return result;
}
