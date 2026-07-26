import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  GroundingAssignmentSnapshot,
  GroundingEvidenceStore,
} from './citation-ledger.service.js';
import type {
  AssignedEvidenceSnapshot,
  GroundingVerificationResult,
} from './grounding-verifier.js';
import type { EvidenceItem, RetrievalState } from '../retrieval/types.js';
import { MaterialGapError } from './material-gap.error.js';
import type { GroundingContractVersion } from './entities/grounding-assignment.entity.js';
import { AtomicGroundingClosedFailure } from './atomic-grounding/failure-policy.js';
import type { AtomicGroundingReasonCode } from './atomic-grounding/contracts.js';

interface AssignmentMetadataRow {
  workflow_job_id: string;
  job_project_id: string;
  assignment_project_id: string;
  retrieval_run_id: string;
  retrieval_run_refs?: unknown;
  primary_run_project_id: string;
  primary_run_state: RetrievalState;
  retrieval_state: RetrievalState;
  contract_version: GroundingContractVersion;
  snapshot_digest?: string | null;
  strict_mode: number | string | boolean;
  targeted_revision_attempts: number | string;
  evidence_ids: unknown;
}

interface AssignmentEvidenceRow {
  evidence_retrieval_run_id: string;
  evidence_run_project_id: string;
  evidence_run_state: RetrievalState;
  evidence_json: unknown;
  selected: number | string | boolean;
  chunk_id: string;
  chunk_project_id: string;
  file_id: string;
  document_id: string;
  candidate_ingestion_key: string | null;
  chunk_ingestion_key: string | null;
  active_ingestion_key: string | null;
  document_ingestion_key: string | null;
  chunk_active: number | string | boolean;
  document_active: number | string | boolean;
  content: string;
  chunk_char_start: number | string | null;
  sparse_rank: number | string | null;
  dense_rank: number | string | null;
  fusion_rank: number | string;
  rerank_rank: number | string;
  sparse_score: number | string | null;
  dense_score: number | string | null;
  fusion_score: number | string;
  rerank_score: number | string;
}

export interface AssignGroundingEvidenceInput {
  workflow_job_id: string;
  project_id: string;
  retrieval_run_id: string;
  retrieval_state: RetrievalState;
  evidence_ids: string[];
  strict_mode: boolean;
  contract_version: GroundingContractVersion;
}

export interface InheritGroundingEvidenceInput {
  workflow_job_id: string;
  project_id: string;
  parent_result_id: string;
  strict_mode: boolean;
  contract_version: GroundingContractVersion;
}

export interface ReplaceGroundingEvidenceInput extends AssignGroundingEvidenceInput {
  revision_attempt: number;
}

@Injectable()
export class SqlGroundingEvidenceStore implements GroundingEvidenceStore {
  constructor(private readonly dataSource: DataSource) {}

