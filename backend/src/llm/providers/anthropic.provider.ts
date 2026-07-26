import Anthropic from '@anthropic-ai/sdk';
import {
  LLMProvider,
  LLMConfig,
  LLMStreamEvent,
  LLMStreamOptions,
} from '../llm.interface';
import type {
  ModelAdapter,
  ModelError,
  ModelEvent,
  ModelFinishReason,
  ModelRequest,
  ModelToolChoice,
  ModelUsage,
} from '../model-types.js';
import type {
  Tool as AnthropicTool,
  ToolChoice as AnthropicToolChoice,
} from '@anthropic-ai/sdk/resources/messages';

export class AnthropicProvider implements LLMProvider, ModelAdapter {
  private client: Anthropic;
  readonly provider = 'anthropic';
  readonly model: string;

  constructor(config: LLMConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  async *stream(
    request: ModelRequest,
    attempt: number,
  ): AsyncIterable<ModelEvent> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role:
          message.role === 'assistant'
            ? ('assistant' as const)
            : ('user' as const),
        content: message.content,
      }));
    const toolConfig = buildAnthropicToolConfig(request);
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: request.max_tokens ?? 32_000,
        system: appendSchemaInstruction(system, request),
        messages,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...toolConfig,
      },
      request.signal || request.idempotency_key
        ? {
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.idempotency_key
              ? {
                  maxRetries: 0,
                  headers: {
                    'X-Client-Request-Id': request.idempotency_key,
                  },
                }
              : {}),
          }
        : undefined,
    );

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;
    let finishReason: ModelFinishReason | null = null;
    let terminalError: ModelError | null = null;
    const responseMode =
      request.response_mode ?? (request.schema ? 'structured' : 'text');
    const allowedToolNames = new Set(
      (request.tools ?? []).map((tool) => tool.name),
    );
    const toolBlocks = new Map<
      number,
      {
        id: string;
        name: string;
        startArgumentsJson: string | null;
        streamedArgumentsJson: string;
        sawDelta: boolean;
        stopped: boolean;
      }
    >();
    const seenBlockIndexes = new Set<number>();

    for await (const rawEvent of stream) {
      const event = rawEvent as unknown as Record<string, unknown>;
      switch (event.type) {
        case 'message_start': {
          const usage = asRecord(asRecord(event.message).usage);
          inputTokens = readInteger(usage.input_tokens);
          cachedInputTokens = readOptionalInteger(
            usage.cache_read_input_tokens,
          );
          cacheCreationInputTokens = readOptionalInteger(
            usage.cache_creation_input_tokens,
          );
          break;
        }
        case 'content_block_delta': {
          const delta = asRecord(event.delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield { type: 'text_delta', text: delta.text, attempt };
          } else if (
            delta.type === 'input_json_delta' &&
            typeof delta.partial_json === 'string'
          ) {
            const index = readToolIndex(event.index);
            const tool = index === null ? undefined : toolBlocks.get(index);
            if (index === null || !tool || tool.stopped) {
              yield {
                type: 'error',
                error: invalidToolCallError(),
                attempt,
              };
              return;
            }
            if (!tool.sawDelta) {
              if (
                tool.startArgumentsJson !== null &&
                tool.startArgumentsJson !== '{}'
              ) {
                yield {
                  type: 'error',
                  error: invalidToolCallError(),
                  attempt,
                };
                return;
              }
              tool.streamedArgumentsJson = delta.partial_json;
              tool.sawDelta = true;
            } else {
              tool.streamedArgumentsJson += delta.partial_json;
            }
          }
          break;
        }
        case 'content_block_start': {
          const index = readToolIndex(event.index);
          const block = asRecord(event.content_block);
          if (index === null || seenBlockIndexes.has(index)) {
            yield { type: 'error', error: invalidToolCallError(), attempt };
            return;
          }
          seenBlockIndexes.add(index);
          if (block.type !== 'tool_use') break;
          if (
            typeof block.id !== 'string' ||
            typeof block.name !== 'string' ||
            !isSafeToolId(block.id) ||
            !isSafeToolName(block.name) ||
            toolBlocks.has(index) ||
            [...toolBlocks.values()].some((tool) => tool.id === block.id)
          ) {
            yield { type: 'error', error: invalidToolCallError(), attempt };
            return;
          }
          const startArgumentsJson = serializeToolInput(block.input);
          if (startArgumentsJson === undefined) {
            yield { type: 'error', error: invalidToolCallError(), attempt };
            return;
          }
          toolBlocks.set(index, {
            id: block.id,
            name: block.name,
            startArgumentsJson,
            streamedArgumentsJson: '',
            sawDelta: false,
            stopped: false,
          });
          break;
        }
        case 'content_block_stop': {
          const index = readToolIndex(event.index);
          const tool = index === null ? undefined : toolBlocks.get(index);
          if (index === null) {
            yield {
              type: 'error',
              error: invalidToolCallError(),
              attempt,
            };
            return;
          }
          if (!tool) break;
          if (tool.stopped) {
            yield {
              type: 'error',
              error: invalidToolCallError(),
              attempt,
            };
            return;
          }
          tool.stopped = true;
          break;
        }
        case 'message_delta': {
          const delta = asRecord(event.delta);
          if (typeof delta.stop_reason === 'string') {
            const terminal = normalizeAnthropicStopReason(delta.stop_reason);
            finishReason = terminal.finishReason;
            terminalError = terminal.error;
          }
          outputTokens = readInteger(asRecord(event.usage).output_tokens);
          break;
        }
        case 'message_stop': {
          const usage: ModelUsage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            ...(cachedInputTokens !== undefined
              ? { cached_input_tokens: cachedInputTokens }
              : {}),
            ...(cacheCreationInputTokens !== undefined
              ? { cache_creation_input_tokens: cacheCreationInputTokens }
              : {}),
          };
          if (terminalError) {
            yield { type: 'usage', usage, attempt };
            yield { type: 'error', error: terminalError, attempt };
          } else if (finishReason) {
            const toolCalls = [...toolBlocks.entries()]
              .sort(([left], [right]) => left - right)
              .map(([index, tool]) => ({
                id: tool.id,
                name: tool.name,
                argumentsJson: tool.sawDelta
                  ? tool.streamedArgumentsJson
                  : (tool.startArgumentsJson ?? '{}'),
                index,
                stopped: tool.stopped,
              }));
            const toolError = validateAnthropicToolCalls(
              responseMode,
              toolCalls,
              allowedToolNames,
            );
            if (toolError) {
              yield { type: 'usage', usage, attempt };
              yield { type: 'error', error: toolError, attempt };
              return;
            }
            const modeError = validateProviderTerminal(
              responseMode,
              finishReason,
              toolCalls.length,
            );
            if (modeError) {
              yield { type: 'usage', usage, attempt };
              yield { type: 'error', error: modeError, attempt };
            } else {
              for (const tool of toolCalls) {
                yield {
                  type: 'tool_call',
                  tool_call: {
                    id: tool.id,
                    name: tool.name,
                    arguments_json: tool.argumentsJson,
                    index: tool.index,
                  },
                  attempt,
                };
              }
              yield { type: 'usage', usage, attempt };
              yield { type: 'completed', finish_reason: finishReason, attempt };
            }
          } else {
            yield { type: 'usage', usage, attempt };
            yield {
              type: 'error',
              error: {
                code: 'PROVIDER_ERROR',
                message: '模型服务未返回终止原因',
                retryable: false,
              },
              attempt,
            };
          }
          break;
        }
      }
    }
  }

  async *streamCompletion(
    prompt: string,
    systemPrompt?: string,
    temperature?: number,
    options?: LLMStreamOptions,
  ): AsyncIterable<LLMStreamEvent> {
    for await (const event of this.stream(
      {
        messages: [
          ...(systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }]
            : []),
          { role: 'user', content: prompt },
        ],
        ...(temperature !== undefined ? { temperature } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      1,
    )) {
      if (event.type === 'text_delta') {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: event.text },
        };
      } else {
        yield { type: event.type };
      }
    }
  }
}

