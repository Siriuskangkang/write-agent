import { EmbeddingService } from './embedding.service.js';

describe('EmbeddingService usage', () => {
  it('returns provider token usage as actual while preserving the legacy vectors method', async () => {
    const service = new EmbeddingService({
      get: (key: string, fallback?: unknown) =>
        ({
          EMBEDDING_PROVIDER: 'openai',
          EMBEDDING_MODEL: 'embedding-v1',
          OPENAI_API_KEY: 'test-key',
        })[key] ?? fallback,
    } as never);
    Object.assign(service as object, {
      client: {
        embeddings: {
          create: jest.fn().mockResolvedValue({
            data: [{ embedding: [1, 0, 0] }],
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
        },
      },
    });

    await expect(
      service.generateEmbeddingsDetailed(['闭环控制']),
    ).resolves.toEqual({
      vectors: [[1, 0, 0]],
      usage: {
        input_tokens: 7,
        source: 'actual',
      },
    });
    await expect(service.generateEmbeddings(['闭环控制'])).resolves.toEqual([
      [1, 0, 0],
    ]);
    const create = (
      service as unknown as {
        client: { embeddings: { create: jest.Mock } };
      }
    ).client.embeddings.create;
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ encoding_format: 'float' }),
      undefined,
    );
  });

  it('stores a token estimate separately when the provider omits usage', async () => {
    const service = new EmbeddingService({
      get: (key: string, fallback?: unknown) =>
        ({
          EMBEDDING_PROVIDER: 'openai',
          EMBEDDING_MODEL: 'embedding-v1',
          OPENAI_API_KEY: 'test-key',
        })[key] ?? fallback,
    } as never);
    Object.assign(service as object, {
      client: {
        embeddings: {
          create: jest.fn().mockResolvedValue({
            data: [{ embedding: [1, 0, 0] }],
          }),
        },
      },
    });

    await expect(
      service.generateEmbeddingDetailed('abcd'),
    ).resolves.toMatchObject({
      vector: [1, 0, 0],
      usage: {
        input_tokens: 2,
        source: 'estimated',
      },
    });
  });
});
