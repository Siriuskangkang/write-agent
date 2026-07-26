import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { DataSource, type QueryRunner } from 'typeorm';
import { CreateStorageBrokerAuthority1713400000000 } from '../../migrations/1713400000000-CreateStorageBrokerAuthority.js';
import { findApplicationSchemaContractViolations } from '../../migrations/support/application-schema-contract.js';
import { findStorageSchemaContractViolations } from '../../migrations/support/storage-schema-contract.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const EPOCH = '55555555-5555-4555-8555-555555555555';
const SHA256 = 'a'.repeat(64);
const STORAGE_KEY = `p/${PROJECT_ID}/f/${FILE_ID}/g/1/${SHA256}.blob`;

const mysqlDescribe =
  process.env.STORAGE_MYSQL_TEST === '1' ? describe : describe.skip;
const schemaName = `storage_authority_${process.pid}_${Date.now()}`;
const host = process.env.STORAGE_MYSQL_HOST || '127.0.0.1';
const port = Number(process.env.STORAGE_MYSQL_PORT || 3306);
const username = process.env.STORAGE_MYSQL_USER || 'root';
const password = process.env.STORAGE_MYSQL_PASSWORD || 'textweaver_root_local';

jest.setTimeout(180_000);

mysqlDescribe('dormant storage authority schema on MySQL 8.4', () => {
  let admin: Connection;
  let dataSource: DataSource;
  let queryRunner: QueryRunner;

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
  });

  beforeEach(async () => {
    await dataSource.query(
      `INSERT INTO users (id,email,password_hash)
       VALUES (?, 'storage-schema@example.test', 'hash')
       ON DUPLICATE KEY UPDATE email=VALUES(email)`,
      [USER_ID],
    );
    await dataSource.query(
      `INSERT INTO projects (id,user_id,name) VALUES (?,?,'Storage schema')
       ON DUPLICATE KEY UPDATE name=VALUES(name)`,
      [PROJECT_ID, USER_ID],
    );
    await dataSource.query(
      `INSERT INTO source_files
         (id,project_id,file_name,file_type,file_path)
       VALUES (?,?,'fixture.md','md','/tmp/fixture.md')
       ON DUPLICATE KEY UPDATE file_name=VALUES(file_name)`,
      [FILE_ID, PROJECT_ID],
    );
  });

  afterEach(async () => {
    for (const table of [
      'file_upload_outbox',
      'storage_operation_intents',
      'storage_objects',
      'storage_control',
      'source_files',
      'projects',
      'users',
    ]) {
      await dataSource.query(`DELETE FROM \`${table}\``).catch(() => undefined);
    }
  });

  afterAll(async () => {
    if (queryRunner?.isReleased === false) await queryRunner.release();
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
      await admin.end();
    }
  });

  it('installs dormant tables without activating an epoch', async () => {
    const tables = await dataSource.query<Array<{ tableName: string }>>(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE()
          AND TABLE_NAME IN
              ('storage_control','storage_objects',
               'storage_operation_intents')
        ORDER BY TABLE_NAME`,
    );
    expect(tables.map((row) => row.tableName)).toEqual([
      'storage_control',
      'storage_objects',
      'storage_operation_intents',
    ]);
    const rows = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_control',
    );
    expect(String(rows[0].count)).toBe('0');
  });

  it('accepts every legal pending operation shape', async () => {
    await insertStorageFixture(dataSource);
    for (const [kind, quarantineKey, authorizationKind] of [
      ['PROMOTE', 'q/promote', 'UPLOAD_COMMIT'],
      ['DELETE_QUARANTINE', 'q/delete', 'MOVE_ABORT'],
      ['DELETE_BLOB', null, 'SOURCE_FILE_TOMBSTONE'],
      ['ABORT_PROMOTION', 'q/abort', 'MOVE_ABORT'],
    ] as const) {
      await expect(
        dataSource.query(
          `INSERT INTO storage_operation_intents
             (id,idempotency_key,kind,project_id,object_id,
              object_generation,storage_key,quarantine_key,
              expected_sha256,expected_size,authorization_kind,
              authorization_id,storage_epoch,status)
           VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,'PENDING')`,
          [
            randomUUID(),
            randomDigest(),
            kind,
            PROJECT_ID,
            OBJECT_ID,
            STORAGE_KEY,
            quarantineKey,
            SHA256,
            '42',
            authorizationKind,
            randomUUID(),
            EPOCH,
          ],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('rejects a promote intent with the wrong same-row shape', async () => {
    await insertStorageFixture(dataSource);
    await expect(
      dataSource.query(
        `INSERT INTO storage_operation_intents
           (id,idempotency_key,kind,project_id,object_id,object_generation,
            storage_key,quarantine_key,expected_sha256,expected_size,
            authorization_kind,authorization_id,storage_epoch,status)
         VALUES (?,?, 'PROMOTE',?,?,1,?,NULL,?,42,
                 'SOURCE_FILE_TOMBSTONE',?,?,'PENDING')`,
        [
          randomUUID(),
          randomDigest(),
          PROJECT_ID,
          OBJECT_ID,
          STORAGE_KEY,
          SHA256,
          randomUUID(),
          EPOCH,
        ],
      ),
    ).rejects.toThrow();
  });

  it('requires an outbox intent exactly in storage_pending', async () => {
    await dataSource.query(
      `INSERT INTO file_upload_outbox
         (id,file_id,project_id,parse_generation,job_id,status)
       VALUES (?,?,?,?,?,'pending')`,
      [randomUUID(), FILE_ID, PROJECT_ID, 1, `file-parse:${FILE_ID}`],
    );
    await expect(
      dataSource.query(
        `UPDATE file_upload_outbox
            SET status='storage_pending',storage_intent_id=NULL
          WHERE file_id=?`,
        [FILE_ID],
      ),
    ).rejects.toThrow();
  });

  it('prevents any mutation of a terminal storage intent', async () => {
    await insertStorageFixture(dataSource);
    const intentId = randomUUID();
    await dataSource.query(
      `INSERT INTO storage_operation_intents
         (id,idempotency_key,kind,project_id,object_id,object_generation,
          storage_key,quarantine_key,expected_sha256,expected_size,
          authorization_kind,authorization_id,storage_epoch,status,
          execution_fence,attempts,completed_at,result_code)
       VALUES (?,?,'DELETE_BLOB',?,?,1,?,NULL,?,42,
               'SOURCE_FILE_TOMBSTONE',?,?,'SUCCEEDED',
               1,1,CURRENT_TIMESTAMP(6),'DELETED')`,
      [
        intentId,
        randomDigest(),
        PROJECT_ID,
        OBJECT_ID,
        STORAGE_KEY,
        SHA256,
        randomUUID(),
        EPOCH,
      ],
    );
    await expect(
      dataSource.query(
        `UPDATE storage_operation_intents
            SET expected_size=43
          WHERE id=?`,
        [intentId],
      ),
    ).rejects.toThrow();
  });

  it('prevents project deletion from bypassing broker-aware tombstones', async () => {
    const rows = await dataSource.query<
      Array<{ deleteRule: string; updateRule: string }>
    >(
      `SELECT DELETE_RULE AS deleteRule,UPDATE_RULE AS updateRule
         FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE()
          AND TABLE_NAME='source_files'
          AND CONSTRAINT_NAME='source_files_project_id_fkey'`,
    );
    expect(rows).toEqual([{ deleteRule: 'RESTRICT', updateRule: 'RESTRICT' }]);
  });

  it('reports no normalized storage schema-contract violations', async () => {
    expect(await findStorageSchemaContractViolations(queryRunner)).toEqual([]);
  });

  it('keeps the whole application schema contract closed after installation', async () => {
    expect(await findApplicationSchemaContractViolations(queryRunner)).toEqual(
      [],
    );
  });

  it('is idempotent without activating storage control', async () => {
    await new CreateStorageBrokerAuthority1713400000000().up(queryRunner);
    const rows = await dataSource.query<Array<{ count: string }>>(
      'SELECT COUNT(*) AS count FROM storage_control',
    );
    expect(String(rows[0].count)).toBe('0');
    expect(await findStorageSchemaContractViolations(queryRunner)).toEqual([]);
  });
});

async function insertStorageFixture(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `INSERT INTO storage_control
       (singleton_id,active_epoch,broker_contract_version)
     VALUES (1,?,'storage-broker.v1')`,
    [EPOCH],
  );
  await dataSource.query(
    `INSERT INTO storage_objects
       (id,project_id,source_file_id,generation,storage_key,
        checksum_sha256,byte_size,state)
     VALUES (?,?,?,1,?,?,42,'STAGING')`,
    [OBJECT_ID, PROJECT_ID, FILE_ID, STORAGE_KEY, SHA256],
  );
}

function randomDigest(): string {
  return Buffer.from(randomUUID()).toString('hex').padEnd(64, '0').slice(0, 64);
}
