import type { MigrationInterface, QueryRunner } from 'typeorm';
import { findWorkflowSchemaContractViolations } from './support/workflow-schema-contract';

const COLUMN_DEFINITIONS = [
  {
    name: 'lease_owner',
    definition: 'VARCHAR(128) NULL AFTER checkpoint',
    columnType: 'varchar(128)',
    nullable: 'YES',
    defaultValue: null,
  },
  {
    name: 'lease_token',
    definition: 'CHAR(36) NULL AFTER lease_owner',
    columnType: 'char(36)',
    nullable: 'YES',
    defaultValue: null,
  },
  {
    name: 'lease_expires_at',
    definition: 'DATETIME(6) NULL AFTER lease_token',
    columnType: 'datetime(6)',
    nullable: 'YES',
    defaultValue: null,
  },
  {
    name: 'fencing_token',
    definition: 'BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER lease_expires_at',
    columnType: 'bigint unsigned',
    nullable: 'NO',
    defaultValue: '0',
  },
  {
    name: 'attempt_count',
    definition: 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER fencing_token',
    columnType: 'int unsigned',
    nullable: 'NO',
    defaultValue: '0',
  },
] as const;

export class AddWorkflowExecutionLeases1712300000000 implements MigrationInterface {
  name = 'AddWorkflowExecutionLeases1712300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const tableRows: unknown = await queryRunner.query(
      `SELECT COUNT(*) AS tableCount
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_jobs'
          AND TABLE_TYPE = 'BASE TABLE'`,
    );
    const tableCount = readCount(tableRows, 'tableCount');
    if (tableCount !== 1) {
      throw new Error(
        'Workflow lease migration refused: workflow_jobs is missing',
      );
    }

    const existingRows: unknown = await queryRunner.query(
      `SELECT COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_jobs'
          AND COLUMN_NAME IN
            ('lease_owner', 'lease_token', 'lease_expires_at',
             'fencing_token', 'attempt_count')
        ORDER BY ORDINAL_POSITION`,
    );
    if (!Array.isArray(existingRows)) {
      throw new Error(
        'Workflow lease migration refused: column inspection failed',
      );
    }
    const existingByName = new Map(
      existingRows.map((row) => [
        readString(row, 'columnName'),
        {
          columnType: readString(row, 'columnType'),
          nullable: readString(row, 'nullable'),
          defaultValue: readNullable(row, 'defaultValue'),
        },
      ]),
    );

    for (const expected of COLUMN_DEFINITIONS) {
      const existing = existingByName.get(expected.name);
      if (
        existing &&
        (existing.columnType !== expected.columnType ||
          existing.nullable !== expected.nullable ||
          existing.defaultValue !== expected.defaultValue)
      ) {
        throw new Error(
          `Workflow lease migration refused: ${expected.name} has incompatible definition`,
        );
      }
    }

    const indexRows: unknown = await queryRunner.query(
      `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
              SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
              INDEX_TYPE AS indexType, IS_VISIBLE AS isVisible
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_jobs'
          AND INDEX_NAME = 'idx_workflow_jobs_status_lease'
        ORDER BY SEQ_IN_INDEX`,
    );
    if (!Array.isArray(indexRows)) {
      throw new Error(
        'Workflow lease migration refused: index inspection failed',
      );
    }
    if (
      indexRows.length > 0 &&
      indexSignature(indexRows) !==
        '1|1|status|BTREE|YES;1|2|lease_expires_at|BTREE|YES'
    ) {
      throw new Error(
        'Workflow lease migration refused: idx_workflow_jobs_status_lease has incompatible definition',
      );
    }

    for (const expected of COLUMN_DEFINITIONS) {
      if (!existingByName.has(expected.name)) {
        await queryRunner.query(
          `ALTER TABLE workflow_jobs ADD COLUMN \`${expected.name}\` ${expected.definition}`,
        );
      }
    }
    if (indexRows.length === 0) {
      await queryRunner.query(
        `ALTER TABLE workflow_jobs
           ADD KEY idx_workflow_jobs_status_lease
             (status, lease_expires_at)`,
      );
    }
    const violations =
      await findWorkflowSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Workflow lease migration refused: schema contract mismatch (${violations.join(
          ', ',
        )})`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE workflow_jobs DROP INDEX idx_workflow_jobs_status_lease',
    );
    for (const column of [...COLUMN_DEFINITIONS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE workflow_jobs DROP COLUMN \`${column.name}\``,
      );
    }
  }
}

function readCount(rows: unknown, key: string): number {
  if (!Array.isArray(rows) || rows.length !== 1) return Number.NaN;
  return Number(readString(rows[0], key));
}

function readString(row: unknown, key: string): string {
  if (typeof row !== 'object' || row === null) return '';
  return String((row as Record<string, unknown>)[key] ?? '');
}

function readNullable(row: unknown, key: string): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return value === null || value === undefined ? null : String(value);
}

function indexSignature(rows: unknown[]): string {
  return rows
    .map((row) =>
      [
        Number(readString(row, 'nonUnique')),
        Number(readString(row, 'sequenceNumber')),
        readString(row, 'columnName'),
        readString(row, 'indexType'),
        readString(row, 'isVisible'),
      ].join('|'),
    )
    .join(';');
}
