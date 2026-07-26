import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import cookieParser from 'cookie-parser';
import { createConnection, type Connection } from 'mysql2/promise';
import request from 'supertest';
import { Repository, type MigrationInterface } from 'typeorm';
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
import { getQueueToken } from '@nestjs/bull';
import { WORKFLOW_QUEUE } from '../src/workflow/workflow.processor.js';
import { User } from '../src/auth/entities/user.entity.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ProjectStatus } from '../src/common/enums.js';
import { Project } from '../src/project/entities/project.entity.js';
import { ProjectModule } from '../src/project/project.module.js';
import { WorkflowJob } from '../src/workflow/entities/workflow-job.entity.js';
import type { PublicWorkflowJobDto } from '../src/workflow/dto/workflow-response.dto.js';
import { WorkflowModule } from '../src/workflow/workflow.module.js';
import { ContentController } from '../src/content/content.controller.js';
import { DirectoryController } from '../src/content/directory.controller.js';
import { ContentService } from '../src/content/content.service.js';
import { SSE_REDIS_CLIENT } from '../src/content/content.constants.js';
import {
  WorkflowService,
  type WorkflowEventEnvelope,
} from '../src/workflow/workflow.service.js';
import {
  WorkflowStatus,
  WorkflowType,
} from '../src/workflow/workflow.types.js';

const MYSQL_PASSWORD = 'workflow-controller-e2e-password';
const containerName = `write-agent-workflow-e2e-${process.pid}-${Date.now()}`;
const schemaName = `workflow_controller_${process.pid}_${Date.now()}`;
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
];
let queueAddMock: jest.Mock;

jest.setTimeout(120_000);

