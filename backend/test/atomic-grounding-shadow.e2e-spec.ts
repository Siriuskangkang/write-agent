/* eslint-disable @typescript-eslint/unbound-method */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import { DataSource, type MigrationInterface } from 'typeorm';
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
import type { GroundingAssignmentSnapshot } from '../src/citation/citation-ledger.service.js';
import type { AssignedEvidenceSnapshot } from '../src/citation/grounding-verifier.js';
import { capPersistedGroundingForRead } from '../src/citation/grounding-read-policy.js';
import { SqlGroundingEvidenceStore } from '../src/citation/sql-grounding-evidence.store.js';
import type {
  AtomicVerificationResult,
  CanonicalAtomicClaimV1,
  GroundedDraftProposal,
  SealedApprovedRenderContextV1,
  SealedGroundedCandidateV1,
} from '../src/citation/atomic-grounding/contracts.js';
import {
  recoverSealedGroundedCandidateV1,
  sealGroundedCandidateV1,
} from '../src/citation/atomic-grounding/sealed-grounded-candidate.js';
import { AtomicGroundingCoordinator } from '../src/citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import { AtomicGroundingVerifier } from '../src/citation/atomic-grounding/atomic-grounding.verifier.js';
import { AtomicGroundingMetricsRecorder } from '../src/citation/atomic-grounding/atomic-grounding.metrics.js';
import { ContentService } from '../src/content/content.service.js';
import { ContentGenerationService } from '../src/content/content-generation.service.js';
import { ContentSharedService } from '../src/content/content-shared.service.js';
import { RetrievalPersistenceService } from '../src/retrieval/retrieval-persistence.service.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever.js';
import { RetrievalService } from '../src/retrieval/retrieval.service.js';
import { RetrievalRun } from '../src/retrieval/entities/retrieval-run.entity.js';
import { RetrievalCandidateRecord } from '../src/retrieval/entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from '../src/retrieval/entities/retrieval-index-version.entity.js';
import { RetrievalRunIndexVersion } from '../src/retrieval/entities/retrieval-run-index.entity.js';
import { WorkflowDomainCommitService } from '../src/workflow/workflow-domain-commit.service.js';
import {
  WorkflowGenerationExecutor,
  type WorkflowDomainCommitter,
} from '../src/workflow/workflow-generation.executor.js';
import type {
  ClaimedWorkflowJob,
  WorkflowExecutionEvent,
} from '../src/workflow/workflow.engine.js';
import { MysqlWorkflowExecutionStore } from '../src/workflow/mysql-workflow-execution.store.js';
import { WorkflowEvent } from '../src/workflow/entities/workflow-event.entity.js';
import { ModelRun } from '../src/workflow/entities/model-run.entity.js';
import { ModelRunService } from '../src/workflow/model-run.service.js';
import { WorkflowType } from '../src/workflow/workflow.types.js';

jest.setTimeout(120_000);

const MYSQL_PASSWORD = 'atomic-shadow-e2e-password';
const containerName = `write-agent-atomic-shadow-${process.pid}-${Date.now()}`;
const schema = `atomic_shadow_${randomUUID().replaceAll('-', '')}`;
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
  HardenHybridRetrieval1713000000000,
  CompleteHybridRetrievalFencing1713100000000,
  RetainReactivatableDenseNamespaces1713200000000,
  CreateClaimEvidenceLedger1713300000000,
  HardenGroundingWorkflow1713310000000,
  AddGroundingRevisionRunRefs1713320000000,
  AddAtomicGroundingContracts1713330000000,
  HardenAtomicOperationIdempotency1713340000000,
];