function validateToolResponse(
  mode: 'text' | 'structured' | 'tool',
  id: string,
  name: string,
  argumentsJson: string,
  allowedTools: ReadonlySet<string>,
): ModelError | null {
  if (mode !== 'tool' || !allowedTools.has(name)) {
    return {
      code: 'UNEXPECTED_TOOL_CALL',
      message: '当前响应模式不允许工具调用',
      retryable: false,
    };
  }
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (
      !isSafeToolId(id) ||
      !isSafeToolName(name) ||
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('invalid tool call');
    }
  } catch {
    return {
      code: 'PROVIDER_ERROR',
      message: '模型服务返回了不完整的工具调用',
      retryable: false,
    };
  }
  return null;
}

function validateAnthropicToolCalls(
  mode: 'text' | 'structured' | 'tool',
  calls: readonly {
    id: string;
    name: string;
    argumentsJson: string;
    index: number;
    stopped: boolean;
  }[],
  allowedTools: ReadonlySet<string>,
): ModelError | null {
  if (calls.length > 0 && mode !== 'tool') {
    return {
      code: 'UNEXPECTED_TOOL_CALL',
      message: '当前响应模式不允许工具调用',
      retryable: false,
    };
  }
  for (const call of calls) {
    if (!call.stopped) return invalidToolCallError();
    const error = validateToolResponse(
      mode,
      call.id,
      call.name,
      call.argumentsJson,
      allowedTools,
    );
    if (error) return error;
  }
  return null;
}

