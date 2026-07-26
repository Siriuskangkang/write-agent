import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DataSource, EntityManager } from 'typeorm';
import {
  type ClaimedWorkflowJob,
  WorkflowCancelledError,
  type WorkflowControlState,
  type WorkflowExecutionStore,
  type WorkflowSuspensionReason,
  WorkflowLeaseLostError,
} from './workflow.engine.js';
import { WorkflowEvent } from './entities/workflow-event.entity.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';
import {
  GroundingRevisionRequiredError,
  MaterialGapError,
} from '../citation/material-gap.error.js';
import { type AtomicFailureDisposition } from '../citation/atomic-grounding/contracts.js';
import {
  AtomicGroundingExecutionFailure,
  dispositionForAtomicFailure,
} from '../citation/atomic-grounding/failure-policy.js';
import {
  restoreAuthoringPolicySelection,
  type AuthoringMode,
  type AuthoringPolicySnapshotV1,
  type ServerEntrypoint,
  type WorkflowDefinition,
} from '../authoring/rollout/authoring-rollout.js';

interface LockedJobRow {
  id: string;
  user_id: string;
  project_id: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  input: Record<string, unknown> | string | null;
  checkpoint: Record<string, unknown> | string | null;
  cancel_requested_at: Date | string | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  fencing_token: number | string;
  generation_attempt: number | string;
  lease_active: number | string;
  workflow_definition: WorkflowDefinition;
  authoring_mode: AuthoringMode;
  rollout_policy_version: string;
  rollout_policy_snapshot: Record<string, unknown> | string;
  rollout_policy_digest: string;
  server_entrypoint: ServerEntrypoint;
  client_contract_version: 'authoring-approval-ui.v1' | null;
}

@Injectable()
export class MysqlWorkflowExecutionStore implements WorkflowExecutionStore {
  private readonly leaseMilliseconds = 30_000;

  constructor(private readonly dataSource: DataSource) {}

