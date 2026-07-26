import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  MoreThan,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { ProjectAccessPolicy } from '../project/project-access.policy.js';
import { CreateWorkflowDto } from './dto/create-workflow.dto.js';
import { ListWorkflowEventsQueryDto } from './dto/list-workflow-events-query.dto.js';
import {
  type PublicWorkflowJobDto,
  toPublicWorkflowJob,
} from './dto/workflow-response.dto.js';
import { WorkflowEvent } from './entities/workflow-event.entity.js';
import { WorkflowJob } from './entities/workflow-job.entity.js';
import { assertWorkflowTransition, WorkflowStatus } from './workflow.types.js';
import {
  parseAuthoringRolloutConfig,
  selectAuthoringPolicy,
  type ServerEntrypoint,
} from '../authoring/rollout/authoring-rollout.js';
import { StorageReadinessService } from '../storage/storage-readiness.service.js';

export { assertWorkflowTransition } from './workflow.types.js';

export interface WorkflowEventEnvelope {
  id: string;
  job_id: string;
  seq: number;
  type: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

@Injectable()
export class WorkflowService {
  constructor(
    @InjectRepository(WorkflowJob)
    private readonly jobRepository: Repository<WorkflowJob>,
    @InjectRepository(WorkflowEvent)
    private readonly eventRepository: Repository<WorkflowEvent>,
    private readonly dataSource: DataSource,
    private readonly projectAccessPolicy: ProjectAccessPolicy,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly storageReadiness?: StorageReadinessService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    dto: CreateWorkflowDto,
    serverEntrypoint: ServerEntrypoint = 'workflow_api',
  ): Promise<WorkflowJob> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const explicitIdempotencyKey = dto.idempotency_key?.trim();
    if (
      dto.idempotency_key !== undefined &&
      explicitIdempotencyKey?.length === 0
    ) {
      throw new BadRequestException('幂等键不能为空');
    }
    const idempotencyKey = explicitIdempotencyKey ?? randomUUID();
    const requestHash = createWorkflowRequestHash(dto);
    const identity = {
      user_id: userId,
      project_id: projectId,
      workflow_type: dto.workflow_type,
      idempotency_key: idempotencyKey,
    };

    const existing = await this.jobRepository.findOne({ where: identity });
    if (existing) return this.assertSameRequest(existing, requestHash);

    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.lockOwnedProject(manager, projectId, userId);
        const jobs = manager.getRepository(WorkflowJob);
        const alreadyCreated = await jobs.findOne({ where: identity });
        if (alreadyCreated) {
          return this.assertSameRequest(alreadyCreated, requestHash);
        }
        const policy = selectAuthoringPolicy({
          projectId,
          serverEntrypoint,
          clientContractVersion: dto.client_contract_version,
          config: parseAuthoringRolloutConfig({
            AUTHORING_COMMIT_MODE: this.configService?.get(
              'AUTHORING_COMMIT_MODE',
            ),
            AUTHORING_ALLOWLIST_PROJECT_IDS: this.configService?.get(
              'AUTHORING_ALLOWLIST_PROJECT_IDS',
            ),
            AUTHORING_MODE: this.configService?.get('AUTHORING_MODE'),
            AUTHORING_ALLOWLIST: this.configService?.get('AUTHORING_ALLOWLIST'),
            AUTHORING_ROLLOUT_POLICY_VERSION: this.configService?.get(
              'AUTHORING_ROLLOUT_POLICY_VERSION',
            ),
          }),
        });
        if (policy.workflowDefinition === 'deterministic-authoring.v1') {
          if (!this.storageReadiness) {
            throw new Error('STORAGE_AUTHORITY_UNPROVEN');
          }
          await this.storageReadiness.assertReady();
        }

