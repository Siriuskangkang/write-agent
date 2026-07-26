import { createHash } from 'node:crypto';
import type { QueryRunner } from 'typeorm';

export const STORAGE_AUTHORITY_TABLES = [
  'storage_control',
  'storage_objects',
  'storage_operation_intents',
] as const;

const UTF8 = 'utf8mb4';
const UTF8_COLLATION = 'utf8mb4_0900_ai_ci';
const ASCII = 'ascii';
const ASCII_COLLATION = 'ascii_bin';
const AUTHORITY_DDL_SHA256: Readonly<Record<string, string>> = {
  v_storage_intent_execution_v1:
    'b75432fddd39e2f789f8063bc572b1596c8fd7a5da4cdffdb350cfe7638a39fc',
  sp_storage_claim_v1:
    '27f81fba10f87ce54a4fc28e89628ff6afb441ecc205ba2c3baff6922764d8b5',
  sp_storage_complete_v1:
    '4939ed44dbff007df41e027b7fc5b0060bc69cee06d578865b071bd818ce2b23',
  sp_storage_request_abort_promotion_v1:
    '9dff0927adcf2d5441169aa62f623ca438d2b8a5c9ae98fb4fe7c2cd9afe8ac1',
  sp_storage_request_delete_blob_v1:
    'f1cfead0f60dd276ee9dd7db9de3b88802cf062405cfa938872519269c83f99e',
  sp_storage_request_delete_quarantine_v1:
    'ae322487806571e3bf89a2c85510a4323fcf7eb20cf0ac0fa9890895fac91b13',
  sp_storage_request_promote_v1:
    '63f2892289c0747ee4f59d68c26112b85402370f5591905ffdd8b276ff75c2ee',
};
const LEGACY_REQUEST_DDL_SHA256: Readonly<Record<string, string>> = {
  sp_storage_request_abort_promotion_v1:
    '534069eae45cf89d93d9f3cb0a1f0d962ea10ba447b74e53d5092fac4c714df4',
  sp_storage_request_delete_blob_v1:
    'd83d29887e3c49bf3207e3f6a1aac5db6151dd67a00a505fc5d831819508364d',
  sp_storage_request_delete_quarantine_v1:
    '8a916511bbcc3172a08edf3599ea23ba1803b424807bed362f3bea798ba480da',
  sp_storage_request_promote_v1:
    '43fad644f313cef501b2da9171ada80480062489536df2d47ba9e2b535f02b8d',
};

interface ExpectedColumn {
  name: string;
  type: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
  extra: string;
  charset: string | null;
  collation: string | null;
}

interface ExpectedIndexColumn {
  name: string;
  nonUnique: 0 | 1;
  type: 'BTREE';
  position: number;
  column: string;
}

