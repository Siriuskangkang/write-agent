import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateClaimEvidenceLedger1713300000000 implements MigrationInterface {
  name = 'CreateClaimEvidenceLedger1713300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Keep the database default aligned with the fail-safe shadow rollout.
    // Existing callers still pass the canonical path explicitly.
    await queryRunner.query(`
      ALTER TABLE retrieval_runs
        MODIFY canonical_path VARCHAR(30) NOT NULL DEFAULT 'legacy_like'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS grounding_assignments (
        workflow_job_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        retrieval_run_id VARCHAR(36) NOT NULL,
        retrieval_state VARCHAR(20) NOT NULL,
        evidence_ids JSON NOT NULL,
        strict_mode TINYINT(1) NOT NULL DEFAULT 1,
        targeted_revision_attempts INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (workflow_job_id),
        KEY idx_grounding_assignments_run (retrieval_run_id),
        KEY idx_grounding_assignments_project (project_id),
        CONSTRAINT grounding_assignments_workflow_fkey
          FOREIGN KEY (workflow_job_id) REFERENCES workflow_jobs(id)
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT grounding_assignments_project_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id)
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT grounding_assignments_run_fkey
          FOREIGN KEY (retrieval_run_id) REFERENCES retrieval_runs(id)
          ON DELETE RESTRICT ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS grounding_claims (
        claim_id CHAR(64) NOT NULL,
        workflow_job_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        result_id VARCHAR(36) NOT NULL,
        claim_text TEXT NOT NULL,
        normalized_claim_text TEXT NOT NULL,
        output_char_start INT UNSIGNED NOT NULL,
        output_char_end INT UNSIGNED NOT NULL,
        support_status VARCHAR(20) NOT NULL,
        support_score DOUBLE NOT NULL DEFAULT 0,
        verification_method VARCHAR(50) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (claim_id),
        UNIQUE KEY uq_grounding_claims_result_offsets
          (result_id, output_char_start, output_char_end),
        KEY idx_grounding_claims_project_result (project_id, result_id),
        KEY idx_grounding_claims_workflow (workflow_job_id),
        CONSTRAINT grounding_claims_workflow_fkey
          FOREIGN KEY (workflow_job_id) REFERENCES workflow_jobs(id)
          ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT grounding_claims_project_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id)
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT grounding_claims_result_fkey
          FOREIGN KEY (result_id) REFERENCES writing_results(id)
          ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);

    await addColumns(queryRunner, 'citation_maps', [
      ['claim_id', 'CHAR(64) NULL'],
      ['evidence_id', 'VARCHAR(100) NULL'],
      ['document_id', 'VARCHAR(36) NULL'],
      ['retrieval_run_id', 'VARCHAR(36) NULL'],
      ['support_status', `VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIABLE'`],
      ['support_score', 'DOUBLE NOT NULL DEFAULT 0'],
      [
        'verification_method',
        `VARCHAR(50) NOT NULL DEFAULT 'legacy_unverifiable'`,
      ],
      ['evidence_char_start', 'INT NULL'],
      ['evidence_char_end', 'INT NULL'],
      ['chunk_char_start', 'INT NULL'],
      ['chunk_char_end', 'INT NULL'],
      ['candidate_rank', 'INT NULL'],
      ['sparse_rank', 'INT NULL'],
      ['dense_rank', 'INT NULL'],
      ['fusion_rank', 'INT NULL'],
      ['rerank_rank', 'INT NULL'],
      ['sparse_score', 'DOUBLE NULL'],
      ['dense_score', 'DOUBLE NULL'],
      ['fusion_score', 'DOUBLE NULL'],
      ['rerank_score', 'DOUBLE NULL'],
      ['ingestion_key', 'CHAR(64) NULL'],
      ['index_snapshot', 'JSON NULL'],
    ]);
    await queryRunner.query(`
      UPDATE citation_maps
         SET support_status = 'UNVERIFIABLE',
             support_score = 0,
             verification_method = 'legacy_unverifiable'
       WHERE claim_id IS NULL
    `);
    await addIndex(
      queryRunner,
      'citation_maps',
      'idx_citation_maps_claim',
      '(claim_id)',
    );
    await addIndex(
      queryRunner,
      'citation_maps',
      'idx_citation_maps_retrieval',
      '(retrieval_run_id)',
    );
    await addForeignKey(
      queryRunner,
      'citation_maps',
      'citation_maps_claim_fkey',
      'claim_id',
      'grounding_claims',
      'claim_id',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropForeignKey(
      queryRunner,
      'citation_maps',
      'citation_maps_claim_fkey',
    );
    for (const index of [
      'idx_citation_maps_retrieval',
      'idx_citation_maps_claim',
    ]) {
      if (await hasIndex(queryRunner, 'citation_maps', index)) {
        await queryRunner.query(
          `ALTER TABLE citation_maps DROP INDEX \`${index}\``,
        );
      }
    }
    for (const column of [
      'index_snapshot',
      'ingestion_key',
      'rerank_score',
      'fusion_score',
      'dense_score',
      'sparse_score',
      'rerank_rank',
      'fusion_rank',
      'dense_rank',
      'sparse_rank',
      'candidate_rank',
      'chunk_char_end',
      'chunk_char_start',
      'evidence_char_end',
      'evidence_char_start',
      'verification_method',
      'support_score',
      'support_status',
      'retrieval_run_id',
      'document_id',
      'evidence_id',
      'claim_id',
    ]) {
      if (await queryRunner.hasColumn('citation_maps', column)) {
        await queryRunner.query(
          `ALTER TABLE citation_maps DROP COLUMN \`${column}\``,
        );
      }
    }
    await queryRunner.query(`DROP TABLE IF EXISTS grounding_claims`);
    await queryRunner.query(`DROP TABLE IF EXISTS grounding_assignments`);
    await queryRunner.query(`
      ALTER TABLE retrieval_runs
        MODIFY canonical_path VARCHAR(30) NOT NULL DEFAULT 'hybrid'
    `);
  }
}

