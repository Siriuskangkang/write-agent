import OpenAI from 'openai';
import {
  LLMProvider,
  LLMConfig,
  LLMStreamEvent,
  LLMStreamOptions,
} from '../llm.interface';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions';
import type {
  ModelAdapter,
  ModelError,
  ModelEvent,
  ModelFinishReason,
  ModelRequest,
  ModelToolChoice,
  ModelUsage,
} from '../model-types.js';

export class DeepSeekProvider implements LLMProvider, ModelAdapter {
  private client: OpenAI;
  readonly provider = 'deepseek';
  readonly model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  async *stream(
    request: ModelRequest,
    attempt: number,
  ): AsyncIterable<ModelEvent> {
    const messages = request.messages.map(
      (message): ChatCompletionMessageParam => {
        if (message.role === 'tool') {
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.tool_call_id ?? 'unknown',
          };
        }
        return {
          role: message.role,
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        } as ChatCompletionMessageParam;
      },
    );
    const toolConfig = buildDeepSeekToolConfig(request);
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.max_tokens !== undefined
          ? { max_tokens: request.max_tokens }
          : {}),
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.schema ? { response_format: { type: 'json_object' } } : {}),
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

    let finishReason: ModelFinishReason | null = null;
    let terminalError: ModelError | null = null;
    let usage: ModelUsage | null = null;
    const responseMode =
      request.response_mode ?? (request.schema ? 'structured' : 'text');
    const allowedToolNames = new Set(
      (request.tools ?? []).map((tool) => tool.name),
    );
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; argumentsJson: string }
    >();
    for await (const rawChunk of stream) {
      const chunk = rawChunk as unknown as Record<string, unknown>;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = asRecord(choices[0]);
      const delta = asRecord(choice.delta);
      if (typeof delta.content === 'string' && delta.content !== '') {
        yield { type: 'text_delta', text: delta.content, attempt };
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawToolCall of toolCalls) {
        const toolCall = asRecord(rawToolCall);
        const fn = asRecord(toolCall.function);
        const index = readToolIndex(toolCall.index);
        if (
          index === null ||
          (toolCall.type !== undefined && toolCall.type !== 'function') ||
          (fn.arguments !== undefined && typeof fn.arguments !== 'string')
        ) {
          yield { type: 'error', error: invalidToolCallError(), attempt };
          return;
        }
        const current = pendingToolCalls.get(index);
        if (!current) {
          if (
            typeof toolCall.id !== 'string' ||
            typeof fn.name !== 'string' ||
            !isSafeToolId(toolCall.id) ||
            !isSafeToolName(fn.name) ||
            [...pendingToolCalls.values()].some(
              (candidate) => candidate.id === toolCall.id,
            )
          ) {
            yield { type: 'error', error: invalidToolCallError(), attempt };
            return;
          }
          pendingToolCalls.set(index, {
            id: toolCall.id,
            name: fn.name,
            argumentsJson: typeof fn.arguments === 'string' ? fn.arguments : '',
          });
          continue;
        }
        if (
          (toolCall.id !== undefined &&
            (typeof toolCall.id !== 'string' || toolCall.id !== current.id)) ||
          (fn.name !== undefined &&
            (typeof fn.name !== 'string' || fn.name !== current.name))
        ) {
          yield { type: 'error', error: invalidToolCallError(), attempt };
          return;
        }
        if (typeof fn.arguments === 'string') {
          current.argumentsJson += fn.arguments;
        }
      }
      if (typeof choice.finish_reason === 'string') {
        const terminal = normalizeDeepSeekFinishReason(choice.finish_reason);
        finishReason = terminal.finishReason;
        terminalError = terminal.error;
      }
      if (isRecord(chunk.usage)) {
        const rawUsage = chunk.usage;
        const inputTokens = readInteger(rawUsage.prompt_tokens);
        const outputTokens = readInteger(rawUsage.completion_tokens);
        const promptDetails = asRecord(rawUsage.prompt_tokens_details);
        const completionDetails = asRecord(rawUsage.completion_tokens_details);
        usage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          ...(readOptionalInteger(promptDetails.cached_tokens) !== undefined
            ? {
                cached_input_tokens: readOptionalInteger(
                  promptDetails.cached_tokens,
                ),
              }
            : {}),
          ...(readOptionalInteger(promptDetails.cache_creation_tokens) !==
          undefined
            ? {
                cache_creation_input_tokens: readOptionalInteger(
                  promptDetails.cache_creation_tokens,
                ),
              }
            : {}),
          ...(readOptionalInteger(completionDetails.reasoning_tokens) !==
          undefined
            ? {
                reasoning_tokens: readOptionalInteger(
                  completionDetails.reasoning_tokens,
                ),
              }
            : {}),
        };
      }
    }
    if (finishReason || terminalError) {
      const toolCalls = [...pendingToolCalls].sort(
        ([left], [right]) => left - right,
      );
      if (terminalError) {
        if (usage) yield { type: 'usage', usage, attempt };
        yield { type: 'error', error: terminalError, attempt };
        return;
      }
      if (pendingToolCalls.size > 0 && responseMode !== 'tool') {
        yield {
          type: 'error',
          error: {
            code: 'UNEXPECTED_TOOL_CALL',
            message: '当前响应模式不允许工具调用',
            retryable: false,
          },
          attempt,
        };
        return;
      }
      if (
        !terminalError &&
        responseMode === 'tool' &&
        (finishReason !== 'tool_call' || toolCalls.length === 0)
      ) {
        yield {
          type: 'error',
          error: {
            code: 'TOOL_CALL_REQUIRED',
            message: '模型未返回完整工具调用',
            retryable: false,
          },
          attempt,
        };
        return;
      }
      if (
        !terminalError &&
        responseMode !== 'tool' &&
        finishReason === 'tool_call'
      ) {
        yield {
          type: 'error',
          error: {
            code: 'UNEXPECTED_TOOL_CALL',
            message: '当前响应模式不允许工具调用',
            retryable: false,
          },
          attempt,
        };
        return;
      }
      for (const [index, toolCall] of toolCalls) {
        const toolError = validateToolResponse(
          toolCall.id,
          toolCall.name,
          toolCall.argumentsJson || '{}',
          allowedToolNames,
        );
        if (toolError) {
          yield { type: 'error', error: toolError, attempt };
          return;
        }
        yield {
          type: 'tool_call',
          tool_call: {
            id: toolCall.id,
            name: toolCall.name,
            arguments_json: toolCall.argumentsJson || '{}',
            index,
          },
          attempt,
        };
      }
      if (usage) yield { type: 'usage', usage, attempt };
      if (finishReason) {
        yield { type: 'completed', finish_reason: finishReason, attempt };
      }
      return;
    }
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
          delta: {
            type: 'text_delta',
            text: event.text,
          },
        };
      } else {
        yield { type: event.type };
      }
    }
  }
}

