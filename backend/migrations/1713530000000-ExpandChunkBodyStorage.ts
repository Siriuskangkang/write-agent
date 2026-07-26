import type { MigrationInterface, QueryRunner } from 'typeorm';
import { findApplicationSchemaContractViolations } from './support/application-schema-contract';

export class ExpandChunkBodyStorage1713530000000 implements MigrationInterface {
  name = 'ExpandChunkBodyStorage1713530000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await assertAdditiveSource(queryRunner);
    await queryRunner.query(
      `ALTER TABLE chunks
         MODIFY COLUMN content LONGTEXT
           CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL`,
    );

    const violations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Chunk body schema did not converge: ${violations.join(', ')}`,
      );
    }
  }

  down(): Promise<never> {
    return Promise.reject(
      new Error('CHUNK_BODY_STORAGE_DESTRUCTIVE_ROLLBACK_FORBIDDEN'),
    );
  }
}

async function assertAdditiveSource(queryRunner: QueryRunner): Promise<void> {
  if (
    !(await queryRunner.hasTable('chunks')) ||
    !(await queryRunner.hasColumn('chunks', 'content'))
  ) {
    throw new Error('CHUNK_BODY_SCHEMA_RECONCILIATION_REQUIRED:chunks');
  }

  const rows: unknown = await queryRunner.query(
    `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='chunks'
        AND COLUMN_NAME='content'`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('CHUNK_BODY_SCHEMA_RECONCILIATION_REQUIRED:chunks');
  }
  const column = rows[0] as { columnType?: unknown; nullable?: unknown };
  const columnType =
    typeof column.columnType === 'string'
      ? column.columnType.toLowerCase()
      : '';
  if (
    (columnType !== 'text' &&
      columnType !== 'mediumtext' &&
      columnType !== 'longtext') ||
    column.nullable !== 'NO'
  ) {
    throw new Error('CHUNK_BODY_SCHEMA_RECONCILIATION_REQUIRED:chunks');
  }
}
