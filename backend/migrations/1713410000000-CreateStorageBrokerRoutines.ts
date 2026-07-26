import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  findStorageAuthorityContractViolations,
  findStorageSchemaContractViolations,
} from './support/storage-schema-contract';

const APP_ROLE = 'wa_app_role_v1';
const BROKER_ROLE = 'wa_storage_broker_role_v1';
const ROUTINES = [
  'sp_storage_request_promote_v1',
  'sp_storage_request_delete_quarantine_v1',
  'sp_storage_request_delete_blob_v1',
  'sp_storage_request_abort_promotion_v1',
  'sp_storage_claim_v1',
  'sp_storage_complete_v1',
] as const;

export class CreateStorageBrokerRoutines1713410000000 implements MigrationInterface {
  name = 'CreateStorageBrokerRoutines1713410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const baseViolations =
      await findStorageSchemaContractViolations(queryRunner);
    if (baseViolations.length > 0) {
      throw new Error(
        `STORAGE_SCHEMA_RECONCILIATION_REQUIRED:${baseViolations[0]}`,
      );
    }

    await installView(queryRunner);
    for (const routine of ROUTINES) {
      await queryRunner.query(`DROP PROCEDURE IF EXISTS \`${routine}\``);
    }
    await queryRunner.query(requestPromoteSql());
    await queryRunner.query(requestDeleteQuarantineSql());
    await queryRunner.query(requestDeleteBlobSql());
    await queryRunner.query(requestAbortPromotionSql());
    await queryRunner.query(claimSql());
    await queryRunner.query(completeSql());
    await installDormantRoles(queryRunner);

