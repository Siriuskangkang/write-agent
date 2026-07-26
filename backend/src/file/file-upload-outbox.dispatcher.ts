import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as Bull from 'bull';
import { Repository } from 'typeorm';
import { FileUploadOutbox } from './entities/file-upload-outbox.entity.js';
import {
  claimRetryBatch,
  errorMessage,
  fencedUpdate,
  nextRetryAt,
  renewClaimLease,
  RetryDispatcher,
} from './retry-dispatcher.js';

@Injectable()
export class FileUploadOutboxDispatcher extends RetryDispatcher {
  constructor(
    @InjectRepository(FileUploadOutbox)
    private readonly outboxRepo: Repository<FileUploadOutbox>,
    @InjectQueue('file-parse') private readonly parseQueue: Bull.Queue,
  ) {
    super(FileUploadOutboxDispatcher.name);
  }

  protected async dispatchClaimed(): Promise<void> {
    const pending = await claimRetryBatch(
      this.outboxRepo,
      'file_upload_outbox',
      'pending',
    );
    for (const event of pending) {
      try {
        if (!(await renewClaimLease(this.outboxRepo, event))) continue;
        await this.parseQueue.add(
          'parse',
          {
            fileId: event.file_id,
            projectId: event.project_id,
            parseGeneration: event.parse_generation,
          },
          {
            jobId: event.job_id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
        const completed = await fencedUpdate(this.outboxRepo, event, {
          status: 'published',
          attempts: event.attempts + 1,
          last_error: null,
          lease_owner: null,
          lease_expires_at: null,
        });
        if (!completed) {
          this.logger.warn(
            `Upload outbox ${event.id} lost its lease after queue publish`,
          );
        }
      } catch (error: unknown) {
        const message = errorMessage(error);
        const attempts = event.attempts + 1;
        await fencedUpdate(this.outboxRepo, event, {
          attempts,
          last_error: message,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: nextRetryAt(attempts),
        });
        this.logger.error(
          `Failed to dispatch upload outbox ${event.id}: ${message}`,
        );
      }
    }
  }
}
