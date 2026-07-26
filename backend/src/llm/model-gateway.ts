import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { LLMFactory } from './llm.factory.js';
import { ModelPricingCatalog, type ModelRunRecorder } from './model-pricing.js';
import type {
  ModelError,
  ModelCompletionAudit,
  ModelEvent,
  ModelFinishReason,
  ModelMessage,
  ModelOperationIdentity,
  ModelRequest,
  ModelResponseMode,
  ModelToolCall,
  ModelUsage,
  ModelAdapter,
  ToolDefinition,
} from './model-types.js';
import { ModelRunService } from '../workflow/model-run.service.js';

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

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_REPAIRS = 2;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_MODEL_TOKENS = 1_000_000;
const MAX_GENERATION_ATTEMPT = 4_294_967_288;
const MAX_MESSAGES = 256;
const MAX_MESSAGE_CONTENT_BYTES = 1_048_576;
const MAX_TOTAL_MESSAGE_BYTES = 4_194_304;
const MAX_RESPONSE_SCHEMA_BYTES = 262_144;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_KEYS = 8_192;
const MAX_TOOLS = 64;
const MAX_TOOL_DESCRIPTION_BYTES = 1_024;
const MAX_TOOL_SCHEMA_BYTES = 32_768;
const NATIVE_REFLECT = requireOwnDataObject(globalThis, 'Reflect');
const NATIVE_REFLECT_APPLY = requireNativeReflectMethod(
  NATIVE_REFLECT,
  'apply',
) as SafeReflectApply;
const NATIVE_REFLECT_GET = requireNativeReflectMethod(
  NATIVE_REFLECT,
  'get',
) as SafeReflectGet;
const NATIVE_REFLECT_GET_PROTOTYPE_OF = requireNativeReflectMethod(
  NATIVE_REFLECT,
  'getPrototypeOf',
) as SafeReflectGetPrototypeOf;
const NATIVE_REFLECT_OWN_KEYS = requireNativeReflectMethod(
  NATIVE_REFLECT,
  'ownKeys',
) as SafeReflectOwnKeys;
const NATIVE_ABORTED_GETTER = requireNativeGetter(
  AbortSignal.prototype,
  'aborted',
);
const NATIVE_REASON_GETTER = requireNativeGetter(
  AbortSignal.prototype,
  'reason',
);
// eslint-disable-next-line @typescript-eslint/unbound-method
const NATIVE_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const NATIVE_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const NATIVE_THROW_IF_ABORTED = AbortSignal.prototype.throwIfAborted;
const NATIVE_ABORT_CONTROLLER = AbortController;
const NATIVE_ABORT_CONTROLLER_PROTOTYPE = NATIVE_ABORT_CONTROLLER.prototype;
const NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER = requireNativeGetter(
  NATIVE_ABORT_CONTROLLER_PROTOTYPE,
  'signal',
);
const NATIVE_ABORT_CONTROLLER_ABORT = requireNativeMethod(
  NATIVE_ABORT_CONTROLLER_PROTOTYPE,
  'abort',
);

export interface ModelCompletion<TOutput = unknown> {
  text: string;
  usage: ModelUsage | null;
  finish_reason: ModelFinishReason;
  audit: ModelCompletionAudit;
  structured_output?: TOutput;
  tool_calls?: ModelToolCall[];
}

export interface PreparedModelOperation<TOutput = unknown> {
  readonly identity: ModelOperationIdentity;
  readonly __output?: TOutput;
}

interface PreparedModelOperationState<TOutput> {
  request: CanonicalModelRequest<TOutput>;
  adapter: ModelAdapter;
  identity: ModelOperationIdentity;
}

interface TrustedAbortSignalSnapshot {
  readonly isAborted: () => boolean;
  readonly getReason: () => unknown;
  readonly addAbortListener: (listener: EventListener) => void;
  readonly removeAbortListener: (listener: EventListener) => void;
}

type CanonicalModelRequest<TOutput = unknown> = Readonly<
  Omit<ModelRequest<TOutput>, 'signal'> & {
    signal?: TrustedAbortSignalSnapshot;
    response_mode: ModelResponseMode;
    timeout_ms: number;
    max_retries: number;
    max_repair_attempts: number;
    retry_base_delay_ms: number;
  }
>;

export class ModelGatewayError extends Error {
  constructor(readonly modelError: ModelError) {
    super(modelError.message);
    this.name = 'ModelGatewayError';
  }
}

@Injectable()
export class ModelGateway {
  private readonly preparedOperations = new WeakMap<
    PreparedModelOperation,
    PreparedModelOperationState<unknown>
  >();
  private readonly dispatchedOperations = new WeakSet<PreparedModelOperation>();

  constructor(
    private readonly factory: LLMFactory,
    @Inject(ModelRunService)
    private readonly recorder: ModelRunRecorder,
    private readonly pricing: ModelPricingCatalog,
  ) {}

  estimateWorstCaseCost(request: ModelRequest): string | null {
    const canonical = validateAndCanonicalizeRequest(request);
    if (canonical.max_tokens === undefined) return null;
    const adapter = resolveAdapter(this.factory.createProvider());
    const inputTokens = estimateInputTokenUpperBound(canonical);
    return this.pricing.calculate(adapter.provider, adapter.model, {
      input_tokens: inputTokens,
      output_tokens: canonical.max_tokens,
      total_tokens: inputTokens + canonical.max_tokens,
      cached_input_tokens: 0,
    });
  }

  calculateUsageCost(usage: ModelUsage | null): string | null {
    if (usage === null) return null;
    const canonical = validateAndCanonicalizeUsage(usage);
    const adapter = resolveAdapter(this.factory.createProvider());
    return this.pricing.calculate(adapter.provider, adapter.model, canonical);
  }