  async claim(
    jobId: string,
    workerId: string,
  ): Promise<ClaimedWorkflowJob | null> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, jobId);
      if (
        row.cancel_requested_at !== null ||
        isTerminalStatus(row.status) ||
        (row.status === WorkflowStatus.RUNNING &&
          Number(row.lease_active) === 1)
      ) {
        return null;
      }
      if (
        row.status !== WorkflowStatus.QUEUED &&
        row.status !== WorkflowStatus.REVISION_REQUIRED &&
        row.status !== WorkflowStatus.RUNNING
      ) {
        return null;
      }

      const leaseToken = randomUUID();
      const fencingToken = Number(row.fencing_token) + 1;
      const snapshot = parseJsonObject(row.rollout_policy_snapshot);
      if (!snapshot) throw new Error('AUTHORING_POLICY_SNAPSHOT_INVALID');
      const authoringPolicy = restoreAuthoringPolicySelection({
        workflowDefinition: row.workflow_definition,
        authoringMode: row.authoring_mode,
        rolloutPolicyVersion: row.rollout_policy_version,
        snapshot: snapshot as unknown as AuthoringPolicySnapshotV1,
        snapshotDigest: row.rollout_policy_digest,
        serverEntrypoint: row.server_entrypoint,
        clientContractVersion: row.client_contract_version,
      });
      const result: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET status = ?,
                started_at = COALESCE(started_at, CURRENT_TIMESTAMP(6)),
                lease_owner = ?,
                lease_token = ?,
                lease_expires_at =
                  DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? MICROSECOND),
                fencing_token = ?,
                attempt_count = attempt_count + 1,
                updated_at = CURRENT_TIMESTAMP(6)
          WHERE id = ?
            AND cancel_requested_at IS NULL
            AND status IN (?, ?, ?)`,
        [
          WorkflowStatus.RUNNING,
          workerId,
          leaseToken,
          this.leaseMilliseconds * 1000,
          fencingToken,
          jobId,
          WorkflowStatus.QUEUED,
          WorkflowStatus.REVISION_REQUIRED,
          WorkflowStatus.RUNNING,
        ],
      );
      if (affectedRows(result) !== 1) return null;

      await this.appendEvent(
        manager,
        jobId,
        row.status === WorkflowStatus.RUNNING
          ? 'workflow.resumed'
          : 'workflow.started',
        {
          status: WorkflowStatus.RUNNING,
          attempt: fencingToken,
        },
      );
      return {
        id: row.id,
        userId: row.user_id,
        projectId: row.project_id,
        workflowType: row.workflow_type,
        input: parseJsonObject(row.input),
        checkpoint: parseJsonObject(row.checkpoint),
        leaseToken,
        fencingToken,
        generationAttempt: Number(row.generation_attempt),
        workflowDefinition: authoringPolicy.workflowDefinition,
        authoringMode: authoringPolicy.authoringMode,
        rolloutPolicyVersion: authoringPolicy.rolloutPolicyVersion,
        rolloutPolicySnapshot: authoringPolicy.snapshot,
        rolloutPolicyDigest: authoringPolicy.snapshotDigest,
        serverEntrypoint: authoringPolicy.serverEntrypoint,
        clientContractVersion: authoringPolicy.clientContractVersion,
      };
    });
  }

  async inspectControl(job: ClaimedWorkflowJob): Promise<WorkflowControlState> {
    const renewal: unknown = await this.dataSource.query(
      `UPDATE workflow_jobs
          SET lease_expires_at =
                DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? MICROSECOND),
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?
          AND status = ?
          AND cancel_requested_at IS NULL
          AND lease_token = ?
          AND fencing_token = ?
          AND lease_expires_at > CURRENT_TIMESTAMP(6)`,
      [
        this.leaseMilliseconds * 1000,
        job.id,
        WorkflowStatus.RUNNING,
        job.leaseToken,
        job.fencingToken,
      ],
    );
    if (affectedRows(renewal) === 1) return 'active';

    const rows: unknown = await this.dataSource.query(
      `SELECT status,
              cancel_requested_at AS cancelRequestedAt,
              lease_token AS leaseToken,
              fencing_token AS fencingToken,
              (lease_expires_at > CURRENT_TIMESTAMP(6)) AS leaseActive
         FROM workflow_jobs
        WHERE id = ?`,
      [job.id],
    );
    if (!Array.isArray(rows) || rows.length === 0) return 'lease_lost';
    const row = rows[0] as {
      status: WorkflowStatus;
      cancelRequestedAt: unknown;
      leaseToken: string | null;
      fencingToken: number | string;
      leaseActive: number | string;
    };
    if (
      row.status === WorkflowStatus.STOPPED ||
      row.cancelRequestedAt !== null
    ) {
      return 'cancelled';
    }
    if (
      row.status !== WorkflowStatus.RUNNING ||
      row.leaseToken !== job.leaseToken ||
      Number(row.fencingToken) !== job.fencingToken ||
      Number(row.leaseActive) !== 1
    ) {
      return 'lease_lost';
    }
    return 'active';
  }

  async persistProgress(
    job: ClaimedWorkflowJob,
    type: string,
    data: Record<string, unknown> | null,
    checkpoint: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, job.id);
      this.assertFence(row, job);
      if (checkpoint.phase === 'atomic_revision_required') {
        const reserved = await this.reserveAtomicRevision(
          manager,
          row,
          job,
          checkpoint,
        );
        if (!reserved) return;
      }
      const generationAttempt = readGenerationAttempt(
        checkpoint,
        Number(row.generation_attempt),
      );
      const result: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET checkpoint = ?,
                generation_attempt = ?,
                lease_expires_at =
                  DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? MICROSECOND),
                updated_at = CURRENT_TIMESTAMP(6)
          WHERE id = ?
            AND status = ?
            AND cancel_requested_at IS NULL
            AND lease_token = ?
            AND fencing_token = ?`,
        [
          JSON.stringify(checkpoint),
          generationAttempt,
          this.leaseMilliseconds * 1000,
          job.id,
          WorkflowStatus.RUNNING,
          job.leaseToken,
          job.fencingToken,
        ],
      );
      if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
      await this.appendEvent(manager, job.id, type, data);
    });
  }

  private async reserveAtomicRevision(
    manager: EntityManager,
    row: LockedJobRow,
    job: ClaimedWorkflowJob,
    checkpoint: Record<string, unknown>,
  ): Promise<boolean> {
    const reservation: unknown = await manager.query(
      `UPDATE grounding_assignments
          SET targeted_revision_attempts = 1,
              snapshot_digest = NULL,
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE workflow_job_id = ?
          AND project_id = ?
          AND targeted_revision_attempts = 0
          AND strict_mode = 1
          AND contract_version = 'atomic:v1'`,
      [job.id, job.projectId],
    );
    if (affectedRows(reservation) === 1) return true;

    const assignments: unknown = await manager.query(
      `SELECT targeted_revision_attempts, strict_mode, contract_version
         FROM grounding_assignments
        WHERE workflow_job_id = ?
          AND project_id = ?
        FOR UPDATE`,
      [job.id, job.projectId],
    );
    const assignment =
      Array.isArray(assignments) && assignments.length === 1
        ? (assignments[0] as Record<string, unknown>)
        : null;
    const persisted = parseJsonObject(row.checkpoint);
    if (
      assignment &&
      Number(assignment.targeted_revision_attempts) === 1 &&
      Number(assignment.strict_mode) === 1 &&
      assignment.contract_version === 'atomic:v1' &&
      isDeepStrictEqual(persisted, checkpoint)
    ) {
      return false;
    }
    throw new AtomicGroundingExecutionFailure(
      'REVISION_EXHAUSTED',
      1,
      readStringArray(checkpoint.candidate_claim_keys),
    );
  }

  async complete(job: ClaimedWorkflowJob): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, job.id);
      this.assertFence(row, job);
      const result: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET status = ?,
                completed_at = CURRENT_TIMESTAMP(6),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = CURRENT_TIMESTAMP(6)
          WHERE id = ?
            AND status = ?
            AND cancel_requested_at IS NULL
            AND lease_token = ?
            AND fencing_token = ?`,
        [
          WorkflowStatus.SUCCEEDED,
          job.id,
          WorkflowStatus.RUNNING,
          job.leaseToken,
          job.fencingToken,
        ],
      );
      if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
      await this.appendEvent(manager, job.id, 'workflow.succeeded', {
        status: WorkflowStatus.SUCCEEDED,
      });
    });
  }

  async suspend(
    job: ClaimedWorkflowJob,
    reason: WorkflowSuspensionReason,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, job.id);
      this.assertFence(row, job);
      const status =
        reason === 'WAITING_APPROVAL'
          ? WorkflowStatus.WAITING_APPROVAL
          : reason === 'WAITING_MATERIAL'
            ? WorkflowStatus.WAITING_MATERIAL
            : WorkflowStatus.SUCCEEDED;
      const result: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET status=?,
                completed_at=?,
                lease_owner=NULL,
                lease_token=NULL,
                lease_expires_at=NULL,
                updated_at=CURRENT_TIMESTAMP(6)
          WHERE id=? AND status=? AND cancel_requested_at IS NULL
            AND lease_token=? AND fencing_token=?`,
        [
          status,
          reason === 'SHADOW_COMPLETED' ? new Date() : null,
          job.id,
          WorkflowStatus.RUNNING,
          job.leaseToken,
          job.fencingToken,
        ],
      );
      if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
      const eventType =
        reason === 'WAITING_APPROVAL'
          ? 'workflow.waiting_approval'
          : reason === 'WAITING_MATERIAL'
            ? 'workflow.waiting_material'
            : 'workflow.shadow_completed';
      await this.appendEvent(manager, job.id, eventType, {
        status,
        suspension_reason: reason,
      });
    });
  }

  async fail(job: ClaimedWorkflowJob, error: unknown): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockJob(manager, job.id);
      this.assertFence(row, job);
      const atomicFailure = readAtomicExecutionFailure(error);
      if (atomicFailure) {
        await this.persistAtomicFailure(manager, row, job, atomicFailure);
        return;
      }
      if (error instanceof GroundingRevisionRequiredError) {
        await this.requireGroundingRevision(manager, row, job, error);
        return;
      }
      if (error instanceof MaterialGapError) {
        await this.pauseForGrounding(manager, job, error);
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Unknown workflow failure';
      const result: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET status = ?,
                error_code = ?,
                error_message = ?,
                public_error_code = ?,
                public_error_message = ?,
                completed_at = CURRENT_TIMESTAMP(6),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = CURRENT_TIMESTAMP(6)
          WHERE id = ?
            AND status = ?
            AND cancel_requested_at IS NULL
            AND lease_token = ?
            AND fencing_token = ?`,
        [
          WorkflowStatus.FAILED,
          'WORKFLOW_EXECUTION_FAILED',
          message.slice(0, 65_535),
          'WORKFLOW_FAILED',
          '任务执行失败，请稍后重试',
          job.id,
          WorkflowStatus.RUNNING,
          job.leaseToken,
          job.fencingToken,
        ],
      );
      if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
      await this.appendEvent(manager, job.id, 'error', {
        type: 'error',
        error_code: 'WORKFLOW_FAILED',
        message: '任务执行失败，请稍后重试',
      });
      await this.appendEvent(manager, job.id, 'workflow.failed', {
        status: WorkflowStatus.FAILED,
      });
    });
  }

  private async persistAtomicFailure(
    manager: EntityManager,
    row: LockedJobRow,
    job: ClaimedWorkflowJob,
    failure: AtomicExecutionFailure,
  ): Promise<void> {
    const { disposition, candidateClaimKeys } = failure;
    const status =
      disposition.transition === 'REVISION_REQUIRED'
        ? WorkflowStatus.REVISION_REQUIRED
        : disposition.transition === 'WAITING_MATERIAL'
          ? WorkflowStatus.WAITING_MATERIAL
          : WorkflowStatus.FAILED;
    const checkpoint = {
      ...(parseJsonObject(row.checkpoint) ?? {}),
      atomic_failure_reason: disposition.internal_reason,
      candidate_claim_keys: candidateClaimKeys,
    };
    const publicMessage =
      disposition.public_code === 'ATOMIC_GROUNDING_UNAVAILABLE'
        ? '可信引用功能当前不可用，请稍后重试'
        : disposition.transition === 'FAILED'
          ? '任务执行失败，请稍后重试'
          : disposition.transition === 'REVISION_REQUIRED'
            ? '正在执行一次定向证据修订'
            : '素材不足，请补充资料后继续';
    const result: unknown = await manager.query(
      `UPDATE workflow_jobs
          SET status = ?,
              error_code = ?,
              error_message = ?,
              public_error_code = ?,
              public_error_message = ?,
              checkpoint = ?,
              completed_at = ?,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?
          AND status = ?
          AND cancel_requested_at IS NULL
          AND lease_token = ?
          AND fencing_token = ?`,
      [
        status,
        disposition.internal_reason,
        disposition.internal_reason,
        disposition.public_code,
        publicMessage,
        JSON.stringify(checkpoint),
        status === WorkflowStatus.FAILED ? new Date() : null,
        job.id,
        WorkflowStatus.RUNNING,
        job.leaseToken,
        job.fencingToken,
      ],
    );
    if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();

    const eventType =
      disposition.transition === 'FAILED'
        ? 'error'
        : disposition.transition === 'REVISION_REQUIRED'
          ? 'grounding.revision_required'
          : 'grounding.material_gap';
    await this.appendEvent(manager, job.id, eventType, {
      type:
        disposition.transition === 'FAILED'
          ? 'error'
          : disposition.transition === 'REVISION_REQUIRED'
            ? 'revision_required'
            : 'material_gap',
      error_code: disposition.public_code,
      message: publicMessage,
      reason: disposition.internal_reason,
      candidate_claim_keys: candidateClaimKeys,
    });
    if (disposition.transition === 'WAITING_MATERIAL') {
      await this.appendEvent(manager, job.id, 'workflow.waiting_material', {
        status: WorkflowStatus.WAITING_MATERIAL,
      });
    } else if (disposition.transition === 'FAILED') {
      await this.appendEvent(manager, job.id, 'workflow.failed', {
        status: WorkflowStatus.FAILED,
      });
    }
  }

  private async requireGroundingRevision(
    manager: EntityManager,
    row: LockedJobRow,
    job: ClaimedWorkflowJob,
    error: GroundingRevisionRequiredError,
  ): Promise<void> {
    const increment: unknown = await manager.query(
      `UPDATE grounding_assignments
          SET targeted_revision_attempts = targeted_revision_attempts + 1,
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE workflow_job_id = ?
          AND project_id = ?
          AND targeted_revision_attempts = 0`,
      [job.id, job.projectId],
    );
    if (affectedRows(increment) !== 1) {
      await this.pauseForGrounding(
        manager,
        job,
        new MaterialGapError(
          '定向修订次数已用尽，请补充素材后继续',
          error.unsupportedClaimIds,
        ),
      );
      return;
    }
    const previous = parseJsonObject(row.checkpoint) ?? {};
    const checkpoint = {
      ...previous,
      phase: 'revision_required',
      revision_attempt: 1,
      unsupported_claims: error.unsupportedClaims,
    };
    const result: unknown = await manager.query(
      `UPDATE workflow_jobs
          SET status = ?,
              checkpoint = ?,
              error_code = 'GROUNDING_REVISION_REQUIRED',
              error_message = ?,
              public_error_code = 'GROUNDING_REVISION_REQUIRED',
              public_error_message = '正在执行一次定向证据修订',
              completed_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?
          AND status = ?
          AND cancel_requested_at IS NULL
          AND lease_token = ?
          AND fencing_token = ?`,
      [
        WorkflowStatus.REVISION_REQUIRED,
        JSON.stringify(checkpoint),
        error.message.slice(0, 65_535),
        job.id,
        WorkflowStatus.RUNNING,
        job.leaseToken,
        job.fencingToken,
      ],
    );
    if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
    await this.appendEvent(manager, job.id, 'grounding.revision_required', {
      type: 'revision_required',
      error_code: 'GROUNDING_REVISION_REQUIRED',
      message: '正在执行一次定向证据修订',
      unsupported_claim_ids: error.unsupportedClaimIds,
      revision_attempt: 1,
    });
  }

  private async pauseForGrounding(
    manager: EntityManager,
    job: ClaimedWorkflowJob,
    error: MaterialGapError,
  ): Promise<void> {
    const errorCode = 'MATERIAL_GAP';
    const publicMessage = '素材不足，请补充资料后继续';
    const result: unknown = await manager.query(
      `UPDATE workflow_jobs
          SET status = ?,
              error_code = ?,
              error_message = ?,
              public_error_code = ?,
              public_error_message = ?,
              completed_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP(6)
        WHERE id = ?
          AND status = ?
          AND cancel_requested_at IS NULL
          AND lease_token = ?
          AND fencing_token = ?`,
      [
        WorkflowStatus.WAITING_MATERIAL,
        errorCode,
        error.message.slice(0, 65_535),
        errorCode,
        publicMessage,
        job.id,
        WorkflowStatus.RUNNING,
        job.leaseToken,
        job.fencingToken,
      ],
    );
    if (affectedRows(result) !== 1) throw new WorkflowLeaseLostError();
    await this.appendEvent(manager, job.id, 'grounding.material_gap', {
      type: 'material_gap',
      error_code: errorCode,
      message: publicMessage,
      unsupported_claim_ids: error.unsupportedClaimIds,
    });
    await this.appendEvent(manager, job.id, 'workflow.waiting_material', {
      status: WorkflowStatus.WAITING_MATERIAL,
    });
  }

  private assertFence(row: LockedJobRow, job: ClaimedWorkflowJob): void {
    if (
      row.status === WorkflowStatus.STOPPED ||
      row.cancel_requested_at !== null
    ) {
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

  private async lockJob(
    manager: EntityManager,
    jobId: string,
  ): Promise<LockedJobRow> {
    const rows: unknown = await manager.query(
      `SELECT *,
              (lease_expires_at > CURRENT_TIMESTAMP(6)) AS lease_active
         FROM workflow_jobs
        WHERE id = ?
        FOR UPDATE`,
      [jobId],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NotFoundException('工作流任务不存在');
    }
    return rows[0] as LockedJobRow;
  }

  private async appendEvent(
    manager: EntityManager,
    jobId: string,
    type: string,
    data: Record<string, unknown> | null,
  ): Promise<void> {
    const rows: unknown = await manager.query(
      `SELECT COALESCE(MAX(seq), 0) AS maxSeq
         FROM workflow_events
        WHERE job_id = ?`,
      [jobId],
    );
    const maxSeq =
      Array.isArray(rows) && rows.length > 0
        ? Number((rows[0] as { maxSeq?: unknown }).maxSeq ?? 0)
        : 0;
    const repository = manager.getRepository(WorkflowEvent);
    await repository.save(
      repository.create({
        job_id: jobId,
        seq: maxSeq + 1,
        type,
        data,
      }),
    );
  }
}

function affectedRows(result: unknown): number {
  if (
    result !== null &&
    typeof result === 'object' &&
    'affectedRows' in result
  ) {
    return Number((result as { affectedRows: unknown }).affectedRows);
  }
  return 0;
}

function parseJsonObject(
  value: Record<string, unknown> | string | null,
): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  }
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalStatus(status: WorkflowStatus): boolean {
  return (
    status === WorkflowStatus.SUCCEEDED ||
    status === WorkflowStatus.FAILED ||
    status === WorkflowStatus.STOPPED
  );
}

function readGenerationAttempt(
  checkpoint: Record<string, unknown>,
  current: number,
): number {
  const raw = checkpoint.generation_attempt;
  if (raw === undefined) return current;
  const attempt = Number(raw);
  if (!Number.isSafeInteger(attempt) || attempt < current || attempt < 0) {
    throw new Error('Invalid workflow generation attempt');
  }
  return attempt;
}

interface AtomicExecutionFailure {
  disposition: AtomicFailureDisposition;
  candidateClaimKeys: string[];
}

function readAtomicExecutionFailure(
  error: unknown,
): AtomicExecutionFailure | null {
  if (!(error instanceof AtomicGroundingExecutionFailure)) return null;
  return {
    disposition: dispositionForAtomicFailure(
      error.reason,
      error.revisionAttempt,
    ),
    candidateClaimKeys: [...error.candidateClaimKeys],
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
