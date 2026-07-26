import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  QueryFailedError,
  type DataSource,
  type EntityManager,
  type Repository,
} from 'typeorm';
import type { ProjectAccessPolicy } from '../project/project-access.policy.js';
import {
  assertWorkflowTransition,
  WorkflowService,
} from './workflow.service.js';
import {
  TERMINAL_WORKFLOW_STATUSES,
  WorkflowStatus,
  WorkflowType,
} from './workflow.types.js';
import type { WorkflowEvent } from './entities/workflow-event.entity.js';
import type { WorkflowJob } from './entities/workflow-job.entity.js';
import type { ConfigService } from '@nestjs/config';
import type { StorageReadinessService } from '../storage/storage-readiness.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';

describe('workflow state machine', () => {
  it.each([
    [WorkflowStatus.QUEUED, WorkflowStatus.RUNNING],
    [WorkflowStatus.RUNNING, WorkflowStatus.WAITING_APPROVAL],
    [WorkflowStatus.RUNNING, WorkflowStatus.SUCCEEDED],
    [WorkflowStatus.WAITING_APPROVAL, WorkflowStatus.QUEUED],
  ])('allows %s to transition to %s', (current, next) => {
    expect(() => assertWorkflowTransition(current, next)).not.toThrow();
  });

  it.each([...TERMINAL_WORKFLOW_STATUSES])(
    'prevents terminal status %s from being reversed',
    (terminal) => {
      expect(() =>
        assertWorkflowTransition(terminal, WorkflowStatus.SUCCEEDED),
      ).toThrow(ConflictException);
    },
  );

  it('rejects an undefined transition edge', () => {
    expect(() =>
      assertWorkflowTransition(WorkflowStatus.QUEUED, WorkflowStatus.SUCCEEDED),
    ).toThrow(ConflictException);
  });
});

