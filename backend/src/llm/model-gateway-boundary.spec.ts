/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import { getEventListeners } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import type { LLMFactory } from './llm.factory.js';
import { ModelGateway } from './model-gateway.js';
import { ModelPricingCatalog, type ModelRunRecorder } from './model-pricing.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelOperationIdentity,
  ModelRequest,
  ModelUsage,
} from './model-types.js';

type SafeReflectApply = <TThis, TArgs extends readonly unknown[], TResult>(
  target: (this: TThis, ...args: TArgs) => TResult,
  thisArgument: TThis,
  argumentsList: TArgs,
) => TResult;
type SafeReflectGet = (
  target: object,
  propertyKey: PropertyKey,
  receiver?: unknown,
) => unknown;
type SafeReflectGetPrototypeOf = (target: object) => object | null;
type SafeReflectOwnKeys = (target: object) => PropertyKey[];

const validTrace = {
  workflow_job_id: '11111111-1111-4111-8111-111111111111',
  node: 'draft',
  attempt: 1,
} as const;

const validSchema = {
  id: 'grounded-draft',
  version: 'v1',
  json_schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
  },
  parse: (value: unknown) => value,
};

// Test-only trusted handle used to abort the caller controller while its
// prototype method is under attack.
const TEST_NATIVE_ABORT_CONTROLLER_ABORT = AbortController.prototype.abort;
const TEST_NATIVE_ABORT_CONTROLLER = AbortController;
const TEST_NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER =
  Object.getOwnPropertyDescriptor(
    TEST_NATIVE_ABORT_CONTROLLER.prototype,
    'signal',
  )!.get!;
const TEST_NATIVE_REFLECT = Reflect;
const TEST_NATIVE_REFLECT_APPLY = Reflect.apply as SafeReflectApply;
const TEST_NATIVE_REFLECT_GET = Reflect.get as SafeReflectGet;
const TEST_NATIVE_REFLECT_GET_PROTOTYPE_OF =
  Reflect.getPrototypeOf as SafeReflectGetPrototypeOf;
const TEST_NATIVE_REFLECT_OWN_KEYS = Reflect.ownKeys as SafeReflectOwnKeys;

type RequestEntrypoint = {
  name: string;
  invoke(gateway: ModelGateway, request: ModelRequest): Promise<unknown>;
};

const requestEntrypoints: readonly RequestEntrypoint[] = [
  {
    name: 'prepareSingleDispatch',
    invoke: (gateway, request) =>
      Promise.resolve().then(() => gateway.prepareSingleDispatch(request)),
  },
  {
    name: 'stream',
    invoke: (gateway, request) => gateway.stream(request).next(),
  },
  {
    name: 'complete',
    invoke: (gateway, request) => gateway.complete(request),
  },
  {
    name: 'estimateWorstCaseCost',
    invoke: (gateway, request) =>
      Promise.resolve().then(() => gateway.estimateWorstCaseCost(request)),
  },
];

type InvalidRequestCase = {
  name: string;
  request(): ModelRequest;
};

