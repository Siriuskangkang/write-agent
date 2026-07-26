import type { MigrationInterface, QueryRunner } from 'typeorm';

interface ExpectedColumn {
  name:
    | 'attempt_number'
    | 'workflow_node'
    | 'attempt_kind'
    | 'generation_attempt'
    | 'network_attempt'
    | 'repair_attempt'
    | 'latency_ms';
  finalDefinition: string;
  stagingDefinition: string;
  columnType: string;
  ordinalPosition: number;
  characterSetName: string | null;
  collationName: string | null;
}

const TABLE_COLLATION = 'utf8mb4_0900_ai_ci';
const UNIQUE_INDEX = 'uq_model_runs_job_node_attempt';
const BACKFILL_TABLE = 'model_run_attempt_backfill';
const COLUMNS: readonly ExpectedColumn[] = [
  {
    name: 'attempt_number',
    finalDefinition: 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER `model`',
    stagingDefinition: 'INT UNSIGNED NULL AFTER `model`',
    columnType: 'int unsigned',
    ordinalPosition: 5,
    characterSetName: null,
    collationName: null,
  },
  {
    name: 'workflow_node',
    finalDefinition:
      "VARCHAR(100) NOT NULL DEFAULT 'legacy' AFTER `attempt_number`",
    stagingDefinition: 'VARCHAR(100) NULL AFTER `attempt_number`',
    columnType: 'varchar(100)',
    ordinalPosition: 6,
    characterSetName: 'utf8mb4',
    collationName: TABLE_COLLATION,
  },
  {
    name: 'attempt_kind',
    finalDefinition:
      "VARCHAR(20) NOT NULL DEFAULT 'legacy' AFTER `workflow_node`",
    stagingDefinition: 'VARCHAR(20) NULL AFTER `workflow_node`',
    columnType: 'varchar(20)',
    ordinalPosition: 7,
    characterSetName: 'utf8mb4',
    collationName: TABLE_COLLATION,
  },
  {
    name: 'generation_attempt',
    finalDefinition: 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER `attempt_kind`',
    stagingDefinition: 'INT UNSIGNED NULL AFTER `attempt_kind`',
    columnType: 'int unsigned',
    ordinalPosition: 8,
    characterSetName: null,
    collationName: null,
  },
  {
    name: 'network_attempt',
    finalDefinition: 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER `generation_attempt`',
    stagingDefinition: 'INT UNSIGNED NULL AFTER `generation_attempt`',
    columnType: 'int unsigned',
    ordinalPosition: 9,
    characterSetName: null,
    collationName: null,
  },
  {
    name: 'repair_attempt',
    finalDefinition: 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER `network_attempt`',
    stagingDefinition: 'INT UNSIGNED NULL AFTER `network_attempt`',
    columnType: 'int unsigned',
    ordinalPosition: 10,
    characterSetName: null,
    collationName: null,
  },
  {
    name: 'latency_ms',
    finalDefinition: 'INT UNSIGNED NULL AFTER `completed_at`',
    stagingDefinition: 'INT UNSIGNED NULL AFTER `completed_at`',
    columnType: 'int unsigned',
    ordinalPosition: 20,
    characterSetName: null,
    collationName: null,
  },
];

