import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectAccessPolicy } from '../project/project-access.policy.js';
import { Project } from '../project/entities/project.entity.js';
import { ProjectState } from '../project/entities/project-state.entity.js';
import { User } from '../auth/entities/user.entity.js';
import { WorkflowService } from './workflow.service.js';
import { WorkflowEvent } from './entities/workflow-event.entity.js';
import { WorkflowJob } from './entities/workflow-job.entity.js';
import { ModelRun } from './entities/model-run.entity.js';
import { CreateWorkflowPersistence1712200000000 } from '../../migrations/1712200000000-CreateWorkflowPersistence.js';
import { AddWorkflowExecutionLeases1712300000000 } from '../../migrations/1712300000000-AddWorkflowExecutionLeases.js';
import { AddWorkflowDomainCommits1712400000000 } from '../../migrations/1712400000000-AddWorkflowDomainCommits.js';
import { AddWorkflowAttemptRecovery1712500000000 } from '../../migrations/1712500000000-AddWorkflowAttemptRecovery.js';
import { AddModelRunAttempts1712600000000 } from '../../migrations/1712600000000-AddModelRunAttempts.js';
import { WorkflowStatus, WorkflowType } from './workflow.types.js';
import { MysqlWorkflowExecutionStore } from './mysql-workflow-execution.store.js';
import {
  WorkflowCancelledError,
  WorkflowLeaseLostError,
} from './workflow.engine.js';
import { WorkflowDomainCommitService } from './workflow-domain-commit.service.js';
import { WorkflowDomainCommit } from './entities/workflow-domain-commit.entity.js';
import { DirectoryVersion } from '../content/entities/directory-version.entity.js';
import { OutlineVersion } from '../content/entities/outline-version.entity.js';
import { WritingResult } from '../content/entities/writing-result.entity.js';
import { ContentVersion } from '../content/entities/content-version.entity.js';
import { WorkflowGenerationExecutor } from './workflow-generation.executor.js';
import type { ContentService } from '../content/content.service.js';
import { ModelRunService } from './model-run.service.js';

const mysqlDescribe =
  process.env.WORKFLOW_MYSQL_TEST === '1' ? describe : describe.skip;

jest.setTimeout(120_000);

