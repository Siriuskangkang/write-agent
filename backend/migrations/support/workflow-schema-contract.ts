import type { QueryRunner } from 'typeorm';

export const WORKFLOW_SCHEMA_TABLES = [
  'workflow_jobs',
  'workflow_events',
  'model_runs',
] as const;

const EXPECTED_COLUMNS: Readonly<Record<string, string>> = {
  workflow_jobs:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;user_id|varchar(36)|NO|∅||;project_id|varchar(36)|NO|∅||;workflow_type|varchar(50)|NO|∅||;idempotency_key|varchar(128)|NO|∅||;request_hash|char(64)|NO|∅||;status|varchar(32)|NO|QUEUED||;input|json|YES|∅||;checkpoint|json|YES|∅||;lease_owner|varchar(128)|YES|∅||;lease_token|char(36)|YES|∅||;lease_expires_at|datetime(6)|YES|∅||;fencing_token|bigint unsigned|NO|0||;attempt_count|int unsigned|NO|0||;cancel_requested_at|datetime(6)|YES|∅||;approved_at|datetime(6)|YES|∅||;error_code|varchar(100)|YES|∅||;error_message|text|YES|∅||;public_error_code|varchar(100)|YES|∅||;public_error_message|varchar(500)|YES|∅||;started_at|datetime(6)|YES|∅||;completed_at|datetime(6)|YES|∅||;created_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;updated_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)|',
  workflow_events:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;job_id|varchar(36)|NO|∅||;seq|int unsigned|NO|∅||;type|varchar(100)|NO|∅||;data|json|YES|∅||;created_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|',
  model_runs:
    'id|varchar(36)|NO|uuid()|DEFAULT_GENERATED|;workflow_job_id|varchar(36)|NO|∅||;provider|varchar(50)|NO|∅||;model|varchar(100)|NO|∅||;request_metadata|json|YES|∅||;prompt_sha256|char(64)|YES|∅||;usage|json|YES|∅||;cost_usd|decimal(12,6)|YES|∅||;status|varchar(20)|NO|∅||;error_code|varchar(100)|YES|∅||;error_message|text|YES|∅||;started_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|;completed_at|datetime(6)|YES|∅||;created_at|datetime(6)|NO|CURRENT_TIMESTAMP(6)|DEFAULT_GENERATED|',
};

const EXPECTED_INDEXES: Readonly<Record<string, string>> = {
  workflow_jobs:
    'idx_workflow_jobs_project_status_created|1|BTREE|1|project_id;idx_workflow_jobs_project_status_created|1|BTREE|2|status;idx_workflow_jobs_project_status_created|1|BTREE|3|created_at;idx_workflow_jobs_status_lease|1|BTREE|1|status;idx_workflow_jobs_status_lease|1|BTREE|2|lease_expires_at;PRIMARY|0|BTREE|1|id;uq_workflow_jobs_idempotency|0|BTREE|1|user_id;uq_workflow_jobs_idempotency|0|BTREE|2|project_id;uq_workflow_jobs_idempotency|0|BTREE|3|workflow_type;uq_workflow_jobs_idempotency|0|BTREE|4|idempotency_key',
  workflow_events:
    'PRIMARY|0|BTREE|1|id;uq_workflow_events_job_seq|0|BTREE|1|job_id;uq_workflow_events_job_seq|0|BTREE|2|seq',
  model_runs:
    'idx_model_runs_workflow_status|1|BTREE|1|workflow_job_id;idx_model_runs_workflow_status|1|BTREE|2|status;PRIMARY|0|BTREE|1|id',
};

const EXPECTED_FOREIGN_KEYS: Readonly<Record<string, string>> = {
  workflow_jobs:
    'workflow_jobs_project_id_fkey|1|1|project_id|projects|id|CASCADE|RESTRICT;workflow_jobs_user_id_fkey|1|1|user_id|users|id|CASCADE|RESTRICT',
  workflow_events:
    'workflow_events_job_id_fkey|1|1|job_id|workflow_jobs|id|CASCADE|RESTRICT',
  model_runs:
    'model_runs_workflow_job_id_fkey|1|1|workflow_job_id|workflow_jobs|id|CASCADE|RESTRICT',
};

