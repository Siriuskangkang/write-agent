import { Injectable } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';
import type { StorageIntentStatus } from './entities/storage-operation-intent.entity.js';
import {
  canonicalStorageOperationV1,
  storageOperationIdempotencyKeyV1,
  type StorageOperationPreimageV1,
} from './storage-operation.contract.js';

export interface StorageRequestResultV1 {
  intent_id: string;
  status: StorageIntentStatus;
  execution_fence_decimal: string;
  result_code: string | null;
}

@Injectable()
export class StorageRequestService {
  async request(
    queryRunner: QueryRunner,
    value: StorageOperationPreimageV1,
  ): Promise<StorageRequestResultV1> {
    const operation = canonicalStorageOperationV1(value);
    const idempotencyKey = storageOperationIdempotencyKeyV1(operation);
    const { routine, parameters } = routineCall(operation, idempotencyKey);
    const raw: unknown = await queryRunner.query(
      `CALL ${routine}(${parameters.map(() => '?').join(',')})`,
      parameters,
    );
    const row = oneRoutineRow(raw);
    if (row.intent_id !== operation.intent_id) {
      throw new Error('STORAGE_REQUEST_RESULT_INVALID');
    }
    if (
      row.status !== 'PENDING' &&
      row.status !== 'EXECUTING' &&
      row.status !== 'RETRY' &&
      row.status !== 'SUCCEEDED' &&
      row.status !== 'REJECTED'
    ) {
      throw new Error('STORAGE_REQUEST_RESULT_INVALID');
    }
    return {
      intent_id: row.intent_id,
      status: row.status,
      execution_fence_decimal: decimal(row.execution_fence),
      result_code: typeof row.result_code === 'string' ? row.result_code : null,
    };
  }
}

function routineCall(
  operation: StorageOperationPreimageV1,
  idempotencyKey: string,
): { routine: string; parameters: unknown[] } {
  const common = [
    operation.actor_id,
    operation.intent_id,
    operation.project_id,
    operation.source_file_id,
    operation.object_id,
    operation.object_generation_decimal,
    operation.storage_key,
  ];
  const tail = [
    operation.expected_sha256,
    operation.expected_size_decimal,
    operation.authorization_id,
    operation.storage_epoch,
    idempotencyKey,
  ];
  switch (operation.kind) {
    case 'PROMOTE':
      return {
        routine: 'sp_storage_request_promote_v1',
        parameters: [...common, operation.quarantine_key, ...tail],
      };
    case 'DELETE_QUARANTINE':
      return {
        routine: 'sp_storage_request_delete_quarantine_v1',
        parameters: [
          ...common,
          operation.quarantine_key,
          operation.authorization_kind,
          ...tail,
        ],
      };
    case 'DELETE_BLOB':
      return {
        routine: 'sp_storage_request_delete_blob_v1',
        parameters: [...common, ...tail],
      };
    case 'ABORT_PROMOTION':
      return {
        routine: 'sp_storage_request_abort_promotion_v1',
        parameters: [...common, operation.quarantine_key, ...tail],
      };
  }
}

function oneRoutineRow(raw: unknown): Record<string, unknown> {
  if (
    !Array.isArray(raw) ||
    !Array.isArray(raw[0]) ||
    raw[0].length !== 1 ||
    typeof raw[0][0] !== 'object' ||
    raw[0][0] === null
  ) {
    throw new Error('STORAGE_REQUEST_RESULT_INVALID');
  }
  return raw[0][0] as Record<string, unknown>;
}

function decimal(value: unknown): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(value))
  ) {
    throw new Error('STORAGE_REQUEST_RESULT_INVALID');
  }
  return String(value);
}
