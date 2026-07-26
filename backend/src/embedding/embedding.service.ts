import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface EmbeddingUsage {
  input_tokens: number;
  source: 'actual' | 'estimated';
}

export interface EmbeddingBatchResult {
  vectors: Array<number[] | null>;
  usage: EmbeddingUsage | null;
}

export interface EmbeddingResult {
  vector: number[] | null;
  usage: EmbeddingUsage | null;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly provider: string;
  private readonly model: string;
  private readonly pricePerMillionUsd: number | null;
  private readonly client: OpenAI | null;

  constructor(private readonly configService: ConfigService) {
    this.provider = this.configService.get<string>(
      'EMBEDDING_PROVIDER',
      'openai',
    );
    this.model = this.configService.get<string>(
      'EMBEDDING_MODEL',
      'text-embedding-3-small',
    );
    const configuredPrice = Number(
      this.configService.get('EMBEDDING_PRICE_PER_MILLION_USD', ''),
    );
    this.pricePerMillionUsd =
      Number.isFinite(configuredPrice) && configuredPrice >= 0
        ? configuredPrice
        : null;

    if (this.provider === 'openai') {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      const baseURL = this.configService.get<string>('EMBEDDING_BASE_URL');
      this.client = apiKey
        ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
        : null;
      if (!apiKey) {
        this.logger.warn(
          'OPENAI_API_KEY is missing, embedding generation is disabled',
        );
      }
    } else {
      this.client = null;
      this.logger.warn(`Unsupported embedding provider: ${this.provider}`);
    }
  }

  get configuredModel(): string {
    return this.model;
  }

  get configuredPricePerMillionUsd(): number | null {
    return this.pricePerMillionUsd;
  }

  async generateEmbedding(input: string): Promise<number[] | null> {
    return (await this.generateEmbeddingDetailed(input)).vector;
  }

  async generateEmbeddings(inputs: string[]): Promise<Array<number[] | null>> {
    return (await this.generateEmbeddingsDetailed(inputs)).vectors;
  }

  async generateEmbeddingDetailed(
    input: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbeddingResult> {
    const result = await this.generateEmbeddingsDetailed([input], options);
    return { vector: result.vectors[0] ?? null, usage: result.usage };
  }

  async generateEmbeddingsDetailed(
    inputs: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<EmbeddingBatchResult> {
    const normalized = inputs.map((input) => this.normalizeInput(input));
    if (!this.client || normalized.every((input) => input.length === 0)) {
      return {
        vectors: normalized.map(() => null),
        usage: null,
      };
    }

    const indexMap = normalized
      .map((input, index) => ({ input, index }))
      .filter((item) => item.input.length > 0);

    if (indexMap.length === 0) {
      return { vectors: normalized.map(() => null), usage: null };
    }

    try {
      const response = await this.client.embeddings.create(
        {
          model: this.model,
          input: indexMap.map((item) => item.input),
          encoding_format: 'float',
        },
        options.signal ? { signal: options.signal } : undefined,
      );

      const results = normalized.map(() => null as number[] | null);
      response.data.forEach((item, responseIndex) => {
        const originalIndex = indexMap[responseIndex]?.index;
        if (originalIndex != null) {
          results[originalIndex] = item.embedding;
        }
      });
      const actualTokens = Number(response.usage?.prompt_tokens);
      return {
        vectors: results,
        usage:
          Number.isSafeInteger(actualTokens) && actualTokens >= 0
            ? { input_tokens: actualTokens, source: 'actual' }
            : {
                input_tokens: estimateInputTokens(
                  indexMap.map((item) => item.input),
                ),
                source: 'estimated',
              },
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Embedding generation aborted');
      }
      this.logger.warn(`Embedding generation failed: ${error}`);
      return { vectors: normalized.map(() => null), usage: null };
    }
  }

  private normalizeInput(input: string): string {
    return input.replace(/\s+/g, ' ').trim().slice(0, 8000);
  }
}

function estimateInputTokens(inputs: string[]): number {
  return Math.max(
    1,
    inputs.reduce((total, input) => total + Math.ceil(input.length / 2), 0),
  );
}