interface ExpectedForeignKeyColumn {
  name: string;
  position: number;
  referencedPosition: number;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

const EXPECTED_COLUMNS: Readonly<
  Record<(typeof STORAGE_AUTHORITY_TABLES)[number], readonly ExpectedColumn[]>
> = {
  storage_control: [
    column('singleton_id', 'tinyint unsigned'),
    column('active_epoch', 'char(36)', false, null, '', ASCII),
    column('broker_contract_version', 'varchar(64)', false, null, '', ASCII),
    column(
      'activated_at',
      'datetime(6)',
      false,
      'CURRENT_TIMESTAMP(6)',
      'DEFAULT_GENERATED',
    ),
  ],
  storage_objects: [
    column('id', 'varchar(36)', false, null, '', UTF8),
    column('project_id', 'varchar(36)', false, null, '', UTF8),
    column('source_file_id', 'varchar(36)', false, null, '', UTF8),
    column('generation', 'bigint unsigned'),
    column('storage_key', 'varchar(512)', false, null, '', ASCII),
    column('checksum_sha256', 'char(64)', false, null, '', ASCII),
    column('byte_size', 'bigint unsigned'),
    column('state', 'varchar(32)', false, null, '', ASCII),
    column(
      'created_at',
      'datetime(6)',
      false,
      'CURRENT_TIMESTAMP(6)',
      'DEFAULT_GENERATED',
    ),
    column(
      'updated_at',
      'datetime(6)',
      false,
      'CURRENT_TIMESTAMP(6)',
      'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)',
    ),
  ],
  storage_operation_intents: [
    column('id', 'varchar(36)', false, null, '', UTF8),
    column('idempotency_key', 'char(64)', false, null, '', ASCII),
    column('kind', 'varchar(32)', false, null, '', ASCII),
    column('project_id', 'varchar(36)', false, null, '', UTF8),
    column('object_id', 'varchar(36)', false, null, '', UTF8),
    column('object_generation', 'bigint unsigned'),
    column('storage_key', 'varchar(512)', false, null, '', ASCII),
    column('quarantine_key', 'varchar(512)', true, null, '', ASCII),
    column('expected_sha256', 'char(64)', false, null, '', ASCII),
    column('expected_size', 'bigint unsigned'),
    column('authorization_kind', 'varchar(32)', false, null, '', ASCII),
    column('authorization_id', 'varchar(36)', false, null, '', UTF8),
    column('storage_epoch', 'char(36)', false, null, '', ASCII),
    column('status', 'varchar(32)', false, null, '', ASCII),
    column('execution_fence', 'bigint unsigned', false, '0'),
    column('lease_token', 'char(36)', true, null, '', ASCII),
    column('lease_expires_at', 'datetime(6)', true),
    column('next_attempt_at', 'datetime(6)', true),
    column('completed_at', 'datetime(6)', true),
    column('attempts', 'int unsigned', false, '0'),
    column('result_code', 'varchar(128)', true, null, '', ASCII),
    column('last_error', 'varchar(128)', true, null, '', ASCII),
    column(
      'created_at',
      'datetime(6)',
      false,
      'CURRENT_TIMESTAMP(6)',
      'DEFAULT_GENERATED',
    ),
    column(
      'updated_at',
      'datetime(6)',
      false,
      'CURRENT_TIMESTAMP(6)',
      'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)',
    ),
  ],
};

const EXPECTED_INDEXES: Readonly<
  Record<
    (typeof STORAGE_AUTHORITY_TABLES)[number],
    readonly ExpectedIndexColumn[]
  >
> = {
  storage_control: [
    index('PRIMARY', 0, 1, 'singleton_id'),
    index('uq_storage_control_active_epoch', 0, 1, 'active_epoch'),
  ],
  storage_objects: [
    index('PRIMARY', 0, 1, 'id'),
    index('storage_objects_project_file_fkey', 1, 1, 'project_id'),
    index('storage_objects_project_file_fkey', 1, 2, 'source_file_id'),
    index('uq_storage_objects_file_generation', 0, 1, 'source_file_id'),
    index('uq_storage_objects_file_generation', 0, 2, 'generation'),
    index('uq_storage_objects_intent_identity', 0, 1, 'id'),
    index('uq_storage_objects_intent_identity', 0, 2, 'project_id'),
    index('uq_storage_objects_intent_identity', 0, 3, 'generation'),
    index('uq_storage_objects_intent_identity', 0, 4, 'storage_key'),
    index('uq_storage_objects_key', 0, 1, 'storage_key'),
  ],
  storage_operation_intents: [
    index('idx_storage_operation_intents_claim', 1, 1, 'status'),
    index('idx_storage_operation_intents_claim', 1, 2, 'next_attempt_at'),
    index('idx_storage_operation_intents_claim', 1, 3, 'lease_expires_at'),
    index('PRIMARY', 0, 1, 'id'),
    index('storage_operation_intents_object_fkey', 1, 1, 'object_id'),
    index('storage_operation_intents_object_fkey', 1, 2, 'project_id'),
    index('storage_operation_intents_object_fkey', 1, 3, 'object_generation'),
    index('storage_operation_intents_object_fkey', 1, 4, 'storage_key'),
    index('storage_operation_intents_project_fkey', 1, 1, 'project_id'),
    index(
      'storage_operation_intents_storage_epoch_fkey',
      1,
      1,
      'storage_epoch',
    ),
    index('uq_storage_operation_intents_idempotency', 0, 1, 'idempotency_key'),
  ],
};

const EXPECTED_FOREIGN_KEYS: Readonly<
  Record<
    Exclude<(typeof STORAGE_AUTHORITY_TABLES)[number], 'storage_control'>,
    readonly ExpectedForeignKeyColumn[]
  >
> = {
  storage_objects: [
    foreignKey(
      'storage_objects_project_file_fkey',
      1,
      1,
      'project_id',
      'source_files',
      'project_id',
    ),
    foreignKey(
      'storage_objects_project_file_fkey',
      2,
      2,
      'source_file_id',
      'source_files',
      'id',
    ),
    foreignKey(
      'storage_objects_project_fkey',
      1,
      1,
      'project_id',
      'projects',
      'id',
    ),
  ],
  storage_operation_intents: [
    foreignKey(
      'storage_operation_intents_object_fkey',
      1,
      1,
      'object_id',
      'storage_objects',
      'id',
    ),
    foreignKey(
      'storage_operation_intents_object_fkey',
      2,
      2,
      'project_id',
      'storage_objects',
      'project_id',
    ),
    foreignKey(
      'storage_operation_intents_object_fkey',
      3,
      3,
      'object_generation',
      'storage_objects',
      'generation',
    ),
    foreignKey(
      'storage_operation_intents_object_fkey',
      4,
      4,
      'storage_key',
      'storage_objects',
      'storage_key',
    ),
    foreignKey(
      'storage_operation_intents_project_fkey',
      1,
      1,
      'project_id',
      'projects',
      'id',
    ),
    foreignKey(
      'storage_operation_intents_storage_epoch_fkey',
      1,
      1,
      'storage_epoch',
      'storage_control',
      'active_epoch',
    ),
  ],
};

const EXPECTED_CHECKS: Readonly<Record<string, string>> = {
  chk_storage_control_contract: "broker_contract_version='storage-broker.v1'",
  chk_storage_control_singleton: 'singleton_id=1',
  chk_storage_objects_state:
    "state in ('STAGING','AVAILABLE','DELETE_PENDING','DELETED')",
  chk_storage_operation_intents_authorization:
    "authorization_kind in ('UPLOAD_COMMIT','SOURCE_FILE_TOMBSTONE','MOVE_ABORT')",
  chk_storage_operation_intents_kind:
    "kind in ('PROMOTE','DELETE_QUARANTINE','DELETE_BLOB','ABORT_PROMOTION')",
  chk_storage_operation_intents_shape: `
    (
      (
        (kind='PROMOTE' and quarantine_key is not null
          and authorization_kind='UPLOAD_COMMIT')
        or
        (kind='DELETE_QUARANTINE' and quarantine_key is not null
          and authorization_kind in ('UPLOAD_COMMIT','MOVE_ABORT'))
        or
        (kind='DELETE_BLOB' and quarantine_key is null
          and authorization_kind='SOURCE_FILE_TOMBSTONE')
        or
        (kind='ABORT_PROMOTION' and quarantine_key is not null
          and authorization_kind='MOVE_ABORT')
      )
      and
      (
        (status='PENDING' and lease_token is null
          and lease_expires_at is null and completed_at is null
          and result_code is null and next_attempt_at is null
          and last_error is null and execution_fence=0)
        or
        (status='EXECUTING' and lease_token is not null
          and lease_expires_at is not null and completed_at is null
          and result_code is null and next_attempt_at is null
          and last_error is null and execution_fence>0 and attempts>0)
        or
        (status='RETRY' and lease_token is null
          and lease_expires_at is null and completed_at is null
          and result_code is null and next_attempt_at is not null
          and last_error is not null and attempts>0)
        or
        (status='SUCCEEDED' and lease_token is null
          and lease_expires_at is null and completed_at is not null
          and result_code is not null and next_attempt_at is null
          and last_error is null and execution_fence>0 and attempts>0)
        or
        (status='REJECTED' and lease_token is null
          and lease_expires_at is null and completed_at is not null
          and result_code is not null and next_attempt_at is null
          and execution_fence>0 and attempts>0)
      )
    )
  `,
  chk_storage_operation_intents_status:
    "status in ('PENDING','EXECUTING','RETRY','SUCCEEDED','REJECTED')",
};

export async function findStorageSchemaContractViolations(
  queryRunner: QueryRunner,
): Promise<string[]> {
  const violations: string[] = [];
  const placeholders = STORAGE_AUTHORITY_TABLES.map(() => '?').join(',');
  const tableRows: unknown = await queryRunner.query(
    `SELECT TABLE_NAME AS tableName,TABLE_TYPE AS tableType,
            ENGINE AS engine,TABLE_COLLATION AS tableCollation
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME`,
    [...STORAGE_AUTHORITY_TABLES],
  );
  if (!Array.isArray(tableRows)) return ['storage tables: inspection'];
  for (const table of STORAGE_AUTHORITY_TABLES) {
    const row = tableRows.find(
      (candidate) => read(candidate, 'tableName') === table,
    );
    if (
      !row ||
      read(row, 'tableType') !== 'BASE TABLE' ||
      read(row, 'engine') !== 'InnoDB' ||
      read(row, 'tableCollation') !== UTF8_COLLATION
    ) {
      violations.push(`${table}: table`);
    }
  }

  await validateColumns(queryRunner, violations);
  await validateIndexes(queryRunner, violations);
  await validateForeignKeys(queryRunner, violations);
  await validateChecks(queryRunner, violations);
  await validateAuxiliaryObjects(queryRunner, violations);
  await validateTerminalTrigger(queryRunner, violations);
  return violations;
}

export async function findStorageAuthorityContractViolations(
  queryRunner: QueryRunner,
  options: {
    requestRoutines?: 'legacy' | 'transaction-bound';
  } = {},
): Promise<string[]> {
  const violations = await findStorageSchemaContractViolations(queryRunner);
  const database = await inspectCurrentDatabase(queryRunner);
  if (database === null) {
    violations.push('storage authority: database');
    return violations;
  }
  await validateAuthorityView(queryRunner, violations, database);
  await validateAuthorityRoutines(
    queryRunner,
    violations,
    database,
    options.requestRoutines ?? 'transaction-bound',
  );
  await validateAuthorityRoles(queryRunner, violations, database);
  return violations;
}

async function validateAuthorityView(
  queryRunner: QueryRunner,
  violations: string[],
  database: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT SECURITY_TYPE AS securityType,
            CHECK_OPTION AS checkOption,
            VIEW_DEFINITION AS definition
       FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='v_storage_intent_execution_v1'`,
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    read(rows[0], 'securityType') !== 'DEFINER' ||
    read(rows[0], 'checkOption') !== 'NONE'
  ) {
    violations.push('v_storage_intent_execution_v1: definition');
    return;
  }
  const columns: unknown = await queryRunner.query(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='v_storage_intent_execution_v1'
      ORDER BY ORDINAL_POSITION`,
  );
  const expected = [
    'intent_id',
    'kind',
    'project_id',
    'source_file_id',
    'object_id',
    'object_generation',
    'storage_key',
    'quarantine_key',
    'expected_sha256',
    'expected_size',
    'authorization_kind',
    'authorization_id',
    'storage_epoch',
    'status',
    'execution_fence',
    'lease_token',
    'lease_expires_at',
  ];
  if (
    !Array.isArray(columns) ||
    JSON.stringify(columns.map((row) => read(row, 'name'))) !==
      JSON.stringify(expected)
  ) {
    violations.push('v_storage_intent_execution_v1: columns');
  }
  const show: unknown = await queryRunner.query(
    'SHOW CREATE VIEW v_storage_intent_execution_v1',
  );
  if (
    !Array.isArray(show) ||
    show.length !== 1 ||
    authoritySqlDigest(read(show[0], 'Create View'), database) !==
      AUTHORITY_DDL_SHA256.v_storage_intent_execution_v1
  ) {
    violations.push('v_storage_intent_execution_v1: show create');
  }
}

