import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFileUploadReliabilityTables1712050000000 implements MigrationInterface {
  name = 'CreateFileUploadReliabilityTables1712050000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS file_upload_outbox (
      id VARCHAR(36) NOT NULL DEFAULT (UUID()), file_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL, job_id VARCHAR(100) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_file_upload_outbox_file (file_id),
      UNIQUE KEY uq_file_upload_outbox_job (job_id),
      KEY idx_file_upload_outbox_status (status),
      CONSTRAINT file_upload_outbox_file_fkey FOREIGN KEY (file_id) REFERENCES source_files(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS file_cleanup_records (
      id VARCHAR(36) NOT NULL DEFAULT (UUID()), file_path VARCHAR(1000) NOT NULL,
      reason TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0, last_error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id),
      KEY idx_file_cleanup_records_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS file_cleanup_records');
    await queryRunner.query('DROP TABLE IF EXISTS file_upload_outbox');
  }
}
