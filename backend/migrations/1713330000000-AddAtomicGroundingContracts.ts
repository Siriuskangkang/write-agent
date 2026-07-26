import type { MigrationInterface, QueryRunner } from 'typeorm';

const LEGACY_CONTRACT_VERSION = 'legacy:v0';
const ATOMIC_CONTRACT_VERSION = 'atomic:v1';

export class AddAtomicGroundingContracts1713330000000
  implements MigrationInterface
{
  name = 'AddAtomicGroundingContracts1713330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'grounding_assignments',
        'contract_version',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          ADD COLUMN contract_version VARCHAR(32) NULL DEFAULT 'legacy:v0'
      `);
    }
    await queryRunner.query(`
      UPDATE grounding_assignments
         SET contract_version = 'legacy:v0'
       WHERE contract_version IS NULL
    `);
    const unknownContracts: unknown = await queryRunner.query(
      `SELECT contract_version
         FROM grounding_assignments
        WHERE contract_version NOT IN (?, ?)
        LIMIT 1`,
      [LEGACY_CONTRACT_VERSION, ATOMIC_CONTRACT_VERSION],
    );
    if (Array.isArray(unknownContracts) && unknownContracts.length > 0) {
      throw new Error('ATOMIC_GROUNDING_UNKNOWN_CONTRACT_VERSION');
    }
    await queryRunner.query(`
      ALTER TABLE grounding_assignments
        MODIFY contract_version VARCHAR(32) NOT NULL DEFAULT 'legacy:v0'
    `);
    if (!(await queryRunner.hasColumn('grounding_claims', 'atomic_claim'))) {
      await queryRunner.query(`
        ALTER TABLE grounding_claims
          ADD COLUMN atomic_claim JSON NULL
      `);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error('ATOMIC_GROUNDING_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
  }
}
