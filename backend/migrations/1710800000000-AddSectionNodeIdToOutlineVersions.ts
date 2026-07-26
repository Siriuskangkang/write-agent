import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSectionNodeIdToOutlineVersions1710800000000 implements MigrationInterface {
  name = 'AddSectionNodeIdToOutlineVersions1710800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('outline_versions', 'section_node_id'))) {
      await queryRunner.query(`
        ALTER TABLE outline_versions
        ADD COLUMN section_node_id VARCHAR(100) DEFAULT NULL
      `);
    }

    if (
      await this.hasIndex(
        queryRunner,
        'uq_outline_versions_project_chapter_current',
      )
    ) {
      await queryRunner.query(`
        DROP INDEX uq_outline_versions_project_chapter_current ON outline_versions
      `);
    }
    if (
      await this.hasIndex(queryRunner, 'idx_outline_versions_project_chapter')
    ) {
      await queryRunner.query(`
        DROP INDEX idx_outline_versions_project_chapter ON outline_versions
      `);
    }

    if (
      !(await this.hasIndex(
        queryRunner,
        'idx_outline_versions_project_chapter_section',
      ))
    ) {
      await queryRunner.query(`
        CREATE INDEX idx_outline_versions_project_chapter_section
        ON outline_versions(project_id, chapter_node_id, section_node_id)
      `);
    }
  }

  public async down(): Promise<void> {
    throw new Error(
      'AddSectionNodeIdToOutlineVersions1710800000000 cannot be reversed safely because InitSchema owns the current section scope columns',
    );
  }

  private async hasIndex(
    queryRunner: QueryRunner,
    indexName: string,
  ): Promise<boolean> {
    const rows: unknown = await queryRunner.query(
      `SELECT 1
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'outline_versions'
          AND INDEX_NAME = ?
        LIMIT 1`,
      [indexName],
    );
    return Array.isArray(rows) && rows.length > 0;
  }
}
