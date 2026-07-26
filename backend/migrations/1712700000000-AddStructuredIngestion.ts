import { MigrationInterface, QueryRunner } from 'typeorm';
import { findApplicationSchemaContractViolations } from './support/application-schema-contract';

export class AddStructuredIngestion1712700000000 implements MigrationInterface {
  name = 'AddStructuredIngestion1712700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addColumn(
      queryRunner,
      'source_files',
      'checksum_sha256',
      'CHAR(64) NULL AFTER file_path',
    );
    await addColumn(
      queryRunner,
      'source_files',
      'active_ingestion_key',
      'CHAR(64) NULL AFTER checksum_sha256',
    );
    await addColumn(
      queryRunner,
      'source_files',
      'parse_generation',
      'INT NOT NULL DEFAULT 1 AFTER active_ingestion_key',
    );
    await addColumn(
      queryRunner,
      'source_files',
      'parse_attempt_token',
      'CHAR(36) NULL AFTER parse_generation',
    );
    await addColumn(
      queryRunner,
      'source_files',
      'parse_lease_expires_at',
      'DATETIME(6) NULL AFTER parse_attempt_token',
    );
    await addColumn(
      queryRunner,
      'file_upload_outbox',
      'parse_generation',
      'INT NOT NULL DEFAULT 1 AFTER project_id',
    );
    await queryRunner.query(`
      ALTER TABLE source_files
        MODIFY COLUMN checksum_sha256 CHAR(64) NULL,
        MODIFY COLUMN active_ingestion_key CHAR(64) NULL,
        MODIFY COLUMN parse_generation INT NOT NULL DEFAULT 1,
        MODIFY COLUMN parse_attempt_token CHAR(36) NULL,
        MODIFY COLUMN parse_lease_expires_at DATETIME(6) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE file_upload_outbox
        MODIFY COLUMN parse_generation INT NOT NULL DEFAULT 1
    `);

    await addColumn(
      queryRunner,
      'documents',
      'source_checksum',
      'CHAR(64) NULL AFTER sections',
    );
    await addColumn(
      queryRunner,
      'documents',
      'parser_version',
      'VARCHAR(50) NULL AFTER source_checksum',
    );
    await addColumn(
      queryRunner,
      'documents',
      'chunk_version',
      'VARCHAR(50) NULL AFTER parser_version',
    );
    await addColumn(
      queryRunner,
      'documents',
      'ingestion_key',
      'CHAR(64) NULL AFTER chunk_version',
    );
    await addColumn(
      queryRunner,
      'documents',
      'ast',
      'JSON NULL AFTER ingestion_key',
    );
    await addColumn(
      queryRunner,
      'documents',
      'is_active',
      'TINYINT(1) NOT NULL DEFAULT 0 AFTER ast',
    );
    await ensureGeneratedColumn(
      queryRunner,
      'documents',
      'active_marker',
      `TINYINT GENERATED ALWAYS AS (
         CASE WHEN is_active = 1 THEN 1 ELSE NULL END
       ) STORED AFTER is_active`,
      'case when is_active = 1 then 1 else null end',
      ['uq_documents_file_active'],
    );

    await queryRunner.query(`
      UPDATE documents d
      LEFT JOIN source_files f ON f.id = d.file_id
         SET d.source_checksum = COALESCE(
               d.source_checksum,
               f.checksum_sha256,
               SHA2(CONCAT('legacy-source:', d.file_id), 256)
             ),
             d.parser_version = COALESCE(
               NULLIF(d.parser_version, ''),
               'legacy-flat-1'
             ),
             d.chunk_version = COALESCE(
               NULLIF(d.chunk_version, ''),
               'legacy-char-v1'
             ),
             d.ingestion_key = COALESCE(
               d.ingestion_key,
               SHA2(CONCAT('legacy-ingestion:', d.id), 256)
             ),
             d.ast = COALESCE(
               d.ast,
               JSON_OBJECT(
                 'version', 'document-ast-v1',
                 'location', JSON_OBJECT(
                   'kind', 'none',
                   'status', 'degraded',
                   'reason', 'legacy_flat_document'
                 ),
                 'blocks', JSON_ARRAY()
               )
             )
    `);
    await queryRunner.query(`
      UPDATE documents d
      JOIN (
        SELECT file_id, SUBSTRING_INDEX(
          GROUP_CONCAT(
            id ORDER BY parsed_at DESC, id DESC SEPARATOR ','
          ),
          ',',
          1
        ) AS active_id
          FROM documents
         GROUP BY file_id
      ) latest ON latest.file_id = d.file_id
         SET d.is_active = (d.id = latest.active_id)
    `);
    await queryRunner.query(`
      UPDATE source_files f
      LEFT JOIN documents d
        ON d.file_id = f.id
       AND d.is_active = 1
         SET f.active_ingestion_key = d.ingestion_key
    `);
    await queryRunner.query(`
      ALTER TABLE documents
        MODIFY COLUMN source_checksum CHAR(64) NOT NULL,
        MODIFY COLUMN parser_version VARCHAR(50) NOT NULL,
        MODIFY COLUMN chunk_version VARCHAR(50) NOT NULL,
        MODIFY COLUMN ingestion_key CHAR(64) NOT NULL,
        MODIFY COLUMN ast JSON NOT NULL,
        MODIFY COLUMN is_active TINYINT(1) NOT NULL DEFAULT 0
    `);

    await addColumn(
      queryRunner,
      'chunks',
      'stable_key',
      'CHAR(64) NULL AFTER search_terms',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'ingestion_key',
      'CHAR(64) NULL AFTER stable_key',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'chunk_type',
      "VARCHAR(20) NOT NULL DEFAULT 'child' AFTER ingestion_key",
    );
    await addColumn(
      queryRunner,
      'chunks',
      'parent_id',
      'VARCHAR(36) NULL AFTER chunk_type',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'position',
      'INT NOT NULL DEFAULT 0 AFTER parent_id',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'token_count',
      'INT NOT NULL DEFAULT 0 AFTER position',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'tokenizer_version',
      "VARCHAR(50) NOT NULL DEFAULT 'legacy-char-v1' AFTER token_count",
    );
    await addColumn(
      queryRunner,
      'chunks',
      'overlap_previous_tokens',
      'INT NOT NULL DEFAULT 0 AFTER tokenizer_version',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'heading_path',
      'JSON NULL AFTER overlap_previous_tokens',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'page_start',
      'INT NULL AFTER heading_path',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'page_end',
      'INT NULL AFTER page_start',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'block_ids',
      'JSON NULL AFTER page_end',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'char_start',
      'INT NULL AFTER block_ids',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'char_end',
      'INT NULL AFTER char_start',
    );
    await addColumn(
      queryRunner,
      'chunks',
      'is_active',
      'TINYINT(1) NOT NULL DEFAULT 1 AFTER char_end',
    );

    await queryRunner.query(`
      UPDATE chunks c
      JOIN documents d ON d.id = c.document_id
         SET c.stable_key = COALESCE(
               c.stable_key,
               SHA2(CONCAT('legacy-chunk:', c.id), 256)
             ),
             c.ingestion_key = COALESCE(c.ingestion_key, d.ingestion_key),
             c.chunk_type = COALESCE(NULLIF(c.chunk_type, ''), 'child'),
             c.position = c.chunk_index,
             c.token_count = CASE
               WHEN c.token_count > 0 THEN c.token_count
               ELSE CHAR_LENGTH(c.content)
             END,
             c.tokenizer_version = COALESCE(
               NULLIF(c.tokenizer_version, ''),
               'legacy-char-v1'
             ),
             c.heading_path = COALESCE(
               c.heading_path,
               CASE
                 WHEN c.section_title IS NULL THEN JSON_ARRAY()
                 ELSE JSON_ARRAY(c.section_title)
               END
             ),
             c.page_start = COALESCE(c.page_start, c.page_number),
             c.page_end = COALESCE(c.page_end, c.page_number),
             c.block_ids = COALESCE(c.block_ids, JSON_ARRAY()),
             c.is_active = d.is_active
    `);
    await queryRunner.query(`
      ALTER TABLE chunks
        MODIFY COLUMN stable_key CHAR(64) NULL,
        MODIFY COLUMN ingestion_key CHAR(64) NULL,
        MODIFY COLUMN chunk_type VARCHAR(20) NOT NULL DEFAULT 'child',
        MODIFY COLUMN parent_id VARCHAR(36) NULL,
        MODIFY COLUMN position INT NOT NULL DEFAULT 0,
        MODIFY COLUMN token_count INT NOT NULL DEFAULT 0,
        MODIFY COLUMN tokenizer_version VARCHAR(50) NOT NULL
          DEFAULT 'legacy-char-v1',
        MODIFY COLUMN overlap_previous_tokens INT NOT NULL DEFAULT 0,
        MODIFY COLUMN heading_path JSON NULL,
        MODIFY COLUMN page_start INT NULL,
        MODIFY COLUMN page_end INT NULL,
        MODIFY COLUMN block_ids JSON NULL,
        MODIFY COLUMN char_start INT NULL,
        MODIFY COLUMN char_end INT NULL,
        MODIFY COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1
    `);

    await ensureIndex(
      queryRunner,
      'source_files',
      'idx_source_files_checksum',
      '(checksum_sha256)',
    );
    await ensureIndex(
      queryRunner,
      'documents',
      'uq_documents_file_ingestion',
      '(file_id, ingestion_key)',
      true,
    );
    await ensureIndex(
      queryRunner,
      'documents',
      'uq_documents_file_active',
      '(file_id, active_marker)',
      true,
    );
    await ensureIndex(
      queryRunner,
      'documents',
      'idx_documents_project_active',
      '(project_id, is_active)',
    );
    await ensureIndex(
      queryRunner,
      'chunks',
      'uq_chunks_document_stable_key',
      '(document_id, stable_key)',
      true,
    );
    await ensureIndex(
      queryRunner,
      'chunks',
      'idx_chunks_active_children',
      '(project_id, is_active, chunk_type)',
    );
    await ensureIndex(
      queryRunner,
      'chunks',
      'idx_chunks_parent_id',
      '(parent_id)',
    );
    await ensureForeignKey(
      queryRunner,
      'chunks',
      'chunks_parent_id_fkey',
      ['parent_id'],
      'chunks',
      ['id'],
      'SET NULL',
      'NO ACTION',
    );

    const violations =
      await findApplicationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `Structured ingestion schema did not converge: ${violations.join(
          ', ',
        )}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropForeignKey(queryRunner, 'chunks', 'chunks_parent_id_fkey');
    for (const [table, index] of [
      ['chunks', 'idx_chunks_parent_id'],
      ['chunks', 'idx_chunks_active_children'],
      ['chunks', 'uq_chunks_document_stable_key'],
      ['documents', 'idx_documents_project_active'],
      ['documents', 'uq_documents_file_active'],
      ['documents', 'uq_documents_file_ingestion'],
      ['source_files', 'idx_source_files_checksum'],
    ] as const) {
      await dropIndex(queryRunner, table, index);
    }
    for (const column of [
      'is_active',
      'char_end',
      'char_start',
      'block_ids',
      'page_end',
      'page_start',
      'heading_path',
      'overlap_previous_tokens',
      'tokenizer_version',
      'token_count',
      'position',
      'parent_id',
      'chunk_type',
      'ingestion_key',
      'stable_key',
    ]) {
      await dropColumn(queryRunner, 'chunks', column);
    }
    for (const column of [
      'active_marker',
      'is_active',
      'ast',
      'ingestion_key',
      'chunk_version',
      'parser_version',
      'source_checksum',
    ]) {
      await dropColumn(queryRunner, 'documents', column);
    }
    await dropColumn(queryRunner, 'file_upload_outbox', 'parse_generation');
    await dropColumn(queryRunner, 'source_files', 'parse_lease_expires_at');
    await dropColumn(queryRunner, 'source_files', 'parse_attempt_token');
    await dropColumn(queryRunner, 'source_files', 'parse_generation');
    await dropColumn(queryRunner, 'source_files', 'active_ingestion_key');
    await dropColumn(queryRunner, 'source_files', 'checksum_sha256');
  }
}

async function addColumn(
  runner: QueryRunner,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (await columnExists(runner, table, column)) return;
  await runner.query(
    `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
  );
}

