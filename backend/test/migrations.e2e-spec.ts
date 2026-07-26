import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm';
import { InitSchema1710700000000 } from '../migrations/1710700000000-InitSchema.js';
import { AddSectionNodeIdToOutlineVersions1710800000000 } from '../migrations/1710800000000-AddSectionNodeIdToOutlineVersions.js';
import { CreateStyleTemplates1711800000000 } from '../migrations/1711800000000-CreateStyleTemplates.js';
import { FixCitationMapsCascade1712000000000 } from '../migrations/1712000000000-FixCitationMapsCascade.js';
import { CreateFileUploadReliabilityTables1712050000000 } from '../migrations/1712050000000-CreateFileUploadReliabilityTables.js';
import { HardenFileUploadLeases1712060000000 } from '../migrations/1712060000000-HardenFileUploadLeases.js';
import { UseDatabaseClockForFileUploadLeases1712070000000 } from '../migrations/1712070000000-UseDatabaseClockForFileUploadLeases.js';
import { NormalizeUploadLeaseTimestamps1712080000000 } from '../migrations/1712080000000-NormalizeUploadLeaseTimestamps.js';
import { ReconcileApplicationSchema1712100000000 } from '../migrations/1712100000000-ReconcileApplicationSchema.js';
import { CreateWorkflowPersistence1712200000000 } from '../migrations/1712200000000-CreateWorkflowPersistence.js';
import { AddWorkflowExecutionLeases1712300000000 } from '../migrations/1712300000000-AddWorkflowExecutionLeases.js';
import { AddWorkflowDomainCommits1712400000000 } from '../migrations/1712400000000-AddWorkflowDomainCommits.js';
import { AddWorkflowAttemptRecovery1712500000000 } from '../migrations/1712500000000-AddWorkflowAttemptRecovery.js';
import { AddModelRunAttempts1712600000000 } from '../migrations/1712600000000-AddModelRunAttempts.js';
import { AddStructuredIngestion1712700000000 } from '../migrations/1712700000000-AddStructuredIngestion.js';
import { AddParseAttemptLeases1712800000000 } from '../migrations/1712800000000-AddParseAttemptLeases.js';
import { CreateHybridRetrieval1712900000000 } from '../migrations/1712900000000-CreateHybridRetrieval.js';
import { HardenHybridRetrieval1713000000000 } from '../migrations/1713000000000-HardenHybridRetrieval.js';
import { CompleteHybridRetrievalFencing1713100000000 } from '../migrations/1713100000000-CompleteHybridRetrievalFencing.js';
import { RetainReactivatableDenseNamespaces1713200000000 } from '../migrations/1713200000000-RetainReactivatableDenseNamespaces.js';
import { CreateClaimEvidenceLedger1713300000000 } from '../migrations/1713300000000-CreateClaimEvidenceLedger.js';
import { HardenGroundingWorkflow1713310000000 } from '../migrations/1713310000000-HardenGroundingWorkflow.js';
import { AddGroundingRevisionRunRefs1713320000000 } from '../migrations/1713320000000-AddGroundingRevisionRunRefs.js';
import { AddAtomicGroundingContracts1713330000000 } from '../migrations/1713330000000-AddAtomicGroundingContracts.js';
import { HardenAtomicOperationIdempotency1713340000000 } from '../migrations/1713340000000-HardenAtomicOperationIdempotency.js';
import {
  ATOMIC_SCOPE_CHECK_EXPRESSION,
  findAtomicOperationSchemaContractViolations,
  isAtomicScopeCheckClause,
} from '../migrations/support/atomic-operation-schema-contract.js';
import { findWorkflowSchemaContractViolations } from '../migrations/support/workflow-schema-contract.js';
import {
  APPLICATION_TABLES,
  findApplicationSchemaContractViolations,
  isAllowlistedDatabaseOnlySchemaQuery,
} from '../migrations/support/application-schema-contract.js';
import { DirectoryService } from '../src/content/directory.service.js';
import { OutlineService } from '../src/content/outline.service.js';
import { ContentGenerationService } from '../src/content/content-generation.service.js';
import { ProjectService } from '../src/project/project.service.js';
import { DirectoryVersion } from '../src/content/entities/directory-version.entity.js';
import { OutlineVersion } from '../src/content/entities/outline-version.entity.js';
import { ContentVersion } from '../src/content/entities/content-version.entity.js';
import { WritingResult } from '../src/content/entities/writing-result.entity.js';
import { Project } from '../src/project/entities/project.entity.js';
import { ProjectState } from '../src/project/entities/project-state.entity.js';
import { User } from '../src/auth/entities/user.entity.js';
import { RefreshToken } from '../src/auth/entities/refresh-token.entity.js';
import { SourceFile } from '../src/file/entities/source-file.entity.js';
import { Document } from '../src/file/entities/document.entity.js';
import { FileUploadOutbox } from '../src/file/entities/file-upload-outbox.entity.js';
import { FileCleanupRecord } from '../src/file/entities/file-cleanup-record.entity.js';
import { FileMoveIntent } from '../src/file/entities/file-move-intent.entity.js';
import { Chunk } from '../src/chunk/entities/chunk.entity.js';
import { Session } from '../src/session/entities/session.entity.js';
import { Message } from '../src/session/entities/message.entity.js';
import { CitationMap } from '../src/citation/entities/citation-map.entity.js';
import { ExportJob } from '../src/export/entities/export-job.entity.js';
import { StyleTemplate } from '../src/style-template/entities/style-template.entity.js';
import { WorkflowJob } from '../src/workflow/entities/workflow-job.entity.js';
import { WorkflowEvent } from '../src/workflow/entities/workflow-event.entity.js';
import { ModelRun } from '../src/workflow/entities/model-run.entity.js';
import { WorkflowDomainCommit } from '../src/workflow/entities/workflow-domain-commit.entity.js';
import { ModelRunService } from '../src/workflow/model-run.service.js';
import { RetrievalRun } from '../src/retrieval/entities/retrieval-run.entity.js';
import { RetrievalCandidateRecord } from '../src/retrieval/entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from '../src/retrieval/entities/retrieval-index-version.entity.js';
import { RetrievalRunIndexVersion } from '../src/retrieval/entities/retrieval-run-index.entity.js';
import { GroundingAssignment } from '../src/citation/entities/grounding-assignment.entity.js';
import { GroundingClaim } from '../src/citation/entities/grounding-claim.entity.js';
import { SqlGroundingEvidenceStore } from '../src/citation/sql-grounding-evidence.store.js';
import { MysqlWorkflowExecutionStore } from '../src/workflow/mysql-workflow-execution.store.js';
import { WorkflowService } from '../src/workflow/workflow.service.js';
import { WorkflowStatus } from '../src/workflow/workflow.types.js';
import { ProjectAccessPolicy } from '../src/project/project-access.policy.js';
import {
  GroundingRevisionRequiredError,
  MaterialGapError,
} from '../src/citation/material-gap.error.js';
import { GroundingVerifier } from '../src/citation/grounding-verifier.js';
import { CitationLedgerService } from '../src/citation/citation-ledger.service.js';

jest.setTimeout(120_000);

const MYSQL_PASSWORD = 'migration-e2e-password';
const containerName = `write-agent-migration-e2e-${process.pid}-${Date.now()}`;
const migrations: Array<new () => MigrationInterface> = [
  InitSchema1710700000000,
  AddSectionNodeIdToOutlineVersions1710800000000,
  CreateStyleTemplates1711800000000,
  FixCitationMapsCascade1712000000000,
  CreateFileUploadReliabilityTables1712050000000,
  HardenFileUploadLeases1712060000000,
  UseDatabaseClockForFileUploadLeases1712070000000,
  NormalizeUploadLeaseTimestamps1712080000000,
  ReconcileApplicationSchema1712100000000,
  CreateWorkflowPersistence1712200000000,
  AddWorkflowExecutionLeases1712300000000,
  AddWorkflowDomainCommits1712400000000,
  AddWorkflowAttemptRecovery1712500000000,
  AddModelRunAttempts1712600000000,
  AddStructuredIngestion1712700000000,
  AddParseAttemptLeases1712800000000,
  CreateHybridRetrieval1712900000000,
];

const currentMigrations: Array<new () => MigrationInterface> = [
  ...migrations,
  HardenHybridRetrieval1713000000000,
  CompleteHybridRetrievalFencing1713100000000,
  RetainReactivatableDenseNamespaces1713200000000,
  CreateClaimEvidenceLedger1713300000000,
  HardenGroundingWorkflow1713310000000,
  AddGroundingRevisionRunRefs1713320000000,
  AddAtomicGroundingContracts1713330000000,
  HardenAtomicOperationIdempotency1713340000000,
];

const runtimeEntities = [
  User,
  RefreshToken,
  Project,
  ProjectState,
  SourceFile,
  Document,
  FileUploadOutbox,
  FileCleanupRecord,
  FileMoveIntent,
  Chunk,
  Session,
  Message,
  DirectoryVersion,
  OutlineVersion,
  WritingResult,
  ContentVersion,
  CitationMap,
  ExportJob,
  StyleTemplate,
  WorkflowJob,
  WorkflowEvent,
  ModelRun,
  WorkflowDomainCommit,
  RetrievalRun,
  RetrievalCandidateRecord,
  RetrievalIndexVersion,
  RetrievalRunIndexVersion,
  GroundingAssignment,
  GroundingClaim,
];