  prepareSingleDispatch<TOutput = unknown>(
    originalRequest: ModelRequest<TOutput>,
  ): PreparedModelOperation<TOutput> {
    const request = validateAndCanonicalizeRequest(originalRequest);
    const adapter = resolveAdapter(this.factory.createProvider());
    const promptSha256 = hashCanonical(
      request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        name: message.name ?? null,
        tool_call_id: message.tool_call_id ?? null,
      })),
    );
    const schemaSha256 = request.schema?.json_schema
      ? hashCanonical(request.schema.json_schema)
      : null;
    const requestFingerprint = hashCanonical({
      version: 'model-request-fingerprint.v1',
      provider: adapter.provider,
      model: adapter.model,
      messages_sha256: promptSha256,
      response_mode: resolveResponseMode(request),
      schema: request.schema
        ? {
            id: request.schema.id,
            version: request.schema.version ?? null,
            json_schema_sha256: schemaSha256,
          }
        : null,
      tools:
        request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        })) ?? null,
      tool_choice: request.tool_choice ?? null,
      temperature: request.temperature ?? null,
      max_tokens: request.max_tokens ?? null,
      timeout_ms: request.timeout_ms,
      max_retries: request.max_retries,
      max_repair_attempts: request.max_repair_attempts,
      retry_base_delay_ms: request.retry_base_delay_ms,
      dispatch_policy: 'single-dispatch.v1',
    });
    const operationKey = hashCanonical({
      version: 'model-operation-key.v1',
      workflow_job_id: request.trace?.workflow_job_id ?? null,
      workflow_node: request.trace?.node ?? null,
      generation_attempt: request.trace?.attempt ?? null,
      request_fingerprint: requestFingerprint,
    });
    const identity = Object.freeze({
      version: 'model-operation.v1' as const,
      operation_key: operationKey,
      request_fingerprint: requestFingerprint,
      prompt_sha256: promptSha256,
      provider: adapter.provider,
      model: adapter.model,
      schema_id: request.schema?.id ?? null,
      schema_version: request.schema?.version ?? null,
      schema_sha256: schemaSha256,
    });
    const prepared = Object.freeze({
      identity,
    }) as PreparedModelOperation<TOutput>;
    this.preparedOperations.set(prepared, {
      request: Object.freeze({
        ...request,
        idempotency_key: operationKey,
      }),
      adapter,
      identity,
    });
    return prepared;
  }

  async completePrepared<TOutput = unknown>(
    prepared: PreparedModelOperation<TOutput>,
  ): Promise<ModelCompletion<TOutput>> {
    const state = this.preparedOperations.get(prepared);
    if (!state) throw new Error('MODEL_OPERATION_HANDLE_INVALID');
    if (this.dispatchedOperations.has(prepared)) {
      throw new Error('MODEL_OPERATION_ALREADY_DISPATCHED');
    }
    this.dispatchedOperations.add(prepared);
    return this.completeWithAdapter(
      state.request as CanonicalModelRequest<TOutput>,
      state.adapter,
      state.identity,
    );
  }

  async inspectOperation(
    workflowJobId: string,
    operation: string | ModelOperationIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch' | 'unknown'> {
    const lookup = validateAndCanonicalizeOperationLookup(
      workflowJobId,
      operation,
    );
    if (!this.recorder.findOperationState) return 'unknown';
    try {
      return await this.recorder.findOperationState(
        lookup.workflowJobId,
        typeof lookup.operation === 'string'
          ? lookup.operation
          : lookup.operation.operation_key,
        typeof lookup.operation === 'string'
          ? undefined
          : {
              request_fingerprint: lookup.operation.request_fingerprint,
              prompt_sha256: lookup.operation.prompt_sha256,
              provider: lookup.operation.provider,
              model: lookup.operation.model,
              schema_id: lookup.operation.schema_id,
              schema_version: lookup.operation.schema_version,
              schema_sha256: lookup.operation.schema_sha256,
            },
      );
    } catch {
      return 'unknown';
    }
  }

  async *stream<TOutput = unknown>(
    originalRequest: ModelRequest<TOutput>,
  ): AsyncGenerator<ModelEvent<TOutput>> {
    const request = validateAndCanonicalizeRequest(originalRequest);
    yield* this.streamWithAdapter(
      request,
      resolveAdapter(this.factory.createProvider()),
    );
  }

  private async *streamWithAdapter<TOutput>(
    originalRequest: CanonicalModelRequest<TOutput>,
    adapter: ModelAdapter,
    preparedIdentity?: ModelOperationIdentity,
  ): AsyncGenerator<ModelEvent<TOutput>> {
    const responseMode = originalRequest.response_mode;
    const allowedToolNames = getAllowedToolNames(originalRequest.tools);
    const baseAttempt = originalRequest.trace?.attempt ?? 1;
    const maxRetries = originalRequest.max_retries ?? DEFAULT_MAX_RETRIES;
    const maxRepairs = Math.min(
      originalRequest.max_repair_attempts ?? 1,
      MAX_REPAIRS,
    );
    let retryCount = 0;
    let repairCount = 0;
    let attemptOffset = 0;
    let attemptKind: 'initial' | 'network_retry' | 'repair' = 'initial';
    let messages: readonly ModelMessage[] = originalRequest.messages;

    while (true) {
      const attempt = baseAttempt + attemptOffset;
      const timeout = combineAbortSignals(
        originalRequest.signal,
        originalRequest.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      );
      const request = Object.freeze({
        ...originalRequest,
        messages,
        signal: timeout.signal,
      }) as unknown as ModelRequest<TOutput>;
      const startedAt = Date.now();
      let run: { id: string } | null = null;
      let usage: ModelUsage | null = null;
      let emittedOutput = false;
      let completed = false;
      let text = '';
      const toolCalls: ModelToolCall[] = [];
      const buffered: ModelEvent<TOutput>[] = [];
      const terminalEvents: ModelEvent<TOutput>[] = [];

      try {
        run = await this.startRun(
          request,
          adapter.provider,
          adapter.model,
          attemptKind,
          retryCount,
          repairCount,
          preparedIdentity,
        );
        for await (const providerEvent of adapter.stream(request, attempt)) {
          const event = withAttempt(
            providerEvent,
            attempt,
          ) as ModelEvent<TOutput>;
          if (event.type === 'error') {
            throw new ModelGatewayError(event.error);
          }
          if (event.type === 'text_delta') {
            text += event.text;
            emittedOutput = true;
          } else if (event.type === 'tool_call') {
            if (responseMode !== 'tool') {
              throw new ModelGatewayError(unexpectedToolCall());
            }
            const toolCall = validateToolCall(
              event.tool_call,
              allowedToolNames,
              toolCalls,
            );
            toolCalls.push(toolCall);
            emittedOutput = true;
          } else if (event.type === 'usage') {
            usage = validateModelUsage(event.usage);
          } else if (event.type === 'completed') {
            const terminalError = invalidTerminalReason(
              (event as { finish_reason: unknown }).finish_reason,
            );
            if (terminalError) {
              throw new ModelGatewayError(terminalError);
            }
            const modeError = validateTerminalForMode(
              responseMode,
              event.finish_reason,
              toolCalls.length,
            );
            if (modeError) throw new ModelGatewayError(modeError);
            completed = true;
          }

          if (responseMode === 'structured') {
            if (event.type !== 'text_delta') buffered.push(event);
          } else if (event.type === 'usage' || event.type === 'completed') {
            terminalEvents.push(event);
          } else {
            yield event;
          }
        }
        if (!completed) {
          throw new ModelGatewayError({
            code: 'PROVIDER_UNAVAILABLE',
            message: '模型流在完成事件前中断',
            retryable: true,
          });
        }

        if (responseMode === 'structured') {
          const validation = validateStructuredOutput(text, (value) =>
            originalRequest.schema!.parse(value),
          );
          if (!validation.ok) {
            await this.finishRun(run?.id, {
              status: 'FAILED',
              usage,
              cost_usd: this.pricing.calculate(
                adapter.provider,
                adapter.model,
                usage,
              ),
              error_code: 'STRUCTURED_OUTPUT_INVALID',
              error_message: '结构化输出校验失败',
              latency_ms: elapsed(startedAt),
              completed_at: new Date(),
            });
            if (repairCount < maxRepairs) {
              repairCount += 1;
              attemptOffset += 1;
              attemptKind = 'repair';
              messages = validateAndCanonicalizeMessages(
                buildRepairMessages(
                  originalRequest.messages,
                  text,
                  validation.details,
                  originalRequest.schema!.id,
                ),
              );
              continue;
            }
            yield {
              type: 'error',
              error: {
                code: 'STRUCTURED_OUTPUT_INVALID',
                message: '结构化输出校验失败',
                retryable: false,
                details: validation.details,
              },
              attempt,
            };
            return;
          }

          await this.finishRun(run?.id, {
            status: 'SUCCEEDED',
            usage,
            cost_usd: this.pricing.calculate(
              adapter.provider,
              adapter.model,
              usage,
            ),
            error_code: null,
            error_message: null,
            latency_ms: elapsed(startedAt),
            completed_at: new Date(),
          });
          for (const event of buffered) {
            if (event.type === 'completed') {
              yield {
                ...event,
                structured_output: validation.value,
                gateway_audit: {
                  repair_attempts: repairCount,
                  response_utf8_bytes: Buffer.byteLength(text, 'utf8'),
                  final_model_run_id: run?.id ?? null,
                },
              };
            } else {
              yield event;
            }
          }
          return;
        }

        await this.finishRun(run?.id, {
          status: 'SUCCEEDED',
          usage,
          cost_usd: this.pricing.calculate(
            adapter.provider,
            adapter.model,
            usage,
          ),
          error_code: null,
          error_message: null,
          latency_ms: elapsed(startedAt),
          completed_at: new Date(),
        });
        for (const event of terminalEvents) {
          if (event.type === 'completed') {
            yield {
              ...event,
              gateway_audit: {
                repair_attempts: 0,
                response_utf8_bytes: Buffer.byteLength(text, 'utf8'),
                final_model_run_id: run?.id ?? null,
              },
            };
          } else {
            yield event;
          }
        }
        return;
      } catch (caught: unknown) {
        const modelError = normalizeModelError(
          caught,
          timeout.timedOut(),
          isTrustedSignalAborted(originalRequest.signal),
        );
        await this.finishRun(run?.id, {
          status: modelError.code === 'ABORTED' ? 'CANCELLED' : 'FAILED',
          usage,
          cost_usd: this.pricing.calculate(
            adapter.provider,
            adapter.model,
            usage,
          ),
          error_code: modelError.code,
          error_message: modelError.message,
          latency_ms: elapsed(startedAt),
          completed_at: new Date(),
        });

        if (
          isRetryableModelError(modelError) &&
          !emittedOutput &&
          retryCount < maxRetries &&
          !isTrustedSignalAborted(originalRequest.signal)
        ) {
          const retryDelay = calculateRetryDelay(
            retryCount,
            originalRequest.retry_base_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
            modelError.retry_after_ms,
          );
          retryCount += 1;
          attemptOffset += 1;
          attemptKind = 'network_retry';
          try {
            await abortableDelay(retryDelay, originalRequest.signal);
          } catch (delayError: unknown) {
            const aborted = normalizeModelError(delayError, false, true);
            yield { type: 'error', error: aborted, attempt };
            return;
          }
          continue;
        }

        yield { type: 'error', error: modelError, attempt };
        return;
      } finally {
        timeout.cleanup();
      }
    }
  }

  async complete<TOutput = unknown>(
    request: ModelRequest<TOutput>,
  ): Promise<ModelCompletion<TOutput>> {
    return this.completeFromEvents(this.stream(request));
  }

  private async completeWithAdapter<TOutput>(
    request: CanonicalModelRequest<TOutput>,
    adapter: ModelAdapter,
    identity: ModelOperationIdentity,
  ): Promise<ModelCompletion<TOutput>> {
    return this.completeFromEvents(
      this.streamWithAdapter(request, adapter, identity),
    );
  }

  private async completeFromEvents<TOutput>(
    events: AsyncIterable<ModelEvent<TOutput>>,
  ): Promise<ModelCompletion<TOutput>> {
    let text = '';
    let usage: ModelUsage | null = null;
    let finishReason: ModelFinishReason | null = null;
    let audit: ModelCompletionAudit | null = null;
    let structuredOutput: TOutput | undefined;
    const toolCalls: ModelToolCall[] = [];
    for await (const event of events) {
      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'completed':
          finishReason = event.finish_reason;
          structuredOutput = event.structured_output;
          audit = event.gateway_audit ?? null;
          break;
        case 'error':
          throw new ModelGatewayError(event.error);
        case 'tool_call':
          toolCalls.push(event.tool_call);
          break;
      }
    }
    if (!finishReason || !audit) {
      throw new ModelGatewayError({
        code: 'PROVIDER_ERROR',
        message: !finishReason
          ? '模型服务未返回完成事件'
          : '模型网关未返回完成审计',
        retryable: false,
      });
    }
    return {
      text,
      usage,
      finish_reason: finishReason,
      audit,
      ...(structuredOutput !== undefined
        ? { structured_output: structuredOutput }
        : {}),
      ...(toolCalls.length > 0
        ? {
            tool_calls: [...toolCalls].sort(
              (left, right) => left.index - right.index,
            ),
          }
        : {}),
    };
  }

  private async startRun(
    request: ModelRequest,
    provider: string,
    model: string,
    attemptKind: 'initial' | 'network_retry' | 'repair',
    networkAttempt: number,
    repairAttempt: number,
    operationIdentity?: ModelOperationIdentity,
  ): Promise<{ id: string } | null> {
    if (!request.trace) return null;
    return this.recorder.startAttempt({
      workflow_job_id: request.trace.workflow_job_id,
      provider,
      model,
      workflow_node: request.trace.node,
      attempt_kind: attemptKind,
      generation_attempt: request.trace.attempt,
      network_attempt: networkAttempt,
      repair_attempt: repairAttempt,
      request_metadata: {
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.max_tokens !== undefined
          ? { max_output_tokens: request.max_tokens }
          : {}),
        ...(request.timeout_ms !== undefined
          ? { timeout_ms: request.timeout_ms }
          : {}),
        ...(request.schema
          ? {
              response_schema_id: request.schema.id,
              ...(request.schema.version !== undefined
                ? { response_schema_version: request.schema.version }
                : {}),
              ...(operationIdentity?.schema_sha256
                ? {
                    response_schema_sha256: operationIdentity.schema_sha256,
                  }
                : {}),
              structured_output: true,
            }
          : {}),
        response_mode: resolveResponseMode(request),
        ...(request.trace.trace_id ? { trace_id: request.trace.trace_id } : {}),
        workflow_node: request.trace.node,
        generation_attempt: request.trace.attempt,
        retry_attempt: networkAttempt,
        repair_attempt: repairAttempt,
        attempt_kind: attemptKind,
      },
      prompt_sha256:
        operationIdentity?.prompt_sha256 ?? hashMessages(request.messages),
      operation_key: request.idempotency_key ?? null,
      request_fingerprint: operationIdentity?.request_fingerprint ?? null,
    });
  }

  private async finishRun(
    runId: string | undefined,
    input: Parameters<ModelRunRecorder['finishAttempt']>[1],
  ): Promise<void> {
    if (!runId) return;
    await this.recorder.finishAttempt(runId, input);
  }
}