async function ensureGeneratedColumn(
  runner: QueryRunner,
  table: string,
  column: string,
  definition: string,
  expectedExpression: string,
  dependentIndexes: readonly string[],
): Promise<void> {
  const rows: unknown = await runner.query(
    `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
            EXTRA AS extra, GENERATION_EXPRESSION AS expression
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column],
  );
  const row =
    Array.isArray(rows) && rows.length > 0
      ? (rows[0] as {
          columnType: string;
          nullable: string;
          extra: string;
          expression: string;
        })
      : undefined;
  const matches =
    row?.columnType.toLowerCase() === 'tinyint' &&
    row.nullable === 'YES' &&
    row.extra.toUpperCase().includes('STORED GENERATED') &&
    normalizeSql(row.expression) === normalizeSql(expectedExpression);
  if (matches) return;
  if (row) {
    for (const index of dependentIndexes) {
      await dropIndex(runner, table, index);
    }
    await dropColumn(runner, table, column);
  }
  await addColumn(runner, table, column, definition);
}

async function dropColumn(
  runner: QueryRunner,
  table: string,
  column: string,
): Promise<void> {
  if (!(await columnExists(runner, table, column))) return;
  await runner.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
}

async function ensureIndex(
  runner: QueryRunner,
  table: string,
  name: string,
  definition: string,
  unique = false,
): Promise<void> {
  const expectedColumns = definition
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((column) => column.trim().replaceAll('`', ''));
  const rows: unknown = await runner.query(
    `SELECT NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType,
            SEQ_IN_INDEX AS position, COLUMN_NAME AS columnName,
            EXPRESSION AS expression, SUB_PART AS prefixLength
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [table, name],
  );
  const indexRows = Array.isArray(rows)
    ? (rows as Array<{
        nonUnique: number | string;
        indexType: string;
        position: number | string;
        columnName: string | null;
        expression: string | null;
        prefixLength: number | null;
      }>)
    : [];
  const matches =
    indexRows.length === expectedColumns.length &&
    indexRows.every(
      (row, index) =>
        Number(row.nonUnique) === (unique ? 0 : 1) &&
        row.indexType.toUpperCase() === 'BTREE' &&
        Number(row.position) === index + 1 &&
        row.columnName === expectedColumns[index] &&
        row.expression === null &&
        row.prefixLength === null,
    );
  if (matches) return;
  if (indexRows.length > 0) await dropIndex(runner, table, name);
  await runner.query(
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\`
       ON \`${table}\` ${definition}`,
  );
}

async function dropIndex(
  runner: QueryRunner,
  table: string,
  name: string,
): Promise<void> {
  if (!(await indexExists(runner, table, name))) return;
  await runner.query(`DROP INDEX \`${name}\` ON \`${table}\``);
}

async function ensureForeignKey(
  runner: QueryRunner,
  table: string,
  name: string,
  columns: readonly string[],
  referencedTable: string,
  referencedColumns: readonly string[],
  deleteRule: string,
  updateRule: string,
): Promise<void> {
  const rows: unknown = await runner.query(
    `SELECT kcu.ORDINAL_POSITION AS position,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_NAME AS referencedTable,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumn,
            rc.DELETE_RULE AS deleteRule,
            rc.UPDATE_RULE AS updateRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = ?
        AND kcu.CONSTRAINT_NAME = ?
      ORDER BY kcu.ORDINAL_POSITION`,
    [table, name],
  );
  const foreignRows = Array.isArray(rows)
    ? (rows as Array<{
        position: number | string;
        columnName: string;
        referencedTable: string;
        referencedColumn: string;
        deleteRule: string;
        updateRule: string;
      }>)
    : [];
  const matches =
    foreignRows.length === columns.length &&
    foreignRows.every(
      (row, index) =>
        Number(row.position) === index + 1 &&
        row.columnName === columns[index] &&
        row.referencedTable === referencedTable &&
        row.referencedColumn === referencedColumns[index] &&
        row.deleteRule.toUpperCase() === deleteRule.toUpperCase() &&
        row.updateRule.toUpperCase() === updateRule.toUpperCase(),
    );
  if (matches) return;
  if (foreignRows.length > 0) await dropForeignKey(runner, table, name);
  await runner.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\`
       FOREIGN KEY (${columns.map(quoteIdentifier).join(', ')})
       REFERENCES \`${referencedTable}\`
         (${referencedColumns.map(quoteIdentifier).join(', ')})
       ON DELETE ${deleteRule} ON UPDATE ${updateRule}`,
  );
}

async function dropForeignKey(
  runner: QueryRunner,
  table: string,
  name: string,
): Promise<void> {
  if (!(await foreignKeyExists(runner, table, name))) return;
  await runner.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${name}\``);
}

async function columnExists(
  runner: QueryRunner,
  table: string,
  column: string,
): Promise<boolean> {
  const rows: unknown = await runner.query(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function indexExists(
  runner: QueryRunner,
  table: string,
  name: string,
): Promise<boolean> {
  const rows: unknown = await runner.query(
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [table, name],
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function foreignKeyExists(
  runner: QueryRunner,
  table: string,
  name: string,
): Promise<boolean> {
  const rows: unknown = await runner.query(
    `SELECT 1
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
      LIMIT 1`,
    [table, name],
  );
  return Array.isArray(rows) && rows.length > 0;
}

function normalizeSql(value: string): string {
  return value
    .replaceAll('`', '')
    .replace(/\s+/g, '')
    .replace(/^\((.*)\)$/s, '$1')
    .toLowerCase();
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}