        const job = await jobs.save(
          jobs.create({
            ...identity,
            request_hash: requestHash,
            status: WorkflowStatus.QUEUED,
            input: dto.input ?? null,
            checkpoint: null,
            workflow_definition: policy.workflowDefinition,
            authoring_mode: policy.authoringMode,
            rollout_policy_version: policy.rolloutPolicyVersion,
            rollout_policy_snapshot: policy.snapshot,
            rollout_policy_digest: policy.snapshotDigest,
            server_entrypoint: policy.serverEntrypoint,
            client_contract_version: policy.clientContractVersion,
            cancel_requested_at: null,
            approved_at: null,
            error_code: null,
            error_message: null,
            public_error_code: null,
            public_error_message: null,
            started_at: null,
            completed_at: null,
          }),
        );
        await this.appendEventWithManager(
          manager,
          job.id,
          'workflow.created',
          { status: WorkflowStatus.QUEUED },
          false,
        );
        return job;
      });
    } catch (error) {
      if (!this.isIdempotencyDuplicate(error)) throw error;
      const duplicate = await this.jobRepository.findOne({ where: identity });
      if (!duplicate) throw error;
      return this.assertSameRequest(duplicate, requestHash);
    }
  }

  async findOne(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<WorkflowJob> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const job = await this.jobRepository.findOne({
      where: { id: jobId, project_id: projectId, user_id: userId },
    });
    if (!job) throw new NotFoundException('工作流任务不存在');
    return job;
  }

  async listEvents(
    userId: string,
    projectId: string,
    jobId: string,
    query: ListWorkflowEventsQueryDto,
    lastEventId?: string,
  ): Promise<WorkflowEventEnvelope[]> {
    await this.findOne(userId, projectId, jobId);
    let afterSeq = 0;
    if (lastEventId !== undefined && lastEventId !== '') {
      if (!isUUID(lastEventId)) {
        throw new BadRequestException('Last-Event-ID 格式无效');
      }
      const cursor = await this.eventRepository.findOne({
        where: { id: lastEventId, job_id: jobId },
      });
      if (!cursor) {
        throw new BadRequestException('Last-Event-ID 不属于当前任务');
      }
      afterSeq = cursor.seq;
    }
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    const rows = await this.eventRepository.find({
      where: {
        job_id: jobId,
        ...(afterSeq > 0 ? { seq: MoreThan(afterSeq) } : {}),
      },
      order: { seq: 'ASC' },
      take: limit,
    });
    return rows.map((event) => this.toEventEnvelope(event));
  }

  async cancel(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<WorkflowJob> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    return this.dataSource.transaction(async (manager) => {
      const job = await this.lockJob(manager, jobId, projectId, userId);
      if (job.status === WorkflowStatus.STOPPED) return job;
      if (
        job.status === WorkflowStatus.SUCCEEDED ||
        job.status === WorkflowStatus.FAILED
      ) {
        throw new ConflictException('终态任务不能取消');
      }

      assertWorkflowTransition(job.status, WorkflowStatus.STOPPED);
      const now = new Date();
      job.status = WorkflowStatus.STOPPED;
      job.cancel_requested_at = now;
      job.completed_at = now;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      const saved = await manager.getRepository(WorkflowJob).save(job);
      await this.appendEventWithManager(
        manager,
        job.id,
        'workflow.cancelled',
        { status: WorkflowStatus.STOPPED },
        false,
      );
      return saved;
    });
  }

  async resumeMaterial(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<WorkflowJob> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    return this.dataSource.transaction(async (manager) => {
      const job = await this.lockJob(manager, jobId, projectId, userId);
      if (job.status !== WorkflowStatus.WAITING_MATERIAL) {
        throw new ConflictException('任务当前不等待补充素材');
      }
      assertWorkflowTransition(job.status, WorkflowStatus.QUEUED);
      await manager.query(
        `DELETE FROM grounding_assignments
          WHERE workflow_job_id = ?
            AND project_id = ?`,
        [job.id, projectId],
      );
      job.status = WorkflowStatus.QUEUED;
      job.checkpoint = null;
      job.error_code = null;
      job.error_message = null;
      job.public_error_code = null;
      job.public_error_message = null;
      job.completed_at = null;
      job.lease_owner = null;
      job.lease_token = null;
      job.lease_expires_at = null;
      const saved = await manager.getRepository(WorkflowJob).save(job);
      await this.appendEventWithManager(
        manager,
        job.id,
        'workflow.material_resumed',
        { status: WorkflowStatus.QUEUED },
        false,
      );
      return saved;
    });
  }

  async cancelByLegacyResult(
    userId: string,
    projectId: string,
    resultId: string,
  ): Promise<boolean> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const rows: unknown = await this.dataSource.query(
      `SELECT id
         FROM workflow_jobs
        WHERE user_id = ?
          AND project_id = ?
          AND status IN (?, ?, ?, ?)
          AND workflow_type IN (?, ?, ?, ?, ?, ?)
          AND (
            id = ?
            OR JSON_UNQUOTE(JSON_EXTRACT(checkpoint, '$.result_id')) = ?
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [
        userId,
        projectId,
        WorkflowStatus.QUEUED,
        WorkflowStatus.RUNNING,
        WorkflowStatus.REVISION_REQUIRED,
        WorkflowStatus.WAITING_MATERIAL,
        'directory',
        'outline',
        'content',
        'rewrite',
        'expand',
        'compress',
        resultId,
        resultId,
      ],
    );
    if (
      !Array.isArray(rows) ||
      rows.length === 0 ||
      typeof (rows[0] as { id?: unknown }).id !== 'string'
    ) {
      return false;
    }
    await this.cancel(userId, projectId, (rows[0] as { id: string }).id);
    return true;
  }

  /**
   * Trusted worker boundary. HTTP callers use the ownership-scoped methods.
   */
  async transition(
    jobId: string,
    next: WorkflowStatus,
    eventType: string,
    data: Record<string, unknown> | null = null,
  ): Promise<WorkflowJob> {
    return this.dataSource.transaction(async (manager) => {
      const job = await this.lockJob(manager, jobId);
      assertWorkflowTransition(job.status, next);
      const now = new Date();
      job.status = next;
      if (next === WorkflowStatus.RUNNING && job.started_at === null) {
        job.started_at = now;
      }
      if (
        next === WorkflowStatus.SUCCEEDED ||
        next === WorkflowStatus.FAILED ||
        next === WorkflowStatus.STOPPED
      ) {
        job.completed_at = now;
      }
      const saved = await manager.getRepository(WorkflowJob).save(job);
      await this.appendEventWithManager(
        manager,
        job.id,
        eventType,
        data,
        false,
      );
      return saved;
    });
  }

  async appendEvent(
    jobId: string,
    type: string,
    data: Record<string, unknown> | null = null,
  ): Promise<WorkflowEventEnvelope> {
    const event = await this.dataSource.transaction((manager) =>
      this.appendEventWithManager(manager, jobId, type, data, true),
    );
    return this.toEventEnvelope(event);
  }

  toEventEnvelope(event: WorkflowEvent): WorkflowEventEnvelope {
    return {
      id: event.id,
      job_id: event.job_id,
      seq: event.seq,
      type: event.type,
      data: event.data,
      created_at: event.created_at,
    };
  }

  toPublicJob(job: WorkflowJob): PublicWorkflowJobDto {
    return toPublicWorkflowJob(job);
  }

  private async lockJob(
    manager: EntityManager,
    jobId: string,
    projectId?: string,
    userId?: string,
  ): Promise<WorkflowJob> {
    const scoped = projectId !== undefined && userId !== undefined;
    const rows: unknown = await manager.query(
      `SELECT *
         FROM workflow_jobs
        WHERE id = ?${scoped ? ' AND project_id = ? AND user_id = ?' : ''}
        FOR UPDATE`,
      scoped ? [jobId, projectId, userId] : [jobId],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NotFoundException('工作流任务不存在');
    }
    return rows[0] as WorkflowJob;
  }

  private async lockOwnedProject(
    manager: EntityManager,
    projectId: string,
    userId: string,
  ): Promise<void> {
    const rows: unknown = await manager.query(
      `SELECT id
         FROM projects
        WHERE id = ? AND user_id = ?
        FOR UPDATE`,
      [projectId, userId],
    );
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new NotFoundException('项目不存在');
    }
  }

  private async appendEventWithManager(
    manager: EntityManager,
    jobId: string,
    type: string,
    data: Record<string, unknown> | null,
    lockJob: boolean,
  ): Promise<WorkflowEvent> {
    if (lockJob) await this.lockJob(manager, jobId);
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
    return repository.save(
      repository.create({
        job_id: jobId,
        seq: maxSeq + 1,
        type,
        data,
      }),
    );
  }

  private isIdempotencyDuplicate(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error.driverError as
      | {
          code?: string;
          errno?: number;
          constraint?: unknown;
          index?: unknown;
          key?: unknown;
          sqlMessage?: unknown;
          sql?: unknown;
        }
      | undefined;
    if (driverError?.code !== 'ER_DUP_ENTRY' && driverError?.errno !== 1062) {
      return false;
    }

    const directIdentifiers = [
      driverError?.constraint,
      driverError?.index,
      driverError?.key,
    ];
    if (
      directIdentifiers.some(
        (identifier) =>
          typeof identifier === 'string' &&
          this.isIdempotencyIndexIdentifier(identifier),
      )
    ) {
      return true;
    }

    return [driverError?.sqlMessage, driverError?.sql, error.message].some(
      (message) =>
        typeof message === 'string' &&
        this.messageNamesIdempotencyIndex(message),
    );
  }

  private isIdempotencyIndexIdentifier(identifier: string): boolean {
    const unquoted = identifier.replace(/[`'"]/g, '').trim();
    const finalSegment = unquoted.split('.').at(-1);
    return finalSegment === 'uq_workflow_jobs_idempotency';
  }

  private messageNamesIdempotencyIndex(message: string): boolean {
    const quotedIdentifiers = message.matchAll(
      /(?:for\s+key|constraint|index)\s+[`'"]([^`'"]+)[`'"]/gi,
    );
    for (const match of quotedIdentifiers) {
      if (this.isIdempotencyIndexIdentifier(match[1])) return true;
    }

    const bareIdentifiers = message.matchAll(
      /(?:for\s+key|constraint|index)\s+([A-Za-z0-9_$.-]+)/gi,
    );
    for (const match of bareIdentifiers) {
      if (this.isIdempotencyIndexIdentifier(match[1])) return true;
    }
    return false;
  }

  private assertSameRequest(
    job: WorkflowJob,
    requestHash: string,
  ): WorkflowJob {
    if (job.request_hash !== requestHash) {
      throw new ConflictException(
        '该幂等键已用于不同的工作流请求，请使用新的幂等键',
      );
    }
    return job;
  }
}

function createWorkflowRequestHash(dto: CreateWorkflowDto): string {
  // Canonical JSON rules: object keys are sorted, array order is preserved,
  // undefined object values are omitted, undefined array values become null,
  // and an absent/undefined input is equivalent to explicit null.
  const canonical = stableJsonStringify({
    workflow_type: dto.workflow_type,
    input: dto.input ?? null,
    client_contract_version: dto.client_contract_version ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new BadRequestException('工作流输入包含无效数字');
    }
    if (typeof current !== 'object' || current === null) return current;
    if (seen.has(current)) {
      throw new BadRequestException('工作流输入不能包含循环引用');
    }
    seen.add(current);
    if (Array.isArray(current)) return current as unknown[];
    const prototype = Object.getPrototypeOf(current) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new BadRequestException('工作流输入必须是 JSON 对象');
    }
    return Object.fromEntries(
      Object.keys(current as Record<string, unknown>)
        .sort()
        .map((key) => [key, (current as Record<string, unknown>)[key]]),
    );
  });
  if (serialized === undefined) {
    throw new BadRequestException('工作流输入无法序列化');
  }
  return serialized;
}
