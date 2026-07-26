import { MigrationInterface, QueryRunner } from 'typeorm';

export class UseDatabaseClockForFileUploadLeases1712070000000 implements MigrationInterface {
  name = 'UseDatabaseClockForFileUploadLeases1712070000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE file_upload_outbox
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_cleanup_records
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_move_intents
      MODIFY COLUMN recover_after DATETIME(6) NOT NULL,
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE file_move_intents
      MODIFY COLUMN recover_after DATETIME(3) NOT NULL,
      MODIFY COLUMN lease_expires_at DATETIME(3) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    await queryRunner.query(`ALTER TABLE file_cleanup_records
      MODIFY COLUMN lease_expires_at DATETIME(3) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
    await queryRunner.query(`ALTER TABLE file_upload_outbox
      MODIFY COLUMN lease_expires_at DATETIME(3) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`);
  }
}
