import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixCitationMapsCascade1712000000000 implements MigrationInterface {
  name = 'FixCitationMapsCascade1712000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.ensureCascade(
      queryRunner,
      'chunk_id',
      'chunks',
      'citation_maps_chunk_id_fkey',
    );
    await this.ensureCascade(
      queryRunner,
      'file_id',
      'source_files',
      'citation_maps_file_id_fkey',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Revert to no CASCADE
    await queryRunner.query(
      `ALTER TABLE citation_maps DROP FOREIGN KEY citation_maps_chunk_id_fkey`,
    );
    await queryRunner.query(
      `ALTER TABLE citation_maps ADD CONSTRAINT citation_maps_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunks(id)`,
    );

    await queryRunner.query(
      `ALTER TABLE citation_maps DROP FOREIGN KEY citation_maps_file_id_fkey`,
    );
    await queryRunner.query(
      `ALTER TABLE citation_maps ADD CONSTRAINT citation_maps_file_id_fkey FOREIGN KEY (file_id) REFERENCES source_files(id)`,
    );
  }

  private async ensureCascade(
    queryRunner: QueryRunner,
    column: string,
    referencedTable: string,
    constraintName: string,
  ): Promise<void> {
    const rows: unknown = await queryRunner.query(
      `SELECT kcu.CONSTRAINT_NAME AS constraintName,
              rc.DELETE_RULE AS deleteRule
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.TABLE_NAME = 'citation_maps'
          AND kcu.COLUMN_NAME = ?
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        LIMIT 1`,
      [column],
    );
    const existing =
      Array.isArray(rows) && rows.length > 0
        ? (rows[0] as {
            constraintName?: unknown;
            deleteRule?: unknown;
          })
        : undefined;
    if (
      typeof existing?.deleteRule === 'string' &&
      existing.deleteRule.toUpperCase() === 'CASCADE'
    ) {
      return;
    }
    if (typeof existing?.constraintName === 'string') {
      await queryRunner.query(
        `ALTER TABLE citation_maps
         DROP FOREIGN KEY \`${existing.constraintName}\``,
      );
    }
    await queryRunner.query(`
      ALTER TABLE citation_maps
      ADD CONSTRAINT ${constraintName}
      FOREIGN KEY (${column}) REFERENCES ${referencedTable}(id)
      ON DELETE CASCADE
    `);
  }
}