describe('workflow HTTP API', () => {
  let admin: Connection;
  let app: INestApplication;
  let mysqlPort: number;
  let ownerToken: string;
  let otherToken: string;
  let ownerProject: Project;
  let otherProject: Project;
  let workflowService: WorkflowService;
  let jobRepository: Repository<WorkflowJob>;

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
    admin = await waitForMysql(mysqlPort);
    await admin.query(
      `CREATE DATABASE \`${schemaName}\` CHARACTER SET utf8mb4`,
    );

    queueAddMock = jest.fn().mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [createWorkflowE2eModule(mysqlPort)],
    })
      .overrideProvider(getQueueToken(WORKFLOW_QUEUE))
      .useValue({ add: queueAddMock })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.listen(0, '127.0.0.1');

    const userRepository = app.get<Repository<User>>(getRepositoryToken(User));
    const projectRepository = app.get<Repository<Project>>(
      getRepositoryToken(Project),
    );
    jobRepository = app.get<Repository<WorkflowJob>>(
      getRepositoryToken(WorkflowJob),
    );
    workflowService = app.get(WorkflowService);
    const owner = await userRepository.save(
      userRepository.create({
        email: 'workflow-owner@example.test',
        password_hash: 'hash',
        nickname: 'owner',
      }),
    );
    const other = await userRepository.save(
      userRepository.create({
        email: 'workflow-other@example.test',
        password_hash: 'hash',
        nickname: 'other',
      }),
    );
    ownerProject = await projectRepository.save(
      projectRepository.create({
        user_id: owner.id,
        name: 'owner workflow project',
        type: null,
        target_audience: null,
        target_chapters: 1,
        style: '教材',
        status: ProjectStatus.DRAFT,
        description: null,
      }),
    );
    otherProject = await projectRepository.save(
      projectRepository.create({
        user_id: other.id,
        name: 'other workflow project',
        type: null,
        target_audience: null,
        target_chapters: 1,
        style: '教材',
        status: ProjectStatus.DRAFT,
        description: null,
      }),
    );
    const jwt = app.get(JwtService);
    ownerToken = await jwt.signAsync({ sub: owner.id, email: owner.email });
    otherToken = await jwt.signAsync({ sub: other.id, email: other.email });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
      await admin.end();
    }
    try {
      execFileSync('docker', ['rm', '--force', containerName]);
    } catch {
      // The --rm container may already have exited.
    }
  });

  const asUser = (token: string) => {
    const api = request(app.getHttpServer() as import('node:http').Server);
    return {
      get: (path: string) =>
        api.get(path).set('Cookie', `wa_access_token=${token}`),
      post: (path: string) =>
        api.post(path).set('Cookie', `wa_access_token=${token}`),
    };
  };

  it('uses the /api prefix and the actual cookie authentication guard', async () => {
    await request(app.getHttpServer() as import('node:http').Server)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({ workflow_type: WorkflowType.DIRECTORY })
      .expect(401);
    await asUser(ownerToken)
      .post('/api/projects/not-a-uuid/workflows')
      .send({ workflow_type: WorkflowType.DIRECTORY })
      .expect(400);
  });

  it('validates blank keys and binds a key only to the same payload', async () => {
    await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.DIRECTORY,
        idempotency_key: '   ',
      })
      .expect(400);

    await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.DIRECTORY,
        idempotency_key: 'http-idempotency',
        input: { chapter: 1 },
      })
      .expect(201);
    await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.DIRECTORY,
        idempotency_key: 'http-idempotency',
        input: { chapter: 2 },
      })
      .expect(409);
  });

  it('returns only the explicit public job projection', async () => {
    const created = await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.CONTENT,
        idempotency_key: 'safe-public-response',
        input: { instruction: 'must remain private' },
      })
      .expect(201);
    const jobId = responseData<PublicWorkflowJobDto>(created).id;
    await jobRepository.update(
      { id: jobId },
      {
        checkpoint: { evidence: 'private checkpoint' },
        error_code: 'RAW_PROVIDER_ERROR',
        error_message: 'raw upstream stack and request details',
        public_error_code: 'MODEL_UNAVAILABLE',
        public_error_message: '模型暂时不可用，请稍后重试',
      },
    );

    const response = await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/workflows/${jobId}`)
      .expect(200);
    const publicJob = responseData<PublicWorkflowJobDto>(response);
    expect(Object.keys(publicJob).sort()).toEqual(
      [
        'id',
        'project_id',
        'workflow_type',
        'status',
        'cancel_requested_at',
        'approved_at',
        'started_at',
        'completed_at',
        'created_at',
        'updated_at',
        'error',
      ].sort(),
    );
    expect(publicJob.error).toEqual({
      code: 'MODEL_UNAVAILABLE',
      message: '模型暂时不可用，请稍后重试',
    });
    const responseBody: unknown = response.body;
    expect(JSON.stringify(responseBody)).not.toContain('private checkpoint');
    expect(JSON.stringify(responseBody)).not.toContain('raw upstream');
    expect(publicJob).not.toHaveProperty('user_id');
    expect(publicJob).not.toHaveProperty('idempotency_key');
    expect(publicJob).not.toHaveProperty('request_hash');
    expect(publicJob).not.toHaveProperty('input');
    expect(publicJob).not.toHaveProperty('checkpoint');
    expect(publicJob).not.toHaveProperty('error_message');
  });

  it('preserves 403 for foreign projects and 404 for foreign jobs in an owned project', async () => {
    await asUser(otherToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({ workflow_type: WorkflowType.DIRECTORY })
      .expect(403);
    const foreign = await asUser(otherToken)
      .post(`/api/projects/${otherProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'foreign-job',
      })
      .expect(201);
    await asUser(ownerToken)
      .get(
        `/api/projects/${ownerProject.id}/workflows/${String(
          responseData<PublicWorkflowJobDto>(foreign).id,
        )}`,
      )
      .expect(404);
  });

  it('binds Last-Event-ID to persisted job events and keeps action status codes stable', async () => {
    const created = await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows`)
      .send({
        workflow_type: WorkflowType.CONTENT,
        idempotency_key: 'http-events',
      })
      .expect(201);
    const jobId = responseData<PublicWorkflowJobDto>(created).id;
    const initial = await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/workflows/${jobId}/events`)
      .expect(200);
    await workflowService.appendEvent(jobId, 'model.delta', { text: 'safe' });
    const resumed = await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/workflows/${jobId}/events`)
      .set(
        'Last-Event-ID',
        responseData<WorkflowEventEnvelope[]>(initial)[0].id,
      )
      .expect(200);
    expect(responseData<WorkflowEventEnvelope[]>(resumed)).toEqual([
      expect.objectContaining({
        job_id: jobId,
        seq: 2,
        type: 'model.delta',
      }),
    ]);
    await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/workflows/${jobId}/events`)
      .set('Last-Event-ID', randomUUID())
      .expect(400);
    await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/workflows/${jobId}/cancel`)
      .expect(200)
      .expect((response) => {
        const data = responseData<PublicWorkflowJobDto>(response);
        expect(data.status).toBe(WorkflowStatus.STOPPED);
        expect(data).not.toHaveProperty('checkpoint');
      });
    const streamed = await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/workflows/${jobId}/events`)
      .set('Accept', 'text/event-stream')
      .set(
        'Last-Event-ID',
        responseData<WorkflowEventEnvelope[]>(initial)[0].id,
      )
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);
    expect(streamed.text).toContain('event: model.delta');
    expect(streamed.text).toContain('event: workflow.cancelled');
    expect(streamed.text).toContain(`"job_id":"${jobId}"`);

    const approvable = await workflowService.create(
      ownerProject.user_id,
      ownerProject.id,
      {
        workflow_type: WorkflowType.OUTLINE,
        idempotency_key: 'http-approve',
      },
    );
    await workflowService.transition(
      approvable.id,
      WorkflowStatus.RUNNING,
      'workflow.started',
    );
    await workflowService.transition(
      approvable.id,
      WorkflowStatus.WAITING_APPROVAL,
      'workflow.waiting_approval',
    );
    await asUser(ownerToken)
      .post(
        `/api/projects/${ownerProject.id}/workflows/${approvable.id}/approve`,
      )
      .expect(200)
      .expect((response) => {
        const data = responseData<PublicWorkflowJobDto>(response);
        expect(data.status).toBe(WorkflowStatus.QUEUED);
        expect(data).not.toHaveProperty('input');
      });
  });

  it('cancels a durable generation through the legacy stop route without a domain write', async () => {
    const job = await workflowService.create(
      ownerProject.user_id,
      ownerProject.id,
      {
        workflow_type: WorkflowType.CONTENT,
        idempotency_key: 'legacy-http-stop',
        input: {
          chapter_node_id: 'chapter-stop',
          section_node_id: 'section-stop',
        },
      },
    );

    await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/content/${job.id}/stop`)
      .expect(201)
      .expect((response) => {
        expect(responseData<{ status: string }>(response).status).toBe(
          'stopped',
        );
      });
    await expect(
      jobRepository.findOneByOrFail({ id: job.id }),
    ).resolves.toMatchObject({
      status: WorkflowStatus.STOPPED,
    });
    await expect(
      admin.query(
        `SELECT COUNT(*) AS count
           FROM \`${schemaName}\`.writing_results
          WHERE project_id = ?
            AND chapter_node_id = 'chapter-stop'`,
        [ownerProject.id],
      ),
    ).resolves.toEqual([[{ count: 0 }], expect.anything()]);
  });

  it('exposes the durable job before dispatch acknowledgement so an immediate Stop is authoritative', async () => {
    let acknowledgeDispatch!: (value: unknown) => void;
    queueAddMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledgeDispatch = resolve;
        }),
    );
    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Workflow E2E server did not expose a TCP address');
    }
    const requestController = new AbortController();
    const generation = fetch(
      `http://127.0.0.1:${address.port}/api/projects/${ownerProject.id}/directory/generate`,
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Cookie: `wa_access_token=${ownerToken}`,
          'X-Request-Id': 'legacy-pre-handshake-stop',
        },
        body: '{}',
        signal: requestController.signal,
      },
    );

    const earlyResponse = await Promise.race([
      generation,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 500);
      }),
    ]);
    if (!earlyResponse) {
      acknowledgeDispatch({});
      requestController.abort();
      await generation.catch(() => undefined);
      throw new Error(
        'Legacy workflow headers were not available while Bull acknowledgement was pending',
      );
    }

    const jobId = earlyResponse.headers.get('x-workflow-job-id');
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const cancellation = await fetch(
      `http://127.0.0.1:${address.port}/api/projects/${ownerProject.id}/workflows/${jobId}/cancel`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Cookie: `wa_access_token=${ownerToken}`,
        },
      },
    );
    expect(cancellation.status).toBe(200);
    requestController.abort();
    acknowledgeDispatch({});

    await expect(
      jobRepository.findOneByOrFail({ id: jobId! }),
    ).resolves.toMatchObject({
      status: WorkflowStatus.STOPPED,
    });
    await expect(
      admin.query(
        `SELECT
           (SELECT COUNT(*) FROM \`${schemaName}\`.directory_versions WHERE project_id = ?) AS versions,
           (SELECT COUNT(*) FROM \`${schemaName}\`.workflow_domain_commits WHERE workflow_job_id = ?) AS commits`,
        [ownerProject.id, jobId],
      ),
    ).resolves.toEqual([[{ versions: 0, commits: 0 }], expect.anything()]);
  });

  it('stops a persisted legacy job when the client disconnects before reading the workflow header', async () => {
    queueAddMock.mockImplementationOnce(() => new Promise(() => undefined));
    const server = app.getHttpServer() as import('node:http').Server;
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Workflow E2E server did not expose a TCP address');
    }
    const requestId = 'legacy-disconnect-before-header';
    let responseObserved = false;
    const generationRequest = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/api/projects/${ownerProject.id}/directory/generate`,
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': '2',
          Cookie: `wa_access_token=${ownerToken}`,
          'X-Request-Id': requestId,
        },
      },
      () => {
        responseObserved = true;
      },
    );
    generationRequest.once('socket', (socket) => socket.pause());
    generationRequest.on('error', () => undefined);
    generationRequest.end('{}');

    const persistedJob = await waitForWorkflowByIdempotencyKey(
      jobRepository,
      requestId,
    );
    expect(responseObserved).toBe(false);
    generationRequest.destroy();

    await waitForWorkflowStatus(
      jobRepository,
      persistedJob.id,
      WorkflowStatus.STOPPED,
    );
    expect(responseObserved).toBe(false);
    await expect(
      admin.query(
        `SELECT
           (SELECT COUNT(*) FROM \`${schemaName}\`.directory_versions WHERE project_id = ?) AS versions,
           (SELECT COUNT(*) FROM \`${schemaName}\`.workflow_domain_commits WHERE workflow_job_id = ?) AS commits`,
        [ownerProject.id, persistedJob.id],
      ),
    ).resolves.toEqual([[{ versions: 0, commits: 0 }], expect.anything()]);
  });

  it('reconnects a legacy generation after Last-Event-ID and replays reset without old tokens', async () => {
    const requestId = 'legacy-http-reconnect';
    const job = await workflowService.create(
      ownerProject.user_id,
      ownerProject.id,
      {
        workflow_type: WorkflowType.DIRECTORY,
        idempotency_key: requestId,
        input: {},
      },
    );
    await workflowService.appendEvent(job.id, 'meta', {
      type: 'meta',
      result_id: job.id,
      workflow_job_id: job.id,
      task_type: WorkflowType.DIRECTORY,
    });
    const oldToken = await workflowService.appendEvent(job.id, 'token', {
      type: 'token',
      content: 'old-partial',
      paragraph_key: '',
    });
    await workflowService.appendEvent(job.id, 'reset', {
      type: 'reset',
      superseded_attempt: 1,
      generation_attempt: 2,
    });
    await workflowService.appendEvent(job.id, 'token', {
      type: 'token',
      content: 'fresh',
      paragraph_key: '',
    });
    await workflowService.appendEvent(job.id, 'done', {
      type: 'done',
      result_id: randomUUID(),
      workflow_job_id: job.id,
      status: 'succeeded',
      citations: [],
    });
    await jobRepository.update(
      { id: job.id },
      { status: WorkflowStatus.SUCCEEDED },
    );

    const response = await asUser(ownerToken)
      .post(`/api/projects/${ownerProject.id}/directory/generate`)
      .set('Accept', 'text/event-stream')
      .set('X-Request-Id', requestId)
      .set('Last-Event-ID', oldToken.id)
      .send({});

    if (response.status !== 200) {
      throw new Error(
        `Expected reconnect 200, received ${response.status}: ${JSON.stringify(response.body)}`,
      );
    }
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.headers['x-workflow-job-id']).toBe(job.id);
    expect(response.text).toContain('event: reset');
    expect(response.text).toContain('"content":"fresh"');
    expect(response.text).not.toContain('old-partial');
  });
});