function validateAndCanonicalizeRequest<TOutput>(
  value: ModelRequest<TOutput>,
): CanonicalModelRequest<TOutput> {
  assertExactDataRecord(
    value,
    [
      'messages',
      'idempotency_key',
      'response_mode',
      'schema',
      'tools',
      'tool_choice',
      'temperature',
      'max_tokens',
      'timeout_ms',
      'signal',
      'trace',
      'max_retries',
      'max_repair_attempts',
      'retry_base_delay_ms',
    ],
    'ModelRequest',
  );
  const request = value as ModelRequest<TOutput>;
  const messages = validateAndCanonicalizeMessages(request.messages);
  if (messages.length === 0) {
    throw new Error('ModelRequest.messages 不能为空');
  }
  if (
    request.response_mode !== undefined &&
    !['text', 'structured', 'tool'].includes(request.response_mode)
  ) {
    throw new Error('response_mode 必须是 text、structured 或 tool');
  }
  const responseMode = resolveResponseMode(request);
  if (responseMode === 'structured' && !request.schema) {
    throw new Error('structured response_mode 必须提供 schema');
  }
  if (responseMode !== 'structured' && request.schema) {
    throw new Error('schema 只能用于 structured response_mode');
  }
  validateToolContract(request, responseMode);
  if (
    request.temperature !== undefined &&
    (typeof request.temperature !== 'number' ||
      !Number.isFinite(request.temperature) ||
      request.temperature < 0 ||
      request.temperature > 2)
  ) {
    throw new Error('temperature 必须是 0 到 2 的有限数字');
  }
  if (
    request.max_tokens !== undefined &&
    (!Number.isSafeInteger(request.max_tokens) ||
      request.max_tokens <= 0 ||
      request.max_tokens > MAX_MODEL_TOKENS)
  ) {
    throw new Error(`max_tokens 必须是 1 到 ${MAX_MODEL_TOKENS} 的整数`);
  }
  if (
    request.max_retries !== undefined &&
    (!Number.isSafeInteger(request.max_retries) ||
      request.max_retries < 0 ||
      request.max_retries > 5)
  ) {
    throw new Error('max_retries 必须是 0 到 5 的整数');
  }
  if (
    request.timeout_ms !== undefined &&
    (!Number.isSafeInteger(request.timeout_ms) ||
      request.timeout_ms < 1 ||
      request.timeout_ms > MAX_TIMEOUT_MS)
  ) {
    throw new Error(`timeout_ms 必须是 1 到 ${MAX_TIMEOUT_MS} 的整数`);
  }
  if (
    request.retry_base_delay_ms !== undefined &&
    (!Number.isSafeInteger(request.retry_base_delay_ms) ||
      request.retry_base_delay_ms < 0 ||
      request.retry_base_delay_ms > MAX_RETRY_DELAY_MS)
  ) {
    throw new Error(
      `retry_base_delay_ms 必须是 0 到 ${MAX_RETRY_DELAY_MS} 的整数`,
    );
  }
  if (
    request.max_repair_attempts !== undefined &&
    (!Number.isSafeInteger(request.max_repair_attempts) ||
      request.max_repair_attempts < 0 ||
      request.max_repair_attempts > MAX_REPAIRS)
  ) {
    throw new Error(`max_repair_attempts 必须是 0 到 ${MAX_REPAIRS} 的整数`);
  }
  const schema =
    request.schema === undefined
      ? undefined
      : validateAndCanonicalizeSchema<TOutput>(request.schema);
  const trace =
    request.trace === undefined
      ? undefined
      : validateAndCanonicalizeTrace(request.trace);
  if (trace) {
    if (
      !Number.isSafeInteger(trace.attempt) ||
      trace.attempt <= 0 ||
      trace.attempt > MAX_GENERATION_ATTEMPT
    ) {
      throw new Error(
        `trace.attempt 必须是 1 到 ${MAX_GENERATION_ATTEMPT} 的整数`,
      );
    }
  }
  if (
    request.idempotency_key !== undefined &&
    (typeof request.idempotency_key !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(request.idempotency_key))
  ) {
    throw new Error('idempotency_key 必须是 64 位小写 SHA-256');
  }
  const signal =
    request.signal === undefined
      ? undefined
      : snapshotTrustedAbortSignal(request.signal);

  const tools =
    request.tools === undefined ? undefined : cloneCanonicalJson(request.tools);
  const toolChoice =
    request.tool_choice !== undefined && typeof request.tool_choice === 'object'
      ? cloneCanonicalJson(request.tool_choice)
      : request.tool_choice;
  return Object.freeze({
    messages,
    ...(request.idempotency_key !== undefined
      ? { idempotency_key: request.idempotency_key }
      : {}),
    response_mode: responseMode,
    ...(schema ? { schema } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(request.temperature !== undefined
      ? { temperature: normalizeNegativeZero(request.temperature) }
      : {}),
    ...(request.max_tokens !== undefined
      ? { max_tokens: normalizeNegativeZero(request.max_tokens) }
      : {}),
    timeout_ms: normalizeNegativeZero(request.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    ...(signal !== undefined ? { signal } : {}),
    ...(trace ? { trace } : {}),
    max_retries: normalizeNegativeZero(
      request.max_retries ?? DEFAULT_MAX_RETRIES,
    ),
    max_repair_attempts: normalizeNegativeZero(
      request.max_repair_attempts ?? 1,
    ),
    retry_base_delay_ms: normalizeNegativeZero(
      request.retry_base_delay_ms ?? DEFAULT_RETRY_DELAY_MS,
    ),
  });
}

function resolveResponseMode(
  request: Pick<ModelRequest, 'response_mode' | 'schema'>,
): ModelResponseMode {
  return request.response_mode ?? (request.schema ? 'structured' : 'text');
}

function validateAndCanonicalizeMessages(
  value: unknown,
): readonly ModelMessage[] {
  assertDenseDataArray(value, 'ModelRequest.messages');
  if (value.length > MAX_MESSAGES) {
    throw new Error(`ModelRequest.messages 不能超过 ${MAX_MESSAGES} 条`);
  }
  let totalBytes = 0;
  const messages = value.map((item, index) => {
    assertExactDataRecord(
      item,
      ['role', 'content', 'name', 'tool_call_id'],
      `ModelRequest.messages[${index}]`,
    );
    const role = item.role;
    if (
      typeof role !== 'string' ||
      !['system', 'user', 'assistant', 'tool'].includes(role)
    ) {
      throw new Error(`ModelRequest.messages[${index}].role 无效`);
    }
    if (typeof item.content !== 'string') {
      throw new Error(`ModelRequest.messages[${index}].content 必须是字符串`);
    }
    const content = canonicalizeContent(item.content);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) {
      throw new Error(`ModelRequest.messages[${index}].content 超过字节上限`);
    }
    totalBytes += contentBytes;
    if (totalBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new Error('ModelRequest.messages 总字节数超过上限');
    }
    if (
      item.name !== undefined &&
      (typeof item.name !== 'string' || !isSafeIdentifier(item.name, 128))
    ) {
      throw new Error(`ModelRequest.messages[${index}].name 无效`);
    }
    if (
      item.tool_call_id !== undefined &&
      (typeof item.tool_call_id !== 'string' ||
        !isSafeIdentifier(item.tool_call_id, 128))
    ) {
      throw new Error(`ModelRequest.messages[${index}].tool_call_id 无效`);
    }
    return Object.freeze({
      role: role as ModelMessage['role'],
      content,
      ...(item.name !== undefined ? { name: item.name.normalize('NFC') } : {}),
      ...(item.tool_call_id !== undefined
        ? { tool_call_id: item.tool_call_id.normalize('NFC') }
        : {}),
    });
  });
  return Object.freeze(messages);
}

function validateAndCanonicalizeSchema<TOutput>(
  value: unknown,
): NonNullable<ModelRequest<TOutput>['schema']> {
  assertExactDataRecord(
    value,
    ['id', 'version', 'json_schema', 'parse'],
    'schema',
  );
  if (!isSafeIdentifier(value.id, 100)) {
    throw new Error('schema.id 必须是最多 100 字节的安全标识符');
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== 'string' || !isSafeIdentifier(value.version, 100))
  ) {
    throw new Error('schema.version 必须是最多 100 字节的安全标识符');
  }
  if (typeof value.parse !== 'function') {
    throw new Error('schema.parse 必须是函数');
  }
  let jsonSchema: Readonly<Record<string, unknown>> | undefined;
  if (value.json_schema !== undefined) {
    if (!isPlainRecord(value.json_schema)) {
      throw new Error('schema.json_schema 必须是普通对象');
    }
    jsonSchema = validateAndCanonicalizeJson(
      value.json_schema,
      MAX_RESPONSE_SCHEMA_BYTES,
      'schema.json_schema',
    ) as Readonly<Record<string, unknown>>;
  }
  return Object.freeze({
    id: value.id.normalize('NFC'),
    ...(value.version !== undefined
      ? { version: value.version.normalize('NFC') }
      : {}),
    ...(jsonSchema ? { json_schema: jsonSchema } : {}),
    parse: value.parse as (input: unknown) => TOutput,
  });
}