export class AddModelRunAttempts1712600000000 implements MigrationInterface {
  name = 'AddModelRunAttempts1712600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('model_runs'))) {
      throw new Error(
        'Model run attempt migration refused: model_runs is missing',
      );
    }

    // Preflight the complete existing shape and all populated typed fields
    // before the first persistent DDL statement.
    let inspection = await inspectTargetShape(queryRunner);
    assertCompatibleShape(inspection);
    await assertExistingDataCompatible(queryRunner, inspection);

    if (inspection.missingColumns.length > 0) {
      await queryRunner.query(
        `ALTER TABLE \`model_runs\`\n  ${inspection.missingColumns
          .map(
            (expected) =>
              `ADD COLUMN \`${expected.name}\` ${expected.stagingDefinition}`,
          )
          .join(',\n  ')}`,
      );
    }

    await backfillLegacyRows(queryRunner);
    await assertReadyForConstraint(queryRunner);

    inspection = await inspectTargetShape(queryRunner);
    assertCompatibleShape(inspection);
    const finalClauses = COLUMNS.flatMap((expected) => {
      const row = inspection.columns.get(expected.name);
      return row && !isFinalColumn(row, expected, inspection.missingColumnNames)
        ? [
            `MODIFY COLUMN \`${expected.name}\` ${expected.finalDefinition}`,
          ]
        : [];
    });
    if (inspection.indexRows.length === 0) {
      finalClauses.push(
        `ADD UNIQUE KEY \`${UNIQUE_INDEX}\` ` +
          '(`workflow_job_id`, `workflow_node`, `attempt_number`)',
      );
    }
    if (finalClauses.length > 0) {
      await queryRunner.query(
        `ALTER TABLE \`model_runs\`\n  ${finalClauses.join(',\n  ')}`,
      );
    }

    const reconciled = await inspectTargetShape(queryRunner);
    if (
      reconciled.missingColumns.length > 0 ||
      reconciled.indexRows.length === 0
    ) {
      throw new Error(
        'Model run attempt migration failed to establish the target contract',
      );
    }
    for (const expected of COLUMNS) {
      const row = reconciled.columns.get(expected.name);
      if (
        !row ||
        !isFinalColumn(row, expected, reconciled.missingColumnNames)
      ) {
        throw new Error(
          `Model run attempt migration failed to finalize model_runs.${expected.name}`,
        );
      }
    }
    assertCompatibleIndex(reconciled.indexRows);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('model_runs'))) return;
    const inspection = await inspectTargetShape(queryRunner);
    const clauses: string[] = [];
    if (inspection.indexRows.length > 0) {
      assertCompatibleIndex(inspection.indexRows);
      clauses.push(`DROP INDEX \`${UNIQUE_INDEX}\``);
    }
    for (const expected of [...COLUMNS].reverse()) {
      if (inspection.columns.has(expected.name)) {
        clauses.push(`DROP COLUMN \`${expected.name}\``);
      }
    }
    if (clauses.length > 0) {
      await queryRunner.query(
        `ALTER TABLE \`model_runs\`\n  ${clauses.join(',\n  ')}`,
      );
    }
  }
}

interface ShapeInspection {
  columns: Map<string, Record<string, unknown>>;
  missingColumns: ExpectedColumn[];
  missingColumnNames: Set<string>;
  indexRows: Array<Record<string, unknown>>;
}

async function inspectTargetShape(
  queryRunner: QueryRunner,
): Promise<ShapeInspection> {
  const names = COLUMNS.map(({ name }) => name);
  const placeholders = names.map(() => '?').join(', ');
  const columnRows: unknown = await queryRunner.query(
    `SELECT COLUMN_NAME AS columnName,
            ORDINAL_POSITION AS ordinalPosition,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue,
            EXTRA AS extra,
            GENERATION_EXPRESSION AS generationExpression,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'model_runs'
        AND COLUMN_NAME IN (${placeholders})
      ORDER BY ORDINAL_POSITION`,
    names,
  );
  const indexRows: unknown = await queryRunner.query(
    `SELECT INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique,
            INDEX_TYPE AS indexType,
            SEQ_IN_INDEX AS sequenceNumber,
            COLUMN_NAME AS columnName,
            EXPRESSION AS expression,
            SUB_PART AS subPart,
            COLLATION AS collation,
            IS_VISIBLE AS isVisible
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'model_runs'
        AND INDEX_NAME = ?
      ORDER BY SEQ_IN_INDEX`,
    [UNIQUE_INDEX],
  );
  if (!Array.isArray(columnRows) || !Array.isArray(indexRows)) {
    throw new Error(
      'Model run attempt migration refused: schema inspection failed',
    );
  }
  const columns = new Map<string, Record<string, unknown>>();
  for (const raw of columnRows) {
    const row = asRecord(raw);
    const name = read(row, 'columnName');
    if (columns.has(name)) {
      throw new Error(`Model run attempt migration refused: duplicate ${name}`);
    }
    columns.set(name, row);
  }
  const missingColumns = COLUMNS.filter(
    (expected) => !columns.has(expected.name),
  );
  return {
    columns,
    missingColumns,
    missingColumnNames: new Set(
      missingColumns.map((expected) => expected.name),
    ),
    indexRows: indexRows.map(asRecord),
  };
}

function assertCompatibleShape(inspection: ShapeInspection): void {
  for (const expected of COLUMNS) {
    const row = inspection.columns.get(expected.name);
    if (
      row &&
      !isFinalColumn(row, expected, inspection.missingColumnNames) &&
      !isStagingColumn(row, expected, inspection.missingColumnNames)
    ) {
      throw new Error(
        `Model run attempt migration refused: model_runs.${expected.name} is incompatible`,
      );
    }
  }
  if (inspection.indexRows.length > 0) {
    assertCompatibleIndex(inspection.indexRows);
  }
}