describe('WorkflowService', () => {
  let jobs: WorkflowJob[];
  let events: WorkflowEvent[];
  let service: WorkflowService;
  let accessPolicy: Pick<ProjectAccessPolicy, 'assertOwner'>;
  let repositories: ReturnType<typeof createInMemoryRepositories>;
  let dataSource: DataSource;

  beforeEach(() => {
    jobs = [];
    events = [];
    accessPolicy = {
      assertOwner: jest.fn().mockResolvedValue({
        id: PROJECT_ID,
        user_id: USER_ID,
      }),
    };
    repositories = createInMemoryRepositories(
      () => jobs,
      (next) => {
        jobs = next;
      },
      () => events,
      (next) => {
        events = next;
      },
    );
    const manager = createInMemoryManager(
      repositories,
      () => jobs,
      () => events,
    );
    dataSource = {
      transaction: jest.fn(
        async <T>(callback: (entityManager: EntityManager) => Promise<T>) =>
          callback(manager as EntityManager),
      ),
    } as unknown as DataSource;
    service = new WorkflowService(
      repositories.jobs as Repository<WorkflowJob>,
      repositories.events as Repository<WorkflowEvent>,
      dataSource,
      accessPolicy as ProjectAccessPolicy,
    );
  });

  it('creates a queued job and a first persisted event', async () => {
    const job = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.DIRECTORY,
      input: { title: '教材目录' },
    });

    expect(job).toMatchObject({
      user_id: USER_ID,
      project_id: PROJECT_ID,
      workflow_type: WorkflowType.DIRECTORY,
      status: WorkflowStatus.QUEUED,
      workflow_definition: 'legacy-generation.v1',
      authoring_mode: 'off',
      server_entrypoint: 'workflow_api',
      client_contract_version: null,
    });
    expect(job.rollout_policy_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(job.idempotency_key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(events).toHaveLength(1);
    expect(service.toEventEnvelope(events[0])).toEqual({
      id: events[0].id,
      job_id: job.id,
      seq: 1,
      type: 'workflow.created',
      data: { status: WorkflowStatus.QUEUED },
      created_at: events[0].created_at,
    });
  });

  it('requires storage readiness before persisting enforce authoring', async () => {
    const readiness: Pick<StorageReadinessService, 'assertReady'> = {
      assertReady: jest
        .fn()
        .mockRejectedValue(new Error('STORAGE_AUTHORITY_UNPROVEN')),
    };
    const configValues: Record<string, unknown> = {
      AUTHORING_COMMIT_MODE: 'enforce_allowlist',
      AUTHORING_ALLOWLIST_PROJECT_IDS: PROJECT_ID,
    };
    const config: Pick<ConfigService, 'get'> = {
      get: jest.fn((key: string) => configValues[key]),
    };
    const gated = new WorkflowService(
      repositories.jobs as Repository<WorkflowJob>,
      repositories.events as Repository<WorkflowEvent>,
      dataSource,
      accessPolicy as ProjectAccessPolicy,
      config as ConfigService,
      readiness as StorageReadinessService,
    );

    await expect(
      gated.create(USER_ID, PROJECT_ID, {
        workflow_type: WorkflowType.CONTENT,
        client_contract_version: 'authoring-approval-ui.v1',
        input: { section_node_id: 'section-1' },
      }),
    ).rejects.toThrow('STORAGE_AUTHORITY_UNPROVEN');
    expect(readiness.assertReady).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(0);
  });

  it('persists enforce authoring after storage readiness passes', async () => {
    const readiness: Pick<StorageReadinessService, 'assertReady'> = {
      assertReady: jest.fn().mockResolvedValue({
        storage_epoch: 'epoch-1',
        storage_contract_version: 'storage-broker.v1',
      }),
    };
    const configValues: Record<string, unknown> = {
      AUTHORING_COMMIT_MODE: 'enforce_allowlist',
      AUTHORING_ALLOWLIST_PROJECT_IDS: PROJECT_ID,
    };
    const config: Pick<ConfigService, 'get'> = {
      get: jest.fn((key: string) => configValues[key]),
    };
    const gated = new WorkflowService(
      repositories.jobs as Repository<WorkflowJob>,
      repositories.events as Repository<WorkflowEvent>,
      dataSource,
      accessPolicy as ProjectAccessPolicy,
      config as ConfigService,
      readiness as StorageReadinessService,
    );

    const created = await gated.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      client_contract_version: 'authoring-approval-ui.v1',
      input: { section_node_id: 'section-1' },
    });

    expect(readiness.assertReady).toHaveBeenCalledTimes(1);
    expect(created.workflow_definition).toBe('deterministic-authoring.v1');
    expect(jobs).toHaveLength(1);
  });

  it('returns the original job for the same key and canonical request', async () => {
    const first = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'outline-chapter-1',
      input: {
        chapter: 1,
        options: { language: 'zh-CN', audience: 'beginner' },
      },
    });
    const duplicate = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'outline-chapter-1',
      input: {
        options: { audience: 'beginner', language: 'zh-CN' },
        chapter: 1,
      },
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('rejects a reused key whose canonical request is different', async () => {
    await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'outline-chapter-mismatch',
      input: { chapter: 1 },
    });

    await expect(
      service.create(USER_ID, PROJECT_ID, {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'outline-chapter-mismatch',
        input: { chapter: 2 },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(jobs).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('recovers a concurrent insert only when MySQL names the idempotency unique index', async () => {
    const dto = {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'named-idempotency-race',
      input: { chapter: 1 },
    };
    const existing = await service.create(USER_ID, PROJECT_ID, dto);
    const duplicateError = mysqlDuplicateError(
      "Duplicate entry 'scope' for key 'workflow_jobs.uq_workflow_jobs_idempotency'",
    );
    const raceService = createDuplicateRaceService(
      duplicateError,
      existing,
      accessPolicy,
    );

    await expect(
      raceService.create(USER_ID, PROJECT_ID, dto),
    ).resolves.toMatchObject({ id: existing.id });
  });

  it.each([
    ['PRIMARY', "Duplicate entry 'id' for key 'workflow_jobs.PRIMARY'"],
    [
      'another unique index',
      "Duplicate entry 'value' for key 'workflow_jobs.uq_workflow_jobs_future'",
    ],
  ])(
    'rethrows an ER_DUP_ENTRY for %s even if the scoped job is visible',
    async (_name, sqlMessage) => {
      const dto = {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: `wrong-unique-${_name}`,
        input: { chapter: 1 },
      };
      const existing = await service.create(USER_ID, PROJECT_ID, dto);
      const duplicateError = mysqlDuplicateError(sqlMessage);
      const raceService = createDuplicateRaceService(
        duplicateError,
        existing,
        accessPolicy,
      );

      await expect(raceService.create(USER_ID, PROJECT_ID, dto)).rejects.toBe(
        duplicateError,
      );
    },
  );

  it('canonicalizes undefined like JSON without changing array order', async () => {
    const first = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'canonical-json',
      input: {
        omitted: undefined,
        values: ['first', undefined, null],
      } as unknown as Record<string, unknown>,
    });
    const duplicate = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'canonical-json',
      input: { values: ['first', null, null] },
    });

    expect(duplicate.id).toBe(first.id);
  });

  it('does not deduplicate requests that omit the idempotency key', async () => {
    const first = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
    });
    const second = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
    });

    expect(second.id).not.toBe(first.id);
    expect(jobs).toHaveLength(2);
  });

  it('rejects an explicitly blank idempotency key', async () => {
    await expect(
      service.create(USER_ID, PROJECT_ID, {
        workflow_type: WorkflowType.CONTENT,
        idempotency_key: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs).toHaveLength(0);
  });

  it('checks project ownership before disclosing a job', async () => {
    accessPolicy.assertOwner = jest
      .fn()
      .mockRejectedValue(new ForbiddenException());

    await expect(
      service.findOne('foreign-user', PROJECT_ID, JOB_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 when a job is not in the owned project', async () => {
    await expect(
      service.findOne(USER_ID, PROJECT_ID, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists cancellation and keeps STOPPED idempotent', async () => {
    const job = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.DIRECTORY,
      idempotency_key: 'cancel-me',
    });
    const stopped = await service.cancel(USER_ID, PROJECT_ID, job.id);
    const repeated = await service.cancel(USER_ID, PROJECT_ID, job.id);

    expect(stopped.status).toBe(WorkflowStatus.STOPPED);
    expect(stopped.cancel_requested_at).toBeInstanceOf(Date);
    expect(repeated.status).toBe(WorkflowStatus.STOPPED);
    expect(events.map((event) => event.type)).toEqual([
      'workflow.created',
      'workflow.cancelled',
    ]);
  });

  it('resumes a material-gap job from a clean grounding checkpoint', async () => {
    const job = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'resume-material',
    });
    await service.transition(
      job.id,
      WorkflowStatus.RUNNING,
      'workflow.started',
    );
    await service.transition(
      job.id,
      WorkflowStatus.WAITING_MATERIAL,
      'workflow.waiting_material',
    );
    job.checkpoint = {
      phase: 'revision_model_completed',
      revision_attempt: 1,
      output: '仍不支持',
    };
    job.error_code = 'MATERIAL_GAP';

    const resumed = await service.resumeMaterial(USER_ID, PROJECT_ID, job.id);

    expect(resumed).toMatchObject({
      status: WorkflowStatus.QUEUED,
      checkpoint: null,
      error_code: null,
      public_error_code: null,
    });
    expect(events.at(-1)?.type).toBe('workflow.material_resumed');
  });

  it('lists bounded events after an opaque persisted event id', async () => {
    const job = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'events',
    });
    await service.transition(
      job.id,
      WorkflowStatus.RUNNING,
      'workflow.started',
      { attempt: 1 },
    );
    await service.transition(
      job.id,
      WorkflowStatus.WAITING_APPROVAL,
      'workflow.waiting_approval',
    );

    const listed = await service.listEvents(
      USER_ID,
      PROJECT_ID,
      job.id,
      { limit: 1 },
      events[0].id,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      job_id: job.id,
      seq: 2,
      type: 'workflow.started',
      data: { attempt: 1 },
    });
    expect(Object.keys(listed[0]).sort()).toEqual(
      ['id', 'job_id', 'seq', 'type', 'data', 'created_at'].sort(),
    );
  });

  it('rejects a malformed or cross-job Last-Event-ID cursor', async () => {
    const job = await service.create(USER_ID, PROJECT_ID, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'cursor-job',
    });

    await expect(
      service.listEvents(
        USER_ID,
        PROJECT_ID,
        job.id,
        { limit: 20 },
        'not-a-uuid',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listEvents(
        USER_ID,
        PROJECT_ID,
        job.id,
        { limit: 20 },
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createInMemoryRepositories(
  getJobs: () => WorkflowJob[],
  setJobs: (jobs: WorkflowJob[]) => void,
  getEvents: () => WorkflowEvent[],
  setEvents: (events: WorkflowEvent[]) => void,
) {
  const jobs = {
    create: (value: Partial<WorkflowJob>) => value as WorkflowJob,
    save: (value: WorkflowJob) => {
      const now = new Date();
      const saved = {
        ...value,
        id: value.id || randomUUID(),
        created_at: value.created_at || now,
        updated_at: now,
      };
      setJobs([...getJobs().filter((row) => row.id !== saved.id), saved]);
      return Promise.resolve(saved);
    },
    findOne: ({
      where,
    }: {
      where: Partial<Record<keyof WorkflowJob, unknown>>;
    }) =>
      Promise.resolve(
        getJobs().find((row) =>
          Object.entries(where).every(
            ([key, value]) => row[key as keyof WorkflowJob] === value,
          ),
        ) ?? null,
      ),
  };
  const workflowEvents = {
    create: (value: Partial<WorkflowEvent>) => value as WorkflowEvent,
    save: (value: WorkflowEvent) => {
      const saved = {
        ...value,
        id: value.id || randomUUID(),
        created_at: value.created_at || new Date(),
      };
      setEvents([...getEvents(), saved]);
      return Promise.resolve(saved);
    },
    findOne: ({
      where,
    }: {
      where: Partial<Record<keyof WorkflowEvent, unknown>>;
    }) =>
      Promise.resolve(
        getEvents().find((row) =>
          Object.entries(where).every(
            ([key, value]) => row[key as keyof WorkflowEvent] === value,
          ),
        ) ?? null,
      ),
    find: ({
      where,
      take,
    }: {
      where: {
        job_id: string;
        seq?: { _value: number };
      };
      take: number;
    }) =>
      Promise.resolve(
        getEvents()
          .filter(
            (row) =>
              row.job_id === where.job_id &&
              (where.seq === undefined || row.seq > where.seq._value),
          )
          .sort((a, b) => a.seq - b.seq)
          .slice(0, take),
      ),
  };
  return {
    jobs,
    events: workflowEvents,
  };
}

function createInMemoryManager(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  getJobs: () => WorkflowJob[],
  getEvents: () => WorkflowEvent[],
) {
  return {
    getRepository: (entity: { name: string }) => {
      if (entity.name === 'WorkflowJob') return repositories.jobs;
      if (entity.name === 'WorkflowEvent') return repositories.events;
      throw new Error(`Unexpected in-memory repository: ${entity.name}`);
    },
    query: (sql: string, parameters: unknown[]) => {
      if (sql.includes('FROM projects')) {
        return Promise.resolve(
          parameters[0] === PROJECT_ID && parameters[1] === USER_ID
            ? [{ id: PROJECT_ID }]
            : [],
        );
      }
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve(
          getJobs().filter(
            (job) =>
              job.id === parameters[0] &&
              (parameters.length < 3 ||
                (job.project_id === parameters[1] &&
                  job.user_id === parameters[2])),
          ),
        );
      }
      if (sql.includes('MAX(seq)')) {
        return Promise.resolve([
          {
            maxSeq: getEvents()
              .filter((event) => event.job_id === parameters[0])
              .reduce((highest, event) => Math.max(highest, event.seq), 0),
          },
        ]);
      }
      if (sql.includes('DELETE FROM grounding_assignments')) {
        return Promise.resolve({ affectedRows: 1 });
      }
      return Promise.reject(new Error(`Unexpected in-memory SQL: ${sql}`));
    },
  };
}

function mysqlDuplicateError(sqlMessage: string): QueryFailedError {
  return new QueryFailedError('INSERT INTO workflow_jobs ...', [], {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlMessage,
    sql: 'INSERT INTO `workflow_jobs` (`id`) VALUES (?)',
  });
}

function createDuplicateRaceService(
  duplicateError: QueryFailedError,
  existing: WorkflowJob,
  accessPolicy: Pick<ProjectAccessPolicy, 'assertOwner'>,
): WorkflowService {
  const jobs = {
    findOne: jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing),
  } as unknown as Repository<WorkflowJob>;
  const events = {} as Repository<WorkflowEvent>;
  const dataSource = {
    transaction: jest.fn().mockRejectedValue(duplicateError),
  } as unknown as DataSource;
  return new WorkflowService(
    jobs,
    events,
    dataSource,
    accessPolicy as ProjectAccessPolicy,
  );
}
