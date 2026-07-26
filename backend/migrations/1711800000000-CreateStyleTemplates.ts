import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStyleTemplates1711800000000 implements MigrationInterface {
  name = 'CreateStyleTemplates1711800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS style_templates (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL,
        file_path VARCHAR(1024) NULL,
        reference_file_ids JSON NULL,
        features JSON NULL,
        status ENUM('pending', 'analyzing', 'completed', 'failed')
          NOT NULL DEFAULT 'pending',
        error_message TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT style_templates_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    if (
      !(await this.hasIndex(
        queryRunner,
        'style_templates',
        'idx_style_templates_project_id',
      ))
    ) {
      await queryRunner.query(`
        CREATE INDEX idx_style_templates_project_id ON style_templates(project_id)
      `);
    }
    if (
      !(await this.hasIndex(
        queryRunner,
        'style_templates',
        'idx_style_templates_status',
      ))
    ) {
      await queryRunner.query(`
        CREATE INDEX idx_style_templates_status ON style_templates(status)
      `);
    }

    if (
      !(await queryRunner.hasColumn('projects', 'active_style_template_id'))
    ) {
      await queryRunner.query(`
        ALTER TABLE projects
        ADD COLUMN active_style_template_id VARCHAR(36)
      `);
    }

    if (
      !(await this.hasForeignKey(
        queryRunner,
        'projects',
        'active_style_template_id',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE projects
        ADD CONSTRAINT projects_active_style_template_id_fkey
        FOREIGN KEY (active_style_template_id) REFERENCES style_templates(id)
        ON DELETE SET NULL
      `);
    }
    if (
      !(await this.hasIndex(
        queryRunner,
        'projects',
        'idx_projects_active_style_template_id',
      ))
    ) {
      await queryRunner.query(`
        CREATE INDEX idx_projects_active_style_template_id
        ON projects(active_style_template_id)
      `);
    }
  }

  public async down(): Promise<void> {
    throw new Error(
      'CreateStyleTemplates1711800000000 cannot be reversed safely because InitSchema owns the current style table and project pointer',
    );
  }

  private async hasIndex(
    queryRunner: QueryRunner,
    table: string,
    indexName: string,
  ): Promise<boolean> {
    const rows: unknown = await queryRunner.query(
      `SELECT 1
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND INDEX_NAME = ?
        LIMIT 1`,
      [table, indexName],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  private async hasForeignKey(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    return Boolean(await this.getForeignKeyName(queryRunner, table, column));
  }

  private async getForeignKeyName(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<string | undefined> {
    const rows: unknown = await queryRunner.query(
      `SELECT CONSTRAINT_NAME AS constraintName
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
        LIMIT 1`,
      [table, column],
    );
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    const first = rows[0] as { constraintName?: unknown };
    return typeof first.constraintName === 'string'
      ? first.constraintName
      : undefined;
  }
}