const invalidRequestCases: readonly InvalidRequestCase[] = [
  {
    name: 'null request',
    request: () => null as unknown as ModelRequest,
  },
  {
    name: 'request with an extra field',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        secret: 'not part of the contract',
      }) as unknown as ModelRequest,
  },
  {
    name: 'request Proxy that changes temperature after validation',
    request: () => {
      let temperatureReads = 0;
      return new Proxy(
        {
          messages: [{ role: 'user' as const, content: 'write' }],
          temperature: 0,
        },
        {
          get: (target, property) => {
            if (property === 'temperature') {
              temperatureReads += 1;
              return temperatureReads <= 6 ? 0 : { unvalidated: true };
            }
            return property === 'messages' ? target.messages : undefined;
          },
        },
      ) as ModelRequest;
    },
  },
  {
    name: 'request with a symbol key',
    request: () => {
      const request = {
        messages: [{ role: 'user', content: 'write' }],
      } as ModelRequest & Record<PropertyKey, unknown>;
      request[Symbol('hidden')] = true;
      return request;
    },
  },
  {
    name: 'idempotency key object that stringifies to a digest',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        idempotency_key: {
          toString: () => 'a'.repeat(64),
        },
      }) as unknown as ModelRequest,
  },
  {
    name: 'null message',
    request: () =>
      ({
        messages: [null],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message with an extra field',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write', hidden: true }],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message with an invalid role',
    request: () =>
      ({
        messages: [{ role: 'operator', content: 'write' }],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message with a role object that stringifies to user',
    request: () =>
      ({
        messages: [
          {
            role: { toString: () => 'user' },
            content: 'write',
          },
        ],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message with non-string content',
    request: () =>
      ({
        messages: [{ role: 'user', content: null }],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message with oversized content',
    request: () => ({
      messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }],
    }),
  },
  {
    name: 'too many messages',
    request: () => ({
      messages: Array.from({ length: 257 }, () => ({
        role: 'user' as const,
        content: 'x',
      })),
    }),
  },
  {
    name: 'messages exceed the total byte budget',
    request: () => ({
      messages: Array.from({ length: 5 }, () => ({
        role: 'user' as const,
        content: 'x'.repeat(1_048_576),
      })),
    }),
  },
  {
    name: 'message Array subclass with an overridden map',
    request: () => {
      class EvilMessages extends Array<ModelRequest['messages'][number]> {
        override map(): never[] {
          return [
            { role: 'operator', content: { unvalidated: true } },
          ] as unknown as never[];
        }
      }
      return {
        messages: new EvilMessages({
          role: 'user',
          content: 'write',
        }),
      };
    },
  },
  {
    name: 'message name has the wrong type',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write', name: null }],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message name is unsafe',
    request: () => ({
      messages: [{ role: 'user', content: 'write', name: 'raw source text' }],
    }),
  },
  {
    name: 'message tool_call_id has the wrong type',
    request: () =>
      ({
        messages: [{ role: 'tool', content: 'result', tool_call_id: {} }],
      }) as unknown as ModelRequest,
  },
  {
    name: 'message tool_call_id is unsafe',
    request: () => ({
      messages: [
        { role: 'tool', content: 'result', tool_call_id: 'raw call id' },
      ],
    }),
  },
  {
    name: 'schema has an extra field',
    request: () =>
      ({
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, hidden: true },
      }) as unknown as ModelRequest,
  },
  {
    name: 'schema version is null',
    request: () =>
      ({
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, version: null },
      }) as unknown as ModelRequest,
  },
  {
    name: 'schema version is unsafe',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: { ...validSchema, version: 'raw schema version' },
    }),
  },
  {
    name: 'schema JSON contains NaN',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: {
        ...validSchema,
        json_schema: { type: 'number', maximum: Number.NaN },
      },
    }),
  },
  {
    name: 'schema JSON contains a function',
    request: () =>
      ({
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: {
          ...validSchema,
          json_schema: { type: 'object', transform: () => undefined },
        },
      }) as unknown as ModelRequest,
  },
  {
    name: 'schema JSON contains a symbol value',
    request: () =>
      ({
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: {
          ...validSchema,
          json_schema: { type: 'object', hidden: Symbol('hidden') },
        },
      }) as unknown as ModelRequest,
  },
  {
    name: 'schema JSON contains a symbol key',
    request: () => {
      const jsonSchema: Record<PropertyKey, unknown> = { type: 'object' };
      jsonSchema[Symbol('hidden')] = true;
      return {
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, json_schema: jsonSchema },
      } as ModelRequest;
    },
  },
  {
    name: 'schema JSON is cyclic',
    request: () => {
      const jsonSchema: Record<string, unknown> = { type: 'object' };
      jsonSchema.self = jsonSchema;
      return {
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, json_schema: jsonSchema },
      };
    },
  },
  {
    name: 'schema JSON contains a prototype-pollution key',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: {
        ...validSchema,
        json_schema: JSON.parse(
          '{"type":"object","__proto__":{"polluted":true}}',
        ) as Record<string, unknown>,
      },
    }),
  },
  {
    name: 'schema JSON contains an accessor',
    request: () => {
      const jsonSchema: Record<string, unknown> = { type: 'object' };
      Object.defineProperty(jsonSchema, 'secret', {
        enumerable: true,
        get: () => 'read',
      });
      return {
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, json_schema: jsonSchema },
      };
    },
  },
  {
    name: 'schema JSON exceeds the depth limit',
    request: () => {
      const jsonSchema: Record<string, unknown> = { type: 'object' };
      let current = jsonSchema;
      for (let index = 0; index < 33; index += 1) {
        const child: Record<string, unknown> = {};
        current.child = child;
        current = child;
      }
      return {
        response_mode: 'structured',
        messages: [{ role: 'user', content: 'write' }],
        schema: { ...validSchema, json_schema: jsonSchema },
      };
    },
  },
  {
    name: 'schema JSON exceeds the byte limit',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: {
        ...validSchema,
        json_schema: {
          type: 'object',
          description: 'x'.repeat(262_145),
        },
      },
    }),
  },
  {
    name: 'schema JSON exceeds the key limit',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: {
        ...validSchema,
        json_schema: Object.fromEntries([
          ['type', 'object'],
          ...Array.from({ length: 8_193 }, (_unused, index) => [
            `k${index}`,
            true,
          ]),
        ]),
      },
    }),
  },
  {
    name: 'schema JSON has colliding normalized keys',
    request: () => ({
      response_mode: 'structured',
      messages: [{ role: 'user', content: 'write' }],
      schema: {
        ...validSchema,
        json_schema: {
          type: 'object',
          '\u00e9': true,
          'e\u0301': false,
        },
      },
    }),
  },
  {
    name: 'trace is null',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        trace: null,
      }) as unknown as ModelRequest,
  },
  {
    name: 'trace has an extra field',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        trace: { ...validTrace, hidden: true },
      }) as unknown as ModelRequest,
  },
  {
    name: 'trace workflow_job_id is null',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        trace: { ...validTrace, workflow_job_id: null },
      }) as unknown as ModelRequest,
  },
  {
    name: 'trace workflow_job_id is unsafe',
    request: () => ({
      messages: [{ role: 'user', content: 'write' }],
      trace: { ...validTrace, workflow_job_id: 'raw workflow job id' },
    }),
  },
  {
    name: 'tool input schema contains a cycle',
    request: () => {
      const inputSchema: Record<string, unknown> = { type: 'object' };
      inputSchema.self = inputSchema;
      return {
        response_mode: 'tool',
        messages: [{ role: 'user', content: 'look up' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up evidence.',
            input_schema: inputSchema,
          },
        ],
      };
    },
  },
  {
    name: 'tool definition with an accessor',
    request: () => {
      const tool = Object.defineProperties(
        {},
        {
          name: {
            enumerable: true,
            get: () => 'lookup',
          },
          description: {
            enumerable: true,
            value: 'Look up evidence.',
          },
          input_schema: {
            enumerable: true,
            value: { type: 'object' },
          },
        },
      );
      return {
        response_mode: 'tool',
        messages: [{ role: 'user', content: 'look up' }],
        tools: [tool],
      } as unknown as ModelRequest;
    },
  },
  {
    name: 'tool choice contains an extra field',
    request: () =>
      ({
        response_mode: 'tool',
        messages: [{ role: 'user', content: 'look up' }],
        tools: [
          {
            name: 'lookup',
            description: 'Look up evidence.',
            input_schema: { type: 'object' },
          },
        ],
        tool_choice: { name: 'lookup', hidden: true },
      }) as unknown as ModelRequest,
  },
  {
    name: 'plain-object AbortSignal duck type',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        signal: {
          aborted: false,
          reason: undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        },
      }) as unknown as ModelRequest,
  },
  {
    name: 'native AbortSignal with an overridden listener',
    request: () => {
      const signal = new AbortController().signal;
      Object.defineProperty(signal, 'addEventListener', {
        configurable: true,
        value: () => {
          throw new Error('tampered listener');
        },
      });
      return {
        messages: [{ role: 'user', content: 'write' }],
        signal,
      };
    },
  },
  ...(
    ['aborted', 'reason', 'removeEventListener', 'throwIfAborted'] as const
  ).map((key) => ({
    name: `native AbortSignal with an own ${key}`,
    request: () => {
      const signal = new AbortController().signal;
      Object.defineProperty(signal, key, {
        configurable: true,
        value: key === 'aborted' ? false : () => undefined,
      });
      return {
        messages: [{ role: 'user' as const, content: 'write' }],
        signal,
      };
    },
  })),
  {
    name: 'Proxy around a native AbortSignal',
    request: () => ({
      messages: [{ role: 'user', content: 'write' }],
      signal: new Proxy(new AbortController().signal, {}),
    }),
  },
  {
    name: 'AbortSignal toStringTag spoof',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        signal: { [Symbol.toStringTag]: 'AbortSignal', aborted: false },
      }) as unknown as ModelRequest,
  },
  {
    name: 'object with AbortSignal prototype but no internal slot',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        signal: Object.create(AbortSignal.prototype),
      }) as unknown as ModelRequest,
  },
  {
    name: 'nested invalid numeric value',
    request: () =>
      ({
        messages: [{ role: 'user', content: 'write' }],
        max_tokens: Number.NaN,
      }) as ModelRequest,
  },
];

