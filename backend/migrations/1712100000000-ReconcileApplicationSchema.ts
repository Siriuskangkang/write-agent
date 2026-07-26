import { MigrationInterface, QueryRunner } from 'typeorm';
import { InitSchema1710700000000 } from './1710700000000-InitSchema';
import { AddSectionNodeIdToOutlineVersions1710800000000 } from './1710800000000-AddSectionNodeIdToOutlineVersions';
import { CreateStyleTemplates1711800000000 } from './1711800000000-CreateStyleTemplates';
import { FixCitationMapsCascade1712000000000 } from './1712000000000-FixCitationMapsCascade';
import { CreateFileUploadReliabilityTables1712050000000 } from './1712050000000-CreateFileUploadReliabilityTables';
import { HardenFileUploadLeases1712060000000 } from './1712060000000-HardenFileUploadLeases';
import { UseDatabaseClockForFileUploadLeases1712070000000 } from './1712070000000-UseDatabaseClockForFileUploadLeases';
import { NormalizeUploadLeaseTimestamps1712080000000 } from './1712080000000-NormalizeUploadLeaseTimestamps';
import {
  APPLICATION_TABLES,
  findApplicationSchemaContractViolations,
  isPreservedAuthenticationSchemaViolation,
} from './support/application-schema-contract';

export class ReconcileApplicationSchema1712100000000 implements MigrationInterface {
  name = 'ReconcileApplicationSchema1712100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const existingTables = await this.getExistingBusinessTables(queryRunner);
    const rowCounts: Array<readonly [table: string, count: number]> = [];

    for (const table of existingTables) {
      const rows: unknown = await queryRunner.query(
        `SELECT COUNT(*) AS rowCount FROM \`${table}\``,
      );
      const rawCount =
        Array.isArray(rows) && rows.length > 0
          ? (rows[0] as { rowCount?: unknown }).rowCount
          : undefined;
      rowCounts.push([table, Number(rawCount ?? 0)]);
    }

    const nonEmpty = rowCounts.filter(([, count]) => count > 0);
    if (nonEmpty.length > 0) {
      throw new Error(
        `Cannot reconcile application schema because business tables are not empty: ${nonEmpty
          .map(([table, count]) => `${table}=${count}`)
          .join(', ')}`,
      );
    }

    await this.reconcilePreservedAuthenticationTimestampNullability(
      queryRunner,
    );

    const initialViolations =
      await findApplicationSchemaContractViolations(queryRunner);
    const authenticationViolations = initialViolations.filter(
      isPreservedAuthenticationSchemaViolation,
    );
    if (authenticationViolations.length > 0) {
      throw new Error(
        `Cannot reconcile preserved authentication schema safely: ${authenticationViolations.join(
          ', ',
        )}`,
      );
    }

    if (initialViolations.length === 0) {
      return;
    }

    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 0`);
    try {
      for (const table of APPLICATION_TABLES) {
        await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
      }
    } finally {
      await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 1`);
    }

    await new InitSchema1710700000000().up(queryRunner);
    await new AddSectionNodeIdToOutlineVersions1710800000000().up(queryRunner);
    await new CreateStyleTemplates1711800000000().up(queryRunner);
    await new FixCitationMapsCascade1712000000000().up(queryRunner);
    await new CreateFileUploadReliabilityTables1712050000000().up(queryRunner);
    await new HardenFileUploadLeases1712060000000().up(queryRunner);
    await new UseDatabaseClockForFileUploadLeases1712070000000().up(
      queryRunner,
    );
    await new NormalizeUploadLeaseTimestamps1712080000000().up(queryRunner);

    for (const table of APPLICATION_TABLES) {
      await queryRunner.query(
        `ALTER TABLE \`${table}\`
         ENGINE=InnoDB,
         CONVERT TO CHARACTER SET utf8mb4
         COLLATE utf8mb4_0900_ai_ci`,
      );
    }

    const violations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Application schema reconciliation did not converge: ${violations.join(
          ', ',
        )}`,
      );
    }
  }

  down(): Promise<never> {
    return Promise.reject(
      new Error(
        'ReconcileApplicationSchema1712100000000 cannot be reversed safely',
      ),
    );
  }

  private async getExistingBusinessTables(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: unknown = await queryRunner.query(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN (${APPLICATION_TABLES.map(() => '?').join(', ')})`,
      [...APPLICATION_TABLES],
    );
    if (!Array.isArray(rows)) return [];
    const existing = new Set(
      rows.flatMap((row) => {
        const tableName = (row as { tableName?: unknown }).tableName;
        return typeof tableName === 'string' ? [tableName] : [];
      }),
    );
    return APPLICATION_TABLES.filter((table) => existing.has(table));
  }

  private async reconcilePreservedAuthenticationTimestampNullability(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const rows: unknown = await queryRunner.query(
      `SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE()
          AND IS_NULLABLE='YES'
          AND (
            (TABLE_NAME='users'
              AND COLUMN_NAME IN ('created_at','updated_at'))
            OR (TABLE_NAME='refresh_tokens'
              AND COLUMN_NAME='created_at')
            OR (TABLE_NAME='user_settings'
              AND COLUMN_NAME IN ('created_at','updated_at'))
          )`,
    );
    if (!Array.isArray(rows) || rows.length === 0) return;

    const nullable = new Set(
      rows.map((row) => {
        const value = row as Record<string, unknown>;
        return `${String(value.tableName)}.${String(value.columnName)}`;
      }),
    );
    const repairs = [
      {
        table: 'users',
        columns: ['created_at', 'updated_at'],
        sql: `ALTER TABLE users
                MODIFY created_at DATETIME NOT NULL
                  DEFAULT CURRENT_TIMESTAMP,
                MODIFY updated_at DATETIME NOT NULL
                  DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP`,
      },
      {
        table: 'refresh_tokens',
        columns: ['created_at'],
        sql: `ALTER TABLE refresh_tokens
                MODIFY created_at DATETIME NOT NULL
                  DEFAULT CURRENT_TIMESTAMP`,
      },
      {
        table: 'user_settings',
        columns: ['created_at', 'updated_at'],
        sql: `ALTER TABLE user_settings
                MODIFY created_at DATETIME NOT NULL
                  DEFAULT CURRENT_TIMESTAMP,
                MODIFY updated_at DATETIME NOT NULL
                  DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP`,
      },
    ] as const;

    for (const repair of repairs) {
      const columns = repair.columns.filter((column) =>
        nullable.has(`${repair.table}.${column}`),
      );
      if (columns.length === 0) continue;
      const nullRows: unknown = await queryRunner.query(
        `SELECT COUNT(*) AS rowCount
           FROM \`${repair.table}\`
          WHERE ${columns.map((column) => `\`${column}\` IS NULL`).join(' OR ')}`,
      );
      const rawCount =
        Array.isArray(nullRows) && nullRows.length === 1
          ? (nullRows[0] as { rowCount?: unknown }).rowCount
          : undefined;
      if (Number(rawCount ?? -1) !== 0) {
        throw new Error(
          `Cannot reconcile preserved authentication timestamps with NULL data: ${repair.table}.${columns.join(',')}`,
        );
      }
      await queryRunner.query(repair.sql);
    }
  }
}