function isFinalColumn(
  row: Record<string, unknown>,
  expected: ExpectedColumn,
  missingColumnNames: ReadonlySet<string>,
): boolean {
  return isCompatibleColumn(
    row,
    expected,
    missingColumnNames,
    expected.name === 'latency_ms' ? 'YES' : 'NO',
    expected.name === 'latency_ms'
      ? null
      : expected.name === 'workflow_node' || expected.name === 'attempt_kind'
        ? 'legacy'
        : expected.name === 'network_attempt' ||
            expected.name === 'repair_attempt'
          ? '0'
          : '1',
  );
}

function isStagingColumn(
  row: Record<string, unknown>,
  expected: ExpectedColumn,
  missingColumnNames: ReadonlySet<string>,
): boolean {
  return isCompatibleColumn(
    row,
    expected,
    missingColumnNames,
    'YES',
    null,
  );
}

function isCompatibleColumn(
  row: Record<string, unknown>,
  expected: ExpectedColumn,
  missingColumnNames: ReadonlySet<string>,
  nullable: 'YES' | 'NO',
  defaultValue: string | null,
): boolean {
  const actualDefault =
    row.defaultValue === null || row.defaultValue === undefined
      ? null
      : String(row.defaultValue);
  const missingBefore = COLUMNS.filter(
    (candidate) =>
      candidate.ordinalPosition < expected.ordinalPosition &&
      missingColumnNames.has(candidate.name),
  ).length;
  return (
    read(row, 'columnType') === expected.columnType &&
    read(row, 'nullable') === nullable &&
    actualDefault === defaultValue &&
    read(row, 'extra') === '' &&
    read(row, 'generationExpression') === '' &&
    nullableString(row.characterSetName) === expected.characterSetName &&
    nullableString(row.collationName) === expected.collationName &&
    Number(row.ordinalPosition) + missingBefore === expected.ordinalPosition
  );
}

async function assertExistingDataCompatible(
  queryRunner: QueryRunner,
  inspection: ShapeInspection,
): Promise<void> {
  const select = (name: ExpectedColumn['name']): string =>
    inspection.columns.has(name) ? `\`${name}\`` : `NULL AS \`${name}\``;
  const rows: unknown = await queryRunner.query(
    `SELECT id, workflow_job_id,
            ${COLUMNS.map(({ name }) => select(name)).join(', ')}
       FROM model_runs`,
  );
  if (!Array.isArray(rows)) {
    throw new Error(
      'Model run attempt migration refused: data inspection failed',
    );
  }
  const occupied = new Set<string>();
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!read(row, 'id') || !read(row, 'workflow_job_id')) {
      throw new Error(
        'Model run attempt migration refused: invalid legacy identity',
      );
    }
    assertOptionalUnsigned(row.attempt_number, false);
    assertOptionalUnsigned(row.generation_attempt, false);
    assertOptionalUnsigned(row.network_attempt, true);
    assertOptionalUnsigned(row.repair_attempt, true);
    assertOptionalUnsigned(row.latency_ms, true);
    const node = nullableString(row.workflow_node);
    if (node !== null && !isSafeIdentifier(node, 100)) {
      throw new Error(
        'Model run attempt migration refused: invalid workflow_node data',
      );
    }
    const kind = nullableString(row.attempt_kind);
    if (
      kind !== null &&
      !['legacy', 'initial', 'network_retry', 'repair'].includes(kind)
    ) {
      throw new Error(
        'Model run attempt migration refused: invalid attempt_kind data',
      );
    }
    if (
      kind !== null &&
      kind !== 'legacy' &&
      (node === null ||
        row.attempt_number === null ||
        row.attempt_number === undefined ||
        row.generation_attempt === null ||
        row.generation_attempt === undefined ||
        row.network_attempt === null ||
        row.network_attempt === undefined ||
        row.repair_attempt === null ||
        row.repair_attempt === undefined)
    ) {
      throw new Error(
        'Model run attempt migration refused: incomplete populated attempt',
      );
    }
    if (
      kind !== null &&
      kind !== 'legacy' &&
      node !== null &&
      row.attempt_number !== null &&
      row.attempt_number !== undefined
    ) {
      const key = `${read(row, 'workflow_job_id')}\0${node}\0${String(
        row.attempt_number,
      )}`;
      if (occupied.has(key)) {
        throw new Error(
          'Model run attempt migration refused: duplicate populated attempts',
        );
      }
      occupied.add(key);
    }
  }
}