async function addColumns(
  queryRunner: QueryRunner,
  table: string,
  columns: Array<[string, string]>,
): Promise<void> {
  for (const [name, definition] of columns) {
    if (!(await queryRunner.hasColumn(table, name))) {
      await queryRunner.query(
        `ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`,
      );
    }
  }
}

async function addIndex(
  queryRunner: QueryRunner,
  table: string,
  name: string,
  expression: string,
): Promise<void> {
  if (!(await hasIndex(queryRunner, table, name))) {
    await queryRunner.query(
      `ALTER TABLE \`${table}\` ADD INDEX \`${name}\` ${expression}`,
    );
  }
}

async function hasIndex(
  queryRunner: QueryRunner,
  table: string,
  name: string,
): Promise<boolean> {
  const rows: unknown = await queryRunner.query(
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [table, name],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function addForeignKey(
  queryRunner: QueryRunner,
  table: string,
  name: string,
  column: string,
  referencedTable: string,
  referencedColumn: string,
): Promise<void> {
  if (await hasForeignKey(queryRunner, table, name)) return;
  await queryRunner.query(
    `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${name}\`
       FOREIGN KEY (\`${column}\`) REFERENCES \`${referencedTable}\`(\`${referencedColumn}\`)
       ON DELETE CASCADE ON UPDATE NO ACTION`,
  );
}

async function dropForeignKey(
  queryRunner: QueryRunner,
  table: string,
  name: string,
): Promise<void> {
  if (await hasForeignKey(queryRunner, table, name)) {
    await queryRunner.query(
      `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``,
    );
  }
}

async function hasForeignKey(
  queryRunner: QueryRunner,
  table: string,
  name: string,
): Promise<boolean> {
  const rows: unknown = await queryRunner.query(
    `SELECT 1
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      LIMIT 1`,
    [table, name],
  );
  return Array.isArray(rows) && rows.length > 0;
}
