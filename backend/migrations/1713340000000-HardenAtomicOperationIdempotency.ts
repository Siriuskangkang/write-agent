import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  ATOMIC_SCOPE_CHECK_EXPRESSION,
  findAtomicOperationSchemaContractViolations,
  isAtomicScopeCheckClause,
} from './support/atomic-operation-schema-contract';

const MODEL_OPERATION_INDEX = 'uq_model_runs_operation_key';
const RETRIEVAL_REVISION_INDEX = 'uq_retrieval_runs_workflow_revision';
const RETRIEVAL_WORKFLOW_FK = 'retrieval_runs_workflow_job_id_fkey';
const RETRIEVAL_SCOPE_CHECK = 'chk_retrieval_runs_atomic_revision_scope';
const CHARACTER_SET = 'utf8mb4';
const COLLATION = 'utf8mb4_0900_ai_ci';

interface ExpectedColumn {
  table: string;
  name: string;
  columnType: string;
  nullable: 'YES';
  characterSet: string | null;
  collation: string | null;
  after: string;
  ddl: string;
}

const COLUMNS: readonly ExpectedColumn[] = [
  {
    table: 'model_runs',
    name: 'operation_key',
    columnType: 'char(64)',
    nullable: 'YES',
    characterSet: CHARACTER_SET,
    collation: COLLATION,
    after: 'prompt_sha256',
    ddl: `CHAR(64) CHARACTER SET ${CHARACTER_SET} COLLATE ${COLLATION} NULL`,
  },
  {
    table: 'model_runs',
    name: 'request_fingerprint',
    columnType: 'char(64)',
    nullable: 'YES',
    characterSet: CHARACTER_SET,
    collation: COLLATION,
    after: 'operation_key',
    ddl: `CHAR(64) CHARACTER SET ${CHARACTER_SET} COLLATE ${COLLATION} NULL`,
  },
  {
    table: 'retrieval_runs',
    name: 'workflow_job_id',
    columnType: 'varchar(36)',
    nullable: 'YES',
    characterSet: CHARACTER_SET,
    collation: COLLATION,
    after: 'project_id',
    ddl: `VARCHAR(36) CHARACTER SET ${CHARACTER_SET} COLLATE ${COLLATION} NULL`,
  },
  {
    table: 'retrieval_runs',
    name: 'revision_attempt',
    columnType: 'tinyint unsigned',
    nullable: 'YES',
    characterSet: null,
    collation: null,
    after: 'workflow_job_id',
    ddl: 'TINYINT UNSIGNED NULL',
  },
  {
    table: 'retrieval_runs',
    name: 'request_sha256',
    columnType: 'char(64)',
    nullable: 'YES',
    characterSet: CHARACTER_SET,
    collation: COLLATION,
    after: 'revision_attempt',
    ddl: `CHAR(64) CHARACTER SET ${CHARACTER_SET} COLLATE ${COLLATION} NULL`,
  },
] as const;

export class HardenAtomicOperationIdempotency1713340000000 implements MigrationInterface {
  name = 'HardenAtomicOperationIdempotency1713340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existingColumns = await assertExistingObjectsCompatible(queryRunner);
    await assertExistingDataCompatible(queryRunner, existingColumns);

    for (const column of COLUMNS) {
      if (!existingColumns.has(columnKey(column.table, column.name))) {
        await queryRunner.query(
          `ALTER TABLE ${column.table}
             ADD COLUMN ${column.name} ${column.ddl} AFTER ${column.after}`,
        );
        await assertColumn(queryRunner, column);
      }
    }

