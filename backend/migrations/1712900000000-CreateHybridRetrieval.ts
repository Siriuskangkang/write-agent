import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHybridRetrieval1712900000000 implements MigrationInterface {
  name = 'CreateHybridRetrieval1712900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('chunks', 'search_text'))) {
      await queryRunner.query(
        `ALTER TABLE chunks ADD COLUMN search_text LONGTEXT NULL AFTER content`,
      );
    }
    const headingExpression = (await queryRunner.hasColumn(
      'chunks',
      'heading_path',
    ))
      ? `NULLIF(JSON_UNQUOTE(heading_path), 'null')`
      : 'NULL';
    await queryRunner.query(`
      UPDATE chunks
         SET search_text = CONCAT_WS(
           '\\n',
           ${headingExpression},
           section_title,
           content
         )
       WHERE search_text IS NULL OR search_text = ''
    `);
    await queryRunner.query(
      `ALTER TABLE chunks MODIFY COLUMN search_text LONGTEXT NOT NULL`,
    );
    if (await hasIndex(queryRunner, 'chunks', 'idx_chunks_content_fulltext')) {
      await queryRunner.query(
        `ALTER TABLE chunks DROP INDEX idx_chunks_content_fulltext`,
      );
    }
    if (
      !(await hasIndex(queryRunner, 'chunks', 'idx_chunks_search_fulltext'))
    ) {
      // Chinese sparse retrieval requires ngram semantics. Fail closed instead
      // of silently creating a non-equivalent default FULLTEXT index.
      await queryRunner.query(
        `ALTER TABLE chunks
           ADD FULLTEXT INDEX idx_chunks_search_fulltext (search_text)
           WITH PARSER ngram`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retrieval_runs (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        query VARCHAR(500) NOT NULL,
        task_type VARCHAR(20) NOT NULL,
        query_plan JSON NOT NULL,
        state VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
        canonical_path VARCHAR(30) NOT NULL DEFAULT 'hybrid',
        shadow_path VARCHAR(30) NOT NULL DEFAULT 'legacy_like',
        error_code VARCHAR(100) NULL,
        error_message TEXT NULL,
        sparse_count INT NOT NULL DEFAULT 0,
        dense_count INT NOT NULL DEFAULT 0,
        fused_count INT NOT NULL DEFAULT 0,
        legacy_count INT NOT NULL DEFAULT 0,
        selected_count INT NOT NULL DEFAULT 0,
        latency_ms INT NULL,
        embedding_cost_usd DECIMAL(14,8) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        completed_at DATETIME(6) NULL,
        PRIMARY KEY (id),
        KEY idx_retrieval_runs_project_created (project_id, created_at),
        CONSTRAINT retrieval_runs_project_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id)
          ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retrieval_candidates (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        retrieval_run_id VARCHAR(36) NOT NULL,
        chunk_id VARCHAR(36) NOT NULL,
        file_id VARCHAR(36) NOT NULL,
        document_id VARCHAR(36) NOT NULL,
        ingestion_key CHAR(64) NULL,
        sparse_rank INT NULL,
        sparse_score DOUBLE NULL,
        \`dense_rank\` INT NULL,
        dense_score DOUBLE NULL,
        fusion_rank INT NOT NULL,
        fusion_score DOUBLE NOT NULL,
        rerank_rank INT NOT NULL,
        rerank_score DOUBLE NOT NULL,
        selected TINYINT(1) NOT NULL DEFAULT 0,
        evidence JSON NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_retrieval_candidates_run_chunk
          (retrieval_run_id, chunk_id),
        KEY idx_retrieval_candidates_run_fusion
          (retrieval_run_id, fusion_rank),
        CONSTRAINT retrieval_candidates_run_fkey
          FOREIGN KEY (retrieval_run_id)
          REFERENCES retrieval_runs(id)
          ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS retrieval_index_versions (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        project_id VARCHAR(36) NOT NULL,
        file_id VARCHAR(36) NOT NULL,
        document_id VARCHAR(36) NOT NULL,
        ingestion_key CHAR(64) NOT NULL,
        chunk_version VARCHAR(50) NOT NULL,
        index_version VARCHAR(50) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'qdrant',
        collection_name VARCHAR(100) NOT NULL DEFAULT 'write_agent_chunks',
        embedding_model VARCHAR(100) NOT NULL,
        embedding_dimension INT NOT NULL,
        distance VARCHAR(20) NOT NULL DEFAULT 'Cosine',
        sparse_parser VARCHAR(20) NOT NULL DEFAULT 'ngram',
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        point_count INT NOT NULL DEFAULT 0,
        error_code VARCHAR(100) NULL,
        error_message TEXT NULL,
        indexed_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_retrieval_index_file_ingestion_version
          (file_id, ingestion_key, index_version),
        KEY idx_retrieval_index_project_status (project_id, status),
        CONSTRAINT retrieval_index_project_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id)
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT retrieval_index_file_fkey
          FOREIGN KEY (file_id) REFERENCES source_files(id)
          ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT retrieval_index_document_fkey
          FOREIGN KEY (document_id) REFERENCES documents(id)
          ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS retrieval_index_versions`);
    await queryRunner.query(`DROP TABLE IF EXISTS retrieval_candidates`);
    await queryRunner.query(`DROP TABLE IF EXISTS retrieval_runs`);
    if (await hasIndex(queryRunner, 'chunks', 'idx_chunks_search_fulltext')) {
      await queryRunner.query(
        `ALTER TABLE chunks DROP INDEX idx_chunks_search_fulltext`,
      );
    }
    if (await queryRunner.hasColumn('chunks', 'search_text')) {
      await queryRunner.query(`ALTER TABLE chunks DROP COLUMN search_text`);
    }
    if (
      !(await hasIndex(queryRunner, 'chunks', 'idx_chunks_content_fulltext'))
    ) {
      await queryRunner.query(
        `ALTER TABLE chunks
           ADD FULLTEXT INDEX idx_chunks_content_fulltext (content)`,
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
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [table, index],
  );
  return Array.isArray(rows) && rows.length > 0;
}
