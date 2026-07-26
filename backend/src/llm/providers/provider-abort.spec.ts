import { AnthropicProvider } from './anthropic.provider.js';
import { DeepSeekProvider } from './deepseek.provider.js';

describe('legacy LLM provider cancellation contract', () => {
  it('passes AbortSignal to the Anthropic SDK stream request', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-test',
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ok' },
        };
      },
    };
    const createStream = jest.fn().mockReturnValue(stream);
    (
      provider as unknown as {
        client: { messages: { stream: typeof createStream } };
      }
    ).client = { messages: { stream: createStream } };
    const controller = new AbortController();

    await collect(
      provider.streamCompletion('prompt', 'system', 0.2, {
        signal: controller.signal,
      }),
    );

    expect(createStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test' }),
      { signal: controller.signal },
    );
  });

  it('passes AbortSignal to the OpenAI-compatible DeepSeek request', async () => {
    const provider = new DeepSeekProvider({
      apiKey: 'test',
      model: 'deepseek-test',
    });
    const stream = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield { choices: [{ delta: { content: 'ok' } }] };
      },
    };
    const create = jest.fn().mockResolvedValue(stream);
    (
      provider as unknown as {
        client: { chat: { completions: { create: typeof create } } };
      }
    ).client = { chat: { completions: { create } } };
    const controller = new AbortController();

    await collect(
      provider.streamCompletion('prompt', 'system', 0.2, {
        signal: controller.signal,
      }),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek-test', stream: true }),
      { signal: controller.signal },
    );
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}
