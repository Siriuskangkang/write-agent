import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { DataSource, type EntityManager } from 'typeorm';
import { TaskType, WritingResultStatus } from '../../common/enums.js';
import type { SealedGroundedCandidateV1 } from '../../citation/atomic-grounding/contracts.js';
import { parseSealedGroundedCandidateWorkflowV1 } from '../../citation/atomic-grounding/sealed-grounded-candidate.js';
import type { ClaimedWorkflowJob } from '../../workflow/workflow.engine.js';
import {
  WorkflowCancelledError,
  WorkflowLeaseLostError,
} from '../../workflow/workflow.engine.js';
import { WorkflowStatus, WorkflowType } from '../../workflow/workflow.types.js';

const MAX_STRUCTURED_PAYLOAD_BYTES = 1_048_576;
const MAX_BODY_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface AuthoringCommitReceipt {
  resourceId: string;
  versionId: string;
}

interface CreatedAuthoringResource extends AuthoringCommitReceipt {
  resourceVersion: number;
}

export interface ApprovedAuthoringProposalRow {
  id: string;
  job_id: string;
  project_id: string;
  user_id: string;
  artifact_kind: 'body' | 'directory' | 'outline';
  status: 'APPROVED' | 'COMMITTED';
  payload: Buffer | null;
  payload_utf8_bytes: number | string;
  payload_sha256: string;
  expires_active: number | string;
  resource_id: string | null;
  resource_version: number | string | null;
}

interface LockedWorkflowRow {
  id: string;
  user_id: string;
  project_id: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  cancel_requested_at: Date | string | null;
  lease_token: string | null;
  fencing_token: number | string;
  lease_active: number | string;
}

interface DomainCommitRow {
  workflow_type: WorkflowType;
  resource_id: string;
  version_id: string | null;
  commit_payload: Record<string, unknown> | string | null;
}

interface WritingScope {
  sessionId: string | null;
  chapterNodeId: string | null;
  sectionNodeId: string | null;
  chapterIndex: number | null;
  chapterTitle: string | null;
  sectionTitle: string | null;
  style: string | null;
  parentResultId: string | null;
}

export type AuthoringCommitErrorCode =
  | 'AUTHORING_COMMIT_RECEIPT_MISMATCH'
  | 'AUTHORING_PARENT_NOT_APPROVED'
  | 'AUTHORING_GROUNDING_INVALID'
  | 'AUTHORING_PAYLOAD_DIGEST_MISMATCH'
  | 'AUTHORING_PAYLOAD_INVALID'
  | 'AUTHORING_PROPOSAL_EXPIRED'
  | 'AUTHORING_PROPOSAL_NOT_APPROVED'
  | 'AUTHORING_SCOPE_INVALID';

export class AuthoringCommitError extends Error {
  constructor(readonly code: AuthoringCommitErrorCode) {
    super(code);
    this.name = 'AuthoringCommitError';
  }
}

@Injectable()
export class AuthoringCommitService {
  constructor(private readonly dataSource: DataSource) {}

