import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenFileUploadLeases1712060000000 implements MigrationInterface {
  name = 'HardenFileUploadLeases1712060000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE file_upload_outbox
      ADD COLUMN lease_owner VARCHAR(100) NULL AFTER last_error,
      ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER lease_owner,
      ADD COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER lease_expires_at,
      DROP INDEX idx_file_upload_outbox_status,
      ADD INDEX idx_file_upload_outbox_claim (status, next_attempt_at, lease_expires_at)`);

    await queryRunner.query(`ALTER TABLE file_cleanup_records
      ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending' AFTER reason,
      ADD COLUMN lease_owner VARCHAR(100) NULL AFTER last_error,
      ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER lease_owner,
      ADD COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER lease_expires_at,
      DROP INDEX idx_file_cleanup_records_created,
      ADD INDEX idx_file_cleanup_records_claim (status, next_attempt_at, lease_expires_at)`);

    await queryRunner.query(`CREATE TABLE file_move_intents (
      id VARCHAR(36) NOT NULL DEFAULT (UUID()),
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      source_path VARCHAR(1000) NOT NULL,
      destination_path VARCHAR(1000) NOT NULL,
      file_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      file_size BIGINT NOT NULL,
      writer_token VARCHAR(100) NOT NULL,
      recover_after DATETIME(3) NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      lease_owner VARCHAR(100) NULL,
      lease_expires_at DATETIME(3) NULL,
      next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_file_move_intents_file (file_id),
      KEY idx_file_move_intents_claim (
        status, recover_after, next_attempt_at, lease_expires_at
      )
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS file_move_intents');

    await queryRunner.query(`ALTER TABLE file_cleanup_records
      DROP INDEX idx_file_cleanup_records_claim,
      ADD INDEX idx_file_cleanup_records_created (created_at),
      DROP COLUMN next_attempt_at,
      DROP COLUMN lease_expires_at,
      DROP COLUMN lease_owner,
      DROP COLUMN status`);

    await queryRunner.query(`ALTER TABLE file_upload_outbox
      DROP INDEX idx_file_upload_outbox_claim,
      ADD INDEX idx_file_upload_outbox_status (status),
      DROP COLUMN next_attempt_at,
      DROP COLUMN lease_expires_at,
      DROP COLUMN lease_owner`);
  }
}
