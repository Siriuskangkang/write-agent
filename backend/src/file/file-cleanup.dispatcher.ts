import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs/promises';
import { Repository } from 'typeorm';
import { FileCleanupRecord } from './entities/file-cleanup-record.entity.js';
import {
  claimRetryBatch,
  errorMessage,
  fencedDelete,
  fencedUpdate,
  nextRetryAt,
  renewClaimLease,
  RetryDispatcher,
} from './retry-dispatcher.js';
import { inspectUploadFileForUnlink } from './upload-file-safety.js';

@Injectable()
export class FileCleanupDispatcher extends RetryDispatcher {
  constructor(
    @InjectRepository(FileCleanupRecord)
    private readonly cleanupRepo: Repository<FileCleanupRecord>,
  ) {
    super(FileCleanupDispatcher.name);
  }

  protected async dispatchClaimed(): Promise<void> {
    const pending = await claimRetryBatch(
      this.cleanupRepo,
      'file_cleanup_records',
      'pending',
    );
    for (const record of pending) {
      try {
        if (!(await renewClaimLease(this.cleanupRepo, record))) continue;
        let inspection = await inspectUploadFileForUnlink(record.file_path);
        if (inspection.kind === 'missing') {
          await fencedDelete(this.cleanupRepo, record);
          continue;
        }
        if (inspection.kind === 'unsafe') {
          await this.rejectUnsafe(record, inspection.reason);
          continue;
        }

        if (!(await renewClaimLease(this.cleanupRepo, record))) continue;
        inspection = await inspectUploadFileForUnlink(record.file_path);
        if (inspection.kind === 'missing') {
          await fencedDelete(this.cleanupRepo, record);
          continue;
        }
        if (inspection.kind === 'unsafe') {
          await this.rejectUnsafe(record, inspection.reason);
          continue;
        }

        try {
          await fs.unlink(record.file_path);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fencedDelete(this.cleanupRepo, record);
      } catch (error: unknown) {
        const message = errorMessage(error);
        const attempts = record.attempts + 1;
        await fencedUpdate(this.cleanupRepo, record, {
          attempts,
          last_error: message,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: nextRetryAt(attempts),
        });
        this.logger.error(
          `Failed to clean upload file ${record.file_path}: ${message}`,
        );
      }
    }
  }

  private async rejectUnsafe(
    record: FileCleanupRecord,
    reason: string,
  ): Promise<void> {
    await fencedUpdate(this.cleanupRepo, record, {
      status: 'rejected',
      attempts: record.attempts + 1,
      last_error: `Unsafe cleanup path: ${reason}`,
      lease_owner: null,
      lease_expires_at: null,
    });
    this.logger.error(
      `Permanently rejected cleanup record ${record.id}: ${reason}`,
    );
  }
}
