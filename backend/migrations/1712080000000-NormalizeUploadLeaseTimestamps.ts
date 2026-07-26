import { MigrationInterface, QueryRunner } from 'typeorm';

const UNCERTAIN_COMMIT_GRACE_SECONDS = 5 * 60;

export class NormalizeUploadLeaseTimestamps1712080000000 implements MigrationInterface {
  name = 'NormalizeUploadLeaseTimestamps1712080000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE file_upload_outbox
      SET lease_owner = NULL,
          lease_expires_at = NULL`);
    await queryRunner.query(`UPDATE file_upload_outbox
      SET next_attempt_at = CURRENT_TIMESTAMP(6)
      WHERE status = 'pending'`);

    await queryRunner.query(`UPDATE file_cleanup_records
      SET lease_owner = NULL,
          lease_expires_at = NULL`);
    await queryRunner.query(`UPDATE file_cleanup_records
      SET next_attempt_at = CURRENT_TIMESTAMP(6)
      WHERE status = 'pending'`);

    await queryRunner.query(`UPDATE file_move_intents
      SET lease_owner = NULL,
          lease_expires_at = NULL`);
    await queryRunner.query(`UPDATE file_move_intents
      SET last_error = CASE
            WHEN status = 'ACTIVE'
              THEN CONCAT(
                COALESCE(CONCAT(last_error, '; '), ''),
                'Lease state normalized during TIMESTAMP migration; delayed reconciliation required'
              )
            ELSE last_error
          END,
          status = 'UNCERTAIN',
          recover_after = DATE_ADD(
            CURRENT_TIMESTAMP(6),
            INTERVAL ${UNCERTAIN_COMMIT_GRACE_SECONDS} SECOND
          ),
          next_attempt_at = DATE_ADD(
            CURRENT_TIMESTAMP(6),
            INTERVAL ${UNCERTAIN_COMMIT_GRACE_SECONDS} SECOND
          )
      WHERE status IN ('ACTIVE', 'UNCERTAIN')`);

    await queryRunner.query(`ALTER TABLE file_upload_outbox
      MODIFY COLUMN lease_expires_at TIMESTAMP(6) NULL DEFAULT NULL,
      MODIFY COLUMN next_attempt_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_cleanup_records
      MODIFY COLUMN lease_expires_at TIMESTAMP(6) NULL DEFAULT NULL,
      MODIFY COLUMN next_attempt_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_move_intents
      MODIFY COLUMN recover_after TIMESTAMP(6) NOT NULL,
      MODIFY COLUMN lease_expires_at TIMESTAMP(6) NULL DEFAULT NULL,
      MODIFY COLUMN next_attempt_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE file_move_intents
      MODIFY COLUMN recover_after DATETIME(6) NOT NULL,
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_cleanup_records
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
    await queryRunner.query(`ALTER TABLE file_upload_outbox
      MODIFY COLUMN lease_expires_at DATETIME(6) NULL,
      MODIFY COLUMN next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)`);
  }
}
