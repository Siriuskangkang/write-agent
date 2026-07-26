import type { MigrationInterface, QueryRunner } from 'typeorm';

const LEGACY_SNAPSHOT = JSON.stringify({
  allowlisted: false,
  authoring_mode: 'off',
  client_contract_version: null,
  policy_version: 'deterministic-authoring-rollout.v1',
  server_entrypoint: 'legacy_api',
  workflow_definition: 'legacy-generation.v1',
});
const LEGACY_SNAPSHOT_DIGEST =
  '49ec8f642f2f8a3b2e9b62a6e159a2965ff2121bb659b839d0a2159b98489f59';

const JOB_COLUMNS = [
  {
    name: 'workflow_definition',
    add: `VARCHAR(64) NULL`,
    modify: `VARCHAR(64) NOT NULL DEFAULT 'legacy-generation.v1'`,
  },
  {
    name: 'authoring_mode',
    add: `VARCHAR(32) NULL`,
    modify: `VARCHAR(32) NOT NULL DEFAULT 'off'`,
  },
  {
    name: 'rollout_policy_version',
    add: `VARCHAR(64) NULL`,
    modify: `VARCHAR(64) NOT NULL
      DEFAULT 'deterministic-authoring-rollout.v1'`,
  },
  {
    name: 'rollout_policy_snapshot',
    add: `JSON NULL`,
    modify: `JSON NOT NULL DEFAULT (
      JSON_OBJECT(
        'allowlisted', FALSE,
        'authoring_mode', 'off',
        'client_contract_version', NULL,
        'policy_version', 'deterministic-authoring-rollout.v1',
        'server_entrypoint', 'internal',
        'workflow_definition', 'legacy-generation.v1'
      )
    )`,
  },
  {
    name: 'rollout_policy_digest',
    add: `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL`,
    modify: `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
      DEFAULT 'c1adc9f68d2beeed60cc2fba62809860295b11179900be517f79190d3f5fe92c'`,
  },
  {
    name: 'server_entrypoint',
    add: `VARCHAR(32) NULL`,
    modify: `VARCHAR(32) NOT NULL DEFAULT 'internal'`,
  },
  {
    name: 'client_contract_version',
    add: `VARCHAR(64) NULL`,
    modify: `VARCHAR(64) NULL DEFAULT NULL`,
  },
] as const;