    const violations = await findStorageAuthorityContractViolations(
      queryRunner,
      {
        requestRoutines: 'legacy',
      },
    );
    if (violations.length > 0) {
      throw new Error(
        `STORAGE_AUTHORITY_RECONCILIATION_REQUIRED:${violations[0]}`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<never> {
    throw new Error('STORAGE_AUTHORITY_DESTRUCTIVE_ROLLBACK_FORBIDDEN');
  }
}

async function installView(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query(`
    CREATE OR REPLACE
      SQL SECURITY DEFINER
      VIEW v_storage_intent_execution_v1 AS
    SELECT i.id AS intent_id,
           i.kind,
           i.project_id,
           o.source_file_id,
           i.object_id,
           i.object_generation,
           i.storage_key,
           i.quarantine_key,
           i.expected_sha256,
           i.expected_size,
           i.authorization_kind,
           i.authorization_id,
           i.storage_epoch,
           i.status,
           i.execution_fence,
           i.lease_token,
           i.lease_expires_at
      FROM storage_operation_intents i
      JOIN storage_objects o
        ON o.id=i.object_id
       AND o.project_id=i.project_id
       AND o.generation=i.object_generation
       AND o.storage_key=i.storage_key
  `);
}

async function installDormantRoles(queryRunner: QueryRunner): Promise<void> {
  const database = await currentDatabase(queryRunner);
  const schema = quoteIdentifier(database);
  await queryRunner.query(
    `CREATE ROLE IF NOT EXISTS '${APP_ROLE}', '${BROKER_ROLE}'`,
  );
  for (const routine of ROUTINES.slice(0, 4)) {
    await queryRunner.query(
      `GRANT EXECUTE ON PROCEDURE ${schema}.\`${routine}\`
         TO '${APP_ROLE}'`,
    );
  }
  for (const routine of ROUTINES.slice(4)) {
    await queryRunner.query(
      `GRANT EXECUTE ON PROCEDURE ${schema}.\`${routine}\`
         TO '${BROKER_ROLE}'`,
    );
  }
  await queryRunner.query(
    `GRANT SELECT ON ${schema}.v_storage_intent_execution_v1
       TO '${BROKER_ROLE}'`,
  );
}

function requestPromoteSql(): string {
  return requestRoutineSql({
    name: 'sp_storage_request_promote_v1',
    kind: 'PROMOTE',
    parameters: `${commonRequestParameters()},
      IN p_quarantine_key VARCHAR(512),
      ${requestTailParameters()}`,
    quarantineExpression: 'p_quarantine_key',
    authorizationExpression: "'UPLOAD_COMMIT'",
    authorizationCheck: `
      SELECT COUNT(*) INTO v_authorized
        FROM file_upload_outbox
       WHERE id=p_authorization_id
         AND file_id=p_source_file_id
         AND project_id=p_project_id
         AND parse_generation=p_object_generation
         AND status IN ('storage_preparing','storage_pending')
       FOR UPDATE;
      IF v_authorized <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_AUTHORIZATION_INVALID';
      END IF;`,
    allowCreateObject: true,
    beforeInsert: '',
    afterInsert: `
      UPDATE file_upload_outbox
         SET status='storage_pending',storage_intent_id=p_intent_id
       WHERE id=p_authorization_id
         AND file_id=p_source_file_id
         AND project_id=p_project_id
         AND parse_generation=p_object_generation
         AND status='storage_preparing'
         AND storage_intent_id IS NULL;
      IF ROW_COUNT() <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_OUTBOX_STATE_INVALID';
      END IF;`,
  });
}

function requestDeleteQuarantineSql(): string {
  return requestRoutineSql({
    name: 'sp_storage_request_delete_quarantine_v1',
    kind: 'DELETE_QUARANTINE',
    parameters: `${commonRequestParameters()},
      IN p_quarantine_key VARCHAR(512),
      IN p_authorization_kind VARCHAR(32),
      ${requestTailParameters()}`,
    quarantineExpression: 'p_quarantine_key',
    authorizationExpression: 'p_authorization_kind',
    authorizationCheck: moveOrUploadAuthorizationSql(),
    allowCreateObject: false,
    beforeInsert: '',
    afterInsert: '',
  });
}

function requestDeleteBlobSql(): string {
  return requestRoutineSql({
    name: 'sp_storage_request_delete_blob_v1',
    kind: 'DELETE_BLOB',
    parameters: `${commonRequestParameters()},
      ${requestTailParameters()}`,
    quarantineExpression: 'NULL',
    authorizationExpression: "'SOURCE_FILE_TOMBSTONE'",
    authorizationCheck: `
      IF v_source_deleted_at IS NULL
         OR v_source_deleted_by <> p_actor_id
         OR p_authorization_id <> p_source_file_id THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_AUTHORIZATION_INVALID';
      END IF;`,
    allowCreateObject: false,
    beforeInsert: `
      UPDATE storage_objects
         SET state='DELETE_PENDING'
       WHERE id=p_object_id AND state='AVAILABLE';
      IF ROW_COUNT() <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_OBJECT_STATE_INVALID';
      END IF;`,
    afterInsert: '',
  });
}

function requestAbortPromotionSql(): string {
  return requestRoutineSql({
    name: 'sp_storage_request_abort_promotion_v1',
    kind: 'ABORT_PROMOTION',
    parameters: `${commonRequestParameters()},
      IN p_quarantine_key VARCHAR(512),
      ${requestTailParameters()}`,
    quarantineExpression: 'p_quarantine_key',
    authorizationExpression: "'MOVE_ABORT'",
    authorizationCheck: moveAuthorizationSql(),
    allowCreateObject: false,
    beforeInsert: `
      UPDATE storage_objects
         SET state='DELETE_PENDING'
       WHERE id=p_object_id AND state='STAGING';
      IF ROW_COUNT() <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_OBJECT_STATE_INVALID';
      END IF;`,
    afterInsert: '',
  });
}

interface RequestRoutineOptions {
  name: string;
  kind: string;
  parameters: string;
  quarantineExpression: string;
  authorizationExpression: string;
  authorizationCheck: string;
  allowCreateObject: boolean;
  beforeInsert: string;
  afterInsert: string;
}

function requestRoutineSql(options: RequestRoutineOptions): string {
  const createObject = options.allowCreateObject
    ? `
      SELECT COUNT(*) INTO v_object_count
        FROM storage_objects
       WHERE id=p_object_id
       FOR UPDATE;
      IF v_object_count=0 THEN
        INSERT INTO storage_objects
          (id,project_id,source_file_id,generation,storage_key,
           checksum_sha256,byte_size,state)
        VALUES
          (p_object_id,p_project_id,p_source_file_id,p_object_generation,
           p_storage_key,p_expected_sha256,p_expected_size,'STAGING');
      ELSE
        SELECT COUNT(*) INTO v_object_count
          FROM storage_objects
         WHERE id=p_object_id
           AND project_id=p_project_id
           AND source_file_id=p_source_file_id
           AND generation=p_object_generation
           AND storage_key=p_storage_key
           AND checksum_sha256=p_expected_sha256
           AND byte_size=p_expected_size
           AND state IN ('STAGING','AVAILABLE')
         FOR UPDATE;
        IF v_object_count <> 1 THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='STORAGE_IDEMPOTENCY_MISMATCH';
        END IF;
      END IF;`
    : `
      SELECT COUNT(*) INTO v_object_count
        FROM storage_objects
       WHERE id=p_object_id
         AND project_id=p_project_id
         AND source_file_id=p_source_file_id
         AND generation=p_object_generation
         AND storage_key=p_storage_key
         AND checksum_sha256=p_expected_sha256
         AND byte_size=p_expected_size
       FOR UPDATE;
      IF v_object_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_OBJECT_MISMATCH';
      END IF;`;

  return `
    CREATE PROCEDURE ${options.name}(${options.parameters})
    SQL SECURITY DEFINER
    MODIFIES SQL DATA
    proc: BEGIN
      DECLARE v_contract VARCHAR(64);
      DECLARE v_owner_id VARCHAR(36);
      DECLARE v_source_generation BIGINT UNSIGNED;
      DECLARE v_source_deleted_at DATETIME(6);
      DECLARE v_source_deleted_by VARCHAR(36);
      DECLARE v_object_count INT DEFAULT 0;
      DECLARE v_intent_count INT DEFAULT 0;
      DECLARE v_authorized INT DEFAULT 0;
      DECLARE v_existing_id VARCHAR(36);
      DECLARE v_existing_status VARCHAR(32);
      DECLARE v_existing_fence BIGINT UNSIGNED;
      DECLARE v_existing_result VARCHAR(128);
      DECLARE EXIT HANDLER FOR SQLEXCEPTION
      BEGIN
        ROLLBACK;
        RESIGNAL;
      END;

      START TRANSACTION;
      SELECT broker_contract_version INTO v_contract
        FROM storage_control
       WHERE singleton_id=1 AND active_epoch=p_storage_epoch
       FOR UPDATE;
      IF v_contract IS NULL OR v_contract <> 'storage-broker.v1' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_EPOCH_MISMATCH';
      END IF;

      SELECT user_id INTO v_owner_id
        FROM projects
       WHERE id=p_project_id
       FOR UPDATE;
      IF v_owner_id IS NULL OR v_owner_id <> p_actor_id THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_PROJECT_FORBIDDEN';
      END IF;

      SELECT parse_generation,deleted_at,deleted_by
        INTO v_source_generation,v_source_deleted_at,v_source_deleted_by
        FROM source_files
       WHERE id=p_source_file_id AND project_id=p_project_id
       FOR UPDATE;
      IF v_source_generation IS NULL
         OR v_source_generation <> p_object_generation THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_GENERATION_MISMATCH';
      END IF;

      ${createObject}
      ${options.authorizationCheck}

      SELECT COUNT(*) INTO v_intent_count
        FROM storage_operation_intents
       WHERE id=p_intent_id OR idempotency_key=p_idempotency_key
       FOR UPDATE;
      IF v_intent_count > 0 THEN
        SELECT id,status,execution_fence,result_code
          INTO v_existing_id,v_existing_status,
               v_existing_fence,v_existing_result
          FROM storage_operation_intents
         WHERE id=p_intent_id
           AND idempotency_key=p_idempotency_key
           AND kind='${options.kind}'
           AND project_id=p_project_id
           AND object_id=p_object_id
           AND object_generation=p_object_generation
           AND storage_key=p_storage_key
           AND quarantine_key <=> ${options.quarantineExpression}
           AND expected_sha256=p_expected_sha256
           AND expected_size=p_expected_size
           AND authorization_kind=${options.authorizationExpression}
           AND authorization_id=p_authorization_id
           AND storage_epoch=p_storage_epoch
         FOR UPDATE;
        IF v_existing_id IS NULL THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='STORAGE_IDEMPOTENCY_MISMATCH';
        END IF;
        COMMIT;
        SELECT v_existing_id AS intent_id,
               v_existing_status AS status,
               v_existing_fence AS execution_fence,
               v_existing_result AS result_code;
        LEAVE proc;
      END IF;

      ${options.beforeInsert}
      INSERT INTO storage_operation_intents
        (id,idempotency_key,kind,project_id,object_id,object_generation,
         storage_key,quarantine_key,expected_sha256,expected_size,
         authorization_kind,authorization_id,storage_epoch,status)
      VALUES
        (p_intent_id,p_idempotency_key,'${options.kind}',p_project_id,
         p_object_id,p_object_generation,p_storage_key,
         ${options.quarantineExpression},p_expected_sha256,p_expected_size,
         ${options.authorizationExpression},p_authorization_id,
         p_storage_epoch,'PENDING');
      ${options.afterInsert}
      COMMIT;
      SELECT p_intent_id AS intent_id,'PENDING' AS status,
             0 AS execution_fence,NULL AS result_code;
    END
  `;
}

function claimSql(): string {
  return `
    CREATE PROCEDURE sp_storage_claim_v1(
      IN p_instance_id VARCHAR(128),
      IN p_lease_seconds INT UNSIGNED,
      IN p_storage_epoch CHAR(36)
    )
    SQL SECURITY DEFINER
    MODIFIES SQL DATA
    proc: BEGIN
      DECLARE v_contract VARCHAR(64);
      DECLARE v_intent_id VARCHAR(36);
      DECLARE EXIT HANDLER FOR SQLEXCEPTION
      BEGIN
        ROLLBACK;
        RESIGNAL;
      END;

      IF p_instance_id IS NULL OR p_instance_id=''
         OR p_lease_seconds IS NULL
         OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_CLAIM_INVALID';
      END IF;
      START TRANSACTION;
      SELECT broker_contract_version INTO v_contract
        FROM storage_control
       WHERE singleton_id=1 AND active_epoch=p_storage_epoch
       FOR UPDATE;
      IF v_contract IS NULL OR v_contract <> 'storage-broker.v1' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_EPOCH_MISMATCH';
      END IF;

      SET v_intent_id=NULL;
      SELECT id INTO v_intent_id
        FROM storage_operation_intents
       WHERE storage_epoch=p_storage_epoch
         AND (
           status='PENDING'
           OR (status='RETRY' AND next_attempt_at<=CURRENT_TIMESTAMP(6))
           OR (status='EXECUTING'
               AND lease_expires_at<=CURRENT_TIMESTAMP(6))
         )
       ORDER BY created_at,id
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      IF v_intent_id IS NULL THEN
        COMMIT;
        SELECT * FROM v_storage_intent_execution_v1 WHERE 1=0;
        LEAVE proc;
      END IF;

      UPDATE storage_operation_intents
         SET status='EXECUTING',
             execution_fence=execution_fence+1,
             lease_token=LOWER(UUID()),
             lease_expires_at=TIMESTAMPADD(
               SECOND,p_lease_seconds,CURRENT_TIMESTAMP(6)
             ),
             next_attempt_at=NULL,
             attempts=attempts+1,
             result_code=NULL,
             last_error=NULL,
             completed_at=NULL
       WHERE id=v_intent_id;
      COMMIT;
      SELECT * FROM v_storage_intent_execution_v1
       WHERE intent_id=v_intent_id;
    END
  `;
}

function completeSql(): string {
  return `
    CREATE PROCEDURE sp_storage_complete_v1(
      IN p_intent_id VARCHAR(36),
      IN p_lease_token CHAR(36),
      IN p_execution_fence BIGINT UNSIGNED,
      IN p_storage_epoch CHAR(36),
      IN p_outcome VARCHAR(32),
      IN p_result_code VARCHAR(128),
      IN p_last_error VARCHAR(128),
      IN p_retry_after_seconds INT UNSIGNED
    )
    SQL SECURITY DEFINER
    MODIFIES SQL DATA
    proc: BEGIN
      DECLARE v_contract VARCHAR(64);
      DECLARE v_project_id VARCHAR(36);
      DECLARE v_source_file_id VARCHAR(36);
      DECLARE v_object_id VARCHAR(36);
      DECLARE v_generation BIGINT UNSIGNED;
      DECLARE v_kind VARCHAR(32);
      DECLARE v_object_state VARCHAR(32);
      DECLARE v_outbox_status VARCHAR(20);
      DECLARE v_count INT DEFAULT 0;
      DECLARE EXIT HANDLER FOR SQLEXCEPTION
      BEGIN
        ROLLBACK;
        RESIGNAL;
      END;

      IF p_outcome IS NULL
         OR p_outcome NOT IN ('SUCCEEDED','RETRY','REJECTED') THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_COMPLETION_INVALID';
      END IF;
      START TRANSACTION;
      SELECT broker_contract_version INTO v_contract
        FROM storage_control
       WHERE singleton_id=1 AND active_epoch=p_storage_epoch
       FOR UPDATE;
      IF v_contract IS NULL OR v_contract <> 'storage-broker.v1' THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_EPOCH_MISMATCH';
      END IF;

      SELECT COUNT(*) INTO v_count
        FROM storage_operation_intents
       WHERE id=p_intent_id;
      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_FENCE_LOST';
      END IF;
      SELECT i.project_id,o.source_file_id,i.object_id,
             i.object_generation,i.kind
        INTO v_project_id,v_source_file_id,v_object_id,v_generation,v_kind
        FROM storage_operation_intents i
        JOIN storage_objects o ON o.id=i.object_id
       WHERE i.id=p_intent_id;
      SELECT COUNT(*) INTO v_count
        FROM projects WHERE id=v_project_id FOR UPDATE;
      SELECT COUNT(*) INTO v_count
        FROM source_files
       WHERE id=v_source_file_id AND project_id=v_project_id
       FOR UPDATE;
      SELECT state INTO v_object_state
        FROM storage_objects
       WHERE id=v_object_id AND project_id=v_project_id
       FOR UPDATE;
      SELECT COUNT(*) INTO v_count
        FROM storage_operation_intents
       WHERE id=p_intent_id
         AND storage_epoch=p_storage_epoch
         AND status='EXECUTING'
         AND lease_token=p_lease_token
         AND execution_fence=p_execution_fence
       FOR UPDATE;
      IF v_count <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_FENCE_LOST';
      END IF;

      IF p_outcome='SUCCEEDED' THEN
        IF p_result_code IS NULL OR p_last_error IS NOT NULL THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='STORAGE_COMPLETION_INVALID';
        END IF;
        IF v_kind='PROMOTE' THEN
          UPDATE storage_objects
             SET state='AVAILABLE'
           WHERE id=v_object_id AND state='STAGING';
          IF ROW_COUNT() <> 1 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT='STORAGE_OBJECT_STATE_INVALID';
          END IF;
          UPDATE file_upload_outbox
             SET status='pending',
                 storage_intent_id=NULL,
                 lease_owner=NULL,
                 lease_expires_at=NULL,
                 last_error=NULL,
                 next_attempt_at=CURRENT_TIMESTAMP(6)
           WHERE file_id=v_source_file_id
             AND project_id=v_project_id
             AND parse_generation=v_generation
             AND storage_intent_id=p_intent_id
             AND status='storage_pending';
          IF ROW_COUNT() <> 1 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT='STORAGE_OUTBOX_STATE_INVALID';
          END IF;
          SET v_outbox_status='pending';
        ELSEIF v_kind IN ('DELETE_BLOB','ABORT_PROMOTION') THEN
          UPDATE storage_objects
             SET state='DELETED'
           WHERE id=v_object_id AND state='DELETE_PENDING';
          IF ROW_COUNT() <> 1 THEN
            SIGNAL SQLSTATE '45000'
              SET MESSAGE_TEXT='STORAGE_OBJECT_STATE_INVALID';
          END IF;
          SET v_outbox_status=NULL;
        ELSE
          SET v_outbox_status=NULL;
        END IF;
        UPDATE storage_operation_intents
           SET status='SUCCEEDED',lease_token=NULL,lease_expires_at=NULL,
               next_attempt_at=NULL,completed_at=CURRENT_TIMESTAMP(6),
               result_code=p_result_code,last_error=NULL
         WHERE id=p_intent_id AND status='EXECUTING'
           AND lease_token=p_lease_token
           AND execution_fence=p_execution_fence;
      ELSEIF p_outcome='RETRY' THEN
        IF p_last_error IS NULL OR p_result_code IS NOT NULL
           OR p_retry_after_seconds IS NULL
           OR p_retry_after_seconds < 1
           OR p_retry_after_seconds > 86400 THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='STORAGE_COMPLETION_INVALID';
        END IF;
        UPDATE storage_operation_intents
           SET status='RETRY',lease_token=NULL,lease_expires_at=NULL,
               next_attempt_at=TIMESTAMPADD(
                 SECOND,p_retry_after_seconds,CURRENT_TIMESTAMP(6)
               ),
               completed_at=NULL,result_code=NULL,last_error=p_last_error
         WHERE id=p_intent_id AND status='EXECUTING'
           AND lease_token=p_lease_token
           AND execution_fence=p_execution_fence;
        SET v_outbox_status=NULL;
      ELSE
        IF p_result_code IS NULL OR p_retry_after_seconds IS NOT NULL THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='STORAGE_COMPLETION_INVALID';
        END IF;
        UPDATE storage_operation_intents
           SET status='REJECTED',lease_token=NULL,lease_expires_at=NULL,
               next_attempt_at=NULL,completed_at=CURRENT_TIMESTAMP(6),
               result_code=p_result_code,last_error=p_last_error
         WHERE id=p_intent_id AND status='EXECUTING'
           AND lease_token=p_lease_token
           AND execution_fence=p_execution_fence;
        SET v_outbox_status=NULL;
      END IF;
      IF ROW_COUNT() <> 1 THEN
        SIGNAL SQLSTATE '45000'
          SET MESSAGE_TEXT='STORAGE_FENCE_LOST';
      END IF;
      SELECT state INTO v_object_state
        FROM storage_objects WHERE id=v_object_id;
      COMMIT;
      SELECT p_intent_id AS intent_id,p_outcome AS status,
             v_object_state AS object_state,
             v_outbox_status AS outbox_status,
             p_execution_fence AS execution_fence,
             p_result_code AS result_code;
    END
  `;
}

function commonRequestParameters(): string {
  return `
      IN p_actor_id VARCHAR(36),
      IN p_intent_id VARCHAR(36),
      IN p_project_id VARCHAR(36),
      IN p_source_file_id VARCHAR(36),
      IN p_object_id VARCHAR(36),
      IN p_object_generation BIGINT UNSIGNED,
      IN p_storage_key VARCHAR(512)`;
}

function requestTailParameters(): string {
  return `
      IN p_expected_sha256 CHAR(64),
      IN p_expected_size BIGINT UNSIGNED,
      IN p_authorization_id VARCHAR(36),
      IN p_storage_epoch CHAR(36),
      IN p_idempotency_key CHAR(64)`;
}

function moveOrUploadAuthorizationSql(): string {
  return `
    IF p_authorization_kind='UPLOAD_COMMIT' THEN
      SELECT COUNT(*) INTO v_authorized
        FROM file_upload_outbox
       WHERE id=p_authorization_id
         AND file_id=p_source_file_id
         AND project_id=p_project_id
         AND parse_generation=p_object_generation
       FOR UPDATE;
    ELSEIF p_authorization_kind='MOVE_ABORT' THEN
      ${moveAuthorizationBody()}
    ELSE
      SET v_authorized=0;
    END IF;
    IF v_authorized <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT='STORAGE_AUTHORIZATION_INVALID';
    END IF;`;
}

function moveAuthorizationSql(): string {
  return `
    ${moveAuthorizationBody()}
    IF v_authorized <> 1 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT='STORAGE_AUTHORIZATION_INVALID';
    END IF;`;
}

function moveAuthorizationBody(): string {
  return `
    SELECT COUNT(*) INTO v_authorized
      FROM file_move_intents
     WHERE id=p_authorization_id
       AND file_id=p_source_file_id
       AND project_id=p_project_id
       AND user_id=p_actor_id
       AND status IN ('ACTIVE','UNCERTAIN')
     FOR UPDATE;`;
}

async function currentDatabase(queryRunner: QueryRunner): Promise<string> {
  const rows: unknown = await queryRunner.query(
    'SELECT DATABASE() AS databaseName',
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof (rows[0] as Record<string, unknown>).databaseName !== 'string'
  ) {
    throw new Error('STORAGE_AUTHORITY_DATABASE_UNKNOWN');
  }
  return (rows[0] as Record<string, string>).databaseName;
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll('`', '``')}\``;
}