describe('ModelGateway closed public runtime boundary', () => {
  it.each(
    requestEntrypoints.flatMap((entrypoint) =>
      invalidRequestCases.map((invalid) => ({
        entrypoint: entrypoint.name,
        invalid: invalid.name,
        invoke: entrypoint.invoke,
        request: invalid.request,
      })),
    ),
  )(
    '$entrypoint rejects $invalid before every model dependency',
    async ({ invoke, request }) => {
      const harness = createHarness();

      await expect(invoke(harness.gateway, request())).rejects.toThrow();
      expect(harness.factory.createProvider).not.toHaveBeenCalled();
      expect(harness.adapter.stream).not.toHaveBeenCalled();
      expect(harness.recorder.startAttempt).not.toHaveBeenCalled();
      expect(harness.recorder.finishAttempt).not.toHaveBeenCalled();
      expect(harness.recorder.findOperationState).not.toHaveBeenCalled();
      expect(harness.pricingCalculate).not.toHaveBeenCalled();
    },
  );

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
    ['max_tokens', 1_000_001],
    ['max_tokens', Number.MAX_SAFE_INTEGER + 1],
    ['timeout_ms', null],
    ['timeout_ms', Number.NaN],
    ['timeout_ms', Number.POSITIVE_INFINITY],
    ['timeout_ms', Number.NEGATIVE_INFINITY],
    ['timeout_ms', '1000'],
    ['timeout_ms', 0],
    ['timeout_ms', -1],
    ['timeout_ms', 1.5],
    ['timeout_ms', 2_147_483_648],
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
    'all request entrypoints reject invalid %s=%p before dependency I/O',
    async (field, value) => {
      for (const entrypoint of requestEntrypoints) {
        const harness = createHarness();
        const request = {
          messages: [{ role: 'user' as const, content: 'write' }],
          [field]: value,
        } as unknown as ModelRequest;

        await expect(
          entrypoint.invoke(harness.gateway, request),
        ).rejects.toThrow();
        expect(harness.factory.createProvider).not.toHaveBeenCalled();
        expect(harness.adapter.stream).not.toHaveBeenCalled();
        expect(harness.recorder.startAttempt).not.toHaveBeenCalled();
        expect(harness.pricingCalculate).not.toHaveBeenCalled();
      }
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
    4_294_967_289,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'all request entrypoints reject invalid trace.attempt=%p before dependency I/O',
    async (attempt) => {
      for (const entrypoint of requestEntrypoints) {
        const harness = createHarness();
        const request = {
          messages: [{ role: 'user' as const, content: 'write' }],
          trace: { ...validTrace, attempt },
        } as unknown as ModelRequest;

        await expect(
          entrypoint.invoke(harness.gateway, request),
        ).rejects.toThrow();
        expect(harness.factory.createProvider).not.toHaveBeenCalled();
        expect(harness.adapter.stream).not.toHaveBeenCalled();
        expect(harness.recorder.startAttempt).not.toHaveBeenCalled();
        expect(harness.pricingCalculate).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['undefined', undefined],
    ['string', 'invalid'],
    ['array', []],
    [
      'extra key',
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        hidden: true,
      },
    ],
    [
      'NaN input',
      { input_tokens: Number.NaN, output_tokens: 1, total_tokens: 1 },
    ],
    [
      'infinite output',
      {
        input_tokens: 1,
        output_tokens: Number.POSITIVE_INFINITY,
        total_tokens: 1,
      },
    ],
    ['negative input', { input_tokens: -1, output_tokens: 1, total_tokens: 0 }],
    [
      'fractional output',
      { input_tokens: 1, output_tokens: 0.5, total_tokens: 1.5 },
    ],
    [
      'unsafe total',
      {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    [
      'inconsistent total',
      { input_tokens: 1, output_tokens: 1, total_tokens: 3 },
    ],
    [
      'cached input exceeds input',
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cached_input_tokens: 2,
      },
    ],
    [
      'invalid cache creation count',
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        cache_creation_input_tokens: Number.NaN,
      },
    ],
    [
      'invalid reasoning count',
      {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        reasoning_tokens: -1,
      },
    ],
  ])(
    'calculateUsageCost rejects %s usage before dependency I/O',
    (_name, usage) => {
      const harness = createHarness();

      expect(() =>
        harness.gateway.calculateUsageCost(usage as unknown as ModelUsage),
      ).toThrow();
      expect(harness.factory.createProvider).not.toHaveBeenCalled();
      expect(harness.adapter.stream).not.toHaveBeenCalled();
      expect(harness.recorder.startAttempt).not.toHaveBeenCalled();
      expect(harness.pricingCalculate).not.toHaveBeenCalled();
    },
  );

  it('calculateUsageCost accepts null without dependencies and canonicalizes negative zero', () => {
    const nullHarness = createHarness();
    expect(nullHarness.gateway.calculateUsageCost(null)).toBeNull();
    expect(nullHarness.factory.createProvider).not.toHaveBeenCalled();
    expect(nullHarness.pricingCalculate).not.toHaveBeenCalled();

    const zeroHarness = createHarness();
    zeroHarness.gateway.calculateUsageCost({
      input_tokens: -0,
      output_tokens: -0,
      total_tokens: -0,
      cached_input_tokens: -0,
      cache_creation_input_tokens: -0,
      reasoning_tokens: -0,
    });
    expect(zeroHarness.factory.createProvider).toHaveBeenCalledTimes(1);
    expect(zeroHarness.pricingCalculate).toHaveBeenCalledWith(
      'fake',
      'model-1',
      {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_tokens: 0,
      },
    );
  });

  it.each([
    ['empty workflow id', '', 'a'.repeat(64)],
    ['unsafe workflow id', 'raw workflow id', 'a'.repeat(64)],
    ['invalid operation string', validTrace.workflow_job_id, 'operation'],
    ['null operation', validTrace.workflow_job_id, null],
    [
      'operation identity with wrong version',
      validTrace.workflow_job_id,
      operationIdentity({ version: 'model-operation.v2' }),
    ],
    [
      'operation identity with extra field',
      validTrace.workflow_job_id,
      { ...operationIdentity(), hidden: true },
    ],
    [
      'operation identity with invalid provider',
      validTrace.workflow_job_id,
      operationIdentity({ provider: 'raw provider' }),
    ],
    [
      'operation identity with invalid digest',
      validTrace.workflow_job_id,
      operationIdentity({ request_fingerprint: 'A'.repeat(64) }),
    ],
    [
      'operation identity with invalid nullable schema version',
      validTrace.workflow_job_id,
      operationIdentity({ schema_version: '' }),
    ],
  ])(
    'inspectOperation rejects %s before recorder I/O',
    async (_name, workflowJobId, operation) => {
      const harness = createHarness();

      await expect(
        harness.gateway.inspectOperation(
          workflowJobId,
          operation as string | ModelOperationIdentity,
        ),
      ).rejects.toThrow();
      expect(harness.factory.createProvider).not.toHaveBeenCalled();
      expect(harness.recorder.findOperationState).not.toHaveBeenCalled();
      expect(harness.recorder.startAttempt).not.toHaveBeenCalled();
      expect(harness.pricingCalculate).not.toHaveBeenCalled();
    },
  );

  it('direct and prepared dispatch share canonical defaults, strings and negative zero', async () => {
    const harness = createHarness();
    const decomposed = 'Cafe\u0301';
    const composed = 'Caf\u00e9';
    const omitted = {
      messages: [{ role: 'user' as const, content: decomposed }],
      trace: validTrace,
    };
    const explicitDefaults = {
      messages: [{ role: 'user' as const, content: composed }],
      response_mode: 'text' as const,
      timeout_ms: 120_000,
      max_retries: 2,
      max_repair_attempts: 1,
      retry_base_delay_ms: 250,
      trace: validTrace,
    };

    await harness.gateway.complete(omitted);
    await harness.gateway.complete(explicitDefaults);
    await harness.gateway.completePrepared(
      harness.gateway.prepareSingleDispatch(omitted),
    );

    const canonicalDefault = {
      messages: [{ role: 'user', content: composed }],
      response_mode: 'text',
      timeout_ms: 120_000,
      max_retries: 2,
      max_repair_attempts: 1,
      retry_base_delay_ms: 250,
      trace: validTrace,
    };
    for (const call of harness.adapter.stream.mock.calls.slice(0, 3)) {
      expect(dispatchSemantics(call[0])).toEqual(canonicalDefault);
    }

    const negativeZero = {
      messages: [{ role: 'user' as const, content: 'same' }],
      temperature: -0,
      max_retries: -0,
      max_repair_attempts: -0,
      retry_base_delay_ms: -0,
      trace: validTrace,
    };
    const positiveZero = {
      ...negativeZero,
      temperature: 0,
      max_retries: 0,
      max_repair_attempts: 0,
      retry_base_delay_ms: 0,
    };
    const preparedNegative =
      harness.gateway.prepareSingleDispatch(negativeZero);
    const preparedPositive =
      harness.gateway.prepareSingleDispatch(positiveZero);
    expect(preparedNegative.identity).toEqual(preparedPositive.identity);

    await harness.gateway.complete(negativeZero);
    await harness.gateway.completePrepared(preparedNegative);
    await harness.gateway.completePrepared(preparedPositive);
    const zeroDispatches = harness.adapter.stream.mock.calls
      .slice(3)
      .map(([request]) => dispatchSemantics(request));
    expect(zeroDispatches).toEqual([
      zeroDispatches[0],
      zeroDispatches[0],
      zeroDispatches[0],
    ]);
    for (const dispatch of zeroDispatches) {
      expect(dispatch).toMatchObject({
        temperature: 0,
        max_retries: 0,
        max_repair_attempts: 0,
        retry_base_delay_ms: 0,
      });
    }
  });

  it('accepts a real AbortSignal while rejecting prototype and tag spoofing', async () => {
    const harness = createHarness();
    const controller = new AbortController();

    await expect(
      harness.gateway.complete({
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ finish_reason: 'stop' });
    expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
  });

  it.each(['direct', 'prepared'] as const)(
    '%s dispatch never calls AbortSignal properties added during recorder persistence',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      let releaseStart!: (value: { id: string }) => void;
      const startGate = new Promise<{ id: string }>((resolve) => {
        releaseStart = resolve;
      });
      harness.recorder.startAttempt.mockReturnValueOnce(startGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.startAttempt.mock.calls.length === 1,
      );
      const attacker = jest.fn(() => {
        throw new Error('caller AbortSignal property executed');
      });
      Object.defineProperties(controller.signal, {
        aborted: { configurable: true, get: attacker },
        reason: { configurable: true, get: attacker },
        addEventListener: { configurable: true, value: attacker },
        removeEventListener: { configurable: true, value: attacker },
      });
      releaseStart({ id: 'run-1' });

      await expect(completion).resolves.toMatchObject({
        finish_reason: 'stop',
      });
      expect(attacker).not.toHaveBeenCalled();
    },
  );

  it('prepared dispatch never consults AbortSignal properties added before dispatch', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const prepared = harness.gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'write' }],
      signal: controller.signal,
      trace: validTrace,
    });
    const attacker = jest.fn(() => {
      throw new Error('caller AbortSignal property executed');
    });
    Object.defineProperties(controller.signal, {
      aborted: { configurable: true, get: attacker },
      reason: { configurable: true, get: attacker },
      addEventListener: { configurable: true, value: attacker },
      removeEventListener: { configurable: true, value: attacker },
    });

    await expect(
      harness.gateway.completePrepared(prepared),
    ).resolves.toMatchObject({
      finish_reason: 'stop',
    });
    expect(attacker).not.toHaveBeenCalled();
  });

  it.each(['direct', 'prepared'] as const)(
    '%s dispatch retains captured EventTarget intrinsics after prototype tampering',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      let releaseStart!: (value: { id: string }) => void;
      const startGate = new Promise<{ id: string }>((resolve) => {
        releaseStart = resolve;
      });
      harness.recorder.startAttempt.mockReturnValueOnce(startGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.startAttempt.mock.calls.length === 1,
      );
      const originalRemove = Object.getOwnPropertyDescriptor(
        EventTarget.prototype,
        'removeEventListener',
      )!;
      const attacker = jest.fn(() => {
        throw new Error('tampered EventTarget prototype executed');
      });
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
        configurable: true,
        writable: true,
        value: attacker,
      });
      try {
        releaseStart({ id: 'run-1' });
        await expect(completion).resolves.toMatchObject({
          finish_reason: 'stop',
        });
        expect(attacker).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(
          EventTarget.prototype,
          'removeEventListener',
          originalRemove,
        );
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s dispatch preserves the native abort reason across persistence-time tampering',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      const expectedReason = new DOMException('cancelled', 'AbortError');
      const forgedReason = new DOMException('forged', 'AbortError');
      let providerReason: unknown;
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                providerReason = request.signal?.reason;
                reject(
                  providerReason instanceof Error
                    ? providerReason
                    : new Error('missing abort reason'),
                );
              };
              if (request.signal?.aborted) onAbort();
              else
                request.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
            });
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      let releaseStart!: (value: { id: string }) => void;
      const startGate = new Promise<{ id: string }>((resolve) => {
        releaseStart = resolve;
      });
      harness.recorder.startAttempt.mockReturnValueOnce(startGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.startAttempt.mock.calls.length === 1,
      );
      const attacker = jest.fn(() => forgedReason);
      Object.defineProperties(controller.signal, {
        aborted: { configurable: true, get: () => false },
        reason: { configurable: true, get: attacker },
        addEventListener: { configurable: true, value: attacker },
        removeEventListener: { configurable: true, value: attacker },
      });
      const abortMutation = tamperAbortControllerPrototype();
      try {
        abortCallerController(controller, expectedReason);
        releaseStart({ id: 'run-1' });

        await expect(completion).rejects.toMatchObject({
          modelError: { code: 'ABORTED' },
        });
        expect(providerReason).toBe(expectedReason);
        expect(attacker).not.toHaveBeenCalled();
        expect(abortMutation.attacker).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        abortMutation.restore();
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s dispatch ignores post-import AbortController constructor and signal getter tampering',
    async (entrypoint) => {
      const harness = createHarness();
      const callerController = new TEST_NATIVE_ABORT_CONTROLLER();
      const callerSignal = readTestNativeControllerSignal(callerController);
      const expectedReason = new DOMException(
        'cancelled with constructor sources under attack',
        'AbortError',
      );
      let providerReason: unknown;
      let providerReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        providerReady = resolve;
      });
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                providerReason = request.signal?.reason;
                reject(
                  providerReason instanceof Error
                    ? providerReason
                    : new Error('missing abort reason'),
                );
              };
              if (request.signal?.aborted) onAbort();
              else {
                request.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
                providerReady();
              }
            });
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: callerSignal,
        max_retries: 1,
        retry_base_delay_ms: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const mutation = tamperAbortControllerConstructionSources();
      try {
        const completion =
          entrypoint === 'prepared'
            ? harness.gateway.completePrepared(prepared!)
            : harness.gateway.complete(request);
        await ready;
        abortCallerController(callerController, expectedReason);

        await expect(completion).rejects.toMatchObject({
          modelError: { code: 'ABORTED' },
        });
        expect(providerReason).toBe(expectedReason);
        expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
        expect(mutation.constructorAttacker).not.toHaveBeenCalled();
        expect(mutation.signalGetterAttacker).not.toHaveBeenCalled();
        expect(getEventListeners(callerSignal, 'abort')).toHaveLength(0);
      } finally {
        mutation.restore();
      }
    },
  );

  it('fails closed when AbortController is already replaced before module loading', () => {
    const mutation = tamperGlobalAbortControllerConstructor();
    try {
      expect(() => {
        jest.isolateModules(() => {
          jest.requireActual('./model-gateway.js');
        });
      }).toThrow('缺少原生 signal getter');
      expect(mutation.constructorAttacker).not.toHaveBeenCalled();
    } finally {
      mutation.restore();
    }
  });

  it.each(
    (['direct', 'prepared'] as const).flatMap((entrypoint) =>
      (['apply', 'global'] as const).map((mode) => ({ entrypoint, mode })),
    ),
  )(
    '$entrypoint dispatch ignores post-import $mode Reflect tampering before execution',
    async ({ entrypoint, mode }) => {
      const harness = createHarness();
      const callerController = new TEST_NATIVE_ABORT_CONTROLLER();
      const callerSignal = readTestNativeControllerSignal(callerController);
      const expectedReason = new DOMException(
        'cancelled with Reflect under attack',
        'AbortError',
      );
      let providerReason: unknown;
      let providerReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        providerReady = resolve;
      });
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                providerReason = request.signal?.reason;
                reject(
                  providerReason instanceof Error
                    ? providerReason
                    : new Error('missing abort reason'),
                );
              };
              if (request.signal?.aborted) onAbort();
              else {
                request.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
                providerReady();
              }
            });
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: callerSignal,
        max_retries: 1,
        retry_base_delay_ms: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const mutation = tamperReflectRuntime(mode);
      let caught: unknown;
      try {
        const completion =
          entrypoint === 'prepared'
            ? harness.gateway.completePrepared(prepared!)
            : harness.gateway.complete(request);
        await ready;
        abortCallerController(callerController, expectedReason);
        try {
          await completion;
        } catch (error) {
          caught = error;
        }
      } finally {
        mutation.restore();
      }

      expect(caught).toMatchObject({
        modelError: { code: 'ABORTED' },
      });
      expect(providerReason).toBe(expectedReason);
      expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
      expect(mutation.attackerCalls()).toBe(0);
      expect(getEventListeners(callerSignal, 'abort')).toHaveLength(0);
    },
  );

  it.each(
    (['direct', 'prepared'] as const).flatMap((entrypoint) =>
      (['start', 'provider', 'finish', 'retry', 'timeout'] as const).map(
        (window) => ({ entrypoint, window }),
      ),
    ),
  )(
    '$entrypoint dispatch ignores whole-Reflect replacement during $window window',
    async ({ entrypoint, window }) => {
      await runReflectAwaitWindowAttack(entrypoint, window);
    },
  );

  it('fails closed when Reflect.apply is already replaced before module loading', () => {
    const mutation = tamperReflectRuntime('apply');
    try {
      expect(() => {
        jest.isolateModules(() => {
          jest.requireActual('./model-gateway.js');
        });
      }).toThrow('缺少原生 Reflect.apply method');
    } finally {
      mutation.restore();
    }
  });

  it.each(
    (['direct', 'prepared'] as const).flatMap((entrypoint) =>
      (['own', 'prototype'] as const).map((tamper) => ({
        entrypoint,
        tamper,
      })),
    ),
  )(
    '$entrypoint dispatch ignores $tamper signal tampering during provider await',
    async ({ entrypoint, tamper }) => {
      const harness = createHarness();
      const controller = new AbortController();
      const expectedReason = new DOMException(
        'cancelled during provider',
        'AbortError',
      );
      let providerReason: unknown;
      let providerReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        providerReady = resolve;
      });
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                providerReason = request.signal?.reason;
                reject(
                  providerReason instanceof Error
                    ? providerReason
                    : new Error('missing abort reason'),
                );
              };
              if (request.signal?.aborted) onAbort();
              else {
                request.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
                providerReady();
              }
            });
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await ready;
      const mutation = tamperNativeSignal(controller.signal, tamper);
      try {
        abortCallerController(controller, expectedReason);
        await expect(completion).rejects.toMatchObject({
          modelError: { code: 'ABORTED' },
        });
        expect(providerReason).toBe(expectedReason);
        expect(mutation.attacker).not.toHaveBeenCalled();
        expect(mutation.abortAttacker).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        mutation.restore();
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s dispatch preserves an already-aborted native signal',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      const reason = new DOMException(
        'cancelled before dispatch',
        'AbortError',
      );
      controller.abort(reason);
      let providerReason: unknown;
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await Promise.resolve();
            providerReason = request.signal?.reason;
            if (request.signal?.aborted) {
              throw providerReason;
            }
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;

      await expect(
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request),
      ).rejects.toMatchObject({
        modelError: { code: 'ABORTED' },
      });
      expect(providerReason).toBe(reason);
    },
  );

  it('detaches every dispatch mirror after repeated completion and error paths', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    const dispatchedSignals: AbortSignal[] = [];
    harness.adapter.stream.mockImplementation(
      (request: ModelRequest, attempt: number) =>
        (async function* () {
          await Promise.resolve();
          dispatchedSignals.push(request.signal!);
          if (dispatchedSignals.length === 2) {
            throw new Error('provider failed');
          }
          yield { type: 'completed', finish_reason: 'stop', attempt };
        })(),
    );
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'write' }],
      signal: controller.signal,
      max_retries: 0,
      trace: validTrace,
    };

    await expect(harness.gateway.complete(request)).resolves.toMatchObject({
      finish_reason: 'stop',
    });
    const prepared = harness.gateway.prepareSingleDispatch(request);
    await expect(
      harness.gateway.completePrepared(prepared),
    ).rejects.toMatchObject({
      modelError: { code: 'PROVIDER_ERROR' },
    });
    await expect(harness.gateway.complete(request)).resolves.toMatchObject({
      finish_reason: 'stop',
    });
    expect(dispatchedSignals).toHaveLength(3);

    controller.abort(new DOMException('late cancellation', 'AbortError'));
    expect(dispatchedSignals.map((signal) => signal.aborted)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it.each(
    (['direct', 'prepared'] as const).flatMap((entrypoint) =>
      (['success', 'error'] as const).map((outcome) => ({
        entrypoint,
        outcome,
      })),
    ),
  )(
    '$entrypoint $outcome persistence window preserves abort reason without caller behavior',
    async ({ entrypoint, outcome }) => {
      const harness = createHarness();
      const controller = new AbortController();
      const expectedReason = new DOMException(
        'cancelled during completion persistence',
        'AbortError',
      );
      let dispatchedSignal: AbortSignal | undefined;
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await Promise.resolve();
            dispatchedSignal = request.signal;
            if (outcome === 'error') {
              throw new Error('provider failed before persistence');
            }
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      let releaseFinish!: () => void;
      const finishGate = new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      harness.recorder.finishAttempt.mockReturnValueOnce(finishGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.finishAttempt.mock.calls.length === 1,
      );
      const mutation = tamperNativeSignal(controller.signal, 'prototype');
      try {
        abortCallerController(controller, expectedReason);
        expect(dispatchedSignal?.aborted).toBe(true);
        expect(dispatchedSignal?.reason).toBe(expectedReason);
        releaseFinish();
        if (outcome === 'success') {
          await expect(completion).resolves.toMatchObject({
            finish_reason: 'stop',
          });
        } else {
          await expect(completion).rejects.toMatchObject({
            modelError: { code: 'PROVIDER_ERROR' },
          });
        }
        expect(mutation.attacker).not.toHaveBeenCalled();
        expect(mutation.abortAttacker).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        mutation.restore();
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s retry delay keeps using captured signal intrinsics after failure persistence',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      let attempt = 0;
      harness.adapter.stream.mockImplementation(
        (_request: ModelRequest, providerAttempt: number) =>
          (async function* () {
            await Promise.resolve();
            attempt += 1;
            if (attempt === 1) {
              throw Object.assign(new Error('connection reset'), {
                code: 'ECONNRESET',
              });
            }
            yield {
              type: 'completed',
              finish_reason: 'stop',
              attempt: providerAttempt,
            };
          })(),
      );
      let releaseFinish!: () => void;
      const finishGate = new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      harness.recorder.finishAttempt.mockReturnValueOnce(finishGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 1,
        retry_base_delay_ms: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.finishAttempt.mock.calls.length === 1,
      );
      const attacker = jest.fn(() => {
        throw new Error('caller AbortSignal property executed');
      });
      Object.defineProperties(controller.signal, {
        aborted: { configurable: true, get: attacker },
        reason: { configurable: true, get: attacker },
        addEventListener: { configurable: true, value: attacker },
        removeEventListener: { configurable: true, value: attacker },
      });
      releaseFinish();

      await expect(completion).resolves.toMatchObject({
        finish_reason: 'stop',
      });
      expect(harness.adapter.stream).toHaveBeenCalledTimes(2);
      expect(attacker).not.toHaveBeenCalled();
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s retry delay propagates a real late abort and its native reason',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      const expectedReason = new DOMException(
        'cancelled during retry delay',
        'AbortError',
      );
      const dispatchedSignals: AbortSignal[] = [];
      harness.adapter.stream.mockImplementation((request: ModelRequest) =>
        (async function* () {
          await Promise.resolve();
          dispatchedSignals.push(request.signal!);
          throw Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
          });
          yield {
            type: 'completed',
            finish_reason: 'stop',
            attempt: 0,
          };
        })(),
      );
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        max_retries: 1,
        retry_base_delay_ms: 30_000,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);
      let settled = false;
      void completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await waitFor(
        () => harness.recorder.finishAttempt.mock.calls.length === 1,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      const abortMutation = tamperAbortControllerPrototype();
      try {
        abortCallerController(controller, expectedReason);

        await expect(completion).rejects.toMatchObject({
          modelError: { code: 'ABORTED' },
        });
        expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
        expect(dispatchedSignals).toHaveLength(1);
        expect(dispatchedSignals[0].reason).toBe(expectedReason);
        expect(abortMutation.attacker).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        abortMutation.restore();
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s timeout callback ignores AbortController prototype tampering after validation',
    async (entrypoint) => {
      const harness = createHarness();
      const controller = new AbortController();
      let providerReason: unknown;
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await Promise.resolve();
            providerReason = request.signal?.reason;
            if (request.signal?.aborted) {
              throw providerReason;
            }
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      let releaseStart!: (value: { id: string }) => void;
      const startGate = new Promise<{ id: string }>((resolve) => {
        releaseStart = resolve;
      });
      harness.recorder.startAttempt.mockReturnValueOnce(startGate);
      const request: ModelRequest = {
        messages: [{ role: 'user', content: 'write' }],
        signal: controller.signal,
        timeout_ms: 5,
        max_retries: 0,
        trace: validTrace,
      };
      const prepared =
        entrypoint === 'prepared'
          ? harness.gateway.prepareSingleDispatch(request)
          : null;
      const completion =
        entrypoint === 'prepared'
          ? harness.gateway.completePrepared(prepared!)
          : harness.gateway.complete(request);

      await waitFor(
        () => harness.recorder.startAttempt.mock.calls.length === 1,
      );
      const abortMutation = tamperAbortControllerPrototype();
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        releaseStart({ id: 'run-1' });
        await expect(completion).rejects.toMatchObject({
          modelError: { code: 'TIMEOUT' },
        });
        expect(providerReason).toMatchObject({
          name: 'TimeoutError',
          message: 'timeout',
        });
        expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
        expect(abortMutation.attacker).not.toHaveBeenCalled();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      } finally {
        abortMutation.restore();
      }
    },
  );

  it.each(['direct', 'prepared'] as const)(
    '%s timeout is insulated from an initially tampered AbortController prototype',
    async (entrypoint) => {
      const harness = createHarness();
      let providerReason: unknown;
      harness.adapter.stream.mockImplementationOnce(
        (request: ModelRequest, attempt: number) =>
          (async function* () {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => {
                providerReason = request.signal?.reason;
                reject(
                  providerReason instanceof Error
                    ? providerReason
                    : new Error('missing timeout reason'),
                );
              };
              if (request.signal?.aborted) onAbort();
              else
                request.signal?.addEventListener('abort', onAbort, {
                  once: true,
                });
            });
            yield { type: 'completed', finish_reason: 'stop', attempt };
          })(),
      );
      const abortMutation = tamperAbortControllerPrototype();
      try {
        const request: ModelRequest = {
          messages: [{ role: 'user', content: 'write' }],
          timeout_ms: 5,
          max_retries: 0,
          trace: validTrace,
        };
        const prepared =
          entrypoint === 'prepared'
            ? harness.gateway.prepareSingleDispatch(request)
            : null;

        await expect(
          entrypoint === 'prepared'
            ? harness.gateway.completePrepared(prepared!)
            : harness.gateway.complete(request),
        ).rejects.toMatchObject({
          modelError: { code: 'TIMEOUT' },
        });
        expect(providerReason).toMatchObject({
          name: 'TimeoutError',
          message: 'timeout',
        });
        expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
        expect(abortMutation.attacker).not.toHaveBeenCalled();
      } finally {
        abortMutation.restore();
      }
    },
  );

  it('snapshots a direct request before awaited dependency I/O', async () => {
    const harness = createHarness();
    let releaseStart!: (value: { id: string }) => void;
    const startGate = new Promise<{ id: string }>((resolve) => {
      releaseStart = resolve;
    });
    harness.recorder.startAttempt.mockReturnValueOnce(startGate);
    const request = {
      messages: [{ role: 'user' as const, content: 'initial' }],
      trace: {
        workflow_job_id: validTrace.workflow_job_id,
        node: 'draft',
        attempt: 1,
      },
    };

    const completion = harness.gateway.complete(request);
    await waitFor(() => harness.recorder.startAttempt.mock.calls.length === 1);
    request.messages[0].content = 'mutated';
    request.trace.node = 'mutated';
    releaseStart({ id: 'run-1' });

    await expect(completion).resolves.toMatchObject({ finish_reason: 'stop' });
    expect(harness.adapter.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'initial' }],
        trace: expect.objectContaining({ node: 'draft' }),
      }),
      1,
    );
  });

  it('reads and validates each adapter descriptor exactly once', async () => {
    const harness = createHarness();
    const reads = { provider: 0, model: 0, stream: 0 };
    const stream = jest.fn<
      ReturnType<ModelAdapter['stream']>,
      Parameters<ModelAdapter['stream']>
    >(() =>
      events({
        type: 'completed',
        finish_reason: 'stop',
        attempt: 0,
      }),
    );
    const adapter = {
      get provider() {
        reads.provider += 1;
        return 'fake';
      },
      get model() {
        reads.model += 1;
        return 'model-1';
      },
      get stream() {
        reads.stream += 1;
        return stream;
      },
    } as ModelAdapter;
    harness.factory.createProvider.mockReturnValueOnce(adapter);

    const prepared = harness.gateway.prepareSingleDispatch({
      messages: [{ role: 'user', content: 'write' }],
    });
    expect(prepared.identity).toMatchObject({
      provider: 'fake',
      model: 'model-1',
    });
    expect(reads).toEqual({ provider: 1, model: 1, stream: 1 });

    await expect(
      harness.gateway.completePrepared(prepared),
    ).resolves.toMatchObject({ finish_reason: 'stop' });
    expect(reads).toEqual({ provider: 1, model: 1, stream: 1 });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

type ReflectAttackWindow =
  | 'start'
  | 'provider'
  | 'finish'
  | 'retry'
  | 'timeout';

async function runReflectAwaitWindowAttack(
  entrypoint: 'direct' | 'prepared',
  window: ReflectAttackWindow,
): Promise<void> {
  const harness = createHarness();
  const callerController = new TEST_NATIVE_ABORT_CONTROLLER();
  const callerSignal = readTestNativeControllerSignal(callerController);
  const expectedReason = new DOMException(
    `cancelled during ${window}`,
    'AbortError',
  );
  let providerReason: unknown;
  let dispatchedSignal: AbortSignal | undefined;
  let providerReady!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    providerReady = resolve;
  });
  let releaseStart!: (value: { id: string }) => void;
  const startGate = new Promise<{ id: string }>((resolve) => {
    releaseStart = resolve;
  });
  let releaseFinish!: () => void;
  const finishGate = new Promise<void>((resolve) => {
    releaseFinish = resolve;
  });

  if (window === 'start' || window === 'timeout') {
    harness.recorder.startAttempt.mockReturnValueOnce(startGate);
  }
  if (window === 'finish') {
    harness.recorder.finishAttempt.mockReturnValueOnce(finishGate);
  }
  harness.adapter.stream.mockImplementationOnce(
    (request: ModelRequest, attempt: number) =>
      (async function* () {
        dispatchedSignal = request.signal;
        if (window === 'provider') {
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
              providerReason = request.signal?.reason;
              reject(
                providerReason instanceof Error
                  ? providerReason
                  : new Error('missing abort reason'),
              );
            };
            if (request.signal?.aborted) onAbort();
            else {
              request.signal?.addEventListener('abort', onAbort, {
                once: true,
              });
              providerReady();
            }
          });
        } else {
          await Promise.resolve();
          providerReason = request.signal?.reason;
          if (request.signal?.aborted) throw providerReason;
        }
        if (window === 'retry') {
          throw Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
          });
        }
        yield { type: 'completed', finish_reason: 'stop', attempt };
      })(),
  );

  const request: ModelRequest = {
    messages: [{ role: 'user', content: 'write' }],
    signal: callerSignal,
    max_retries: window === 'retry' ? 1 : 0,
    retry_base_delay_ms: window === 'retry' ? 30_000 : 0,
    timeout_ms: window === 'timeout' ? 5 : 120_000,
    trace: validTrace,
  };
  const prepared =
    entrypoint === 'prepared'
      ? harness.gateway.prepareSingleDispatch(request)
      : null;
  const completion =
    entrypoint === 'prepared'
      ? harness.gateway.completePrepared(prepared!)
      : harness.gateway.complete(request);

  if (window === 'provider') {
    await providerGate;
  } else if (window === 'finish' || window === 'retry') {
    await waitFor(() => harness.recorder.finishAttempt.mock.calls.length === 1);
    if (window === 'retry') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } else {
    await waitFor(() => harness.recorder.startAttempt.mock.calls.length === 1);
  }

  const mutation = tamperReflectRuntime('global');
  let caught: unknown;
  let result: unknown;
  try {
    if (window === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 15));
      releaseStart({ id: 'run-1' });
    } else {
      abortCallerController(callerController, expectedReason);
      if (window === 'start') releaseStart({ id: 'run-1' });
      if (window === 'finish') releaseFinish();
    }
    try {
      result = await completion;
    } catch (error) {
      caught = error;
    }
  } finally {
    mutation.restore();
  }

  expect(mutation.attackerCalls()).toBe(0);
  expect(harness.adapter.stream).toHaveBeenCalledTimes(1);
  expect(getEventListeners(callerSignal, 'abort')).toHaveLength(0);
  if (window === 'finish') {
    expect(result).toMatchObject({ finish_reason: 'stop' });
    expect(dispatchedSignal?.aborted).toBe(true);
    expect(dispatchedSignal?.reason).toBe(expectedReason);
  } else if (window === 'timeout') {
    expect(caught).toMatchObject({
      modelError: { code: 'TIMEOUT' },
    });
    expect(providerReason).toMatchObject({
      name: 'TimeoutError',
      message: 'timeout',
    });
  } else {
    expect(caught).toMatchObject({
      modelError: { code: 'ABORTED' },
    });
    if (window === 'retry') {
      expect(dispatchedSignal?.reason).toBe(expectedReason);
    } else {
      expect(providerReason).toBe(expectedReason);
    }
  }
}

