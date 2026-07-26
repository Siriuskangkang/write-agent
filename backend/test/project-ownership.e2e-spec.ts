import { readFile } from 'node:fs/promises';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { createConnection, type Connection } from 'mysql2/promise';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { ProjectModule } from '../src/project/project.module.js';
import { ContentModule } from '../src/content/content.module.js';
import { StyleTemplateModule } from '../src/style-template/style-template.module.js';
import { User } from '../src/auth/entities/user.entity.js';
import { Project } from '../src/project/entities/project.entity.js';
import { DirectoryVersion } from '../src/content/entities/directory-version.entity.js';
import { OutlineVersion } from '../src/content/entities/outline-version.entity.js';
import { WritingResult } from '../src/content/entities/writing-result.entity.js';
import { StyleTemplate } from '../src/style-template/entities/style-template.entity.js';
import { TaskType, WritingResultStatus } from '../src/common/enums.js';
import { cleanupOwnershipE2e } from '../src/testing/ownership-e2e-cleanup.js';

type E2eConfig = {
  databaseHost: string;
  databasePort: number;
  databaseUser: string;
  databasePassword: string;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
};

function parseEnvFile(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .flatMap((line) => {
        const index = line.indexOf('=');
        if (index < 1) return [];
        const key = line.slice(0, index).trim();
        const value = line
          .slice(index + 1)
          .trim()
          .replace(/^(['"])(.*)\1$/, '$2');
        return [[key, value]];
      }),
  );
}

async function loadE2eConfig(): Promise<E2eConfig> {
  const envFile = process.env.AUTH_E2E_ENV_FILE;
  if (envFile) {
    const fileValues = parseEnvFile(await readFile(envFile, 'utf8'));
    for (const [key, value] of Object.entries(fileValues)) {
      process.env[key] ??= value;
    }
  }

  const get = (authKey: string, fallbackKey: string): string => {
    const value = process.env[authKey] ?? process.env[fallbackKey];
    if (!value) {
      throw new Error(
        `Missing ${authKey} (or ${fallbackKey}) for isolated ownership e2e tests`,
      );
    }
    return value;
  };
  const port = (authKey: string, fallbackKey: string): number => {
    const value = Number(get(authKey, fallbackKey));
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Invalid ${authKey} (or ${fallbackKey}) for e2e tests`);
    }
    return value;
  };

  return {
    databaseHost: get('AUTH_E2E_DATABASE_HOST', 'DATABASE_HOST'),
    databasePort: port('AUTH_E2E_DATABASE_PORT', 'DATABASE_PORT'),
    databaseUser: get('AUTH_E2E_DATABASE_USER', 'DATABASE_USER'),
    databasePassword: get('AUTH_E2E_DATABASE_PASSWORD', 'DATABASE_PASSWORD'),
    redisHost: get('AUTH_E2E_REDIS_HOST', 'REDIS_HOST'),
    redisPort: port('AUTH_E2E_REDIS_PORT', 'REDIS_PORT'),
    redisPassword:
      process.env.AUTH_E2E_REDIS_PASSWORD ?? process.env.REDIS_PASSWORD,
  };
}

function createE2eAppModule(config: E2eConfig, schemaName: string) {
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            DATABASE_HOST: config.databaseHost,
            DATABASE_PORT: config.databasePort,
            DATABASE_USER: config.databaseUser,
            DATABASE_PASSWORD: config.databasePassword,
            DATABASE_NAME: schemaName,
            REDIS_HOST: config.redisHost,
            REDIS_PORT: config.redisPort,
            REDIS_PASSWORD: config.redisPassword,
            JWT_SECRET: 'ownership-e2e-secret',
            LLM_PROVIDER: 'deepseek',
            DEEPSEEK_API_KEY: 'ownership-e2e-key',
          }),
        ],
      }),
      TypeOrmModule.forRoot({
        type: 'mysql',
        host: config.databaseHost,
        port: config.databasePort,
        username: config.databaseUser,
        password: config.databasePassword,
        database: schemaName,
        charset: 'utf8mb4',
        autoLoadEntities: true,
        synchronize: false,
      }),
      AuthModule,
      ProjectModule,
      ContentModule,
      StyleTemplateModule,
    ],
  })
  class OwnershipE2eModule {}

  return OwnershipE2eModule;
}

async function createRequiredTables(dataSource: DataSource): Promise<void> {
  const tables = [
    `CREATE TABLE users (
      id varchar(36) NOT NULL PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      nickname varchar(100) NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE projects (
      id varchar(36) NOT NULL PRIMARY KEY,
      user_id varchar(36) NOT NULL,
      name varchar(255) NOT NULL,
      type varchar(50) NULL,
      target_audience text NULL,
      target_chapters int NOT NULL,
      style varchar(50) NOT NULL,
      status varchar(20) NOT NULL,
      description text NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE project_states (
      id varchar(36) NOT NULL PRIMARY KEY,
      project_id varchar(36) NOT NULL UNIQUE,
      current_directory_version_id varchar(36) NULL,
      completed_chapters json NULL,
      in_progress_chapter varchar(255) NULL,
      in_progress_section varchar(255) NULL,
      pending_items json NULL,
      material_gaps json NULL,
      user_notes text NULL,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE directory_versions (
      id varchar(36) NOT NULL PRIMARY KEY,
      project_id varchar(36) NOT NULL,
      version_number int NOT NULL,
      content json NOT NULL,
      is_current tinyint NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE outline_versions (
      id varchar(36) NOT NULL PRIMARY KEY,
      project_id varchar(36) NOT NULL,
      chapter_node_id varchar(100) NOT NULL,
      section_node_id varchar(100) NULL,
      chapter_index int NOT NULL,
      chapter_title varchar(500) NOT NULL,
      version_number int NOT NULL,
      content json NOT NULL,
      is_current tinyint NOT NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE writing_results (
      id varchar(36) NOT NULL PRIMARY KEY,
      project_id varchar(36) NOT NULL,
      session_id varchar(36) NULL,
      chapter_node_id varchar(100) NULL,
      section_node_id varchar(100) NULL,
      chapter_index int NULL,
      chapter_title varchar(500) NULL,
      section_title varchar(500) NULL,
      task_type varchar(30) NOT NULL,
      status varchar(20) NOT NULL,
      content_text text NOT NULL,
      word_count int NULL,
      style varchar(50) NULL,
      version_number int NOT NULL,
      parent_result_id varchar(36) NULL,
      error_message text NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at datetime NULL
    )`,
    `CREATE TABLE style_templates (
      id varchar(36) NOT NULL PRIMARY KEY,
      name varchar(255) NOT NULL,
      project_id varchar(36) NOT NULL,
      file_path varchar(1024) NULL,
      reference_file_ids json NULL,
      features json NULL,
      status varchar(20) NOT NULL,
      error_message text NULL,
      created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  ];
  for (const sql of tables) {
    await dataSource.query(sql);
  }
}

describe('project ownership HTTP matrix', () => {
  const schemaName = `write_agent_auth_e2e_${process.pid}_${Date.now()}`;
  let adminConnection: Connection;
  let app: INestApplication;
  let ownerToken: string;
  let otherToken: string;
  let ownerProject: Project;
  let foreignDirectory: DirectoryVersion;
  let foreignOutline: OutlineVersion;
  let foreignResult: WritingResult;
  let foreignTemplate: StyleTemplate;
  let templateRepo: Repository<StyleTemplate>;
  let schemaCreated = false;

  beforeAll(async () => {
    const config = await loadE2eConfig();
    adminConnection = await createConnection({
      host: config.databaseHost,
      port: config.databasePort,
      user: config.databaseUser,
      password: config.databasePassword,
    });
    await adminConnection.query(
      `CREATE DATABASE \`${schemaName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    schemaCreated = true;

    const moduleRef = await Test.createTestingModule({
      imports: [createE2eAppModule(config, schemaName)],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await createRequiredTables(app.get(DataSource));
    await app.init();

    const userRepo = app.get<Repository<User>>(getRepositoryToken(User));
    const projectRepo = app.get<Repository<Project>>(
      getRepositoryToken(Project),
    );
    const directoryRepo = app.get<Repository<DirectoryVersion>>(
      getRepositoryToken(DirectoryVersion),
    );
    const outlineRepo = app.get<Repository<OutlineVersion>>(
      getRepositoryToken(OutlineVersion),
    );
    const resultRepo = app.get<Repository<WritingResult>>(
      getRepositoryToken(WritingResult),
    );
    templateRepo = app.get<Repository<StyleTemplate>>(
      getRepositoryToken(StyleTemplate),
    );

    const owner = await userRepo.save(
      userRepo.create({
        email: 'owner@ownership-e2e.test',
        password_hash: 'hash',
        nickname: 'owner',
      }),
    );
    const other = await userRepo.save(
      userRepo.create({
        email: 'other@ownership-e2e.test',
        password_hash: 'hash',
        nickname: 'other',
      }),
    );
    ownerProject = await projectRepo.save(
      projectRepo.create({
        user_id: owner.id,
        name: 'owner project',
        target_chapters: 1,
        style: '教材',
        status: 'draft' as never,
      }),
    );
    const otherProject = await projectRepo.save(
      projectRepo.create({
        user_id: other.id,
        name: 'other project',
        target_chapters: 1,
        style: '教材',
        status: 'draft' as never,
      }),
    );
    foreignDirectory = await directoryRepo.save(
      directoryRepo.create({
        project_id: otherProject.id,
        version_number: 1,
        content: [],
        is_current: true,
      }),
    );
    foreignOutline = await outlineRepo.save(
      outlineRepo.create({
        project_id: otherProject.id,
        chapter_node_id: 'chapter-1',
        section_node_id: null,
        chapter_index: 0,
        chapter_title: 'foreign chapter',
        version_number: 1,
        content: {},
        is_current: true,
      }),
    );
    foreignResult = await resultRepo.save(
      resultRepo.create({
        project_id: otherProject.id,
        session_id: null,
        chapter_node_id: null,
        section_node_id: null,
        chapter_index: null,
        chapter_title: null,
        section_title: null,
        task_type: TaskType.GENERATE,
        status: WritingResultStatus.SUCCEEDED,
        content_text: 'foreign content',
        word_count: null,
        style: null,
        version_number: 1,
        parent_result_id: null,
        error_message: null,
        completed_at: null,
      }),
    );
    foreignTemplate = await templateRepo.save(
      templateRepo.create({
        name: 'foreign template',
        projectId: otherProject.id,
        filePath: null,
        referenceFileIds: null,
        features: null,
        status: 'completed',
        errorMessage: null,
      }),
    );

    const jwt = app.get(JwtService);
    ownerToken = await jwt.signAsync({ sub: owner.id, email: owner.email });
    otherToken = await jwt.signAsync({ sub: other.id, email: other.email });
  }, 60_000);

  afterAll(async () => {
    await cleanupOwnershipE2e({
      app,
      connection: adminConnection,
      schemaName,
      schemaCreated,
    });
  });

  const asUser = (token: string) => {
    const api = request(app.getHttpServer() as import('node:http').Server);
    const withAuth = <T extends { set(field: string, value: string): T }>(
      requestWithMethod: T,
    ) => requestWithMethod.set('Cookie', `wa_access_token=${token}`);
    return {
      get: (path: string) => withAuth(api.get(path)),
      post: (path: string) => withAuth(api.post(path)),
      patch: (path: string) => withAuth(api.patch(path)),
      delete: (path: string) => withAuth(api.delete(path)),
    };
  };

  it('allows an owner to read their project', async () => {
    await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}`)
      .expect(200);
  });

  it('returns 403 for a foreign project before SSE headers are committed', async () => {
    await asUser(otherToken)
      .post(`/api/projects/${ownerProject.id}/content/generate`)
      .send({ chapter_node_id: 'chapter-1', section_node_id: 'section-1' })
      .expect(403);
    await asUser(otherToken)
      .get(
        `/api/projects/${ownerProject.id}/content/${foreignResult.id}/citations`,
      )
      .expect(403);
  });

  it('returns 404 for resources outside an owned project', async () => {
    await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/directory/${foreignDirectory.id}`)
      .expect(404);
    await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/outline/${foreignOutline.id}`)
      .expect(404);
    await asUser(ownerToken)
      .get(`/api/projects/${ownerProject.id}/content/${foreignResult.id}`)
      .expect(404);
    await asUser(ownerToken)
      .get(
        `/api/projects/${ownerProject.id}/content/${foreignResult.id}/citations`,
      )
      .expect(404);
    await asUser(ownerToken)
      .post(
        `/api/projects/${ownerProject.id}/content/${foreignResult.id}/material-gap`,
      )
      .send({ reason: '素材不足' })
      .expect(404);
    await asUser(ownerToken)
      .get(
        `/api/style-templates/${foreignTemplate.id}?projectId=${ownerProject.id}`,
      )
      .expect(404);
  });

  it('keeps legacy style item calls compatible for an owner', async () => {
    const ownerTemplate = await templateRepo.save(
      templateRepo.create({
        name: 'owner template',
        projectId: ownerProject.id,
        filePath: null,
        referenceFileIds: null,
        features: null,
        status: 'completed',
        errorMessage: null,
      }),
    );
    const response = await asUser(ownerToken)
      .get(`/api/style-templates/${ownerTemplate.id}`)
      .expect(200);
    expect(response.body).toMatchObject({ name: 'owner template' });
  });

  it('persists replacement features before merging panel assignments', async () => {
    const template = await templateRepo.save(
      templateRepo.create({
        name: 'editable template',
        projectId: ownerProject.id,
        filePath: null,
        referenceFileIds: null,
        features: {
          structure_tree: { title: 'old tree', children: [] },
        },
        status: 'completed',
        errorMessage: null,
      }),
    );
    const replacementFeatures = {
      structure_tree: { title: 'replacement tree', children: [] },
    };
    const panelAssignment = { panel_a: [], panel_b: [] };

    await asUser(ownerToken)
      .patch(`/api/style-templates/${template.id}`)
      .send({
        features: replacementFeatures,
        panel_assignment: panelAssignment,
      })
      .expect(200);

    const reloaded = await asUser(ownerToken)
      .get(`/api/style-templates/${template.id}`)
      .expect(200);
    expect((reloaded.body as { features: unknown }).features).toEqual({
      ...replacementFeatures,
      panel_assignment: panelAssignment,
    });
  });

  it('does not delete or mutate a foreign template during style creation or item mutation', async () => {
    await asUser(ownerToken)
      .post('/api/style-templates/analyze-text')
      .send({ projectId: ownerProject.id, textContent: '体例正文' })
      .expect(201);
    await expect(
      templateRepo.findOneByOrFail({ id: foreignTemplate.id }),
    ).resolves.toMatchObject({ projectId: foreignTemplate.projectId });

    await asUser(ownerToken)
      .patch(
        `/api/style-templates/${foreignTemplate.id}?projectId=${ownerProject.id}`,
      )
      .send({ name: 'should not apply' })
      .expect(404);
    await asUser(ownerToken)
      .delete(
        `/api/style-templates/${foreignTemplate.id}?projectId=${ownerProject.id}`,
      )
      .expect(404);
    await expect(
      templateRepo.findOneByOrFail({ id: foreignTemplate.id }),
    ).resolves.toMatchObject({ name: 'foreign template' });
  });
});