async function backfillLegacyRows(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`DROP TEMPORARY TABLE IF EXISTS \`${BACKFILL_TABLE}\``);
  try {
    await queryRunner.query(
      `CREATE TEMPORARY TABLE \`${BACKFILL_TABLE}\` (
         id VARCHAR(36) NOT NULL,
         attempt_number INT UNSIGNED NOT NULL,
         PRIMARY KEY (id)
       ) ENGINE=InnoDB
       SELECT legacy.id,
              COALESCE(populated.max_attempt, 0) +
                ROW_NUMBER() OVER (
                  PARTITION BY legacy.workflow_job_id
                  ORDER BY legacy.started_at, legacy.created_at, legacy.id
                ) AS attempt_number
         FROM model_runs legacy
         LEFT JOIN (
           SELECT workflow_job_id, MAX(attempt_number) AS max_attempt
             FROM model_runs
            WHERE attempt_kind IS NOT NULL
              AND attempt_kind <> 'legacy'
              AND workflow_node = 'legacy'
            GROUP BY workflow_job_id
         ) populated
           ON populated.workflow_job_id = legacy.workflow_job_id
        WHERE legacy.attempt_kind IS NULL
           OR legacy.attempt_kind = 'legacy'`,
    );
    await queryRunner.query(
      `UPDATE model_runs target
         JOIN \`${BACKFILL_TABLE}\` backfill ON backfill.id = target.id
          SET target.attempt_number = backfill.attempt_number,
              target.workflow_node = 'legacy',
              target.attempt_kind = 'legacy',
              target.generation_attempt = 1,
              target.network_attempt = 0,
              target.repair_attempt = 0`,
    );
  } finally {
    await queryRunner.query(
      `DROP TEMPORARY TABLE IF EXISTS \`${BACKFILL_TABLE}\``,
    );
  }
}

async function assertReadyForConstraint(
  queryRunner: QueryRunner,
): Promise<void> {
  const invalidRows: unknown = await queryRunner.query(
    `SELECT COUNT(*) AS rowCount
       FROM model_runs
      WHERE attempt_number IS NULL OR attempt_number < 1
         OR workflow_node IS NULL OR workflow_node = ''
         OR attempt_kind IS NULL
         OR attempt_kind NOT IN ('legacy', 'initial', 'network_retry', 'repair')
         OR generation_attempt IS NULL OR generation_attempt < 1
         OR network_attempt IS NULL
         OR repair_attempt IS NULL`,
  );
  if (readCount(invalidRows) !== 0) {
    throw new Error(
      'Model run attempt migration refused: backfilled data is invalid',
    );
  }
  const duplicates: unknown = await queryRunner.query(
    `SELECT COUNT(*) AS rowCount
       FROM (
         SELECT workflow_job_id, workflow_node, attempt_number
           FROM model_runs
          GROUP BY workflow_job_id, workflow_node, attempt_number
         HAVING COUNT(*) > 1
       ) duplicate_attempts`,
  );
  if (readCount(duplicates) !== 0) {
    throw new Error(
      'Model run attempt migration refused: attempt keys are not unique',
    );
  }
}

function assertCompatibleIndex(rows: Array<Record<string, unknown>>): void {
  const expectedColumns = [
    'workflow_job_id',
    'workflow_node',
    'attempt_number',
  ];
  if (
    rows.length !== expectedColumns.length ||
    rows.some(
      (row, index) =>
        read(row, 'indexName') !== UNIQUE_INDEX ||
        Number(row.nonUnique) !== 0 ||
        read(row, 'indexType') !== 'BTREE' ||
        Number(row.sequenceNumber) !== index + 1 ||
        read(row, 'columnName') !== expectedColumns[index] ||
        nullableString(row.expression) !== null ||
        nullableString(row.subPart) !== null ||
        read(row, 'collation') !== 'A' ||
        read(row, 'isVisible') !== 'YES',
    )
  ) {
    throw new Error(
      `Model run attempt migration refused: ${UNIQUE_INDEX} is incompatible`,
    );
  }
}

function assertOptionalUnsigned(value: unknown, allowZero: boolean): void {
  if (value === null || value === undefined) return;
  const number = typeof value === 'string' ? Number(value) : value;
  if (
    !Number.isSafeInteger(number) ||
    Number(number) < (allowZero ? 0 : 1)
  ) {
    throw new Error(
      'Model run attempt migration refused: invalid numeric attempt data',
    );
  }
}

function readCount(rows: unknown): number {
  const raw =
    Array.isArray(rows) && rows.length === 1
      ? (rows[0] as { rowCount?: unknown }).rowCount
      : undefined;
  const count = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isSafeInteger(count) || Number(count) < 0) {
    throw new Error(
      'Model run attempt migration refused: could not count inspected rows',
    );
  }
  return Number(count);
}

function isSafeIdentifier(value: string, maxBytes: number): boolean {
  return (
    Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'Model run attempt migration refused: invalid inspection row',
    );
  }
  return value as Record<string, unknown>;
}

function read(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? '');
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