function validateAndCanonicalizeTrace(
  value: unknown,
): NonNullable<ModelRequest['trace']> {
  assertExactDataRecord(
    value,
    ['workflow_job_id', 'node', 'attempt', 'trace_id'],
    'trace',
  );
  if (!isSafeIdentifier(value.workflow_job_id, 128)) {
    throw new Error('trace.workflow_job_id 必须是最多 128 字节的安全标识符');
  }
  if (!isSafeIdentifier(value.node, 100)) {
    throw new Error('trace.node 必须是最多 100 字节的安全标识符');
  }
  if (value.trace_id !== undefined && !isSafeIdentifier(value.trace_id, 128)) {
    throw new Error('trace.trace_id 必须是最多 128 字节的安全标识符');
  }
  return Object.freeze({
    workflow_job_id: value.workflow_job_id.normalize('NFC'),
    node: value.node.normalize('NFC'),
    attempt: value.attempt as number,
    ...(value.trace_id !== undefined
      ? { trace_id: value.trace_id.normalize('NFC') }
      : {}),
  });
}

function validateToolCall(
  toolCall: ModelToolCall,
  allowedTools: ReadonlySet<string>,
  existing: readonly ModelToolCall[],
): ModelToolCall {
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(toolCall.arguments_json) as unknown;
  } catch {
    throw new ModelGatewayError({
      code: 'PROVIDER_ERROR',
      message: '模型服务返回了无效的工具参数',
      retryable: false,
    });
  }
  if (
    !isSafeIdentifier(toolCall.id, 128) ||
    !isSafeIdentifier(toolCall.name, 100) ||
    !Number.isSafeInteger(toolCall.index) ||
    toolCall.index < 0 ||
    typeof parsedArguments !== 'object' ||
    parsedArguments === null ||
    Array.isArray(parsedArguments) ||
    existing.some(
      (candidate) =>
        candidate.id === toolCall.id || candidate.index === toolCall.index,
    )
  ) {
    throw new ModelGatewayError({
      code: 'PROVIDER_ERROR',
      message: '模型服务返回了不完整的工具调用',
      retryable: false,
    });
  }
  if (!allowedTools.has(toolCall.name)) {
    throw new ModelGatewayError(unexpectedToolCall());
  }
  return toolCall;
}