    if (!(await readIndex(queryRunner, 'model_runs', MODEL_OPERATION_INDEX))) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX ${MODEL_OPERATION_INDEX}
           ON model_runs (operation_key)`,
      );
      await assertIndex(queryRunner, 'model_runs', MODEL_OPERATION_INDEX, [
        'operation_key',
      ]);
    }
    if (
      !(await readIndex(
        queryRunner,
        'retrieval_runs',
        RETRIEVAL_REVISION_INDEX,
      ))
    ) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX ${RETRIEVAL_REVISION_INDEX}
           ON retrieval_runs (workflow_job_id, revision_attempt)`,
      );
      await assertIndex(
        queryRunner,
        'retrieval_runs',
        RETRIEVAL_REVISION_INDEX,
        ['workflow_job_id', 'revision_attempt'],
      );
    }
    if (!(await readForeignKey(queryRunner, RETRIEVAL_WORKFLOW_FK))) {
      await queryRunner.query(
        `ALTER TABLE retrieval_runs
           ADD CONSTRAINT ${RETRIEVAL_WORKFLOW_FK}
           FOREIGN KEY (workflow_job_id)
           REFERENCES workflow_jobs(id)
           ON DELETE CASCADE
           ON UPDATE RESTRICT`,
      );
      await assertForeignKey(queryRunner);
    }
    if (!(await readCheck(queryRunner, RETRIEVAL_SCOPE_CHECK))) {
      await queryRunner.query(
        `ALTER TABLE retrieval_runs
           ADD CONSTRAINT ${RETRIEVAL_SCOPE_CHECK}
           CHECK (${ATOMIC_SCOPE_CHECK_EXPRESSION})`,
      );
      await assertCheck(queryRunner);
    }

    const violations =
      await findAtomicOperationSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw schemaDrift(violations[0]);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error(
      'ATOMIC_OPERATION_IDEMPOTENCY_DESTRUCTIVE_ROLLBACK_FORBIDDEN',
    );
  }
}

async function assertExistingObjectsCompatible(
  queryRunner: QueryRunner,
): Promise<Set<string>> {
  await assertDdlPrerequisites(queryRunner);

  const existingColumns = new Set<string>();
  for (const expected of COLUMNS) {
    const actual = await readColumn(queryRunner, expected.table, expected.name);
    if (actual) existingColumns.add(columnKey(expected.table, expected.name));
    if (actual && !sameColumn(actual, expected)) {
      throw schemaDrift(`${expected.table}.${expected.name}`);
    }
  }
  const modelIndex = await readIndex(
    queryRunner,
    'model_runs',
    MODEL_OPERATION_INDEX,
  );
  if (modelIndex && !sameIndex(modelIndex, ['operation_key'])) {
    throw schemaDrift(`model_runs.${MODEL_OPERATION_INDEX}`);
  }
  const retrievalIndex = await readIndex(
    queryRunner,
    'retrieval_runs',
    RETRIEVAL_REVISION_INDEX,
  );
  if (
    retrievalIndex &&
    !sameIndex(retrievalIndex, ['workflow_job_id', 'revision_attempt'])
  ) {
    throw schemaDrift(`retrieval_runs.${RETRIEVAL_REVISION_INDEX}`);
  }
  const foreignKey = await readForeignKey(queryRunner, RETRIEVAL_WORKFLOW_FK);
  if (foreignKey && !sameForeignKey(foreignKey)) {
    throw schemaDrift(`retrieval_runs.${RETRIEVAL_WORKFLOW_FK}`);
  }
  const check = await readCheck(queryRunner, RETRIEVAL_SCOPE_CHECK);
  if (check && !sameCheck(check)) {
    throw schemaDrift(`retrieval_runs.${RETRIEVAL_SCOPE_CHECK}`);
  }
  return existingColumns;
}

