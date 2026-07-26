import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RetainReactivatableDenseNamespaces1713200000000 implements MigrationInterface {
  name = 'RetainReactivatableDenseNamespaces1713200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'retrieval_index_versions',
        'retention_debt_recorded_at',
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_index_versions
           ADD COLUMN retention_debt_recorded_at DATETIME(6) NULL
           AFTER published_namespace`,
      );
    }
    if (
      !(await queryRunner.hasColumn(
        'retrieval_index_versions',
        'retention_debt_reason',
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_index_versions
           ADD COLUMN retention_debt_reason VARCHAR(100) NULL
           AFTER retention_debt_recorded_at`,
      );
    }
    if (
      !(await hasIndex(
        queryRunner,
        'retrieval_index_versions',
        'idx_retrieval_index_retention_debt',
      ))
    ) {
      await queryRunner.query(
        `CREATE INDEX idx_retrieval_index_retention_debt
           ON retrieval_index_versions
             (retention_debt_recorded_at, status)`,
      );
    }

    if (
      await queryRunner.hasColumn('retrieval_index_versions', 'gc_completed_at')
    ) {
      await queryRunner.query(
        `UPDATE retrieval_index_versions stale
           JOIN source_files sf
             ON sf.id = stale.file_id AND sf.project_id = stale.project_id
            SET stale.retention_debt_recorded_at =
                  COALESCE(stale.updated_at, CURRENT_TIMESTAMP(6)),
                stale.retention_debt_reason =
                  'REACTIVATABLE_NAMESPACE_RETAINED'
          WHERE stale.status = 'READY'
            AND stale.published_namespace IS NOT NULL
            AND stale.ingestion_key <> sf.active_ingestion_key
            AND stale.gc_completed_at IS NULL`,
      );
    }

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

  public async down(queryRunner: QueryRunner): Promise<void> {
    const legacyColumns: Array<[string, string]> = [
      ['gc_token', 'CHAR(36) NULL AFTER published_namespace'],
      ['gc_lease_expires_at', 'DATETIME(6) NULL AFTER gc_token'],
      ['gc_completed_at', 'DATETIME(6) NULL AFTER gc_lease_expires_at'],
      ['gc_error_message', 'TEXT NULL AFTER gc_completed_at'],
    ];
    for (const [column, definition] of legacyColumns) {
      if (!(await queryRunner.hasColumn('retrieval_index_versions', column))) {
        await queryRunner.query(
          `ALTER TABLE retrieval_index_versions ADD COLUMN \`${column}\` ${definition}`,
        );
      }
    }
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
    if (
      await hasIndex(
        queryRunner,
        'retrieval_index_versions',
        'idx_retrieval_index_retention_debt',
      )
    ) {
      await queryRunner.query(
        `ALTER TABLE retrieval_index_versions
           DROP INDEX idx_retrieval_index_retention_debt`,
      );
    }
    for (const column of [
      'retention_debt_reason',
      'retention_debt_recorded_at',
    ]) {
      if (await queryRunner.hasColumn('retrieval_index_versions', column)) {
        await queryRunner.query(
          `ALTER TABLE retrieval_index_versions DROP COLUMN \`${column}\``,
        );
      }
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