async function validateAuthorityRoutines(
  queryRunner: QueryRunner,
  violations: string[],
  database: string,
  requestRoutines: 'legacy' | 'transaction-bound',
): Promise<void> {
  const expectedParameters: Readonly<Record<string, readonly string[]>> = {
    sp_storage_request_promote_v1: [
      'p_actor_id',
      'p_intent_id',
      'p_project_id',
      'p_source_file_id',
      'p_object_id',
      'p_object_generation',
      'p_storage_key',
      'p_quarantine_key',
      'p_expected_sha256',
      'p_expected_size',
      'p_authorization_id',
      'p_storage_epoch',
      'p_idempotency_key',
    ],
    sp_storage_request_delete_quarantine_v1: [
      'p_actor_id',
      'p_intent_id',
      'p_project_id',
      'p_source_file_id',
      'p_object_id',
      'p_object_generation',
      'p_storage_key',
      'p_quarantine_key',
      'p_authorization_kind',
      'p_expected_sha256',
      'p_expected_size',
      'p_authorization_id',
      'p_storage_epoch',
      'p_idempotency_key',
    ],
    sp_storage_request_delete_blob_v1: [
      'p_actor_id',
      'p_intent_id',
      'p_project_id',
      'p_source_file_id',
      'p_object_id',
      'p_object_generation',
      'p_storage_key',
      'p_expected_sha256',
      'p_expected_size',
      'p_authorization_id',
      'p_storage_epoch',
      'p_idempotency_key',
    ],
    sp_storage_request_abort_promotion_v1: [
      'p_actor_id',
      'p_intent_id',
      'p_project_id',
      'p_source_file_id',
      'p_object_id',
      'p_object_generation',
      'p_storage_key',
      'p_quarantine_key',
      'p_expected_sha256',
      'p_expected_size',
      'p_authorization_id',
      'p_storage_epoch',
      'p_idempotency_key',
    ],
    sp_storage_claim_v1: [
      'p_instance_id',
      'p_lease_seconds',
      'p_storage_epoch',
    ],
    sp_storage_complete_v1: [
      'p_intent_id',
      'p_lease_token',
      'p_execution_fence',
      'p_storage_epoch',
      'p_outcome',
      'p_result_code',
      'p_last_error',
      'p_retry_after_seconds',
    ],
  };
  const routineRows: unknown = await queryRunner.query(
    `SELECT ROUTINE_NAME AS name,ROUTINE_TYPE AS routineType,
            SQL_DATA_ACCESS AS dataAccess,SECURITY_TYPE AS securityType
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA=DATABASE()
        AND ROUTINE_NAME LIKE 'sp_storage_%_v1'
      ORDER BY ROUTINE_NAME`,
  );
  if (!Array.isArray(routineRows)) {
    violations.push('storage routines: inspection');
    return;
  }
  const names = Object.keys(expectedParameters).sort();
  const actualNames = routineRows.map((row) => read(row, 'name'));
  if (JSON.stringify(actualNames) !== JSON.stringify(names)) {
    violations.push('storage routines: names');
    return;
  }
  for (const row of routineRows) {
    const name = read(row, 'name');
    if (
      read(row, 'routineType') !== 'PROCEDURE' ||
      read(row, 'dataAccess') !== 'MODIFIES SQL DATA' ||
      read(row, 'securityType') !== 'DEFINER'
    ) {
      violations.push(`${name}: metadata`);
      continue;
    }
    const parameterRows: unknown = await queryRunner.query(
      `SELECT PARAMETER_NAME AS name
         FROM information_schema.PARAMETERS
        WHERE SPECIFIC_SCHEMA=DATABASE() AND SPECIFIC_NAME=?
        ORDER BY ORDINAL_POSITION`,
      [name],
    );
    if (
      !Array.isArray(parameterRows) ||
      JSON.stringify(parameterRows.map((value) => read(value, 'name'))) !==
        JSON.stringify(expectedParameters[name])
    ) {
      violations.push(`${name}: parameters`);
    }
    const show: unknown = await queryRunner.query(
      `SHOW CREATE PROCEDURE \`${name}\``,
    );
    const create =
      Array.isArray(show) && show.length === 1
        ? read(show[0], 'Create Procedure')
        : '';
    const expectedDigest =
      requestRoutines === 'legacy' && LEGACY_REQUEST_DDL_SHA256[name]
        ? LEGACY_REQUEST_DDL_SHA256[name]
        : AUTHORITY_DDL_SHA256[name];
    if (authoritySqlDigest(create, database) !== expectedDigest) {
      violations.push(`${name}: show create`);
    }
  }
}