async function assertDdlPrerequisites(queryRunner: QueryRunner): Promise<void> {
  for (const table of ['model_runs', 'retrieval_runs', 'workflow_jobs']) {
    const actual = await readTable(queryRunner, table);
    if (
      actual === null ||
      read(actual, 'tableType') !== 'BASE TABLE' ||
      read(actual, 'engine') !== 'InnoDB' ||
      read(actual, 'tableCollation') !== COLLATION ||
      read(actual, 'createOptions') !== ''
    ) {
      throw schemaDrift(table);
    }
  }

  await assertAnchorColumn(queryRunner, {
    table: 'model_runs',
    name: 'prompt_sha256',
    columnType: 'char(64)',
    nullable: 'YES',
  });
  await assertAnchorColumn(queryRunner, {
    table: 'retrieval_runs',
    name: 'project_id',
    columnType: 'varchar(36)',
    nullable: 'NO',
  });

  const workflowId = await readColumn(queryRunner, 'workflow_jobs', 'id');
  if (
    workflowId === null ||
    read(workflowId, 'columnType').toLowerCase() !== 'varchar(36)' ||
    read(workflowId, 'nullable') !== 'NO' ||
    nullableString(workflowId.characterSet) !== CHARACTER_SET ||
    nullableString(workflowId.collation) !== COLLATION ||
    read(workflowId, 'generationExpression') !== ''
  ) {
    throw schemaDrift('workflow_jobs.id');
  }

  if (
    !sameIndex(await readIndex(queryRunner, 'workflow_jobs', 'PRIMARY'), ['id'])
  ) {
    throw schemaDrift('workflow_jobs.PRIMARY');
  }
}

async function assertAnchorColumn(
  queryRunner: QueryRunner,
  expected: {
    table: string;
    name: string;
    columnType: string;
    nullable: 'YES' | 'NO';
  },
): Promise<void> {
  const actual = await readColumn(queryRunner, expected.table, expected.name);
  if (
    actual === null ||
    read(actual, 'columnType').toLowerCase() !== expected.columnType ||
    read(actual, 'nullable') !== expected.nullable ||
    nullableString(actual.characterSet) !== CHARACTER_SET ||
    nullableString(actual.collation) !== COLLATION ||
    actual.defaultValue !== null ||
    read(actual, 'extra') !== '' ||
    read(actual, 'generationExpression') !== ''
  ) {
    throw schemaDrift(`${expected.table}.${expected.name}`);
  }
}

async function assertExistingDataCompatible(
  queryRunner: QueryRunner,
  existingColumns: ReadonlySet<string>,
): Promise<void> {
  const workflowJob = existingColumnExpression(
    existingColumns,
    'retrieval_runs',
    'workflow_job_id',
  );
  const revisionAttempt = existingColumnExpression(
    existingColumns,
    'retrieval_runs',
    'revision_attempt',
  );
  const requestSha256 = existingColumnExpression(
    existingColumns,
    'retrieval_runs',
    'request_sha256',
  );
  const invalidScope = await queryRunner.query(
    `SELECT 1
       FROM retrieval_runs
      WHERE (
        (
          ${workflowJob} IS NULL
          AND ${revisionAttempt} IS NULL
          AND ${requestSha256} IS NULL
        )
        OR
        (
          ${workflowJob} IS NOT NULL
          AND ${revisionAttempt} = 1
          AND ${requestSha256} IS NOT NULL
          AND REGEXP_LIKE(
            ${requestSha256},
            _ascii'^[0-9a-f]{64}$',
            _ascii'c'
          )
        )
      ) IS NOT TRUE
      LIMIT 1`,
  );
  if (hasRows(invalidScope)) {
    throw new Error('ATOMIC_OPERATION_INVALID_RETRIEVAL_SCOPE');
  }
  if (
    existingColumns.has(columnKey('retrieval_runs', 'workflow_job_id')) &&
    existingColumns.has(columnKey('retrieval_runs', 'revision_attempt'))
  ) {
    const duplicateRevision = await queryRunner.query(
      `SELECT 1
         FROM retrieval_runs
        WHERE workflow_job_id IS NOT NULL
        GROUP BY workflow_job_id, revision_attempt
       HAVING COUNT(*) > 1
        LIMIT 1`,
    );
    if (hasRows(duplicateRevision)) {
      throw new Error('ATOMIC_OPERATION_DUPLICATE_RETRIEVAL_REVISION');
    }
  }
  if (existingColumns.has(columnKey('model_runs', 'operation_key'))) {
    const duplicateOperation = await queryRunner.query(
      `SELECT 1
         FROM model_runs
        WHERE operation_key IS NOT NULL
        GROUP BY operation_key
       HAVING COUNT(*) > 1
        LIMIT 1`,
    );
    if (hasRows(duplicateOperation)) {
      throw new Error('ATOMIC_OPERATION_DUPLICATE_MODEL_OPERATION');
    }
  }
  if (existingColumns.has(columnKey('retrieval_runs', 'workflow_job_id'))) {
    const orphanedJob = await queryRunner.query(
      `SELECT 1
         FROM retrieval_runs rr
         LEFT JOIN workflow_jobs w ON w.id = rr.workflow_job_id
        WHERE rr.workflow_job_id IS NOT NULL
          AND w.id IS NULL
        LIMIT 1`,
    );
    if (hasRows(orphanedJob)) {
      throw new Error('ATOMIC_OPERATION_ORPHANED_WORKFLOW_JOB');
    }
  }
}

