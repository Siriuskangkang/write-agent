import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { createConnection, type Connection } from 'mysql2/promise';
import { DataSource, type QueryRunner } from 'typeorm';
import { findStorageAuthorityContractViolations } from '../../migrations/support/storage-schema-contract.js';
import type { StorageOperationPreimageV1 } from './storage-operation.contract.js';
import { StorageReadinessService } from './storage-readiness.service.js';
import { StorageRequestService } from './storage-request.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';
const OUTBOX_ID = '66666666-6666-4666-8666-666666666666';
const EPOCH = '77777777-7777-4777-8777-777777777777';
const OTHER_EPOCH = '88888888-8888-4888-8888-888888888888';
const SHA256 = 'a'.repeat(64);
const STORAGE_KEY = `p/${PROJECT_ID}/f/${FILE_ID}/g/1/${SHA256}.blob`;

const mysqlDescribe =
  process.env.STORAGE_MYSQL_TEST === '1' ? describe : describe.skip;
const schemaName = `storage_routines_${process.pid}_${Date.now()}`;
const host = process.env.STORAGE_MYSQL_HOST || '127.0.0.1';
const port = Number(process.env.STORAGE_MYSQL_PORT || 3306);
const username = process.env.STORAGE_MYSQL_USER || 'root';
const password = process.env.STORAGE_MYSQL_PASSWORD || 'textweaver_root_local';

jest.setTimeout(180_000);

