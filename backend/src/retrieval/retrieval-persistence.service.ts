import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { RetrievalCandidateRecord } from './entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from './entities/retrieval-index-version.entity.js';
import { RetrievalRun } from './entities/retrieval-run.entity.js';
import { RetrievalRunIndexVersion } from './entities/retrieval-run-index.entity.js';
import type {
  IndexVersionRecorder,
  RetrievalRunCompletion,
  RetrievalRunRecorder,
  RetrievalRunStart,
  DenseIndexClaim,
  DenseIndexRetentionDebt,
  HybridRetrievalResult,
  IdempotentRetrievalStart,
} from './types.js';
import {
  buildRetrievalConfigBinding,
  retrievalConfigHash,
} from './retrieval-config.js';
import { digestCanonicalV1 } from '../citation/atomic-grounding/canonical-json.js';

@Injectable()
export class RetrievalPersistenceService
  implements RetrievalRunRecorder, IndexVersionRecorder
{
  private readonly collectionName: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimension: number;
  private readonly retrievalConfigHash: string;

  constructor(
    @InjectRepository(RetrievalRun)
    private readonly runRepo: Repository<RetrievalRun>,
    @InjectRepository(RetrievalCandidateRecord)
    private readonly candidateRepo: Repository<RetrievalCandidateRecord>,
    @InjectRepository(RetrievalIndexVersion)
    private readonly indexRepo: Repository<RetrievalIndexVersion>,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.collectionName = String(
      config.get('QDRANT_COLLECTION', 'write_agent_chunks'),
    );
    this.embeddingModel = String(
      config.get('EMBEDDING_MODEL', 'text-embedding-3-small'),
    );
    this.embeddingDimension = Number(config.get('EMBEDDING_DIMENSION', 1536));
    this.retrievalConfigHash = retrievalConfigHash(
      buildRetrievalConfigBinding({
        collection_name: this.collectionName,
        embedding_model: this.embeddingModel,
        embedding_dimension: this.embeddingDimension,
        index_version: String(config.get('RAG_INDEX_VERSION', 'rag-v1')),
      }),
    );
  }

  async start(input: RetrievalRunStart): Promise<string> {
    const run = await this.runRepo.save(
      this.runRepo.create({
        project_id: input.project_id,
        query: input.query,
        task_type: input.task_type,
        query_plan: input.plan,
        state: 'RUNNING',
        mode: input.mode,
        gate_decision: input.gate_decision,
        canonical_path: input.canonical_path,
        shadow_path: input.shadow_path,
        collection_name: this.collectionName,
        embedding_model: this.embeddingModel,
        embedding_dimension: this.embeddingDimension,
        retrieval_config_hash: this.retrievalConfigHash,
        error_code: null,
        error_message: null,
        completed_at: null,
        workflow_job_id: null,
        revision_attempt: null,
        request_sha256: null,
      }),
    );
    return run.id;
  }

  async startIdempotent(
    input: RetrievalRunStart,
  ): Promise<IdempotentRetrievalStart> {
    if (!input.workflow_job_id || input.revision_attempt !== 1) {
      throw new BadRequestException('定向检索缺少稳定工作流修订作用域');
    }
    if (
      !Number.isSafeInteger(input.top_k) ||
      (input.top_k ?? 0) <= 0 ||
      !Number.isSafeInteger(input.token_budget) ||
      (input.token_budget ?? 0) <= 0
    ) {
      throw new BadRequestException('定向检索请求预算无效');
    }
    const requestSha256 = digestCanonicalV1('targeted-retrieval-request.v1', {
      workflow_job_id: input.workflow_job_id,
      revision_attempt: input.revision_attempt,
      project_id: input.project_id,
      query: input.query,
      task_type: input.task_type,
      plan: input.plan,
      mode: input.mode,
      gate_decision: input.gate_decision,
      canonical_path: input.canonical_path,
      shadow_path: input.shadow_path,
      top_k: input.top_k,
      token_budget: input.token_budget,
      retrieval_config_hash: this.retrievalConfigHash,
    });
    return this.dataSource.transaction(async (manager) => {
      const jobs: unknown = await manager.query(
        `SELECT id
           FROM workflow_jobs
          WHERE id = ?
            AND project_id = ?
          FOR UPDATE`,
        [input.workflow_job_id, input.project_id],
      );
      if (!Array.isArray(jobs) || jobs.length !== 1) {
        throw new BadRequestException('定向检索工作流任务不存在');
      }
      const repository = manager.getRepository(RetrievalRun);
      const existing = await repository.findOne({
        where: {
          workflow_job_id: input.workflow_job_id,
          revision_attempt: input.revision_attempt,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (existing) {
        if (existing.request_sha256 !== requestSha256) {
          throw new ConflictException('定向检索请求与已保留运行不一致');
        }
        if (existing.state === 'RUNNING') {
          throw new ConflictException('定向检索运行终态不明确');
        }
        return {
          kind: 'recovered',
          result: await recoverRetrievalResult(manager, existing),
        };
      }
      const run = await repository.save(
        repository.create({
          project_id: input.project_id,
          query: input.query,
          task_type: input.task_type,
          query_plan: input.plan,
          state: 'RUNNING',
          mode: input.mode,
          gate_decision: input.gate_decision,
          canonical_path: input.canonical_path,
          shadow_path: input.shadow_path,
          collection_name: this.collectionName,
          embedding_model: this.embeddingModel,
          embedding_dimension: this.embeddingDimension,
          retrieval_config_hash: this.retrievalConfigHash,
          workflow_job_id: input.workflow_job_id,
          revision_attempt: input.revision_attempt,
          request_sha256: requestSha256,
          error_code: null,
          error_message: null,
          completed_at: null,
        }),
      );
      return { kind: 'started', run_id: run.id };
    });
  }

  async complete(runId: string, input: RetrievalRunCompletion): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const updated = await manager.update(
          RetrievalRun,
          { id: runId, state: 'RUNNING' },
          {
            state: input.state,
            error_code: input.error_code,
            error_message: input.error_message,
            latency_ms: input.latency_ms,
            sparse_count: input.sparse_count,
            dense_count: input.dense_count,
            fused_count: input.fused_count,
            legacy_count: input.legacy_count,
            selected_count: input.selected_count,
            embedding_cost_usd: input.embedding_cost_usd,
            embedding_input_tokens: input.embedding_input_tokens,
            embedding_estimated_cost_usd: input.embedding_estimated_cost_usd,
            embedding_estimated_input_tokens:
              input.embedding_estimated_input_tokens,
            embedding_usage_estimated: input.embedding_usage_estimated,
            canonical_state: input.canonical_state,
            canonical_latency_ms: input.canonical_latency_ms,
            canonical_count: input.canonical_count,
            canonical_error_code: input.canonical_error_code,
            canonical_error_message: input.canonical_error_message,
            shadow_state: input.shadow_state,
            shadow_latency_ms: input.shadow_latency_ms,
            shadow_count: input.shadow_count,
            shadow_error_code: input.shadow_error_code,
            shadow_error_message: input.shadow_error_message,
            completed_at: new Date(),
          },
        );
        if (updated.affected !== 1) {
          throw new Error(`Retrieval run ${runId} is not RUNNING`);
        }

        const evidenceByChunk = new Map(
          input.evidence.map((evidence) => [evidence.chunk_id, evidence]),
        );
        if (input.candidates.length > 0) {
          await manager.save(
            RetrievalCandidateRecord,
            input.candidates.map((candidate) =>
              manager.create(RetrievalCandidateRecord, {
                retrieval_run_id: runId,
                chunk_id: candidate.chunk_id,
                file_id: candidate.file_id,
                document_id: candidate.document_id,
                ingestion_key: candidate.ingestion_key,
                sparse_rank: candidate.sparse_rank,
                sparse_score: candidate.sparse_score,
                dense_rank: candidate.dense_rank,
                dense_score: candidate.dense_score,
                fusion_rank: candidate.fusion_rank,
                fusion_score: candidate.fusion_score,
                rerank_rank: candidate.rerank_rank,
                rerank_score: candidate.rerank_score,
                selected: evidenceByChunk.has(candidate.chunk_id),
                evidence: evidenceByChunk.get(candidate.chunk_id) ?? null,
              }),
            ),
          );
        }
        if (input.index_versions.length > 0) {
          await manager.save(
            RetrievalRunIndexVersion,
            input.index_versions.map((index) =>
              manager.create(RetrievalRunIndexVersion, {
                retrieval_run_id: runId,
                index_version_id: index.id,
                file_id: index.file_id,
                ingestion_key: index.ingestion_key,
                index_version: index.index_version,
                status: index.status,
                expected_point_count: index.expected_point_count,
                observed_point_count: index.observed_point_count,
              }),
            ),
          );
        }
      });
    } catch (error) {
      await this.runRepo
        .update(
          { id: runId, state: 'RUNNING' },
          {
            state: 'ERROR',
            error_code: 'RUN_PERSISTENCE_FAILED',
            error_message:
              error instanceof Error ? error.message : String(error),
            completed_at: new Date(),
          },
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async claimDispatchBatch(limit: number): Promise<DenseIndexClaim[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE retrieval_index_versions riv
          JOIN source_files sf
            ON sf.id = riv.file_id AND sf.project_id = riv.project_id
            SET riv.status = 'FAILED',
                riv.claim_token = NULL,
                riv.lease_expires_at = NULL,
                riv.next_retry_at = NULL,
                riv.error_code = 'STALE_INDEX_VERSION',
                riv.error_message =
                  'The source file has a newer active ingestion'
          WHERE riv.status <> 'READY'
            AND sf.active_ingestion_key <> riv.ingestion_key`,
      );
      await manager.query(
        `UPDATE retrieval_index_versions riv
          JOIN source_files sf
            ON sf.id = riv.file_id AND sf.project_id = riv.project_id
            SET riv.status = 'FAILED',
                riv.claim_token = NULL,
                riv.lease_expires_at = NULL,
                riv.next_retry_at = NULL,
                riv.error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
                riv.error_message =
                  'Dense indexing crashed after exhausting all attempts'
          WHERE riv.status IN ('QUEUED', 'RUNNING')
            AND riv.lease_expires_at IS NOT NULL
            AND riv.lease_expires_at <= CURRENT_TIMESTAMP(6)
            AND riv.attempt_count >= riv.max_attempts
            AND sf.active_ingestion_key = riv.ingestion_key`,
      );
      const rows = await manager.query<
        Array<
          Omit<DenseIndexClaim, 'attempt_token' | 'attempt_count'> & {
            attempt_count: number | string;
          }
        >
      >(
        `SELECT riv.id, riv.project_id, riv.file_id, riv.document_id,
                riv.ingestion_key, riv.chunk_version, riv.index_version,
                riv.status, riv.collection_name, riv.embedding_model,
                riv.embedding_dimension, riv.attempt_count
           FROM retrieval_index_versions riv
           JOIN source_files sf
             ON sf.id = riv.file_id AND sf.project_id = riv.project_id
          WHERE riv.attempt_count < riv.max_attempts
            AND sf.active_ingestion_key = riv.ingestion_key
            AND (
              riv.status = 'PENDING'
              OR (
                riv.status = 'FAILED'
                AND riv.next_retry_at IS NOT NULL
                AND riv.next_retry_at <= CURRENT_TIMESTAMP(6)
              )
              OR (
                riv.status IN ('QUEUED', 'RUNNING')
                AND riv.lease_expires_at IS NOT NULL
                AND riv.lease_expires_at <= CURRENT_TIMESTAMP(6)
              )
            )
          ORDER BY riv.created_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const claims: DenseIndexClaim[] = [];
      for (const row of rows) {
        const attemptToken = randomUUID();
        const result = await manager.query<{ affectedRows?: number }>(
          `UPDATE retrieval_index_versions
              SET status = 'QUEUED',
                  claim_token = ?,
                  attempt_count = attempt_count + 1,
                  lease_expires_at =
                    TIMESTAMPADD(SECOND, 120, CURRENT_TIMESTAMP(6)),
                  next_retry_at = NULL,
                  published_namespace = NULL,
                  error_code = NULL,
                  error_message = NULL
            WHERE id = ?
              AND attempt_count = ?`,
          [attemptToken, row.id, Number(row.attempt_count)],
        );
        if (Number(result.affectedRows ?? 0) !== 1) continue;
        claims.push({
          ...row,
          status: 'QUEUED',
          embedding_dimension: Number(row.embedding_dimension),
          attempt_count: Number(row.attempt_count) + 1,
          attempt_token: attemptToken,
        });
      }
      return claims;
    });
  }

  async releaseDispatchClaim(
    id: string,
    attemptToken: string,
    errorMessage: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE retrieval_index_versions
          SET status = 'FAILED',
              claim_token = NULL,
              lease_expires_at = NULL,
              next_retry_at = CASE
                WHEN attempt_count < max_attempts
                  THEN TIMESTAMPADD(SECOND, 5, CURRENT_TIMESTAMP(6))
                ELSE NULL
              END,
              error_code = 'QUEUE_PUBLISH_FAILED',
              error_message = ?
        WHERE id = ? AND claim_token = ? AND status = 'QUEUED'`,
      [errorMessage.slice(0, 10_000), id, attemptToken],
    );
  }

  async claimSpecificIndex(id: string): Promise<DenseIndexClaim | null> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<
        Array<
          Omit<DenseIndexClaim, 'attempt_token' | 'attempt_count'> & {
            attempt_count: number | string;
          }
        >
      >(
        `SELECT riv.id, riv.project_id, riv.file_id, riv.document_id,
                riv.ingestion_key, riv.chunk_version, riv.index_version,
                riv.status, riv.collection_name, riv.embedding_model,
                riv.embedding_dimension, riv.attempt_count
           FROM retrieval_index_versions riv
           JOIN source_files sf
             ON sf.id = riv.file_id AND sf.project_id = riv.project_id
          WHERE riv.id = ?
            AND riv.attempt_count < riv.max_attempts
            AND sf.active_ingestion_key = riv.ingestion_key
            AND riv.status IN ('PENDING', 'FAILED')
          FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const attemptToken = randomUUID();
      const result = await manager.query<{ affectedRows?: number }>(
        `UPDATE retrieval_index_versions
            SET status = 'QUEUED',
                claim_token = ?,
                attempt_count = attempt_count + 1,
                lease_expires_at =
                  TIMESTAMPADD(SECOND, 120, CURRENT_TIMESTAMP(6)),
                next_retry_at = NULL,
                published_namespace = NULL,
                error_code = NULL,
                error_message = NULL
          WHERE id = ? AND attempt_count = ?`,
        [attemptToken, id, Number(row.attempt_count)],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return {
        ...row,
        status: 'QUEUED',
        embedding_dimension: Number(row.embedding_dimension),
        attempt_count: Number(row.attempt_count) + 1,
        attempt_token: attemptToken,
      };
    });
  }

  async beginAttempt(
    id: string,
    attemptToken: string,
  ): Promise<DenseIndexClaim | null> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE retrieval_index_versions riv
        JOIN source_files sf
          ON sf.id = riv.file_id AND sf.project_id = riv.project_id
          SET riv.status = 'RUNNING',
              riv.lease_expires_at =
                TIMESTAMPADD(SECOND, 300, CURRENT_TIMESTAMP(6))
        WHERE riv.id = ?
          AND riv.claim_token = ?
          AND riv.status = 'QUEUED'
          AND riv.lease_expires_at > CURRENT_TIMESTAMP(6)
          AND sf.active_ingestion_key = riv.ingestion_key`,
      [id, attemptToken],
    );
    if (Number(result.affectedRows ?? 0) !== 1) return null;
    const rows = await this.dataSource.query<DenseIndexClaim[]>(
      `SELECT id, project_id, file_id, document_id, ingestion_key,
              chunk_version, index_version, status, collection_name,
              embedding_model, embedding_dimension, claim_token AS attempt_token,
              attempt_count
         FROM retrieval_index_versions
        WHERE id = ? AND claim_token = ?`,
      [id, attemptToken],
    );
    return rows[0] ?? null;
  }

  async isAttemptActive(id: string, attemptToken: string): Promise<boolean> {
    const rows = await this.dataSource.query<
      Array<{ active: number | string }>
    >(
      `SELECT 1 AS active
         FROM retrieval_index_versions riv
         JOIN source_files sf
           ON sf.id = riv.file_id AND sf.project_id = riv.project_id
        WHERE riv.id = ?
          AND riv.claim_token = ?
          AND riv.status = 'RUNNING'
          AND riv.lease_expires_at > CURRENT_TIMESTAMP(6)
          AND sf.active_ingestion_key = riv.ingestion_key
        LIMIT 1`,
      [id, attemptToken],
    );
    return rows.length === 1;
  }

  async renewAttemptLease(id: string, attemptToken: string): Promise<boolean> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE retrieval_index_versions riv
        JOIN source_files sf
          ON sf.id = riv.file_id AND sf.project_id = riv.project_id
          SET riv.lease_expires_at =
                TIMESTAMPADD(SECOND, 300, CURRENT_TIMESTAMP(6))
        WHERE riv.id = ?
          AND riv.claim_token = ?
          AND riv.status = 'RUNNING'
          AND riv.lease_expires_at > CURRENT_TIMESTAMP(6)
          AND sf.active_ingestion_key = riv.ingestion_key`,
      [id, attemptToken],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  async attemptFenceState(
    id: string,
    attemptToken: string,
  ): Promise<'ACTIVE' | 'STALE_INGESTION' | 'LEASE_EXPIRED' | 'SUPERSEDED'> {
    const rows = await this.dataSource.query<
      Array<{
        claim_token: string | null;
        status: string;
        ingestion_key: string;
        active_ingestion_key: string | null;
        expired: number | string;
      }>
    >(
      `SELECT riv.claim_token,
              riv.status,
              riv.ingestion_key,
              sf.active_ingestion_key,
              riv.lease_expires_at <= CURRENT_TIMESTAMP(6) AS expired
         FROM retrieval_index_versions riv
         JOIN source_files sf
           ON sf.id = riv.file_id AND sf.project_id = riv.project_id
        WHERE riv.id = ?
        LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row || row.claim_token !== attemptToken || row.status !== 'RUNNING') {
      return 'SUPERSEDED';
    }
    if (row.active_ingestion_key !== row.ingestion_key) {
      return 'STALE_INGESTION';
    }
    if (Number(row.expired) === 1) return 'LEASE_EXPIRED';
    return 'ACTIVE';
  }

  async markReady(
    id: string,
    attemptToken: string,
    input: { point_count: number; indexed_at: Date },
  ): Promise<boolean> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE retrieval_index_versions riv
        JOIN source_files sf
          ON sf.id = riv.file_id AND sf.project_id = riv.project_id
          SET riv.status = 'READY',
              riv.point_count = ?,
              riv.indexed_at = ?,
              riv.error_code = NULL,
              riv.error_message = NULL,
              riv.claim_token = NULL,
              riv.lease_expires_at = NULL,
              riv.next_retry_at = NULL,
              riv.published_namespace = ?
        WHERE riv.id = ?
          AND riv.claim_token = ?
          AND riv.status = 'RUNNING'
          AND riv.lease_expires_at > CURRENT_TIMESTAMP(6)
          AND sf.active_ingestion_key = riv.ingestion_key`,
      [
        input.point_count,
        input.indexed_at,
        `${id}:${attemptToken}`,
        id,
        attemptToken,
      ],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  async markFailed(
    id: string,
    attemptToken: string,
    input: { error_code: string; error_message: string },
  ): Promise<boolean> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE retrieval_index_versions
          SET status = 'FAILED',
              error_code = ?,
              error_message = ?,
              claim_token = NULL,
              lease_expires_at = NULL,
              next_retry_at = CASE
                WHEN ? = 'STALE_INGESTION' THEN NULL
                WHEN attempt_count < max_attempts
                  THEN TIMESTAMPADD(
                    SECOND,
                    LEAST(300, POW(2, attempt_count)),
                    CURRENT_TIMESTAMP(6)
                  )
                ELSE NULL
              END
        WHERE id = ?
          AND claim_token = ?
          AND status = 'RUNNING'`,
      [
        input.error_code,
        input.error_message.slice(0, 10_000),
        input.error_code,
        id,
        attemptToken,
      ],
    );
    return Number(result.affectedRows ?? 0) === 1;
  }

  async recordRetentionDebtBatch(
    limit: number,
  ): Promise<DenseIndexRetentionDebt[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query<
        Array<{ id: string; file_id: string; namespace: string }>
      >(
        `SELECT stale.id,
                stale.file_id,
                stale.published_namespace AS namespace
           FROM retrieval_index_versions stale
           JOIN source_files sf
             ON sf.id = stale.file_id AND sf.project_id = stale.project_id
          WHERE stale.status = 'READY'
            AND stale.published_namespace IS NOT NULL
            AND stale.ingestion_key <> sf.active_ingestion_key
            AND stale.retention_debt_recorded_at IS NULL
          ORDER BY stale.updated_at ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const debts: DenseIndexRetentionDebt[] = [];
      for (const row of rows) {
        const result = await manager.query<{ affectedRows?: number }>(
          `UPDATE retrieval_index_versions stale
             JOIN source_files sf
               ON sf.id = stale.file_id AND sf.project_id = stale.project_id
              SET stale.retention_debt_recorded_at = CURRENT_TIMESTAMP(6),
                  stale.retention_debt_reason =
                    'REACTIVATABLE_NAMESPACE_RETAINED'
            WHERE stale.id = ?
              AND stale.published_namespace = ?
              AND stale.status = 'READY'
              AND stale.ingestion_key <> sf.active_ingestion_key
              AND stale.retention_debt_recorded_at IS NULL`,
          [row.id, row.namespace],
        );
        if (Number(result.affectedRows ?? 0) !== 1) continue;
        debts.push({
          id: row.id,
          file_id: row.file_id,
          namespace: row.namespace,
          reason: 'REACTIVATABLE_NAMESPACE_RETAINED',
        });
      }
      return debts;
    });
  }
}