describe('application migrations on MySQL 8.4', () => {
  let admin: Connection;
  let mysqlPort: number;

  beforeAll(async () => {
    execFileSync('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--env',
      `MYSQL_ROOT_PASSWORD=${MYSQL_PASSWORD}`,
      '--publish',
      '127.0.0.1::3306',
      'mysql:8.4',
    ]);
    const portOutput = execFileSync('docker', [
      'port',
      containerName,
      '3306/tcp',
    ])
      .toString()
      .trim();
    mysqlPort = Number(portOutput.slice(portOutput.lastIndexOf(':') + 1));

    const deadline = Date.now() + 60_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        admin = await createConnection({
          host: '127.0.0.1',
          port: mysqlPort,
          user: 'root',
          password: MYSQL_PASSWORD,
        });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }, 90_000);

  afterAll(async () => {
    await admin?.end();
    try {
      execFileSync('docker', ['rm', '--force', containerName]);
    } catch {
      // The --rm container may already have exited.
    }
  });

  it('runs the complete migration chain on a fresh schema', async () => {
    const schema = `migration_fresh_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );

    try {
      await dataSource.initialize();
      await expect(dataSource.runMigrations()).resolves.toHaveLength(
        currentMigrations.length,
      );
      await expect(
        dataSource.query(
          `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
                  IS_NULLABLE AS nullable
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'source_files'
              AND COLUMN_NAME IN
                ('parse_attempt_token', 'parse_lease_expires_at')
            ORDER BY ORDINAL_POSITION`,
          [schema],
        ),
      ).resolves.toEqual([
        {
          columnName: 'parse_attempt_token',
          columnType: 'char(36)',
          nullable: 'YES',
        },
        {
          columnName: 'parse_lease_expires_at',
          columnType: 'datetime(6)',
          nullable: 'YES',
        },
      ]);
      await expect(
        dataSource.query(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                  COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
                  COLUMN_DEFAULT AS defaultValue
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND (
                (TABLE_NAME = 'grounding_assignments'
                 AND COLUMN_NAME = 'contract_version')
                OR
                (TABLE_NAME = 'grounding_claims'
                 AND COLUMN_NAME = 'atomic_claim')
              )
            ORDER BY TABLE_NAME, COLUMN_NAME`,
          [schema],
        ),
      ).resolves.toEqual([
        {
          tableName: 'grounding_assignments',
          columnName: 'contract_version',
          columnType: 'varchar(32)',
          nullable: 'NO',
          defaultValue: 'legacy:v0',
        },
        {
          tableName: 'grounding_claims',
          columnName: 'atomic_claim',
          columnType: 'json',
          nullable: 'YES',
          defaultValue: null,
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('preserves legacy citations and marks them unverifiable during ledger upgrade', async () => {
    const schema = `migration_grounding_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessorMigrations = currentMigrations.filter((Migration) => {
      const name = new Migration().name;
      return (
        name !== 'CreateClaimEvidenceLedger1713300000000' &&
        name !== 'HardenGroundingWorkflow1713310000000' &&
        name !== 'AddGroundingRevisionRunRefs1713320000000' &&
        name !== 'AddAtomicGroundingContracts1713330000000' &&
        name !== 'HardenAtomicOperationIdempotency1713340000000'
      );
    });
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      predecessorMigrations,
    );
    let upgraded: DataSource | undefined;
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const documentId = randomUUID();
    const chunkId = randomUUID();
    const resultId = randomUUID();
    const citationId = randomUUID();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await predecessor.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Grounding migration')`,
        [projectId, userId],
      );
      await predecessor.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            checksum_sha256, active_ingestion_key, parse_status)
         VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md', ?, ?, 'done')`,
        [fileId, projectId, 'a'.repeat(64), 'b'.repeat(64)],
      );
      await predecessor.query(
        `INSERT INTO documents
           (id, file_id, project_id, title, content_text, source_checksum,
            parser_version, chunk_version, ingestion_key, ast, is_active)
         VALUES (?, ?, ?, 'Fixture', '装机容量为 300 MW', ?, 'md-v1',
                 'token-v1', ?, ?, 1)`,
        [
          documentId,
          fileId,
          projectId,
          'a'.repeat(64),
          'b'.repeat(64),
          JSON.stringify({
            version: 'document-ast-v1',
            blocks: [],
            text_length: 13,
          }),
        ],
      );
      await predecessor.query(
        `INSERT INTO chunks
           (id, project_id, file_id, document_id, chunk_index, content,
            search_text, stable_key, ingestion_key, position, token_count,
            tokenizer_version, char_start, char_end, is_active)
         VALUES (?, ?, ?, ?, 0, '装机容量为 300 MW', '装机容量为 300 MW',
                 ?, ?, 0, 8, 'token-v1', 0, 12, 1)`,
        [
          chunkId,
          projectId,
          fileId,
          documentId,
          'c'.repeat(64),
          'b'.repeat(64),
        ],
      );
      await predecessor.query(
        `INSERT INTO writing_results
           (id, project_id, task_type, status, content_text)
         VALUES (?, ?, 'generate', 'succeeded', '旧正文')`,
        [resultId, projectId],
      );
      await predecessor.query(
        `INSERT INTO citation_maps
           (id, project_id, result_id, paragraph_key, chunk_id, file_id,
            use_type, evidence_text, confidence_score)
         VALUES (?, ?, ?, 'p1', ?, ?, 'synthesize', '旧证据', 0.85)`,
        [citationId, projectId, resultId, chunkId, fileId],
      );
      await predecessor.destroy();

      upgraded = createMigrationDataSource(
        schema,
        mysqlPort,
        currentMigrations,
      );
      await upgraded.initialize();
      await expect(upgraded.runMigrations()).resolves.toHaveLength(5);
      await expect(
        upgraded.query(
          `SELECT id, evidence_text AS evidenceText,
                  support_status AS supportStatus,
                  support_score AS supportScore,
                  verification_method AS verificationMethod,
                  claim_id AS claimId, evidence_id AS evidenceId
             FROM citation_maps
            WHERE id = ?`,
          [citationId],
        ),
      ).resolves.toEqual([
        {
          id: citationId,
          evidenceText: '旧证据',
          supportStatus: 'UNVERIFIABLE',
          supportScore: 0,
          verificationMethod: 'legacy_unverifiable',
          claimId: null,
          evidenceId: null,
        },
      ]);
      await expect(
        upgraded.query(
          `SELECT TABLE_NAME AS tableName
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME IN ('grounding_assignments', 'grounding_claims')
            ORDER BY TABLE_NAME`,
          [schema],
        ),
      ).resolves.toEqual([
        { tableName: 'grounding_assignments' },
        { tableName: 'grounding_claims' },
      ]);
    } finally {
      if (upgraded?.isInitialized) await upgraded.destroy();
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('retries 171331 after the first grounding ALTER auto-commits', async () => {
    const schema = `migration_grounding_retry_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter((Migration) => {
        const name = new Migration().name;
        return (
          name !== 'HardenGroundingWorkflow1713310000000' &&
          name !== 'AddGroundingRevisionRunRefs1713320000000' &&
          name !== 'AddAtomicGroundingContracts1713330000000' &&
          name !== 'HardenAtomicOperationIdempotency1713340000000'
        );
      }),
    );

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        const migration = new HardenGroundingWorkflow1713310000000();
        await expect(
          migration.up(withGroundingAlterFailure(runner, 2)),
        ).rejects.toThrow('injected grounding ALTER 2 failure');
        await expect(
          runner.hasColumn('grounding_assignments', 'snapshot_digest'),
        ).resolves.toBe(true);
        await expect(
          runner.hasColumn('citation_maps', 'snapshot_digest'),
        ).resolves.toBe(false);

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          runner.hasColumn('grounding_assignments', 'snapshot_digest'),
        ).resolves.toBe(true);
        await expect(
          runner.hasColumn('citation_maps', 'snapshot_digest'),
        ).resolves.toBe(true);
      } finally {
        await runner.release();
      }
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('preserves populated ledgers, backfills legacy contracts, and remains idempotent', async () => {
    const schema = `migration_atomic_populated_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessorMigrations = currentMigrations.filter((Migration) => {
      const name = new Migration().name;
      return (
        name !== 'AddAtomicGroundingContracts1713330000000' &&
        name !== 'HardenAtomicOperationIdempotency1713340000000'
      );
    });
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      predecessorMigrations,
    );
    let upgraded: DataSource | undefined;

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      const fixture = await insertGroundingContractFixture(predecessor, {
        suffix: 'populated',
      });
      const before = await groundingLedgerCounts(predecessor);
      await predecessor.destroy();

      upgraded = createMigrationDataSource(
        schema,
        mysqlPort,
        currentMigrations,
      );
      await upgraded.initialize();
      await expect(upgraded.runMigrations()).resolves.toHaveLength(2);
      await expect(groundingLedgerCounts(upgraded)).resolves.toEqual(before);
      await expect(
        upgraded.query(
          `SELECT contract_version AS contractVersion
             FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [fixture.workflowJobId],
        ),
      ).resolves.toEqual([{ contractVersion: 'legacy:v0' }]);
      await expect(
        upgraded.query(
          `SELECT atomic_claim AS atomicClaim
             FROM grounding_claims
            WHERE claim_id = ?`,
          [fixture.claimId],
        ),
      ).resolves.toEqual([{ atomicClaim: null }]);
      await expect(
        upgraded.query(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND (
                (TABLE_NAME = 'model_runs'
                 AND COLUMN_NAME IN ('operation_key', 'request_fingerprint'))
                OR
                (TABLE_NAME = 'retrieval_runs'
                 AND COLUMN_NAME IN
                   ('workflow_job_id', 'revision_attempt', 'request_sha256'))
              )
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [schema],
        ),
      ).resolves.toEqual([
        { tableName: 'model_runs', columnName: 'operation_key' },
        { tableName: 'model_runs', columnName: 'request_fingerprint' },
        { tableName: 'retrieval_runs', columnName: 'workflow_job_id' },
        { tableName: 'retrieval_runs', columnName: 'revision_attempt' },
        { tableName: 'retrieval_runs', columnName: 'request_sha256' },
      ]);

      const oldBinaryFixture = await insertGroundingContractFixture(upgraded, {
        suffix: 'old-binary',
        omitNewColumns: true,
      });
      await expect(
        upgraded.query(
          `SELECT contract_version AS contractVersion
             FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [oldBinaryFixture.workflowJobId],
        ),
      ).resolves.toEqual([{ contractVersion: 'legacy:v0' }]);
      const beforeRetry: unknown = await upgraded.query(
        `SELECT workflow_job_id AS workflowJobId,
                contract_version AS contractVersion
           FROM grounding_assignments
          ORDER BY workflow_job_id`,
      );
      const migration = new AddAtomicGroundingContracts1713330000000();
      const runner = upgraded.createQueryRunner();
      await runner.connect();
      try {
        await expect(migration.up(runner)).resolves.toBeUndefined();
      } finally {
        await runner.release();
      }
      await expect(
        upgraded.query(
          `SELECT workflow_job_id AS workflowJobId,
                  contract_version AS contractVersion
             FROM grounding_assignments
            ORDER BY workflow_job_id`,
        ),
      ).resolves.toEqual(beforeRetry);
      await expect(
        upgraded.query(
          `SELECT COUNT(*) AS count
             FROM grounding_assignments
            WHERE contract_version IS NULL
               OR contract_version NOT IN ('legacy:v0', 'atomic:v1')`,
        ),
      ).resolves.toEqual([{ count: '0' }]);
    } finally {
      if (upgraded?.isInitialized) await upgraded.destroy();
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('resumes after only the contract column ALTER auto-commits', async () => {
    const schema = `migration_atomic_partial_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter((Migration) => {
        const name = new Migration().name;
        return (
          name !== 'AddAtomicGroundingContracts1713330000000' &&
          name !== 'HardenAtomicOperationIdempotency1713340000000'
        );
      }),
    );

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      const fixture = await insertGroundingContractFixture(predecessor, {
        suffix: 'partial',
      });
      await predecessor.query(
        `ALTER TABLE grounding_assignments
           ADD COLUMN contract_version VARCHAR(32) NULL DEFAULT 'legacy:v0'`,
      );
      await predecessor.query(
        `UPDATE grounding_assignments
            SET contract_version = NULL
          WHERE workflow_job_id = ?`,
        [fixture.workflowJobId],
      );
      const migration = new AddAtomicGroundingContracts1713330000000();
      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
      } finally {
        await runner.release();
      }
      await expect(
        predecessor.query(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                  COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
                  COLUMN_DEFAULT AS defaultValue
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND (
                (TABLE_NAME = 'grounding_assignments'
                 AND COLUMN_NAME = 'contract_version')
                OR
                (TABLE_NAME = 'grounding_claims'
                 AND COLUMN_NAME = 'atomic_claim')
              )
            ORDER BY TABLE_NAME, COLUMN_NAME`,
          [schema],
        ),
      ).resolves.toEqual([
        {
          tableName: 'grounding_assignments',
          columnName: 'contract_version',
          columnType: 'varchar(32)',
          nullable: 'NO',
          defaultValue: 'legacy:v0',
        },
        {
          tableName: 'grounding_claims',
          columnName: 'atomic_claim',
          columnType: 'json',
          nullable: 'YES',
          defaultValue: null,
        },
      ]);
      await expect(
        predecessor.query(
          `SELECT contract_version AS contractVersion
             FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [fixture.workflowJobId],
        ),
      ).resolves.toEqual([{ contractVersion: 'legacy:v0' }]);
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('rejects unknown preexisting assignment contract values', async () => {
    const schema = `migration_atomic_unknown_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter((Migration) => {
        const name = new Migration().name;
        return (
          name !== 'AddAtomicGroundingContracts1713330000000' &&
          name !== 'HardenAtomicOperationIdempotency1713340000000'
        );
      }),
    );

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      const fixture = await insertGroundingContractFixture(predecessor, {
        suffix: 'unknown',
      });
      await predecessor.query(
        `ALTER TABLE grounding_assignments
           ADD COLUMN contract_version VARCHAR(32) NULL DEFAULT 'legacy:v0'`,
      );
      await predecessor.query(
        `UPDATE grounding_assignments
            SET contract_version = 'future:v9'
          WHERE workflow_job_id = ?`,
        [fixture.workflowJobId],
      );
      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          new AddAtomicGroundingContracts1713330000000().up(runner),
        ).rejects.toThrow('ATOMIC_GROUNDING_UNKNOWN_CONTRACT_VERSION');
      } finally {
        await runner.release();
      }
      await expect(
        predecessor.query(
          `SELECT contract_version AS contractVersion
             FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [fixture.workflowJobId],
        ),
      ).resolves.toEqual([{ contractVersion: 'future:v9' }]);
      await expect(
        predecessor.query(
          `SELECT COUNT(*) AS count
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'grounding_claims'
              AND COLUMN_NAME = 'atomic_claim'`,
          [schema],
        ),
      ).resolves.toEqual([{ count: '0' }]);
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('rejects destructive down while preserving schema, data, and migration history', async () => {
    const schema = `migration_atomic_down_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const fixture = await insertGroundingContractFixture(dataSource, {
        suffix: 'down',
        contractVersion: 'atomic:v1',
        atomicClaim: atomicClaimFixture(),
      });
      const before = await atomicRollbackSnapshot(dataSource, fixture);

      await expect(dataSource.undoLastMigration()).rejects.toThrow(
        'ATOMIC_OPERATION_IDEMPOTENCY_DESTRUCTIVE_ROLLBACK_FORBIDDEN',
      );

      await expect(
        atomicRollbackSnapshot(dataSource, fixture),
      ).resolves.toEqual(before);
      await expect(
        dataSource.query(
          `SELECT COUNT(*) AS count
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND (
                (TABLE_NAME = 'grounding_assignments'
                 AND COLUMN_NAME = 'contract_version')
                OR
                (TABLE_NAME = 'grounding_claims'
                 AND COLUMN_NAME = 'atomic_claim')
              )`,
          [schema],
        ),
      ).resolves.toEqual([{ count: '2' }]);
      await expect(
        dataSource.query(
          `SELECT COUNT(*) AS count
             FROM typeorm_migrations
            WHERE name = 'AddAtomicGroundingContracts1713330000000'`,
        ),
      ).resolves.toEqual([{ count: '1' }]);
      await expect(
        dataSource.query(
          `SELECT COUNT(*) AS count
             FROM typeorm_migrations
            WHERE name =
              'HardenAtomicOperationIdempotency1713340000000'`,
        ),
      ).resolves.toEqual([{ count: '1' }]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('enforces the closed atomic operation scope and stores the model request fingerprint', async () => {
    const schema = `atomic_operation_contract_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const workflowJobId = randomUUID();

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Atomic operation contract')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'atomic-operation-contract', ?,
                 'RUNNING')`,
        [workflowJobId, userId, projectId, 'f'.repeat(64)],
      );

      await expect(
        dataSource.query(
          `SELECT COLUMN_NAME AS columnName
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'model_runs'
              AND COLUMN_NAME IN ('operation_key', 'request_fingerprint')
            ORDER BY ORDINAL_POSITION`,
          [schema],
        ),
      ).resolves.toEqual([
        { columnName: 'operation_key' },
        { columnName: 'request_fingerprint' },
      ]);

      for (const suffix of ['generic-a', 'generic-b']) {
        await expect(
          insertAtomicRetrievalRun(dataSource, {
            id: randomUUID(),
            projectId,
            query: suffix,
            workflowJobId: null,
            revisionAttempt: null,
            requestSha256: null,
          }),
        ).resolves.toBeDefined();
      }
      await expect(
        insertAtomicRetrievalRun(dataSource, {
          id: randomUUID(),
          projectId,
          query: 'targeted-valid',
          workflowJobId,
          revisionAttempt: 1,
          requestSha256: 'a'.repeat(64),
        }),
      ).resolves.toBeDefined();
      await expect(
        insertAtomicRetrievalRun(dataSource, {
          id: randomUUID(),
          projectId,
          query: 'targeted-duplicate',
          workflowJobId,
          revisionAttempt: 1,
          requestSha256: 'b'.repeat(64),
        }),
      ).rejects.toThrow();

      const invalidScopes = [
        {
          workflowJobId,
          revisionAttempt: null,
          requestSha256: 'a'.repeat(64),
        },
        {
          workflowJobId,
          revisionAttempt: 0,
          requestSha256: 'a'.repeat(64),
        },
        {
          workflowJobId,
          revisionAttempt: 2,
          requestSha256: 'a'.repeat(64),
        },
        {
          workflowJobId,
          revisionAttempt: 1,
          requestSha256: null,
        },
        {
          workflowJobId,
          revisionAttempt: 1,
          requestSha256: 'A'.repeat(64),
        },
        {
          workflowJobId,
          revisionAttempt: 1,
          requestSha256: 'not-a-sha256',
        },
        {
          workflowJobId: null,
          revisionAttempt: 1,
          requestSha256: null,
        },
        {
          workflowJobId: null,
          revisionAttempt: null,
          requestSha256: 'a'.repeat(64),
        },
      ] as const;
      for (const [index, invalid] of invalidScopes.entries()) {
        await expect(
          insertAtomicRetrievalRun(dataSource, {
            id: randomUUID(),
            projectId,
            query: `invalid-${index}`,
            ...invalid,
          }),
        ).rejects.toThrow();
      }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('fails closed on incompatible same-name atomic columns, indexes, foreign keys, and checks', async () => {
    const schema = `atomic_operation_drift_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter(
        (Migration) =>
          new Migration().name !==
          'HardenAtomicOperationIdempotency1713340000000',
      ),
    );
    const migration = new HardenAtomicOperationIdempotency1713340000000();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(
          `ALTER TABLE model_runs
             ADD COLUMN operation_key VARCHAR(63) NULL`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:model_runs.operation_key',
        );
        await runner.query(
          `ALTER TABLE model_runs DROP COLUMN operation_key,
             ADD COLUMN operation_key CHAR(64) NULL AFTER prompt_sha256,
             ADD COLUMN request_fingerprint CHAR(64) NULL AFTER operation_key`,
        );

        await runner.query(
          `CREATE UNIQUE INDEX uq_model_runs_operation_key
             ON model_runs (prompt_sha256)`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:model_runs.uq_model_runs_operation_key',
        );
        await runner.query(
          `DROP INDEX uq_model_runs_operation_key ON model_runs`,
        );
        await runner.query(
          `CREATE UNIQUE INDEX uq_model_runs_operation_key
             ON model_runs (operation_key)`,
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD COLUMN workflow_job_id VARCHAR(36) NULL AFTER project_id,
             ADD COLUMN revision_attempt TINYINT UNSIGNED NULL
               AFTER workflow_job_id,
             ADD COLUMN request_sha256 CHAR(64) NULL AFTER revision_attempt`,
        );

        await runner.query(
          `CREATE UNIQUE INDEX uq_retrieval_runs_workflow_revision
             ON retrieval_runs (revision_attempt, workflow_job_id)`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.uq_retrieval_runs_workflow_revision',
        );
        await runner.query(
          `DROP INDEX uq_retrieval_runs_workflow_revision ON retrieval_runs`,
        );
        await runner.query(
          `CREATE UNIQUE INDEX uq_retrieval_runs_workflow_revision
             ON retrieval_runs (workflow_job_id, revision_attempt)`,
        );

        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD CONSTRAINT retrieval_runs_workflow_job_id_fkey
             FOREIGN KEY (workflow_job_id) REFERENCES projects(id)
             ON DELETE RESTRICT ON UPDATE RESTRICT`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.retrieval_runs_workflow_job_id_fkey',
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             DROP FOREIGN KEY retrieval_runs_workflow_job_id_fkey`,
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD CONSTRAINT retrieval_runs_workflow_job_id_fkey
             FOREIGN KEY (workflow_job_id) REFERENCES workflow_jobs(id)
             ON DELETE CASCADE ON UPDATE RESTRICT`,
        );

        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD CONSTRAINT chk_retrieval_runs_atomic_revision_scope
             CHECK (revision_attempt IS NULL)`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.chk_retrieval_runs_atomic_revision_scope',
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             DROP CHECK chk_retrieval_runs_atomic_revision_scope`,
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD CONSTRAINT chk_retrieval_runs_atomic_revision_scope
             CHECK (
               (
                 workflow_job_id IS NULL
                 AND revision_attempt IS NULL
                 AND request_sha256 IS NULL
               )
               OR
               (
                 workflow_job_id IS NOT NULL
                 AND revision_attempt = 1
                 AND request_sha256 IS NOT NULL
                 AND REGEXP_LIKE(
                   request_sha256,
                   _ascii'^[0-9a-f]{64}$',
                   _ascii'c'
                 ) IS TRUE
               )
             )`,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.chk_retrieval_runs_atomic_revision_scope',
        );
        await runner.query(
          `ALTER TABLE retrieval_runs
             DROP CHECK chk_retrieval_runs_atomic_revision_scope`,
        );
        const wrongRegex = `^[0-9a\\-f]{64}$`;
        const regexBehavior: unknown = await runner.query(
          `SELECT
             REGEXP_LIKE(REPEAT('-', 64), ?, 'c') AS acceptsHyphens,
             REGEXP_LIKE(REPEAT('b', 64), ?, 'c') AS acceptsB`,
          [wrongRegex, wrongRegex],
        );
        expect(regexBehavior).toEqual([{ acceptsHyphens: '1', acceptsB: '0' }]);
        await runner.query(
          `ALTER TABLE retrieval_runs
             ADD CONSTRAINT chk_retrieval_runs_atomic_revision_scope
             CHECK ((
               (
                 workflow_job_id IS NULL
                 AND revision_attempt IS NULL
                 AND request_sha256 IS NULL
               )
               OR
               (
                 workflow_job_id IS NOT NULL
                 AND revision_attempt = 1
                 AND request_sha256 IS NOT NULL
                 AND REGEXP_LIKE(
                   request_sha256,
                   _ascii'^[0-9a\\\\-f]{64}$',
                   _ascii'c'
                 )
               )
             ) IS TRUE)`,
        );
        const beforeWrongRegexRejection = await snapshotDdl(
          predecessor,
          schema,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.chk_retrieval_runs_atomic_revision_scope',
        );
        await expect(snapshotDdl(predecessor, schema)).resolves.toEqual(
          beforeWrongRegexRejection,
        );
      } finally {
        await runner.release();
      }
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it.each([
    [
      'foreign key',
      'retrieval_runs_workflow_job_id_fkey',
      async (dataSource: DataSource) => {
        await dataSource.query(
          `CREATE TABLE atomic_constraint_conflict (
             id VARCHAR(36) NOT NULL,
             workflow_job_id VARCHAR(36) NULL,
             PRIMARY KEY (id),
             KEY ix_atomic_constraint_conflict_job (workflow_job_id),
             CONSTRAINT retrieval_runs_workflow_job_id_fkey
               FOREIGN KEY (workflow_job_id) REFERENCES workflow_jobs(id)
               ON DELETE RESTRICT ON UPDATE RESTRICT
           ) ENGINE=InnoDB
             DEFAULT CHARACTER SET utf8mb4
             COLLATE utf8mb4_0900_ai_ci`,
        );
      },
    ],
    [
      'check',
      'chk_retrieval_runs_atomic_revision_scope',
      async (dataSource: DataSource) => {
        await dataSource.query(
          `CREATE TABLE atomic_constraint_conflict (
             id INT NOT NULL,
             CONSTRAINT chk_retrieval_runs_atomic_revision_scope
               CHECK (id >= 0)
           ) ENGINE=InnoDB
             DEFAULT CHARACTER SET utf8mb4
             COLLATE utf8mb4_0900_ai_ci`,
        );
      },
    ],
  ])(
    'rejects a schema-global same-name atomic %s before any DDL',
    async (_kind, constraintName, createConflict) => {
      const schema = `atomic_global_name_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
      const predecessor = createMigrationDataSource(
        schema,
        mysqlPort,
        currentMigrations.filter(
          (Migration) =>
            new Migration().name !==
            'HardenAtomicOperationIdempotency1713340000000',
        ),
      );
      const migration = new HardenAtomicOperationIdempotency1713340000000();

      try {
        await predecessor.initialize();
        await predecessor.runMigrations();
        await createConflict(predecessor);
        const before = await snapshotAtomicPreflightSchema(
          predecessor,
          schema,
          ['atomic_constraint_conflict'],
        );
        const runner = predecessor.createQueryRunner();
        await runner.connect();
        try {
          await expect(migration.up(runner)).rejects.toThrow(
            `ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.${constraintName}`,
          );
        } finally {
          await runner.release();
        }
        await expect(
          snapshotAtomicPreflightSchema(predecessor, schema, [
            'atomic_constraint_conflict',
          ]),
        ).resolves.toEqual(before);
      } finally {
        if (predecessor.isInitialized) await predecessor.destroy();
        await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      }
    },
  );

  it('rejects the atomic FK when its referenced table is in another schema before any DDL', async () => {
    const schema = `atomic_cross_schema_${randomUUID().replaceAll('-', '')}`;
    const referencedSchema = `atomic_cross_ref_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    await admin.query(
      `CREATE DATABASE \`${referencedSchema}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter(
        (Migration) =>
          new Migration().name !==
          'HardenAtomicOperationIdempotency1713340000000',
      ),
    );
    const migration = new HardenAtomicOperationIdempotency1713340000000();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `CREATE TABLE \`${referencedSchema}\`.workflow_jobs (
           id VARCHAR(36) NOT NULL,
           PRIMARY KEY (id)
         ) ENGINE=InnoDB
           DEFAULT CHARACTER SET utf8mb4
           COLLATE utf8mb4_0900_ai_ci`,
      );
      await predecessor.query(
        `ALTER TABLE retrieval_runs
           ADD COLUMN workflow_job_id
             VARCHAR(36) CHARACTER SET utf8mb4
             COLLATE utf8mb4_0900_ai_ci NULL AFTER project_id,
           ADD CONSTRAINT retrieval_runs_workflow_job_id_fkey
             FOREIGN KEY (workflow_job_id)
             REFERENCES \`${referencedSchema}\`.workflow_jobs(id)
             ON DELETE CASCADE ON UPDATE RESTRICT`,
      );
      const before = await snapshotAtomicPreflightSchema(predecessor, schema);
      const referencedBefore: unknown = await predecessor.query(
        `SHOW CREATE TABLE \`${referencedSchema}\`.workflow_jobs`,
      );
      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.retrieval_runs_workflow_job_id_fkey',
        );
      } finally {
        await runner.release();
      }
      await expect(
        snapshotAtomicPreflightSchema(predecessor, schema),
      ).resolves.toEqual(before);
      await expect(
        predecessor.query(
          `SHOW CREATE TABLE \`${referencedSchema}\`.workflow_jobs`,
        ),
      ).resolves.toEqual(referencedBefore);
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      await admin.query(`DROP DATABASE IF EXISTS \`${referencedSchema}\``);
    }
  });

  it.each([
    {
      name: 'model_runs default collation',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:model_runs',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      retrievalTable:
        'id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      workflowTable: 'id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      workflowOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
    {
      name: 'retrieval_runs default collation',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      retrievalTable:
        'id VARCHAR(36) NOT NULL, project_id VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      workflowTable: 'id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      workflowOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
    {
      name: 'workflow_jobs id collation',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:workflow_jobs.id',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      retrievalTable:
        'id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      workflowTable:
        'id VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL, PRIMARY KEY (id)',
      workflowOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
    {
      name: 'workflow_jobs missing referenced index',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:workflow_jobs.PRIMARY',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      retrievalTable:
        'id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      workflowTable: 'id VARCHAR(36) NOT NULL',
      workflowOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
    {
      name: 'workflow_jobs engine',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:workflow_jobs',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      retrievalTable:
        'id VARCHAR(36) NOT NULL, project_id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      workflowTable: 'id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      workflowOptions:
        'ENGINE=MyISAM DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
    {
      name: 'retrieval_runs missing AFTER anchor',
      expected: 'ATOMIC_OPERATION_SCHEMA_DRIFT:retrieval_runs.project_id',
      modelTable:
        'id VARCHAR(36) NOT NULL, prompt_sha256 CHAR(64) NULL, PRIMARY KEY (id)',
      modelOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      retrievalTable: 'id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      retrievalOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      workflowTable: 'id VARCHAR(36) NOT NULL, PRIMARY KEY (id)',
      workflowOptions:
        'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    },
  ])(
    'preflights atomic DDL prerequisite: $name',
    async ({
      expected,
      modelTable,
      modelOptions,
      retrievalTable,
      retrievalOptions,
      workflowTable,
      workflowOptions,
    }) => {
      const schema = `atomic_prerequisite_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
      const dataSource = createMigrationDataSource(schema, mysqlPort, []);
      const migration = new HardenAtomicOperationIdempotency1713340000000();

      try {
        await dataSource.initialize();
        await dataSource.query(
          `CREATE TABLE model_runs (${modelTable}) ${modelOptions}`,
        );
        await dataSource.query(
          `CREATE TABLE retrieval_runs (${retrievalTable}) ${retrievalOptions}`,
        );
        await dataSource.query(
          `CREATE TABLE workflow_jobs (${workflowTable}) ${workflowOptions}`,
        );
        const before = await snapshotAtomicPreflightSchema(dataSource, schema);
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        try {
          await expect(migration.up(runner)).rejects.toThrow(expected);
        } finally {
          await runner.release();
        }
        await expect(
          snapshotAtomicPreflightSchema(dataSource, schema),
        ).resolves.toEqual(before);
      } finally {
        if (dataSource.isInitialized) await dataSource.destroy();
        await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      }
    },
  );

  it('preserves MySQL CHECK string literal escapes while normalizing harmless syntax', () => {
    expect(isAtomicScopeCheckClause(ATOMIC_SCOPE_CHECK_EXPRESSION)).toBe(true);
    expect(
      isAtomicScopeCheckClause(
        '((((`workflow_job_id` is null) and (`revision_attempt` is null) and ' +
          '(`request_sha256` is null)) or ((`workflow_job_id` is not null) and ' +
          '(`revision_attempt` = 1) and (`request_sha256` is not null) and ' +
          "regexp_like(`request_sha256`,_ascii\\'^[0-9a-f]{64}$\\'," +
          "_ascii\\'c\\'))) is true)",
      ),
    ).toBe(true);
    expect(
      isAtomicScopeCheckClause(
        ATOMIC_SCOPE_CHECK_EXPRESSION.replace(
          '^[0-9a-f]{64}$',
          '^[0-9a\\-f]{64}$',
        ),
      ),
    ).toBe(false);
    expect(
      isAtomicScopeCheckClause(
        ATOMIC_SCOPE_CHECK_EXPRESSION.replace("_ascii'c'", "_ascii'c'''"),
      ),
    ).toBe(false);
    expect(
      isAtomicScopeCheckClause(
        ATOMIC_SCOPE_CHECK_EXPRESSION.replace(
          '^[0-9a-f]{64}$',
          '^[0-9a\\nf]{64}$',
        ),
      ),
    ).toBe(false);
  });

  it('resumes partial atomic DDL, rejects invalid existing scope data, and is idempotent', async () => {
    const schema = `atomic_operation_partial_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter(
        (Migration) =>
          new Migration().name !==
          'HardenAtomicOperationIdempotency1713340000000',
      ),
    );
    const userId = randomUUID();
    const projectId = randomUUID();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await predecessor.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Partial atomic DDL')`,
        [projectId, userId],
      );
      await predecessor.query(
        `ALTER TABLE model_runs
           ADD COLUMN operation_key CHAR(64) NULL AFTER prompt_sha256,
           ADD COLUMN request_fingerprint CHAR(64) NULL AFTER operation_key`,
      );
      await predecessor.query(
        `ALTER TABLE retrieval_runs
           ADD COLUMN workflow_job_id VARCHAR(36) NULL AFTER project_id,
           ADD COLUMN revision_attempt TINYINT UNSIGNED NULL
             AFTER workflow_job_id,
           ADD COLUMN request_sha256 CHAR(64) NULL AFTER revision_attempt`,
      );
      for (const query of ['generic-before-a', 'generic-before-b']) {
        await insertAtomicRetrievalRun(predecessor, {
          id: randomUUID(),
          projectId,
          query,
          workflowJobId: null,
          revisionAttempt: null,
          requestSha256: null,
        });
      }
      const invalidId = randomUUID();
      await insertAtomicRetrievalRun(predecessor, {
        id: invalidId,
        projectId,
        query: 'invalid-before-check',
        workflowJobId: null,
        revisionAttempt: 1,
        requestSha256: null,
      });

      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        const migration = new HardenAtomicOperationIdempotency1713340000000();
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_INVALID_RETRIEVAL_SCOPE',
        );
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          invalidId,
        ]);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          findAtomicOperationSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }
      await expect(
        predecessor.query(
          `SELECT COUNT(*) AS count
             FROM retrieval_runs
            WHERE workflow_job_id IS NULL
              AND revision_attempt IS NULL
              AND request_sha256 IS NULL`,
        ),
      ).resolves.toEqual([{ count: '2' }]);
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('rejects unsafe partial atomic rows and duplicate model operations before any DDL', async () => {
    const schema = `atomic_partial_pf_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter(
        (Migration) =>
          new Migration().name !==
          'HardenAtomicOperationIdempotency1713340000000',
      ),
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const jobId = randomUUID();
    const migration = new HardenAtomicOperationIdempotency1713340000000();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await predecessor.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Partial preflight')`,
        [projectId, userId],
      );
      await predecessor.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'partial-preflight', ?, 'RUNNING')`,
        [jobId, userId, projectId, 'a'.repeat(64)],
      );
      await predecessor.query(
        `ALTER TABLE model_runs
           ADD COLUMN operation_key CHAR(64) NULL AFTER prompt_sha256`,
      );
      await predecessor.query(
        `ALTER TABLE retrieval_runs
           ADD COLUMN workflow_job_id VARCHAR(36) NULL AFTER project_id`,
      );
      const unsafeRetrievalId = randomUUID();
      await predecessor.query(
        `INSERT INTO retrieval_runs
           (id, project_id, workflow_job_id, query, task_type, query_plan,
            state, canonical_path)
         VALUES (?, ?, ?, 'partial-targeted', 'content', JSON_OBJECT(),
                 'READY', 'hybrid')`,
        [unsafeRetrievalId, projectId, jobId],
      );

      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        const beforeUnsafe = await snapshotAtomicPreflightSchema(
          predecessor,
          schema,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_INVALID_RETRIEVAL_SCOPE',
        );
        await expect(
          snapshotAtomicPreflightSchema(predecessor, schema),
        ).resolves.toEqual(beforeUnsafe);
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          unsafeRetrievalId,
        ]);

        await runner.query(
          `INSERT INTO retrieval_runs
             (id, project_id, workflow_job_id, query, task_type, query_plan,
              state, canonical_path)
           VALUES (?, ?, NULL, 'partial-generic', 'content', JSON_OBJECT(),
                   'READY', 'hybrid')`,
          [randomUUID(), projectId],
        );
        const duplicateOperation = 'b'.repeat(64);
        const modelRunIds = [randomUUID(), randomUUID()];
        await runner.query(
          `INSERT INTO model_runs
             (id, workflow_job_id, provider, model, attempt_number,
              workflow_node, attempt_kind, generation_attempt,
              network_attempt, repair_attempt, operation_key, status)
           VALUES
             (?, ?, 'fake', 'model-a', 1, 'draft', 'initial', 1, 0, 0, ?,
              'RUNNING'),
             (?, ?, 'fake', 'model-b', 2, 'draft', 'initial', 1, 0, 0, ?,
              'RUNNING')`,
          [
            modelRunIds[0],
            jobId,
            duplicateOperation,
            modelRunIds[1],
            jobId,
            duplicateOperation,
          ],
        );
        const beforeDuplicate = await snapshotAtomicPreflightSchema(
          predecessor,
          schema,
        );
        await expect(migration.up(runner)).rejects.toThrow(
          'ATOMIC_OPERATION_DUPLICATE_MODEL_OPERATION',
        );
        await expect(
          snapshotAtomicPreflightSchema(predecessor, schema),
        ).resolves.toEqual(beforeDuplicate);

        await runner.query(`DELETE FROM model_runs WHERE id = ?`, [
          modelRunIds[1],
        ]);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          findAtomicOperationSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('preflights orphan, invalid and duplicate targeted retrieval data before filling another missing column', async () => {
    const schema = `atomic_data_pf_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations.filter(
        (Migration) =>
          new Migration().name !==
          'HardenAtomicOperationIdempotency1713340000000',
      ),
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const jobId = randomUUID();
    const migration = new HardenAtomicOperationIdempotency1713340000000();

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await predecessor.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Data preflight')`,
        [projectId, userId],
      );
      await predecessor.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'data-preflight', ?, 'RUNNING')`,
        [jobId, userId, projectId, 'c'.repeat(64)],
      );
      await predecessor.query(
        `ALTER TABLE model_runs
           ADD COLUMN operation_key CHAR(64) NULL AFTER prompt_sha256`,
      );
      await predecessor.query(
        `ALTER TABLE retrieval_runs
           ADD COLUMN workflow_job_id VARCHAR(36) NULL AFTER project_id,
           ADD COLUMN revision_attempt TINYINT UNSIGNED NULL
             AFTER workflow_job_id,
           ADD COLUMN request_sha256 CHAR(64) NULL AFTER revision_attempt`,
      );

      const runner = predecessor.createQueryRunner();
      await runner.connect();
      try {
        const assertRejectedWithoutDdl = async (
          expectedError: string,
        ): Promise<void> => {
          const before = await snapshotAtomicPreflightSchema(
            predecessor,
            schema,
          );
          await expect(migration.up(runner)).rejects.toThrow(expectedError);
          await expect(
            snapshotAtomicPreflightSchema(predecessor, schema),
          ).resolves.toEqual(before);
        };

        const orphanId = randomUUID();
        await insertAtomicRetrievalRun(predecessor, {
          id: orphanId,
          projectId,
          query: 'orphan',
          workflowJobId: randomUUID(),
          revisionAttempt: 1,
          requestSha256: 'd'.repeat(64),
        });
        await assertRejectedWithoutDdl(
          'ATOMIC_OPERATION_ORPHANED_WORKFLOW_JOB',
        );
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          orphanId,
        ]);

        const badRevisionId = randomUUID();
        await insertAtomicRetrievalRun(predecessor, {
          id: badRevisionId,
          projectId,
          query: 'bad-revision',
          workflowJobId: jobId,
          revisionAttempt: 2,
          requestSha256: 'e'.repeat(64),
        });
        await assertRejectedWithoutDdl(
          'ATOMIC_OPERATION_INVALID_RETRIEVAL_SCOPE',
        );
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          badRevisionId,
        ]);

        const badDigestId = randomUUID();
        await insertAtomicRetrievalRun(predecessor, {
          id: badDigestId,
          projectId,
          query: 'bad-digest',
          workflowJobId: jobId,
          revisionAttempt: 1,
          requestSha256: 'F'.repeat(64),
        });
        await assertRejectedWithoutDdl(
          'ATOMIC_OPERATION_INVALID_RETRIEVAL_SCOPE',
        );
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          badDigestId,
        ]);

        const duplicateIds = [randomUUID(), randomUUID()];
        for (const [index, id] of duplicateIds.entries()) {
          await insertAtomicRetrievalRun(predecessor, {
            id,
            projectId,
            query: `duplicate-${index}`,
            workflowJobId: jobId,
            revisionAttempt: 1,
            requestSha256: String(index + 1).repeat(64),
          });
        }
        await assertRejectedWithoutDdl(
          'ATOMIC_OPERATION_DUPLICATE_RETRIEVAL_REVISION',
        );
        await runner.query(`DELETE FROM retrieval_runs WHERE id = ?`, [
          duplicateIds[1],
        ]);

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          findAtomicOperationSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }
    } finally {
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('rolls back the business result and ledger when evidence expires at commit time', async () => {
    const schema = `grounding_transaction_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const workflowJobId = randomUUID();
    const retrievalRunId = randomUUID();
    const fileId = randomUUID();
    const documentId = randomUUID();
    const chunkId = randomUUID();
    const resultId = randomUUID();
    const claimId = 'c'.repeat(64);
    const ingestionKey = 'b'.repeat(64);
    const evidenceId = `evidence:${chunkId}`;

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Grounding transaction')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'grounding-transaction', ?, 'RUNNING')`,
        [workflowJobId, userId, projectId, 'f'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            checksum_sha256, active_ingestion_key, parse_status)
         VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md', ?, ?, 'done')`,
        [fileId, projectId, 'a'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO documents
           (id, file_id, project_id, title, content_text, source_checksum,
            parser_version, chunk_version, ingestion_key, ast, is_active)
         VALUES (?, ?, ?, 'Fixture', '装机容量为 300 MW', ?, 'md-v1',
                 'token-v1', ?, JSON_OBJECT(), 1)`,
        [documentId, fileId, projectId, 'a'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO chunks
           (id, project_id, file_id, document_id, chunk_index, content,
            search_text, stable_key, ingestion_key, position, token_count,
            tokenizer_version, char_start, char_end, is_active)
         VALUES (?, ?, ?, ?, 0, '装机容量为 300 MW', '装机容量为 300 MW',
                 ?, ?, 0, 8, 'token-v1', 100, 112, 1)`,
        [chunkId, projectId, fileId, documentId, 'e'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO retrieval_runs
           (id, project_id, query, task_type, query_plan, state,
            canonical_path)
         VALUES (?, ?, '装机容量', 'content', JSON_OBJECT(), 'READY',
                 'hybrid')`,
        [retrievalRunId, projectId],
      );
      await dataSource.query(
        `INSERT INTO retrieval_candidates
           (retrieval_run_id, chunk_id, file_id, document_id, ingestion_key,
            fusion_rank, fusion_score, rerank_rank, rerank_score, selected,
            evidence)
         VALUES (?, ?, ?, ?, ?, 1, 0.8, 1, 0.9, 1, ?)`,
        [
          retrievalRunId,
          chunkId,
          fileId,
          documentId,
          ingestionKey,
          JSON.stringify({
            evidence_id: evidenceId,
            chunk_id: chunkId,
            exact_span: {
              text: '装机容量为 300 MW',
              char_start: 100,
              char_end: 112,
            },
            source: {
              file_id: fileId,
              document_id: documentId,
              ingestion_key: ingestionKey,
              page_start: 1,
              page_end: 1,
              heading_path: [],
            },
          }),
        ],
      );
      const store = new SqlGroundingEvidenceStore(dataSource);
      await store.assignEvidence({
        workflow_job_id: workflowJobId,
        project_id: projectId,
        retrieval_run_id: retrievalRunId,
        retrieval_state: 'READY',
        evidence_ids: [evidenceId],
        strict_mode: true,
        contract_version: 'atomic:v1',
      });
      const assignment = await store.loadAssignment(workflowJobId);
      expect(assignment?.contract_version).toBe('atomic:v1');
      expect(assignment?.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
      await dataSource.query(
        `UPDATE grounding_assignments
            SET contract_version = 'legacy:v0'
          WHERE workflow_job_id = ?`,
        [workflowJobId],
      );
      await expect(store.loadAssignment(workflowJobId)).rejects.toThrow(
        'grounding assignment 快照摘要不一致',
      );
      await dataSource.query(
        `UPDATE grounding_assignments
            SET contract_version = 'atomic:v1'
          WHERE workflow_job_id = ?`,
        [workflowJobId],
      );
      await dataSource.query(
        `UPDATE retrieval_candidates
            SET rerank_score = 0.7
          WHERE retrieval_run_id = ?
            AND chunk_id = ?`,
        [retrievalRunId, chunkId],
      );

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO writing_results
               (id, project_id, task_type, status, content_text)
             VALUES (?, ?, 'generate', 'succeeded', '装机容量为 300 MW')`,
            [resultId, projectId],
          );
          await store.saveLedger(manager, resultId, {
            workflow_job_id: workflowJobId,
            project_id: projectId,
            retrieval_run_id: retrievalRunId,
            assignment_snapshot_digest: assignment?.snapshot_digest,
            decision: 'ALLOW',
            claims: [
              {
                claim_id: claimId,
                claim_text: '装机容量为 300 MW',
                normalized_claim_text: '装机容量为300mw',
                output_char_start: 0,
                output_char_end: 12,
                support_status: 'SUPPORTED',
                support_score: 1,
                verification_method: 'deterministic_exact',
                links: [
                  {
                    ...assignment!.evidence[0],
                    exact_span_chunk_start: 0,
                    exact_span_chunk_end: 12,
                  },
                ],
              },
            ],
          });
        }),
      ).rejects.toThrow('证据候选或索引快照已变化');
      await expect(
        dataSource.query(
          `SELECT id FROM writing_results WHERE id = ?
           UNION ALL
           SELECT claim_id AS id FROM grounding_claims WHERE claim_id = ?`,
          [resultId, claimId],
        ),
      ).resolves.toEqual([]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('fails closed on an ambiguous legacy evidence id across retrieval runs', async () => {
    const schema = `grounding_legacy_collision_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const workflowJobId = randomUUID();
    const oldRunId = randomUUID();
    const newRunId = randomUUID();
    const fileId = randomUUID();
    const documentId = randomUUID();
    const chunkId = randomUUID();
    const ingestionKey = '4'.repeat(64);
    const legacyEvidenceId = `legacy:${chunkId}`;
    const content = '装机容量为300MW。年发电量为12亿千瓦时。';

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Legacy evidence collision')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'legacy-evidence-collision', ?,
                 'RUNNING')`,
        [workflowJobId, userId, projectId, '5'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            checksum_sha256, active_ingestion_key, parse_status)
         VALUES (?, ?, 'legacy.md', 'md', '/tmp/legacy.md', ?, ?, 'done')`,
        [fileId, projectId, '6'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO documents
           (id, file_id, project_id, title, content_text, source_checksum,
            parser_version, chunk_version, ingestion_key, ast, is_active)
         VALUES (?, ?, ?, 'Legacy', ?, ?, 'md-v1', 'token-v1', ?,
                 JSON_OBJECT(), 1)`,
        [documentId, fileId, projectId, content, '6'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO chunks
           (id, project_id, file_id, document_id, chunk_index, content,
            search_text, stable_key, ingestion_key, position, token_count,
            tokenizer_version, char_start, char_end, is_active)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 20, 'token-v1', 0, ?, 1)`,
        [
          chunkId,
          projectId,
          fileId,
          documentId,
          content,
          content,
          '7'.repeat(64),
          ingestionKey,
          content.length,
        ],
      );
      await dataSource.query(
        `INSERT INTO retrieval_runs
           (id, project_id, query, task_type, query_plan, state,
            canonical_path)
         VALUES
           (?, ?, '装机容量', 'content', JSON_OBJECT(), 'READY', 'hybrid'),
           (?, ?, '年发电量', 'content', JSON_OBJECT(), 'READY', 'hybrid')`,
        [oldRunId, projectId, newRunId, projectId],
      );
      const evidenceJson = (text: string, start: number) =>
        JSON.stringify({
          evidence_id: legacyEvidenceId,
          chunk_id: chunkId,
          exact_span: {
            text,
            char_start: start,
            char_end: start + text.length,
          },
          source: {
            file_id: fileId,
            document_id: documentId,
            ingestion_key: ingestionKey,
            page_start: 1,
            page_end: 1,
            heading_path: [],
          },
        });
      const oldSpan = '装机容量为300MW';
      const newSpan = '年发电量为12亿千瓦时';
      await dataSource.query(
        `INSERT INTO retrieval_candidates
           (retrieval_run_id, chunk_id, file_id, document_id, ingestion_key,
            fusion_rank, fusion_score, rerank_rank, rerank_score, selected,
            evidence)
         VALUES
           (?, ?, ?, ?, ?, 1, 0.8, 1, 0.9, 1, ?),
           (?, ?, ?, ?, ?, 1, 0.8, 1, 0.9, 1, ?)`,
        [
          oldRunId,
          chunkId,
          fileId,
          documentId,
          ingestionKey,
          evidenceJson(oldSpan, content.indexOf(oldSpan)),
          newRunId,
          chunkId,
          fileId,
          documentId,
          ingestionKey,
          evidenceJson(newSpan, content.indexOf(newSpan)),
        ],
      );
      await dataSource.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode,
            targeted_revision_attempts)
         VALUES (?, ?, ?, 'READY', ?, ?, 1, 1)`,
        [
          workflowJobId,
          projectId,
          newRunId,
          JSON.stringify([oldRunId, newRunId]),
          JSON.stringify([legacyEvidenceId]),
        ],
      );
      const store = new SqlGroundingEvidenceStore(dataSource);

      await expect(store.loadAssignment(workflowJobId)).rejects.toThrow(
        'legacy evidence id 歧义',
      );
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('caps legacy reverify and inherits only a closed atomic claim ledger', async () => {
    const schema = `grounding_revision_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const workflowJobId = randomUUID();
    const oldRunId = randomUUID();
    const newRunId = randomUUID();
    const fileId = randomUUID();
    const documentId = randomUUID();
    const oldChunkId = randomUUID();
    const newChunkId = randomUUID();
    const resultId = randomUUID();
    const compressWorkflowJobId = randomUUID();
    const legacyParentWorkflowJobId = randomUUID();
    const mixedLegacyCompressWorkflowJobId = randomUUID();
    const nullRefCompressWorkflowJobId = randomUUID();
    const zeroCitationCompressWorkflowJobId = randomUUID();
    const legacyCompressWorkflowJobId = randomUUID();
    const ingestionKey = '7'.repeat(64);
    const oldEvidenceId = `evidence:${oldChunkId}`;
    const newEvidenceId = `evidence:${newChunkId}`;
    const supportedClaim = '装机容量为 300 MW。';
    const revisedClaim = '年发电量为 12 亿千瓦时。';

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Grounding revision')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'grounding-revision', ?, 'RUNNING')`,
        [workflowJobId, userId, projectId, '8'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            checksum_sha256, active_ingestion_key, parse_status)
         VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md', ?, ?, 'done')`,
        [fileId, projectId, '9'.repeat(64), ingestionKey],
      );
      await dataSource.query(
        `INSERT INTO documents
           (id, file_id, project_id, title, content_text, source_checksum,
            parser_version, chunk_version, ingestion_key, ast, is_active)
         VALUES (?, ?, ?, 'Fixture', ?, ?, 'md-v1', 'token-v1', ?,
                 JSON_OBJECT(), 1)`,
        [
          documentId,
          fileId,
          projectId,
          `${supportedClaim}\n${revisedClaim}`,
          '9'.repeat(64),
          ingestionKey,
        ],
      );
      await dataSource.query(
        `INSERT INTO chunks
           (id, project_id, file_id, document_id, chunk_index, content,
            search_text, stable_key, ingestion_key, position, token_count,
            tokenizer_version, char_start, char_end, is_active)
         VALUES
           (?, ?, ?, ?, 0, '装机容量为 300 MW', '装机容量为 300 MW',
            ?, ?, 0, 8, 'token-v1', 0, 12, 1),
           (?, ?, ?, ?, 1, '年发电量为 12 亿千瓦时',
            '年发电量为 12 亿千瓦时', ?, ?, 1, 10, 'token-v1', 20, 34, 1)`,
        [
          oldChunkId,
          projectId,
          fileId,
          documentId,
          'a'.repeat(64),
          ingestionKey,
          newChunkId,
          projectId,
          fileId,
          documentId,
          'b'.repeat(64),
          ingestionKey,
        ],
      );
      await dataSource.query(
        `INSERT INTO retrieval_runs
           (id, project_id, query, task_type, query_plan, state,
            canonical_path)
         VALUES
           (?, ?, '装机容量', 'content', JSON_OBJECT(), 'READY', 'hybrid'),
           (?, ?, '年发电量', 'content', JSON_OBJECT(), 'READY', 'hybrid')`,
        [oldRunId, projectId, newRunId, projectId],
      );
      const evidenceJson = (
        evidenceId: string,
        chunkId: string,
        text: string,
        start: number,
      ) =>
        JSON.stringify({
          evidence_id: evidenceId,
          chunk_id: chunkId,
          exact_span: {
            text,
            char_start: start,
            char_end: start + text.length,
          },
          source: {
            file_id: fileId,
            document_id: documentId,
            ingestion_key: ingestionKey,
            page_start: 1,
            page_end: 1,
            heading_path: [],
          },
        });
      await dataSource.query(
        `INSERT INTO retrieval_candidates
           (retrieval_run_id, chunk_id, file_id, document_id, ingestion_key,
            fusion_rank, fusion_score, rerank_rank, rerank_score, selected,
            evidence)
         VALUES
           (?, ?, ?, ?, ?, 1, 0.8, 1, 0.9, 1, ?),
           (?, ?, ?, ?, ?, 1, 0.8, 1, 0.9, 1, ?)`,
        [
          oldRunId,
          oldChunkId,
          fileId,
          documentId,
          ingestionKey,
          evidenceJson(oldEvidenceId, oldChunkId, '装机容量为 300 MW', 0),
          newRunId,
          newChunkId,
          fileId,
          documentId,
          ingestionKey,
          evidenceJson(newEvidenceId, newChunkId, '年发电量为 12 亿千瓦时', 20),
        ],
      );
      const store = new SqlGroundingEvidenceStore(dataSource);
      const ledger = new CitationLedgerService(store, new GroundingVerifier());
      await store.assignEvidence({
        workflow_job_id: workflowJobId,
        project_id: projectId,
        retrieval_run_id: oldRunId,
        retrieval_state: 'READY',
        evidence_ids: [oldEvidenceId],
        strict_mode: true,
        contract_version: 'atomic:v1',
      });
      const initialOutput =
        `${supportedClaim}\n` +
        `<!-- claim_evidence:${JSON.stringify({
          claim_text: supportedClaim,
          evidence_ids: [oldEvidenceId],
        })} -->\n` +
        '年发电量为 99 亿千瓦时。\n' +
        `<!-- claim_evidence:${JSON.stringify({
          claim_text: '年发电量为 99 亿千瓦时。',
          evidence_ids: [oldEvidenceId],
        })} -->`;
      await expect(
        ledger.prepare({
          workflow_job_id: workflowJobId,
          project_id: projectId,
          output: initialOutput,
        }),
      ).rejects.toBeInstanceOf(GroundingRevisionRequiredError);
      await dataSource.query(
        `UPDATE grounding_assignments
            SET targeted_revision_attempts = 1
          WHERE workflow_job_id = ?`,
        [workflowJobId],
      );
      await store.replaceEvidenceAfterTargetedRetrieval({
        workflow_job_id: workflowJobId,
        project_id: projectId,
        retrieval_run_id: newRunId,
        retrieval_state: 'READY',
        evidence_ids: [newEvidenceId],
        strict_mode: true,
        contract_version: 'atomic:v1',
        revision_attempt: 1,
      });
      const revisedOutput =
        `${supportedClaim}\n` +
        `<!-- claim_evidence:${JSON.stringify({
          claim_text: supportedClaim,
          evidence_ids: [oldEvidenceId],
        })} -->\n` +
        `${revisedClaim}\n` +
        `<!-- claim_evidence:${JSON.stringify({
          claim_text: revisedClaim,
          evidence_ids: [newEvidenceId],
        })} -->`;
      await expect(
        ledger.prepare({
          workflow_job_id: workflowJobId,
          project_id: projectId,
          output: revisedOutput,
        }),
      ).rejects.toBeInstanceOf(MaterialGapError);
      const parentAssignment = await store.loadAssignment(workflowJobId);
      expect(parentAssignment?.contract_version).toBe('atomic:v1');
      const parentDigest = parentAssignment?.snapshot_digest;
      expect(parentDigest).toMatch(/^[a-f0-9]{64}$/);
      const oldClaimId = 'a'.repeat(64);
      const newClaimId = 'b'.repeat(64);
      await dataSource.query(
        `INSERT INTO writing_results
           (id, project_id, task_type, status, content_text)
         VALUES (?, ?, 'generate', 'succeeded', ?)`,
        [resultId, projectId, revisedOutput],
      );
      await dataSource.query(
        `INSERT INTO grounding_claims
           (claim_id, workflow_job_id, project_id, result_id, claim_text,
            normalized_claim_text, output_char_start, output_char_end,
            support_status, support_score, verification_method, atomic_claim)
         VALUES
           (?, ?, ?, ?, ?, ?, 0, 13, 'SUPPORTED', 1,
            'atomic_extract_exact', ?),
           (?, ?, ?, ?, ?, ?, 14, 29, 'SUPPORTED', 1,
            'atomic_typed_equivalent', ?)`,
        [
          oldClaimId,
          workflowJobId,
          projectId,
          resultId,
          supportedClaim,
          '装机容量为300mw',
          JSON.stringify(atomicClaimFixture()),
          newClaimId,
          workflowJobId,
          projectId,
          resultId,
          revisedClaim,
          '年发电量为12亿千瓦时',
          JSON.stringify(atomicClaimFixture()),
        ],
      );
      await dataSource.query(
        `INSERT INTO citation_maps
           (id, project_id, result_id, paragraph_key, chunk_id, file_id,
            use_type, evidence_text, confidence_score, claim_id, evidence_id,
            document_id, retrieval_run_id, support_status, support_score,
            verification_method, snapshot_digest)
         VALUES
           (?, ?, ?, 'claim:old', ?, ?, 'synthesize', ?, 1, ?, ?, ?, ?,
            'SUPPORTED', 1, 'atomic_extract_exact', ?),
           (?, ?, ?, 'claim:new', ?, ?, 'synthesize', ?, 1, ?, ?, ?, ?,
            'SUPPORTED', 1, 'atomic_typed_equivalent', ?)`,
        [
          randomUUID(),
          projectId,
          resultId,
          oldChunkId,
          fileId,
          '装机容量为 300 MW',
          oldClaimId,
          oldEvidenceId,
          documentId,
          oldRunId,
          parentDigest,
          randomUUID(),
          projectId,
          resultId,
          newChunkId,
          fileId,
          '年发电量为 12 亿千瓦时',
          newClaimId,
          newEvidenceId,
          documentId,
          newRunId,
          parentDigest,
        ],
      );
      await expect(
        dataSource.query(
          `SELECT JSON_LENGTH(retrieval_run_refs) AS runCount,
                  JSON_LENGTH(evidence_ids) AS evidenceCount
             FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [workflowJobId],
        ),
      ).resolves.toEqual([{ runCount: '2', evidenceCount: '2' }]);

      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'compress', 'grounding-compress', ?, 'RUNNING')`,
        [compressWorkflowJobId, userId, projectId, '6'.repeat(64)],
      );
      const inherited = await store.inheritEvidenceAssignment({
        workflow_job_id: compressWorkflowJobId,
        project_id: projectId,
        parent_result_id: resultId,
        strict_mode: true,
        contract_version: 'atomic:v1',
      });
      expect(inherited.retrieval_run_id).toBe(newRunId);
      expect(inherited.retrieval_run_refs).toEqual([oldRunId, newRunId]);
      const inheritedEvidenceRefs = inherited.evidence.map((item) => [
        item.evidence_id,
        item.retrieval_run_id,
      ]);
      expect(inheritedEvidenceRefs).toHaveLength(2);
      expect(inheritedEvidenceRefs).toEqual(
        expect.arrayContaining([
          [oldEvidenceId, oldRunId],
          [newEvidenceId, newRunId],
        ]),
      );
      expect(inherited.contract_version).toBe('atomic:v1');

      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES
           (?, ?, ?, 'content', 'grounding-parent-legacy', ?, 'RUNNING'),
           (?, ?, ?, 'compress', 'grounding-compress-mixed-legacy', ?,
            'RUNNING'),
           (?, ?, ?, 'compress', 'grounding-compress-null-ref', ?,
            'RUNNING'),
           (?, ?, ?, 'compress', 'grounding-compress-zero-citation', ?,
            'RUNNING')`,
        [
          legacyParentWorkflowJobId,
          userId,
          projectId,
          '4'.repeat(64),
          mixedLegacyCompressWorkflowJobId,
          userId,
          projectId,
          '3'.repeat(64),
          nullRefCompressWorkflowJobId,
          userId,
          projectId,
          '2'.repeat(64),
          zeroCitationCompressWorkflowJobId,
          userId,
          projectId,
          '1'.repeat(64),
        ],
      );
      const attemptInvalidInheritance = async (
        targetWorkflowJobId: string,
      ): Promise<'material-gap' | 'resolved' | 'unexpected-error'> => {
        try {
          await store.inheritEvidenceAssignment({
            workflow_job_id: targetWorkflowJobId,
            project_id: projectId,
            parent_result_id: resultId,
            strict_mode: true,
            contract_version: 'atomic:v1',
          });
          return 'resolved';
        } catch (error) {
          return error instanceof MaterialGapError
            ? 'material-gap'
            : 'unexpected-error';
        }
      };

      await dataSource.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, snapshot_digest, strict_mode,
            targeted_revision_attempts, contract_version)
         SELECT ?, project_id, retrieval_run_id, retrieval_state,
                retrieval_run_refs, evidence_ids, NULL, strict_mode,
                targeted_revision_attempts, 'legacy:v0'
           FROM grounding_assignments
          WHERE workflow_job_id = ?`,
        [legacyParentWorkflowJobId, workflowJobId],
      );
      await dataSource.query(
        `UPDATE grounding_claims
            SET workflow_job_id = ?
          WHERE claim_id = ?`,
        [legacyParentWorkflowJobId, newClaimId],
      );
      const mixedLegacyOutcome = await attemptInvalidInheritance(
        mixedLegacyCompressWorkflowJobId,
      );
      await dataSource.query(
        `UPDATE grounding_claims
            SET workflow_job_id = ?
          WHERE claim_id = ?`,
        [workflowJobId, newClaimId],
      );

      await dataSource.query(
        `UPDATE citation_maps
            SET snapshot_digest = NULL
          WHERE claim_id = ?`,
        [newClaimId],
      );
      const nullRefOutcome = await attemptInvalidInheritance(
        nullRefCompressWorkflowJobId,
      );
      await dataSource.query(
        `UPDATE citation_maps
            SET snapshot_digest = ?
          WHERE claim_id = ?`,
        [parentDigest, newClaimId],
      );

      await dataSource.query(
        `DELETE FROM citation_maps
          WHERE claim_id = ?`,
        [newClaimId],
      );
      const zeroCitationOutcome = await attemptInvalidInheritance(
        zeroCitationCompressWorkflowJobId,
      );

      expect({
        mixedLegacyOutcome,
        nullRefOutcome,
        zeroCitationOutcome,
      }).toEqual({
        mixedLegacyOutcome: 'material-gap',
        nullRefOutcome: 'material-gap',
        zeroCitationOutcome: 'material-gap',
      });
      await expect(
        dataSource.query(
          `SELECT COUNT(*) AS count
             FROM grounding_assignments
            WHERE workflow_job_id IN (?, ?, ?)`,
          [
            mixedLegacyCompressWorkflowJobId,
            nullRefCompressWorkflowJobId,
            zeroCitationCompressWorkflowJobId,
          ],
        ),
      ).resolves.toEqual([{ count: '0' }]);

      await dataSource.query(
        `UPDATE grounding_assignments
            SET contract_version = 'legacy:v0'
          WHERE workflow_job_id = ?`,
        [workflowJobId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'compress', 'grounding-compress-legacy', ?,
                 'RUNNING')`,
        [legacyCompressWorkflowJobId, userId, projectId, '5'.repeat(64)],
      );
      await expect(
        store.inheritEvidenceAssignment({
          workflow_job_id: legacyCompressWorkflowJobId,
          project_id: projectId,
          parent_result_id: resultId,
          strict_mode: true,
          contract_version: 'atomic:v1',
        }),
      ).rejects.toBeInstanceOf(MaterialGapError);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('persists, recovers, resumes, and cancels the one-shot grounding revision state', async () => {
    const schema = `grounding_revision_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const workflowJobId = randomUUID();
    const retrievalRunId = randomUUID();

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Grounding revision')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'grounding-revision', ?, 'QUEUED')`,
        [workflowJobId, userId, projectId, 'f'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO retrieval_runs
           (id, project_id, query, task_type, query_plan, state,
            canonical_path)
         VALUES (?, ?, '待修订声明', 'content', JSON_OBJECT(), 'READY',
                 'hybrid')`,
        [retrievalRunId, projectId],
      );
      await dataSource.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode,
            targeted_revision_attempts)
         VALUES (?, ?, ?, 'READY', JSON_ARRAY(?), JSON_ARRAY(), 1, 0)`,
        [workflowJobId, projectId, retrievalRunId, retrievalRunId],
      );

      const executionStore = new MysqlWorkflowExecutionStore(dataSource);
      const firstClaim = await executionStore.claim(
        workflowJobId,
        'revision-worker-1',
      );
      expect(firstClaim).not.toBeNull();
      await executionStore.fail(
        firstClaim!,
        new GroundingRevisionRequiredError([
          { claim_id: 'claim-1', claim_text: '待修订声明。' },
        ]),
      );
      await expect(
        dataSource.query(
          `SELECT w.status, ga.targeted_revision_attempts AS attempts,
                  JSON_UNQUOTE(JSON_EXTRACT(w.checkpoint, '$.phase')) AS phase
             FROM workflow_jobs w
             JOIN grounding_assignments ga ON ga.workflow_job_id = w.id
            WHERE w.id = ?`,
          [workflowJobId],
        ),
      ).resolves.toEqual([
        {
          status: WorkflowStatus.REVISION_REQUIRED,
          attempts: 1,
          phase: 'revision_required',
        },
      ]);

      const recovered = await executionStore.claim(
        workflowJobId,
        'revision-worker-2',
      );
      expect(recovered).not.toBeNull();
      await executionStore.fail(
        recovered!,
        new GroundingRevisionRequiredError([
          { claim_id: 'claim-1', claim_text: '仍然缺少支持。' },
        ]),
      );
      await expect(
        dataSource.query(`SELECT status FROM workflow_jobs WHERE id = ?`, [
          workflowJobId,
        ]),
      ).resolves.toEqual([{ status: WorkflowStatus.WAITING_MATERIAL }]);

      const workflows = new WorkflowService(
        dataSource.getRepository(WorkflowJob),
        dataSource.getRepository(WorkflowEvent),
        dataSource,
        new ProjectAccessPolicy(dataSource.getRepository(Project)),
      );
      const concurrentResumes = await Promise.allSettled([
        workflows.resumeMaterial(userId, projectId, workflowJobId),
        workflows.resumeMaterial(userId, projectId, workflowJobId),
      ]);
      expect(
        concurrentResumes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        concurrentResumes.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        concurrentResumes.find((result) => result.status === 'fulfilled'),
      ).toMatchObject({
        value: { status: WorkflowStatus.QUEUED },
      });
      await expect(
        dataSource.query(
          `SELECT workflow_job_id FROM grounding_assignments
            WHERE workflow_job_id = ?`,
          [workflowJobId],
        ),
      ).resolves.toEqual([]);
      await expect(
        workflows.cancel(userId, projectId, workflowJobId),
      ).resolves.toMatchObject({ status: WorkflowStatus.STOPPED });
      await expect(
        dataSource.query(
          `SELECT type, COUNT(*) AS count
             FROM workflow_events
            WHERE job_id = ?
              AND type IN (
                'grounding.revision_required',
                'grounding.material_gap',
                'workflow.material_resumed',
                'workflow.cancelled'
              )
            GROUP BY type
            ORDER BY type`,
          [workflowJobId],
        ),
      ).resolves.toEqual([
        { type: 'grounding.material_gap', count: '1' },
        { type: 'grounding.revision_required', count: '1' },
        { type: 'workflow.cancelled', count: '1' },
        { type: 'workflow.material_resumed', count: '1' },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('adds parse-attempt leases to an already structured schema without changing source rows', async () => {
    const schema = `migration_parse_lease_${randomUUID().replaceAll('-', '')}`;
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const predecessor = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter(
        (Migration) =>
          new Migration().name !== 'AddParseAttemptLeases1712800000000',
      ),
    );
    let upgraded: DataSource | undefined;

    try {
      await predecessor.initialize();
      await predecessor.runMigrations();
      await predecessor.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await predecessor.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'parse lease migration')`,
        [projectId, userId],
      );
      await predecessor.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path, parse_status)
         VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md', 'failed')`,
        [fileId, projectId],
      );
      await predecessor.query(
        `ALTER TABLE source_files
           DROP COLUMN parse_lease_expires_at,
           DROP COLUMN parse_attempt_token`,
      );
      await predecessor.destroy();

      upgraded = createMigrationDataSource(schema, mysqlPort);
      await upgraded.initialize();
      await expect(upgraded.runMigrations()).resolves.toHaveLength(1);
      await expect(
        upgraded.query(
          `SELECT id, parse_status AS parseStatus,
                  parse_attempt_token AS attemptToken,
                  parse_lease_expires_at AS leaseExpiresAt
             FROM source_files
            WHERE id = ?`,
          [fileId],
        ),
      ).resolves.toEqual([
        {
          id: fileId,
          parseStatus: 'failed',
          attemptToken: null,
          leaseExpiresAt: null,
        },
      ]);
      await upgraded.destroy();
    } finally {
      if (upgraded?.isInitialized) await upgraded.destroy();
      if (predecessor.isInitialized) await predecessor.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('creates the workflow persistence tables with concurrency constraints', async () => {
    const schema = `migration_workflow_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const contractRunner = dataSource.createQueryRunner();
      await contractRunner.connect();
      try {
        await expect(
          findWorkflowSchemaContractViolations(contractRunner),
        ).resolves.toEqual([]);
      } finally {
        await contractRunner.release();
      }
      const rows = await dataSource.query<
        Array<{ tableName: string; indexName: string }>
      >(
        `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
            AND (
              (TABLE_NAME = 'workflow_jobs'
                AND INDEX_NAME = 'uq_workflow_jobs_idempotency')
              OR
              (TABLE_NAME = 'workflow_events'
                AND INDEX_NAME = 'uq_workflow_events_job_seq')
            )
          GROUP BY TABLE_NAME, INDEX_NAME
          ORDER BY TABLE_NAME`,
        [schema],
      );
      expect(rows).toEqual([
        {
          tableName: 'workflow_events',
          indexName: 'uq_workflow_events_job_seq',
        },
        {
          tableName: 'workflow_jobs',
          indexName: 'uq_workflow_jobs_idempotency',
        },
      ]);
      await expect(
        dataSource.query(
          `SELECT TABLE_NAME AS tableName, ENGINE AS engine,
                  TABLE_COLLATION AS collation
             FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME IN
                ('workflow_jobs', 'workflow_events', 'model_runs')
            ORDER BY TABLE_NAME`,
          [schema],
        ),
      ).resolves.toEqual([
        {
          tableName: 'model_runs',
          engine: 'InnoDB',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          tableName: 'workflow_events',
          engine: 'InnoDB',
          collation: 'utf8mb4_0900_ai_ci',
        },
        {
          tableName: 'workflow_jobs',
          engine: 'InnoDB',
          collation: 'utf8mb4_0900_ai_ci',
        },
      ]);
      await expect(
        dataSource.query(
          `SELECT COLUMN_NAME AS columnName
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'workflow_jobs'
              AND COLUMN_NAME IN
                ('request_hash', 'public_error_code', 'public_error_message',
                 'lease_owner', 'lease_token', 'lease_expires_at',
                 'fencing_token', 'attempt_count', 'generation_attempt')
            ORDER BY ORDINAL_POSITION`,
          [schema],
        ),
      ).resolves.toEqual([
        { columnName: 'request_hash' },
        { columnName: 'lease_owner' },
        { columnName: 'lease_token' },
        { columnName: 'lease_expires_at' },
        { columnName: 'fencing_token' },
        { columnName: 'attempt_count' },
        { columnName: 'generation_attempt' },
        { columnName: 'public_error_code' },
        { columnName: 'public_error_message' },
      ]);
      await expect(
        dataSource.query(
          `SELECT COLUMN_NAME AS columnName
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'workflow_domain_commits'
              AND COLUMN_NAME = 'commit_payload'`,
          [schema],
        ),
      ).resolves.toEqual([{ columnName: 'commit_payload' }]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('persists and completes a sanitized model attempt on real MySQL', async () => {
    const schema = `migration_model_run_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const jobId = randomUUID();

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Model run')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'model-run-test', ?, 'RUNNING')`,
        [jobId, userId, projectId, 'a'.repeat(64)],
      );
      const service = new ModelRunService(dataSource.getRepository(ModelRun));
      const run = await service.startAttempt({
        workflow_job_id: jobId,
        provider: 'fake',
        model: 'fake-model',
        workflow_node: 'draft',
        attempt_kind: 'network_retry',
        generation_attempt: 3,
        network_attempt: 1,
        repair_attempt: 0,
        request_metadata: {
          workflow_node: 'draft',
          generation_attempt: 3,
          retry_attempt: 1,
        },
        prompt_sha256: 'b'.repeat(64),
      });
      await service.finishAttempt(run.id, {
        status: 'SUCCEEDED',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        cost_usd: '0.000600',
        error_code: null,
        error_message: null,
        latency_ms: 42,
        completed_at: new Date('2026-07-25T00:00:00.000Z'),
      });

      const rows = await dataSource.query<
        Array<{
          attemptNumber: number;
          workflowNode: string;
          attemptKind: string;
          generationAttempt: number;
          networkAttempt: number;
          repairAttempt: number;
          requestMetadata: Record<string, unknown>;
          promptSha256: string;
          usage: Record<string, unknown>;
          costUsd: string;
          status: string;
          latencyMs: number;
          completedAt: Date;
        }>
      >(
        `SELECT attempt_number AS attemptNumber,
                workflow_node AS workflowNode,
                attempt_kind AS attemptKind,
                generation_attempt AS generationAttempt,
                network_attempt AS networkAttempt,
                repair_attempt AS repairAttempt,
                request_metadata AS requestMetadata,
                prompt_sha256 AS promptSha256,
                \`usage\` AS \`usage\`,
                cost_usd AS costUsd,
                status,
                latency_ms AS latencyMs,
                completed_at AS completedAt
           FROM model_runs
          WHERE id = ?`,
        [run.id],
      );
      expect(rows).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          workflowNode: 'draft',
          attemptKind: 'network_retry',
          generationAttempt: 3,
          networkAttempt: 1,
          repairAttempt: 0,
          requestMetadata: {
            workflow_node: 'draft',
            generation_attempt: 3,
            retry_attempt: 1,
          },
          promptSha256: 'b'.repeat(64),
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
          },
          costUsd: '0.000600',
          status: 'SUCCEEDED',
          latencyMs: 42,
        }),
      ]);
      expect(rows[0]?.completedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(rows)).not.toContain('secret prompt');
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('reconciles a partially applied model-run attempt schema and is then an exact no-op', async () => {
    const schema = `migration_model_partial_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter(
        (Migration) =>
          new Migration().name !== 'AddModelRunAttempts1712600000000',
      ),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE model_runs
           ADD COLUMN attempt_number INT UNSIGNED NOT NULL DEFAULT 1 AFTER model,
           ADD COLUMN workflow_node VARCHAR(100) NOT NULL DEFAULT 'legacy'
             AFTER attempt_number,
           ADD COLUMN latency_ms INT UNSIGNED NULL AFTER completed_at`,
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new AddModelRunAttempts1712600000000();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          dataSource.query(
            `SELECT COLUMN_NAME AS columnName
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
                AND TABLE_NAME = 'model_runs'
                AND COLUMN_NAME IN
                  ('attempt_number', 'workflow_node', 'attempt_kind',
                   'generation_attempt', 'network_attempt', 'repair_attempt',
                   'latency_ms')
              ORDER BY ORDINAL_POSITION`,
            [schema],
          ),
        ).resolves.toEqual([
          { columnName: 'attempt_number' },
          { columnName: 'workflow_node' },
          { columnName: 'attempt_kind' },
          { columnName: 'generation_attempt' },
          { columnName: 'network_attempt' },
          { columnName: 'repair_attempt' },
          { columnName: 'latency_ms' },
        ]);
        await expect(
          dataSource.query(
            `SELECT INDEX_NAME AS indexName, COLUMN_NAME AS columnName
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ?
                AND TABLE_NAME = 'model_runs'
                AND INDEX_NAME = 'uq_model_runs_job_node_attempt'
              ORDER BY SEQ_IN_INDEX`,
            [schema],
          ),
        ).resolves.toEqual([
          {
            indexName: 'uq_model_runs_job_node_attempt',
            columnName: 'workflow_job_id',
          },
          {
            indexName: 'uq_model_runs_job_node_attempt',
            columnName: 'workflow_node',
          },
          {
            indexName: 'uq_model_runs_job_node_attempt',
            columnName: 'attempt_number',
          },
        ]);
        const exact = await snapshotModelRunAttemptShape(dataSource, schema);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          snapshotModelRunAttemptShape(dataSource, schema),
        ).resolves.toEqual(exact);
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('performs zero DDL when a later partial model-run column is incompatible', async () => {
    const schema = `migration_model_drift_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter(
        (Migration) =>
          new Migration().name !== 'AddModelRunAttempts1712600000000',
      ),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE model_runs
           ADD COLUMN workflow_node VARCHAR(100)
             CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
             NOT NULL DEFAULT 'legacy' AFTER model`,
      );
      const before = await snapshotModelRunAttemptShape(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          new AddModelRunAttempts1712600000000().up(runner),
        ).rejects.toThrow('model_runs.workflow_node is incompatible');
      } finally {
        await runner.release();
      }
      await expect(
        snapshotModelRunAttemptShape(dataSource, schema),
      ).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('preserves and deterministically backfills non-empty predecessor model runs', async () => {
    const schema = `migration_model_data_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter(
        (Migration) =>
          new Migration().name !== 'AddModelRunAttempts1712600000000',
      ),
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const jobId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID()];

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Model run data')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'model-data', ?, 'RUNNING')`,
        [jobId, userId, projectId, 'a'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO model_runs
           (id, workflow_job_id, provider, model, request_metadata,
            \`usage\`, cost_usd, status, error_code, started_at, completed_at,
            created_at)
         VALUES
           (?, ?, 'fake', 'legacy-a', JSON_OBJECT('legacy', 1),
            JSON_OBJECT('input_tokens', 10, 'output_tokens', 2,
                        'total_tokens', 12),
            0.000123, 'SUCCEEDED', NULL,
            '2026-01-01 00:00:01.000000',
            '2026-01-01 00:00:02.000000',
            '2026-01-01 00:00:01.000000'),
           (?, ?, 'fake', 'legacy-b', JSON_OBJECT('legacy', 2),
            JSON_OBJECT('input_tokens', 20, 'output_tokens', 3,
                        'total_tokens', 23),
            0.000456, 'FAILED', 'LEGACY_FAILURE',
            '2026-01-01 00:00:02.000000',
            '2026-01-01 00:00:03.000000',
            '2026-01-01 00:00:02.000000'),
           (?, ?, 'fake', 'legacy-c', JSON_OBJECT('legacy', 3),
            NULL, NULL, 'RUNNING', NULL,
            '2026-01-01 00:00:03.000000', NULL,
            '2026-01-01 00:00:03.000000')`,
        [runIds[0], jobId, runIds[1], jobId, runIds[2], jobId],
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new AddModelRunAttempts1712600000000();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.up(runner)).resolves.toBeUndefined();
      } finally {
        await runner.release();
      }
      await expect(
        dataSource.query(
          `SELECT id, model, attempt_number AS attemptNumber,
                  workflow_node AS workflowNode,
                  attempt_kind AS attemptKind,
                  generation_attempt AS generationAttempt,
                  network_attempt AS networkAttempt,
                  repair_attempt AS repairAttempt,
                  latency_ms AS latencyMs,
                  request_metadata AS requestMetadata,
                  \`usage\`, CAST(cost_usd AS CHAR) AS costUsd,
                  status, error_code AS errorCode
             FROM model_runs
            WHERE workflow_job_id = ?
            ORDER BY attempt_number`,
          [jobId],
        ),
      ).resolves.toEqual([
        {
          id: runIds[0],
          model: 'legacy-a',
          attemptNumber: 1,
          workflowNode: 'legacy',
          attemptKind: 'legacy',
          generationAttempt: 1,
          networkAttempt: 0,
          repairAttempt: 0,
          latencyMs: null,
          requestMetadata: { legacy: 1 },
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
          costUsd: '0.000123',
          status: 'SUCCEEDED',
          errorCode: null,
        },
        {
          id: runIds[1],
          model: 'legacy-b',
          attemptNumber: 2,
          workflowNode: 'legacy',
          attemptKind: 'legacy',
          generationAttempt: 1,
          networkAttempt: 0,
          repairAttempt: 0,
          latencyMs: null,
          requestMetadata: { legacy: 2 },
          usage: {
            input_tokens: 20,
            output_tokens: 3,
            total_tokens: 23,
          },
          costUsd: '0.000456',
          status: 'FAILED',
          errorCode: 'LEGACY_FAILURE',
        },
        {
          id: runIds[2],
          model: 'legacy-c',
          attemptNumber: 3,
          workflowNode: 'legacy',
          attemptKind: 'legacy',
          generationAttempt: 1,
          networkAttempt: 0,
          repairAttempt: 0,
          latencyMs: null,
          requestMetadata: { legacy: 3 },
          usage: null,
          costUsd: null,
          status: 'RUNNING',
          errorCode: null,
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('resumes a non-empty nullable staging schema without duplicating legacy attempts', async () => {
    const schema = `migration_model_resume_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter(
        (Migration) =>
          new Migration().name !== 'AddModelRunAttempts1712600000000',
      ),
    );
    const userId = randomUUID();
    const projectId = randomUUID();
    const jobId = randomUUID();
    const runIds = [randomUUID(), randomUUID()];

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name) VALUES (?, ?, 'Resume')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'content', 'resume-model-runs', ?, 'RUNNING')`,
        [jobId, userId, projectId, 'b'.repeat(64)],
      );
      await dataSource.query(
        `INSERT INTO model_runs
           (id, workflow_job_id, provider, model, status, started_at,
            created_at)
         VALUES
           (?, ?, 'fake', 'resume-a', 'SUCCEEDED',
            '2026-01-01 00:00:01.000000',
            '2026-01-01 00:00:01.000000'),
           (?, ?, 'fake', 'resume-b', 'FAILED',
            '2026-01-01 00:00:02.000000',
            '2026-01-01 00:00:02.000000')`,
        [runIds[0], jobId, runIds[1], jobId],
      );
      await dataSource.query(
        `ALTER TABLE model_runs
           ADD COLUMN attempt_number INT UNSIGNED NULL AFTER model,
           ADD COLUMN workflow_node VARCHAR(100) NULL AFTER attempt_number,
           ADD COLUMN attempt_kind VARCHAR(20) NULL AFTER workflow_node,
           ADD COLUMN generation_attempt INT UNSIGNED NULL AFTER attempt_kind,
           ADD COLUMN network_attempt INT UNSIGNED NULL AFTER generation_attempt,
           ADD COLUMN repair_attempt INT UNSIGNED NULL AFTER network_attempt,
           ADD COLUMN latency_ms INT UNSIGNED NULL AFTER completed_at`,
      );

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new AddModelRunAttempts1712600000000();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        const once = await snapshotModelRunAttemptShape(dataSource, schema);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          snapshotModelRunAttemptShape(dataSource, schema),
        ).resolves.toEqual(once);
      } finally {
        await runner.release();
      }

      await expect(
        dataSource.query(
          `SELECT id, attempt_number AS attemptNumber,
                  workflow_node AS workflowNode,
                  attempt_kind AS attemptKind
             FROM model_runs
            WHERE workflow_job_id = ?
            ORDER BY attempt_number`,
          [jobId],
        ),
      ).resolves.toEqual([
        {
          id: runIds[0],
          attemptNumber: 1,
          workflowNode: 'legacy',
          attemptKind: 'legacy',
        },
        {
          id: runIds[1],
          attemptNumber: 2,
          workflowNode: 'legacy',
          attemptKind: 'legacy',
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('detects workflow column, index and foreign-key physical drift', async () => {
    const schema = `migration_workflow_drift_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await dataSource.query(
          `ALTER TABLE workflow_jobs
             DROP INDEX uq_workflow_jobs_idempotency,
             ADD UNIQUE KEY uq_workflow_jobs_idempotency
               (user_id, project_id, workflow_type, idempotency_key(8))`,
        );
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toContain('workflow_jobs: indexes');
        await dataSource.query(
          `ALTER TABLE workflow_jobs
             DROP INDEX uq_workflow_jobs_idempotency,
             ADD UNIQUE KEY uq_workflow_jobs_idempotency
               (user_id, project_id, workflow_type, idempotency_key)`,
        );

        await dataSource.query(
          `ALTER TABLE workflow_events
             MODIFY type VARCHAR(100)
             CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`,
        );
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toContain('workflow_events: columns');
        await dataSource.query(
          `ALTER TABLE workflow_events
             MODIFY type VARCHAR(100)
             CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL`,
        );

        await dataSource.query(
          `ALTER TABLE model_runs
             ALTER INDEX idx_model_runs_workflow_status INVISIBLE`,
        );
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toContain('model_runs: indexes');
        await dataSource.query(
          `ALTER TABLE model_runs
             ALTER INDEX idx_model_runs_workflow_status VISIBLE`,
        );

        await dataSource.query(
          `ALTER TABLE workflow_events
             DROP FOREIGN KEY workflow_events_job_id_fkey`,
        );
        await dataSource.query(
          `ALTER TABLE workflow_events
             ADD CONSTRAINT workflow_events_job_id_fkey
               FOREIGN KEY (job_id) REFERENCES workflow_jobs(id)
               ON DELETE CASCADE ON UPDATE CASCADE`,
        );
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toContain('workflow_events: foreign keys');
      } finally {
        await runner.release();
      }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it.each([
    [2, ['workflow_jobs']],
    [3, ['workflow_events', 'workflow_jobs']],
  ])(
    'retries workflow migration after CREATE failure %s without manual repair',
    async (failOnCreate, expectedPartialTables) => {
      const schema = `migration_workflow_retry_${failOnCreate}_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
      const dataSource = createMigrationDataSource(
        schema,
        mysqlPort,
        migrations.filter((Migration) => {
          const name = new Migration().name;
          return (
            name !== 'CreateWorkflowPersistence1712200000000' &&
            name !== 'AddWorkflowExecutionLeases1712300000000' &&
            name !== 'AddWorkflowDomainCommits1712400000000' &&
            name !== 'AddWorkflowAttemptRecovery1712500000000' &&
            name !== 'AddModelRunAttempts1712600000000'
          );
        }),
      );

      try {
        await dataSource.initialize();
        await dataSource.runMigrations();
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        try {
          const migration = new CreateWorkflowPersistence1712200000000();
          const failingRunner = withWorkflowCreateFailure(runner, failOnCreate);

          await expect(migration.up(failingRunner)).rejects.toThrow(
            `injected CREATE ${failOnCreate} failure`,
          );
          await expect(
            dataSource.query(
              `SELECT TABLE_NAME AS tableName
                 FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = ?
                  AND TABLE_NAME IN
                    ('workflow_jobs', 'workflow_events', 'model_runs')
                ORDER BY TABLE_NAME`,
              [schema],
            ),
          ).resolves.toEqual(
            expectedPartialTables.map((tableName) => ({ tableName })),
          );

          await expect(migration.up(runner)).resolves.toBeUndefined();
          await expect(
            new AddWorkflowExecutionLeases1712300000000().up(runner),
          ).resolves.toBeUndefined();
          await expect(
            findWorkflowSchemaContractViolations(runner),
          ).resolves.toEqual([]);
        } finally {
          await runner.release();
        }
      } finally {
        if (dataSource.isInitialized) await dataSource.destroy();
        await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      }
    },
  );

  it('fails closed instead of dropping data from a partial workflow migration', async () => {
    const schema = `migration_workflow_data_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter((Migration) => {
        const name = new Migration().name;
        return (
          name !== 'CreateWorkflowPersistence1712200000000' &&
          name !== 'AddWorkflowExecutionLeases1712300000000' &&
          name !== 'AddWorkflowDomainCommits1712400000000' &&
          name !== 'AddWorkflowAttemptRecovery1712500000000' &&
          name !== 'AddModelRunAttempts1712600000000'
        );
      }),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new CreateWorkflowPersistence1712200000000();
        const failingRunner = withWorkflowCreateFailure(runner, 2);
        await expect(migration.up(failingRunner)).rejects.toThrow(
          'injected CREATE 2 failure',
        );

        const userId = randomUUID();
        const projectId = randomUUID();
        await dataSource.query(
          `INSERT INTO users (id, email, password_hash)
           VALUES (?, ?, 'hash')`,
          [userId, `${userId}@example.test`],
        );
        await dataSource.query(
          `INSERT INTO projects (id, user_id, name)
           VALUES (?, ?, 'partial workflow')`,
          [projectId, userId],
        );
        const workflowColumns = await dataSource.query<
          Array<{ columnName: string }>
        >(
          `SELECT COLUMN_NAME AS columnName
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME = 'workflow_jobs'`,
          [schema],
        );
        const requestHashColumn = workflowColumns.some(
          ({ columnName }) => columnName === 'request_hash',
        );
        await dataSource.query(
          `INSERT INTO workflow_jobs
             (id, user_id, project_id, workflow_type, idempotency_key,
              ${requestHashColumn ? 'request_hash,' : ''} status)
           VALUES (?, ?, ?, 'directory', 'partial-data',
              ${requestHashColumn ? "'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'," : ''}
              'QUEUED')`,
          [randomUUID(), userId, projectId],
        );

        await expect(migration.up(runner)).rejects.toThrow(
          'Workflow persistence recovery refused: workflow_jobs contains 1 row',
        );
        await expect(
          dataSource.query(`SELECT COUNT(*) AS count FROM workflow_jobs`),
        ).resolves.toEqual([{ count: '1' }]);
      } finally {
        await runner.release();
      }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('retries a partially applied workflow lease migration without dropping jobs', async () => {
    const schema = `migration_workflow_lease_retry_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.filter((Migration) => {
        const name = new Migration().name;
        return (
          name !== 'AddWorkflowExecutionLeases1712300000000' &&
          name !== 'AddWorkflowDomainCommits1712400000000' &&
          name !== 'AddWorkflowAttemptRecovery1712500000000' &&
          name !== 'AddModelRunAttempts1712600000000'
        );
      }),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const userId = randomUUID();
      const projectId = randomUUID();
      const workflowJobId = randomUUID();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES (?, ?, 'hash')`,
        [userId, `${userId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'lease retry')`,
        [projectId, userId],
      );
      await dataSource.query(
        `INSERT INTO workflow_jobs
           (id, user_id, project_id, workflow_type, idempotency_key,
            request_hash, status)
         VALUES (?, ?, ?, 'directory', 'lease-retry',
                 ?, 'QUEUED')`,
        [workflowJobId, userId, projectId, 'a'.repeat(64)],
      );
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new AddWorkflowExecutionLeases1712300000000();
        await expect(
          migration.up(withWorkflowLeaseAlterFailure(runner, 3)),
        ).rejects.toThrow('injected workflow lease ALTER 3 failure');
        await expect(
          dataSource.query(
            `SELECT COLUMN_NAME AS columnName
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ?
                AND TABLE_NAME = 'workflow_jobs'
                AND COLUMN_NAME IN
                  ('lease_owner', 'lease_token', 'lease_expires_at',
                   'fencing_token', 'attempt_count')
              ORDER BY ORDINAL_POSITION`,
            [schema],
          ),
        ).resolves.toEqual([
          { columnName: 'lease_owner' },
          { columnName: 'lease_token' },
        ]);

        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(
          dataSource.query(
            `SELECT id, status FROM workflow_jobs WHERE id = ?`,
            [workflowJobId],
          ),
        ).resolves.toEqual([{ id: workflowJobId, status: 'QUEUED' }]);
        await expect(
          findWorkflowSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('runs a fresh schema through the documented ts-node migration command', async () => {
    const schema = `migration_cli_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);

    try {
      expect(() =>
        execFileSync('npm', ['run', 'migration:run'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_HOST: '127.0.0.1',
            DATABASE_PORT: String(mysqlPort),
            DATABASE_USER: 'root',
            DATABASE_PASSWORD: MYSQL_PASSWORD,
            DATABASE_NAME: schema,
          },
          stdio: 'pipe',
        }),
      ).not.toThrow();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('matches the runtime entity column contract after a fresh install', async () => {
    const schema = `migration_contract_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await expectRuntimeColumnContract(dataSource, schema);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('has no unallowlisted TypeORM entity-to-schema drift', async () => {
    const schema = `migration_entity_diff_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      currentMigrations,
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const contractRunner = dataSource.createQueryRunner();
      await contractRunner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(contractRunner),
        ).resolves.toEqual([]);
      } finally {
        await contractRunner.release();
      }
      await dataSource.query(
        `CREATE TABLE typeorm_metadata (
           type VARCHAR(255) NOT NULL,
           \`database\` VARCHAR(255) NULL,
           \`schema\` VARCHAR(255) NULL,
           \`table\` VARCHAR(255) NULL,
           name VARCHAR(255) NULL,
           value TEXT NULL
         )`,
      );
      const schemaLog = await dataSource.driver.createSchemaBuilder().log();
      const unallowlisted = schemaLog.upQueries
        .map((query) => query.query)
        .filter((query) => !isAllowlistedDatabaseOnlySchemaQuery(query));

      expect(unallowlisted).toEqual([]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('is a no-op only for the complete application schema contract', async () => {
    const schema = `migration_noop_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const before = await snapshotDdl(dataSource, schema);

      await new ReconcileApplicationSchema1712100000000().up(
        dataSource.createQueryRunner(),
      );

      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('converges a partially applied schema with type, index, and foreign-key drift', async () => {
    const schema = `migration_retry_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const expected = await snapshotDdl(dataSource, schema);

      await dataSource.query(
        `ALTER TABLE file_move_intents
         MODIFY COLUMN recover_after DATETIME(6) NOT NULL`,
      );
      await dataSource.query(
        `ALTER TABLE citation_maps
         DROP FOREIGN KEY citation_maps_chunk_id_fkey`,
      );
      await dataSource.query(
        `ALTER TABLE directory_versions
         DROP INDEX uq_directory_versions_scope_version,
         ADD INDEX uq_directory_versions_scope_version
           (version_number, project_id)`,
      );

      expect(await snapshotDdl(dataSource, schema)).not.toEqual(expected);

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await new ReconcileApplicationSchema1712100000000().up(runner);
        await new AddStructuredIngestion1712700000000().up(runner);
        await new CreateHybridRetrieval1712900000000().up(runner);
      } finally {
        await runner.release();
      }

      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(expected);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('removes an unexpected application CHECK before accepting current versions', async () => {
    const schema = `migration_check_contract_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE directory_versions
         ADD CONSTRAINT chk_no_current CHECK (is_current = 0)`,
      );

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toContain('directory_versions: checks');
        await new ReconcileApplicationSchema1712100000000().up(runner);
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toEqual([]);
      } finally {
        await runner.release();
      }

      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES ('abababab-abab-4bab-8bab-abababababab',
                 'check-contract@example.com', 'hash')`,
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES ('cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
                 'abababab-abab-4bab-8bab-abababababab',
                 'check contract project')`,
      );
      await expect(
        dataSource.query(
          `INSERT INTO directory_versions
             (id, project_id, version_number, content, is_current)
           VALUES ('efefefef-efef-4fef-8fef-efefefefefef',
                   'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
                   1, JSON_ARRAY(), 1)`,
        ),
      ).resolves.toBeDefined();
      await expect(
        dataSource.query(
          `SELECT version_number AS versionNumber, is_current AS isCurrent
             FROM directory_versions
            WHERE project_id = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'`,
        ),
      ).resolves.toEqual([{ versionNumber: 1, isCurrent: 1 }]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('reconciles every empty application table to InnoDB and the canonical utf8mb4 collation', async () => {
    const schema = `migration_table_contract_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES ('10101010-1010-4010-8010-101010101010',
                 'table-contract@example.com', 'preserved-hash')`,
      );
      await dataSource.query(`ALTER TABLE file_cleanup_records ENGINE=MyISAM`);
      await dataSource.query(
        `ALTER TABLE file_move_intents
         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      );

      const driftRunner = dataSource.createQueryRunner();
      await driftRunner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(driftRunner),
        ).resolves.toEqual(
          expect.arrayContaining([
            'file_cleanup_records: table',
            'file_move_intents: table',
          ]),
        );
        await new ReconcileApplicationSchema1712100000000().up(driftRunner);
        await expect(
          findApplicationSchemaContractViolations(driftRunner),
        ).resolves.toEqual([]);
      } finally {
        await driftRunner.release();
      }

      const tableRows = await dataSource.query<
        Array<{
          tableName: string;
          tableType: string;
          engine: string;
          tableCollation: string;
          characterSetName: string;
        }>
      >(
        `SELECT t.TABLE_NAME AS tableName,
                t.TABLE_TYPE AS tableType,
                t.ENGINE AS engine,
                t.TABLE_COLLATION AS tableCollation,
                cca.CHARACTER_SET_NAME AS characterSetName
           FROM information_schema.TABLES t
           JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY cca
             ON cca.COLLATION_NAME = t.TABLE_COLLATION
          WHERE t.TABLE_SCHEMA = ?
            AND t.TABLE_NAME IN (${APPLICATION_TABLES.map(() => '?').join(', ')})
          ORDER BY t.TABLE_NAME`,
        [schema, ...APPLICATION_TABLES],
      );
      expect(tableRows).toHaveLength(APPLICATION_TABLES.length);
      expect(tableRows).toEqual(
        tableRows.map((row) => ({
          ...row,
          tableType: 'BASE TABLE',
          engine: 'InnoDB',
          tableCollation: 'utf8mb4_0900_ai_ci',
          characterSetName: 'utf8mb4',
        })),
      );
      await expect(
        dataSource.query(
          `SELECT email, password_hash AS passwordHash
             FROM users
            WHERE id = '10101010-1010-4010-8010-101010101010'`,
        ),
      ).resolves.toEqual([
        {
          email: 'table-contract@example.com',
          passwordHash: 'preserved-hash',
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('rejects unexpected auth CHECK constraints before DDL and preserves auth data', async () => {
    const schema = `migration_auth_check_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES ('12121212-1212-4212-8212-121212121212',
                 'auth-check@example.com', 'preserved-hash')`,
      );
      await dataSource.query(
        `ALTER TABLE users
         ADD CONSTRAINT chk_users_email_present CHECK (email <> '')`,
      );

      const before = await snapshotDdl(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toContain('users: checks');
        await expect(
          new ReconcileApplicationSchema1712100000000().up(runner),
        ).rejects.toThrow(/preserved authentication schema.*users: checks/i);
      } finally {
        await runner.release();
      }

      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
      await expect(
        dataSource.query(
          `SELECT email, password_hash AS passwordHash
             FROM users
            WHERE id = '12121212-1212-4212-8212-121212121212'`,
        ),
      ).resolves.toEqual([
        {
          email: 'auth-check@example.com',
          passwordHash: 'preserved-hash',
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('detects auth key drift and refuses reconciliation without modifying preserved auth data', async () => {
    const schema = `migration_auth_contract_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES ('20202020-2020-4020-8020-202020202020',
                 'auth-contract@example.com', 'preserved-hash')`,
      );
      await dataSource.query(
        `INSERT INTO refresh_tokens
           (id, user_id, token_hash, expires_at)
         VALUES
           ('30303030-3030-4030-8030-303030303030',
            '20202020-2020-4020-8020-202020202020',
            'preserved-token', '2035-01-01 00:00:00')`,
      );
      await dataSource.query(
        `INSERT INTO user_settings (id, user_id, settings)
         VALUES ('40404040-4040-4040-8040-404040404040',
                 '20202020-2020-4020-8020-202020202020',
                 JSON_OBJECT('language', 'zh-CN'))`,
      );
      await dataSource.query(
        `ALTER TABLE refresh_tokens
         DROP FOREIGN KEY refresh_tokens_user_id_fkey,
         DROP INDEX idx_refresh_tokens_user_id`,
      );
      await dataSource.query(`ALTER TABLE users DROP INDEX uq_users_email`);

      const before = await snapshotDdl(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toEqual(
          expect.arrayContaining([
            'users: indexes',
            'refresh_tokens: indexes',
            'refresh_tokens: foreign keys',
          ]),
        );
        await expect(
          new ReconcileApplicationSchema1712100000000().up(runner),
        ).rejects.toThrow(
          /preserved authentication schema.*users.*refresh_tokens/i,
        );
      } finally {
        await runner.release();
      }
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
      await expect(
        dataSource.query(
          `SELECT u.email, u.password_hash AS passwordHash,
                  rt.token_hash AS tokenHash,
                  JSON_UNQUOTE(JSON_EXTRACT(us.settings, '$.language')) AS language
             FROM users u
             JOIN refresh_tokens rt ON rt.user_id = u.id
             JOIN user_settings us ON us.user_id = u.id`,
        ),
      ).resolves.toEqual([
        {
          email: 'auth-contract@example.com',
          passwordHash: 'preserved-hash',
          tokenHash: 'preserved-token',
          language: 'zh-CN',
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('detects per-column auth collation drift and refuses reconciliation', async () => {
    const schema = `migration_auth_column_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE users
         MODIFY email VARCHAR(255)
         CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`,
      );
      const before = await snapshotDdl(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toContain('users: columns');
        await expect(
          new ReconcileApplicationSchema1712100000000().up(runner),
        ).rejects.toThrow(/preserved authentication schema.*users: columns/i);
      } finally {
        await runner.release();
      }
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('detects auth index prefix drift and refuses reconciliation', async () => {
    const schema = `migration_auth_prefix_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE users
         DROP INDEX uq_users_email,
         ADD UNIQUE INDEX uq_users_email (email(10))`,
      );
      const before = await snapshotDdl(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toContain('users: indexes');
        await expect(
          new ReconcileApplicationSchema1712100000000().up(runner),
        ).rejects.toThrow(/preserved authentication schema.*users: indexes/i);
      } finally {
        await runner.release();
      }
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('detects auth foreign-key update-rule drift and refuses reconciliation', async () => {
    const schema = `migration_auth_fk_update_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(schema, mysqlPort);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await dataSource.query(
        `ALTER TABLE refresh_tokens
         DROP FOREIGN KEY refresh_tokens_user_id_fkey`,
      );
      await dataSource.query(
        `ALTER TABLE refresh_tokens
         ADD CONSTRAINT refresh_tokens_user_id_fkey
           FOREIGN KEY (user_id) REFERENCES users(id)
           ON DELETE CASCADE ON UPDATE CASCADE`,
      );
      const before = await snapshotDdl(dataSource, schema);
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await expect(
          findApplicationSchemaContractViolations(runner),
        ).resolves.toContain('refresh_tokens: foreign keys');
        await expect(
          new ReconcileApplicationSchema1712100000000().up(runner),
        ).rejects.toThrow(
          /preserved authentication schema.*refresh_tokens: foreign keys/i,
        );
      } finally {
        await runner.release();
      }
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('does not globally allowlist auth or unknown index and foreign-key repair queries', () => {
    expect(
      isAllowlistedDatabaseOnlySchemaQuery(
        'ALTER TABLE `users` ADD UNIQUE INDEX `IDX_users_email` (`email`)',
      ),
    ).toBe(false);
    expect(
      isAllowlistedDatabaseOnlySchemaQuery(
        'ALTER TABLE `refresh_tokens` ADD CONSTRAINT `FK_refresh_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      ),
    ).toBe(false);
    expect(
      isAllowlistedDatabaseOnlySchemaQuery(
        'CREATE INDEX `idx_unknown` ON `unknown_table` (`unknown_column`)',
      ),
    ).toBe(false);
  });

  it('reconciles an empty Init plus AddSection schema and preserves auth data', async () => {
    const schema = `migration_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);

    try {
      await createLegacyInitAddSchema(schema, mysqlPort);
      const beforeUpgrade = createMigrationDataSource(schema, mysqlPort);
      await beforeUpgrade.initialize();
      await beforeUpgrade.query(
        `INSERT INTO users
           (id, email, password_hash, nickname)
         VALUES
           ('11111111-1111-4111-8111-111111111111',
            'migration-auth@example.com', 'preserved-hash', '保留用户')`,
      );
      await beforeUpgrade.query(
        `INSERT INTO refresh_tokens
           (id, user_id, token_hash, expires_at)
         VALUES
           ('22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'preserved-token-hash', '2035-01-01 00:00:00')`,
      );
      await beforeUpgrade.query(
        `INSERT INTO user_settings
           (id, user_id, settings)
         VALUES
           ('33333333-3333-4333-8333-333333333333',
            '11111111-1111-4111-8111-111111111111',
            JSON_OBJECT('language', 'zh-CN'))`,
      );
      await beforeUpgrade.destroy();

      execFileSync('npm', ['run', 'migration:run'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_HOST: '127.0.0.1',
          DATABASE_PORT: String(mysqlPort),
          DATABASE_USER: 'root',
          DATABASE_PASSWORD: MYSQL_PASSWORD,
          DATABASE_NAME: schema,
        },
        stdio: 'pipe',
      });

      const upgraded = createMigrationDataSource(schema, mysqlPort);
      await upgraded.initialize();

      await expectRuntimeColumnContract(upgraded, schema);
      await expect(
        upgraded.query(
          `SELECT u.email, u.password_hash AS passwordHash,
                  rt.token_hash AS tokenHash,
                  JSON_UNQUOTE(JSON_EXTRACT(us.settings, '$.language')) AS language
             FROM users u
             JOIN refresh_tokens rt ON rt.user_id = u.id
             JOIN user_settings us ON us.user_id = u.id`,
        ),
      ).resolves.toEqual([
        {
          email: 'migration-auth@example.com',
          passwordHash: 'preserved-hash',
          tokenHash: 'preserved-token-hash',
          language: 'zh-CN',
        },
      ]);
      await upgraded.destroy();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  }, 30_000);

  it('rejects a non-empty business schema before executing any DDL', async () => {
    const schema = `migration_nonempty_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    let dataSource: DataSource | undefined;

    try {
      await createLegacySchemaThrough171208(schema, mysqlPort);
      dataSource = createMigrationDataSource(schema, mysqlPort);
      await dataSource.initialize();
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash)
         VALUES ('44444444-4444-4444-8444-444444444444',
                 'business-owner@example.com', 'hash')`,
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES ('55555555-5555-4555-8555-555555555555',
                 '44444444-4444-4444-8444-444444444444',
                 'must block reconciliation')`,
      );
      const before = await snapshotDdl(dataSource, schema);

      await expect(dataSource.runMigrations()).rejects.toThrow(
        /business tables are not empty.*projects=1/i,
      );
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource?.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('refuses the unsafe outline historical rollback without changing schema', async () => {
    const schema = `migration_down_outline_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.slice(0, 2),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const before = await snapshotDdl(dataSource, schema);

      await expect(dataSource.undoLastMigration()).rejects.toThrow(
        /AddSectionNodeId.*cannot be reversed safely/i,
      );
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('refuses the unsafe style historical rollback without changing schema', async () => {
    const schema = `migration_down_style_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createMigrationDataSource(
      schema,
      mysqlPort,
      migrations.slice(0, 3),
    );

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      const before = await snapshotDdl(dataSource, schema);

      await expect(dataSource.undoLastMigration()).rejects.toThrow(
        /CreateStyleTemplates.*cannot be reversed safely/i,
      );
      await expect(snapshotDdl(dataSource, schema)).resolves.toEqual(before);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('serializes two directory writes in one project scope', async () => {
    const fixture = await createVersioningFixture(
      admin,
      mysqlPort,
      'directory',
    );
    const projectService = {
      findOne: jest.fn().mockResolvedValue({
        id: fixture.projectId,
        user_id: fixture.userId,
      }),
      updateState: jest
        .fn()
        .mockImplementation(
          async (
            _userId: string,
            projectId: string,
            update: { current_directory_version_id: string },
          ) => {
            await fixture.dataSource.query(
              `UPDATE project_states
                  SET current_directory_version_id = ?
                WHERE project_id = ?`,
              [update.current_directory_version_id, projectId],
            );
          },
        ),
    };
    const service = new DirectoryService(
      fixture.dataSource.getRepository(DirectoryVersion),
      {} as never,
      projectService as never,
      {} as never,
      {} as never,
    );

    try {
      await fixture.dataSource.query(
        `CREATE TRIGGER pause_directory_version_insert
         BEFORE INSERT ON directory_versions
         FOR EACH ROW DO SLEEP(0.15)`,
      );
      const writes = await Promise.allSettled([
        service.saveDirectory(fixture.userId, fixture.projectId, {
          base_version_number: 1,
          nodes: [
            {
              node_id: 'chapter-a',
              node_type: 'chapter' as never,
              order_index: 0,
              title: '并发目录 A',
            },
          ],
        }),
        service.saveDirectory(fixture.userId, fixture.projectId, {
          base_version_number: 1,
          nodes: [
            {
              node_id: 'chapter-b',
              node_type: 'chapter' as never,
              order_index: 0,
              title: '并发目录 B',
            },
          ],
        }),
      ]);

      expect(writes.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      await expectVersionRows(
        fixture.dataSource,
        `SELECT version_number AS versionNumber, is_current AS isCurrent
           FROM directory_versions
          WHERE project_id = ?
          ORDER BY version_number`,
        [fixture.projectId],
      );
      const pointerRows = await fixture.dataSource.query<
        Array<{ stateVersionId: string; currentVersionId: string }>
      >(
        `SELECT ps.current_directory_version_id AS stateVersionId,
                dv.id AS currentVersionId
           FROM project_states ps
           JOIN directory_versions dv
             ON dv.project_id = ps.project_id AND dv.is_current = 1
          WHERE ps.project_id = ?`,
        [fixture.projectId],
      );
      expect(pointerRows).toHaveLength(1);
      expect(pointerRows[0].stateVersionId).toBe(
        pointerRows[0].currentVersionId,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rolls back a directory version when its project-state pointer cannot update', async () => {
    const fixture = await createVersioningFixture(
      admin,
      mysqlPort,
      'directory_rollback',
    );
    await fixture.dataSource.query(
      `DELETE FROM project_states WHERE project_id = ?`,
      [fixture.projectId],
    );
    const service = new DirectoryService(
      fixture.dataSource.getRepository(DirectoryVersion),
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: fixture.projectId,
          user_id: fixture.userId,
        }),
        updateState: jest
          .fn()
          .mockRejectedValue(new Error('project state missing')),
      } as never,
      {} as never,
      {} as never,
    );

    try {
      await expect(
        service.saveDirectory(fixture.userId, fixture.projectId, {
          base_version_number: 1,
          nodes: [],
        }),
      ).rejects.toThrow('项目状态不存在');
      await expect(
        fixture.dataSource.query(
          `SELECT COUNT(*) AS rowCount
             FROM directory_versions
            WHERE project_id = ?`,
          [fixture.projectId],
        ),
      ).resolves.toEqual([{ rowCount: '0' }]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('serializes a directory writer with project deletion without leaking a deadlock', async () => {
    const fixture = await createVersioningFixture(
      admin,
      mysqlPort,
      'writer_delete',
    );
    const directoryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await fixture.dataSource.query(
      `INSERT INTO directory_versions
         (id, project_id, version_number, content, is_current)
       VALUES (?, ?, 1, JSON_ARRAY(), 1)`,
      [directoryId, fixture.projectId],
    );
    await fixture.dataSource.query(
      `UPDATE project_states
          SET current_directory_version_id = ?
        WHERE project_id = ?`,
      [directoryId, fixture.projectId],
    );
    await fixture.dataSource.query(
      `CREATE TRIGGER pause_directory_version_delete
       BEFORE DELETE ON directory_versions
       FOR EACH ROW DO SLEEP(0.25)`,
    );

    const accessPolicy = {
      assertOwner: jest.fn().mockImplementation(async () => {
        const project = await fixture.dataSource
          .getRepository(Project)
          .findOne({ where: { id: fixture.projectId } });
        if (!project) throw new Error('项目不存在');
        return project;
      }),
    };
    const projectService = new ProjectService(
      fixture.dataSource.getRepository(Project),
      fixture.dataSource.getRepository(ProjectState),
      fixture.dataSource.getRepository(SourceFile),
      fixture.dataSource.getRepository(Document),
      fixture.dataSource.getRepository(Chunk),
      fixture.dataSource.getRepository(StyleTemplate),
      fixture.dataSource.getRepository(CitationMap),
      fixture.dataSource.getRepository(DirectoryVersion),
      fixture.dataSource.getRepository(OutlineVersion),
      fixture.dataSource.getRepository(ContentVersion),
      fixture.dataSource.getRepository(WritingResult),
      fixture.dataSource.getRepository(Session),
      fixture.dataSource.getRepository(Message),
      fixture.dataSource.getRepository(ExportJob),
      accessPolicy as never,
    );
    const directoryService = new DirectoryService(
      fixture.dataSource.getRepository(DirectoryVersion),
      {} as never,
      projectService,
      {} as never,
      {} as never,
    );

    try {
      const deletion = projectService.remove(fixture.userId, fixture.projectId);
      const writer = new Promise<DirectoryVersion>((resolve, reject) => {
        setTimeout(() => {
          directoryService
            .saveDirectory(fixture.userId, fixture.projectId, {
              base_version_number: 1,
              nodes: [],
            })
            .then(resolve, reject);
        }, 50);
      });
      const [deleteResult, writeResult] = await Promise.allSettled([
        deletion,
        writer,
      ]);

      expect(deleteResult.status).toBe('fulfilled');
      expect(writeResult.status).toBe('rejected');
      if (writeResult.status === 'rejected') {
        const message =
          writeResult.reason instanceof Error
            ? writeResult.reason.message
            : String(writeResult.reason);
        expect(message).toMatch(/项目不存在/);
        expect(message).not.toMatch(/deadlock/i);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('serializes two outline writes in one chapter-section scope', async () => {
    const fixture = await createVersioningFixture(admin, mysqlPort, 'outline');
    const service = new OutlineService(
      fixture.dataSource.getRepository(DirectoryVersion),
      fixture.dataSource.getRepository(OutlineVersion),
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: fixture.projectId,
          user_id: fixture.userId,
        }),
      } as never,
      {} as never,
      {} as never,
    );

    try {
      await fixture.dataSource.query(
        `CREATE TRIGGER pause_outline_version_insert
         BEFORE INSERT ON outline_versions
         FOR EACH ROW DO SLEEP(0.15)`,
      );
      const baseDto = {
        chapter_node_id: 'chapter-1',
        section_node_id: 'section-1',
        chapter_index: 0,
        chapter_title: '第一章',
        base_version_number: 1,
      };
      const writes = await Promise.allSettled([
        service.saveOutline(fixture.userId, fixture.projectId, {
          ...baseDto,
          content: { sections: [], node_title: '大纲 A' },
        }),
        service.saveOutline(fixture.userId, fixture.projectId, {
          ...baseDto,
          content: { sections: [], node_title: '大纲 B' },
        }),
      ]);

      expect(writes.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      await expectVersionRows(
        fixture.dataSource,
        `SELECT version_number AS versionNumber, is_current AS isCurrent
           FROM outline_versions
          WHERE project_id = ?
            AND chapter_node_id = ?
            AND section_node_id = ?
          ORDER BY version_number`,
        [fixture.projectId, 'chapter-1', 'section-1'],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('serializes two content writes in one writing-result scope', async () => {
    const fixture = await createVersioningFixture(admin, mysqlPort, 'content');
    const resultId = '99999999-9999-4999-8999-999999999999';
    await fixture.dataSource.query(
      `INSERT INTO writing_results
         (id, project_id, task_type, status, content_text)
       VALUES (?, ?, 'generate', 'succeeded', 'seed')`,
      [resultId, fixture.projectId],
    );
    const service = new ContentGenerationService(
      fixture.dataSource.getRepository(WritingResult),
      fixture.dataSource.getRepository(ContentVersion),
      fixture.dataSource.getRepository(OutlineVersion),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const contentVersionWriter = service as unknown as {
      storeContentVersion(result: string, content: string): Promise<void>;
    };

    try {
      await fixture.dataSource.query(
        `CREATE TRIGGER pause_content_version_insert
         BEFORE INSERT ON content_versions
         FOR EACH ROW DO SLEEP(0.15)`,
      );
      const writes = await Promise.allSettled([
        contentVersionWriter.storeContentVersion(resultId, '正文版本 A'),
        contentVersionWriter.storeContentVersion(resultId, '正文版本 B'),
      ]);

      expect(writes.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      await expectVersionRows(
        fixture.dataSource,
        `SELECT version_number AS versionNumber, is_current AS isCurrent
           FROM content_versions
          WHERE result_id = ?
          ORDER BY version_number`,
        [resultId],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

type QueryMethod = (sql: string, parameters?: unknown[]) => Promise<unknown>;

function withWorkflowCreateFailure(
  runner: QueryRunner,
  failOnCreate: number,
): QueryRunner {
  const failingRunner = Object.create(runner) as QueryRunner;
  const originalQuery = runner.query.bind(runner) as unknown as QueryMethod;
  let createCount = 0;
  (failingRunner as unknown as { query: QueryMethod }).query = (
    sql,
    parameters,
  ) => {
    if (
      /^\s*CREATE TABLE (?:workflow_jobs|workflow_events|model_runs)/i.test(sql)
    ) {
      createCount += 1;
      if (createCount === failOnCreate) {
        return Promise.reject(
          new Error(`injected CREATE ${failOnCreate} failure`),
        );
      }
    }
    return originalQuery(sql, parameters);
  };
  return failingRunner;
}

function withWorkflowLeaseAlterFailure(
  runner: QueryRunner,
  failOnAlter: number,
): QueryRunner {
  const failingRunner = Object.create(runner) as QueryRunner;
  const originalQuery = runner.query.bind(runner) as unknown as QueryMethod;
  let alterCount = 0;
  (failingRunner as unknown as { query: QueryMethod }).query = (
    sql,
    parameters,
  ) => {
    if (
      /^\s*ALTER TABLE workflow_jobs ADD COLUMN `(?:lease_owner|lease_token|lease_expires_at|fencing_token|attempt_count)`/i.test(
        sql,
      )
    ) {
      alterCount += 1;
      if (alterCount === failOnAlter) {
        return Promise.reject(
          new Error(`injected workflow lease ALTER ${failOnAlter} failure`),
        );
      }
    }
    return originalQuery(sql, parameters);
  };
  return failingRunner;
}

function withGroundingAlterFailure(
  runner: QueryRunner,
  failOnAlter: number,
): QueryRunner {
  const failingRunner = Object.create(runner) as QueryRunner;
  const originalQuery = runner.query.bind(runner) as unknown as QueryMethod;
  let alterCount = 0;
  (failingRunner as unknown as { query: QueryMethod }).query = (
    sql,
    parameters,
  ) => {
    if (
      /^\s*ALTER TABLE (?:grounding_assignments|citation_maps)\s+ADD COLUMN snapshot_digest/i.test(
        sql,
      )
    ) {
      alterCount += 1;
      if (alterCount === failOnAlter) {
        return Promise.reject(
          new Error(`injected grounding ALTER ${failOnAlter} failure`),
        );
      }
    }
    return originalQuery(sql, parameters);
  };
  return failingRunner;
}

function createMigrationDataSource(
  database: string,
  port: number,
  selectedMigrations: Array<new () => MigrationInterface> = migrations,
): DataSource {
  return new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    port,
    username: 'root',
    password: MYSQL_PASSWORD,
    database,
    charset: 'utf8mb4',
    entities: [...runtimeEntities],
    migrations: selectedMigrations,
    migrationsTableName: 'typeorm_migrations',
  });
}

async function insertAtomicRetrievalRun(
  dataSource: DataSource,
  input: {
    id: string;
    projectId: string;
    query: string;
    workflowJobId: string | null;
    revisionAttempt: number | null;
    requestSha256: string | null;
  },
): Promise<unknown> {
  return dataSource.query(
    `INSERT INTO retrieval_runs
       (id, project_id, workflow_job_id, revision_attempt, request_sha256,
        query, task_type, query_plan, state, canonical_path)
     VALUES (?, ?, ?, ?, ?, ?, 'content', JSON_OBJECT(), 'READY', 'hybrid')`,
    [
      input.id,
      input.projectId,
      input.workflowJobId,
      input.revisionAttempt,
      input.requestSha256,
      input.query,
    ],
  );
}

async function insertGroundingContractFixture(
  dataSource: DataSource,
  options: {
    suffix: string;
    omitNewColumns?: boolean;
    contractVersion?: 'legacy:v0' | 'atomic:v1';
    atomicClaim?: Record<string, unknown>;
  },
): Promise<{
  workflowJobId: string;
  claimId: string;
}> {
  const userId = randomUUID();
  const projectId = randomUUID();
  const workflowJobId = randomUUID();
  const retrievalRunId = randomUUID();
  const resultId = randomUUID();
  const claimId = createHash('sha256')
    .update(`${workflowJobId}\0${options.suffix}`)
    .digest('hex');
  await dataSource.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES (?, ?, 'hash')`,
    [userId, `${userId}@example.test`],
  );
  await dataSource.query(
    `INSERT INTO projects (id, user_id, name)
     VALUES (?, ?, ?)`,
    [projectId, userId, `Atomic grounding ${options.suffix}`],
  );
  await dataSource.query(
    `INSERT INTO workflow_jobs
       (id, user_id, project_id, workflow_type, idempotency_key,
        request_hash, status)
     VALUES (?, ?, ?, 'content', ?, ?, 'RUNNING')`,
    [
      workflowJobId,
      userId,
      projectId,
      `atomic-${options.suffix}-${workflowJobId}`,
      createHash('sha256').update(options.suffix).digest('hex'),
    ],
  );
  await dataSource.query(
    `INSERT INTO retrieval_runs
       (id, project_id, query, task_type, query_plan, state, canonical_path)
     VALUES (?, ?, 'atomic contract fixture', 'content', JSON_OBJECT(),
             'READY', 'hybrid')`,
    [retrievalRunId, projectId],
  );
  await dataSource.query(
    `INSERT INTO writing_results
       (id, project_id, task_type, status, content_text)
     VALUES (?, ?, 'generate', 'succeeded', '原子声明')`,
    [resultId, projectId],
  );
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const hasContract = await runner.hasColumn(
      'grounding_assignments',
      'contract_version',
    );
    if (
      hasContract &&
      !options.omitNewColumns &&
      options.contractVersion !== undefined
    ) {
      await dataSource.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode,
            targeted_revision_attempts, contract_version)
         VALUES (?, ?, ?, 'READY', JSON_ARRAY(?), JSON_ARRAY(), 1, 0, ?)`,
        [
          workflowJobId,
          projectId,
          retrievalRunId,
          retrievalRunId,
          options.contractVersion,
        ],
      );
    } else {
      await dataSource.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode,
            targeted_revision_attempts)
         VALUES (?, ?, ?, 'READY', JSON_ARRAY(?), JSON_ARRAY(), 1, 0)`,
        [workflowJobId, projectId, retrievalRunId, retrievalRunId],
      );
    }
    const hasAtomicClaim = await runner.hasColumn(
      'grounding_claims',
      'atomic_claim',
    );
    if (
      hasAtomicClaim &&
      !options.omitNewColumns &&
      options.atomicClaim !== undefined
    ) {
      await dataSource.query(
        `INSERT INTO grounding_claims
           (claim_id, workflow_job_id, project_id, result_id, claim_text,
            normalized_claim_text, output_char_start, output_char_end,
            support_status, support_score, verification_method, atomic_claim)
         VALUES (?, ?, ?, ?, '原子声明', '原子声明', 0, 4, 'SUPPORTED', 1,
                 'atomic_extract_exact', ?)`,
        [
          claimId,
          workflowJobId,
          projectId,
          resultId,
          JSON.stringify(options.atomicClaim),
        ],
      );
    } else {
      await dataSource.query(
        `INSERT INTO grounding_claims
           (claim_id, workflow_job_id, project_id, result_id, claim_text,
            normalized_claim_text, output_char_start, output_char_end,
            support_status, support_score, verification_method)
         VALUES (?, ?, ?, ?, '原子声明', '原子声明', 0, 4, 'SUPPORTED', 1,
                 'deterministic_exact')`,
        [claimId, workflowJobId, projectId, resultId],
      );
    }
  } finally {
    await runner.release();
  }
  return { workflowJobId, claimId };
}

async function groundingLedgerCounts(dataSource: DataSource): Promise<unknown> {
  return dataSource.query(
    `SELECT
       (SELECT COUNT(*) FROM grounding_assignments) AS assignments,
       (SELECT COUNT(*) FROM grounding_claims) AS claims`,
  );
}

function atomicClaimFixture(): Record<string, unknown> {
  return {
    canonicalizer_version: 'atomic-canonicalizer.v1',
    quantity_lexer_version: 'quantity-lexer.v1',
    verifier_version: 'atomic-verifier.v1',
    canonical_claim: {
      canonical_claim_version: 'canonical-atomic-claim.v1',
      candidate_claim_key: 'candidate-1',
      source_claim_text_nfc: '原子声明',
      rendered_claim_text: '原子声明',
      subject_anchor: {
        surface_nfc: '原子',
        start_utf16: 0,
        end_utf16: 2,
      },
      predicate_anchor: {
        surface_nfc: '声明',
        start_utf16: 2,
        end_utf16: 4,
      },
      polarity: 'affirmed',
      quantifier: 'plain',
      quantities: [],
      evidence_ids: [],
      fragment: {
        ordinal: 0,
        presentation: 'sentence',
        previous_structure_id: null,
        next_structure_id: null,
      },
      revision: {
        attempt: 0,
        revision_of_candidate_claim_key: null,
      },
    },
  };
}

async function atomicRollbackSnapshot(
  dataSource: DataSource,
  fixture: { workflowJobId: string; claimId: string },
): Promise<unknown> {
  return dataSource.query(
    `SELECT ga.contract_version AS contractVersion,
            CAST(gc.atomic_claim AS CHAR CHARACTER SET utf8mb4) AS atomicClaim
       FROM grounding_assignments ga
       JOIN grounding_claims gc ON gc.workflow_job_id = ga.workflow_job_id
      WHERE ga.workflow_job_id = ?
        AND gc.claim_id = ?`,
    [fixture.workflowJobId, fixture.claimId],
  );
}

async function createVersioningFixture(
  admin: Connection,
  port: number,
  label: string,
): Promise<{
  dataSource: DataSource;
  schema: string;
  userId: string;
  projectId: string;
  cleanup(): Promise<void>;
}> {
  const schema = `migration_${label}_${randomUUID().replaceAll('-', '')}`;
  const userId = '77777777-7777-4777-8777-777777777777';
  const projectId = '88888888-8888-4888-8888-888888888888';
  await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const dataSource = createMigrationDataSource(schema, port);
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES (?, ?, 'hash')`,
    [userId, `${label}@example.com`],
  );
  await dataSource.query(
    `INSERT INTO projects (id, user_id, name)
     VALUES (?, ?, ?)`,
    [projectId, userId, `${label} project`],
  );
  await dataSource.query(
    `INSERT INTO project_states
       (id, project_id, completed_chapters, pending_items, material_gaps)
     VALUES
       ('66666666-6666-4666-8666-666666666666', ?,
        JSON_ARRAY(), JSON_ARRAY(), JSON_ARRAY())`,
    [projectId],
  );
  return {
    dataSource,
    schema,
    userId,
    projectId,
    cleanup: async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    },
  };
}

async function expectVersionRows(
  dataSource: DataSource,
  sql: string,
  parameters: unknown[],
): Promise<void> {
  await expect(dataSource.query(sql, parameters)).resolves.toEqual([
    { versionNumber: 1, isCurrent: 0 },
    { versionNumber: 2, isCurrent: 1 },
  ]);
}

async function expectRuntimeColumnContract(
  dataSource: DataSource,
  schema: string,
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await expect(
      findApplicationSchemaContractViolations(runner),
    ).resolves.toEqual([]);
  } finally {
    await runner.release();
  }

  const columnRows = await dataSource.query<ColumnContractRow[]>(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );
  expect(findMissingRuntimeColumns(columnRows)).toEqual([]);

  const indexRows = await dataSource.query<IndexContractRow[]>(
    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
            NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequenceNumber,
            COLUMN_NAME AS columnName
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );
  expect(findInvalidRuntimeIndexes(indexRows)).toEqual([]);

  const foreignKeyRows = await dataSource.query<ForeignKeyContractRow[]>(
    `SELECT kcu.TABLE_NAME AS tableName,
            kcu.COLUMN_NAME AS columnName,
            kcu.REFERENCED_TABLE_NAME AS referencedTableName,
            kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
            rc.DELETE_RULE AS deleteRule
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
    [schema],
  );
  expect(findMissingRuntimeForeignKeys(foreignKeyRows)).toEqual([]);
  expect(foreignKeyRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tableName: 'project_states',
        columnName: 'current_directory_version_id',
        referencedTableName: 'directory_versions',
        referencedColumnName: 'id',
        deleteRule: 'SET NULL',
      }),
    ]),
  );
}

async function createLegacySchemaThrough171208(
  schema: string,
  port: number,
): Promise<void> {
  await createLegacyInitAddSchema(schema, port);

  const through171208 = createMigrationDataSource(
    schema,
    port,
    migrations.filter(
      (Migration) =>
        new Migration().name !== 'ReconcileApplicationSchema1712100000000' &&
        new Migration().name !== 'CreateWorkflowPersistence1712200000000' &&
        new Migration().name !== 'AddWorkflowExecutionLeases1712300000000' &&
        new Migration().name !== 'AddWorkflowDomainCommits1712400000000' &&
        new Migration().name !== 'AddWorkflowAttemptRecovery1712500000000' &&
        new Migration().name !== 'AddModelRunAttempts1712600000000' &&
        new Migration().name !== 'AddStructuredIngestion1712700000000' &&
        new Migration().name !== 'AddParseAttemptLeases1712800000000',
    ),
  );
  await through171208.initialize();
  await through171208.runMigrations();
  await through171208.destroy();
}

async function createLegacyInitAddSchema(
  schema: string,
  port: number,
): Promise<void> {
  const initial = createMigrationDataSource(
    schema,
    port,
    migrations.slice(0, 2),
  );
  await initial.initialize();
  await initial.runMigrations();
  await transformToLegacyInitAddSchema(initial);
  await initial.destroy();
}

async function transformToLegacyInitAddSchema(
  dataSource: DataSource,
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    if (await runner.hasColumn('messages', 'message_type')) {
      await runner.query(`ALTER TABLE messages DROP COLUMN message_type`);
    }
    if (await runner.hasColumn('directory_versions', 'content')) {
      await runner.query(
        `ALTER TABLE directory_versions
         CHANGE COLUMN content nodes JSON NULL`,
      );
    }
    if (await runner.hasColumn('outline_versions', 'chapter_index')) {
      await runner.query(
        `ALTER TABLE outline_versions
         DROP COLUMN chapter_index,
         DROP COLUMN chapter_title`,
      );
    }
    await runner.query(
      `ALTER TABLE outline_versions
       MODIFY COLUMN chapter_node_id VARCHAR(255) NOT NULL`,
    );

    if (await runner.hasColumn('content_versions', 'result_id')) {
      await runner.query(`DROP TABLE content_versions`);
      await runner.query(`
        CREATE TABLE content_versions (
          id VARCHAR(36) NOT NULL DEFAULT (UUID()),
          project_id VARCHAR(36) NOT NULL,
          node_id VARCHAR(255) NOT NULL,
          version_number INT NOT NULL DEFAULT 1,
          is_current TINYINT(1) NOT NULL DEFAULT 1,
          content LONGTEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_content_versions_project_id (project_id),
          CONSTRAINT content_versions_project_id_fkey
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    }

    const writingColumns = [
      'session_id',
      'chapter_index',
      'chapter_title',
      'section_title',
      'task_type',
      'status',
      'content_text',
      'style',
      'parent_result_id',
      'error_message',
      'completed_at',
    ];
    const writingSessionForeignKey: unknown = await runner.query(
      `SELECT CONSTRAINT_NAME AS constraintName
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'writing_results'
          AND COLUMN_NAME = 'session_id'
          AND REFERENCED_TABLE_NAME IS NOT NULL
        LIMIT 1`,
    );
    if (
      Array.isArray(writingSessionForeignKey) &&
      writingSessionForeignKey.length > 0
    ) {
      const constraintName = (
        writingSessionForeignKey[0] as { constraintName: string }
      ).constraintName;
      await runner.query(
        `ALTER TABLE writing_results
         DROP FOREIGN KEY \`${constraintName}\``,
      );
    }
    for (const column of writingColumns) {
      if (await runner.hasColumn('writing_results', column)) {
        await runner.query(
          `ALTER TABLE writing_results DROP COLUMN \`${column}\``,
        );
      }
    }
    const legacyWritingColumns: Array<[string, string]> = [
      ['is_current', 'TINYINT(1) NOT NULL DEFAULT 1'],
      ['content', 'LONGTEXT NULL'],
      ['outline_id', 'VARCHAR(36) NULL'],
      ['metadata', 'JSON NULL'],
      [
        'updated_at',
        'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      ],
    ];
    for (const [column, definition] of legacyWritingColumns) {
      if (!(await runner.hasColumn('writing_results', column))) {
        await runner.query(
          `ALTER TABLE writing_results
           ADD COLUMN \`${column}\` ${definition}`,
        );
      }
    }
    await runner.query(
      `ALTER TABLE writing_results
       MODIFY COLUMN chapter_node_id VARCHAR(255) NOT NULL,
       MODIFY COLUMN section_node_id VARCHAR(255) NULL`,
    );
  } finally {
    await runner.release();
  }
}

async function snapshotDdl(
  dataSource: DataSource,
  schema: string,
): Promise<unknown> {
  const [tables, columns, indexes, foreignKeys, checks] = await Promise.all([
    dataSource.query<unknown[]>(
      `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [schema],
    ),
    dataSource.query<unknown[]>(
      `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION,
              CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [schema],
    ),
    dataSource.query<unknown[]>(
      `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX,
              COLUMN_NAME, EXPRESSION, SUB_PART, COLLATION, IS_VISIBLE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [schema],
    ),
    dataSource.query<unknown[]>(
      `SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
              kcu.ORDINAL_POSITION, kcu.POSITION_IN_UNIQUE_CONSTRAINT,
              kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
              rc.DELETE_RULE, rc.UPDATE_RULE
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.TABLE_SCHEMA = ?
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [schema],
    ),
    dataSource.query<unknown[]>(
      `SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.ENFORCED,
              cc.CHECK_CLAUSE
         FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = ?
          AND tc.CONSTRAINT_TYPE = 'CHECK'
        ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME`,
      [schema],
    ),
  ]);
  return { tables, columns, indexes, foreignKeys, checks };
}

async function snapshotAtomicPreflightSchema(
  dataSource: DataSource,
  schema: string,
  extraTables: readonly string[] = [],
): Promise<unknown> {
  const tableNames = [
    'model_runs',
    'retrieval_runs',
    'workflow_jobs',
    ...extraTables,
  ];
  const [informationSchema, ...tableDefinitions] = await Promise.all([
    snapshotDdl(dataSource, schema),
    ...tableNames.map((table) =>
      dataSource.query<unknown[]>(`SHOW CREATE TABLE \`${table}\``),
    ),
  ]);
  return {
    informationSchema,
    tableDefinitions: Object.fromEntries(
      tableNames.map((table, index) => [table, tableDefinitions[index]]),
    ),
  };
}

async function snapshotModelRunAttemptShape(
  dataSource: DataSource,
  schema: string,
): Promise<unknown> {
  const [columns, indexes] = await Promise.all([
    dataSource.query<unknown[]>(
      `SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION,
              CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'model_runs'
        ORDER BY ORDINAL_POSITION`,
      [schema],
    ),
    dataSource.query<unknown[]>(
      `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, SEQ_IN_INDEX,
              COLUMN_NAME, SUB_PART, COLLATION, IS_VISIBLE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'model_runs'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema],
    ),
  ]);
  return { columns, indexes };
}

const RUNTIME_COLUMNS: Record<string, readonly string[]> = {
  users: [
    'id',
    'email',
    'password_hash',
    'nickname',
    'created_at',
    'updated_at',
  ],
  refresh_tokens: [
    'id',
    'user_id',
    'token_hash',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  projects: [
    'id',
    'user_id',
    'name',
    'type',
    'target_audience',
    'target_chapters',
    'style',
    'status',
    'description',
    'created_at',
    'updated_at',
  ],
  project_states: [
    'id',
    'project_id',
    'current_directory_version_id',
    'completed_chapters',
    'in_progress_chapter',
    'in_progress_section',
    'pending_items',
    'material_gaps',
    'user_notes',
    'updated_at',
  ],
  source_files: [
    'id',
    'project_id',
    'file_name',
    'file_type',
    'file_size',
    'file_path',
    'parse_status',
    'error_message',
    'uploaded_at',
  ],
  documents: [
    'id',
    'file_id',
    'project_id',
    'title',
    'content_text',
    'page_count',
    'sections',
    'parsed_at',
  ],
  chunks: [
    'id',
    'project_id',
    'file_id',
    'document_id',
    'chunk_index',
    'content',
    'section_title',
    'page_number',
    'keywords',
    'search_terms',
    'created_at',
  ],
  sessions: [
    'id',
    'project_id',
    'user_id',
    'title',
    'created_at',
    'updated_at',
  ],
  messages: [
    'id',
    'session_id',
    'role',
    'content',
    'message_type',
    'metadata',
    'created_at',
  ],
  directory_versions: [
    'id',
    'project_id',
    'version_number',
    'content',
    'is_current',
    'created_at',
  ],
  outline_versions: [
    'id',
    'project_id',
    'chapter_node_id',
    'section_node_id',
    'chapter_index',
    'chapter_title',
    'version_number',
    'content',
    'is_current',
    'created_at',
  ],
  writing_results: [
    'id',
    'project_id',
    'session_id',
    'chapter_node_id',
    'section_node_id',
    'chapter_index',
    'chapter_title',
    'section_title',
    'task_type',
    'status',
    'content_text',
    'word_count',
    'style',
    'version_number',
    'parent_result_id',
    'error_message',
    'created_at',
    'completed_at',
  ],
  content_versions: [
    'id',
    'result_id',
    'version_number',
    'editor_source',
    'content_text',
    'is_current',
    'created_at',
  ],
  citation_maps: [
    'id',
    'project_id',
    'result_id',
    'paragraph_key',
    'chunk_id',
    'file_id',
    'use_type',
    'evidence_text',
    'page_number',
    'section_title',
    'confidence_score',
    'created_at',
  ],
  export_jobs: [
    'id',
    'project_id',
    'format',
    'scope',
    'chapter_ids',
    'include_citations',
    'status',
    'file_path',
    'error_message',
    'created_at',
    'completed_at',
  ],
  style_templates: [
    'id',
    'name',
    'project_id',
    'file_path',
    'reference_file_ids',
    'features',
    'status',
    'error_message',
    'created_at',
    'updated_at',
  ],
  file_upload_outbox: [
    'id',
    'file_id',
    'project_id',
    'job_id',
    'status',
    'attempts',
    'last_error',
    'lease_owner',
    'lease_expires_at',
    'next_attempt_at',
    'created_at',
  ],
  file_cleanup_records: [
    'id',
    'file_path',
    'reason',
    'status',
    'attempts',
    'last_error',
    'lease_owner',
    'lease_expires_at',
    'next_attempt_at',
    'created_at',
  ],
  file_move_intents: [
    'id',
    'status',
    'source_path',
    'destination_path',
    'file_id',
    'project_id',
    'user_id',
    'file_size',
    'writer_token',
    'recover_after',
    'attempts',
    'last_error',
    'lease_owner',
    'lease_expires_at',
    'next_attempt_at',
    'created_at',
  ],
};

const RUNTIME_INDEXES = [
  {
    table: 'directory_versions',
    name: 'uq_directory_versions_scope_version',
    unique: true,
    columns: ['project_id', 'version_number'],
  },
  {
    table: 'directory_versions',
    name: 'uq_directory_versions_current',
    unique: true,
    columns: ['project_id', 'current_marker'],
  },
  {
    table: 'outline_versions',
    name: 'uq_outline_versions_scope_version',
    unique: true,
    columns: [
      'project_id',
      'chapter_node_id',
      'scope_section_node_id',
      'version_number',
    ],
  },
  {
    table: 'outline_versions',
    name: 'uq_outline_versions_current',
    unique: true,
    columns: [
      'project_id',
      'chapter_node_id',
      'scope_section_node_id',
      'current_marker',
    ],
  },
  {
    table: 'content_versions',
    name: 'uq_content_versions_scope_version',
    unique: true,
    columns: ['result_id', 'version_number'],
  },
  {
    table: 'content_versions',
    name: 'uq_content_versions_current',
    unique: true,
    columns: ['result_id', 'current_marker'],
  },
] as const;

const RUNTIME_FOREIGN_KEYS = [
  ['refresh_tokens', 'user_id', 'users', 'id', 'CASCADE'],
  ['projects', 'user_id', 'users', 'id', 'CASCADE'],
  ['project_states', 'project_id', 'projects', 'id', 'CASCADE'],
  [
    'project_states',
    'current_directory_version_id',
    'directory_versions',
    'id',
    'SET NULL',
  ],
  ['source_files', 'project_id', 'projects', 'id', 'CASCADE'],
  ['documents', 'file_id', 'source_files', 'id', 'CASCADE'],
  ['documents', 'project_id', 'projects', 'id', 'CASCADE'],
  ['chunks', 'document_id', 'documents', 'id', 'CASCADE'],
  ['chunks', 'file_id', 'source_files', 'id', 'CASCADE'],
  ['chunks', 'project_id', 'projects', 'id', 'CASCADE'],
  ['sessions', 'project_id', 'projects', 'id', 'CASCADE'],
  ['sessions', 'user_id', 'users', 'id', 'CASCADE'],
  ['messages', 'session_id', 'sessions', 'id', 'CASCADE'],
  ['directory_versions', 'project_id', 'projects', 'id', 'CASCADE'],
  ['outline_versions', 'project_id', 'projects', 'id', 'CASCADE'],
  ['writing_results', 'project_id', 'projects', 'id', 'CASCADE'],
  ['writing_results', 'session_id', 'sessions', 'id', 'SET NULL'],
  ['content_versions', 'result_id', 'writing_results', 'id', 'CASCADE'],
  ['citation_maps', 'project_id', 'projects', 'id', 'CASCADE'],
  ['citation_maps', 'result_id', 'writing_results', 'id', 'CASCADE'],
  ['citation_maps', 'chunk_id', 'chunks', 'id', 'CASCADE'],
  ['citation_maps', 'file_id', 'source_files', 'id', 'CASCADE'],
  ['export_jobs', 'project_id', 'projects', 'id', 'CASCADE'],
  ['style_templates', 'project_id', 'projects', 'id', 'CASCADE'],
  ['file_upload_outbox', 'file_id', 'source_files', 'id', 'CASCADE'],
] as const;

interface ColumnContractRow {
  tableName: string;
  columnName: string;
}

interface IndexContractRow {
  tableName: string;
  indexName: string;
  nonUnique: number;
  sequenceNumber: number;
  columnName: string;
}

interface ForeignKeyContractRow {
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
}

function findMissingRuntimeColumns(received: ColumnContractRow[]): string[] {
  const actual = new Map<string, Set<string>>();
  for (const row of received) {
    const columns = actual.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    actual.set(row.tableName, columns);
  }
  return Object.entries(RUNTIME_COLUMNS).flatMap(([table, columns]) =>
    columns
      .filter((column) => !actual.get(table)?.has(column))
      .map((column) => `${table}.${column}`),
  );
}

function findInvalidRuntimeIndexes(received: IndexContractRow[]): string[] {
  return RUNTIME_INDEXES.flatMap((expected) => {
    const actual = received
      .filter(
        (row) =>
          row.tableName === expected.table && row.indexName === expected.name,
      )
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const actualColumns = actual.map((row) => row.columnName);
    const actualUnique =
      actual.length > 0 && actual.every((row) => Number(row.nonUnique) === 0);
    return actualUnique === expected.unique &&
      actualColumns.join(',') === expected.columns.join(',')
      ? []
      : [
          `${expected.table}.${expected.name} expected unique=${expected.unique} (${expected.columns.join(', ')})`,
        ];
  });
}

function findMissingRuntimeForeignKeys(
  received: ForeignKeyContractRow[],
): string[] {
  return RUNTIME_FOREIGN_KEYS.filter(
    ([table, column, referencedTable, referencedColumn, deleteRule]) =>
      !received.some(
        (row) =>
          row.tableName === table &&
          row.columnName === column &&
          row.referencedTableName === referencedTable &&
          row.referencedColumnName === referencedColumn &&
          row.deleteRule === deleteRule,
      ),
  ).map(
    ([table, column, referencedTable, referencedColumn, deleteRule]) =>
      `${table}.${column} -> ${referencedTable}.${referencedColumn} ON DELETE ${deleteRule}`,
  );
}
