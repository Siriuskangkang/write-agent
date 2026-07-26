import type { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenGroundingWorkflow1713310000000 implements MigrationInterface {
  name = 'HardenGroundingWorkflow1713310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn('grounding_assignments', 'snapshot_digest'))
    ) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          ADD COLUMN snapshot_digest CHAR(64) NULL AFTER evidence_ids
      `);
    }
    if (!(await queryRunner.hasColumn('citation_maps', 'snapshot_digest'))) {
      await queryRunner.query(`
        ALTER TABLE citation_maps
          ADD COLUMN snapshot_digest CHAR(64) NULL AFTER index_snapshot
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('citation_maps', 'snapshot_digest')) {
      await queryRunner.query(`
        ALTER TABLE citation_maps
          DROP COLUMN snapshot_digest
      `);
    }
    if (
      await queryRunner.hasColumn('grounding_assignments', 'snapshot_digest')
    ) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          DROP COLUMN snapshot_digest
      `);
    }
  }
}
