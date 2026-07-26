import type { MigrationInterface, QueryRunner } from 'typeorm';
import { findStorageSchemaContractViolations } from './support/storage-schema-contract';

const STORAGE_INTENT_SHAPE = `
  (
    (
      (kind='PROMOTE' AND quarantine_key IS NOT NULL
        AND authorization_kind='UPLOAD_COMMIT')
      OR
      (kind='DELETE_QUARANTINE' AND quarantine_key IS NOT NULL
        AND authorization_kind IN ('UPLOAD_COMMIT','MOVE_ABORT'))
      OR
      (kind='DELETE_BLOB' AND quarantine_key IS NULL
        AND authorization_kind='SOURCE_FILE_TOMBSTONE')
      OR
      (kind='ABORT_PROMOTION' AND quarantine_key IS NOT NULL
        AND authorization_kind='MOVE_ABORT')
    )
    AND
    (
      (status='PENDING' AND lease_token IS NULL
        AND lease_expires_at IS NULL AND completed_at IS NULL
        AND result_code IS NULL AND next_attempt_at IS NULL
        AND last_error IS NULL AND execution_fence=0)
      OR
      (status='EXECUTING' AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL AND completed_at IS NULL
        AND result_code IS NULL AND next_attempt_at IS NULL
        AND last_error IS NULL AND execution_fence>0 AND attempts>0)
      OR
      (status='RETRY' AND lease_token IS NULL
        AND lease_expires_at IS NULL AND completed_at IS NULL
        AND result_code IS NULL AND next_attempt_at IS NOT NULL
        AND last_error IS NOT NULL AND attempts>0)
      OR
      (status='SUCCEEDED' AND lease_token IS NULL
        AND lease_expires_at IS NULL AND completed_at IS NOT NULL
        AND result_code IS NOT NULL AND next_attempt_at IS NULL
        AND last_error IS NULL AND execution_fence>0 AND attempts>0)
      OR
      (status='REJECTED' AND lease_token IS NULL
        AND lease_expires_at IS NULL AND completed_at IS NOT NULL
        AND result_code IS NOT NULL AND next_attempt_at IS NULL
        AND execution_fence>0 AND attempts>0)
    )
  )
`;