function tamperReflectRuntime(mode: 'apply' | 'global'): {
  attackerCalls: () => number;
  restore: () => void;
} {
  const globalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'Reflect',
  )!;
  const applyDescriptor = Object.getOwnPropertyDescriptor(
    TEST_NATIVE_REFLECT,
    'apply',
  )!;
  let calls = 0;
  const applyAttacker: SafeReflectApply = function apply(
    target,
    thisArgument,
    argumentsList,
  ) {
    calls += 1;
    return TEST_NATIVE_REFLECT_APPLY(target, thisArgument, argumentsList);
  };
  if (mode === 'apply') {
    Object.defineProperty(TEST_NATIVE_REFLECT, 'apply', {
      ...applyDescriptor,
      value: applyAttacker,
    });
    return {
      attackerCalls: () => calls,
      restore: () => {
        Object.defineProperty(TEST_NATIVE_REFLECT, 'apply', applyDescriptor);
      },
    };
  }

  const ownKeysAttacker: SafeReflectOwnKeys = (target) => {
    calls += 1;
    return TEST_NATIVE_REFLECT_OWN_KEYS(target);
  };
  const getAttacker: SafeReflectGet = (target, propertyKey, receiver) => {
    calls += 1;
    return TEST_NATIVE_REFLECT_GET(target, propertyKey, receiver);
  };
  const getPrototypeOfAttacker: SafeReflectGetPrototypeOf = (target) => {
    calls += 1;
    return TEST_NATIVE_REFLECT_GET_PROTOTYPE_OF(target);
  };
  const maliciousReflect = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(
    maliciousReflect,
    Object.getOwnPropertyDescriptors(TEST_NATIVE_REFLECT),
  );
  Object.defineProperties(maliciousReflect, {
    apply: { ...applyDescriptor, value: applyAttacker },
    get: {
      ...Object.getOwnPropertyDescriptor(TEST_NATIVE_REFLECT, 'get')!,
      value: getAttacker,
    },
    getPrototypeOf: {
      ...Object.getOwnPropertyDescriptor(
        TEST_NATIVE_REFLECT,
        'getPrototypeOf',
      )!,
      value: getPrototypeOfAttacker,
    },
    ownKeys: {
      ...Object.getOwnPropertyDescriptor(TEST_NATIVE_REFLECT, 'ownKeys')!,
      value: ownKeysAttacker,
    },
  });
  Object.defineProperty(globalThis, 'Reflect', {
    ...globalDescriptor,
    value: maliciousReflect,
  });
  return {
    attackerCalls: () => calls,
    restore: () => {
      Object.defineProperty(globalThis, 'Reflect', globalDescriptor);
    },
  };
}

