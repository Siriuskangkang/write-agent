import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGroundingRevisionRunRefs1713320000000 implements MigrationInterface {
  name = 'AddGroundingRevisionRunRefs1713320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'grounding_assignments',
        'retrieval_run_refs',
      ))
    ) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          ADD COLUMN retrieval_run_refs JSON NULL AFTER retrieval_state
      `);
    }
    await queryRunner.query(`
      UPDATE grounding_assignments
         SET retrieval_run_refs = JSON_ARRAY(retrieval_run_id)
       WHERE retrieval_run_refs IS NULL
    `);
    const table = await queryRunner.getTable('grounding_assignments');
    const column = table?.findColumnByName('retrieval_run_refs');
    if (column?.isNullable !== false) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          MODIFY retrieval_run_refs JSON NOT NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (
      await queryRunner.hasColumn('grounding_assignments', 'retrieval_run_refs')
    ) {
      await queryRunner.query(`
        ALTER TABLE grounding_assignments
          DROP COLUMN retrieval_run_refs
      `);
    }
  }
}
