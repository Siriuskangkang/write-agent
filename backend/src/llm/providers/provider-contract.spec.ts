/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type {
  ModelEvent,
  ModelRequest,
  ToolDefinition,
} from '../model-types.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { DeepSeekProvider } from './deepseek.provider.js';

const request: ModelRequest = {
  messages: [
    { role: 'system', content: 'You are precise.' },
    { role: 'user', content: 'Answer.' },
  ],
  temperature: 0.2,
  max_tokens: 128,
  response_mode: 'text',
  trace: {
    workflow_job_id: '11111111-1111-4111-8111-111111111111',
    node: 'draft',
    attempt: 1,
  },
};

const toolDefinitions: readonly ToolDefinition[] = [
  {
    name: 'lookup',
    description: 'Look up evidence for a query.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string' } },
    },
  },
  {
    name: 'summarize',
    description: 'Summarize selected evidence.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
];

describe('provider-neutral adapter contract', () => {
  it('normalizes Anthropic text, usage and completion events', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const stream = asyncItems([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
          },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]);
    const createStream = jest.fn().mockReturnValue(stream);
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };

    expect(await collect(provider.stream(request, 1))).toEqual(
      expectedEvents('stop'),
    );
    expect(createStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-test',
        max_tokens: 128,
        system: 'You are precise.',
        messages: [{ role: 'user', content: 'Answer.' }],
      }),
      undefined,
    );
  });

  it('ignores ordinary Anthropic text block lifecycle events', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const stream = asyncItems([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]);
    const createStream = jest.fn().mockReturnValue(stream);
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };

    const output = await collect(provider.stream(request, 1));
    expect(output).toContainEqual({
      type: 'text_delta',
      text: 'hello',
      attempt: 1,
    });
    expect(output).toContainEqual({
      type: 'completed',
      finish_reason: 'stop',
      attempt: 1,
    });
    expect(output).not.toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('normalizes DeepSeek text, usage and completion events identically', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const stream = asyncItems([
      {
        choices: [
          {
            delta: { content: 'hello' },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: {
            cached_tokens: 2,
            cache_creation_tokens: 1,
          },
        },
      },
    ]);
    const create = jest.fn().mockResolvedValue(stream);
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };

    expect(await collect(provider.stream(request, 1))).toEqual(
      expectedEvents('stop'),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-test',
        max_tokens: 128,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      undefined,
    );
  });

  it('disables Anthropic SDK replay for an idempotent revision operation', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const createStream = jest.fn().mockReturnValue(
      asyncItems([
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 0 },
        },
        { type: 'message_stop' },
      ]),
    );
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };
    const operationKey = 'a'.repeat(64);

    await collect(
      provider.stream({ ...request, idempotency_key: operationKey }, 1),
    );

    expect(createStream).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxRetries: 0,
        headers: { 'X-Client-Request-Id': operationKey },
      }),
    );
  });

  it('disables DeepSeek SDK replay for an idempotent revision operation', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const create = jest.fn().mockResolvedValue(
      asyncItems([
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
        },
      ]),
    );
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };
    const operationKey = 'b'.repeat(64);

    await collect(
      provider.stream({ ...request, idempotency_key: operationKey }, 1),
    );

    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxRetries: 0,
        headers: { 'X-Client-Request-Id': operationKey },
      }),
    );
  });

  it.each([
    ['max_tokens', 'INCOMPLETE_OUTPUT'],
    ['content_filter', 'CONTENT_FILTERED'],
    ['refusal', 'CONTENT_FILTERED'],
    ['pause_turn', 'INCOMPLETE_OUTPUT'],
    ['unexpected_stop', 'PROVIDER_ERROR'],
  ])(
    'turns Anthropic %s into a typed terminal error',
    async (stopReason, errorCode) => {
      const provider = new AnthropicProvider({
        apiKey: 'test',
        model: 'claude-test',
      });
      const stream = asyncItems([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 2 } },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ]);
      const createStream = jest.fn().mockReturnValue(stream);
      (
        provider as unknown as {
          client: { messages: { stream: typeof createStream } };
        }
      ).client = { messages: { stream: createStream } };

      expect(await collect(provider.stream(request, 1))).toEqual([
        { type: 'text_delta', text: 'partial', attempt: 1 },
        expect.objectContaining({ type: 'usage', attempt: 1 }),
        {
          type: 'error',
          error: expect.objectContaining({
            code: errorCode,
            retryable: false,
          }),
          attempt: 1,
        },
      ]);
    },
  );

  it.each([
    ['Anthropic', createAnthropicToolProvider],
    ['DeepSeek', createDeepSeekToolProvider],
  ])(
    'emits a complete %s tool response only in tool mode',
    async (_providerName, createProvider) => {
      const provider = createProvider();
      expect(
        await collect(
          provider.stream(
            {
              ...request,
              response_mode: 'tool',
              tools: toolDefinitions,
              tool_choice: 'required',
            },
            1,
          ),
        ),
      ).toEqual([
        {
          type: 'tool_call',
          tool_call: {
            id: 'tool-1',
            name: 'lookup',
            arguments_json:
              _providerName === 'Anthropic' ? '{"query":"教材"}' : '{}',
            index: 0,
          },
          attempt: 1,
        },
        expect.objectContaining({ type: 'usage', attempt: 1 }),
        {
          type: 'completed',
          finish_reason: 'tool_call',
          attempt: 1,
        },
      ]);
    },
  );

  it.each([
    ['auto', { type: 'auto' }],
    ['required', { type: 'any' }],
    ['none', { type: 'none' }],
    [{ name: 'lookup' }, { type: 'tool', name: 'lookup' }],
  ] as const)(
    'maps provider-neutral Anthropic tool choice %p into the SDK request',
    async (toolChoice, expectedChoice) => {
      const provider = new AnthropicProvider({
        apiKey: 'test',
        model: 'claude-test',
      });
      const createStream = jest.fn().mockReturnValue(
        asyncItems([
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0 },
          },
          { type: 'message_stop' },
        ]),
      );
      (
        provider as unknown as {
          client: { messages: { stream: typeof createStream } };
        }
      ).client = { messages: { stream: createStream } };

      await collect(
        provider.stream(
          {
            ...request,
            tools: toolDefinitions,
            tool_choice: toolChoice,
          },
          1,
        ),
      );

      expect(createStream).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: toolDefinitions,
          tool_choice: expectedChoice,
        }),
        undefined,
      );
    },
  );

  it.each([
    ['auto', 'auto'],
    ['required', 'required'],
    ['none', 'none'],
    [{ name: 'lookup' }, { type: 'function', function: { name: 'lookup' } }],
  ] as const)(
    'maps provider-neutral DeepSeek tool choice %p into the SDK request',
    async (toolChoice, expectedChoice) => {
      const provider = new DeepSeekProvider({
        apiKey: 'test',
        model: 'deepseek-test',
      });
      const create = jest
        .fn()
        .mockResolvedValue(
          asyncItems([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]),
        );
      (
        provider as unknown as {
          client: { chat: { completions: { create: typeof create } } };
        }
      ).client = { chat: { completions: { create } } };

      await collect(
        provider.stream(
          {
            ...request,
            tools: toolDefinitions,
            tool_choice: toolChoice,
          },
          1,
        ),
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: toolDefinitions.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
          tool_choice: expectedChoice,
        }),
        undefined,
      );
    },
  );

  it('assembles split Anthropic arguments without prefixing the start placeholder and orders calls by index', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const createStream = jest.fn().mockReturnValue(
      asyncItems([
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'tool-2',
            name: 'summarize',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"text":' },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-1',
            name: 'lookup',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":"教' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"证据"}' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '材"}' },
        },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 4 },
        },
        { type: 'message_stop' },
      ]),
    );
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };

    const output = await collect(
      provider.stream(
        {
          ...request,
          response_mode: 'tool',
          tools: toolDefinitions,
          tool_choice: 'required',
        },
        1,
      ),
    );

    expect(output.filter((event) => event.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        tool_call: {
          id: 'tool-1',
          name: 'lookup',
          arguments_json: '{"query":"教材"}',
          index: 0,
        },
        attempt: 1,
      },
      {
        type: 'tool_call',
        tool_call: {
          id: 'tool-2',
          name: 'summarize',
          arguments_json: '{"text":"证据"}',
          index: 1,
        },
        attempt: 1,
      },
    ]);
  });

  it('accepts a complete Anthropic input supplied on content_block_start', async () => {
    const provider = createAnthropicToolProvider();
    const output = await collect(
      provider.stream(
        {
          ...request,
          response_mode: 'tool',
          tools: toolDefinitions,
          tool_choice: { name: 'lookup' },
        },
        1,
      ),
    );
    expect(output).toContainEqual({
      type: 'tool_call',
      tool_call: {
        id: 'tool-1',
        name: 'lookup',
        arguments_json: '{"query":"教材"}',
        index: 0,
      },
      attempt: 1,
    });
  });

  it('assembles split DeepSeek arguments for multiple tools and orders calls by index', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const create = jest.fn().mockResolvedValue(
      asyncItems([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: 'tool-2',
                    function: {
                      name: 'summarize',
                      arguments: '{"text":',
                    },
                  },
                  {
                    index: 0,
                    id: 'tool-1',
                    function: { name: 'lookup', arguments: '{"query":"' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '教材"}' } },
                  { index: 1, function: { arguments: '"证据"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    );
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };

    const output = await collect(
      provider.stream(
        {
          ...request,
          response_mode: 'tool',
          tools: toolDefinitions,
          tool_choice: 'required',
        },
        1,
      ),
    );

    expect(output.filter((event) => event.type === 'tool_call')).toEqual([
      {
        type: 'tool_call',
        tool_call: {
          id: 'tool-1',
          name: 'lookup',
          arguments_json: '{"query":"教材"}',
          index: 0,
        },
        attempt: 1,
      },
      {
        type: 'tool_call',
        tool_call: {
          id: 'tool-2',
          name: 'summarize',
          arguments_json: '{"text":"证据"}',
          index: 1,
        },
        attempt: 1,
      },
    ]);
  });

  it('does not emit DeepSeek tool calls from an incomplete terminal response', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const create = jest.fn().mockResolvedValue(
      asyncItems([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-1',
                    function: { name: 'lookup', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'length',
            },
          ],
        },
      ]),
    );
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };

    const output = await collect(
      provider.stream(
        {
          ...request,
          response_mode: 'tool',
          tools: toolDefinitions,
          tool_choice: 'required',
        },
        1,
      ),
    );

    expect(output).toContainEqual({
      type: 'error',
      error: expect.objectContaining({
        code: 'INCOMPLETE_OUTPUT',
        retryable: false,
      }),
      attempt: 1,
    });
    expect(output).not.toContainEqual(
      expect.objectContaining({ type: 'tool_call' }),
    );
  });

  it.each([
    [
      'Anthropic duplicate index',
      createAnthropicStream([
        anthropicToolStart(0, 'tool-1', 'lookup', {}),
        anthropicToolStart(0, 'tool-2', 'summarize', {}),
      ]),
    ],
    [
      'Anthropic duplicate id',
      createAnthropicStream([
        anthropicToolStart(0, 'tool-1', 'lookup', {}),
        anthropicToolStart(1, 'tool-1', 'summarize', {}),
      ]),
    ],
    [
      'Anthropic missing id',
      createAnthropicStream([anthropicToolStart(0, undefined, 'lookup', {})]),
    ],
    [
      'Anthropic missing name',
      createAnthropicStream([anthropicToolStart(0, 'tool-1', undefined, {})]),
    ],
    [
      'Anthropic invalid JSON',
      createAnthropicStream([
        anthropicToolStart(0, 'tool-1', 'lookup', {}),
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
        { type: 'content_block_stop', index: 0 },
      ]),
    ],
    [
      'Anthropic conflicting start input and delta',
      createAnthropicStream([
        anthropicToolStart(0, 'tool-1', 'lookup', { query: 'ready' }),
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      ]),
    ],
    [
      'DeepSeek missing id',
      createDeepSeekStream([
        {
          index: 0,
          function: { name: 'lookup', arguments: '{}' },
        },
      ]),
    ],
    [
      'DeepSeek missing name',
      createDeepSeekStream([
        {
          index: 0,
          id: 'tool-1',
          function: { arguments: '{}' },
        },
      ]),
    ],
    [
      'DeepSeek inconsistent id',
      createDeepSeekStream([
        {
          index: 0,
          id: 'tool-1',
          function: { name: 'lookup', arguments: '{' },
        },
        {
          index: 0,
          id: 'tool-2',
          function: { arguments: '}' },
        },
      ]),
    ],
    [
      'DeepSeek inconsistent name',
      createDeepSeekStream([
        {
          index: 0,
          id: 'tool-1',
          function: { name: 'lookup', arguments: '{' },
        },
        {
          index: 0,
          function: { name: 'summarize', arguments: '}' },
        },
      ]),
    ],
    [
      'DeepSeek invalid JSON',
      createDeepSeekStream([
        {
          index: 0,
          id: 'tool-1',
          function: { name: 'lookup', arguments: '{"query":' },
        },
      ]),
    ],
    [
      'DeepSeek duplicate id',
      createDeepSeekStream([
        {
          index: 0,
          id: 'tool-1',
          function: { name: 'lookup', arguments: '{}' },
        },
        {
          index: 1,
          id: 'tool-1',
          function: { name: 'summarize', arguments: '{}' },
        },
      ]),
    ],
  ])('fails closed for malformed %s tool streams', async (_name, provider) => {
    const output = await collect(
      provider.stream(
        {
          ...request,
          response_mode: 'tool',
          tools: toolDefinitions,
          tool_choice: 'required',
        },
        1,
      ),
    );
    expect(output).toContainEqual({
      type: 'error',
      error: expect.objectContaining({
        code: 'PROVIDER_ERROR',
        retryable: false,
      }),
      attempt: 1,
    });
    expect(output).not.toContainEqual(
      expect.objectContaining({ type: 'completed' }),
    );
  });

  it('does not invent an Anthropic stop reason when message_stop has none', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const stream = asyncItems([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 2 } },
      },
      { type: 'message_stop' },
    ]);
    const createStream = jest.fn().mockReturnValue(stream);
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };

    expect(await collect(provider.stream(request, 1))).toEqual([
      expect.objectContaining({ type: 'usage', attempt: 1 }),
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'PROVIDER_ERROR',
          retryable: false,
        }),
        attempt: 1,
      },
    ]);
  });

  it.each([
    ['length', 'INCOMPLETE_OUTPUT'],
    ['max_tokens', 'INCOMPLETE_OUTPUT'],
    ['content_filter', 'CONTENT_FILTERED'],
    ['error', 'PROVIDER_ERROR'],
    ['unexpected_finish', 'PROVIDER_ERROR'],
  ])(
    'turns DeepSeek %s into a typed terminal error',
    async (finishReason, errorCode) => {
      const provider = new DeepSeekProvider({
        apiKey: 'test',
        model: 'deepseek-test',
      });
      const stream = asyncItems([
        {
          choices: [
            {
              delta: { content: 'partial' },
              finish_reason: finishReason,
            },
          ],
        },
      ]);
      const create = jest.fn().mockResolvedValue(stream);
      (
        provider as unknown as {
          client: { chat: { completions: { create: typeof create } } };
        }
      ).client = { chat: { completions: { create } } };

      expect(await collect(provider.stream(request, 1))).toEqual([
        { type: 'text_delta', text: 'partial', attempt: 1 },
        {
          type: 'error',
          error: expect.objectContaining({
            code: errorCode,
            retryable: false,
          }),
          attempt: 1,
        },
      ]);
    },
  );

  it('does not invent a DeepSeek stop reason when the stream has none', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const create = jest
      .fn()
      .mockResolvedValue(
        asyncItems([{ choices: [{ delta: {}, finish_reason: null }] }]),
      );
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };

    expect(await collect(provider.stream(request, 1))).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'PROVIDER_ERROR',
          retryable: false,
        }),
        attempt: 1,
      },
    ]);
  });

  it('rejects an Anthropic tool terminal without a complete tool call', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const stream = asyncItems([
      {
        type: 'message_start',
        message: { usage: { input_tokens: 2 } },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]);
    const createStream = jest.fn().mockReturnValue(stream);
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };

    expect(
      await collect(
        provider.stream(
          {
            ...request,
            response_mode: 'tool',
            tools: toolDefinitions,
            tool_choice: 'required',
          },
          1,
        ),
      ),
    ).toEqual([
      expect.objectContaining({ type: 'usage', attempt: 1 }),
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'TOOL_CALL_REQUIRED',
          retryable: false,
        }),
        attempt: 1,
      },
    ]);
  });

  it('rejects a DeepSeek tool terminal without a complete tool call', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const create = jest.fn().mockResolvedValue(
      asyncItems([
        {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        },
      ]),
    );
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };

    expect(
      await collect(
        provider.stream(
          {
            ...request,
            response_mode: 'tool',
            tools: toolDefinitions,
            tool_choice: 'required',
          },
          1,
        ),
      ),
    ).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          code: 'TOOL_CALL_REQUIRED',
          retryable: false,
        }),
        attempt: 1,
      },
    ]);
  });

  it.each([
    ['Anthropic', createAnthropicToolProvider],
    ['DeepSeek', createDeepSeekToolProvider],
  ])(
    'rejects an unexpected %s tool response in text mode',
    async (_providerName, createProvider) => {
      const provider = createProvider();
      const output = await collect(provider.stream(request, 1));
      expect(output).toContainEqual({
        type: 'error',
        error: expect.objectContaining({
          code: 'UNEXPECTED_TOOL_CALL',
          retryable: false,
        }),
        attempt: 1,
      });
      expect(output).not.toContainEqual(
        expect.objectContaining({ type: 'completed' }),
      );
    },
  );
});