function tamperNativeSignal(
  signal: AbortSignal,
  mode: 'own' | 'prototype',
): {
  attacker: jest.Mock;
  abortAttacker: jest.Mock;
  restore: () => void;
} {
  const forgedReason = new DOMException('forged', 'AbortError');
  const attacker = jest.fn(() => forgedReason);
  const abortMutation = tamperAbortControllerPrototype(mode === 'prototype');
  const signalKeys = [
    'aborted',
    'reason',
    'addEventListener',
    'removeEventListener',
    'throwIfAborted',
  ] as const;
  if (mode === 'own') {
    Object.defineProperties(signal, {
      aborted: { configurable: true, get: attacker },
      reason: { configurable: true, get: attacker },
      addEventListener: {
        configurable: true,
        writable: true,
        value: attacker,
      },
      removeEventListener: {
        configurable: true,
        writable: true,
        value: attacker,
      },
      throwIfAborted: {
        configurable: true,
        writable: true,
        value: attacker,
      },
    });
    return {
      attacker,
      abortAttacker: abortMutation.attacker,
      restore: () => {
        for (const key of signalKeys) {
          Reflect.deleteProperty(signal, key);
        }
        abortMutation.restore();
      },
    };
  }

  const originalDescriptors = {
    aborted: Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!,
    reason: Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')!,
    throwIfAborted: Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'throwIfAborted',
    )!,
    addEventListener: Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'addEventListener',
    )!,
    removeEventListener: Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'removeEventListener',
    )!,
  };
  Object.defineProperties(AbortSignal.prototype, {
    aborted: { configurable: true, get: attacker },
    reason: { configurable: true, get: attacker },
    throwIfAborted: {
      configurable: true,
      writable: true,
      value: attacker,
    },
  });
  Object.defineProperties(EventTarget.prototype, {
    addEventListener: {
      configurable: true,
      writable: true,
      value: attacker,
    },
    removeEventListener: {
      configurable: true,
      writable: true,
      value: attacker,
    },
  });
  return {
    attacker,
    abortAttacker: abortMutation.attacker,
    restore: () => {
      Object.defineProperties(AbortSignal.prototype, {
        aborted: originalDescriptors.aborted,
        reason: originalDescriptors.reason,
        throwIfAborted: originalDescriptors.throwIfAborted,
      });
      Object.defineProperties(EventTarget.prototype, {
        addEventListener: originalDescriptors.addEventListener,
        removeEventListener: originalDescriptors.removeEventListener,
      });
      abortMutation.restore();
    },
  };
}

