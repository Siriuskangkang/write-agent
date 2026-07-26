import { MigrationInterface, QueryRunner } from 'typeorm';
import { findApplicationSchemaContractViolations } from './support/application-schema-contract';

export class AddParseAttemptLeases1712800000000 implements MigrationInterface {
  name = 'AddParseAttemptLeases1712800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('source_files', 'parse_attempt_token'))) {
      await queryRunner.query(`
        ALTER TABLE source_files
          ADD COLUMN parse_attempt_token CHAR(36) NULL
            AFTER parse_generation
      `);
    }
    if (
      !(await queryRunner.hasColumn('source_files', 'parse_lease_expires_at'))
    ) {
      await queryRunner.query(`
        ALTER TABLE source_files
          ADD COLUMN parse_lease_expires_at DATETIME(6) NULL
            AFTER parse_attempt_token
      `);
    }
    await queryRunner.query(`
      ALTER TABLE source_files
        MODIFY COLUMN parse_attempt_token CHAR(36) NULL,
        MODIFY COLUMN parse_lease_expires_at DATETIME(6) NULL
    `);

    const violations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Parse attempt lease schema did not converge: ${violations.join(', ')}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('source_files', 'parse_lease_expires_at')) {
      await queryRunner.query(
        'ALTER TABLE source_files DROP COLUMN parse_lease_expires_at',
      );
    }
    if (await queryRunner.hasColumn('source_files', 'parse_attempt_token')) {
      await queryRunner.query(
        'ALTER TABLE source_files DROP COLUMN parse_attempt_token',
      );
    }
  }
}