function validateToolResponse(
  id: string,
  name: string,
  argumentsJson: string,
  allowedTools: ReadonlySet<string>,
): ModelError | null {
  if (!allowedTools.has(name)) {
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

function invalidToolCallError(): ModelError {
  return {
    code: 'PROVIDER_ERROR',
    message: '模型服务返回了不完整的工具调用',
    retryable: false,
  };
}

function normalizeDeepSeekFinishReason(reason: string): {
  finishReason: ModelFinishReason | null;
  error: ModelError | null;
} {
  switch (reason) {
    case 'stop':
      return { finishReason: 'stop', error: null };
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_call', error: null };
    case 'length':
    case 'max_tokens':
      return {
        finishReason: null,
        error: {
          code: 'INCOMPLETE_OUTPUT',
          message: '模型输出未完整结束',
          retryable: false,
        },
      };
    case 'content_filter':
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

function buildDeepSeekToolConfig(request: ModelRequest): {
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
} {
  if (!request.tools || request.tools.length === 0) return {};
  const tools: ChatCompletionTool[] = request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
  const choice =
    request.tool_choice ??
    (request.response_mode === 'tool' ? ('required' as const) : undefined);
  return {
    tools,
    ...(choice === undefined
      ? {}
      : { tool_choice: mapDeepSeekToolChoice(choice) }),
  };
}

function mapDeepSeekToolChoice(
  choice: ModelToolChoice,
): ChatCompletionToolChoiceOption {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function readOptionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}
