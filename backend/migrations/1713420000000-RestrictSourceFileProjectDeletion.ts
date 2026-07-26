import type { MigrationInterface, QueryRunner } from 'typeorm';

interface ForeignKeyRow {
  deleteRule: string;
  updateRule: string;
}

export class RestrictSourceFileProjectDeletion1713420000000 implements MigrationInterface {
  name = 'RestrictSourceFileProjectDeletion1713420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('projects')) ||
      !(await queryRunner.hasTable('source_files'))
    ) {
      throw new Error(
        'STORAGE_SCHEMA_RECONCILIATION_REQUIRED:source_files_project_id_fkey',
      );
    }
    const orphanRows: unknown = await queryRunner.query(
      `SELECT sf.id
         FROM source_files sf
         LEFT JOIN projects p ON p.id=sf.project_id
        WHERE p.id IS NULL
        LIMIT 1`,
    );
    if (Array.isArray(orphanRows) && orphanRows.length > 0) {
      throw new Error(
        'STORAGE_SCHEMA_RECONCILIATION_REQUIRED:source_files_project_orphan',
      );
    }

    const current = await readForeignKey(queryRunner);
    if (
      current?.deleteRule === 'RESTRICT' &&
      current.updateRule === 'RESTRICT'
    ) {
      return;
    }
    if (
      !current ||
      current.deleteRule !== 'CASCADE' ||
      (current.updateRule !== 'NO ACTION' && current.updateRule !== 'RESTRICT')
    ) {
      throw new Error(
        'STORAGE_SCHEMA_RECONCILIATION_REQUIRED:source_files_project_id_fkey',
      );
    }

    await queryRunner.query(
      `ALTER TABLE source_files
         DROP FOREIGN KEY source_files_project_id_fkey`,
    );
    await queryRunner.query(
      `ALTER TABLE source_files
         ADD CONSTRAINT source_files_project_id_fkey
         FOREIGN KEY (project_id) REFERENCES projects(id)
         ON DELETE RESTRICT ON UPDATE RESTRICT`,
    );
    const reconciled = await readForeignKey(queryRunner);
    if (
      reconciled?.deleteRule !== 'RESTRICT' ||
      reconciled.updateRule !== 'RESTRICT'
    ) {
      throw new Error(
        'STORAGE_SCHEMA_RECONCILIATION_REQUIRED:source_files_project_id_fkey',
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error('STORAGE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
  }
}

async function readForeignKey(
  queryRunner: QueryRunner,
): Promise<ForeignKeyRow | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT DELETE_RULE AS deleteRule, UPDATE_RULE AS updateRule
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND TABLE_NAME='source_files'
        AND CONSTRAINT_NAME='source_files_project_id_fkey'`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    deleteRule: String(row.deleteRule),
    updateRule: String(row.updateRule),
  };
}