mysqlDescribe('dormant fenced storage authority on MySQL 8.4', () => {
  let admin: Connection;
  let dataSource: DataSource;
  let queryRunner: QueryRunner;
  let requests: StorageRequestService;

  beforeAll(async () => {
    admin = await createConnection({ host, port, user: username, password });
    await admin.query(
      `CREATE DATABASE \`${schemaName}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    dataSource = new DataSource({
      type: 'mysql',
      host,
      port,
      username,
      password,
      database: schemaName,
      charset: 'utf8mb4',
      timezone: '+08:00',
      migrations: [path.join(__dirname, '../../migrations/*{.ts,.js}')],
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    requests = new StorageRequestService();
  });

  beforeEach(async () => {
    await resetFixture(dataSource);
  });

  afterAll(async () => {
    if (queryRunner?.isReleased === false) await queryRunner.release();
    if (dataSource?.isInitialized) {
      await revokeFixtureRoleGrants(dataSource);
      await dataSource.destroy();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
      await admin.end();
    }
  });

  it('installs routines and roles without activating storage control', async () => {
    await dataSource.query('DELETE FROM storage_control');
    const rows = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_control',
    );
    expect(String(rows[0].count)).toBe('0');

    const routines = await dataSource.query<Array<{ name: string }>>(
      `SELECT ROUTINE_NAME AS name
         FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA=DATABASE()
        ORDER BY ROUTINE_NAME`,
    );
    expect(routines.map((row) => row.name)).toEqual([
      'sp_storage_claim_v1',
      'sp_storage_complete_v1',
      'sp_storage_request_abort_promotion_v1',
      'sp_storage_request_delete_blob_v1',
      'sp_storage_request_delete_quarantine_v1',
      'sp_storage_request_promote_v1',
    ]);
  });

  it('proves broker readiness only with the exact authority and control row', async () => {
    const values: Record<string, string> = {
      STORAGE_AUTHORITY_MODE: 'broker',
      STORAGE_PROTECTED_ROOT: '/var/db/textweaver/storage',
      STORAGE_QUARANTINE_ROOT: '/var/db/textweaver/quarantine',
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const readiness = new StorageReadinessService(dataSource, config);

    await expect(readiness.assertReady()).resolves.toEqual({
      storage_epoch: EPOCH,
      storage_contract_version: 'storage-broker.v1',
    });
    await dataSource.query('DELETE FROM storage_control');
    await expect(readiness.assertReady()).rejects.toThrow(
      'STORAGE_AUTHORITY_UNPROVEN',
    );
  });

  it('replays the same request and rejects same-intent different payload', async () => {
    const operation = promoteOperation();
    const first = await requests.request(queryRunner, operation);
    await expect(requests.request(queryRunner, operation)).resolves.toEqual(
      first,
    );
    await expect(
      requests.request(queryRunner, {
        ...operation,
        expected_size_decimal: '43',
      }),
    ).rejects.toThrow('STORAGE_IDEMPOTENCY_MISMATCH');
  });

  it('leaves promotion metadata inside the caller transaction', async () => {
    await queryRunner.startTransaction();
    try {
      await requests.request(queryRunner, promoteOperation());
      const inTransaction = await queryRunner.query<
        Array<{ status: string; storage_intent_id: string | null }>
      >(
        `SELECT status,storage_intent_id
           FROM file_upload_outbox
          WHERE id=?`,
        [OUTBOX_ID],
      );
      expect(inTransaction).toEqual([
        { status: 'storage_pending', storage_intent_id: INTENT_ID },
      ]);
      await queryRunner.rollbackTransaction();
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
    }

    const outbox = await dataSource.query<
      Array<{ status: string; storage_intent_id: string | null }>
    >(
      `SELECT status,storage_intent_id
         FROM file_upload_outbox
        WHERE id=?`,
      [OUTBOX_ID],
    );
    expect(outbox).toEqual([
      { status: 'storage_preparing', storage_intent_id: null },
    ]);
    const objects = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_objects',
    );
    const intents = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_operation_intents',
    );
    expect(String(objects[0].count)).toBe('0');
    expect(String(intents[0].count)).toBe('0');
  });

  it('rolls back a source tombstone and DELETE_BLOB intent together', async () => {
    await dataSource.query(
      `INSERT INTO storage_objects
         (id,project_id,source_file_id,generation,storage_key,
          checksum_sha256,byte_size,state)
       VALUES (?,?,?,?,?,?,?,'AVAILABLE')`,
      [OBJECT_ID, PROJECT_ID, FILE_ID, 1, STORAGE_KEY, SHA256, 42],
    );
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(
        `UPDATE source_files
            SET deleted_at=CURRENT_TIMESTAMP(6),deleted_by=?
          WHERE id=? AND project_id=?`,
        [USER_ID, FILE_ID, PROJECT_ID],
      );
      await requests.request(queryRunner, deleteBlobOperation());
      const inTransaction = await queryRunner.query<Array<{ state: string }>>(
        'SELECT state FROM storage_objects WHERE id=?',
        [OBJECT_ID],
      );
      expect(inTransaction).toEqual([{ state: 'DELETE_PENDING' }]);
      await queryRunner.rollbackTransaction();
    } finally {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
    }

    const sources = await dataSource.query<
      Array<{ deleted_at: Date | null; deleted_by: string | null }>
    >('SELECT deleted_at,deleted_by FROM source_files WHERE id=?', [FILE_ID]);
    expect(sources).toEqual([{ deleted_at: null, deleted_by: null }]);
    const objects = await dataSource.query<Array<{ state: string }>>(
      'SELECT state FROM storage_objects WHERE id=?',
      [OBJECT_ID],
    );
    expect(objects).toEqual([{ state: 'AVAILABLE' }]);
    const intents = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_operation_intents',
    );
    expect(String(intents[0].count)).toBe('0');
  });

  it('rejects an inactive request epoch without creating authority state', async () => {
    await expect(
      requests.request(queryRunner, {
        ...promoteOperation(),
        storage_epoch: OTHER_EPOCH,
      }),
    ).rejects.toThrow('STORAGE_EPOCH_MISMATCH');
    const rows = await dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*) AS count
         FROM storage_objects`,
    );
    expect(String(rows[0].count)).toBe('0');
  });

  it('rejects an inactive claim epoch and an absent lease duration', async () => {
    await requests.request(queryRunner, promoteOperation());
    await expect(
      callOne(queryRunner, 'CALL sp_storage_claim_v1(?,?,?)', [
        'broker-instance-1',
        30,
        OTHER_EPOCH,
      ]),
    ).rejects.toThrow('STORAGE_EPOCH_MISMATCH');
    await expect(
      callOne(queryRunner, 'CALL sp_storage_claim_v1(?,?,?)', [
        'broker-instance-1',
        null,
        EPOCH,
      ]),
    ).rejects.toThrow('STORAGE_CLAIM_INVALID');
  });

  it('claims once with a fresh fence and execution view payload', async () => {
    await requests.request(queryRunner, promoteOperation());
    const claim = await callOne(
      queryRunner,
      'CALL sp_storage_claim_v1(?,?,?)',
      ['broker-instance-1', 30, EPOCH],
    );

    expect(claim).toMatchObject({
      intent_id: INTENT_ID,
      kind: 'PROMOTE',
      project_id: PROJECT_ID,
      source_file_id: FILE_ID,
      object_id: OBJECT_ID,
      object_generation: '1',
      storage_key: STORAGE_KEY,
      status: 'EXECUTING',
      execution_fence: '1',
      storage_epoch: EPOCH,
    });
    expect(claim.lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('loses a stale completion fence without changing object state', async () => {
    await requests.request(queryRunner, promoteOperation());
    const claim = await callOne(
      queryRunner,
      'CALL sp_storage_claim_v1(?,?,?)',
      ['broker-instance-1', 30, EPOCH],
    );

    await expect(
      callOne(queryRunner, 'CALL sp_storage_complete_v1(?,?,?,?,?,?,?,?)', [
        INTENT_ID,
        claim.lease_token,
        '0',
        EPOCH,
        'SUCCEEDED',
        'PROMOTED',
        null,
        null,
      ]),
    ).rejects.toThrow('STORAGE_FENCE_LOST');
    const objects = await dataSource.query<Array<{ state: string }>>(
      'SELECT state FROM storage_objects WHERE id=?',
      [OBJECT_ID],
    );
    expect(objects).toEqual([{ state: 'STAGING' }]);
  });

  it('atomically exposes a promoted object and releases the parse outbox', async () => {
    await requests.request(queryRunner, promoteOperation());
    const claim = await callOne(
      queryRunner,
      'CALL sp_storage_claim_v1(?,?,?)',
      ['broker-instance-1', 30, EPOCH],
    );
    const completed = await callOne(
      queryRunner,
      'CALL sp_storage_complete_v1(?,?,?,?,?,?,?,?)',
      [
        INTENT_ID,
        claim.lease_token,
        claim.execution_fence,
        EPOCH,
        'SUCCEEDED',
        'PROMOTED',
        null,
        null,
      ],
    );

    expect(completed).toEqual({
      intent_id: INTENT_ID,
      status: 'SUCCEEDED',
      object_state: 'AVAILABLE',
      outbox_status: 'pending',
      execution_fence: '1',
      result_code: 'PROMOTED',
    });
  });

  it('keeps the trigger exact and reports no authority-contract drift', async () => {
    expect(await findStorageAuthorityContractViolations(queryRunner)).toEqual(
      [],
    );
  });

  it('rejects normalized SHOW CREATE drift instead of accepting fragments', async () => {
    await dataSource.query(
      `ALTER PROCEDURE sp_storage_claim_v1 COMMENT 'contract drift'`,
    );
    await expect(
      findStorageAuthorityContractViolations(queryRunner),
    ).resolves.toContain('sp_storage_claim_v1: show create');
  });
});

function promoteOperation(): StorageOperationPreimageV1 {
  return {
    operation_version: 'storage-operation.v1',
    kind: 'PROMOTE',
    actor_id: USER_ID,
    intent_id: INTENT_ID,
    project_id: PROJECT_ID,
    source_file_id: FILE_ID,
    object_id: OBJECT_ID,
    object_generation_decimal: '1',
    storage_key: STORAGE_KEY,
    quarantine_key: 'q/fixture-upload',
    expected_sha256: SHA256,
    expected_size_decimal: '42',
    authorization_kind: 'UPLOAD_COMMIT',
    authorization_id: OUTBOX_ID,
    storage_epoch: EPOCH,
  };
}

function deleteBlobOperation(): StorageOperationPreimageV1 {
  return {
    operation_version: 'storage-operation.v1',
    kind: 'DELETE_BLOB',
    actor_id: USER_ID,
    intent_id: INTENT_ID,
    project_id: PROJECT_ID,
    source_file_id: FILE_ID,
    object_id: OBJECT_ID,
    object_generation_decimal: '1',
    storage_key: STORAGE_KEY,
    quarantine_key: null,
    expected_sha256: SHA256,
    expected_size_decimal: '42',
    authorization_kind: 'SOURCE_FILE_TOMBSTONE',
    authorization_id: FILE_ID,
    storage_epoch: EPOCH,
  };
}

async function resetFixture(dataSource: DataSource): Promise<void> {
  for (const table of [
    'file_upload_outbox',
    'storage_operation_intents',
    'storage_objects',
    'storage_control',
    'source_files',
    'projects',
    'users',
  ]) {
    await dataSource.query(`DELETE FROM \`${table}\``);
  }
  await dataSource.query(
    `INSERT INTO users (id,email,password_hash)
     VALUES (?,'storage-authority@example.test','hash')`,
    [USER_ID],
  );
  await dataSource.query(
    `INSERT INTO projects (id,user_id,name) VALUES (?,?,'Storage authority')`,
    [PROJECT_ID, USER_ID],
  );
  await dataSource.query(
    `INSERT INTO source_files
       (id,project_id,file_name,file_type,file_size,file_path,checksum_sha256,
        parse_generation,parse_status)
     VALUES (?,?,'fixture.md','md',42,'/tmp/fixture.md',?,1,'pending')`,
    [FILE_ID, PROJECT_ID, SHA256],
  );
  await dataSource.query(
    `INSERT INTO file_upload_outbox
       (id,file_id,project_id,parse_generation,job_id,status)
     VALUES (?,?,?,?,?,'storage_preparing')`,
    [OUTBOX_ID, FILE_ID, PROJECT_ID, 1, `file-parse:${FILE_ID}`],
  );
  await dataSource.query(
    `INSERT INTO storage_control
       (singleton_id,active_epoch,broker_contract_version)
     VALUES (1,?,'storage-broker.v1')`,
    [EPOCH],
  );
}

async function revokeFixtureRoleGrants(dataSource: DataSource): Promise<void> {
  for (const routine of [
    'sp_storage_request_promote_v1',
    'sp_storage_request_delete_quarantine_v1',
    'sp_storage_request_delete_blob_v1',
    'sp_storage_request_abort_promotion_v1',
  ]) {
    await dataSource.query(
      `REVOKE EXECUTE ON PROCEDURE \`${schemaName}\`.\`${routine}\`
         FROM 'wa_app_role_v1'`,
    );
  }
  for (const routine of ['sp_storage_claim_v1', 'sp_storage_complete_v1']) {
    await dataSource.query(
      `REVOKE EXECUTE ON PROCEDURE \`${schemaName}\`.\`${routine}\`
         FROM 'wa_storage_broker_role_v1'`,
    );
  }
  await dataSource.query(
    `REVOKE SELECT ON \`${schemaName}\`.v_storage_intent_execution_v1
       FROM 'wa_storage_broker_role_v1'`,
  );
}

async function callOne(
  queryRunner: QueryRunner,
  sql: string,
  parameters: unknown[],
): Promise<Record<string, string | null>> {
  const result: unknown = await queryRunner.query(sql, parameters);
  const rows =
    Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('EXPECTED_ONE_ROUTINE_RESULT');
  }
  return rows[0] as Record<string, string | null>;
}