function validateToolContract(
  request: ModelRequest,
  responseMode: ModelResponseMode,
): void {
  const rawTools: unknown = request.tools;
  const toolNames = new Set<string>();
  if (rawTools !== undefined) {
    assertDenseDataArray(rawTools, 'tools');
    if (rawTools.length === 0 || rawTools.length > MAX_TOOLS) {
      throw new Error('tools 必须是非空工具定义数组');
    }
    for (const rawTool of rawTools) {
      validateToolDefinition(rawTool);
      if (toolNames.has(rawTool.name)) {
        throw new Error('tools 中的工具名称必须唯一');
      }
      toolNames.add(rawTool.name);
    }
  }

  if (
    responseMode === 'tool' &&
    (!Array.isArray(rawTools) || rawTools.length === 0)
  ) {
    throw new Error('tool response_mode 必须提供 tools');
  }

  const choice: unknown = request.tool_choice;
  if (responseMode !== 'tool' && rawTools !== undefined && choice !== 'none') {
    throw new Error('非 tool response_mode 只能使用 tools + tool_choice=none');
  }
  if (choice === undefined) return;
  const validKeyword =
    choice === 'auto' || choice === 'required' || choice === 'none';
  const specificName =
    isPlainRecord(choice) &&
    hasOnlyDataProperties(choice, ['name']) &&
    Object.keys(choice).length === 1 &&
    typeof choice.name === 'string' &&
    isSafeToolName(choice.name)
      ? choice.name
      : null;
  if (!validKeyword && specificName === null) {
    throw new Error('tool_choice 必须是 auto、required、none 或具体工具名称');
  }
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    throw new Error('tool_choice 必须与 tools 一起使用');
  }
  if (specificName !== null && !toolNames.has(specificName)) {
    throw new Error('tool_choice 指定的工具不存在');
  }
  if (responseMode === 'tool' && choice === 'none') {
    throw new Error('tool response_mode 不允许 tool_choice=none');
  }
  if (responseMode !== 'tool' && choice !== 'none') {
    throw new Error('非 tool response_mode 仅允许 tool_choice=none');
  }
}

function validateToolDefinition(
  value: unknown,
): asserts value is ToolDefinition {
  assertExactDataRecord(
    value,
    ['name', 'description', 'input_schema'],
    'tool 定义',
  );
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => ['name', 'description', 'input_schema'].includes(key))
  ) {
    throw new Error('tool 定义只能包含 name、description 和 input_schema');
  }
  if (typeof value.name !== 'string' || !isSafeToolName(value.name)) {
    throw new Error('tool.name 必须是最多 64 字节的安全标识符');
  }
  if (
    typeof value.description !== 'string' ||
    value.description.trim().length === 0 ||
    value.description !== value.description.trim() ||
    Buffer.byteLength(value.description, 'utf8') > MAX_TOOL_DESCRIPTION_BYTES ||
    containsDisallowedControlCharacter(value.description)
  ) {
    throw new Error('tool.description 必须是最多 1024 字节的简短说明');
  }
  if (
    !isPlainRecord(value.input_schema) ||
    value.input_schema.type !== 'object'
  ) {
    throw new Error('tool.input_schema 必须是对象类型 JSON Schema');
  }
  try {
    validateAndCanonicalizeJson(
      value.input_schema,
      MAX_TOOL_SCHEMA_BYTES,
      'tool.input_schema',
    );
  } catch {
    throw new Error('tool.input_schema 必须是有界纯 JSON Schema');
  }
}

function containsDisallowedControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertExactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOnlyDataProperties(value, allowedKeys)) {
    throw new Error(`${label} 必须是字段闭合的普通对象`);
  }
}

function hasOnlyDataProperties(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  const keys = NATIVE_REFLECT_OWN_KEYS(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value')
    );
  });
}