function createAnthropicToolProvider(): AnthropicProvider {
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-test',
  });
  const createStream = jest.fn().mockReturnValue(
    asyncItems([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'tool-1',
          name: 'lookup',
          input: { query: '教材' },
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]),
  );
  (
    provider as unknown as {
      client: { messages: { stream: typeof createStream } };
    }
  ).client = { messages: { stream: createStream } };
  return provider;
}

function createDeepSeekToolProvider(): DeepSeekProvider {
  const provider = new DeepSeekProvider({
    apiKey: 'test',
    model: 'deepseek-test',
  });
  const create = jest.fn().mockResolvedValue(
    asyncItems([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-1',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 1,
          total_tokens: 1,
        },
      },
    ]),
  );
  (
    provider as unknown as {
      client: { chat: { completions: { create: typeof create } } };
    }
  ).client = { chat: { completions: { create } } };
  return provider;
}

function anthropicToolStart(
  index: number,
  id: string | undefined,
  name: string | undefined,
  input: unknown,
): Record<string, unknown> {
  return {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      input,
    },
  };
}

function createAnthropicStream(
  body: readonly Record<string, unknown>[],
): AnthropicProvider {
  const provider = new AnthropicProvider({
    apiKey: 'test',
    model: 'claude-test',
  });
  const createStream = jest.fn().mockReturnValue(
    asyncItems([
      ...body,
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]),
  );
  (
    provider as unknown as {
      client: { messages: { stream: typeof createStream } };
    }
  ).client = { messages: { stream: createStream } };
  return provider;
}

function createDeepSeekStream(
  calls: readonly Record<string, unknown>[],
): DeepSeekProvider {
  const provider = new DeepSeekProvider({
    apiKey: 'test',
    model: 'deepseek-test',
  });
  const chunks = calls.map((toolCall, index) => ({
    choices: [
      {
        delta: { tool_calls: [toolCall] },
        finish_reason: index === calls.length - 1 ? 'tool_calls' : null,
      },
    ],
  }));
  const create = jest.fn().mockResolvedValue(asyncItems(chunks));
  (
    provider as unknown as {
      client: { chat: { completions: { create: typeof create } } };
    }
  ).client = { chat: { completions: { create } } };
  return provider;
}

function expectedEvents(
  finishReason: Extract<ModelEvent, { type: 'completed' }>['finish_reason'],
): ModelEvent[] {
  return [
    { type: 'text_delta', text: 'hello', attempt: 1 },
    {
      type: 'usage',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        cached_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
      attempt: 1,
    },
    { type: 'completed', finish_reason: finishReason, attempt: 1 },
  ];
}

function asyncItems<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield* items;
    },
  };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}
