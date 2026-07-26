import type { MigrationInterface, QueryRunner } from 'typeorm';
import { findApplicationSchemaContractViolations } from './support/application-schema-contract';

const MEDIUMTEXT_MAX_BYTES = 16_777_215;

export class ExpandDocumentBodyStorage1713520000000 implements MigrationInterface {
  name = 'ExpandDocumentBodyStorage1713520000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await assertAdditiveSource(queryRunner);
    await queryRunner.query(
      `ALTER TABLE documents
         MODIFY COLUMN content_text MEDIUMTEXT
           CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL`,
    );

    const violations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Document body schema did not converge: ${violations.join(', ')}`,
      );
    }
  }

  down(): Promise<never> {
    return Promise.reject(
      new Error('DOCUMENT_BODY_STORAGE_DESTRUCTIVE_ROLLBACK_FORBIDDEN'),
    );
  }
}

async function assertAdditiveSource(queryRunner: QueryRunner): Promise<void> {
  if (
    !(await queryRunner.hasTable('documents')) ||
    !(await queryRunner.hasColumn('documents', 'content_text'))
  ) {
    throw new Error('DOCUMENT_BODY_SCHEMA_RECONCILIATION_REQUIRED:documents');
  }

  const columnRows: unknown = await queryRunner.query(
    `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='documents'
        AND COLUMN_NAME='content_text'`,
  );
  if (!Array.isArray(columnRows) || columnRows.length !== 1) {
    throw new Error('DOCUMENT_BODY_SCHEMA_RECONCILIATION_REQUIRED:documents');
  }
  const column = columnRows[0] as {
    columnType?: unknown;
    nullable?: unknown;
  };
  const columnType =
    typeof column.columnType === 'string'
      ? column.columnType.toLowerCase()
      : '';
  if (
    (columnType !== 'text' && columnType !== 'mediumtext') ||
    column.nullable !== 'YES'
  ) {
    throw new Error('DOCUMENT_BODY_SCHEMA_RECONCILIATION_REQUIRED:documents');
  }

  const lengthRows: unknown = await queryRunner.query(
    'SELECT COALESCE(MAX(OCTET_LENGTH(content_text)),0) AS maxBytes FROM documents',
  );
  const maxBytes =
    Array.isArray(lengthRows) && lengthRows.length === 1
      ? parseUnsignedInteger((lengthRows[0] as { maxBytes?: unknown }).maxBytes)
      : null;
  if (maxBytes === null || maxBytes > MEDIUMTEXT_MAX_BYTES) {
    throw new Error('DOCUMENT_BODY_SCHEMA_RECONCILIATION_REQUIRED:documents');
  }
}

function parseUnsignedInteger(value: unknown): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