function assertDenseDataArray(
  value: unknown,
  label: string,
): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} 必须是原生数组`);
  }
  const keys = NATIVE_REFLECT_OWN_KEYS(value);
  if (
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= value.length),
    )
  ) {
    throw new Error(`${label} 必须是稠密纯数据数组`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${label} 必须是稠密纯数据数组`);
    }
  }
}

function validateAndCanonicalizeJson(
  value: unknown,
  maxBytes: number,
  label: string,
): unknown {
  validateJsonShape(value, 0, {
    nodes: 0,
    keys: 0,
    active: new Set<object>(),
    label,
  });
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} 超过字节上限`);
  }
  return deepFreeze(JSON.parse(serialized) as unknown);
}

function validateJsonShape(
  value: unknown,
  depth: number,
  budget: {
    nodes: number;
    keys: number;
    active: Set<object>;
    label: string;
  },
): void {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) {
    throw new Error(`${budget.label} 超过深度或节点上限`);
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${budget.label} 只能包含有限数字`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${budget.label} 必须是纯 JSON`);
  }
  if (budget.active.has(value)) {
    throw new Error(`${budget.label} 不能包含循环引用`);
  }
  budget.active.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseDataArray(value, budget.label);
      for (const item of value) {
        validateJsonShape(item, depth + 1, budget);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      throw new Error(`${budget.label} 必须是纯 JSON`);
    }
    const keys = NATIVE_REFLECT_OWN_KEYS(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new Error(`${budget.label} 不能包含 Symbol 键`);
    }
    const stringKeys = keys as string[];
    budget.keys += stringKeys.length;
    if (budget.keys > MAX_JSON_KEYS) {
      throw new Error(`${budget.label} 超过键数量上限`);
    }
    const normalizedKeys = new Set<string>();
    for (const key of stringKeys) {
      const normalized = key.normalize('NFC');
      if (
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        normalizedKeys.has(normalized)
      ) {
        throw new Error(`${budget.label} 包含不安全或冲突键`);
      }
      normalizedKeys.add(normalized);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        throw new Error(`${budget.label} 只能包含可枚举数据属性`);
      }
      validateJsonShape(descriptor.value, depth + 1, budget);
    }
  } finally {
    budget.active.delete(value);
  }
}

function canonicalizeContent(value: string): string {
  if (containsDisallowedControlCharacter(value)) {
    throw new Error('ModelRequest message content 包含不允许的控制字符');
  }
  return value.normalize('NFC');
}

function snapshotTrustedAbortSignal(
  value: unknown,
): TrustedAbortSignalSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    utilTypes.isProxy(value) ||
    [
      'aborted',
      'reason',
      'addEventListener',
      'removeEventListener',
      'throwIfAborted',
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error('signal 必须是真实 AbortSignal');
  }

  const source = value;
  const brandProbe: EventListener = () => undefined;
  try {
    readNativeAbortSignalAborted(source);
    readNativeAbortSignalReason(source);
    applyNativeAddEventListener(source, 'abort', brandProbe, {
      once: true,
    });
    applyNativeRemoveEventListener(source, 'abort', brandProbe);
  } catch {
    throw new Error('signal 必须是真实 AbortSignal');
  }

  return Object.freeze({
    isAborted: () => readNativeAbortSignalAborted(source),
    getReason: () => readNativeAbortSignalReason(source),
    addAbortListener: (listener: EventListener) => {
      applyNativeAddEventListener(source, 'abort', listener, { once: true });
    },
    removeAbortListener: (listener: EventListener) => {
      applyNativeRemoveEventListener(source, 'abort', listener);
    },
  });
}

function requireNativeGetter(
  prototype: object,
  key: string,
): (...args: never[]) => unknown {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (typeof getter !== 'function') {
    throw new Error(`缺少原生 ${key} getter`);
  }
  return getter;
}

function requireOwnDataObject(source: object, key: string): object {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    typeof descriptor.value !== 'object' ||
    descriptor.value === null
  ) {
    throw new Error(`缺少原生 ${key} object`);
  }
  return descriptor.value as object;
}

function requireNativeReflectMethod(
  source: object,
  key: string,
): (...args: never[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  const method: unknown = descriptor?.value;
  const expectedSource = `function ${key}() { [native code] }`;
  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    typeof method !== 'function' ||
    Function.prototype.toString.call(method) !== expectedSource
  ) {
    throw new Error(`缺少原生 Reflect.${key} method`);
  }
  return method as (...args: never[]) => unknown;
}

function requireNativeMethod(
  prototype: object,
  key: string,
): (...args: never[]) => unknown {
  const method: unknown = Object.getOwnPropertyDescriptor(
    prototype,
    key,
  )?.value;
  if (typeof method !== 'function') {
    throw new Error(`缺少原生 ${key} method`);
  }
  return method as (...args: never[]) => unknown;
}

function readNativeAbortSignalAborted(source: object): boolean {
  return NATIVE_REFLECT_APPLY(NATIVE_ABORTED_GETTER, source, []) === true;
}

function readNativeAbortSignalReason(source: object): unknown {
  return NATIVE_REFLECT_APPLY(NATIVE_REASON_GETTER, source, []);
}

function applyNativeAddEventListener(
  source: object,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean,
): void {
  NATIVE_REFLECT_APPLY(NATIVE_ADD_EVENT_LISTENER, source, [
    type,
    listener,
    options,
  ]);
}

function applyNativeRemoveEventListener(
  source: object,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: EventListenerOptions | boolean,
): void {
  NATIVE_REFLECT_APPLY(NATIVE_REMOVE_EVENT_LISTENER, source, [
    type,
    listener,
    options,
  ]);
}

function isTrustedSignalAborted(
  signal: TrustedAbortSignalSnapshot | undefined,
): boolean {
  return signal?.isAborted() === true;
}

function validateAndCanonicalizeUsage(value: unknown): Readonly<ModelUsage> {
  assertExactDataRecord(
    value,
    [
      'input_tokens',
      'output_tokens',
      'total_tokens',
      'cached_input_tokens',
      'cache_creation_input_tokens',
      'reasoning_tokens',
    ],
    'ModelUsage',
  );
  const requiredKeys = [
    'input_tokens',
    'output_tokens',
    'total_tokens',
  ] as const;
  for (const key of requiredKeys) {
    if (!isNonNegativeSafeInteger(value[key])) {
      throw new Error(`ModelUsage.${key} 必须是非负安全整数`);
    }
  }
  const optionalKeys = [
    'cached_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
  ] as const;
  for (const key of optionalKeys) {
    if (value[key] !== undefined && !isNonNegativeSafeInteger(value[key])) {
      throw new Error(`ModelUsage.${key} 必须是非负安全整数`);
    }
  }
  const inputTokens = normalizeNegativeZero(value.input_tokens as number);
  const outputTokens = normalizeNegativeZero(value.output_tokens as number);
  const totalTokens = normalizeNegativeZero(value.total_tokens as number);
  if (
    !Number.isSafeInteger(inputTokens + outputTokens) ||
    totalTokens !== inputTokens + outputTokens ||
    Number(value.cached_input_tokens ?? 0) > inputTokens
  ) {
    throw new Error('ModelUsage token 总数不一致');
  }
  return Object.freeze({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(value.cached_input_tokens !== undefined
      ? {
          cached_input_tokens: normalizeNegativeZero(
            value.cached_input_tokens as number,
          ),
        }
      : {}),
    ...(value.cache_creation_input_tokens !== undefined
      ? {
          cache_creation_input_tokens: normalizeNegativeZero(
            value.cache_creation_input_tokens as number,
          ),
        }
      : {}),
    ...(value.reasoning_tokens !== undefined
      ? {
          reasoning_tokens: normalizeNegativeZero(
            value.reasoning_tokens as number,
          ),
        }
      : {}),
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateAndCanonicalizeOperationLookup(
  workflowJobId: unknown,
  operation: unknown,
): {
  workflowJobId: string;
  operation: string | Readonly<ModelOperationIdentity>;
} {
  if (!isSafeIdentifier(workflowJobId, 128)) {
    throw new Error('workflowJobId 必须是最多 128 字节的安全标识符');
  }
  if (typeof operation === 'string') {
    if (!isSha256(operation)) {
      throw new Error('operation key 必须是 64 位小写 SHA-256');
    }
    return { workflowJobId: workflowJobId.normalize('NFC'), operation };
  }
  assertExactDataRecord(
    operation,
    [
      'version',
      'operation_key',
      'request_fingerprint',
      'prompt_sha256',
      'provider',
      'model',
      'schema_id',
      'schema_version',
      'schema_sha256',
    ],
    'ModelOperationIdentity',
  );
  if (
    operation.version !== 'model-operation.v1' ||
    !isSha256(operation.operation_key) ||
    !isSha256(operation.request_fingerprint) ||
    !isSha256(operation.prompt_sha256) ||
    !isSafeIdentifier(operation.provider, 50) ||
    !isSafeIdentifier(operation.model, 100)
  ) {
    throw new Error('ModelOperationIdentity 无效');
  }
  const schemaId = nullableSafeIdentifier(operation.schema_id, 100);
  const schemaVersion = nullableSafeIdentifier(operation.schema_version, 100);
  const schemaSha =
    operation.schema_sha256 === null && operation.schema_id !== null
      ? null
      : operation.schema_sha256;
  if (
    schemaId === undefined ||
    schemaVersion === undefined ||
    (schemaSha !== null && !isSha256(schemaSha)) ||
    (schemaId === null &&
      (schemaVersion !== null || operation.schema_sha256 !== null))
  ) {
    throw new Error('ModelOperationIdentity schema 无效');
  }
  return {
    workflowJobId: workflowJobId.normalize('NFC'),
    operation: Object.freeze({
      version: 'model-operation.v1',
      operation_key: operation.operation_key,
      request_fingerprint: operation.request_fingerprint,
      prompt_sha256: operation.prompt_sha256,
      provider: operation.provider.normalize('NFC'),
      model: operation.model.normalize('NFC'),
      schema_id: schemaId,
      schema_version: schemaVersion,
      schema_sha256: schemaSha,
    }),
  };
}

function nullableSafeIdentifier(
  value: unknown,
  maxBytes: number,
): string | null | undefined {
  if (value === null) return null;
  return isSafeIdentifier(value, maxBytes) ? value.normalize('NFC') : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function resolveAdapter(value: ModelAdapter): ModelAdapter {
  if (typeof value !== 'object' || value === null) {
    throw new Error('MODEL_ADAPTER_IDENTITY_INVALID');
  }
  const provider = value.provider;
  const model = value.model;
  const streamMethod = NATIVE_REFLECT_GET(value, 'stream');
  if (
    !isSafeIdentifier(provider, 50) ||
    !isSafeIdentifier(model, 100) ||
    typeof streamMethod !== 'function'
  ) {
    throw new Error('MODEL_ADAPTER_IDENTITY_INVALID');
  }
  const capturedStreamMethod = streamMethod as ModelAdapter['stream'];
  const stream: ModelAdapter['stream'] = (request, attempt) =>
    // Preserve the adapter receiver while snapshotting the dispatch function.
    NATIVE_REFLECT_APPLY(capturedStreamMethod, value, [
      request,
      attempt,
    ]) as AsyncIterable<ModelEvent>;
  return Object.freeze({
    provider: provider.normalize('NFC'),
    model: model.normalize('NFC'),
    stream,
  });
}

function estimateInputTokenUpperBound(request: CanonicalModelRequest): number {
  const serialized = canonicalJson({
    messages: request.messages,
    response_mode: request.response_mode,
    schema: request.schema
      ? {
          id: request.schema.id,
          version: request.schema.version ?? null,
          json_schema: request.schema.json_schema ?? null,
        }
      : null,
    tools: request.tools ?? null,
    tool_choice: request.tool_choice ?? null,
  });
  return Buffer.byteLength(serialized, 'utf8') * 2 + 16_384;
}

function isSafeToolName(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= 64 &&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  );
}

function getAllowedToolNames(
  tools: readonly ToolDefinition[] | undefined,
): ReadonlySet<string> {
  return new Set((tools ?? []).map((tool) => tool.name));
}

function validateTerminalForMode(
  mode: ModelResponseMode,
  finishReason: ModelFinishReason,
  toolCallCount: number,
): ModelError | null {
  if (mode === 'tool') {
    if (finishReason !== 'tool_call' || toolCallCount === 0) {
      return {
        code: 'TOOL_CALL_REQUIRED',
        message: '模型未返回完整工具调用',
        retryable: false,
      };
    }
    return null;
  }
  return finishReason === 'tool_call' ? unexpectedToolCall() : null;
}

function unexpectedToolCall(): ModelError {
  return {
    code: 'UNEXPECTED_TOOL_CALL',
    message: '当前响应模式不允许工具调用',
    retryable: false,
  };
}

function isSafeIdentifier(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function withAttempt(event: ModelEvent, attempt: number): ModelEvent {
  return { ...event, attempt };
}

function validateModelUsage(value: ModelUsage): ModelUsage {
  try {
    return validateAndCanonicalizeUsage(value) as ModelUsage;
  } catch {
    throw new ModelGatewayError({
      code: 'PROVIDER_ERROR',
      message: '模型服务返回了无效的用量数据',
      retryable: false,
    });
  }
}

function validateStructuredOutput<T>(
  text: string,
  parse: (value: unknown) => T,
): { ok: true; value: T } | { ok: false; details: string } {
  try {
    const value = JSON.parse(extractJson(text)) as unknown;
    return { ok: true, value: parse(value) };
  } catch (error: unknown) {
    return {
      ok: false,
      details:
        error instanceof Error
          ? error.message.slice(0, 500)
          : 'unknown validation error',
    };
  }
}

function extractJson(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (
    objectStart >= 0 &&
    objectEnd > objectStart &&
    (arrayStart < 0 || objectStart < arrayStart)
  ) {
    return cleaned.slice(objectStart, objectEnd + 1);
  }
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    return cleaned.slice(arrayStart, arrayEnd + 1);
  }
  return cleaned;
}

function buildRepairMessages(
  original: readonly ModelMessage[],
  invalidOutput: string,
  details: string,
  schemaId: string,
): ModelMessage[] {
  return [
    ...original,
    {
      role: 'assistant',
      content: invalidOutput.slice(0, 64 * 1024),
    },
    {
      role: 'user',
      content:
        `上一次输出未通过结构化校验（schema: ${schemaId}）：${details}。` +
        '请只返回修正后的 JSON，不要添加解释或 Markdown 代码围栏。',
    },
  ];
}

function hashMessages(messages: readonly ModelMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function cloneCanonicalJson<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MODEL_INPUT_NOT_CANONICAL');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const prototype = NATIVE_REFLECT_GET_PROTOTYPE_OF(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('MODEL_INPUT_NOT_CANONICAL');
    }
    const keys = Object.keys(record)
      .map((source) => ({ source, normalized: source.normalize('NFC') }))
      .sort((left, right) =>
        left.normalized < right.normalized
          ? -1
          : left.normalized > right.normalized
            ? 1
            : 0,
      );
    if (
      keys.some(
        (entry, index) =>
          index > 0 && keys[index - 1]?.normalized === entry.normalized,
      )
    ) {
      throw new Error('MODEL_INPUT_NOT_CANONICAL');
    }
    return `{${keys
      .map(({ source, normalized }) => {
        const item = record[source];
        if (item === undefined) throw new Error('MODEL_INPUT_NOT_CANONICAL');
        return `${JSON.stringify(normalized)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new Error('MODEL_INPUT_NOT_CANONICAL');
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function normalizeModelError(
  error: unknown,
  timedOut: boolean,
  externallyAborted: boolean,
): ModelError {
  if (externallyAborted) {
    return {
      code: 'ABORTED',
      message: '模型请求已取消',
      retryable: false,
    };
  }
  if (timedOut) {
    return {
      code: 'TIMEOUT',
      message: '模型请求超时',
      retryable: true,
    };
  }
  if (error instanceof ModelGatewayError) return error.modelError;
  if (isSdkAbortError(error) || isAbortLike(error)) {
    return {
      code: 'ABORTED',
      message: '模型请求已取消',
      retryable: false,
    };
  }
  if (isSdkTimeoutError(error)) {
    return {
      code: 'TIMEOUT',
      message: '模型请求超时',
      retryable: true,
    };
  }

  const status = readStatus(error);
  const retryAfterMs = readRetryAfter(error);
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: '模型服务请求过于频繁',
      retryable: true,
      status,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      message: '模型服务暂时不可用',
      retryable: true,
      status,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: '模型服务认证失败',
      retryable: false,
      status,
    };
  }
  if (status !== undefined && status >= 400) {
    return {
      code: 'BAD_REQUEST',
      message: '模型请求无效',
      retryable: false,
      status,
    };
  }
  if (isTransientNetworkError(error)) {
    return {
      code: 'NETWORK_ERROR',
      message: '模型服务网络异常',
      retryable: true,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    message: '模型服务调用失败',
    retryable: false,
  };
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value =
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function isRetryableModelError(error: ModelError): boolean {
  return (
    error.retryable &&
    [
      'TIMEOUT',
      'RATE_LIMITED',
      'PROVIDER_UNAVAILABLE',
      'NETWORK_ERROR',
    ].includes(error.code)
  );
}

function readRetryAfter(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  const raw: unknown =
    typeof get === 'function'
      ? (get as (name: string) => unknown).call(headers, 'retry-after')
      : ((headers as Record<string, unknown>)['retry-after'] ??
        (headers as Record<string, unknown>)['Retry-After']);
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const timestamp = Date.parse(String(raw));
  if (!Number.isNaN(timestamp)) {
    return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function isTransientNetworkError(error: unknown): boolean {
  if (
    error instanceof OpenAI.APIConnectionError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return true;
  }
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (visited.has(current)) return false;
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(code)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isAbortLike(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isSdkAbortError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof Anthropic.APIUserAbortError
  );
}

function isSdkTimeoutError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIConnectionTimeoutError
  );
}

function invalidTerminalReason(reason: unknown): ModelError | null {
  if (reason === 'stop' || reason === 'tool_call') return null;
  if (reason === 'length' || reason === 'max_tokens') {
    return {
      code: 'INCOMPLETE_OUTPUT',
      message: '模型输出未完整结束',
      retryable: false,
    };
  }
  if (reason === 'content_filter' || reason === 'refusal') {
    return {
      code: 'CONTENT_FILTERED',
      message: '模型输出被安全策略过滤',
      retryable: false,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    message: '模型服务返回了未知终止原因',
    retryable: false,
  };
}

function calculateRetryDelay(
  retryCount: number,
  baseDelayMs: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const base = Math.min(
    Math.max(0, baseDelayMs) * 2 ** retryCount,
    MAX_RETRY_DELAY_MS,
  );
  return Math.round(base + Math.random() * base * 0.25);
}

function abortableDelay(
  ms: number,
  signal?: TrustedAbortSignalSnapshot,
): Promise<void> {
  if (isTrustedSignalAborted(signal)) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      signal?.removeAbortListener(onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addAbortListener(onAbort);
    if (isTrustedSignalAborted(signal)) onAbort();
  });
}

function abortReason(signal: TrustedAbortSignalSnapshot | undefined): Error {
  const reason: unknown = signal?.getReason();
  return reason instanceof Error
    ? reason
    : new DOMException('aborted', 'AbortError');
}

function combineAbortSignals(
  external: TrustedAbortSignalSnapshot | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new NATIVE_ABORT_CONTROLLER();
  let didTimeout = false;
  const onExternalAbort = () => {
    abortGatewayOwnedController(
      controller,
      external?.getReason() ?? new DOMException('aborted', 'AbortError'),
    );
  };
  external?.addAbortListener(onExternalAbort);
  if (isTrustedSignalAborted(external)) onExternalAbort();
  const timer = setTimeout(() => {
    didTimeout = true;
    abortGatewayOwnedController(
      controller,
      new DOMException('timeout', 'TimeoutError'),
    );
  }, timeoutMs);
  timer.unref?.();
  const signal = hardenGatewayOwnedAbortSignal(
    readGatewayOwnedAbortControllerSignal(controller),
  );

  return {
    signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeAbortListener(onExternalAbort);
    },
  };
}

function abortGatewayOwnedController(
  controller: InstanceType<typeof NATIVE_ABORT_CONTROLLER>,
  reason: unknown,
): void {
  NATIVE_REFLECT_APPLY(NATIVE_ABORT_CONTROLLER_ABORT, controller, [reason]);
}

function readGatewayOwnedAbortControllerSignal(
  controller: InstanceType<typeof NATIVE_ABORT_CONTROLLER>,
): AbortSignal {
  return NATIVE_REFLECT_APPLY(
    NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER,
    controller,
    [],
  ) as AbortSignal;
}

function hardenGatewayOwnedAbortSignal(signal: AbortSignal): AbortSignal {
  const source = signal as object;
  Object.defineProperties(signal, {
    aborted: {
      configurable: false,
      enumerable: true,
      get: () => readNativeAbortSignalAborted(source),
    },
    reason: {
      configurable: false,
      enumerable: true,
      get: () => readNativeAbortSignalReason(source),
    },
    addEventListener: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean,
      ) => {
        applyNativeAddEventListener(source, type, listener, options);
      },
    },
    removeEventListener: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) => {
        applyNativeRemoveEventListener(source, type, listener, options);
      },
    },
    throwIfAborted: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => NATIVE_REFLECT_APPLY(NATIVE_THROW_IF_ABORTED, source, []),
    },
  });
  Object.preventExtensions(signal);
  return signal;
}