  commitApproved(job: ClaimedWorkflowJob): Promise<AuthoringCommitReceipt> {
    return this.dataSource.transaction(async (manager) => {
      const workflow = await this.lockWorkflow(manager, job.id);
      this.assertWorkflowIdentity(workflow, job);

      const proposal = await this.lockProposal(manager, job.id);
      this.assertProposalIdentity(proposal, job);

      const existing = await this.findDomainCommit(manager, job.id);
      if (existing) {
        return this.recoverReceipt(existing, proposal, job);
      }
      if (proposal.status === 'COMMITTED') {
        return this.recoverProposalReceipt(manager, proposal);
      }

      this.assertFence(workflow, job);
      this.assertApproved(proposal);
      const payload = this.verifyPayload(proposal);
      const candidate = this.verifyAtomicCandidate(job, proposal, payload);
      if (candidate) {
        await this.assertAtomicAssignment(manager, job, candidate);
      }
      const receipt = await this.commitArtifact(
        manager,
        job,
        proposal,
        payload,
      );
      if (candidate) {
        await this.persistAtomicLedger(
          manager,
          job,
          receipt.resourceId,
          candidate,
        );
      }

      const proposalUpdate: unknown = await manager.query(
        `UPDATE authoring_proposals
            SET status='COMMITTED',
                resource_id=?,
                resource_version=?,
                committed_at=CURRENT_TIMESTAMP(6)
          WHERE id=?
            AND job_id=?
            AND project_id=?
            AND user_id=?
            AND status='APPROVED'`,
        [
          receipt.resourceId,
          receipt.resourceVersion,
          proposal.id,
          job.id,
          job.projectId,
          job.userId,
        ],
      );
      if (affectedRows(proposalUpdate) !== 1) {
        throw new WorkflowLeaseLostError();
      }

      await manager.query(
        `INSERT INTO workflow_domain_commits
           (workflow_job_id,workflow_type,resource_id,version_id,
            fencing_token,commit_payload)
         VALUES (?,?,?,?,?,?)`,
        [
          job.id,
          job.workflowType,
          receipt.resourceId,
          receipt.versionId,
          job.fencingToken,
          JSON.stringify({
            resourceId: receipt.resourceId,
            versionId: receipt.versionId,
            ...(candidate
              ? {
                  grounding: {
                    contract_version: candidate.contract_version,
                    assignment_digest: candidate.digests.assignment_digest,
                    render_digest: candidate.digests.render_digest,
                    ledger_digest: candidate.digests.ledger_digest,
                    envelope_digest: candidate.digests.envelope_digest,
                  },
                }
              : {}),
          }),
        ],
      );
      return {
        resourceId: receipt.resourceId,
        versionId: receipt.versionId,
      };
    });
  }

  private async lockWorkflow(
    manager: EntityManager,
    jobId: string,
  ): Promise<LockedWorkflowRow> {
    const rows: unknown = await manager.query(
      `SELECT id,user_id,project_id,workflow_type,status,
              cancel_requested_at,lease_token,fencing_token,
              (lease_expires_at>CURRENT_TIMESTAMP(6)) AS lease_active
         FROM workflow_jobs
        WHERE id=?
        FOR UPDATE`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new WorkflowLeaseLostError();
    }
    return rows[0] as LockedWorkflowRow;
  }

  private async lockProposal(
    manager: EntityManager,
    jobId: string,
  ): Promise<ApprovedAuthoringProposalRow> {
    const rows: unknown = await manager.query(
      `SELECT id,job_id,project_id,user_id,artifact_kind,status,
              payload,payload_utf8_bytes,payload_sha256,
              (expires_at>CURRENT_TIMESTAMP(6)) AS expires_active,
              resource_id,resource_version
         FROM authoring_proposals
        WHERE job_id=?
          AND status IN ('APPROVED','COMMITTED')
        ORDER BY sequence DESC
        LIMIT 1
        FOR UPDATE`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_PROPOSAL_NOT_APPROVED');
    }
    return rows[0] as ApprovedAuthoringProposalRow;
  }