function invalidToolCallError(): ModelError {
  return {
    code: 'PROVIDER_ERROR',
    message: '模型服务返回了不完整的工具调用',
    retryable: false,
  };
}

function validateProviderTerminal(
  mode: 'text' | 'structured' | 'tool',
  finishReason: ModelFinishReason,
  toolCallCount: number,
): ModelError | null {
  if (mode === 'tool') {
    return finishReason === 'tool_call' && toolCallCount > 0
      ? null
      : {
          code: 'TOOL_CALL_REQUIRED',
          message: '模型未返回完整工具调用',
          retryable: false,
        };
  }
  return finishReason === 'tool_call'
    ? {
        code: 'UNEXPECTED_TOOL_CALL',
        message: '当前响应模式不允许工具调用',
        retryable: false,
      }
    : null;
}

function normalizeAnthropicStopReason(reason: string): {
  finishReason: ModelFinishReason | null;
  error: ModelError | null;
} {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'stop', error: null };
    case 'tool_use':
      return { finishReason: 'tool_call', error: null };
    case 'max_tokens':
    case 'pause_turn':
      return {
        finishReason: null,
        error: {
          code: 'INCOMPLETE_OUTPUT',
          message: '模型输出未完整结束',
          retryable: false,
        },
      };
    case 'content_filter':
    case 'refusal':
      return {
        finishReason: null,
        error: {
          code: 'CONTENT_FILTERED',
          message: '模型输出被安全策略过滤',
          retryable: false,
        },
      };
    default:
      return {
        finishReason: null,
        error: {
          code: 'PROVIDER_ERROR',
          message: '模型服务返回了未知终止原因',
          retryable: false,
        },
      };
  }
}

function buildAnthropicToolConfig(request: ModelRequest): {
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
} {
  if (!request.tools || request.tools.length === 0) return {};
  const tools = request.tools.map(
    (tool): AnthropicTool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as AnthropicTool['input_schema'],
    }),
  );
  const choice =
    request.tool_choice ??
    (request.response_mode === 'tool' ? ('required' as const) : undefined);
  return {
    tools,
    ...(choice === undefined
      ? {}
      : { tool_choice: mapAnthropicToolChoice(choice) }),
  };
}

function mapAnthropicToolChoice(choice: ModelToolChoice): AnthropicToolChoice {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: choice.name };
}

function serializeToolInput(input: unknown): string | null | undefined {
  if (input === undefined) return null;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function readToolIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function isSafeToolId(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function isSafeToolName(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') <= 64 &&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
  );
}

function appendSchemaInstruction(
  system: string,
  request: ModelRequest,
): string {
  if (!request.schema) return system;
  const schema = request.schema.json_schema
    ? JSON.stringify(request.schema.json_schema)
    : request.schema.id;
  return [
    system,
    `Return only JSON matching schema ${request.schema.id}: ${schema}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function readOptionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}