function existingColumnExpression(
  existingColumns: ReadonlySet<string>,
  table: string,
  column: string,
): string {
  return existingColumns.has(columnKey(table, column))
    ? `\`${column}\``
    : 'NULL';
}

function columnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

async function assertColumn(
  queryRunner: QueryRunner,
  expected: ExpectedColumn,
): Promise<void> {
  if (
    !sameColumn(
      await readColumn(queryRunner, expected.table, expected.name),
      expected,
    )
  ) {
    throw schemaDrift(`${expected.table}.${expected.name}`);
  }
}

async function assertIndex(
  queryRunner: QueryRunner,
  table: string,
  name: string,
  columns: readonly string[],
): Promise<void> {
  if (!sameIndex(await readIndex(queryRunner, table, name), columns)) {
    throw schemaDrift(`${table}.${name}`);
  }
}

async function assertForeignKey(queryRunner: QueryRunner): Promise<void> {
  if (
    !sameForeignKey(await readForeignKey(queryRunner, RETRIEVAL_WORKFLOW_FK))
  ) {
    throw schemaDrift(`retrieval_runs.${RETRIEVAL_WORKFLOW_FK}`);
  }
}

async function assertCheck(queryRunner: QueryRunner): Promise<void> {
  if (!sameCheck(await readCheck(queryRunner, RETRIEVAL_SCOPE_CHECK))) {
    throw schemaDrift(`retrieval_runs.${RETRIEVAL_SCOPE_CHECK}`);
  }
}

async function readTable(
  queryRunner: QueryRunner,
  table: string,
): Promise<Record<string, unknown> | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT TABLE_TYPE AS tableType, ENGINE AS engine,
            TABLE_COLLATION AS tableCollation,
            CREATE_OPTIONS AS createOptions
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [table],
  );
  return oneRow(rows);
}

async function readColumn(
  queryRunner: QueryRunner,
  table: string,
  column: string,
): Promise<Record<string, unknown> | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS characterSet,
            COLLATION_NAME AS collation,
            COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra,
            GENERATION_EXPRESSION AS generationExpression,
            (
              SELECT previous.COLUMN_NAME
                FROM information_schema.COLUMNS previous
               WHERE previous.TABLE_SCHEMA = target.TABLE_SCHEMA
                 AND previous.TABLE_NAME = target.TABLE_NAME
                 AND previous.ORDINAL_POSITION = target.ORDINAL_POSITION - 1
            ) AS previousColumn
       FROM information_schema.COLUMNS target
      WHERE target.TABLE_SCHEMA = DATABASE()
        AND target.TABLE_NAME = ?
        AND target.COLUMN_NAME = ?`,
    [table, column],
  );
  return oneRow(rows);
}

async function readIndex(
  queryRunner: QueryRunner,
  table: string,
  index: string,
): Promise<Array<Record<string, unknown>> | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
            EXPRESSION AS expression, SUB_PART AS subPart,
            IS_VISIBLE AS isVisible, COLLATION AS direction
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [table, index],
  );
  return rowList(rows);
}

async function readForeignKey(
  queryRunner: QueryRunner,
  constraint: string,
): Promise<Array<Record<string, unknown>> | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT kcu.TABLE_NAME AS tableName,
            kcu.COLUMN_NAME AS columnName,
            kcu.ORDINAL_POSITION AS sequenceNumber,
            kcu.POSITION_IN_UNIQUE_CONSTRAINT AS referencedSequenceNumber,
            (kcu.REFERENCED_TABLE_SCHEMA = DATABASE())
              AS referencesCurrentSchema,
            kcu.REFERENCED_TABLE_NAME AS referencedTableName,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
            rc.DELETE_RULE AS deleteRule,
            rc.UPDATE_RULE AS updateRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
      WHERE kcu.TABLE_SCHEMA = DATABASE()
        AND kcu.CONSTRAINT_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.ORDINAL_POSITION`,
    [constraint],
  );
  return rowList(rows);
}