function tamperAbortControllerPrototype(enabled = true): {
  attacker: jest.Mock;
  restore: () => void;
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    AbortController.prototype,
    'abort',
  )!;
  const attacker = jest.fn(function (this: AbortController, reason?: unknown) {
    TEST_NATIVE_REFLECT_APPLY(TEST_NATIVE_ABORT_CONTROLLER_ABORT, this, [
      reason,
    ]);
  });
  if (!enabled) {
    return { attacker, restore: () => undefined };
  }
  Object.defineProperty(AbortController.prototype, 'abort', {
    configurable: true,
    writable: true,
    value: attacker,
  });
  return {
    attacker,
    restore: () => {
      Object.defineProperty(
        AbortController.prototype,
        'abort',
        originalDescriptor,
      );
    },
  };
}

function tamperAbortControllerConstructionSources(): {
  constructorAttacker: jest.Mock;
  signalGetterAttacker: jest.Mock;
  restore: () => void;
} {
  const globalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'AbortController',
  )!;
  const signalDescriptor = Object.getOwnPropertyDescriptor(
    TEST_NATIVE_ABORT_CONTROLLER.prototype,
    'signal',
  )!;
  const constructorAttacker = jest.fn();
  const signalGetterAttacker = jest.fn(function (
    this: InstanceType<typeof TEST_NATIVE_ABORT_CONTROLLER>,
  ) {
    return TEST_NATIVE_REFLECT_APPLY(
      TEST_NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER,
      this,
      [],
    ) as AbortSignal;
  });
  class MaliciousAbortController extends TEST_NATIVE_ABORT_CONTROLLER {
    constructor() {
      super();
      constructorAttacker();
    }
  }
  Object.defineProperty(globalThis, 'AbortController', {
    ...globalDescriptor,
    value: MaliciousAbortController,
  });
  Object.defineProperty(TEST_NATIVE_ABORT_CONTROLLER.prototype, 'signal', {
    ...signalDescriptor,
    get: signalGetterAttacker,
  });
  return {
    constructorAttacker,
    signalGetterAttacker,
    restore: () => {
      Object.defineProperty(
        TEST_NATIVE_ABORT_CONTROLLER.prototype,
        'signal',
        signalDescriptor,
      );
      Object.defineProperty(globalThis, 'AbortController', globalDescriptor);
    },
  };
}