async function validateAuthorityRoles(
  queryRunner: QueryRunner,
  violations: string[],
  database: string,
): Promise<void> {
  const expected: Readonly<Record<string, readonly string[]>> = {
    wa_app_role_v1: [
      'sp_storage_request_abort_promotion_v1',
      'sp_storage_request_delete_blob_v1',
      'sp_storage_request_delete_quarantine_v1',
      'sp_storage_request_promote_v1',
    ],
    wa_storage_broker_role_v1: [
      'sp_storage_claim_v1',
      'sp_storage_complete_v1',
    ],
  };
  for (const [role, routines] of Object.entries(expected)) {
    const rows: unknown = await queryRunner.query(`SHOW GRANTS FOR '${role}'`);
    const grants = (
      Array.isArray(rows)
        ? rows.map((row) =>
            normalizeAuthoritySql(
              String(Object.values(row as Record<string, unknown>)[0] ?? ''),
              database,
            ),
          )
        : []
    )
      .filter((grant) => grant.includes('<schema>.'))
      .sort();
    const expectedGrants = routines.map(
      (routine) =>
        `grant execute on procedure <schema>.${routine} to ${role}@%`,
    );
    if (role === 'wa_storage_broker_role_v1') {
      expectedGrants.push(
        'grant select on <schema>.v_storage_intent_execution_v1 to wa_storage_broker_role_v1@%',
      );
    }
    expectedGrants.sort();
    if (JSON.stringify(grants) !== JSON.stringify(expectedGrants)) {
      violations.push(`${role}: grants`);
    }
  }
}

