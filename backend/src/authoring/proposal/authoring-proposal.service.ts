import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { DataSource, type EntityManager } from 'typeorm';
import type { ClaimedWorkflowJob } from '../../workflow/workflow.engine.js';
import { WorkflowStatus } from '../../workflow/workflow.types.js';
import {
  type AuthoringArtifactKind,
  AuthoringProposal,
} from './authoring-proposal.entity.js';

const MAX_STRUCTURED_PAYLOAD_BYTES = 1_048_576;
const MAX_BODY_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface StoreAuthoringProposalInput {
  artifactKind: AuthoringArtifactKind;
  schemaVersion: string;
  payload: Buffer;
  expiresAt: Date;
}

export interface PublicAuthoringProposal {
  id: string;
  job_id: string;
  sequence: string;
  artifact_kind: AuthoringArtifactKind;
  schema_version: string;
  status: 'ACTIVE' | 'APPROVED';
  payload: unknown;
  payload_sha256: string;
  payload_utf8_bytes: string;
  expires_at: Date;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class AuthoringProposalService {
  constructor(private readonly dataSource: DataSource) {}

  async store(
    job: ClaimedWorkflowJob,
    input: StoreAuthoringProposalInput,
  ): Promise<AuthoringProposal> {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.schemaVersion) ||
      !['directory', 'outline', 'body'].includes(input.artifactKind) ||
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new Error('AUTHORING_PROPOSAL_INVALID');
    }
    const payload = sealedUtf8Payload(input.payload, input.artifactKind);
    const digest = createHash('sha256').update(payload).digest('hex');
    return this.dataSource.transaction(async (manager) => {
      await assertWorkerFence(manager, job);
      const active = await selectActive(manager, job.id);
      if (active) {
        if (
          active.payload_sha256 === digest &&
          active.artifact_kind === input.artifactKind &&
          active.schema_version === input.schemaVersion
        ) {
          return active;
        }
        throw new ConflictException('任务已有待处理提案');
      }
      const sequenceRows: unknown = await manager.query(
        `SELECT COALESCE(MAX(sequence),0) AS maxSequence
           FROM authoring_proposals
          WHERE job_id=?
          FOR UPDATE`,
        [job.id],
      );
      const maxSequence =
        Array.isArray(sequenceRows) && sequenceRows.length === 1
          ? BigInt(
              decimal(
                (sequenceRows[0] as { maxSequence?: unknown }).maxSequence,
              ),
            )
          : 0n;
      const id = randomUUID();
      await manager.query(
        `INSERT INTO authoring_proposals
          (id,job_id,project_id,user_id,sequence,artifact_kind,
           schema_version,status,payload,payload_sha256,payload_utf8_bytes,
           expires_at)
         VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)`,
        [
          id,
          job.id,
          job.projectId,
          job.userId,
          String(maxSequence + 1n),
          input.artifactKind,
          input.schemaVersion,
          payload,
          digest,
          String(payload.byteLength),
          input.expiresAt,
        ],
      );
      const stored = await selectById(manager, id);
      if (!stored) throw new Error('AUTHORING_PROPOSAL_STORE_FAILED');
      return stored;
    });
  }

  async findActive(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<AuthoringProposal> {
    const rows: unknown = await this.dataSource.query(
      `${activeProposalSelect()}
        WHERE p.job_id=? AND p.project_id=? AND p.user_id=?
          AND p.status IN ('ACTIVE','APPROVED')
          AND (p.status='APPROVED' OR p.expires_at>CURRENT_TIMESTAMP(6))
        ORDER BY p.sequence DESC
        LIMIT 1`,
      [jobId, projectId, userId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new NotFoundException('当前没有可批准的提案');
    }
    return rows[0] as AuthoringProposal;
  }

  async approve(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<AuthoringProposal> {
    return this.dataSource.transaction(async (manager) => {
      const rows: unknown = await manager.query(
        `${activeProposalSelect()}
          WHERE p.job_id=? AND p.project_id=? AND p.user_id=?
            AND p.status IN ('ACTIVE','APPROVED')
          ORDER BY p.sequence DESC
          LIMIT 1
          FOR UPDATE`,
        [jobId, projectId, userId],
      );
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new NotFoundException('当前没有可批准的提案');
      }
      const proposal = rows[0] as AuthoringProposal;
      if (proposal.status === 'APPROVED') return proposal;
      if (new Date(proposal.expires_at).getTime() <= Date.now()) {
        throw new ConflictException('提案已过期');
      }
      const proposalUpdate: unknown = await manager.query(
        `UPDATE authoring_proposals
            SET status='APPROVED',
                approved_at=CURRENT_TIMESTAMP(6),
                updated_at=CURRENT_TIMESTAMP(6)
          WHERE id=? AND job_id=? AND status='ACTIVE'
            AND expires_at>CURRENT_TIMESTAMP(6)`,
        [proposal.id, jobId],
      );
      if (affectedRows(proposalUpdate) !== 1) {
        throw new ConflictException('提案批准竞争失败');
      }
      const jobUpdate: unknown = await manager.query(
        `UPDATE workflow_jobs
            SET status=?,
                approved_at=CURRENT_TIMESTAMP(6),
                lease_owner=NULL,
                lease_token=NULL,
                lease_expires_at=NULL,
                updated_at=CURRENT_TIMESTAMP(6)
          WHERE id=? AND project_id=? AND user_id=? AND status=?`,
        [
          WorkflowStatus.QUEUED,
          jobId,
          projectId,
          userId,
          WorkflowStatus.WAITING_APPROVAL,
        ],
      );
      if (affectedRows(jobUpdate) !== 1) {
        throw new ConflictException('任务当前不等待人工批准');
      }
      const approved = await selectById(manager, proposal.id);
      if (!approved) throw new Error('AUTHORING_PROPOSAL_APPROVAL_LOST');
      return approved;
    });
  }

  toPublic(proposal: AuthoringProposal): PublicAuthoringProposal {
    if (proposal.status !== 'ACTIVE' && proposal.status !== 'APPROVED') {
      throw new Error('AUTHORING_PROPOSAL_NOT_PUBLIC');
    }
    const payloadText = decodeFatalUtf8(proposal.payload);
    return {
      id: proposal.id,
      job_id: proposal.job_id,
      sequence: String(proposal.sequence),
      artifact_kind: proposal.artifact_kind,
      schema_version: proposal.schema_version,
      status: proposal.status,
      payload:
        proposal.artifact_kind === 'body'
          ? payloadText
          : parseStructuredPayload(payloadText),
      payload_sha256: proposal.payload_sha256,
      payload_utf8_bytes: String(proposal.payload_utf8_bytes),
      expires_at: proposal.expires_at,
      approved_at: proposal.approved_at,
      created_at: proposal.created_at,
      updated_at: proposal.updated_at,
    };
  }
}

async function assertWorkerFence(
  manager: EntityManager,
  job: ClaimedWorkflowJob,
): Promise<void> {
  const rows: unknown = await manager.query(
    `SELECT id
       FROM workflow_jobs
      WHERE id=? AND project_id=? AND user_id=? AND status=?
        AND cancel_requested_at IS NULL
        AND lease_token=? AND fencing_token=?
        AND lease_expires_at>CURRENT_TIMESTAMP(6)
      FOR UPDATE`,
    [
      job.id,
      job.projectId,
      job.userId,
      WorkflowStatus.RUNNING,
      job.leaseToken,
      job.fencingToken,
    ],
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('AUTHORING_PROPOSAL_FENCE_LOST');
  }
}

async function selectActive(
  manager: EntityManager,
  jobId: string,
): Promise<AuthoringProposal | null> {
  const rows: unknown = await manager.query(
    `${activeProposalSelect()}
      WHERE p.job_id=? AND p.status IN ('ACTIVE','APPROVED')
      ORDER BY p.sequence DESC
      LIMIT 1
      FOR UPDATE`,
    [jobId],
  );
  return Array.isArray(rows) && rows.length === 1
    ? (rows[0] as AuthoringProposal)
    : null;
}

async function selectById(
  manager: EntityManager,
  id: string,
): Promise<AuthoringProposal | null> {
  const rows: unknown = await manager.query(
    `${activeProposalSelect()} WHERE p.id=?`,
    [id],
  );
  return Array.isArray(rows) && rows.length === 1
    ? (rows[0] as AuthoringProposal)
    : null;
}

function activeProposalSelect(): string {
  return `SELECT p.*
            FROM authoring_proposals p
            JOIN workflow_jobs w
              ON w.id=p.job_id
             AND w.project_id=p.project_id
             AND w.user_id=p.user_id`;
}

function sealedUtf8Payload(
  value: Buffer,
  artifactKind: AuthoringArtifactKind,
): Buffer {
  if (!Buffer.isBuffer(value) || value.byteLength === 0) {
    throw new Error('AUTHORING_PROPOSAL_INVALID');
  }
  const maximum =
    artifactKind === 'body'
      ? MAX_BODY_PAYLOAD_BYTES
      : MAX_STRUCTURED_PAYLOAD_BYTES;
  if (value.byteLength > maximum) {
    throw new Error('AUTHORING_PROPOSAL_INVALID');
  }
  try {
    const text = decodeFatalUtf8(value);
    if (artifactKind === 'body') {
      if (text.length === 0 || text.includes('\u0000')) {
        throw new Error('AUTHORING_PROPOSAL_INVALID');
      }
    } else {
      parseStructuredPayload(text);
    }
  } catch {
    throw new Error('AUTHORING_PROPOSAL_INVALID');
  }
  return Buffer.from(value);
}

function decodeFatalUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    value,
  );
}

function parseStructuredPayload(
  text: string,
): unknown[] | Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (
    (!Array.isArray(parsed) && !isPlainObject(parsed)) ||
    !isSafeJsonValue(parsed)
  ) {
    throw new Error('AUTHORING_PROPOSAL_INVALID');
  }
  return parsed as unknown[] | Record<string, unknown>;
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

function affectedRows(result: unknown): number {
  return result !== null &&
    typeof result === 'object' &&
    'affectedRows' in result
    ? Number((result as { affectedRows: unknown }).affectedRows)
    : 0;
}

function decimal(value: unknown): string {
  if (
    (typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint') ||
    !/^(?:0|[1-9][0-9]*)$/.test(String(value))
  ) {
    throw new Error('AUTHORING_PROPOSAL_SEQUENCE_INVALID');
  }
  return String(value);
}