function tamperGlobalAbortControllerConstructor(): {
  constructorAttacker: jest.Mock;
  restore: () => void;
} {
  const globalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'AbortController',
  )!;
  const constructorAttacker = jest.fn();
  class MaliciousAbortController extends TEST_NATIVE_ABORT_CONTROLLER {
    constructor() {
      super();
      constructorAttacker();
    }
  }
  Object.defineProperty(globalThis, 'AbortController', {
    ...globalDescriptor,
    value: MaliciousAbortController,
  });
  return {
    constructorAttacker,
    restore: () => {
      Object.defineProperty(globalThis, 'AbortController', globalDescriptor);
    },
  };
}

function abortCallerController(
  controller: AbortController,
  reason: unknown,
): void {
  TEST_NATIVE_REFLECT_APPLY(TEST_NATIVE_ABORT_CONTROLLER_ABORT, controller, [
    reason,
  ]);
}

function readTestNativeControllerSignal(
  controller: AbortController,
): AbortSignal {
  return TEST_NATIVE_REFLECT_APPLY(
    TEST_NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER,
    controller,
    [],
  ) as AbortSignal;
}

function operationIdentity(
  override: Record<string, unknown> = {},
): ModelOperationIdentity {
  return {
    version: 'model-operation.v1',
    operation_key: 'a'.repeat(64),
    request_fingerprint: 'b'.repeat(64),
    prompt_sha256: 'c'.repeat(64),
    provider: 'fake',
    model: 'model-1',
    schema_id: null,
    schema_version: null,
    schema_sha256: null,
    ...override,
  } as ModelOperationIdentity;
}

