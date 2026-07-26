import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  FindOptionsOrder,
  FindOptionsWhere,
  ObjectLiteral,
  QueryDeepPartialEntity,
  Repository,
} from 'typeorm';

const CLAIM_LEASE_SECONDS = 60;
const DISPATCH_INTERVAL_MS = 30_000;
const DISPATCH_BATCH_SIZE = 100;

export type RetryRecord = ObjectLiteral & {
  id: string;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
};

type ClaimableTable =
  | 'file_upload_outbox'
  | 'file_cleanup_records'
  | 'file_move_intents';

export abstract class RetryDispatcher implements OnModuleInit, OnModuleDestroy {
  protected readonly logger: Logger;
  private timer?: NodeJS.Timeout;
  private activeDispatch?: Promise<void>;

  protected constructor(loggerName: string) {
    this.logger = new Logger(loggerName);
  }

  onModuleInit(): void {
    if (process.env.WORKER_MODE !== 'true') return;

    this.runScheduledDispatch();
    this.timer = setInterval(
      () => this.runScheduledDispatch(),
      DISPATCH_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  dispatchPending(): Promise<void> {
    if (this.activeDispatch) return this.activeDispatch;

    const dispatch = Promise.resolve().then(() => this.dispatchClaimed());
    const tracked = dispatch.finally(() => {
      if (this.activeDispatch === tracked) this.activeDispatch = undefined;
    });
    this.activeDispatch = tracked;
    return tracked;
  }

  protected abstract dispatchClaimed(): Promise<void>;

  private runScheduledDispatch(): void {
    void this.dispatchPending().catch((error: unknown) => {
      this.logger.error(
        `Scheduled retry dispatch failed: ${errorMessage(error)}`,
      );
    });
  }
}

export async function claimRetryBatch<T extends RetryRecord>(
  repository: Repository<T>,
  table: ClaimableTable,
  status: string,
  options: { recoverAfter?: boolean } = {},
): Promise<T[]> {
  const leaseOwner = `${table}:${process.pid}:${randomUUID()}`;
  const recoverAfterCondition = options.recoverAfter
    ? 'AND recover_after <= CURRENT_TIMESTAMP(6)'
    : '';
  await repository.query(
    `UPDATE ${table}
       SET lease_owner = ?,
           lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${CLAIM_LEASE_SECONDS} SECOND)
     WHERE status = ?
       AND next_attempt_at <= CURRENT_TIMESTAMP(6)
       ${recoverAfterCondition}
       AND (lease_owner IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP(6))
     ORDER BY created_at ASC
     LIMIT ${DISPATCH_BATCH_SIZE}`,
    [leaseOwner, status],
  );

  return repository.find({
    where: { lease_owner: leaseOwner } as FindOptionsWhere<T>,
    order: { created_at: 'ASC' } as FindOptionsOrder<T>,
    take: DISPATCH_BATCH_SIZE,
  });
}

export async function renewClaimLease<T extends RetryRecord>(
  repository: Repository<T>,
  record: T,
): Promise<boolean> {
  if (!record.lease_owner) return false;
  const result = await repository.update(
    {
      id: record.id,
      lease_owner: record.lease_owner,
    } as FindOptionsWhere<T>,
    {
      lease_expires_at: databaseDeadlineAfter(CLAIM_LEASE_SECONDS),
    } as unknown as QueryDeepPartialEntity<T>,
  );
  if (result.affected !== 1) return false;
  return true;
}

export async function fencedUpdate<T extends RetryRecord>(
  repository: Repository<T>,
  record: T,
  changes: QueryDeepPartialEntity<T>,
): Promise<boolean> {
  if (!record.lease_owner) return false;
  const result = await repository.update(
    {
      id: record.id,
      lease_owner: record.lease_owner,
    } as FindOptionsWhere<T>,
    changes,
  );
  return result.affected === 1;
}

export async function fencedDelete<T extends RetryRecord>(
  repository: Repository<T>,
  record: T,
): Promise<boolean> {
  if (!record.lease_owner) return false;
  const result = await repository.delete({
    id: record.id,
    lease_owner: record.lease_owner,
  } as FindOptionsWhere<T>);
  return result.affected === 1;
}

export function nextRetryAt(attempts: number): () => string {
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  return databaseDeadlineAfter(delaySeconds);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function databaseNow(): () => string {
  return () => 'CURRENT_TIMESTAMP(6)';
}

export function databaseDeadlineAfter(seconds: number): () => string {
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error('Database deadline requires non-negative whole seconds');
  }
  return () => `DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${seconds} SECOND)`;
}