function createWorkflowE2eModule(mysqlPort: number) {
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            JWT_SECRET: 'workflow-controller-e2e-secret',
            JWT_EXPIRES_IN: '15m',
            JWT_REFRESH_SECRET: 'workflow-controller-e2e-refresh-secret',
            JWT_REFRESH_EXPIRES_IN: '7d',
          }),
        ],
      }),
      TypeOrmModule.forRoot({
        type: 'mysql',
        host: '127.0.0.1',
        port: mysqlPort,
        username: 'root',
        password: MYSQL_PASSWORD,
        database: schemaName,
        charset: 'utf8mb4',
        timezone: '+08:00',
        autoLoadEntities: true,
        synchronize: false,
        migrations,
        migrationsRun: true,
        migrationsTableName: 'typeorm_migrations',
      }),
      ProjectModule,
      WorkflowModule,
      AuthModule,
    ],
    controllers: [ContentController, DirectoryController],
    providers: [
      {
        provide: ContentService,
        useValue: {
          stopGeneration: jest.fn(),
        },
      },
      {
        provide: SSE_REDIS_CLIENT,
        useValue: {},
      },
    ],
  })
  class WorkflowE2eModule {}

  return WorkflowE2eModule;
}

async function waitForMysql(port: number): Promise<Connection> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: MYSQL_PASSWORD,
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function waitForWorkflowByIdempotencyKey(
  repository: Repository<WorkflowJob>,
  idempotencyKey: string,
): Promise<WorkflowJob> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await repository.findOne({
      where: { idempotency_key: idempotencyKey },
    });
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Workflow with idempotency key ${idempotencyKey} was not persisted`,
  );
}

async function waitForWorkflowStatus(
  repository: Repository<WorkflowJob>,
  jobId: string,
  status: WorkflowStatus,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = await repository.findOneByOrFail({ id: jobId });
    if (job.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const job = await repository.findOneByOrFail({ id: jobId });
  throw new Error(
    `Workflow ${jobId} remained ${job.status}; expected ${status}`,
  );
}

function responseData<T>(response: request.Response): T {
  const body: unknown = response.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    !Object.prototype.hasOwnProperty.call(body, 'data')
  ) {
    throw new Error('Expected API response envelope');
  }
  return (body as { data: T }).data;
}