async function validateColumns(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,
            COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS defaultValue,EXTRA AS extra,
            CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN (?,?,?)
      ORDER BY TABLE_NAME,ORDINAL_POSITION`,
    [...STORAGE_AUTHORITY_TABLES],
  );
  if (!Array.isArray(rows)) {
    violations.push('storage columns: inspection');
    return;
  }
  for (const table of STORAGE_AUTHORITY_TABLES) {
    const actual = rows
      .filter((row) => read(row, 'tableName') === table)
      .map((row) => ({
        name: read(row, 'name'),
        type: read(row, 'type'),
        nullable: read(row, 'nullable'),
        defaultValue: nullableString(readUnknown(row, 'defaultValue')),
        extra: read(row, 'extra'),
        charset: nullableString(readUnknown(row, 'charset')),
        collation: nullableString(readUnknown(row, 'collation')),
      }));
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_COLUMNS[table])) {
      violations.push(`${table}: columns`);
    }
  }
}

async function validateIndexes(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,
            NON_UNIQUE AS nonUnique,INDEX_TYPE AS type,
            SEQ_IN_INDEX AS position,COLUMN_NAME AS columnName
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN (?,?,?)
      ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
    [...STORAGE_AUTHORITY_TABLES],
  );
  if (!Array.isArray(rows)) {
    violations.push('storage indexes: inspection');
    return;
  }
  for (const table of STORAGE_AUTHORITY_TABLES) {
    const actual = rows
      .filter((row) => read(row, 'tableName') === table)
      .map((row) => ({
        name: read(row, 'name'),
        nonUnique: Number(readUnknown(row, 'nonUnique')),
        type: read(row, 'type'),
        position: Number(readUnknown(row, 'position')),
        column: read(row, 'columnName'),
      }));
    if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_INDEXES[table])) {
      violations.push(`${table}: indexes`);
    }
  }
}

async function validateForeignKeys(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT kcu.TABLE_NAME AS tableName,
            kcu.CONSTRAINT_NAME AS name,
            kcu.ORDINAL_POSITION AS position,
            kcu.POSITION_IN_UNIQUE_CONSTRAINT AS referencedPosition,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_NAME AS referencedTable,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumn,
            rc.DELETE_RULE AS deleteRule,rc.UPDATE_RULE AS updateRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME=kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA=DATABASE()
        AND kcu.TABLE_NAME IN ('storage_objects',
                               'storage_operation_intents')
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.TABLE_NAME,kcu.CONSTRAINT_NAME,kcu.ORDINAL_POSITION`,
  );
  if (!Array.isArray(rows)) {
    violations.push('storage foreign keys: inspection');
    return;
  }
  for (const table of [
    'storage_objects',
    'storage_operation_intents',
  ] as const) {
    const actual = rows
      .filter((row) => read(row, 'tableName') === table)
      .map((row) => ({
        name: read(row, 'name'),
        position: Number(readUnknown(row, 'position')),
        referencedPosition: Number(readUnknown(row, 'referencedPosition')),
        column: read(row, 'columnName'),
        referencedTable: read(row, 'referencedTable'),
        referencedColumn: read(row, 'referencedColumn'),
        deleteRule: read(row, 'deleteRule'),
        updateRule: read(row, 'updateRule'),
      }));
    const expected = EXPECTED_FOREIGN_KEYS[table].map((row) => ({
      ...row,
      deleteRule: 'RESTRICT',
      updateRule: 'RESTRICT',
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(`${table}: foreign keys`);
    }
  }
}

async function validateChecks(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT tc.TABLE_NAME AS tableName,tc.CONSTRAINT_NAME AS name,
            tc.ENFORCED AS enforced,cc.CHECK_CLAUSE AS clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA=DATABASE()
        AND tc.TABLE_NAME IN (?,?,?)
        AND tc.CONSTRAINT_TYPE='CHECK'
      ORDER BY tc.TABLE_NAME,tc.CONSTRAINT_NAME`,
    [...STORAGE_AUTHORITY_TABLES],
  );
  if (!Array.isArray(rows)) {
    violations.push('storage checks: inspection');
    return;
  }
  const expectedByTable: Readonly<Record<string, readonly string[]>> = {
    storage_control: [
      'chk_storage_control_contract',
      'chk_storage_control_singleton',
    ],
    storage_objects: ['chk_storage_objects_state'],
    storage_operation_intents: [
      'chk_storage_operation_intents_authorization',
      'chk_storage_operation_intents_kind',
      'chk_storage_operation_intents_shape',
      'chk_storage_operation_intents_status',
    ],
  };
  for (const table of STORAGE_AUTHORITY_TABLES) {
    const actual = rows
      .filter((row) => read(row, 'tableName') === table)
      .map((row) => ({
        name: read(row, 'name'),
        enforced: read(row, 'enforced'),
        clause: normalizeSql(read(row, 'clause')),
      }));
    const expected = expectedByTable[table].map((name) => ({
      name,
      enforced: 'YES',
      clause: normalizeSql(EXPECTED_CHECKS[name]),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      violations.push(`${table}: checks`);
    }
  }
}

async function validateAuxiliaryObjects(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const columns: unknown = await queryRunner.query(
    `SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,
            COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND ((TABLE_NAME='source_files'
              AND COLUMN_NAME IN ('deleted_at','deleted_by'))
          OR (TABLE_NAME='file_upload_outbox'
              AND COLUMN_NAME='storage_intent_id'))
      ORDER BY TABLE_NAME,ORDINAL_POSITION`,
  );
  const actualColumns = Array.isArray(columns)
    ? columns.map((row) => ({
        tableName: read(row, 'tableName'),
        name: read(row, 'name'),
        type: read(row, 'type'),
        nullable: read(row, 'nullable'),
        charset: nullableString(readUnknown(row, 'charset')),
        collation: nullableString(readUnknown(row, 'collation')),
      }))
    : [];
  const expectedColumns = [
    {
      tableName: 'file_upload_outbox',
      name: 'storage_intent_id',
      type: 'varchar(36)',
      nullable: 'YES',
      charset: UTF8,
      collation: UTF8_COLLATION,
    },
    {
      tableName: 'source_files',
      name: 'deleted_at',
      type: 'datetime(6)',
      nullable: 'YES',
      charset: null,
      collation: null,
    },
    {
      tableName: 'source_files',
      name: 'deleted_by',
      type: 'varchar(36)',
      nullable: 'YES',
      charset: UTF8,
      collation: UTF8_COLLATION,
    },
  ];
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    violations.push('storage auxiliary: columns');
  }

  const constraints: unknown = await queryRunner.query(
    `SELECT tc.TABLE_NAME AS tableName,tc.CONSTRAINT_NAME AS name,
            tc.CONSTRAINT_TYPE AS constraintType,
            COALESCE(rc.DELETE_RULE,'') AS deleteRule,
            COALESCE(rc.UPDATE_RULE,'') AS updateRule,
            COALESCE(cc.CHECK_CLAUSE,'') AS clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME=tc.TABLE_NAME
        AND rc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
       LEFT JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA=DATABASE()
        AND tc.CONSTRAINT_NAME IN
          ('chk_source_files_tombstone',
           'source_files_deleted_by_fkey',
           'chk_file_upload_outbox_storage_intent',
           'file_upload_outbox_storage_intent_fkey')
      ORDER BY tc.TABLE_NAME,tc.CONSTRAINT_NAME`,
  );
  const actualConstraints = Array.isArray(constraints)
    ? constraints.map((row) => ({
        tableName: read(row, 'tableName'),
        name: read(row, 'name'),
        constraintType: read(row, 'constraintType'),
        deleteRule: read(row, 'deleteRule'),
        updateRule: read(row, 'updateRule'),
        clause: normalizeSql(read(row, 'clause')),
      }))
    : [];
  const expectedConstraints = [
    {
      tableName: 'file_upload_outbox',
      name: 'chk_file_upload_outbox_storage_intent',
      constraintType: 'CHECK',
      deleteRule: '',
      updateRule: '',
      clause: normalizeSql(`
        (status='storage_preparing' and storage_intent_id is null)
        or (status='storage_pending' and storage_intent_id is not null)
        or (status in ('pending','published') and storage_intent_id is null)
      `),
    },
    {
      tableName: 'file_upload_outbox',
      name: 'file_upload_outbox_storage_intent_fkey',
      constraintType: 'FOREIGN KEY',
      deleteRule: 'RESTRICT',
      updateRule: 'RESTRICT',
      clause: '',
    },
    {
      tableName: 'source_files',
      name: 'chk_source_files_tombstone',
      constraintType: 'CHECK',
      deleteRule: '',
      updateRule: '',
      clause: normalizeSql(`
        (deleted_at is null and deleted_by is null)
        or (deleted_at is not null and deleted_by is not null)
      `),
    },
    {
      tableName: 'source_files',
      name: 'source_files_deleted_by_fkey',
      constraintType: 'FOREIGN KEY',
      deleteRule: 'RESTRICT',
      updateRule: 'RESTRICT',
      clause: '',
    },
  ];
  if (
    JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)
  ) {
    violations.push('storage auxiliary: constraints');
  }

  const indexes: unknown = await queryRunner.query(
    `SELECT TABLE_NAME AS tableName,INDEX_NAME AS name,
            NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,
            COLUMN_NAME AS columnName
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE()
        AND INDEX_NAME IN
          ('idx_file_upload_outbox_storage_intent',
           'idx_source_files_project_deleted',
           'source_files_deleted_by_fkey',
           'uq_source_files_project_id')
      ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX`,
  );
  const actualIndexes = Array.isArray(indexes)
    ? indexes.map((row) => ({
        tableName: read(row, 'tableName'),
        name: read(row, 'name'),
        nonUnique: Number(readUnknown(row, 'nonUnique')),
        position: Number(readUnknown(row, 'position')),
        columnName: read(row, 'columnName'),
      }))
    : [];
  const expectedIndexes = [
    auxiliaryIndex(
      'file_upload_outbox',
      'idx_file_upload_outbox_storage_intent',
      1,
      1,
      'storage_intent_id',
    ),
    auxiliaryIndex(
      'source_files',
      'idx_source_files_project_deleted',
      1,
      1,
      'project_id',
    ),
    auxiliaryIndex(
      'source_files',
      'idx_source_files_project_deleted',
      1,
      2,
      'deleted_at',
    ),
    auxiliaryIndex(
      'source_files',
      'idx_source_files_project_deleted',
      1,
      3,
      'id',
    ),
    auxiliaryIndex(
      'source_files',
      'source_files_deleted_by_fkey',
      1,
      1,
      'deleted_by',
    ),
    auxiliaryIndex(
      'source_files',
      'uq_source_files_project_id',
      0,
      1,
      'project_id',
    ),
    auxiliaryIndex('source_files', 'uq_source_files_project_id', 0, 2, 'id'),
  ];
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    violations.push('storage auxiliary: indexes');
  }
}

async function validateTerminalTrigger(
  queryRunner: QueryRunner,
  violations: string[],
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT TRIGGER_NAME AS name,ACTION_TIMING AS timing,
            EVENT_MANIPULATION AS eventName,
            ACTION_STATEMENT AS statement
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA=DATABASE()
        AND EVENT_OBJECT_TABLE='storage_operation_intents'
      ORDER BY TRIGGER_NAME`,
  );
  const actual = Array.isArray(rows)
    ? rows.map((row) => ({
        name: read(row, 'name'),
        timing: read(row, 'timing'),
        eventName: read(row, 'eventName'),
        statement: normalizeSql(read(row, 'statement')),
      }))
    : [];
  const expected = [
    {
      name: 'trg_storage_operation_intents_terminal_bu',
      timing: 'BEFORE',
      eventName: 'UPDATE',
      statement: normalizeSql(`
        BEGIN
          IF OLD.status IN ('SUCCEEDED','REJECTED') THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT='STORAGE_INTENT_TERMINAL_IMMUTABLE';
          END IF;
        END
      `),
    },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violations.push('storage_operation_intents: trigger');
  }
}

