import type { MigrationInterface, QueryRunner } from 'typeorm';

interface ExpectedColumn {
  table: 'workflow_jobs' | 'workflow_domain_commits';
  name: 'generation_attempt' | 'commit_payload';
  definition: string;
  columnType: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
}

const COLUMNS: readonly ExpectedColumn[] = [
  {
    table: 'workflow_jobs',
    name: 'generation_attempt',
    definition: 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER attempt_count',
    columnType: 'int unsigned',
    nullable: 'NO',
    defaultValue: '0',
  },
  {
    table: 'workflow_domain_commits',
    name: 'commit_payload',
    definition: 'JSON NULL AFTER fencing_token',
    columnType: 'json',
    nullable: 'YES',
    defaultValue: null,
  },
];

export class AddWorkflowAttemptRecovery1712500000000 implements MigrationInterface {
  name = 'AddWorkflowAttemptRecovery1712500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertRequiredTables(queryRunner);
    for (const expected of COLUMNS) {
      const existing = await this.findColumn(
        queryRunner,
        expected.table,
        expected.name,
      );
      if (existing) {
        assertCompatible(existing, expected);
        continue;
      }
      await queryRunner.query(
        `ALTER TABLE \`${expected.table}\`
           ADD COLUMN \`${expected.name}\` ${expected.definition}`,
      );
    }
    for (const expected of COLUMNS) {
      const actual = await this.findColumn(
        queryRunner,
        expected.table,
        expected.name,
      );
      if (!actual) {
        throw new Error(
          `Workflow attempt recovery migration refused: ${expected.table}.${expected.name} is missing`,
        );
      }
      assertCompatible(actual, expected);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const expected of [...COLUMNS].reverse()) {
      if (await queryRunner.hasColumn(expected.table, expected.name)) {
        await queryRunner.query(
          `ALTER TABLE \`${expected.table}\`
             DROP COLUMN \`${expected.name}\``,
        );
      }
    }
  }

  private async assertRequiredTables(queryRunner: QueryRunner): Promise<void> {
    const rows: unknown = await queryRunner.query(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('workflow_jobs', 'workflow_domain_commits')
          AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`,
    );
    const tables = Array.isArray(rows)
      ? rows.map((row) => read(row, 'tableName'))
      : [];
    if (tables.join(',') !== 'workflow_domain_commits,workflow_jobs') {
      throw new Error(
        'Workflow attempt recovery migration refused: required tables are missing',
      );
    }
  }

  private async findColumn(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<Record<string, unknown> | null> {
    const rows: unknown = await queryRunner.query(
      `SELECT COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS defaultValue,
              EXTRA AS extra,
              GENERATION_EXPRESSION AS generationExpression
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new Error(
        `Workflow attempt recovery migration refused: duplicate ${table}.${column}`,
      );
    }
    return rows[0] as Record<string, unknown>;
  }
}

function assertCompatible(
  row: Record<string, unknown>,
  expected: ExpectedColumn,
): void {
  const defaultValue =
    row.defaultValue === null || row.defaultValue === undefined
      ? null
      : String(row.defaultValue);
  if (
    read(row, 'columnType') !== expected.columnType ||
    read(row, 'nullable') !== expected.nullable ||
    defaultValue !== expected.defaultValue ||
    read(row, 'extra') !== '' ||
    read(row, 'generationExpression') !== ''
  ) {
    throw new Error(
      `Workflow attempt recovery migration refused: ${expected.table}.${expected.name} has incompatible definition`,
    );
  }
}

function read(row: unknown, key: string): string {
  if (typeof row !== 'object' || row === null) return '';
  return String((row as Record<string, unknown>)[key] ?? '');
}
