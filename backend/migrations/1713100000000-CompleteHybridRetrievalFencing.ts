import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CompleteHybridRetrievalFencing1713100000000 implements MigrationInterface {
  name = 'CompleteHybridRetrievalFencing1713100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addColumns(queryRunner, 'retrieval_index_versions', [
      ['gc_token', 'CHAR(36) NULL AFTER published_namespace'],
      ['gc_lease_expires_at', 'DATETIME(6) NULL AFTER gc_token'],
      ['gc_completed_at', 'DATETIME(6) NULL AFTER gc_lease_expires_at'],
      ['gc_error_message', 'TEXT NULL AFTER gc_completed_at'],
    ]);
    if (
      !(await hasIndex(
        queryRunner,
        'retrieval_index_versions',
        'idx_retrieval_index_gc',
      ))
    ) {
      await queryRunner.query(
        `CREATE INDEX idx_retrieval_index_gc
           ON retrieval_index_versions
             (gc_completed_at, gc_lease_expires_at, status)`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE retrieval_runs
         MODIFY embedding_input_tokens INT NULL`,
    );
    await addColumns(queryRunner, 'retrieval_runs', [
      [
        'embedding_estimated_cost_usd',
        'DECIMAL(14,8) NULL AFTER embedding_input_tokens',
      ],
      [
        'embedding_estimated_input_tokens',
        'INT NULL AFTER embedding_estimated_cost_usd',
      ],
      [
        'embedding_usage_estimated',
        'TINYINT(1) NOT NULL DEFAULT 0 AFTER embedding_estimated_input_tokens',
      ],
    ]);

    if (
      !(await hasIndex(
        queryRunner,
        'retrieval_run_index_versions',
        'uq_retrieval_run_index_file',
      ))
    ) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX uq_retrieval_run_index_file
           ON retrieval_run_index_versions(retrieval_run_id, file_id)`,
      );
    }
    if (
      await hasIndex(
        queryRunner,
        'retrieval_run_index_versions',
        'uq_retrieval_run_index_version',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_run_index_versions
           DROP INDEX uq_retrieval_run_index_version`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE retrieval_run_index_versions
         MODIFY index_version_id VARCHAR(36) NULL`,
    );
    await addColumns(queryRunner, 'retrieval_run_index_versions', [
      ['expected_point_count', 'INT NOT NULL DEFAULT 0 AFTER status'],
      ['observed_point_count', 'INT NULL AFTER expected_point_count'],
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await hasIndex(
        queryRunner,
        'retrieval_run_index_versions',
        'uq_retrieval_run_index_version',
      ))
    ) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX uq_retrieval_run_index_version
           ON retrieval_run_index_versions
             (retrieval_run_id, index_version_id)`,
      );
    }
    if (
      await hasIndex(
        queryRunner,
        'retrieval_run_index_versions',
        'uq_retrieval_run_index_file',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_run_index_versions
           DROP INDEX uq_retrieval_run_index_file`,
      );
    }
    for (const column of ['observed_point_count', 'expected_point_count']) {
      if (await queryRunner.hasColumn('retrieval_run_index_versions', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_run_index_versions
             DROP COLUMN \`${column}\``,
        );
      }
    }
    await queryRunner.query(
      `ALTER TABLE retrieval_run_index_versions
         MODIFY index_version_id VARCHAR(36) NOT NULL`,
    );
    for (const column of [
      'embedding_usage_estimated',
      'embedding_estimated_input_tokens',
      'embedding_estimated_cost_usd',
    ]) {
      if (await queryRunner.hasColumn('retrieval_runs', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_runs DROP COLUMN \`${column}\``,
        );
      }
    }
    await queryRunner.query(
      `ALTER TABLE retrieval_runs
         MODIFY embedding_input_tokens INT NOT NULL DEFAULT 0`,
    );
    if (
      await hasIndex(
        queryRunner,
        'retrieval_index_versions',
        'idx_retrieval_index_gc',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_index_versions
           DROP INDEX idx_retrieval_index_gc`,
      );
    }
    for (const column of [
      'gc_error_message',
      'gc_completed_at',
      'gc_lease_expires_at',
      'gc_token',
    ]) {
      if (await queryRunner.hasColumn('retrieval_index_versions', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_index_versions DROP COLUMN \`${column}\``,
        );
      }
    }
  }
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