function column(
  name: string,
  type: string,
  nullable = false,
  defaultValue: string | null = null,
  extra = '',
  charset: string | null = null,
): ExpectedColumn {
  return {
    name,
    type,
    nullable: nullable ? 'YES' : 'NO',
    defaultValue,
    extra,
    charset,
    collation:
      charset === ASCII
        ? ASCII_COLLATION
        : charset === UTF8
          ? UTF8_COLLATION
          : null,
  };
}

function index(
  name: string,
  nonUnique: 0 | 1,
  position: number,
  columnName: string,
): ExpectedIndexColumn {
  return { name, nonUnique, type: 'BTREE', position, column: columnName };
}

function foreignKey(
  name: string,
  position: number,
  referencedPosition: number,
  columnName: string,
  referencedTable: string,
  referencedColumn: string,
): ExpectedForeignKeyColumn {
  return {
    name,
    position,
    referencedPosition,
    column: columnName,
    referencedTable,
    referencedColumn,
  };
}

function auxiliaryIndex(
  tableName: string,
  name: string,
  nonUnique: number,
  position: number,
  columnName: string,
): Record<string, string | number> {
  return { tableName, name, nonUnique, position, columnName };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function read(value: unknown, key: string): string {
  const record = value as Record<string, unknown>;
  return String(record[key] ?? '');
}

function readUnknown(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

async function inspectCurrentDatabase(
  queryRunner: QueryRunner,
): Promise<string | null> {
  const rows: unknown = await queryRunner.query(
    'SELECT DATABASE() AS databaseName',
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof (rows[0] as Record<string, unknown>).databaseName !== 'string'
  ) {
    return null;
  }
  return String(
    (rows[0] as Record<string, unknown>).databaseName,
  ).toLowerCase();
}

function authoritySqlDigest(value: string, database: string): string {
  return createHash('sha256')
    .update(normalizeAuthoritySql(value, database))
    .digest('hex');
}

function normalizeAuthoritySql(value: string, database: string): string {
  return value
    .replaceAll('`', '')
    .replace(/_(?:utf8mb4|ascii)/gi, '')
    .replaceAll("\\'", "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/definer=[^ ]+/, 'definer=<definer>')
    .replaceAll(`${database}.`, '<schema>.');
}

function normalizeSql(value: string): string {
  let normalized = value
    .replaceAll('`', '')
    .replace(/_(?:utf8mb4|ascii)/gi, '')
    .replaceAll("\\'", "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  let previous = '';
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(
      /\(([a-z_][a-z0-9_]*\s+in\s*\([^()]*\))\)/g,
      '$1',
    );
    normalized = normalized.replace(
      /\(([^()]+)\)/g,
      (match: string, inner: string, offset: number, source: string) => {
        if (/\b(?:and|or)\b/.test(inner)) return match;
        const prefix = source.slice(0, offset).trimEnd();
        return prefix.endsWith(' in') ? match : inner;
      },
    );
  }
  while (hasOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized
    .replace(/\s*([(),=<>;])\s*/g, '$1')
    .replace(/\s+(and|or|in|is|not|null|then|set)\s+/g, ' $1 ');
}

function hasOuterParentheses(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  let quote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && value[index - 1] !== '\\') quote = !quote;
    if (quote) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0 && !quote;
}