  async assignEvidence(input: AssignGroundingEvidenceInput): Promise<void> {
    const evidenceIds = [...new Set(input.evidence_ids)];
    await this.dataSource.transaction(async (manager) => {
      const rows: unknown = await manager.query(
        `SELECT w.project_id AS job_project_id,
                r.project_id AS run_project_id,
                r.state AS retrieval_state,
                rc.evidence
           FROM workflow_jobs w
           JOIN retrieval_runs r ON r.id = ?
           LEFT JOIN retrieval_candidates rc
             ON rc.retrieval_run_id = r.id
            AND rc.selected = 1
          WHERE w.id = ?
            AND w.project_id = ?
          FOR UPDATE`,
        [input.retrieval_run_id, input.workflow_job_id, input.project_id],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new BadRequestException('工作流或检索快照不存在');
      }
      const first = rows[0] as Record<string, unknown>;
      if (
        first.job_project_id !== input.project_id ||
        first.run_project_id !== input.project_id
      ) {
        throw new BadRequestException('检索快照不属于当前项目');
      }
      const state = String(first.retrieval_state) as RetrievalState;
      if (state !== 'READY' && state !== 'DEGRADED' && state !== 'NO_HIT') {
        throw new BadRequestException(`检索状态 ${state} 不能用于写作`);
      }
      const available = new Set(
        rows.flatMap((row) => {
          const parsed = parseEvidence(
            (row as Record<string, unknown>).evidence,
          );
          return parsed ? [parsed.evidence_id] : [];
        }),
      );
      for (const evidenceId of evidenceIds) {
        if (!available.has(evidenceId)) {
          throw new BadRequestException(
            `证据 ${evidenceId} 未包含在检索快照中`,
          );
        }
      }
      await manager.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode, contract_version,
            targeted_revision_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           retrieval_run_id = IF(retrieval_run_id = VALUES(retrieval_run_id),
                                 retrieval_run_id, NULL),
           evidence_ids = IF(evidence_ids = VALUES(evidence_ids),
                             evidence_ids, NULL),
           strict_mode = IF(strict_mode = VALUES(strict_mode),
                            strict_mode, NULL),
           contract_version =
             IF(contract_version = VALUES(contract_version),
                contract_version, NULL)`,
        [
          input.workflow_job_id,
          input.project_id,
          input.retrieval_run_id,
          state,
          JSON.stringify([input.retrieval_run_id]),
          JSON.stringify(evidenceIds),
          input.strict_mode ? 1 : 0,
          input.contract_version,
        ],
      );
    });
  }

  async inheritEvidenceAssignment(
    input: InheritGroundingEvidenceInput,
  ): Promise<GroundingAssignmentSnapshot> {
    if (input.contract_version !== 'atomic:v1') {
      throw new MaterialGapError('原写作结果不满足 atomic:v1 继承契约');
    }
    const rawRows: unknown = await this.dataSource.query(
      `SELECT DISTINCT ga.retrieval_run_id,
              ga.retrieval_state,
              ga.retrieval_run_refs,
              ga.contract_version,
              COALESCE(cm.retrieval_run_id, ga.retrieval_run_id)
                AS evidence_retrieval_run_id,
              cm.evidence_id
         FROM writing_results wr
         JOIN grounding_claims gc
           ON gc.result_id = wr.id
          AND gc.project_id = wr.project_id
         JOIN grounding_assignments ga
           ON ga.workflow_job_id = gc.workflow_job_id
          AND ga.project_id = gc.project_id
         JOIN citation_maps cm
           ON cm.claim_id = gc.claim_id
          AND cm.result_id = gc.result_id
          AND cm.project_id = gc.project_id
        WHERE wr.id = ?
          AND wr.project_id = ?
          AND NOT EXISTS (
                SELECT 1
                  FROM grounding_claims parent_gc
                  LEFT JOIN grounding_assignments parent_ga
                    ON parent_ga.workflow_job_id = parent_gc.workflow_job_id
                   AND parent_ga.project_id = parent_gc.project_id
                 WHERE parent_gc.result_id = wr.id
                   AND parent_gc.project_id = wr.project_id
                   AND (
                     parent_ga.workflow_job_id IS NULL
                     OR parent_ga.contract_version <> 'atomic:v1'
                     OR parent_gc.atomic_claim IS NULL
                     OR JSON_TYPE(parent_gc.atomic_claim) <> 'OBJECT'
                     OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                          parent_gc.atomic_claim,
                          '$.canonicalizer_version')), '')
                          <> 'atomic-canonicalizer.v1'
                     OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                          parent_gc.atomic_claim,
                          '$.quantity_lexer_version')), '')
                          <> 'quantity-lexer.v1'
                     OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                          parent_gc.atomic_claim,
                          '$.verifier_version')), '')
                          <> 'atomic-verifier.v1'
                     OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(
                          parent_gc.atomic_claim,
                          '$.canonical_claim.canonical_claim_version')), '')
                          <> 'canonical-atomic-claim.v1'
                     OR parent_gc.support_status <> 'SUPPORTED'
                     OR parent_gc.verification_method NOT IN (
                          'atomic_extract_exact',
                          'atomic_typed_equivalent'
                        )
                     OR NOT EXISTS (
                          SELECT 1
                            FROM citation_maps required_cm
                           WHERE required_cm.claim_id = parent_gc.claim_id
                             AND required_cm.result_id = parent_gc.result_id
                             AND required_cm.project_id = parent_gc.project_id
                        )
                     OR EXISTS (
                          SELECT 1
                            FROM citation_maps invalid_cm
                           WHERE invalid_cm.claim_id = parent_gc.claim_id
                             AND invalid_cm.result_id = parent_gc.result_id
                             AND invalid_cm.project_id = parent_gc.project_id
                             AND (
                               invalid_cm.evidence_id IS NULL
                               OR invalid_cm.snapshot_digest IS NULL
                             )
                        )
                   )
              )
          AND ga.contract_version = 'atomic:v1'
          AND gc.atomic_claim IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(
                gc.atomic_claim,
                '$.canonical_claim.canonical_claim_version'))
                = 'canonical-atomic-claim.v1'
          AND JSON_UNQUOTE(JSON_EXTRACT(
                gc.atomic_claim, '$.verifier_version'))
                = 'atomic-verifier.v1'
          AND gc.support_status = 'SUPPORTED'
          AND gc.verification_method IN ('atomic_extract_exact', 'atomic_typed_equivalent')
          AND cm.evidence_id IS NOT NULL
          AND cm.snapshot_digest IS NOT NULL
        ORDER BY ga.retrieval_run_id, evidence_retrieval_run_id,
                 cm.evidence_id`,
      [input.parent_result_id, input.project_id],
    );
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new MaterialGapError(
        '原写作结果没有可继承的可信证据，请重新检索后继续',
      );
    }
    const rows = rawRows as Array<Record<string, unknown>>;
    const runIds = new Set(
      rows.map((row) =>
        typeof row.retrieval_run_id === 'string' ? row.retrieval_run_id : '',
      ),
    );
    const states = new Set(
      rows.map((row) =>
        typeof row.retrieval_state === 'string' ? row.retrieval_state : '',
      ),
    );
    if (runIds.size !== 1 || states.size !== 1) {
      throw new MaterialGapError('原写作结果的证据快照不一致，请重新检索');
    }
    const retrievalRunId = [...runIds][0];
    const retrievalState = [...states][0] as RetrievalState;
    if (
      retrievalState !== 'READY' &&
      retrievalState !== 'DEGRADED' &&
      retrievalState !== 'NO_HIT'
    ) {
      throw new MaterialGapError('原写作结果的检索快照不可继承');
    }
    const parentRunRefs = parseOptionalStringArray(
      rows[0].retrieval_run_refs,
      retrievalRunId,
    );
    const evidenceRefs = rows.flatMap((row) => {
      const evidenceId =
        typeof row.evidence_id === 'string' ? row.evidence_id : '';
      const runId =
        typeof row.evidence_retrieval_run_id === 'string'
          ? row.evidence_retrieval_run_id
          : '';
      return evidenceId && runId
        ? [{ evidence_id: evidenceId, run_id: runId }]
        : [];
    });
    if (evidenceRefs.length === 0) {
      throw new MaterialGapError('原写作结果没有可继承的可信证据');
    }
    if (
      evidenceRefs.some(
        (reference) => !parentRunRefs.includes(reference.run_id),
      )
    ) {
      throw new MaterialGapError('原写作结果的证据检索引用不一致');
    }
    const runByEvidenceId = new Map<string, string>();
    for (const reference of evidenceRefs) {
      const existing = runByEvidenceId.get(reference.evidence_id);
      if (existing && existing !== reference.run_id) {
        throw new MaterialGapError(
          '旧版证据标识跨检索快照冲突，请重新检索后再精简',
        );
      }
      runByEvidenceId.set(reference.evidence_id, reference.run_id);
    }
    await this.assignEvidenceReferences({
      workflow_job_id: input.workflow_job_id,
      project_id: input.project_id,
      retrieval_run_id: retrievalRunId,
      retrieval_run_refs: parentRunRefs,
      evidence_refs: [...runByEvidenceId].map(([evidence_id, run_id]) => ({
        evidence_id,
        run_id,
      })),
      strict_mode: input.strict_mode,
      contract_version: input.contract_version,
    });
    const assignment = await this.loadAssignment(input.workflow_job_id);
    if (!assignment) {
      throw new MaterialGapError('继承证据分配失败，请重新检索');
    }
    return assignment;
  }

  private async assignEvidenceReferences(input: {
    workflow_job_id: string;
    project_id: string;
    retrieval_run_id: string;
    retrieval_run_refs: string[];
    evidence_refs: Array<{ evidence_id: string; run_id: string }>;
    strict_mode: boolean;
    contract_version: GroundingContractVersion;
  }): Promise<void> {
    const runRefs = [...new Set(input.retrieval_run_refs)];
    if (
      runRefs.length === 0 ||
      !runRefs.includes(input.retrieval_run_id) ||
      input.evidence_refs.some(
        (reference) => !runRefs.includes(reference.run_id),
      )
    ) {
      throw new MaterialGapError('继承证据的检索快照引用无效');
    }
    await this.dataSource.transaction(async (manager) => {
      const rows: unknown = await manager.query(
        `SELECT w.project_id AS job_project_id,
                pr.project_id AS primary_run_project_id,
                pr.state AS primary_run_state,
                er.id AS evidence_retrieval_run_id,
                er.project_id AS evidence_run_project_id,
                er.state AS evidence_run_state,
                rc.evidence
           FROM workflow_jobs w
           JOIN retrieval_runs pr ON pr.id = ?
           JOIN retrieval_runs er
             ON er.id IN (${runRefs.map(() => '?').join(',')})
           LEFT JOIN retrieval_candidates rc
             ON rc.retrieval_run_id = er.id
            AND rc.selected = 1
          WHERE w.id = ?
            AND w.project_id = ?
          FOR UPDATE`,
        [
          input.retrieval_run_id,
          ...runRefs,
          input.workflow_job_id,
          input.project_id,
        ],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new MaterialGapError('继承证据的工作流或检索快照不存在');
      }
      const records = rows as Array<Record<string, unknown>>;
      const first = records[0];
      const primaryState = String(first.primary_run_state) as RetrievalState;
      if (
        first.job_project_id !== input.project_id ||
        first.primary_run_project_id !== input.project_id ||
        !isTerminalRetrievalState(primaryState)
      ) {
        throw new MaterialGapError('原写作结果的主检索快照不可继承');
      }
      const available = new Set<string>();
      const seenRuns = new Set<string>();
      for (const row of records) {
        const runId =
          typeof row.evidence_retrieval_run_id === 'string'
            ? row.evidence_retrieval_run_id
            : '';
        if (
          !runRefs.includes(runId) ||
          row.evidence_run_project_id !== input.project_id ||
          !isTerminalRetrievalState(
            String(row.evidence_run_state) as RetrievalState,
          )
        ) {
          throw new MaterialGapError('原写作结果的检索快照不可继承');
        }
        seenRuns.add(runId);
        const parsed = parseEvidence(row.evidence);
        if (parsed) available.add(`${runId}\0${parsed.evidence_id}`);
      }
      if (seenRuns.size !== runRefs.length) {
        throw new MaterialGapError('原写作结果的检索快照引用不完整');
      }
      for (const reference of input.evidence_refs) {
        if (!available.has(`${reference.run_id}\0${reference.evidence_id}`)) {
          throw new MaterialGapError(
            `证据 ${reference.evidence_id} 未包含在原检索快照中`,
          );
        }
      }
      const evidenceIds = input.evidence_refs.map(
        (reference) => reference.evidence_id,
      );
      await manager.query(
        `INSERT INTO grounding_assignments
           (workflow_job_id, project_id, retrieval_run_id, retrieval_state,
            retrieval_run_refs, evidence_ids, strict_mode, contract_version,
            targeted_revision_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           retrieval_run_id = IF(retrieval_run_id = VALUES(retrieval_run_id),
                                 retrieval_run_id, NULL),
           retrieval_run_refs =
             IF(retrieval_run_refs = VALUES(retrieval_run_refs),
                retrieval_run_refs, NULL),
           evidence_ids = IF(evidence_ids = VALUES(evidence_ids),
                             evidence_ids, NULL),
           strict_mode = IF(strict_mode = VALUES(strict_mode),
                            strict_mode, NULL),
           contract_version =
             IF(contract_version = VALUES(contract_version),
                contract_version, NULL)`,
        [
          input.workflow_job_id,
          input.project_id,
          input.retrieval_run_id,
          primaryState,
          JSON.stringify(runRefs),
          JSON.stringify(evidenceIds),
          input.strict_mode ? 1 : 0,
          input.contract_version,
        ],
      );
    });
  }

  async replaceEvidenceAfterTargetedRetrieval(
    input: ReplaceGroundingEvidenceInput,
  ): Promise<void> {
    if (input.contract_version !== 'atomic:v1' || input.strict_mode !== true) {
      throw new MaterialGapError(
        '定向修订仅允许 atomic:v1 严格 grounding contract',
      );
    }
    if (input.revision_attempt !== 1) {
      throw new BadRequestException('定向修订次数无效');
    }
    const evidenceIds = [...new Set(input.evidence_ids)];
    await this.dataSource.transaction(async (manager) => {
      const assignmentRows: unknown = await manager.query(
        `SELECT retrieval_run_id, retrieval_run_refs, evidence_ids,
                strict_mode, contract_version, targeted_revision_attempts
           FROM grounding_assignments
          WHERE workflow_job_id = ?
            AND project_id = ?
          FOR UPDATE`,
        [input.workflow_job_id, input.project_id],
      );
      if (!Array.isArray(assignmentRows) || assignmentRows.length !== 1) {
        throw new MaterialGapError('定向修订证据分配已失效');
      }
      const assignment = assignmentRows[0] as Record<string, unknown>;
      if (Number(assignment.targeted_revision_attempts) !== 1) {
        throw new MaterialGapError('定向修订证据分配已失效');
      }
      if (assignment.contract_version !== input.contract_version) {
        throw new MaterialGapError('定向修订 grounding contract 已变化');
      }
      const oldEvidenceIds = parseStringArray(assignment.evidence_ids);
      const oldRunRefs = parseOptionalStringArray(
        assignment.retrieval_run_refs,
        String(assignment.retrieval_run_id),
      );
      const rows: unknown = await manager.query(
        `SELECT w.project_id AS job_project_id,
                r.project_id AS run_project_id,
                r.state AS retrieval_state,
                rc.evidence
           FROM workflow_jobs w
           JOIN retrieval_runs r ON r.id = ?
           LEFT JOIN retrieval_candidates rc
             ON rc.retrieval_run_id = r.id
            AND rc.selected = 1
          WHERE w.id = ?
            AND w.project_id = ?
          FOR UPDATE`,
        [input.retrieval_run_id, input.workflow_job_id, input.project_id],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new BadRequestException('工作流或定向检索快照不存在');
      }
      const first = rows[0] as Record<string, unknown>;
      if (
        first.job_project_id !== input.project_id ||
        first.run_project_id !== input.project_id
      ) {
        throw new BadRequestException('定向检索快照不属于当前项目');
      }
      const state = String(first.retrieval_state) as RetrievalState;
      if (state !== 'READY' && state !== 'DEGRADED' && state !== 'NO_HIT') {
        throw new BadRequestException(`检索状态 ${state} 不能用于定向修订`);
      }
      const available = new Set(
        rows.flatMap((row) => {
          const parsed = parseEvidence(
            (row as Record<string, unknown>).evidence,
          );
          return parsed ? [parsed.evidence_id] : [];
        }),
      );
      for (const evidenceId of evidenceIds) {
        if (!available.has(evidenceId)) {
          throw new BadRequestException(
            `证据 ${evidenceId} 未包含在定向检索快照中`,
          );
        }
      }
      const mergedRunRefs = [
        ...new Set([...oldRunRefs, input.retrieval_run_id]),
      ];
      const mergedEvidenceIds = [
        ...new Set([...oldEvidenceIds, ...evidenceIds]),
      ];
      const updated: unknown = await manager.query(
        `UPDATE grounding_assignments
            SET retrieval_run_id = ?,
                retrieval_state = ?,
                retrieval_run_refs = ?,
                evidence_ids = ?,
                strict_mode = ?,
                contract_version = ?,
                snapshot_digest = NULL,
                updated_at = CURRENT_TIMESTAMP(6)
          WHERE workflow_job_id = ?
            AND project_id = ?
            AND targeted_revision_attempts = ?`,
        [
          input.retrieval_run_id,
          state,
          JSON.stringify(mergedRunRefs),
          JSON.stringify(mergedEvidenceIds),
          input.strict_mode ? 1 : 0,
          input.contract_version,
          input.workflow_job_id,
          input.project_id,
          input.revision_attempt,
        ],
      );
      if (affectedRows(updated) !== 1) {
        throw new MaterialGapError('定向修订证据分配已失效');
      }
    });
  }

  async loadAssignment(
    workflowJobId: string,
  ): Promise<GroundingAssignmentSnapshot | null> {
    const loaded = await readAssignmentSnapshot(
      this.dataSource,
      workflowJobId,
      false,
    );
    if (!loaded) return null;
    if (!loaded.persisted_snapshot_digest) {
      await this.dataSource.query(
        `UPDATE grounding_assignments
            SET snapshot_digest = ?
          WHERE workflow_job_id = ?
            AND snapshot_digest IS NULL`,
        [loaded.snapshot.snapshot_digest, workflowJobId],
      );
    }
    return loaded.snapshot;
  }

  async saveLedger(
    managerValue: unknown,
    resultId: string,
    ledger: GroundingVerificationResult,
  ): Promise<void> {
    const manager = managerValue as Pick<EntityManager, 'query'>;
    await assertAssignmentSnapshotStillActive(manager, ledger);
    for (const claim of ledger.claims) {
      await manager.query(
        `INSERT INTO grounding_claims
           (claim_id, workflow_job_id, project_id, result_id, claim_text,
            normalized_claim_text, output_char_start, output_char_end,
            support_status, support_score, verification_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          claim.claim_id,
          ledger.workflow_job_id,
          ledger.project_id,
          resultId,
          claim.claim_text,
          claim.normalized_claim_text,
          claim.output_char_start,
          claim.output_char_end,
          claim.support_status,
          claim.support_score,
          claim.verification_method,
        ],
      );
      for (const link of claim.links) {
        await manager.query(
          `INSERT INTO citation_maps
             (id, project_id, result_id, paragraph_key, chunk_id, file_id,
              use_type, evidence_text, page_number, section_title,
              confidence_score, claim_id, evidence_id, document_id,
              retrieval_run_id, support_status, support_score,
              verification_method, evidence_char_start, evidence_char_end,
              chunk_char_start, chunk_char_end, candidate_rank,
              \`sparse_rank\`, \`dense_rank\`, \`fusion_rank\`, \`rerank_rank\`,
              sparse_score, dense_score, fusion_score, rerank_score,
              ingestion_key, index_snapshot, snapshot_digest)
           VALUES (?, ?, ?, ?, ?, ?, 'synthesize', ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            link.project_id,
            resultId,
            `claim:${claim.claim_id.slice(0, 24)}`,
            link.chunk_id,
            link.file_id,
            link.exact_span_text,
            link.page_start,
            link.heading_path.join(' > ') || null,
            claim.support_score,
            claim.claim_id,
            link.evidence_id,
            link.document_id,
            link.retrieval_run_id,
            claim.support_status,
            claim.support_score,
            claim.verification_method,
            link.exact_span_document_start,
            link.exact_span_document_end,
            link.exact_span_chunk_start,
            link.exact_span_chunk_end,
            link.candidate_rank,
            link.ranks.sparse,
            link.ranks.dense,
            link.ranks.fusion,
            link.ranks.rerank,
            link.scores.sparse,
            link.scores.dense,
            link.scores.fusion,
            link.scores.rerank,
            link.ingestion_key,
            JSON.stringify(link.index_snapshot),
            ledger.assignment_snapshot_digest ?? null,
          ],
        );
      }
    }
  }
}

interface SqlExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

interface LoadedAssignment {
  snapshot: GroundingAssignmentSnapshot;
  persisted_snapshot_digest: string | null;
}

async function readAssignmentSnapshot(
  executor: SqlExecutor,
  workflowJobId: string,
  lockForCommit: boolean,
): Promise<LoadedAssignment | null> {
  const lock = lockForCommit ? ' FOR UPDATE' : '';
  const metadataRows: unknown = await executor.query(
    `SELECT ga.workflow_job_id,
            w.project_id AS job_project_id,
            ga.project_id AS assignment_project_id,
            ga.retrieval_run_id,
            ga.retrieval_run_refs,
            ga.retrieval_state,
            ga.contract_version,
            r.project_id AS primary_run_project_id,
            r.state AS primary_run_state,
            ga.strict_mode,
            ga.targeted_revision_attempts,
            ga.evidence_ids,
            ga.snapshot_digest
       FROM grounding_assignments ga
       JOIN workflow_jobs w ON w.id = ga.workflow_job_id
       JOIN retrieval_runs r ON r.id = ga.retrieval_run_id
      WHERE ga.workflow_job_id = ?${lock}`,
    [workflowJobId],
  );
  if (!Array.isArray(metadataRows) || metadataRows.length === 0) return null;
  if (metadataRows.length !== 1) {
    throw new AtomicGroundingClosedFailure(
      'ASSIGNMENT_SNAPSHOT_DRIFT',
      'grounding assignment 元数据不唯一',
    );
  }
  const metadata = metadataRows[0] as AssignmentMetadataRow;
  const runRefs = parseOptionalStringArray(
    metadata.retrieval_run_refs,
    metadata.retrieval_run_id,
    'EVIDENCE_RUN_DRIFT',
  );
  if (!runRefs.includes(metadata.retrieval_run_id)) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_RUN_DRIFT',
      'grounding assignment 主检索不在快照引用中',
    );
  }
  validateAssignmentMetadata(metadata);
  const runRows: unknown = await executor.query(
    `SELECT id, project_id, state
       FROM retrieval_runs
      WHERE id IN (${runRefs.map(() => '?').join(',')})
      ORDER BY id${lock}`,
    runRefs,
  );
  if (!Array.isArray(runRows) || runRows.length !== runRefs.length) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_RUN_DRIFT',
      'grounding assignment 检索快照引用无效',
    );
  }
  const runStates = new Map<string, RetrievalState>();
  for (const raw of runRows as Array<Record<string, unknown>>) {
    const id = typeof raw.id === 'string' ? raw.id : '';
    const projectId = typeof raw.project_id === 'string' ? raw.project_id : '';
    const state = String(raw.state) as RetrievalState;
    if (
      !runRefs.includes(id) ||
      projectId !== metadata.assignment_project_id ||
      !isTerminalRetrievalState(state)
    ) {
      throw new AtomicGroundingClosedFailure(
        'EVIDENCE_RUN_DRIFT',
        'grounding assignment 检索状态无效',
      );
    }
    runStates.set(id, state);
  }
  if (runStates.get(metadata.retrieval_run_id) !== metadata.retrieval_state) {
    throw new AtomicGroundingClosedFailure(
      'RETRIEVAL_STATE_INVALID',
      'grounding assignment 检索状态无效',
    );
  }

  const candidateRows: unknown = await executor.query(
    `SELECT rc.retrieval_run_id AS evidence_retrieval_run_id,
            rr.project_id AS evidence_run_project_id,
            rr.state AS evidence_run_state,
            rc.evidence AS evidence_json,
            rc.selected,
            c.id AS chunk_id,
            c.project_id AS chunk_project_id,
            c.file_id,
            c.document_id,
            rc.ingestion_key AS candidate_ingestion_key,
            c.ingestion_key AS chunk_ingestion_key,
            sf.active_ingestion_key,
            d.ingestion_key AS document_ingestion_key,
            c.is_active AS chunk_active,
            d.is_active AS document_active,
            c.content,
            c.char_start AS chunk_char_start,
            rc.sparse_rank,
            rc.dense_rank,
            rc.fusion_rank,
            rc.rerank_rank,
            rc.sparse_score,
            rc.dense_score,
            rc.fusion_score,
            rc.rerank_score
       FROM retrieval_candidates rc
       JOIN retrieval_runs rr ON rr.id = rc.retrieval_run_id
       JOIN chunks c ON c.id = rc.chunk_id
       JOIN source_files sf ON sf.id = c.file_id
       JOIN documents d ON d.id = c.document_id
      WHERE rc.retrieval_run_id IN (${runRefs.map(() => '?').join(',')})
        AND rc.selected = 1
      ORDER BY (rc.retrieval_run_id = ?) ASC, rc.rerank_rank, rc.id${lock}`,
    [...runRefs, metadata.retrieval_run_id],
  );
  const rows = Array.isArray(candidateRows)
    ? (candidateRows as AssignmentEvidenceRow[])
    : [];
  const indexRows: unknown = await executor.query(
    `SELECT retrieval_run_id, file_id, ingestion_key, index_version, status,
            expected_point_count, observed_point_count
       FROM retrieval_run_index_versions
      WHERE retrieval_run_id IN (${runRefs.map(() => '?').join(',')})
      ORDER BY retrieval_run_id, file_id, index_version${lock}`,
    runRefs,
  );
  const indexes = Array.isArray(indexRows)
    ? (indexRows as Array<Record<string, unknown>>)
    : [];
  const assignedIds = parseStringArray(
    metadata.evidence_ids,
    'ASSIGNMENT_SNAPSHOT_DRIFT',
  );
  const evidenceById = new Map<string, AssignedEvidenceSnapshot>();
  for (const row of rows) {
    const parsed = parseEvidence(row.evidence_json);
    if (!parsed || !assignedIds.includes(parsed.evidence_id)) continue;
    validateEvidenceProject(metadata.assignment_project_id, row);
    validateActiveEvidence(metadata.assignment_project_id, row, parsed);
    if (metadata.contract_version === 'atomic:v1') {
      validateEvidenceOffsets(row, parsed);
    }
    const snapshot = indexes.find(
      (index) =>
        index.retrieval_run_id === row.evidence_retrieval_run_id &&
        index.file_id === row.file_id &&
        index.ingestion_key === row.candidate_ingestion_key,
    );
    const assigned = toAssignedEvidence(row, parsed, snapshot ?? {});
    const current = evidenceById.get(parsed.evidence_id);
    if (current) {
      if (
        current.retrieval_run_id !== assigned.retrieval_run_id ||
        current.evidence_snapshot_digest !== assigned.evidence_snapshot_digest
      ) {
        throw new AtomicGroundingClosedFailure(
          'EVIDENCE_LEGACY_AMBIGUOUS',
          `legacy evidence id 歧义: ${parsed.evidence_id}`,
        );
      }
      continue;
    }
    evidenceById.set(parsed.evidence_id, assigned);
  }
  for (const evidenceId of assignedIds) {
    if (!evidenceById.has(evidenceId)) {
      throw new AtomicGroundingClosedFailure(
        'EVIDENCE_NOT_SELECTED',
        `未找到已分配证据 ${evidenceId}`,
      );
    }
  }
  const evidence = assignedIds.map((id) => evidenceById.get(id)!);
  const strictMode = asBoolean(metadata.strict_mode);
  const calculatedDigest = assignmentSnapshotDigest({
    contractVersion: metadata.contract_version,
    retrievalRunId: metadata.retrieval_run_id,
    state: metadata.retrieval_state,
    runRefs,
    runStates,
    strictMode,
    evidenceIds: assignedIds,
    evidence,
  });
  if (
    metadata.snapshot_digest &&
    metadata.snapshot_digest !== calculatedDigest
  ) {
    throw new AtomicGroundingClosedFailure(
      'ASSIGNMENT_SNAPSHOT_DRIFT',
      'grounding assignment 快照摘要不一致',
    );
  }
  return {
    persisted_snapshot_digest: metadata.snapshot_digest ?? null,
    snapshot: {
      workflow_job_id: metadata.workflow_job_id,
      project_id: metadata.assignment_project_id,
      retrieval_run_id: metadata.retrieval_run_id,
      retrieval_run_refs: runRefs,
      retrieval_state: metadata.retrieval_state,
      contract_version: metadata.contract_version,
      strict_mode: strictMode,
      targeted_revision_attempts: Number(metadata.targeted_revision_attempts),
      snapshot_digest: calculatedDigest,
      evidence,
    },
  };
}

async function assertAssignmentSnapshotStillActive(
  manager: Pick<EntityManager, 'query'>,
  ledger: GroundingVerificationResult,
): Promise<void> {
  if (!ledger.assignment_snapshot_digest) {
    throw new MaterialGapError('grounding assignment 缺少快照摘要');
  }
  let loaded: LoadedAssignment | null;
  try {
    loaded = await readAssignmentSnapshot(
      manager as unknown as SqlExecutor,
      ledger.workflow_job_id,
      true,
    );
  } catch {
    throw new MaterialGapError('证据候选或索引快照已变化');
  }
  if (
    !loaded ||
    loaded.snapshot.project_id !== ledger.project_id ||
    loaded.snapshot.retrieval_run_id !== ledger.retrieval_run_id ||
    loaded.snapshot.snapshot_digest !== ledger.assignment_snapshot_digest ||
    loaded.persisted_snapshot_digest !== ledger.assignment_snapshot_digest
  ) {
    throw new MaterialGapError('grounding assignment 快照已变化');
  }
  const expectedRunRefs = [
    ...(ledger.retrieval_run_refs ?? [ledger.retrieval_run_id]),
  ].sort();
  const currentRunRefs = [
    ...(loaded.snapshot.retrieval_run_refs ?? [
      loaded.snapshot.retrieval_run_id,
    ]),
  ].sort();
  if (stableJson(expectedRunRefs) !== stableJson(currentRunRefs)) {
    throw new MaterialGapError('grounding assignment 检索引用已变化');
  }
  const freshById = new Map(
    loaded.snapshot.evidence.map((item) => [item.evidence_id, item]),
  );
  for (const claim of ledger.claims) {
    for (const link of claim.links) {
      const fresh = freshById.get(link.evidence_id);
      if (
        !fresh ||
        fresh.retrieval_run_id !== link.retrieval_run_id ||
        fresh.evidence_snapshot_digest !== link.evidence_snapshot_digest
      ) {
        throw new MaterialGapError(
          `证据 ${link.evidence_id} 快照已变化，请重新检索`,
        );
      }
    }
  }
}

function validateAssignmentMetadata(row: AssignmentMetadataRow): void {
  if (
    row.job_project_id !== row.assignment_project_id ||
    row.primary_run_project_id !== row.assignment_project_id
  ) {
    throw new AtomicGroundingClosedFailure(
      'ASSIGNMENT_PROJECT_MISMATCH',
      'grounding assignment 项目归属无效',
    );
  }
  if (
    row.contract_version !== 'atomic:v1' &&
    row.contract_version !== 'legacy:v0'
  ) {
    throw new AtomicGroundingClosedFailure(
      'ASSIGNMENT_CONTRACT_MISMATCH',
      'grounding assignment contract 无效',
    );
  }
  if (
    !isTerminalRetrievalState(row.retrieval_state) ||
    row.primary_run_state !== row.retrieval_state
  ) {
    throw new AtomicGroundingClosedFailure(
      'RETRIEVAL_STATE_INVALID',
      'grounding assignment 检索状态无效',
    );
  }
}

function validateEvidenceProject(
  projectId: string,
  row: AssignmentEvidenceRow,
): void {
  if (
    row.chunk_project_id !== projectId ||
    row.evidence_run_project_id !== projectId
  ) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_OWNERSHIP_INVALID',
      'grounding evidence 项目归属无效',
    );
  }
}

function validateActiveEvidence(
  projectId: string,
  row: AssignmentEvidenceRow,
  evidence: EvidenceItem,
): void {
  if (
    row.evidence_run_project_id !== projectId ||
    !isTerminalRetrievalState(row.evidence_run_state)
  ) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_RUN_DRIFT',
      'grounding evidence 检索状态无效',
    );
  }
  if (!asBoolean(row.selected)) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_NOT_SELECTED',
      `证据 ${evidence.evidence_id} 未被检索选中`,
    );
  }
  if (!asBoolean(row.chunk_active) || !asBoolean(row.document_active)) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_INGESTION_INACTIVE',
      `证据 ${evidence.evidence_id} 已失效`,
    );
  }
  if (
    !row.candidate_ingestion_key ||
    row.candidate_ingestion_key !== row.chunk_ingestion_key ||
    row.candidate_ingestion_key !== row.active_ingestion_key ||
    row.candidate_ingestion_key !== row.document_ingestion_key ||
    evidence.source.ingestion_key !== row.candidate_ingestion_key
  ) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_INGESTION_INACTIVE',
      `证据 ${evidence.evidence_id} ingestion 已过期`,
    );
  }
  if (
    evidence.chunk_id !== row.chunk_id ||
    evidence.source.file_id !== row.file_id ||
    evidence.source.document_id !== row.document_id
  ) {
    throw new AtomicGroundingClosedFailure(
      'EVIDENCE_SNAPSHOT_DRIFT',
      `证据 ${evidence.evidence_id} 来源快照无效`,
    );
  }
}

function validateEvidenceOffsets(
  row: AssignmentEvidenceRow,
  evidence: EvidenceItem,
): void {
  const chunkStart = nullableNumber(row.chunk_char_start);
  const documentStart = evidence.exact_span.char_start;
  const documentEnd = evidence.exact_span.char_end;
  if (
    chunkStart === null ||
    !Number.isSafeInteger(chunkStart) ||
    chunkStart < 0 ||
    typeof documentStart !== 'number' ||
    !Number.isSafeInteger(documentStart) ||
    typeof documentEnd !== 'number' ||
    !Number.isSafeInteger(documentEnd) ||
    documentStart < chunkStart ||
    documentEnd < documentStart ||
    row.content.slice(documentStart - chunkStart, documentEnd - chunkStart) !==
      evidence.exact_span.text
  ) {
    throw new AtomicGroundingClosedFailure('EVIDENCE_OFFSET_DRIFT');
  }
}

function toAssignedEvidence(
  row: AssignmentEvidenceRow,
  evidence: EvidenceItem,
  indexSnapshot: Record<string, unknown>,
): AssignedEvidenceSnapshot {
  const snapshot: AssignedEvidenceSnapshot = {
    evidence_id: evidence.evidence_id,
    chunk_id: row.chunk_id,
    project_id: row.chunk_project_id,
    file_id: row.file_id,
    document_id: row.document_id,
    retrieval_run_id: row.evidence_retrieval_run_id,
    ingestion_key: row.candidate_ingestion_key,
    content: row.content,
    exact_span_text: evidence.exact_span.text,
    chunk_char_start: nullableNumber(row.chunk_char_start),
    exact_span_document_start: evidence.exact_span.char_start,
    exact_span_document_end: evidence.exact_span.char_end,
    candidate_rank: Number(row.rerank_rank),
    scores: {
      sparse: nullableNumber(row.sparse_score),
      dense: nullableNumber(row.dense_score),
      fusion: Number(row.fusion_score),
      rerank: Number(row.rerank_score),
    },
    ranks: {
      sparse: nullableNumber(row.sparse_rank),
      dense: nullableNumber(row.dense_rank),
      fusion: Number(row.fusion_rank),
      rerank: Number(row.rerank_rank),
    },
    page_start: evidence.source.page_start,
    page_end: evidence.source.page_end,
    heading_path: evidence.source.heading_path,
    index_snapshot: indexSnapshot,
  };
  snapshot.evidence_snapshot_digest = evidenceSnapshotDigest(snapshot);
  return snapshot;
}

function parseEvidence(value: unknown): EvidenceItem | null {
  const parsed = parseJson(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).evidence_id !== 'string'
  ) {
    return null;
  }
  return parsed as EvidenceItem;
}

function parseStringArray(
  value: unknown,
  reason?: AtomicGroundingReasonCode,
): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    if (reason) {
      throw new AtomicGroundingClosedFailure(
        reason,
        'grounding assignment evidence_ids 无效',
      );
    }
    throw new BadRequestException('grounding assignment evidence_ids 无效');
  }
  return parsed.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

function parseOptionalStringArray(
  value: unknown,
  fallback: string,
  reason?: AtomicGroundingReasonCode,
): string[] {
  if (value === null || value === undefined) return [fallback];
  const parsed = parseStringArray(value, reason);
  return parsed.length > 0 ? parsed : [fallback];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asBoolean(value: unknown): boolean {
  return value === true || Number(value) === 1;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function affectedRows(value: unknown): number {
  return typeof value === 'object' && value !== null && 'affectedRows' in value
    ? Number((value as { affectedRows: unknown }).affectedRows)
    : 0;
}

function evidenceSnapshotDigest(evidence: AssignedEvidenceSnapshot): string {
  return sha256(
    stableJson({
      evidence_id: evidence.evidence_id,
      chunk_id: evidence.chunk_id,
      project_id: evidence.project_id,
      file_id: evidence.file_id,
      document_id: evidence.document_id,
      retrieval_run_id: evidence.retrieval_run_id,
      ingestion_key: evidence.ingestion_key,
      content: evidence.content,
      exact_span_text: evidence.exact_span_text,
      chunk_char_start: evidence.chunk_char_start,
      exact_span_document_start: evidence.exact_span_document_start,
      exact_span_document_end: evidence.exact_span_document_end,
      candidate_rank: evidence.candidate_rank,
      scores: evidence.scores,
      ranks: evidence.ranks,
      page_start: evidence.page_start,
      page_end: evidence.page_end,
      heading_path: evidence.heading_path,
      index_snapshot: evidence.index_snapshot,
    }),
  );
}

function assignmentSnapshotDigest(input: {
  contractVersion: GroundingContractVersion;
  retrievalRunId: string;
  state: RetrievalState;
  runRefs: string[];
  runStates: Map<string, RetrievalState>;
  strictMode: boolean;
  evidenceIds: string[];
  evidence: AssignedEvidenceSnapshot[];
}): string {
  return sha256(
    stableJson({
      contract_version: input.contractVersion,
      retrieval_run_id: input.retrievalRunId,
      retrieval_state: input.state,
      retrieval_run_refs: [...input.runRefs].sort(),
      retrieval_run_states: [...input.runStates.entries()].sort(
        ([left], [right]) => left.localeCompare(right),
      ),
      strict_mode: input.strictMode,
      evidence_ids: [...input.evidenceIds].sort(),
      evidence: [...input.evidence]
        .sort((left, right) =>
          left.evidence_id.localeCompare(right.evidence_id),
        )
        .map((item) => item.evidence_snapshot_digest),
    }),
  );
}

function isTerminalRetrievalState(state: RetrievalState): boolean {
  return state === 'READY' || state === 'DEGRADED' || state === 'NO_HIT';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value);
}
