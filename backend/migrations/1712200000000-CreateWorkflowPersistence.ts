import { MigrationInterface, QueryRunner } from 'typeorm';
import { findApplicationSchemaContractViolations } from './support/application-schema-contract';
import {
  findWorkflowSchemaContractViolations,
  WORKFLOW_SCHEMA_TABLES,
} from './support/workflow-schema-contract';

const CREATE_WORKFLOW_JOBS = `
  CREATE TABLE workflow_jobs (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    user_id VARCHAR(36) NOT NULL,
    project_id VARCHAR(36) NOT NULL,
    workflow_type VARCHAR(50) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    input JSON NULL,
    checkpoint JSON NULL,
    cancel_requested_at DATETIME(6) NULL,
    approved_at DATETIME(6) NULL,
    error_code VARCHAR(100) NULL,
    error_message TEXT NULL,
    public_error_code VARCHAR(100) NULL,
    public_error_message VARCHAR(500) NULL,
    started_at DATETIME(6) NULL,
    completed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
      ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_jobs_idempotency
      (user_id, project_id, workflow_type, idempotency_key),
    KEY idx_workflow_jobs_project_status_created
      (project_id, status, created_at),
    CONSTRAINT workflow_jobs_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT workflow_jobs_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id)
      ON DELETE CASCADE ON UPDATE RESTRICT
  ) ENGINE=InnoDB
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci
`;

const CREATE_WORKFLOW_EVENTS = `
  CREATE TABLE workflow_events (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    job_id VARCHAR(36) NOT NULL,
    seq INT UNSIGNED NOT NULL,
    type VARCHAR(100) NOT NULL,
    data JSON NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_events_job_seq (job_id, seq),
    CONSTRAINT workflow_events_job_id_fkey
      FOREIGN KEY (job_id) REFERENCES workflow_jobs(id)
      ON DELETE CASCADE ON UPDATE RESTRICT
  ) ENGINE=InnoDB
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci
`;

const CREATE_MODEL_RUNS = `
  CREATE TABLE model_runs (
    id VARCHAR(36) NOT NULL DEFAULT (UUID()),
    workflow_job_id VARCHAR(36) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    request_metadata JSON NULL,
    prompt_sha256 CHAR(64) NULL,
    \`usage\` JSON NULL,
    cost_usd DECIMAL(12, 6) NULL,
    status VARCHAR(20) NOT NULL,
    error_code VARCHAR(100) NULL,
    error_message TEXT NULL,
    started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    completed_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    KEY idx_model_runs_workflow_status (workflow_job_id, status),
    CONSTRAINT model_runs_workflow_job_id_fkey
      FOREIGN KEY (workflow_job_id) REFERENCES workflow_jobs(id)
      ON DELETE CASCADE ON UPDATE RESTRICT
  ) ENGINE=InnoDB
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci
`;

const CREATE_STATEMENTS = [
  CREATE_WORKFLOW_JOBS,
  CREATE_WORKFLOW_EVENTS,
  CREATE_MODEL_RUNS,
] as const;

export class CreateWorkflowPersistence1712200000000 implements MigrationInterface {
  name = 'CreateWorkflowPersistence1712200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const existingTables = await this.findExistingTables(queryRunner);
    if (existingTables.length === 0) {
      await this.createAll(queryRunner);
      return;
    }

    if (existingTables.length === WORKFLOW_SCHEMA_TABLES.length) {
      const violations =
        await findWorkflowSchemaContractViolations(queryRunner);
      if (violations.length === 0) return;
    }

    for (const table of existingTables) {
      const rows: unknown = await queryRunner.query(
        `SELECT COUNT(*) AS rowCount FROM \`${table}\``,
      );
      const rowCount =
        Array.isArray(rows) && rows.length > 0
          ? Number((rows[0] as { rowCount?: number | string }).rowCount ?? 0)
          : Number.NaN;
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
        throw new Error(
          `Workflow persistence recovery refused: could not count ${table}`,
        );
      }
      if (rowCount > 0) {
        throw new Error(
          `Workflow persistence recovery refused: ${table} contains ${rowCount} ${
            rowCount === 1 ? 'row' : 'rows'
          }`,
        );
      }
    }

    const applicationViolations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (applicationViolations.length > 0) {
      throw new Error(
        `Workflow persistence recovery refused: application schema is not canonical (${applicationViolations.join(
          ', ',
        )})`,
      );
    }

    await queryRunner.query('DROP TABLE IF EXISTS model_runs');
    await queryRunner.query('DROP TABLE IF EXISTS workflow_events');
    await queryRunner.query('DROP TABLE IF EXISTS workflow_jobs');
    await this.createAll(queryRunner);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS model_runs');
    await queryRunner.query('DROP TABLE IF EXISTS workflow_events');
    await queryRunner.query('DROP TABLE IF EXISTS workflow_jobs');
  }

  private async findExistingTables(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: unknown = await queryRunner.query(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('workflow_jobs', 'workflow_events', 'model_runs')
        ORDER BY TABLE_NAME`,
    );
    if (!Array.isArray(rows)) {
      throw new Error(
        'Workflow persistence recovery refused: table inspection failed',
      );
    }
    return rows
      .map((row) =>
        typeof row === 'object' && row !== null
          ? String((row as { tableName?: unknown }).tableName ?? '')
          : '',
      )
      .filter((table): table is string =>
        WORKFLOW_SCHEMA_TABLES.includes(
          table as (typeof WORKFLOW_SCHEMA_TABLES)[number],
        ),
      );
  }

  private async createAll(queryRunner: QueryRunner): Promise<void> {
    for (const statement of CREATE_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }
}