async function recoverRetrievalResult(
  manager: EntityManager,
  run: RetrievalRun,
): Promise<HybridRetrievalResult> {
  const hybridState =
    run.canonical_path === 'hybrid' ? run.canonical_state : run.shadow_state;
  if (
    hybridState !== 'READY' &&
    hybridState !== 'DEGRADED' &&
    hybridState !== 'NO_HIT' &&
    hybridState !== 'ERROR'
  ) {
    throw new ConflictException('定向检索终态记录不完整');
  }
  const selected = await manager.getRepository(RetrievalCandidateRecord).find({
    where: { retrieval_run_id: run.id, selected: true },
    order: { rerank_rank: 'ASC' },
  });
  const evidence = selected.flatMap((candidate) =>
    candidate.evidence ? [candidate.evidence] : [],
  );
  if (evidence.length !== selected.length) {
    throw new ConflictException('定向检索证据快照不完整');
  }
  const hybridErrorCode =
    run.canonical_path === 'hybrid'
      ? run.canonical_error_code
      : run.shadow_error_code;
  const hybridErrorMessage =
    run.canonical_path === 'hybrid'
      ? run.canonical_error_message
      : run.shadow_error_message;
  return {
    run_id: run.id,
    state: hybridState,
    error_code: hybridErrorCode,
    error_message: hybridErrorMessage,
    evidence,
    used_tokens: evidence.reduce((total, item) => total + item.token_count, 0),
    canonical_path: run.canonical_path,
    shadow_state: run.shadow_state,
    embedding_cost_usd:
      run.embedding_cost_usd ?? run.embedding_estimated_cost_usd,
  };
}