async function readCheck(
  queryRunner: QueryRunner,
  constraint: string,
): Promise<Record<string, unknown> | null> {
  const rows: unknown = await queryRunner.query(
    `SELECT tc.TABLE_NAME AS tableName, tc.ENFORCED AS enforced,
            cc.CHECK_CLAUSE AS checkClause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.CONSTRAINT_NAME = ?
        AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    [constraint],
  );
  return oneRow(rows);
}

function sameColumn(
  actual: Record<string, unknown> | null,
  expected: ExpectedColumn,
): boolean {
  return (
    actual !== null &&
    read(actual, 'columnType').toLowerCase() === expected.columnType &&
    read(actual, 'nullable') === expected.nullable &&
    nullableString(actual.characterSet) === expected.characterSet &&
    nullableString(actual.collation) === expected.collation &&
    actual.defaultValue === null &&
    read(actual, 'extra') === '' &&
    read(actual, 'generationExpression') === '' &&
    read(actual, 'previousColumn') === expected.after
  );
}

function sameIndex(
  rows: Array<Record<string, unknown>> | null,
  columns: readonly string[],
): boolean {
  return (
    rows !== null &&
    rows.length === columns.length &&
    rows.every(
      (row, index) =>
        Number(row.nonUnique) === 0 &&
        read(row, 'indexType') === 'BTREE' &&
        Number(row.sequenceNumber) === index + 1 &&
        read(row, 'columnName') === columns[index] &&
        row.expression === null &&
        row.subPart === null &&
        read(row, 'isVisible') === 'YES' &&
        read(row, 'direction') === 'A',
    )
  );
}

function sameForeignKey(rows: Array<Record<string, unknown>> | null): boolean {
  return (
    rows !== null &&
    rows.length === 1 &&
    read(rows[0], 'tableName') === 'retrieval_runs' &&
    read(rows[0], 'columnName') === 'workflow_job_id' &&
    Number(rows[0].sequenceNumber) === 1 &&
    Number(rows[0].referencedSequenceNumber) === 1 &&
    Number(rows[0].referencesCurrentSchema) === 1 &&
    read(rows[0], 'referencedTableName') === 'workflow_jobs' &&
    read(rows[0], 'referencedColumnName') === 'id' &&
    read(rows[0], 'deleteRule') === 'CASCADE' &&
    read(rows[0], 'updateRule') === 'RESTRICT'
  );
}

function sameCheck(row: Record<string, unknown> | null): boolean {
  return (
    row !== null &&
    read(row, 'tableName') === 'retrieval_runs' &&
    read(row, 'enforced') === 'YES' &&
    isAtomicScopeCheckClause(row.checkClause)
  );
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function read(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? '');
}

function oneRow(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'object' &&
    value[0] !== null
    ? (value[0] as Record<string, unknown>)
    : null;
}

function rowList(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (
    value.some(
      (row) => typeof row !== 'object' || row === null || Array.isArray(row),
    )
  ) {
    return null;
  }
  return value as Array<Record<string, unknown>>;
}

function hasRows(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function schemaDrift(objectName: string): Error {
  return new Error(`ATOMIC_OPERATION_SCHEMA_DRIFT:${objectName}`);
}