describe('atomic grounding shadow_no_persist on MySQL 8.4', () => {
  let admin: Connection;
  let mysqlPort: number;
  let dataSource: DataSource;

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
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!admin!) throw lastError;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    dataSource = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: mysqlPort,
      username: 'root',
      password: MYSQL_PASSWORD,
      database: schema,
      charset: 'utf8mb4',
      timezone: 'Z',
      entities: [
        WorkflowEvent,
        ModelRun,
        RetrievalRun,
        RetrievalCandidateRecord,
        RetrievalIndexVersion,
        RetrievalRunIndexVersion,
      ],
      migrations,
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 90_000);

  afterEach(async () => {
    try {
      await expectZeroDomainWrites(dataSource);
    } finally {
      await dataSource.query('DELETE FROM users');
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
      await admin.end();
    }
    try {
      execFileSync('docker', ['rm', '--force', containerName]);
    } catch {
      // --rm may already have removed the exact generated container.
    }
  });

  it('recovers a persisted mid-token crash with identical bytes and zero repeated model calls', async () => {
    const fixture = await createBaseFixture(dataSource, 'recovery');
    await insertAssignment(dataSource, fixture, 'atomic:v1');
    const longText = Array.from({ length: 100 }, (_, index) => {
      const prefix = `${String.fromCodePoint(0x3400 + index)}系统😀`;
      return (prefix + '支持并网安全运行。'.repeat(40)).slice(0, 250);
    }).join('');
    const snapshots = atomicSnapshots(fixture, 1, longText);
    const candidate = sealGroundedCandidateV1(snapshots.sealInput);
    const freshContent = {
      generateAtomicGroundingCandidate: jest.fn().mockResolvedValue({
        kind: 'sealed',
        candidate,
      }),
      generateWorkflowText: jest.fn(),
    };
    const domain = domainCommitter();
    const freshExecutor = shadowExecutor(
      freshContent,
      domain,
      'shadow_no_persist',
    );
    const executionStore = new MysqlWorkflowExecutionStore(dataSource);
    const firstClaim = await executionStore.claim(
      fixture.workflowJobId,
      'atomic-e2e-first',
    );
    if (!firstClaim) throw new Error('expected first workflow claim');
    const iterator = freshExecutor
      .execute(firstClaim, {
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();

    const meta = requireEvent(await iterator.next());
    const sealed = requireEvent(await iterator.next());
    await persistEvent(executionStore, firstClaim, meta);
    await persistEvent(executionStore, firstClaim, sealed);
    const firstToken = requireEvent(await iterator.next());
    await persistEvent(executionStore, firstClaim, firstToken);
    const prefix = String(firstToken.data?.content);
    expect(meta.type).toBe('meta');
    expect(sealed.checkpoint).toMatchObject({
      phase: 'atomic_sealed',
      sealed_candidate: candidate,
    });
    expect(firstToken.checkpoint).toMatchObject({
      phase: 'atomic_sealed',
      emitted_utf16: prefix.length,
    });
    const persistedRows = await dataSource.query<
      Array<{ checkpoint: Record<string, unknown> | string }>
    >('SELECT checkpoint FROM workflow_jobs WHERE id = ?', [
      fixture.workflowJobId,
    ]);
    expect(parseObject(persistedRows[0].checkpoint)).toMatchObject({
      emitted_utf16: prefix.length,
    });
    await iterator.return?.();
    await dataSource.query(
      `UPDATE workflow_jobs
          SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [fixture.workflowJobId],
    );
    const recoveryClaim = await executionStore.claim(
      fixture.workflowJobId,
      'atomic-e2e-recovery',
    );
    if (!recoveryClaim) throw new Error('expected recovery workflow claim');

    const recoveryModel = {
      generateGroundedDraft: jest.fn(),
    };
    const recoveryCoordinator = new AtomicGroundingCoordinator(
      {
        loadAssignment: jest.fn().mockResolvedValue(snapshots.assignment),
      } as never,
      {
        build: jest.fn().mockResolvedValue(snapshots.context),
      } as never,
      {
        generateGroundedDraft: recoveryModel.generateGroundedDraft,
      } as never,
      new AtomicGroundingVerifier(),
      new AtomicGroundingMetricsRecorder(),
    );
    const recoveredContent = new ContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      recoveryCoordinator,
    );
    const generateAtomic = jest.spyOn(
      recoveredContent,
      'generateAtomicGroundingCandidate',
    );
    const generateLegacy = jest.spyOn(recoveredContent, 'generateWorkflowText');
    const recoveredEvents = await collectPersisted(
      shadowExecutor(recoveredContent, domain, 'shadow_no_persist').execute(
        recoveryClaim,
        { signal: new AbortController().signal },
      ),
      executionStore,
      recoveryClaim,
    );
    const recoveredSuffix = recoveredEvents
      .filter((event) => event.type === 'token')
      .map((event) => String(event.data?.content))
      .join('');

    expect(prefix + recoveredSuffix).toBe(candidate.server_output.text);
    expect(
      (
        recoveredEvents.at(-1)?.checkpoint
          .sealed_candidate as SealedGroundedCandidateV1
      ).digests.envelope_digest,
    ).toBe(candidate.digests.envelope_digest);
    expect(generateAtomic).not.toHaveBeenCalled();
    expect(freshContent.generateAtomicGroundingCandidate).toHaveBeenCalledTimes(
      1,
    );
    expect(generateLegacy).not.toHaveBeenCalled();
    expect(recoveryModel.generateGroundedDraft).not.toHaveBeenCalled();
    expect(domain.commit).not.toHaveBeenCalled();
  });

  it('rejects every atomic commit variant before a transaction', async () => {
    const fixture = await createBaseFixture(dataSource, 'guard');
    const candidate = sealGroundedCandidateV1(
      atomicSnapshots(fixture, 1).sealInput,
    );
    const transaction = jest.spyOn(dataSource, 'transaction');
    const service = new WorkflowDomainCommitService(dataSource);
    for (const patch of [
      {},
      { approved_at: new Date() },
      {
        checkpoint: {
          capability: 'authoring-commit-capability',
          approval_digest: 'a'.repeat(64),
        },
      },
    ]) {
      await expect(
        service.commit(
          { ...atomicJob(fixture), ...patch } as ClaimedWorkflowJob,
          {
            contract_version: 'atomic:v1',
            sealed_candidate: candidate,
          },
        ),
      ).rejects.toMatchObject({ code: 'ATOMIC_COMMIT_NOT_AUTHORIZED' });
    }
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('rejects assignment/run/index/ingestion/context drift during recovery', async () => {
    const fixture = await createBaseFixture(dataSource, 'drift');
    const snapshots = atomicSnapshots(fixture, 1);
    const candidate = sealGroundedCandidateV1(snapshots.sealInput);
    const cases: Array<{
      assignment?: GroundingAssignmentSnapshot;
      context?: SealedApprovedRenderContextV1;
    }> = [
      {
        assignment: {
          ...snapshots.assignment,
          snapshot_digest: '0'.repeat(64),
        },
      },
      {
        assignment: {
          ...snapshots.assignment,
          retrieval_run_id: randomUUID(),
          snapshot_digest: '1'.repeat(64),
        },
      },
      {
        assignment: {
          ...snapshots.assignment,
          evidence: snapshots.assignment.evidence.map((item) => ({
            ...item,
            index_snapshot: { version: 2 },
          })),
          snapshot_digest: '2'.repeat(64),
        },
      },
      {
        assignment: {
          ...snapshots.assignment,
          evidence: snapshots.assignment.evidence.map((item) => ({
            ...item,
            ingestion_key: '0'.repeat(64),
          })),
          snapshot_digest: '3'.repeat(64),
        },
      },
      {
        context: {
          ...snapshots.context,
          entries: snapshots.context.entries.map((entry) => ({
            ...entry,
            label_nfc: '篡改',
          })),
        },
      },
    ];
    for (const drift of cases) {
      expect(() =>
        recoverSealedGroundedCandidateV1({
          checkpoint: candidate,
          current_assignment: drift.assignment ?? snapshots.assignment,
          current_render_context: drift.context ?? snapshots.context,
        }),
      ).toThrow();
    }
  });

  it('keeps off, empty, unknown and enforce at zero coordinator/model/domain calls', async () => {
    const fixture = await createBaseFixture(dataSource, 'off');
    for (const mode of [undefined, '', 'unknown', 'enforce']) {
      const content = {
        generateAtomicGroundingCandidate: jest.fn(),
        generateWorkflowText: jest.fn(),
      };
      const domain = domainCommitter();
      await expect(
        collect(
          shadowExecutor(content, domain, mode).execute(atomicJob(fixture), {
            signal: new AbortController().signal,
          }),
        ),
      ).rejects.toMatchObject({
        disposition: {
          internal_reason: 'ATOMIC_GROUNDING_DISABLED',
          public_code: 'ATOMIC_GROUNDING_UNAVAILABLE',
        },
      });
      expect(content.generateAtomicGroundingCandidate).not.toHaveBeenCalled();
      expect(content.generateWorkflowText).not.toHaveBeenCalled();
      expect(domain.commit).not.toHaveBeenCalled();
    }
  });

  it('downgrades historical SUPPORTED reads and rejects legacy compress inheritance', async () => {
    expect(
      capPersistedGroundingForRead({
        contract_version: 'legacy:v0',
        atomic_claim: null,
        support_status: 'SUPPORTED',
        support_score: 1,
        verification_method: 'deterministic_exact',
      }),
    ).toEqual({
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
    const transaction = jest.fn();
    const store = new SqlGroundingEvidenceStore({
      transaction,
    } as never);
    await expect(
      store.inheritEvidenceAssignment({
        workflow_job_id: randomUUID(),
        project_id: randomUUID(),
        parent_result_id: randomUUID(),
        strict_mode: true,
        contract_version: 'legacy:v0',
      }),
    ).rejects.toThrow('atomic:v1');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes atomic/legacy assignment contracts and binds both snapshot digests', async () => {
    const atomic = await createBaseFixture(dataSource, 'atomic-assignment');
    const legacy = await createBaseFixture(dataSource, 'legacy-assignment');
    const store = new SqlGroundingEvidenceStore(dataSource);
    await store.assignEvidence({
      workflow_job_id: atomic.workflowJobId,
      project_id: atomic.projectId,
      retrieval_run_id: atomic.retrievalRunId,
      retrieval_state: 'READY',
      evidence_ids: [],
      strict_mode: true,
      contract_version: 'atomic:v1',
    });
    await dataSource.query(
      `INSERT INTO grounding_assignments
         (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
          retrieval_run_refs, evidence_ids, strict_mode,
          targeted_revision_attempts)
       VALUES (?, ?, ?, 'READY', JSON_ARRAY(?), JSON_ARRAY(), 0, 0)`,
      [
        legacy.workflowJobId,
        legacy.projectId,
        legacy.retrievalRunId,
        legacy.retrievalRunId,
      ],
    );
    const atomicSnapshot = await store.loadAssignment(atomic.workflowJobId);
    const legacySnapshot = await store.loadAssignment(legacy.workflowJobId);
    const rows = await dataSource.query<
      Array<{ contractVersion: string; snapshotDigest: string }>
    >(
      `SELECT contract_version AS contractVersion,
              snapshot_digest AS snapshotDigest
         FROM grounding_assignments
        WHERE workflow_job_id IN (?, ?)
        ORDER BY contract_version`,
      [atomic.workflowJobId, legacy.workflowJobId],
    );

    expect(rows).toEqual([
      {
        contractVersion: 'atomic:v1',
        snapshotDigest: atomicSnapshot?.snapshot_digest,
      },
      {
        contractVersion: 'legacy:v0',
        snapshotDigest: legacySnapshot?.snapshot_digest,
      },
    ]);
    expect(atomicSnapshot?.snapshot_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(legacySnapshot?.snapshot_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(atomicSnapshot?.snapshot_digest).not.toBe(
      legacySnapshot?.snapshot_digest,
    );

    const executionStore = new MysqlWorkflowExecutionStore(dataSource);
    const claim = await executionStore.claim(
      atomic.workflowJobId,
      'atomic-revision-e2e',
    );
    if (!claim) throw new Error('expected atomic revision claim');
    const revisionCheckpoint = {
      phase: 'atomic_revision_required',
      generation_attempt: 1,
      revision_attempt: 1,
      canonical_proposal: {
        schema_version: 'grounded-draft.v1',
        status: 'draft',
        claims: [],
        render_fragments: [],
        ordering: [],
        material_gap: null,
      },
      candidate_claim_keys: ['candidate-key-1'],
      source_claim_texts: ['声明'],
      reason_codes: ['ATOM_EXACT_MISMATCH'],
      non_target_invariant_digests: {},
      base_retrieval_run_id: atomic.retrievalRunId,
    };
    await executionStore.persistProgress(
      claim,
      'grounding.revision_required',
      { type: 'revision_required' },
      revisionCheckpoint,
    );
    await executionStore.persistProgress(
      claim,
      'grounding.revision_required',
      { type: 'revision_required' },
      revisionCheckpoint,
    );
    const repeatedRevisionEvents = await dataSource.query<
      Array<{ count: number | string }>
    >(
      `SELECT COUNT(*) AS count
         FROM workflow_events
        WHERE job_id = ?
          AND type = 'grounding.revision_required'`,
      [atomic.workflowJobId],
    );
    expect(Number(repeatedRevisionEvents[0].count)).toBe(1);
    const modelRuns = new ModelRunService(dataSource.getRepository(ModelRun));
    const operationKey = '7'.repeat(64);
    await modelRuns.startAttempt({
      workflow_job_id: atomic.workflowJobId,
      provider: 'test-provider',
      model: 'test-model',
      workflow_node: 'atomic_grounded_revision',
      attempt_kind: 'initial',
      generation_attempt: 1,
      network_attempt: 0,
      repair_attempt: 0,
      request_metadata: null,
      prompt_sha256: '8'.repeat(64),
      operation_key: operationKey,
    });
    await expect(
      modelRuns.findOperationState(atomic.workflowJobId, operationKey),
    ).resolves.toBe('recorded');
    await expect(
      modelRuns.startAttempt({
        workflow_job_id: atomic.workflowJobId,
        provider: 'test-provider',
        model: 'test-model',
        workflow_node: 'atomic_grounded_revision',
        attempt_kind: 'initial',
        generation_attempt: 1,
        network_attempt: 0,
        repair_attempt: 0,
        request_metadata: null,
        prompt_sha256: '8'.repeat(64),
        operation_key: operationKey,
      }),
    ).rejects.toThrow();
    const revision = {
      base_proposal:
        revisionCheckpoint.canonical_proposal as GroundedDraftProposal,
      allowed_candidate_claim_keys: ['candidate-key-1'],
      non_target_invariant_digests: {},
    };
    const sparse = { search: jest.fn().mockResolvedValue([]) };
    const dense = {
      search: jest.fn().mockResolvedValue({
        candidates: [],
        state: 'ready',
        error_code: null,
      }),
    };
    const legacyBackend = { search: jest.fn().mockResolvedValue([]) };
    const config = {
      get: (_key: string, fallback: unknown) => fallback,
    };
    const persistence = new RetrievalPersistenceService(
      dataSource.getRepository(RetrievalRun),
      dataSource.getRepository(RetrievalCandidateRecord),
      dataSource.getRepository(RetrievalIndexVersion),
      dataSource,
      config as never,
    );
    const hybrid = new HybridRetriever(
      sparse,
      dense,
      legacyBackend,
      persistence,
      {
        expand: jest.fn((_projectId: string, candidates: unknown[]) =>
          Promise.resolve(candidates),
        ),
      } as never,
    );
    const retrieval = new RetrievalService(
      hybrid,
      legacyBackend,
      config as never,
      { canUseHybrid: jest.fn().mockResolvedValue(false) } as never,
    );
    let replacementAttempts = 0;
    const crashBoundaryStore = {
      loadAssignment: (workflowJobId: string) =>
        store.loadAssignment(workflowJobId),
      replaceEvidenceAfterTargetedRetrieval: jest.fn(
        async (
          input: Parameters<
            SqlGroundingEvidenceStore['replaceEvidenceAfterTargetedRetrieval']
          >[0],
        ) => {
          replacementAttempts += 1;
          if (replacementAttempts === 1) {
            throw new Error('simulated crash before assignment replacement');
          }
          return store.replaceEvidenceAfterTargetedRetrieval(input);
        },
      ),
    };
    const shared = new ContentSharedService(
      {} as never,
      retrieval,
      {} as never,
      crashBoundaryStore as never,
    );
    const generation = new ContentGenerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn().mockResolvedValue({ id: atomic.projectId }),
      } as never,
      {} as never,
      {} as never,
      shared,
    );
    const revisionContentService = new ContentService(
      {} as never,
      {} as never,
      generation,
      {} as never,
      {} as never,
    );
    const targetedClaims = [
      { claim_id: 'candidate-key-1', claim_text: '声明' },
    ];
    await expect(
      revisionContentService.prepareGroundingRevision(
        atomic.userId,
        atomic.projectId,
        atomic.workflowJobId,
        targetedClaims,
        new AbortController().signal,
        atomic.retrievalRunId,
      ),
    ).rejects.toThrow('simulated crash before assignment replacement');
    await revisionContentService.prepareGroundingRevision(
      atomic.userId,
      atomic.projectId,
      atomic.workflowJobId,
      targetedClaims,
      new AbortController().signal,
      atomic.retrievalRunId,
    );
    const revisionRuns = await dataSource.query<
      Array<{ id: string; count: number | string }>
    >(
      `SELECT MIN(id) AS id, COUNT(*) AS count
         FROM retrieval_runs
        WHERE workflow_job_id = ?
          AND revision_attempt = 1`,
      [atomic.workflowJobId],
    );
    const revisionRunId = revisionRuns[0].id;
    expect(Number(revisionRuns[0].count)).toBe(1);
    expect(sparse.search).toHaveBeenCalledTimes(1);
    expect(dense.search).toHaveBeenCalledTimes(1);
    expect(legacyBackend.search).toHaveBeenCalledTimes(1);
    const merged = await store.loadAssignment(atomic.workflowJobId);
    expect(merged).toMatchObject({
      retrieval_run_id: revisionRunId,
      targeted_revision_attempts: 1,
      contract_version: 'atomic:v1',
      strict_mode: true,
    });
    expect(merged?.retrieval_run_refs).toEqual([
      atomic.retrievalRunId,
      revisionRunId,
    ]);

    const prepareRevision = jest.fn(async () => {
      const current = await store.loadAssignment(atomic.workflowJobId);
      return {
        workflow_job_id: atomic.workflowJobId,
        project_id: atomic.projectId,
        workflow_type: 'content' as const,
        generation_attempt: 1,
        revision_attempt: 1 as const,
        authoring_context: { merged_run_id: current?.retrieval_run_id },
        signal: new AbortController().signal,
        revision,
      };
    });
    const coordinator = {
      generate: jest.fn().mockResolvedValue({
        kind: 'material_gap',
        reason_code: 'NO_EVIDENCE',
        candidate_claim_keys: [],
      }),
    };
    const candidateContentService = new ContentService(
      undefined as never,
      undefined as never,
      {
        prepareAtomicGroundingRevisionInput: prepareRevision,
      } as never,
      undefined as never,
      coordinator as never,
    );
    await expect(
      candidateContentService.generateAtomicGroundingRevisionCandidate(
        'content',
        atomic.userId,
        atomic.projectId,
        {
          revision_attempt: 1,
          revision,
        },
        new AbortController().signal,
        {
          workflow_job_id: atomic.workflowJobId,
          node: 'atomic_grounded_revision',
          attempt: 1,
        },
      ),
    ).resolves.toMatchObject({ kind: 'material_gap' });
    expect(prepareRevision).toHaveBeenCalledTimes(1);
    expect(coordinator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        revision_attempt: 1,
        authoring_context: { merged_run_id: revisionRunId },
      }),
    );
  });
});

interface BaseFixture {
  userId: string;
  projectId: string;
  workflowJobId: string;
  retrievalRunId: string;
}

async function createBaseFixture(
  dataSource: DataSource,
  label: string,
): Promise<BaseFixture> {
  const fixture = {
    userId: randomUUID(),
    projectId: randomUUID(),
    workflowJobId: randomUUID(),
    retrievalRunId: randomUUID(),
  };
  await dataSource.query(
    `INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'hash')`,
    [fixture.userId, `${label}-${fixture.userId}@example.test`],
  );
  await dataSource.query(
    `INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`,
    [fixture.projectId, fixture.userId, label],
  );
  await dataSource.query(
    `INSERT INTO workflow_jobs
       (id, user_id, project_id, workflow_type, idempotency_key,
        request_hash, status, input)
     VALUES (?, ?, ?, 'content', ?, ?, 'RUNNING',
             JSON_OBJECT('strict_citation', true))`,
    [
      fixture.workflowJobId,
      fixture.userId,
      fixture.projectId,
      `atomic-${label}`,
      createHash('sha256').update(label).digest('hex'),
    ],
  );
  await dataSource.query(
    `INSERT INTO retrieval_runs
       (id, project_id, query, task_type, query_plan, state, canonical_path)
     VALUES (?, ?, ?, 'content', JSON_OBJECT(), 'READY', 'hybrid')`,
    [fixture.retrievalRunId, fixture.projectId, label],
  );
  return fixture;
}

async function insertAssignment(
  dataSource: DataSource,
  fixture: BaseFixture,
  contractVersion: 'atomic:v1' | 'legacy:v0',
): Promise<void> {
  await dataSource.query(
    `INSERT INTO grounding_assignments
       (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
        retrieval_run_refs, evidence_ids, strict_mode, contract_version,
        targeted_revision_attempts)
     VALUES (?, ?, ?, 'READY', JSON_ARRAY(?), JSON_ARRAY(), 1, ?, 0)`,
    [
      fixture.workflowJobId,
      fixture.projectId,
      fixture.retrievalRunId,
      fixture.retrievalRunId,
      contractVersion,
    ],
  );
}

function atomicSnapshots(
  fixture: BaseFixture,
  generationAttempt: number,
  text = '系统支持并网运行。',
) {
  const claimTexts = splitUnicodeText(text, 250);
  let sourceOffset = 10;
  const assignedEvidence: AssignedEvidenceSnapshot[] = claimTexts.map(
    (claimText, index) => {
      const exactStart = sourceOffset;
      sourceOffset += claimText.length;
      return {
        evidence_id: `evidence:${index + 1}`,
        chunk_id: randomUUID(),
        project_id: fixture.projectId,
        file_id: randomUUID(),
        document_id: randomUUID(),
        retrieval_run_id: fixture.retrievalRunId,
        ingestion_key: '1'.repeat(64),
        content: claimText,
        exact_span_text: claimText,
        chunk_char_start: 0,
        exact_span_document_start: exactStart,
        exact_span_document_end: sourceOffset,
        candidate_rank: index + 1,
        scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
        ranks: {
          sparse: index + 1,
          dense: index + 1,
          fusion: index + 1,
          rerank: index + 1,
        },
        page_start: 1,
        page_end: 1,
        heading_path: ['第一章'],
        index_snapshot: { version: 1 },
        evidence_snapshot_digest: createHash('sha256')
          .update(`evidence:${index + 1}`)
          .digest('hex'),
      };
    },
  );
  const assignment: GroundingAssignmentSnapshot = {
    workflow_job_id: fixture.workflowJobId,
    project_id: fixture.projectId,
    retrieval_run_id: fixture.retrievalRunId,
    retrieval_state: 'READY',
    contract_version: 'atomic:v1',
    strict_mode: true,
    targeted_revision_attempts: 0,
    snapshot_digest: 'b'.repeat(64),
    evidence: assignedEvidence,
  };
  const context: SealedApprovedRenderContextV1 = {
    context_version: 'approved-render-context.v1',
    entries: [
      {
        structure_id: 'heading',
        source_kind: 'outline',
        source_id: 'outline-1',
        source_version: '1',
        label_nfc: '并网',
        presentation: 'heading_1',
      },
    ],
  };
  const renderFragments: GroundedDraftProposal['render_fragments'] = [
    {
      fragment_id: 'heading-fragment',
      kind: 'structure_ref',
      structure_id: 'heading',
      presentation: 'heading_1',
    },
    { fragment_id: 'line-0', kind: 'separator', token: 'line_break' },
  ];
  const ordering = ['heading-fragment', 'line-0'];
  const descriptors = claimTexts.map((claimText, index) => {
    if (index > 0) {
      const separatorId = `line-${index}`;
      renderFragments.push({
        fragment_id: separatorId,
        kind: 'separator',
        token: 'line_break',
      });
      ordering.push(separatorId);
    }
    const claimId = `claim-${index + 1}`;
    const fragmentId = `claim-fragment-${index + 1}`;
    const ordinal = renderFragments.length;
    const candidateClaimKey = createHash('sha256')
      .update(
        [
          'candidate-claim-key.v1',
          fixture.workflowJobId,
          String(generationAttempt),
          String(ordinal),
        ].join('\0'),
      )
      .digest('hex');
    const [subject, predicate] = firstTwoAnchors(claimText);
    renderFragments.push({
      fragment_id: fragmentId,
      kind: 'claim_ref',
      claim_id: claimId,
      presentation: 'sentence',
    });
    ordering.push(fragmentId);
    return {
      claimId,
      fragmentId,
      ordinal,
      claimText,
      candidateClaimKey,
      subject,
      predicate,
      evidenceId: `evidence:${index + 1}`,
      evidenceSnapshotDigest: assignedEvidence[index].evidence_snapshot_digest,
    };
  });
  const proposal: GroundedDraftProposal = {
    schema_version: 'grounded-draft.v1',
    status: 'draft',
    claims: descriptors.map((descriptor) => ({
      proposal_claim_id: descriptor.claimId,
      revision_of_candidate_claim_key: null,
      claim_text: descriptor.claimText,
      span: {
        fragment_id: descriptor.fragmentId,
        start_utf16: 0,
        end_utf16: descriptor.claimText.length,
      },
      subject: {
        surface: descriptor.subject.surface,
        start_utf16: descriptor.subject.start,
        end_utf16: descriptor.subject.end,
      },
      predicate: {
        surface: descriptor.predicate.surface,
        start_utf16: descriptor.predicate.start,
        end_utf16: descriptor.predicate.end,
      },
      polarity: 'affirmed',
      quantifier: 'plain',
      quantities: [],
      evidence_ids: [descriptor.evidenceId],
    })),
    render_fragments: renderFragments,
    ordering,
    material_gap: null,
  };
  const verification: AtomicVerificationResult = {
    decision: 'ALLOW',
    canonical_proposal: proposal,
    claims: descriptors.map((descriptor) => {
      const claimBase: Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'> = {
        canonical_claim_version: 'canonical-atomic-claim.v1',
        candidate_claim_key: descriptor.candidateClaimKey,
        source_claim_text_nfc: descriptor.claimText,
        subject_anchor: {
          surface_nfc: descriptor.subject.surface,
          start_utf16: descriptor.subject.start,
          end_utf16: descriptor.subject.end,
        },
        predicate_anchor: {
          surface_nfc: descriptor.predicate.surface,
          start_utf16: descriptor.predicate.start,
          end_utf16: descriptor.predicate.end,
        },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [],
        evidence_ids: [descriptor.evidenceId],
        fragment: {
          ordinal: descriptor.ordinal,
          presentation: 'sentence',
          previous_structure_id: 'heading',
          next_structure_id: null,
        },
        revision: { attempt: 0, revision_of_candidate_claim_key: null },
      };
      return {
        candidate_claim_key: descriptor.candidateClaimKey,
        canonical_claim_base: claimBase,
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_extract_exact',
        evidence_refs: [
          {
            evidence_id: descriptor.evidenceId,
            evidence_snapshot_digest: descriptor.evidenceSnapshotDigest,
          },
        ],
        reason_codes: [],
      };
    }),
    material_gap_reason: null,
  };
  return {
    assignment,
    context,
    sealInput: {
      workflow: {
        workflow_job_id: fixture.workflowJobId,
        project_id: fixture.projectId,
        workflow_type: 'content' as const,
        generation_attempt: generationAttempt,
        revision_attempt: 0 as const,
      },
      verification,
      assignment,
      render_context: context,
    },
  };
}

function splitUnicodeText(text: string, maxUtf16: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxUtf16);
    if (
      end < text.length &&
      end > start &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function firstTwoAnchors(
  text: string,
): [
  { surface: string; start: number; end: number },
  { surface: string; start: number; end: number },
] {
  const points = [...text];
  if (points.length < 2) throw new Error('atomic fixture claim too short');
  const subjectEnd = points[0].length;
  return [
    { surface: points[0], start: 0, end: subjectEnd },
    {
      surface: points[1],
      start: subjectEnd,
      end: subjectEnd + points[1].length,
    },
  ];
}

function atomicJob(
  fixture: BaseFixture,
  checkpoint: Record<string, unknown> | null = null,
  generationAttempt = 0,
): ClaimedWorkflowJob {
  return {
    id: fixture.workflowJobId,
    userId: fixture.userId,
    projectId: fixture.projectId,
    workflowType: WorkflowType.CONTENT,
    input: { strict_citation: true },
    checkpoint,
    leaseToken: randomUUID(),
    fencingToken: 1,
    generationAttempt,
  };
}

function shadowExecutor(
  content: ContentService | Record<string, unknown>,
  domain: jest.Mocked<WorkflowDomainCommitter>,
  mode: unknown,
): WorkflowGenerationExecutor {
  type Constructor = new (
    contentService: ContentService,
    domainCommitter: WorkflowDomainCommitter,
    config: { get(key: string): unknown },
    metrics: { firstRenderedToken(type: string, ms: number): void },
  ) => WorkflowGenerationExecutor;
  return new (WorkflowGenerationExecutor as unknown as Constructor)(
    content as unknown as ContentService,
    domain,
    { get: () => mode },
    { firstRenderedToken: jest.fn() },
  );
}

function domainCommitter(): jest.Mocked<WorkflowDomainCommitter> {
  return {
    commit: jest.fn().mockResolvedValue({ resourceId: 'forbidden' }),
    findCommitted: jest.fn().mockResolvedValue(null),
  };
}

async function collect(
  source: AsyncIterable<WorkflowExecutionEvent>,
): Promise<WorkflowExecutionEvent[]> {
  const events: WorkflowExecutionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function collectPersisted(
  source: AsyncIterable<WorkflowExecutionEvent>,
  store: MysqlWorkflowExecutionStore,
  job: ClaimedWorkflowJob,
): Promise<WorkflowExecutionEvent[]> {
  const events: WorkflowExecutionEvent[] = [];
  for await (const event of source) {
    events.push(event);
    await persistEvent(store, job, event);
  }
  return events;
}

async function persistEvent(
  store: MysqlWorkflowExecutionStore,
  job: ClaimedWorkflowJob,
  event: WorkflowExecutionEvent,
): Promise<void> {
  await store.persistProgress(job, event.type, event.data, event.checkpoint);
  event.onPersisted?.();
}

function parseObject(
  value: Record<string, unknown> | string,
): Record<string, unknown> {
  return typeof value === 'string'
    ? (JSON.parse(value) as Record<string, unknown>)
    : value;
}

function requireEvent(
  result: IteratorResult<WorkflowExecutionEvent, unknown>,
): WorkflowExecutionEvent {
  if (result.done) throw new Error('expected workflow event');
  return result.value;
}

async function expectZeroDomainWrites(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query<Array<Record<string, string>>>(
    `SELECT
       (SELECT COUNT(*) FROM workflow_domain_commits) AS domain_commits,
       (SELECT COUNT(*) FROM writing_results) AS writing_results,
       (SELECT COUNT(*) FROM content_versions) AS content_versions,
       (SELECT COUNT(*) FROM directory_versions) AS directory_versions,
       (SELECT COUNT(*) FROM outline_versions) AS outline_versions,
       (SELECT COUNT(*) FROM grounding_claims) AS grounding_claims,
       (SELECT COUNT(*) FROM citation_maps) AS citation_maps`,
  );
  expect(rows).toEqual([
    {
      domain_commits: '0',
      writing_results: '0',
      content_versions: '0',
      directory_versions: '0',
      outline_versions: '0',
      grounding_claims: '0',
      citation_maps: '0',
    },
  ]);
}