export class CreateStorageBrokerAuthority1713400000000
  implements MigrationInterface
{
  name = 'CreateStorageBrokerAuthority1713400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await assertPrerequisites(queryRunner);
    await addSourceFileDormantColumns(queryRunner);
    await createStorageTables(queryRunner);
    await addOutboxDormantColumn(queryRunner);
    await createTerminalTrigger(queryRunner);

    const violations =
      await findStorageSchemaContractViolations(queryRunner);
    if (violations.length > 0) {
      throw new Error(
        `STORAGE_SCHEMA_RECONCILIATION_REQUIRED:${violations[0]}`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error('STORAGE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
  }
}

async function assertPrerequisites(queryRunner: QueryRunner): Promise<void> {
  for (const table of [
    'users',
    'projects',
    'source_files',
    'file_upload_outbox',
  ]) {
    if (!(await queryRunner.hasTable(table))) {
      throw new Error(`STORAGE_SCHEMA_RECONCILIATION_REQUIRED:${table}`);
    }
  }
}

async function addSourceFileDormantColumns(
  queryRunner: QueryRunner,
): Promise<void> {
  if (!(await queryRunner.hasColumn('source_files', 'deleted_at'))) {
    await queryRunner.query(
      `ALTER TABLE source_files
         ADD COLUMN deleted_at DATETIME(6) NULL AFTER error_message`,
    );
  }
  if (!(await queryRunner.hasColumn('source_files', 'deleted_by'))) {
    await queryRunner.query(
      `ALTER TABLE source_files
         ADD COLUMN deleted_by VARCHAR(36) NULL AFTER deleted_at`,
    );
  }
  await addCheckIfMissing(
    queryRunner,
    'source_files',
    'chk_source_files_tombstone',
    `ALTER TABLE source_files
       ADD CONSTRAINT chk_source_files_tombstone
       CHECK (
         (deleted_at IS NULL AND deleted_by IS NULL)
         OR
         (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
       )`,
  );
  await addIndexIfMissing(
    queryRunner,
    'source_files',
    'uq_source_files_project_id',
    `CREATE UNIQUE INDEX uq_source_files_project_id
       ON source_files(project_id,id)`,
  );
  await addIndexIfMissing(
    queryRunner,
    'source_files',
    'idx_source_files_project_deleted',
    `CREATE INDEX idx_source_files_project_deleted
       ON source_files(project_id,deleted_at,id)`,
  );
  await addForeignKeyIfMissing(
    queryRunner,
    'source_files_deleted_by_fkey',
    `ALTER TABLE source_files
       ADD CONSTRAINT source_files_deleted_by_fkey
       FOREIGN KEY (deleted_by) REFERENCES users(id)
       ON DELETE RESTRICT ON UPDATE RESTRICT`,
  );
}

async function createStorageTables(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE TABLE IF NOT EXISTS storage_control (
      singleton_id TINYINT UNSIGNED NOT NULL,
      active_epoch CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      broker_contract_version VARCHAR(64)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      activated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      PRIMARY KEY (singleton_id),
      UNIQUE KEY uq_storage_control_active_epoch (active_epoch),
      CONSTRAINT chk_storage_control_singleton CHECK (singleton_id=1),
      CONSTRAINT chk_storage_control_contract
        CHECK (broker_contract_version='storage-broker.v1')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci
  `);

  await queryRunner.query(`
    CREATE TABLE IF NOT EXISTS storage_objects (
      id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      source_file_id VARCHAR(36) NOT NULL,
      generation BIGINT UNSIGNED NOT NULL,
      storage_key VARCHAR(512)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      checksum_sha256 CHAR(64)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      byte_size BIGINT UNSIGNED NOT NULL,
      state VARCHAR(32)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (id),
      UNIQUE KEY uq_storage_objects_key (storage_key),
      UNIQUE KEY uq_storage_objects_file_generation
        (source_file_id,generation),
      UNIQUE KEY uq_storage_objects_intent_identity
        (id,project_id,generation,storage_key),
      CONSTRAINT chk_storage_objects_state
        CHECK (state IN ('STAGING','AVAILABLE','DELETE_PENDING','DELETED')),
      CONSTRAINT storage_objects_project_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT storage_objects_project_file_fkey
        FOREIGN KEY (project_id,source_file_id)
        REFERENCES source_files(project_id,id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci
  `);

  await queryRunner.query(`
    CREATE TABLE IF NOT EXISTS storage_operation_intents (
      id VARCHAR(36) NOT NULL,
      idempotency_key CHAR(64)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      kind VARCHAR(32)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      object_id VARCHAR(36) NOT NULL,
      object_generation BIGINT UNSIGNED NOT NULL,
      storage_key VARCHAR(512)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      quarantine_key VARCHAR(512)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      expected_sha256 CHAR(64)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      expected_size BIGINT UNSIGNED NOT NULL,
      authorization_kind VARCHAR(32)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      authorization_id VARCHAR(36) NOT NULL,
      storage_epoch CHAR(36)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status VARCHAR(32)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      execution_fence BIGINT UNSIGNED NOT NULL DEFAULT 0,
      lease_token CHAR(36)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      lease_expires_at DATETIME(6) NULL,
      next_attempt_at DATETIME(6) NULL,
      completed_at DATETIME(6) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      result_code VARCHAR(128)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      last_error VARCHAR(128)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
      updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
      PRIMARY KEY (id),
      UNIQUE KEY uq_storage_operation_intents_idempotency (idempotency_key),
      KEY idx_storage_operation_intents_claim
        (status,next_attempt_at,lease_expires_at),
      CONSTRAINT chk_storage_operation_intents_kind
        CHECK (
          kind IN
            ('PROMOTE','DELETE_QUARANTINE','DELETE_BLOB','ABORT_PROMOTION')
        ),
      CONSTRAINT chk_storage_operation_intents_status
        CHECK (
          status IN ('PENDING','EXECUTING','RETRY','SUCCEEDED','REJECTED')
        ),
      CONSTRAINT chk_storage_operation_intents_authorization
        CHECK (
          authorization_kind IN
            ('UPLOAD_COMMIT','SOURCE_FILE_TOMBSTONE','MOVE_ABORT')
        ),
      CONSTRAINT chk_storage_operation_intents_shape
        CHECK (${STORAGE_INTENT_SHAPE}),
      CONSTRAINT storage_operation_intents_project_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT storage_operation_intents_storage_epoch_fkey
        FOREIGN KEY (storage_epoch) REFERENCES storage_control(active_epoch)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT storage_operation_intents_object_fkey
        FOREIGN KEY
          (object_id,project_id,object_generation,storage_key)
        REFERENCES storage_objects(id,project_id,generation,storage_key)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_0900_ai_ci
  `);
}

async function addOutboxDormantColumn(
  queryRunner: QueryRunner,
): Promise<void> {
  if (
    !(await queryRunner.hasColumn(
      'file_upload_outbox',
      'storage_intent_id',
    ))
  ) {
    await queryRunner.query(
      `ALTER TABLE file_upload_outbox
         ADD COLUMN storage_intent_id VARCHAR(36) NULL
         AFTER parse_generation`,
    );
  }
  await queryRunner.query(
    `ALTER TABLE file_upload_outbox
       MODIFY status VARCHAR(20) NOT NULL DEFAULT 'pending'`,
  );
  await addCheckIfMissing(
    queryRunner,
    'file_upload_outbox',
    'chk_file_upload_outbox_storage_intent',
    `ALTER TABLE file_upload_outbox
       ADD CONSTRAINT chk_file_upload_outbox_storage_intent
       CHECK (
         (status='storage_preparing' AND storage_intent_id IS NULL)
         OR
         (status='storage_pending' AND storage_intent_id IS NOT NULL)
         OR
         (status IN ('pending','published') AND storage_intent_id IS NULL)
       )`,
  );
  await addIndexIfMissing(
    queryRunner,
    'file_upload_outbox',
    'idx_file_upload_outbox_storage_intent',
    `CREATE INDEX idx_file_upload_outbox_storage_intent
       ON file_upload_outbox(storage_intent_id)`,
  );
  await addForeignKeyIfMissing(
    queryRunner,
    'file_upload_outbox_storage_intent_fkey',
    `ALTER TABLE file_upload_outbox
       ADD CONSTRAINT file_upload_outbox_storage_intent_fkey
       FOREIGN KEY (storage_intent_id)
       REFERENCES storage_operation_intents(id)
       ON DELETE RESTRICT ON UPDATE RESTRICT`,
  );
}

async function createTerminalTrigger(queryRunner: QueryRunner): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT TRIGGER_NAME
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA=DATABASE()
        AND TRIGGER_NAME='trg_storage_operation_intents_terminal_bu'`,
  );
  if (Array.isArray(rows) && rows.length > 0) return;
  await queryRunner.query(`
    CREATE TRIGGER trg_storage_operation_intents_terminal_bu
    BEFORE UPDATE ON storage_operation_intents
    FOR EACH ROW
    BEGIN
      IF OLD.status IN ('SUCCEEDED','REJECTED') THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_INTENT_TERMINAL_IMMUTABLE';
      END IF;
    END
  `);
}

async function addIndexIfMissing(
  queryRunner: QueryRunner,
  table: string,
  index: string,
  ddl: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME=?
        AND INDEX_NAME=?`,
    [table, index],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    await queryRunner.query(ddl);
  }
}

async function addCheckIfMissing(
  queryRunner: QueryRunner,
  table: string,
  constraint: string,
  ddl: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT CONSTRAINT_NAME
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND TABLE_NAME=?
        AND CONSTRAINT_NAME=?
        AND CONSTRAINT_TYPE='CHECK'`,
    [table, constraint],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    await queryRunner.query(ddl);
  }
}

async function addForeignKeyIfMissing(
  queryRunner: QueryRunner,
  constraint: string,
  ddl: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT CONSTRAINT_NAME
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND CONSTRAINT_NAME=?`,
    [constraint],
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    await queryRunner.query(ddl);
  }
}