mysqlDescribe('workflow persistence with MySQL 8.4', () => {
  let dataSource: DataSource;
  let service: WorkflowService;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.WORKFLOW_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.WORKFLOW_MYSQL_PORT || 3306),
      username: process.env.WORKFLOW_MYSQL_USER || 'root',
      password: process.env.WORKFLOW_MYSQL_PASSWORD || '',
      database: process.env.WORKFLOW_MYSQL_DATABASE,
      charset: 'utf8mb4',
      timezone: '+08:00',
      entities: [
        User,
        Project,
        ProjectState,
        WorkflowJob,
        WorkflowEvent,
        ModelRun,
        WorkflowDomainCommit,
        DirectoryVersion,
        OutlineVersion,
        WritingResult,
        ContentVersion,
      ],
      migrations: [
        CreateWorkflowPersistence1712200000000,
        AddWorkflowExecutionLeases1712300000000,
        AddWorkflowDomainCommits1712400000000,
        AddWorkflowAttemptRecovery1712500000000,
        AddModelRunAttempts1712600000000,
      ],
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    userId = randomUUID();
    projectId = randomUUID();
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'hash')`,
      [userId, `${userId}@example.test`],
    );
    await dataSource.query(
      `INSERT INTO projects (id, user_id, name) VALUES (?, ?, 'Workflow')`,
      [projectId, userId],
    );
    await dataSource.query(
      `INSERT INTO project_states
         (id, project_id, completed_chapters, pending_items, material_gaps)
       VALUES (?, ?, JSON_ARRAY(), JSON_ARRAY(), JSON_ARRAY())`,
      [randomUUID(), projectId],
    );
    service = new WorkflowService(
      dataSource.getRepository(WorkflowJob),
      dataSource.getRepository(WorkflowEvent),
      dataSource,
      new ProjectAccessPolicy(dataSource.getRepository(Project)),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM workflow_events');
      await dataSource.query('DELETE FROM model_runs');
      await dataSource.query('DELETE FROM workflow_jobs');
      await dataSource.query('DELETE FROM projects WHERE id = ?', [projectId]);
      await dataSource.query('DELETE FROM users WHERE id = ?', [userId]);
      await dataSource.destroy();
    }
  });

  it('returns one job under concurrent duplicate submissions', async () => {
    const submissions = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.create(userId, projectId, {
          workflow_type: WorkflowType.DIRECTORY,
          idempotency_key: 'concurrent-directory',
        }),
      ),
    );
    expect(new Set(submissions.map((job) => job.id)).size).toBe(1);
    await expect(
      dataSource.getRepository(WorkflowJob).countBy({
        idempotency_key: 'concurrent-directory',
      }),
    ).resolves.toBe(1);
  });

  it('returns deterministic conflicts for sequential and concurrent key reuse with different requests', async () => {
    await service.create(userId, projectId, {
      workflow_type: WorkflowType.DIRECTORY,
      idempotency_key: 'request-mismatch',
      input: { chapter: 1 },
    });
    await expect(
      service.create(userId, projectId, {
        workflow_type: WorkflowType.DIRECTORY,
        idempotency_key: 'request-mismatch',
        input: { chapter: 2 },
      }),
    ).rejects.toBeInstanceOf(Error);

    const concurrent = await Promise.allSettled([
      service.create(userId, projectId, {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'concurrent-request-mismatch',
        input: { chapter: 1 },
      }),
      service.create(userId, projectId, {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'concurrent-request-mismatch',
        input: { chapter: 2 },
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = concurrent.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    await expect(
      dataSource.getRepository(WorkflowJob).countBy({
        idempotency_key: 'concurrent-request-mismatch',
      }),
    ).resolves.toBe(1);
  });

  it('allocates unique monotonic event sequence numbers concurrently', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'concurrent-events',
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service.appendEvent(job.id, 'model.delta', { index }),
      ),
    );
    const rows = await dataSource.getRepository(WorkflowEvent).find({
      where: { job_id: job.id },
      order: { seq: 'ASC' },
    });
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1),
    );
  });

  it('allocates unique model attempt numbers across concurrent gateway services', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'concurrent-model-attempts',
    });
    const repository = dataSource.getRepository(ModelRun);
    const services = [
      new ModelRunService(repository),
      new ModelRunService(repository),
      new ModelRunService(repository),
    ];
    const runs = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        services[index % services.length].startAttempt({
          workflow_job_id: job.id,
          provider: 'fake',
          model: 'fake-model',
          workflow_node: 'draft',
          attempt_kind: index === 0 ? 'initial' : 'network_retry',
          generation_attempt: 1,
          network_attempt: index,
          repair_attempt: 0,
          request_metadata: null,
          prompt_sha256: 'a'.repeat(64),
        }),
      ),
    );

    expect(
      runs.map((run) => run.attempt_number).sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    await expect(
      dataSource.query(
        `SELECT COUNT(DISTINCT attempt_number) AS count
           FROM model_runs
          WHERE workflow_job_id = ?
            AND workflow_node = 'draft'`,
        [job.id],
      ),
    ).resolves.toEqual([{ count: '12' }]);
  });

  it('fences terminal model-run updates and accepts only identical replay', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'model-run-terminal-fence',
    });
    const modelRuns = new ModelRunService(dataSource.getRepository(ModelRun));
    const run = await modelRuns.startAttempt({
      workflow_job_id: job.id,
      provider: 'fake',
      model: 'fake-model',
      workflow_node: 'draft',
      attempt_kind: 'initial',
      generation_attempt: 1,
      network_attempt: 0,
      repair_attempt: 0,
      request_metadata: null,
      prompt_sha256: 'b'.repeat(64),
    });
    const terminal = {
      status: 'SUCCEEDED' as const,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
      cost_usd: '0.000001',
      error_code: null,
      error_message: null,
      latency_ms: 10,
      completed_at: new Date('2026-07-25T00:00:00.000Z'),
    };

    await modelRuns.finishAttempt(run.id, terminal);
    await expect(
      modelRuns.finishAttempt(run.id, terminal),
    ).resolves.toBeUndefined();
    await expect(
      modelRuns.finishAttempt(run.id, {
        ...terminal,
        status: 'FAILED',
        error_code: 'LATE_FAILURE',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      dataSource.query(
        `SELECT status, error_code AS errorCode
           FROM model_runs
          WHERE id = ?`,
        [run.id],
      ),
    ).resolves.toEqual([{ status: 'SUCCEEDED', errorCode: null }]);
  });

  it('does not allow STOPPED to become SUCCEEDED', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'terminal-fence',
    });
    await service.cancel(userId, projectId, job.id);
    await expect(
      service.transition(
        job.id,
        WorkflowStatus.SUCCEEDED,
        'workflow.succeeded',
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      dataSource.getRepository(WorkflowJob).findOneByOrFail({ id: job.id }),
    ).resolves.toMatchObject({ status: WorkflowStatus.STOPPED });
  });

  it('lets only one worker claim a queued job and fences an expired owner', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'lease-fencing',
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);

    const claims = await Promise.all([
      store.claim(job.id, 'worker-a'),
      store.claim(job.id, 'worker-b'),
    ]);
    const first = claims.find((claim) => claim !== null);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(first).toBeDefined();

    await dataSource.query(
      `UPDATE workflow_jobs
          SET lease_expires_at =
            DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [job.id],
    );
    const recovered = await store.claim(job.id, 'worker-recovery');
    expect(recovered).not.toBeNull();
    expect(recovered?.fencingToken).toBe((first?.fencingToken ?? 0) + 1);
    await expect(
      store.persistProgress(
        first!,
        'token',
        { content: 'stale' },
        { output: 'stale' },
      ),
    ).rejects.toBeInstanceOf(WorkflowLeaseLostError);
    await expect(
      store.persistProgress(
        recovered!,
        'token',
        { content: 'fresh' },
        { output: 'fresh' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      dataSource.getRepository(WorkflowJob).findOneByOrFail({ id: job.id }),
    ).resolves.toMatchObject({ checkpoint: { output: 'fresh' } });
  });

  it('keeps STOPPED terminal when a leased worker completes after cancellation', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.OUTLINE,
      idempotency_key: 'cancel-active-lease',
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const claim = await store.claim(job.id, 'worker-cancelled');
    expect(claim).not.toBeNull();

    await service.cancel(userId, projectId, job.id);
    await expect(store.complete(claim!)).rejects.toBeInstanceOf(
      WorkflowCancelledError,
    );
    await expect(
      dataSource.getRepository(WorkflowJob).findOneByOrFail({ id: job.id }),
    ).resolves.toMatchObject({
      status: WorkflowStatus.STOPPED,
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    });
  });

  it('commits generated directory once across crash and lease reclaim', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.DIRECTORY,
      idempotency_key: 'domain-commit-recovery',
      input: {},
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const committer = new WorkflowDomainCommitService(dataSource);
    const contentService = {
      generateDirectory: jest.fn(async function* () {
        await Promise.resolve();
        yield '{"nodes":[{"key":"chapter-1","title":"第一章"}]}';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer,
    );
    const first = await store.claim(job.id, 'worker-before-crash');
    expect(first).not.toBeNull();
    for await (const generated of executor.execute(first!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        first!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
      if (generated.type === 'workflow.model_completed') break;
    }

    await dataSource.query(
      `UPDATE workflow_jobs
          SET lease_expires_at =
            DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [job.id],
    );
    const second = await store.claim(job.id, 'worker-after-model-crash');
    expect(second).not.toBeNull();
    for await (const generated of executor.execute(second!, {
      signal: new AbortController().signal,
    })) {
      if (generated.type === 'workflow.business_committed') break;
    }

    await dataSource.query(
      `UPDATE workflow_jobs
          SET lease_expires_at =
            DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
        WHERE id = ?`,
      [job.id],
    );
    const third = await store.claim(job.id, 'worker-after-commit-crash');
    expect(third).not.toBeNull();
    for await (const generated of executor.execute(third!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        third!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
    }
    await store.complete(third!);

    expect(contentService.generateDirectory).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM directory_versions
          WHERE project_id = ?`,
        [projectId],
      ),
    ).resolves.toEqual([{ count: '1' }]);
    await expect(
      dataSource.query(
        `SELECT status, JSON_UNQUOTE(JSON_EXTRACT(checkpoint, '$.phase')) AS phase
           FROM workflow_jobs
          WHERE id = ?`,
        [job.id],
      ),
    ).resolves.toEqual([{ status: 'SUCCEEDED', phase: 'done' }]);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM workflow_domain_commits
          WHERE workflow_job_id = ?`,
        [job.id],
      ),
    ).resolves.toEqual([{ count: '1' }]);
  });

  it('persists a reset attempt before replaying a crashed model stream', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.DIRECTORY,
      idempotency_key: 'model-stream-reset-recovery',
      input: {},
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const committer = new WorkflowDomainCommitService(dataSource);
    let providerCalls = 0;
    const contentService = {
      generateDirectory: jest.fn(async function* () {
        providerCalls += 1;
        await Promise.resolve();
        if (providerCalls === 1) {
          yield 'old-partial';
          return;
        }
        yield '{"nodes":[{"key":"fresh","title":"新目录"}]}';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer,
    );
    const first = await store.claim(job.id, 'worker-partial-stream');
    expect(first).not.toBeNull();
    for await (const generated of executor.execute(first!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        first!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
      if (generated.type === 'token') break;
    }

    await expireLease(dataSource, job.id);
    const recovered = await store.claim(job.id, 'worker-reset-stream');
    expect(recovered).toMatchObject({ generationAttempt: 1 });
    for await (const generated of executor.execute(recovered!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        recovered!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
    }
    await store.complete(recovered!);

    const events = await service.listEvents(
      userId,
      projectId,
      job.id,
      { limit: 100 },
      undefined,
    );
    let replayed = '';
    for (const event of events) {
      if (event.type === 'reset') replayed = '';
      if (
        event.type === 'token' &&
        event.data &&
        typeof event.data.content === 'string'
      ) {
        replayed += event.data.content;
      }
    }
    expect(replayed).toBe('{"nodes":[{"key":"fresh","title":"新目录"}]}');
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['meta', 'token', 'reset', 'done']),
    );
    await expect(
      dataSource.query(
        `SELECT generation_attempt,
                JSON_EXTRACT(checkpoint, '$.output') AS checkpointOutput
           FROM workflow_jobs
          WHERE id = ?`,
        [job.id],
      ),
    ).resolves.toEqual([{ generation_attempt: 2, checkpointOutput: null }]);
    expect(contentService.generateDirectory).toHaveBeenCalledTimes(2);
  });

  it('rejects cancelled workers before any domain write', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'domain-commit-cancelled',
      input: { chapter_node_id: 'chapter-cancelled' },
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const committer = new WorkflowDomainCommitService(dataSource);
    const claim = await store.claim(job.id, 'worker-cancelled-before-commit');
    expect(claim).not.toBeNull();
    await service.cancel(userId, projectId, job.id);

    await expect(
      committer.commit(claim!, {
        contract_version: 'legacy:v0',
        output: 'late content',
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM writing_results
          WHERE project_id = ?
            AND chapter_node_id = 'chapter-cancelled'`,
        [projectId],
      ),
    ).resolves.toEqual([{ count: '0' }]);
  });

  it('maps a durable legacy result id to STOPPED before any domain write', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'legacy-domain-commit-cancelled',
      input: { chapter_node_id: 'chapter-legacy-cancelled' },
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const committer = new WorkflowDomainCommitService(dataSource);
    const claim = await store.claim(job.id, 'legacy-stop-worker');
    expect(claim).not.toBeNull();

    await expect(
      service.cancelByLegacyResult(userId, projectId, job.id),
    ).resolves.toBe(true);
    await expect(
      committer.commit(claim!, {
        contract_version: 'legacy:v0',
        output: 'late legacy content',
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    await expect(
      dataSource.query(`SELECT status FROM workflow_jobs WHERE id = ?`, [
        job.id,
      ]),
    ).resolves.toEqual([{ status: WorkflowStatus.STOPPED }]);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM writing_results
          WHERE project_id = ?
            AND chapter_node_id = 'chapter-legacy-cancelled'`,
        [projectId],
      ),
    ).resolves.toEqual([{ count: '0' }]);
  });

  it('creates one writing result and version after model and commit crashes', async () => {
    const job = await service.create(userId, projectId, {
      workflow_type: WorkflowType.CONTENT,
      idempotency_key: 'content-domain-commit-recovery',
      input: {
        chapter_node_id: 'chapter-content-recovery',
        section_node_id: 'section-content-recovery',
      },
    });
    const store = new MysqlWorkflowExecutionStore(dataSource);
    const committer = new WorkflowDomainCommitService(dataSource);
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        yield '恢复后的正文';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer,
    );
    const first = await store.claim(job.id, 'content-before-model-crash');
    for await (const generated of executor.execute(first!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        first!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
      if (generated.type === 'workflow.model_completed') break;
    }

    await expireLease(dataSource, job.id);
    const second = await store.claim(job.id, 'content-before-commit-crash');
    for await (const generated of executor.execute(second!, {
      signal: new AbortController().signal,
    })) {
      if (generated.type === 'workflow.business_committed') break;
    }

    await expireLease(dataSource, job.id);
    const third = await store.claim(job.id, 'content-final-recovery');
    for await (const generated of executor.execute(third!, {
      signal: new AbortController().signal,
    })) {
      await store.persistProgress(
        third!,
        generated.type,
        generated.data,
        generated.checkpoint,
      );
    }
    await store.complete(third!);

    expect(contentService.generateWorkflowText).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM writing_results
          WHERE project_id = ?
            AND chapter_node_id = 'chapter-content-recovery'`,
        [projectId],
      ),
    ).resolves.toEqual([{ count: '1' }]);
    await expect(
      dataSource.query(
        `SELECT COUNT(*) AS count
           FROM content_versions cv
           JOIN writing_results wr ON wr.id = cv.result_id
          WHERE wr.project_id = ?
            AND wr.chapter_node_id = 'chapter-content-recovery'`,
        [projectId],
      ),
    ).resolves.toEqual([{ count: '1' }]);
  });
});

async function expireLease(
  dataSource: DataSource,
  jobId: string,
): Promise<void> {
  await dataSource.query(
    `UPDATE workflow_jobs
        SET lease_expires_at =
          DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
      WHERE id = ?`,
    [jobId],
  );
}