const EXPECTED_CHECKS: Readonly<Record<string, string>> = {
  workflow_jobs: '',
  workflow_events: '',
  model_runs: '',
};

const CHARACTER_SET = 'utf8mb4';
const TABLE_COLLATION = 'utf8mb4_0900_ai_ci';
const AUTHORING_JOB_COLUMNS = new Set([
  'workflow_definition',
  'authoring_mode',
  'rollout_policy_version',
  'rollout_policy_snapshot',
  'rollout_policy_digest',
  'server_entrypoint',
  'client_contract_version',
]);
const AUTHORING_JOB_CHECKS = new Set([
  'chk_workflow_jobs_definition',
  'chk_workflow_jobs_authoring_mode',
  'chk_workflow_jobs_server_entrypoint',
  'chk_workflow_jobs_client_contract',
]);

export async function findWorkflowSchemaContractViolations(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const placeholders = WORKFLOW_SCHEMA_TABLES.map(() => '?').join(', ');
  const [tableRows, columnRows, indexRows, foreignKeyRows, checkRows] =
    await Promise.all([
      queryRunner.query(
        `SELECT t.TABLE_NAME AS tableName, t.TABLE_TYPE AS tableType,
                t.ENGINE AS engine, t.TABLE_COLLATION AS tableCollation,
                cca.CHARACTER_SET_NAME AS characterSetName
           FROM information_schema.TABLES t
           LEFT JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY cca
             ON cca.COLLATION_NAME = t.TABLE_COLLATION
          WHERE t.TABLE_SCHEMA = DATABASE()
            AND t.TABLE_NAME IN (${placeholders})
          ORDER BY t.TABLE_NAME`,
        [...WORKFLOW_SCHEMA_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
                GENERATION_EXPRESSION AS generationExpression,
                CHARACTER_SET_NAME AS characterSetName,
                COLLATION_NAME AS collationName
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN (${placeholders})
          ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [...WORKFLOW_SCHEMA_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
                NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType,
                SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName,
                EXPRESSION AS expression, SUB_PART AS subPart,
                COLLATION AS collation, IS_VISIBLE AS isVisible
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN (${placeholders})
          ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [...WORKFLOW_SCHEMA_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT kcu.TABLE_NAME AS tableName,
                kcu.CONSTRAINT_NAME AS constraintName,
                kcu.ORDINAL_POSITION AS sequenceNumber,
                kcu.POSITION_IN_UNIQUE_CONSTRAINT AS referencedSequenceNumber,
                kcu.COLUMN_NAME AS columnName,
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
            AND kcu.TABLE_NAME IN (${placeholders})
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME,
                   kcu.ORDINAL_POSITION`,
        [...WORKFLOW_SCHEMA_TABLES],
      ) as Promise<unknown>,
      queryRunner.query(
        `SELECT tc.TABLE_NAME AS tableName,
                tc.CONSTRAINT_NAME AS constraintName,
                tc.ENFORCED AS enforced,
                cc.CHECK_CLAUSE AS checkClause
           FROM information_schema.TABLE_CONSTRAINTS tc
           JOIN information_schema.CHECK_CONSTRAINTS cc
             ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
            AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
            AND tc.TABLE_NAME IN (${placeholders})
            AND tc.CONSTRAINT_TYPE = 'CHECK'
          ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
        [...WORKFLOW_SCHEMA_TABLES],
      ) as Promise<unknown>,
    ]);

  if (
    !Array.isArray(tableRows) ||
    !Array.isArray(columnRows) ||
    !Array.isArray(indexRows) ||
    !Array.isArray(foreignKeyRows) ||
    !Array.isArray(checkRows)
  ) {
    return ['workflow schema inspection returned an invalid result'];
  }

  const violations: string[] = [];
  const hasGenerationAttempt = columnRows.some(
    (row) =>
      read(row, 'tableName') === 'workflow_jobs' &&
      read(row, 'columnName') === 'generation_attempt',
  );
  const hasModelAttemptColumns = [
    'attempt_number',
    'workflow_node',
    'attempt_kind',
    'generation_attempt',
    'network_attempt',
    'repair_attempt',
    'latency_ms',
  ].every((column) =>
    columnRows.some(
      (row) =>
        read(row, 'tableName') === 'model_runs' &&
        read(row, 'columnName') === column,
    ),
  );
  const hasModelOperationKey = columnRows.some(
    (row) =>
      read(row, 'tableName') === 'model_runs' &&
      read(row, 'columnName') === 'operation_key',
  );
  const hasModelRequestFingerprint = columnRows.some(
    (row) =>
      read(row, 'tableName') === 'model_runs' &&
      read(row, 'columnName') === 'request_fingerprint',
  );
  for (const table of WORKFLOW_SCHEMA_TABLES) {
    const tableRow = tableRows.find((row) => read(row, 'tableName') === table);
    if (
      !tableRow ||
      read(tableRow, 'tableType') !== 'BASE TABLE' ||
      read(tableRow, 'engine') !== 'InnoDB' ||
      read(tableRow, 'tableCollation') !== TABLE_COLLATION ||
      read(tableRow, 'characterSetName') !== CHARACTER_SET
    ) {
      violations.push(`${table}: table`);
    }

    const columns = columnRows
      .filter(
        (row) =>
          read(row, 'tableName') === table &&
          !(
            table === 'workflow_jobs' &&
            AUTHORING_JOB_COLUMNS.has(read(row, 'columnName'))
          ),
      )
      .map((row) =>
        [
          read(row, 'columnName'),
          read(row, 'columnType'),
          read(row, 'nullable'),
          normalizeNullable(readUnknown(row, 'defaultValue')),
          read(row, 'extra'),
          read(row, 'generationExpression'),
          normalizeNullable(readUnknown(row, 'characterSetName')),
          normalizeNullable(readUnknown(row, 'collationName')),
        ].join('|'),
      )
      .join(';');
    if (
      columns !==
      expectedColumns(
        table,
        hasGenerationAttempt,
        hasModelAttemptColumns,
        hasModelOperationKey,
        hasModelRequestFingerprint,
      )
    ) {
      violations.push(`${table}: columns`);
    }

    const indexes = indexRows
      .filter(
        (row) =>
          read(row, 'tableName') === table &&
          !(
            table === 'workflow_jobs' &&
            read(row, 'indexName') === 'uq_workflow_jobs_authoring_identity'
          ),
      )
      .map((row) =>
        [
          read(row, 'indexName'),
          Number(readUnknown(row, 'nonUnique')),
          read(row, 'indexType'),
          Number(readUnknown(row, 'sequenceNumber')),
          normalizeNullable(readUnknown(row, 'columnName')),
          normalizeNullable(readUnknown(row, 'expression')),
          normalizeNullable(readUnknown(row, 'subPart')),
          normalizeNullable(readUnknown(row, 'collation')),
          read(row, 'isVisible'),
        ].join('|'),
      )
      .join(';');
    if (
      indexes !==
      expectedIndexes(table, hasModelAttemptColumns, hasModelOperationKey)
    ) {
      violations.push(`${table}: indexes`);
    }

    const foreignKeys = foreignKeyRows
      .filter((row) => read(row, 'tableName') === table)
      .map((row) =>
        [
          read(row, 'constraintName'),
          Number(readUnknown(row, 'sequenceNumber')),
          normalizeNullable(readUnknown(row, 'referencedSequenceNumber')),
          read(row, 'columnName'),
          read(row, 'referencedTableName'),
          read(row, 'referencedColumnName'),
          read(row, 'deleteRule'),
          read(row, 'updateRule'),
        ].join('|'),
      )
      .join(';');
    if (foreignKeys !== EXPECTED_FOREIGN_KEYS[table]) {
      violations.push(`${table}: foreign keys`);
    }
    const checks = checkRows
      .filter(
        (row) =>
          read(row, 'tableName') === table &&
          !(
            table === 'workflow_jobs' &&
            AUTHORING_JOB_CHECKS.has(read(row, 'constraintName'))
          ),
      )
      .map((row) =>
        [
          read(row, 'constraintName'),
          read(row, 'enforced'),
          normalizeCheckClause(readUnknown(row, 'checkClause')),
        ].join('|'),
      )
      .join(';');
    if (checks !== EXPECTED_CHECKS[table]) {
      violations.push(`${table}: checks`);
    }
  }
  return violations;
}

function read(row: unknown, key: string): string {
  return String(readUnknown(row, key) ?? '');
}

function readUnknown(row: unknown, key: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[key]
    : undefined;
}

function normalizeNullable(value: unknown): string {
  return value === null || value === undefined ? '∅' : String(value);
}

function isCharacterColumnType(columnType: string): boolean {
  return /^(?:char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(
    columnType,
  );
}

function expectedColumns(
  table: string,
  hasGenerationAttempt: boolean,
  hasModelAttemptColumns: boolean,
  hasModelOperationKey: boolean,
  hasModelRequestFingerprint: boolean,
): string {
  let base =
    table === 'workflow_jobs' && hasGenerationAttempt
      ? EXPECTED_COLUMNS[table].replace(
          'attempt_count|int unsigned|NO|0||;',
          'attempt_count|int unsigned|NO|0||;generation_attempt|int unsigned|NO|0||;',
        )
      : EXPECTED_COLUMNS[table];
  if (table === 'model_runs' && hasModelAttemptColumns) {
    base = base
      .replace(
        'model|varchar(100)|NO|∅||;',
        'model|varchar(100)|NO|∅||;attempt_number|int unsigned|NO|1||;workflow_node|varchar(100)|NO|legacy||;attempt_kind|varchar(20)|NO|legacy||;generation_attempt|int unsigned|NO|1||;network_attempt|int unsigned|NO|0||;repair_attempt|int unsigned|NO|0||;',
      )
      .replace(
        'completed_at|datetime(6)|YES|∅||;',
        'completed_at|datetime(6)|YES|∅||;latency_ms|int unsigned|YES|∅||;',
      );
  }
  if (table === 'model_runs' && hasModelOperationKey) {
    base = base.replace(
      'prompt_sha256|char(64)|YES|∅||;',
      'prompt_sha256|char(64)|YES|∅||;operation_key|char(64)|YES|∅||;',
    );
  }
  if (table === 'model_runs' && hasModelRequestFingerprint) {
    base = base.replace(
      'operation_key|char(64)|YES|∅||;',
      'operation_key|char(64)|YES|∅||;request_fingerprint|char(64)|YES|∅||;',
    );
  }
  return base
    .split(';')
    .map((signature) => {
      const [, columnType] = signature.split('|');
      return isCharacterColumnType(columnType)
        ? `${signature}|${CHARACTER_SET}|${TABLE_COLLATION}`
        : `${signature}|∅|∅`;
    })
    .join(';');
}

function expectedIndexes(
  table: string,
  hasModelAttemptColumns: boolean,
  hasModelOperationKey: boolean,
): string {
  let expected =
    table === 'model_runs' && hasModelAttemptColumns
      ? `${EXPECTED_INDEXES[table]};uq_model_runs_job_node_attempt|0|BTREE|1|workflow_job_id;uq_model_runs_job_node_attempt|0|BTREE|2|workflow_node;uq_model_runs_job_node_attempt|0|BTREE|3|attempt_number`
      : EXPECTED_INDEXES[table];
  if (table === 'model_runs' && hasModelOperationKey) {
    expected = `${expected};uq_model_runs_operation_key|0|BTREE|1|operation_key`;
  }
  return expected
    .split(';')
    .map((signature) => `${signature}|∅|∅|A|YES`)
    .join(';');
}

function normalizeCheckClause(value: unknown): string {
  let clause = String(value ?? '').trim();
  while (clause.startsWith('(') && clause.endsWith(')')) {
    clause = clause.slice(1, -1).trim();
  }
  return clause.replace(/\s+/g, ' ');
}
