import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EmbeddingService } from '../embedding/embedding.service.js';
import { QdrantService, type QdrantPoint } from './qdrant.service.js';
import type { IndexVersionRecorder } from './types.js';
import { INDEX_VERSION_RECORDER } from './injection-tokens.js';

export interface DenseIndexInput {
  record_id: string;
  attempt_token: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string;
  chunk_version: string;
  chunks: Array<{
    id: string;
    content: string;
    chunk_type: 'parent' | 'child';
  }>;
}

@Injectable()
export class DenseIndexService {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly qdrant: QdrantService,
    @Inject(INDEX_VERSION_RECORDER)
    private readonly recorder: IndexVersionRecorder,
  ) {}

  async index(input: DenseIndexInput, signal?: AbortSignal): Promise<void> {
    try {
      const contents = input.chunks.map((chunk) => chunk.content);
      const embeddings = this.embeddings as unknown as {
        generateEmbeddingsDetailed?: EmbeddingService['generateEmbeddingsDetailed'];
        generateEmbeddings: EmbeddingService['generateEmbeddings'];
      };
      const vectors =
        typeof embeddings.generateEmbeddingsDetailed === 'function'
          ? (
              await embeddings.generateEmbeddingsDetailed(contents, {
                signal,
              })
            ).vectors
          : await embeddings.generateEmbeddings(contents);
      throwIfAborted(signal);
      if (
        vectors.length !== input.chunks.length ||
        vectors.some((vector) => vector === null)
      ) {
        throw new Error(
          `Embedding generation failed for ${input.chunks.length} chunks`,
        );
      }
      if (
        !(await this.recorder.isAttemptActive(
          input.record_id,
          input.attempt_token,
        ))
      ) {
        await this.recordFenceLoss(input);
        return;
      }
      const points: QdrantPoint[] = input.chunks.map((chunk, index) => ({
        id: attemptPointId(chunk.id, input.record_id, input.attempt_token),
        vector: vectors[index] as number[],
        payload: {
          chunk_id: chunk.id,
          project_id: input.project_id,
          file_id: input.file_id,
          document_id: input.document_id,
          ingestion_key: input.ingestion_key,
          chunk_version: input.chunk_version,
          index_version: this.qdrant.configuredIndexVersion,
          chunk_type: chunk.chunk_type,
          is_active: true,
          index_record_id: input.record_id,
          attempt_token: input.attempt_token,
          index_namespace: `${input.record_id}:${input.attempt_token}`,
        },
      }));
      if (signal) await this.qdrant.upsertAttempt(points, signal);
      else await this.qdrant.upsertAttempt(points);
      throwIfAborted(signal);
      if (
        !(await this.recorder.isAttemptActive(
          input.record_id,
          input.attempt_token,
        ))
      ) {
        await this.recordFenceLoss(input);
        return;
      }
      const published = await this.recorder.markReady(
        input.record_id,
        input.attempt_token,
        {
          point_count: points.length,
          indexed_at: new Date(),
        },
      );
      if (!published) return;
    } catch (error) {
      if (
        await this.recorder.isAttemptActive(
          input.record_id,
          input.attempt_token,
        )
      ) {
        await this.recorder.markFailed(input.record_id, input.attempt_token, {
          error_code: classifyIndexError(error),
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async recordFenceLoss(input: DenseIndexInput): Promise<void> {
    const state = await this.recorder.attemptFenceState(
      input.record_id,
      input.attempt_token,
    );
    const errorCode =
      state === 'STALE_INGESTION'
        ? 'STALE_INGESTION'
        : state === 'LEASE_EXPIRED'
          ? 'LEASE_EXPIRED'
          : 'ATTEMPT_SUPERSEDED';
    await this.recorder.markFailed(input.record_id, input.attempt_token, {
      error_code: errorCode,
      error_message:
        state === 'STALE_INGESTION'
          ? 'The source file has a newer active ingestion'
          : 'Dense index attempt lost its database lease',
    });
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Dense index attempt aborted');
}

function attemptPointId(
  chunkId: string,
  recordId: string,
  attemptToken: string,
): string {
  const hex = createHash('sha256')
    .update(`${chunkId}:${recordId}:${attemptToken}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

function classifyIndexError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QdrantSchemaMismatchError') return 'QDRANT_SCHEMA_MISMATCH';
  if (name === 'QdrantUnavailableError') return 'QDRANT_UNAVAILABLE';
  return 'INDEXING_FAILED';
}
