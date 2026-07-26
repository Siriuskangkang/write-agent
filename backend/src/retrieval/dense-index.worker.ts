import { Process, Processor } from '@nestjs/bull';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as Bull from 'bull';
import { Repository } from 'typeorm';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { DenseIndexService } from './dense-index.service.js';
import { INDEX_VERSION_RECORDER } from './injection-tokens.js';
import type { IndexVersionRecorder } from './types.js';

interface DenseIndexJob {
  indexVersionId: string;
  attemptToken: string;
  attempt: number;
}

@Injectable()
@Processor('dense-index')
export class DenseIndexWorker {
  constructor(
    @Inject(INDEX_VERSION_RECORDER)
    private readonly recorder: IndexVersionRecorder,
    @InjectRepository(Chunk)
    private readonly chunkRepository: Repository<Chunk>,
    private readonly indexer: DenseIndexService,
    @Optional()
    @Inject('DENSE_INDEX_HEARTBEAT_MS')
    private readonly heartbeatMs: number = 60_000,
  ) {}

  @Process('index')
  async handle(job: Bull.Job<DenseIndexJob>): Promise<void> {
    const record = await this.recorder.beginAttempt(
      job.data.indexVersionId,
      job.data.attemptToken,
    );
    if (!record || record.attempt_count !== job.data.attempt) return;
    const controller = new AbortController();
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing.then(async () => {
        try {
          const renewed = await this.recorder.renewAttemptLease(
            record.id,
            record.attempt_token,
          );
          if (!renewed && !controller.signal.aborted) {
            controller.abort(new Error('Dense index lease expired'));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            controller.abort(
              error instanceof Error
                ? error
                : new Error('Dense index lease renewal failed'),
            );
          }
        }
      });
    }, this.heartbeatMs);
    timer.unref();
    try {
      const chunks = await this.chunkRepository.find({
        where: {
          project_id: record.project_id,
          file_id: record.file_id,
          document_id: record.document_id,
          ingestion_key: record.ingestion_key,
          is_active: true,
          chunk_type: 'child',
        },
        order: { position: 'ASC' },
      });
      await this.indexer.index(
        {
          record_id: record.id,
          attempt_token: record.attempt_token,
          project_id: record.project_id,
          file_id: record.file_id,
          document_id: record.document_id,
          ingestion_key: record.ingestion_key,
          chunk_version: record.chunk_version,
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            content: chunk.content,
            chunk_type: chunk.chunk_type,
          })),
        },
        controller.signal,
      );
    } finally {
      clearInterval(timer);
      await renewing;
    }
  }
}
