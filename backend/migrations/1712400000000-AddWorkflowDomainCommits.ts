import type { MigrationInterface, QueryRunner } from 'typeorm';

const EXPECTED_COLUMNS = [
  'workflow_job_id|varchar(36)|NO',
  'workflow_type|varchar(50)|NO',
  'resource_id|varchar(36)|NO',
  'version_id|varchar(36)|YES',
  'fencing_token|bigint unsigned|NO',
  'created_at|datetime(6)|NO',
] as const;

export class AddWorkflowDomainCommits1712400000000 implements MigrationInterface {
  name = 'AddWorkflowDomainCommits1712400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS workflow_domain_commits (
        workflow_job_id VARCHAR(36) NOT NULL,
        workflow_type VARCHAR(50) NOT NULL,
        resource_id VARCHAR(36) NOT NULL,
        version_id VARCHAR(36) NULL,
        fencing_token BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (workflow_job_id),
        KEY idx_workflow_domain_commits_resource
          (workflow_type, resource_id),
        CONSTRAINT workflow_domain_commits_job_id_fkey
          FOREIGN KEY (workflow_job_id)
          REFERENCES workflow_jobs(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    const columns: unknown = await queryRunner.query(
      `SELECT COLUMN_NAME AS columnName,
              COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_domain_commits'
        ORDER BY ORDINAL_POSITION`,
    );
    if (
      !Array.isArray(columns) ||
      columns
        .map(
          (row) =>
            `${read(row, 'columnName')}|${read(row, 'columnType')}|${read(
              row,
              'nullable',
            )}`,
        )
        .join(';') !== EXPECTED_COLUMNS.join(';')
    ) {
      throw new Error(
        'Workflow domain commit migration refused: incompatible table contract',
      );
    }

    const table: unknown = await queryRunner.query(
      `SELECT ENGINE AS engine, TABLE_COLLATION AS tableCollation
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_domain_commits'
          AND TABLE_TYPE = 'BASE TABLE'`,
    );
    if (
      !Array.isArray(table) ||
      table.length !== 1 ||
      read(table[0], 'engine') !== 'InnoDB' ||
      read(table[0], 'tableCollation') !== 'utf8mb4_0900_ai_ci'
    ) {
      throw new Error(
        'Workflow domain commit migration refused: incompatible table metadata',
      );
    }

    const indexes: unknown = await queryRunner.query(
      `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
              SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
              INDEX_TYPE AS indexType, IS_VISIBLE AS isVisible
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'workflow_domain_commits'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    );
    if (
      !Array.isArray(indexes) ||
      indexes
        .map(
          (row) =>
            `${read(row, 'indexName')}|${read(row, 'nonUnique')}|${read(
              row,
              'sequenceNumber',
            )}|${read(row, 'columnName')}|${read(
              row,
              'indexType',
            )}|${read(row, 'isVisible')}`,
        )
        .join(';') !==
        [
          'idx_workflow_domain_commits_resource|1|1|workflow_type|BTREE|YES',
          'idx_workflow_domain_commits_resource|1|2|resource_id|BTREE|YES',
          'PRIMARY|0|1|workflow_job_id|BTREE|YES',
        ].join(';')
    ) {
      throw new Error(
        'Workflow domain commit migration refused: incompatible indexes',
      );
    }

    const foreignKeys: unknown = await queryRunner.query(
      `SELECT kcu.CONSTRAINT_NAME AS constraintName,
              kcu.COLUMN_NAME AS columnName,
              kcu.REFERENCED_TABLE_NAME AS referencedTable,
              kcu.REFERENCED_COLUMN_NAME AS referencedColumn,
              rc.DELETE_RULE AS deleteRule,
              rc.UPDATE_RULE AS updateRule
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.TABLE_NAME = 'workflow_domain_commits'
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    if (
      !Array.isArray(foreignKeys) ||
      foreignKeys.length !== 1 ||
      [
        read(foreignKeys[0], 'constraintName'),
        read(foreignKeys[0], 'columnName'),
        read(foreignKeys[0], 'referencedTable'),
        read(foreignKeys[0], 'referencedColumn'),
        read(foreignKeys[0], 'deleteRule'),
        read(foreignKeys[0], 'updateRule'),
      ].join('|') !==
        'workflow_domain_commits_job_id_fkey|workflow_job_id|workflow_jobs|id|CASCADE|NO ACTION'
    ) {
      throw new Error(
        'Workflow domain commit migration refused: incompatible foreign key',
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS workflow_domain_commits');
  }
}

function read(row: unknown, key: string): string {
  if (typeof row !== 'object' || row === null) return '';
  return String((row as Record<string, unknown>)[key] ?? '');
}
