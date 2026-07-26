import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenHybridRetrieval1713000000000 implements MigrationInterface {
  name = 'HardenHybridRetrieval1713000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await ensureNgramIndex(queryRunner);
    await addColumns(queryRunner, 'retrieval_index_versions', [
      ['claim_token', 'CHAR(36) NULL AFTER status'],
      ['lease_expires_at', 'DATETIME(6) NULL AFTER claim_token'],
      ['attempt_count', 'INT NOT NULL DEFAULT 0 AFTER lease_expires_at'],
      ['max_attempts', 'INT NOT NULL DEFAULT 5 AFTER attempt_count'],
      ['next_retry_at', 'DATETIME(6) NULL AFTER max_attempts'],
      ['published_namespace', 'VARCHAR(80) NULL AFTER next_retry_at'],
    ]);
    await queryRunner
      .query(
        `CREATE INDEX idx_retrieval_index_dispatch
         ON retrieval_index_versions(status, next_retry_at, lease_expires_at)`,
      )
      .catch((error: unknown) => {
        if (!isDuplicateIndex(error)) throw error;
      });

    await addColumns(queryRunner, 'retrieval_runs', [
      ['mode', `VARCHAR(20) NOT NULL DEFAULT 'shadow' AFTER state`],
      ['gate_decision', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER mode'],
      ['canonical_state', 'VARCHAR(20) NULL AFTER shadow_path'],
      ['canonical_latency_ms', 'INT NULL AFTER canonical_state'],
      ['canonical_count', 'INT NOT NULL DEFAULT 0 AFTER canonical_latency_ms'],
      ['canonical_error_code', 'VARCHAR(100) NULL AFTER canonical_count'],
      ['canonical_error_message', 'TEXT NULL AFTER canonical_error_code'],
      ['shadow_state', 'VARCHAR(20) NULL AFTER canonical_error_message'],
      ['shadow_latency_ms', 'INT NULL AFTER shadow_state'],
      ['shadow_count', 'INT NOT NULL DEFAULT 0 AFTER shadow_latency_ms'],
      ['shadow_error_code', 'VARCHAR(100) NULL AFTER shadow_count'],
      ['shadow_error_message', 'TEXT NULL AFTER shadow_error_code'],
      [
        'embedding_input_tokens',
        'INT NOT NULL DEFAULT 0 AFTER embedding_cost_usd',
      ],
      ['collection_name', 'VARCHAR(100) NULL AFTER embedding_input_tokens'],
      ['embedding_model', 'VARCHAR(100) NULL AFTER collection_name'],
      ['embedding_dimension', 'INT NULL AFTER embedding_model'],
      ['retrieval_config_hash', 'CHAR(64) NULL AFTER embedding_dimension'],
    ]);
    await queryRunner.query(
      `ALTER TABLE retrieval_runs MODIFY shadow_path VARCHAR(30) NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retrieval_run_index_versions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        retrieval_run_id VARCHAR(36) NOT NULL,
        index_version_id VARCHAR(36) NOT NULL,
        file_id VARCHAR(36) NOT NULL,
        ingestion_key CHAR(64) NOT NULL,
        index_version VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_retrieval_run_index_version
          (retrieval_run_id, index_version_id),
        CONSTRAINT retrieval_run_indexes_run_fkey
          FOREIGN KEY (retrieval_run_id) REFERENCES retrieval_runs(id)
          ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS retrieval_run_index_versions`,
    );
    if (
      await hasIndex(
        queryRunner,
        'retrieval_index_versions',
        'idx_retrieval_index_dispatch',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_index_versions DROP INDEX idx_retrieval_index_dispatch`,
      );
    }
    for (const column of [
      'retrieval_config_hash',
      'embedding_dimension',
      'embedding_model',
      'collection_name',
      'embedding_input_tokens',
      'shadow_error_message',
      'shadow_error_code',
      'shadow_count',
      'shadow_latency_ms',
      'shadow_state',
      'canonical_error_message',
      'canonical_error_code',
      'canonical_count',
      'canonical_latency_ms',
      'canonical_state',
      'gate_decision',
      'mode',
    ]) {
      if (await queryRunner.hasColumn('retrieval_runs', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_runs DROP COLUMN \`${column}\``,
        );
      }
    }
    for (const column of [
      'next_retry_at',
      'published_namespace',
      'max_attempts',
      'attempt_count',
      'lease_expires_at',
      'claim_token',
    ]) {
      if (await queryRunner.hasColumn('retrieval_index_versions', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_index_versions DROP COLUMN \`${column}\``,
        );
      }
    }
  }
}

async function ensureNgramIndex(queryRunner: QueryRunner): Promise<void> {
  const createRows: unknown = await queryRunner.query(
    `SHOW CREATE TABLE chunks`,
  );
  const createSql =
    Array.isArray(createRows) && createRows[0]
      ? String((createRows[0] as Record<string, unknown>)['Create Table'] ?? '')
      : '';
  if (
    createSql.includes('FULLTEXT KEY `idx_chunks_search_fulltext`') &&
    /idx_chunks_search_fulltext[\s\S]*WITH PARSER `?ngram`?/iu.test(createSql)
  ) {
    return;
  }
  if (await hasIndex(queryRunner, 'chunks', 'idx_chunks_search_fulltext')) {
    await queryRunner.query(
      `ALTER TABLE chunks DROP INDEX idx_chunks_search_fulltext`,
    );
  }
  // Deliberately fail closed when the MySQL ngram parser is unavailable.
  await queryRunner.query(
    `ALTER TABLE chunks
       ADD FULLTEXT INDEX idx_chunks_search_fulltext (search_text)
       WITH PARSER ngram`,
  );
}

async function addColumns(
  queryRunner: QueryRunner,
  table: string,
  columns: Array<[string, string]>,
): Promise<void> {
  for (const [column, definition] of columns) {
    if (!(await queryRunner.hasColumn(table, column))) {
      await queryRunner.query(
        `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
      );
    }
  }
}

async function hasIndex(
  queryRunner: QueryRunner,
  table: string,
  index: string,
): Promise<boolean> {
  const rows: unknown = await queryRunner.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [table, index],
  );
  return Array.isArray(rows) && rows.length > 0;
}

function isDuplicateIndex(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    String((error as { code?: unknown }).code ?? '') === 'ER_DUP_KEYNAME'
  );
}