export class CreateDeterministicAuthoring1713500000000 implements MigrationInterface {
  name = 'CreateDeterministicAuthoring1713500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_jobs'))) {
      throw new Error('AUTHORING_SCHEMA_RECONCILIATION_REQUIRED:workflow_jobs');
    }
    for (const column of JOB_COLUMNS) {
      if (!(await queryRunner.hasColumn('workflow_jobs', column.name))) {
        await queryRunner.query(
          `ALTER TABLE workflow_jobs
             ADD COLUMN \`${column.name}\` ${column.add}`,
        );
      }
    }
    await queryRunner.query(
      `UPDATE workflow_jobs
          SET workflow_definition='legacy-generation.v1',
              authoring_mode='off',
              rollout_policy_version='deterministic-authoring-rollout.v1',
              rollout_policy_snapshot=?,
              rollout_policy_digest=?,
              server_entrypoint='legacy_api',
              client_contract_version=NULL
        WHERE workflow_definition IS NULL
           OR authoring_mode IS NULL
           OR rollout_policy_version IS NULL
           OR rollout_policy_snapshot IS NULL
           OR rollout_policy_digest IS NULL
           OR server_entrypoint IS NULL`,
      [LEGACY_SNAPSHOT, LEGACY_SNAPSHOT_DIGEST],
    );
    for (const column of JOB_COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE workflow_jobs
           MODIFY COLUMN \`${column.name}\` ${column.modify}`,
      );
    }
    await addCheck(
      queryRunner,
      'chk_workflow_jobs_definition',
      `workflow_definition IN (
        'legacy-generation.v1','atomic-shadow.v1',
        'deterministic-authoring-shadow.v1','deterministic-authoring.v1'
      )`,
    );
    await addCheck(
      queryRunner,
      'chk_workflow_jobs_authoring_mode',
      `authoring_mode IN ('off','shadow','enforce_allowlist')`,
    );
    await addCheck(
      queryRunner,
      'chk_workflow_jobs_server_entrypoint',
      `server_entrypoint IN ('legacy_api','workflow_api','internal')`,
    );
    await addCheck(
      queryRunner,
      'chk_workflow_jobs_client_contract',
      `client_contract_version IS NULL
       OR client_contract_version='authoring-approval-ui.v1'`,
    );
    await addIndex(
      queryRunner,
      'uq_workflow_jobs_authoring_identity',
      `CREATE UNIQUE INDEX uq_workflow_jobs_authoring_identity
         ON workflow_jobs(id,project_id,user_id)`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS authoring_proposals (
        id VARCHAR(36) NOT NULL DEFAULT (UUID()),
        job_id VARCHAR(36) NOT NULL,
        project_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        sequence BIGINT UNSIGNED NOT NULL,
        artifact_kind VARCHAR(32) NOT NULL,
        schema_version VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL,
        payload LONGBLOB NOT NULL,
        payload_sha256 CHAR(64)
          CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload_utf8_bytes BIGINT UNSIGNED NOT NULL,
        expires_at DATETIME(6) NOT NULL,
        approved_at DATETIME(6) NULL,
        committed_at DATETIME(6) NULL,
        resource_id VARCHAR(36) NULL,
        resource_version BIGINT UNSIGNED NULL,
        active_slot TINYINT
          GENERATED ALWAYS AS (
            CASE WHEN status IN ('ACTIVE','APPROVED') THEN 1 ELSE NULL END
          ) STORED,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_authoring_proposals_job_sequence (job_id,sequence),
        UNIQUE KEY uq_authoring_proposals_job_active (job_id,active_slot),
        KEY idx_authoring_proposals_owner
          (user_id,project_id,job_id,status),
        CONSTRAINT chk_authoring_proposals_artifact
          CHECK (artifact_kind IN ('directory','outline','body')),
        CONSTRAINT chk_authoring_proposals_status
          CHECK (
            status IN
              ('ACTIVE','APPROVED','COMMITTED','EXPIRED','INVALIDATED')
          ),
        CONSTRAINT chk_authoring_proposals_payload_size
          CHECK (payload_utf8_bytes=OCTET_LENGTH(payload)),
        CONSTRAINT chk_authoring_proposals_shape
          CHECK (
            (status='ACTIVE' AND approved_at IS NULL
              AND committed_at IS NULL AND resource_id IS NULL
              AND resource_version IS NULL)
            OR
            (status='APPROVED' AND approved_at IS NOT NULL
              AND committed_at IS NULL AND resource_id IS NULL
              AND resource_version IS NULL)
            OR
            (status='COMMITTED' AND approved_at IS NOT NULL
              AND committed_at IS NOT NULL AND resource_id IS NOT NULL
              AND resource_version IS NOT NULL)
            OR
            (status IN ('EXPIRED','INVALIDATED')
              AND committed_at IS NULL AND resource_id IS NULL
              AND resource_version IS NULL)
          ),
        CONSTRAINT authoring_proposals_job_identity_fkey
          FOREIGN KEY (job_id,project_id,user_id)
          REFERENCES workflow_jobs(id,project_id,user_id)
          ON DELETE CASCADE ON UPDATE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        COLLATE=utf8mb4_0900_ai_ci
    `);
    await assertProposalShape(queryRunner);
  }

  down(): Promise<never> {
    return Promise.reject(
      new Error('AUTHORING_SCHEMA_DESTRUCTIVE_ROLLBACK_FORBIDDEN'),
    );
  }
}

async function addCheck(
  queryRunner: QueryRunner,
  name: string,
  expression: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND TABLE_NAME='workflow_jobs'
        AND CONSTRAINT_NAME=?
        AND CONSTRAINT_TYPE='CHECK'`,
    [name],
  );
  if (readCount(rows) === 0) {
    await queryRunner.query(
      `ALTER TABLE workflow_jobs
         ADD CONSTRAINT \`${name}\` CHECK (${expression})`,
    );
  }
}

async function addIndex(
  queryRunner: QueryRunner,
  name: string,
  statement: string,
): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT COUNT(*) AS count
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='workflow_jobs'
        AND INDEX_NAME=?`,
    [name],
  );
  if (readCount(rows) === 0) await queryRunner.query(statement);
}

async function assertProposalShape(queryRunner: QueryRunner): Promise<void> {
  const rows: unknown = await queryRunner.query(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='authoring_proposals'
      ORDER BY ORDINAL_POSITION`,
  );
  const expected = [
    'id',
    'job_id',
    'project_id',
    'user_id',
    'sequence',
    'artifact_kind',
    'schema_version',
    'status',
    'payload',
    'payload_sha256',
    'payload_utf8_bytes',
    'expires_at',
    'approved_at',
    'committed_at',
    'resource_id',
    'resource_version',
    'active_slot',
    'created_at',
    'updated_at',
  ];
  const actual = Array.isArray(rows)
    ? rows.map((row) => {
        const value = (row as { name?: unknown }).name;
        return typeof value === 'string' ? value : '';
      })
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'AUTHORING_SCHEMA_RECONCILIATION_REQUIRED:authoring_proposals',
    );
  }
}

function readCount(rows: unknown): number {
  return Array.isArray(rows) && rows.length === 1
    ? Number((rows[0] as { count?: unknown }).count)
    : Number.NaN;
}