function createHarness(): {
  gateway: ModelGateway;
  factory: { createProvider: jest.Mock };
  adapter: jest.Mocked<ModelAdapter>;
  recorder: {
    startAttempt: jest.Mock;
    finishAttempt: jest.Mock;
    findOperationState: jest.Mock;
  };
  pricingCalculate: jest.SpyInstance;
} {
  const adapter: jest.Mocked<ModelAdapter> = {
    provider: 'fake',
    model: 'model-1',
    stream: jest.fn<
      ReturnType<ModelAdapter['stream']>,
      Parameters<ModelAdapter['stream']>
    >(() =>
      events({
        type: 'completed',
        finish_reason: 'stop',
        attempt: 0,
      }),
    ),
  };
  const factory = {
    createProvider: jest.fn().mockReturnValue(adapter),
  };
  const recorder = {
    startAttempt: jest.fn(() => Promise.resolve({ id: 'run-1' })),
    finishAttempt: jest.fn(() => Promise.resolve()),
    findOperationState: jest.fn(() => Promise.resolve('absent' as const)),
  };
  const configService = {
    get: <T>(_key: string, fallback?: T) => fallback,
  } as ConfigService;
  const pricing = new ModelPricingCatalog(configService);
  const pricingCalculate = jest.spyOn(pricing, 'calculate');
  const gateway = new ModelGateway(
    factory as unknown as LLMFactory,
    recorder as unknown as ModelRunRecorder,
    pricing,
  );
  return { gateway, factory, adapter, recorder, pricingCalculate };
}

function dispatchSemantics(request: ModelRequest): Record<string, unknown> {
  const result: Record<string, unknown> = { ...request };
  delete result.idempotency_key;
  delete result.signal;
  return result;
}

function events(...items: ModelEvent[]): AsyncIterable<ModelEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* items;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for test condition');
}
