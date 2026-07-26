import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs/promises';
import { Repository } from 'typeorm';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import { SourceFile } from './entities/source-file.entity.js';
import {
  claimRetryBatch,
  errorMessage,
  fencedDelete,
  fencedUpdate,
  nextRetryAt,
  renewClaimLease,
  RetryDispatcher,
} from './retry-dispatcher.js';
import {
  inspectUploadFileForUnlink,
  UploadFileInspection,
} from './upload-file-safety.js';

@Injectable()
export class FileMoveIntentDispatcher extends RetryDispatcher {
  constructor(
    @InjectRepository(FileMoveIntent)
    private readonly intentRepo: Repository<FileMoveIntent>,
    @InjectRepository(SourceFile)
    private readonly fileRepo: Repository<SourceFile>,
  ) {
    super(FileMoveIntentDispatcher.name);
  }

  protected async dispatchClaimed(): Promise<void> {
    const active = await claimRetryBatch(
      this.intentRepo,
      'file_move_intents',
      'ACTIVE',
      { recoverAfter: true },
    );
    for (const intent of active) {
      try {
        if (!(await renewClaimLease(this.intentRepo, intent))) continue;
        const committed = await this.fileRepo.findOneBy({
          id: intent.file_id,
        });
        if (committed) {
          await fencedDelete(this.intentRepo, intent);
          continue;
        }

        await this.cleanupUncommittedMove(intent);
      } catch (error: unknown) {
        await this.backoff(intent, error);
      }
    }

    const uncertain = await claimRetryBatch(
      this.intentRepo,
      'file_move_intents',
      'UNCERTAIN',
      { recoverAfter: true },
    );
    for (const intent of uncertain) {
      try {
        if (!(await renewClaimLease(this.intentRepo, intent))) continue;
        const facts = await this.readCommitFacts(intent.file_id);
        if (facts.sourceCount === 1 && facts.outboxCount === 1) {
          await fencedDelete(this.intentRepo, intent);
          continue;
        }
        if (facts.sourceCount === 0 && facts.outboxCount === 0) {
          await this.cleanupUncommittedMove(intent);
          continue;
        }

        const attempts = intent.attempts + 1;
        await fencedUpdate(this.intentRepo, intent, {
          status: 'UNCERTAIN',
          attempts,
          last_error: `Manual review required for partial upload state: SourceFile=${facts.sourceCount}, outbox=${facts.outboxCount}`,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: nextRetryAt(attempts),
        });
        this.logger.error(
          `Upload move intent ${intent.id} remains UNCERTAIN because its committed state is partial`,
        );
      } catch (error: unknown) {
        await this.backoff(intent, error);
      }
    }
  }

  private async readCommitFacts(
    fileId: string,
  ): Promise<{ sourceCount: number; outboxCount: number }> {
    const rows: unknown = await this.intentRepo.query(
      `SELECT
         (SELECT COUNT(*) FROM source_files WHERE id = ?) AS sourceCount,
         (SELECT COUNT(*) FROM file_upload_outbox WHERE file_id = ?) AS outboxCount`,
      [fileId, fileId],
    );
    const row =
      Array.isArray(rows) && rows[0] !== null && typeof rows[0] === 'object'
        ? (rows[0] as Record<string, unknown>)
        : undefined;
    const sourceCount = Number(row?.sourceCount);
    const outboxCount = Number(row?.outboxCount);
    if (
      !Number.isInteger(sourceCount) ||
      sourceCount < 0 ||
      !Number.isInteger(outboxCount) ||
      outboxCount < 0
    ) {
      throw new Error('Invalid database result while reconciling upload state');
    }
    return { sourceCount, outboxCount };
  }

  private async cleanupUncommittedMove(intent: FileMoveIntent): Promise<void> {
    const paths = [intent.source_path, intent.destination_path];
    const inspections = await Promise.all(
      paths.map((filePath) => inspectUploadFileForUnlink(filePath)),
    );
    const unsafe = inspections.find(
      (
        inspection,
      ): inspection is Extract<UploadFileInspection, { kind: 'unsafe' }> =>
        inspection.kind === 'unsafe',
    );
    if (unsafe) {
      await this.rejectUnsafe(intent, unsafe.reason);
      return;
    }

    for (let index = 0; index < paths.length; index += 1) {
      if (inspections[index]?.kind === 'missing') continue;
      if (!(await renewClaimLease(this.intentRepo, intent))) return;
      const inspection = await inspectUploadFileForUnlink(paths[index]);
      if (inspection.kind === 'unsafe') {
        await this.rejectUnsafe(intent, inspection.reason);
        return;
      }
      if (inspection.kind === 'missing') continue;
      await this.unlinkIfPresent(paths[index]);
    }
    await fencedDelete(this.intentRepo, intent);
  }

  private async backoff(intent: FileMoveIntent, error: unknown): Promise<void> {
    const message = errorMessage(error);
    const attempts = intent.attempts + 1;
    await fencedUpdate(this.intentRepo, intent, {
      attempts,
      last_error: message,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: nextRetryAt(attempts),
    });
    this.logger.error(
      `Failed to recover file move intent ${intent.id}: ${message}`,
    );
  }

  private async rejectUnsafe(
    intent: FileMoveIntent,
    reason: string,
  ): Promise<void> {
    await fencedUpdate(this.intentRepo, intent, {
      status: 'REJECTED',
      attempts: intent.attempts + 1,
      last_error: `Unsafe move intent path: ${reason}`,
      lease_owner: null,
      lease_expires_at: null,
    });
    this.logger.error(
      `Permanently rejected move intent ${intent.id}: ${reason}`,
    );
  }

  private async unlinkIfPresent(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
