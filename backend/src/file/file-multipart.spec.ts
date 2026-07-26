import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs/promises';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import { FileController } from './file.controller.js';
import { FileService } from './file.service.js';
import { ProjectUploadGuard } from './guards/project-upload.guard.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FIFTY_MIB = 50 * 1024 * 1024;

jest.setTimeout(120_000);

describe('FileController multipart upload', () => {
  let app: INestApplication;
  let httpServer: Server;
  let uploadRoot: string;
  let fixtureRoot: string;
  let projectAllowed: boolean;
  let uploadFiles: jest.Mock<
    Promise<unknown[]>,
    [string, string, Express.Multer.File[]]
  >;

  beforeEach(async () => {
    uploadRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-multipart-'),
    );
    fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'write-agent-multipart-fixtures-'),
    );
    process.env.UPLOAD_DIR = uploadRoot;
    projectAllowed = true;
    uploadFiles = jest.fn<
      Promise<unknown[]>,
      [string, string, Express.Multer.File[]]
    >(
      async (
        _userId: string,
        _projectId: string,
        files: Express.Multer.File[],
      ) => {
        await Promise.all(files.map((file) => fs.unlink(file.path)));
        return [];
      },
    );

    const testingModule = await Test.createTestingModule({
      controllers: [FileController],
      providers: [{ provide: FileService, useValue: { uploadFiles } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext): boolean {
          const req = context
            .switchToHttp()
            .getRequest<{ user?: { sub: string; email: string } }>();
          req.user = { sub: 'owner-1', email: 'owner@example.test' };
          return true;
        },
      })
      .overrideGuard(ProjectUploadGuard)
      .useValue({
        canActivate(): boolean {
          if (!projectAllowed) {
            throw new ForbiddenException('无权访问该项目');
          }
          return true;
        },
      })
      .compile();

    app = testingModule.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    httpServer = app.getHttpServer() as unknown as Server;
  });

  afterEach(async () => {
    delete process.env.UPLOAD_DIR;
    await app.close();
    await fs.rm(uploadRoot, { recursive: true, force: true });
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('runs the ownership guard before Multer creates its destination', async () => {
    projectAllowed = false;

    await request(httpServer)
      .post(`/api/projects/${PROJECT_ID}/files`)
      .attach('files', Buffer.from('notes'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(403);

    expect(uploadFiles).not.toHaveBeenCalled();
    await expect(listRelativeEntries(uploadRoot)).resolves.toEqual([]);
  });

  it('accepts exactly 50 files', async () => {
    let upload = request(httpServer).post(`/api/projects/${PROJECT_ID}/files`);
    for (let index = 0; index < 50; index += 1) {
      upload = upload.attach('files', Buffer.from(`lesson ${index}`), {
        filename: `lesson-${index}.txt`,
        contentType: 'text/plain',
      });
    }

    await upload.expect(201);

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles.mock.calls[0][2]).toHaveLength(50);
  });

  it('rejects 51 files and removes every partially written file', async () => {
    let upload = request(httpServer).post(`/api/projects/${PROJECT_ID}/files`);
    for (let index = 0; index < 51; index += 1) {
      upload = upload.attach('files', Buffer.from(`lesson ${index}`), {
        filename: `lesson-${index}.txt`,
        contentType: 'text/plain',
      });
    }

    await upload.expect(400);

    expect(uploadFiles).not.toHaveBeenCalled();
    await expect(listRelativeEntries(uploadRoot)).resolves.toEqual([]);
  });

  it('accepts a file of exactly 50 MiB', async () => {
    const exactLimit = path.join(fixtureRoot, 'exact-limit.txt');
    await createSparseFile(exactLimit, FIFTY_MIB);

    await request(httpServer)
      .post(`/api/projects/${PROJECT_ID}/files`)
      .attach('files', exactLimit, {
        filename: 'exact-limit.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles.mock.calls[0][2][0].size).toBe(FIFTY_MIB);
  });

  it('rejects one byte over 50 MiB and removes every partially written file', async () => {
    const overLimit = path.join(fixtureRoot, 'over-limit.txt');
    await createSparseFile(overLimit, FIFTY_MIB + 1);

    await request(httpServer)
      .post(`/api/projects/${PROJECT_ID}/files`)
      .attach('files', Buffer.from('first file'), {
        filename: 'first.txt',
        contentType: 'text/plain',
      })
      .attach('files', overLimit, {
        filename: 'over-limit.txt',
        contentType: 'text/plain',
      })
      .expect(413);

    expect(uploadFiles).not.toHaveBeenCalled();
    await expect(listRelativeEntries(uploadRoot)).resolves.toEqual([]);
  });

  it('removes earlier files when Multer rejects a later declaration', async () => {
    await request(httpServer)
      .post(`/api/projects/${PROJECT_ID}/files`)
      .attach('files', Buffer.from('first file'), {
        filename: 'first.txt',
        contentType: 'text/plain',
      })
      .attach('files', Buffer.from('not executable'), {
        filename: 'second.exe',
        contentType: 'application/octet-stream',
      })
      .expect(400);

    expect(uploadFiles).not.toHaveBeenCalled();
    await expect(listRelativeEntries(uploadRoot)).resolves.toEqual([]);
  });
});

async function createSparseFile(filePath: string, size: number): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

async function listRelativeEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      entries.push(path.relative(root, absolute));
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return entries.sort();
}