  private async findDomainCommit(
    manager: EntityManager,
    jobId: string,
  ): Promise<DomainCommitRow | null> {
    const rows: unknown = await manager.query(
      `SELECT workflow_type,resource_id,version_id,commit_payload
         FROM workflow_domain_commits
        WHERE workflow_job_id=?`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    return rows[0] as DomainCommitRow;
  }

  private assertWorkflowIdentity(
    row: LockedWorkflowRow,
    job: ClaimedWorkflowJob,
  ): void {
    if (
      row.id !== job.id ||
      row.user_id !== job.userId ||
      row.project_id !== job.projectId ||
      row.workflow_type !== job.workflowType
    ) {
      throw new WorkflowLeaseLostError();
    }
  }

  private assertProposalIdentity(
    row: ApprovedAuthoringProposalRow,
    job: ClaimedWorkflowJob,
  ): void {
    if (
      row.job_id !== job.id ||
      row.project_id !== job.projectId ||
      row.user_id !== job.userId ||
      row.artifact_kind !== expectedArtifactKind(job.workflowType)
    ) {
      throw new AuthoringCommitError('AUTHORING_PROPOSAL_NOT_APPROVED');
    }
  }

  private assertFence(row: LockedWorkflowRow, job: ClaimedWorkflowJob): void {
    if (row.cancel_requested_at !== null) {
      throw new WorkflowCancelledError();
    }
    if (
      row.status !== WorkflowStatus.RUNNING ||
      row.lease_token !== job.leaseToken ||
      Number(row.fencing_token) !== job.fencingToken ||
      Number(row.lease_active) !== 1
    ) {
      throw new WorkflowLeaseLostError();
    }
  }

  private assertApproved(row: ApprovedAuthoringProposalRow): void {
    if (row.status !== 'APPROVED') {
      throw new AuthoringCommitError('AUTHORING_PROPOSAL_NOT_APPROVED');
    }
    if (Number(row.expires_active) !== 1) {
      throw new AuthoringCommitError('AUTHORING_PROPOSAL_EXPIRED');
    }
  }

  private verifyPayload(row: ApprovedAuthoringProposalRow): Buffer {
    if (
      !Buffer.isBuffer(row.payload) ||
      row.payload.length === 0 ||
      Number(row.payload_utf8_bytes) !== row.payload.length
    ) {
      throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
    }
    const maximum =
      row.artifact_kind === 'body'
        ? MAX_BODY_PAYLOAD_BYTES
        : MAX_STRUCTURED_PAYLOAD_BYTES;
    if (row.payload.length > maximum) {
      throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
    }
    if (!/^[0-9a-f]{64}$/.test(row.payload_sha256)) {
      throw new AuthoringCommitError('AUTHORING_PAYLOAD_DIGEST_MISMATCH');
    }
    const digest = createHash('sha256').update(row.payload).digest('hex');
    if (digest !== row.payload_sha256) {
      throw new AuthoringCommitError('AUTHORING_PAYLOAD_DIGEST_MISMATCH');
    }
    return row.payload;
  }

  private verifyAtomicCandidate(
    job: ClaimedWorkflowJob,
    proposal: ApprovedAuthoringProposalRow,
    payload: Buffer,
  ): SealedGroundedCandidateV1 | null {
    const rawCandidate = job.checkpoint?.sealed_candidate;
    const required =
      job.workflowDefinition === 'deterministic-authoring.v1' &&
      proposal.artifact_kind === 'body';
    if (rawCandidate === undefined) {
      if (required) {
        throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
      }
      return null;
    }
    if (!required) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
    let workflow: SealedGroundedCandidateV1['workflow'];
    try {
      workflow = parseSealedGroundedCandidateWorkflowV1(rawCandidate);
    } catch {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
    const candidate = rawCandidate as SealedGroundedCandidateV1;
    if (
      workflow.workflow_job_id !== job.id ||
      workflow.project_id !== job.projectId ||
      workflow.workflow_type !== String(job.workflowType) ||
      candidate.server_output.utf8_byte_length !== payload.byteLength ||
      candidate.server_output.utf16_length !==
        candidate.server_output.text.length ||
      !Buffer.from(candidate.server_output.text, 'utf8').equals(payload)
    ) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
    return candidate;
  }

  private async assertAtomicAssignment(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    candidate: SealedGroundedCandidateV1,
  ): Promise<void> {
    const rows: unknown = await manager.query(
      `SELECT contract_version,snapshot_digest,targeted_revision_attempts
         FROM grounding_assignments
        WHERE workflow_job_id=?
          AND project_id=?
        FOR UPDATE`,
      [job.id, job.projectId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
    const assignment = rows[0] as Record<string, unknown>;
    const snapshotDigest = assignment.snapshot_digest;
    const revisionAttempt = Number(assignment.targeted_revision_attempts);
    const expectedAssignmentDigest =
      typeof snapshotDigest === 'string' &&
      /^[0-9a-f]{64}$/u.test(snapshotDigest)
        ? createHash('sha256')
            .update(`atomic:v1\0${snapshotDigest}`, 'utf8')
            .digest('hex')
        : '';
    if (
      assignment.contract_version !== 'atomic:v1' ||
      !Number.isSafeInteger(revisionAttempt) ||
      revisionAttempt !== candidate.workflow.revision_attempt ||
      expectedAssignmentDigest !== candidate.digests.assignment_digest
    ) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
  }

  private async persistAtomicLedger(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    resultId: string,
    candidate: SealedGroundedCandidateV1,
  ): Promise<void> {
    const evidence = new Map(
      candidate.evidence_snapshots.map((snapshot) => [
        snapshot.evidence_id,
        snapshot,
      ]),
    );
    if (evidence.size !== candidate.evidence_snapshots.length) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
    const referenced = new Set<string>();
    for (const claim of candidate.claims) {
      if (
        candidate.server_output.text.slice(
          claim.output_char_start_utf16,
          claim.output_char_end_utf16,
        ) !== claim.canonical_claim.rendered_claim_text
      ) {
        throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
      }
      await manager.query(
        `INSERT INTO grounding_claims
           (claim_id,workflow_job_id,project_id,result_id,claim_text,
            normalized_claim_text,output_char_start,output_char_end,
            support_status,support_score,verification_method,atomic_claim)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          claim.persisted_claim_id,
          job.id,
          job.projectId,
          resultId,
          claim.canonical_claim.rendered_claim_text,
          claim.canonical_claim.source_claim_text_nfc,
          claim.output_char_start_utf16,
          claim.output_char_end_utf16,
          claim.support_status,
          1,
          claim.verification_method,
          JSON.stringify({
            canonicalizer_version: candidate.canonicalizer_version,
            quantity_lexer_version: candidate.quantity_lexer_version,
            verifier_version: candidate.verifier_version,
            canonical_claim: claim.canonical_claim,
          }),
        ],
      );
      for (const reference of claim.evidence_refs) {
        const snapshot = evidence.get(reference.evidence_id);
        if (
          !snapshot ||
          snapshot.project_id !== job.projectId ||
          snapshot.evidence_snapshot_digest !==
            reference.evidence_snapshot_digest
        ) {
          throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
        }
        referenced.add(snapshot.evidence_id);
        await manager.query(
          `INSERT INTO citation_maps
             (id,project_id,result_id,paragraph_key,chunk_id,file_id,
              use_type,evidence_text,page_number,section_title,
              confidence_score,claim_id,evidence_id,document_id,
              retrieval_run_id,support_status,support_score,
              verification_method,evidence_char_start,evidence_char_end,
              chunk_char_start,chunk_char_end,candidate_rank,
              \`sparse_rank\`,\`dense_rank\`,\`fusion_rank\`,\`rerank_rank\`,
              sparse_score,dense_score,fusion_score,rerank_score,
              ingestion_key,index_snapshot,snapshot_digest)
           VALUES (?,?,?,?,?,?,'synthesize',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                   ?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(),
            job.projectId,
            resultId,
            `claim:${claim.persisted_claim_id.slice(0, 24)}`,
            snapshot.chunk_id,
            snapshot.file_id,
            snapshot.exact_span_text_nfc,
            null,
            null,
            1,
            claim.persisted_claim_id,
            snapshot.evidence_id,
            snapshot.document_id,
            snapshot.retrieval_run_id,
            claim.support_status,
            1,
            claim.verification_method,
            snapshot.exact_span_document_start,
            snapshot.exact_span_document_end,
            null,
            null,
            snapshot.candidate_rank,
            snapshot.ranks.sparse,
            snapshot.ranks.dense,
            snapshot.ranks.fusion,
            snapshot.ranks.rerank,
            snapshot.scores.sparse,
            snapshot.scores.dense,
            snapshot.scores.fusion,
            snapshot.scores.rerank,
            snapshot.ingestion_key,
            JSON.stringify(snapshot.index_snapshot),
            snapshot.evidence_snapshot_digest,
          ],
        );
      }
    }
    if (referenced.size !== evidence.size) {
      throw new AuthoringCommitError('AUTHORING_GROUNDING_INVALID');
    }
  }

  private commitArtifact(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    proposal: ApprovedAuthoringProposalRow,
    payload: Buffer,
  ): Promise<CreatedAuthoringResource> {
    switch (proposal.artifact_kind) {
      case 'directory':
        return this.commitDirectory(manager, job, payload);
      case 'outline':
        return this.commitOutline(manager, job, payload);
      case 'body':
        return this.commitBody(manager, job, payload);
    }
  }

  private async commitDirectory(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    payload: Buffer,
  ): Promise<CreatedAuthoringResource> {
    const nodes = parseJsonPayload(payload, 'array');
    if (nodes.length === 0) {
      throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
    }
    const stateRows: unknown = await manager.query(
      `SELECT id,current_directory_version_id
         FROM project_states
        WHERE project_id=?
        FOR UPDATE`,
      [job.projectId],
    );
    if (!Array.isArray(stateRows) || stateRows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
    }

    await manager.query(
      `UPDATE directory_versions
          SET is_current=0
        WHERE project_id=? AND is_current=1`,
      [job.projectId],
    );
    const versionNumber = await this.nextVersion(
      manager,
      'directory_versions',
      'project_id=?',
      [job.projectId],
    );
    const versionId = randomUUID();
    await manager.query(
      `INSERT INTO directory_versions
         (id,project_id,version_number,content,is_current)
       VALUES (?,?,?,?,1)`,
      [versionId, job.projectId, versionNumber, JSON.stringify(nodes)],
    );
    const stateUpdate: unknown = await manager.query(
      `UPDATE project_states
          SET current_directory_version_id=?,updated_at=CURRENT_TIMESTAMP
        WHERE project_id=?`,
      [versionId, job.projectId],
    );
    if (affectedRows(stateUpdate) !== 1) {
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
    }
    return { resourceId: versionId, versionId, resourceVersion: versionNumber };
  }

  private async commitOutline(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    payload: Buffer,
  ): Promise<CreatedAuthoringResource> {
    const content = parseJsonPayload(payload, 'object');
    const input = requireInput(job);
    const chapterNodeId = requireString(input, 'chapter_node_id');
    const sectionNodeId = optionalString(input, 'section_node_id');
    const chapterTitle =
      optionalString(input, 'chapter_title') ?? chapterNodeId;

    await manager.query(
      `SELECT id,version_number
         FROM outline_versions
        WHERE project_id=?
          AND chapter_node_id=?
          AND scope_section_node_id=?
        ORDER BY version_number
        FOR UPDATE`,
      [job.projectId, chapterNodeId, sectionNodeId ?? ''],
    );
    await manager.query(
      `UPDATE outline_versions
          SET is_current=0
        WHERE project_id=?
          AND chapter_node_id=?
          AND scope_section_node_id=?
          AND is_current=1`,
      [job.projectId, chapterNodeId, sectionNodeId ?? ''],
    );
    const versionNumber = await this.nextVersion(
      manager,
      'outline_versions',
      `project_id=? AND chapter_node_id=? AND scope_section_node_id=?`,
      [job.projectId, chapterNodeId, sectionNodeId ?? ''],
    );
    const chapterIndex = await this.findChapterIndex(
      manager,
      job.projectId,
      chapterNodeId,
    );
    const versionId = randomUUID();
    await manager.query(
      `INSERT INTO outline_versions
         (id,project_id,chapter_node_id,section_node_id,chapter_index,
          chapter_title,version_number,content,is_current)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      [
        versionId,
        job.projectId,
        chapterNodeId,
        sectionNodeId,
        chapterIndex,
        chapterTitle,
        versionNumber,
        JSON.stringify(content),
      ],
    );
    return { resourceId: versionId, versionId, resourceVersion: versionNumber };
  }

  private async commitBody(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    payload: Buffer,
  ): Promise<CreatedAuthoringResource> {
    const text = decodeExactUtf8(payload);
    const scope = await this.resolveWritingScope(manager, job);
    const resourceId = randomUUID();
    const versionId = randomUUID();
    await manager.query(
      `INSERT INTO writing_results
         (id,project_id,session_id,chapter_node_id,section_node_id,
          chapter_index,chapter_title,section_title,task_type,status,
          content_text,word_count,style,version_number,parent_result_id,
          completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,CURRENT_TIMESTAMP)`,
      [
        resourceId,
        job.projectId,
        scope.sessionId,
        scope.chapterNodeId,
        scope.sectionNodeId,
        scope.chapterIndex,
        scope.chapterTitle,
        scope.sectionTitle,
        taskType(job.workflowType),
        WritingResultStatus.SUCCEEDED,
        text,
        Array.from(text).length,
        scope.style,
        scope.parentResultId,
      ],
    );
    await manager.query(
      `INSERT INTO content_versions
         (id,result_id,version_number,editor_source,content_text,is_current)
       VALUES (?,?,1,'ai',?,1)`,
      [versionId, resourceId, text],
    );
    return { resourceId, versionId, resourceVersion: 1 };
  }

  private async resolveWritingScope(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
  ): Promise<WritingScope> {
    const input = requireInput(job);
    if (job.workflowType === WorkflowType.CONTENT) {
      return {
        sessionId: optionalString(input, 'session_id'),
        chapterNodeId: optionalString(input, 'chapter_node_id'),
        sectionNodeId: optionalString(input, 'section_node_id'),
        chapterIndex: optionalNonNegativeInteger(input, 'chapter_index'),
        chapterTitle: optionalString(input, 'chapter_title'),
        sectionTitle: optionalString(input, 'section_title'),
        style: optionalString(input, 'style'),
        parentResultId: null,
      };
    }

    const parentResultId = requireString(input, 'result_id');
    const rows: unknown = await manager.query(
      `SELECT wr.session_id,wr.chapter_node_id,wr.section_node_id,
              wr.chapter_index,wr.chapter_title,wr.section_title,wr.style
         FROM writing_results wr
         JOIN workflow_domain_commits dc ON dc.resource_id=wr.id
         JOIN authoring_proposals ap
           ON ap.job_id=dc.workflow_job_id
          AND ap.status='COMMITTED'
        WHERE wr.id=?
          AND wr.project_id=?
          AND wr.status=?
        FOR UPDATE`,
      [parentResultId, job.projectId, WritingResultStatus.SUCCEEDED],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_PARENT_NOT_APPROVED');
    }
    const row = rows[0] as Record<string, unknown>;
    return {
      sessionId: rowString(row.session_id),
      chapterNodeId: rowString(row.chapter_node_id),
      sectionNodeId: rowString(row.section_node_id),
      chapterIndex: rowInteger(row.chapter_index),
      chapterTitle: rowString(row.chapter_title),
      sectionTitle: rowString(row.section_title),
      style: rowString(row.style),
      parentResultId,
    };
  }

  private async nextVersion(
    manager: EntityManager,
    table: 'directory_versions' | 'outline_versions',
    where: string,
    parameters: unknown[],
  ): Promise<number> {
    const rows: unknown = await manager.query(
      `SELECT COALESCE(MAX(version_number),0) AS max_version
         FROM ${table}
        WHERE ${where}`,
      parameters,
    );
    const current =
      Array.isArray(rows) && rows.length === 1
        ? Number((rows[0] as Record<string, unknown>).max_version)
        : Number.NaN;
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
    }
    const next = current + 1;
    if (!Number.isSafeInteger(next) || next > 2_147_483_647) {
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
    }
    return next;
  }

  private async findChapterIndex(
    manager: EntityManager,
    projectId: string,
    chapterNodeId: string,
  ): Promise<number> {
    const rows: unknown = await manager.query(
      `SELECT content
         FROM directory_versions
        WHERE project_id=? AND is_current=1`,
      [projectId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) return 0;
    const raw = (rows[0] as Record<string, unknown>).content;
    const nodes = typeof raw === 'string' ? safeJsonParse(raw) : raw;
    if (!Array.isArray(nodes)) return 0;
    const chapters = nodes.filter(
      (node): node is Record<string, unknown> =>
        isPlainObject(node) && node.parent_node_id === null,
    );
    return Math.max(
      0,
      chapters.findIndex((node) => node.node_id === chapterNodeId),
    );
  }

  private recoverReceipt(
    row: DomainCommitRow,
    proposal: ApprovedAuthoringProposalRow,
    job: ClaimedWorkflowJob,
  ): AuthoringCommitReceipt {
    if (
      row.workflow_type !== job.workflowType ||
      !row.resource_id ||
      !row.version_id
    ) {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    const payload = parseReceipt(row.commit_payload);
    if (
      payload.resourceId !== row.resource_id ||
      payload.versionId !== row.version_id ||
      (proposal.resource_id !== null &&
        proposal.resource_id !== row.resource_id)
    ) {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    return payload;
  }

  private async recoverProposalReceipt(
    manager: EntityManager,
    proposal: ApprovedAuthoringProposalRow,
  ): Promise<AuthoringCommitReceipt> {
    const resourceVersion = Number(proposal.resource_version);
    if (
      !proposal.resource_id ||
      !Number.isSafeInteger(resourceVersion) ||
      resourceVersion < 1
    ) {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    if (
      proposal.artifact_kind === 'directory' ||
      proposal.artifact_kind === 'outline'
    ) {
      return {
        resourceId: proposal.resource_id,
        versionId: proposal.resource_id,
      };
    }
    const rows: unknown = await manager.query(
      `SELECT id
         FROM content_versions
        WHERE result_id=?
          AND version_number=?
          AND is_current=1`,
      [proposal.resource_id, resourceVersion],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    const versionId = (rows[0] as Record<string, unknown>).id;
    if (typeof versionId !== 'string' || versionId === '') {
      throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
    }
    return {
      resourceId: proposal.resource_id,
      versionId,
    };
  }
}

function expectedArtifactKind(
  workflowType: WorkflowType,
): ApprovedAuthoringProposalRow['artifact_kind'] {
  switch (workflowType) {
    case WorkflowType.DIRECTORY:
      return 'directory';
    case WorkflowType.OUTLINE:
      return 'outline';
    case WorkflowType.CONTENT:
    case WorkflowType.REWRITE:
    case WorkflowType.EXPAND:
    case WorkflowType.COMPRESS:
      return 'body';
    default:
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  }
}

function taskType(workflowType: WorkflowType): TaskType {
  switch (workflowType) {
    case WorkflowType.CONTENT:
      return TaskType.GENERATE;
    case WorkflowType.REWRITE:
      return TaskType.REWRITE;
    case WorkflowType.EXPAND:
      return TaskType.EXPAND;
    case WorkflowType.COMPRESS:
      return TaskType.COMPRESS;
    default:
      throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  }
}

function parseJsonPayload(payload: Buffer, root: 'array'): unknown[];
function parseJsonPayload(
  payload: Buffer,
  root: 'object',
): Record<string, unknown>;
function parseJsonPayload(
  payload: Buffer,
  root: 'array' | 'object',
): unknown[] | Record<string, unknown> {
  const value = safeJsonParse(decodeExactUtf8(payload));
  if (
    (root === 'array' && !Array.isArray(value)) ||
    (root === 'object' && !isPlainObject(value)) ||
    !isSafeJsonValue(value)
  ) {
    throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
  }
  return value as unknown[] | Record<string, unknown>;
}

function decodeExactUtf8(payload: Buffer): string {
  const text = payload.toString('utf8');
  if (
    text.length === 0 ||
    !Buffer.from(text, 'utf8').equals(payload) ||
    text.includes('\u0000')
  ) {
    throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
  }
  return text;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AuthoringCommitError('AUTHORING_PAYLOAD_INVALID');
  }
}

function isSafeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((item) => isSafeJsonValue(item, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key !== '__proto__' &&
      key !== 'constructor' &&
      key !== 'prototype' &&
      isSafeJsonValue(item, depth + 1),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function requireInput(job: ClaimedWorkflowJob): Record<string, unknown> {
  if (!isPlainObject(job.input)) {
    throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  }
  return job.input;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function optionalNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
): number | null {
  const value = input[key];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  }
  return Number(value);
}

function rowString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function rowInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AuthoringCommitError('AUTHORING_SCOPE_INVALID');
  }
  return number;
}

function parseReceipt(
  raw: Record<string, unknown> | string | null,
): AuthoringCommitReceipt {
  let value: unknown = raw;
  if (typeof raw === 'string') value = safeJsonParse(raw);
  if (!isPlainObject(value)) {
    throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
  }
  if (
    typeof value.resourceId !== 'string' ||
    value.resourceId === '' ||
    typeof value.versionId !== 'string' ||
    value.versionId === ''
  ) {
    throw new AuthoringCommitError('AUTHORING_COMMIT_RECEIPT_MISMATCH');
  }
  return {
    resourceId: value.resourceId,
    versionId: value.versionId,
  };
}

function affectedRows(result: unknown): number {
  return typeof result === 'object' &&
    result !== null &&
    'affectedRows' in result
    ? Number((result as { affectedRows: unknown }).affectedRows)
    : 0;
}
