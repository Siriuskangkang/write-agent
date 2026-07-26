/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createConnection, type Connection } from 'mysql2/promise';
import { DataSource, type MigrationInterface, type Repository } from 'typeorm';
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
import { AddModelRunAttempts1712600000000 } from '../migrations/1712600000000-AddModelRunAttempts.js';
import { AddStructuredIngestion1712700000000 } from '../migrations/1712700000000-AddStructuredIngestion.js';
import { AddParseAttemptLeases1712800000000 } from '../migrations/1712800000000-AddParseAttemptLeases.js';
import { CreateHybridRetrieval1712900000000 } from '../migrations/1712900000000-CreateHybridRetrieval.js';
import { ChunkService } from '../src/chunk/chunk.service.js';
import { Chunk } from '../src/chunk/entities/chunk.entity.js';
import { Document } from '../src/file/entities/document.entity.js';
import { SourceFile } from '../src/file/entities/source-file.entity.js';
import type { ParseResult } from '../src/file/parsers/document-ast.js';
import { StructuredIngestionService } from '../src/file/structured-ingestion.service.js';
import { ParseWorker } from '../src/file/parse.worker.js';
import { FileType, ParseStatus } from '../src/common/enums.js';

const MYSQL_PASSWORD = 'structured-ingestion-password';
const containerName = `write-agent-ingestion-${process.pid}-${Date.now()}`;
const preStructuredMigrations: Array<new () => MigrationInterface> = [
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
  AddModelRunAttempts1712600000000,
];

describe('structured ingestion on MySQL 8.4', () => {
  let admin: Connection;
  let mysqlPort: number;

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
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        admin = await createConnection({
          host: '127.0.0.1',
          port: mysqlPort,
          user: 'root',
          password: MYSQL_PASSWORD,
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('MySQL fixture did not become ready');
  }, 90_000);

  afterAll(async () => {
    await admin?.end();
    try {
      execFileSync('docker', ['rm', '--force', containerName]);
    } catch {
      // --rm may have removed it.
    }
  });

  it('deduplicates concurrent/repeated consumption and atomically switches versions', async () => {
    const schema = `ingestion_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createDataSource(schema, [
      ...preStructuredMigrations,
      AddStructuredIngestion1712700000000,
      AddParseAttemptLeases1712800000000,
      CreateHybridRetrieval1712900000000,
    ]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const checksum = 'a'.repeat(64);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await seedSource(dataSource, { userId, projectId, fileId, checksum });
      const chunkService = new ChunkService(
        dataSource.getRepository(Chunk),
        {} as never,
      );
      const service = new StructuredIngestionService(
        dataSource,
        chunkService,
        noopIndexActivation(),
      );
      const first = parseResult('markdown-ast-1');
      await beginAttempt(dataSource, fileId, 1, 'attempt-1');

      const concurrent = await Promise.allSettled([
        service.activate({
          file_id: fileId,
          project_id: projectId,
          source_checksum: checksum,
          parse_generation: 1,
          attempt_token: 'attempt-1',
          result: first,
        }),
        service.activate({
          file_id: fileId,
          project_id: projectId,
          source_checksum: checksum,
          parse_generation: 1,
          attempt_token: 'attempt-1',
          result: first,
        }),
      ]);
      expect(
        concurrent.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        concurrent.filter((result) => result.status === 'rejected'),
      ).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ message: 'Stale parse attempt' }),
        }),
      ]);
      expect(await dataSource.getRepository(Document).count()).toBe(1);
      expect(await dataSource.getRepository(Chunk).count()).toBe(2);

      await dataSource.getRepository(SourceFile).update(fileId, {
        parse_generation: 2,
        parse_status: ParseStatus.PENDING,
      });
      await beginAttempt(dataSource, fileId, 2, 'attempt-2');
      await service.activate({
        file_id: fileId,
        project_id: projectId,
        source_checksum: checksum,
        parse_generation: 2,
        attempt_token: 'attempt-2',
        result: parseResult('markdown-ast-2'),
      });

      expect(await dataSource.getRepository(Document).count()).toBe(2);
      expect(
        await dataSource.getRepository(Document).count({
          where: { file_id: fileId, is_active: true },
        }),
      ).toBe(1);
      expect(await dataSource.getRepository(Chunk).count()).toBe(4);
      expect(
        await dataSource.getRepository(Chunk).count({
          where: { file_id: fileId, is_active: true },
        }),
      ).toBe(2);
      await expect(
        chunkService.getChunksByFileId(fileId),
      ).resolves.toHaveLength(1);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('converges a partial upgrade twice without deleting legacy rows', async () => {
    const schema = `ingestion_upgrade_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createDataSource(schema, preStructuredMigrations);
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const documentId = randomUUID();
    const chunkId = randomUUID();

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await seedSource(dataSource, {
        userId,
        projectId,
        fileId,
        checksum: null,
      });
      await dataSource.query(
        `INSERT INTO documents
           (id, file_id, project_id, title, content_text, sections)
         VALUES (?, ?, ?, 'legacy', 'legacy body', JSON_ARRAY())`,
        [documentId, fileId, projectId],
      );
      await dataSource.query(
        `INSERT INTO chunks
           (id, project_id, file_id, document_id, chunk_index, content)
         VALUES (?, ?, ?, ?, 0, 'legacy body')`,
        [chunkId, projectId, fileId, documentId],
      );
      await dataSource.query(
        `ALTER TABLE source_files
           ADD COLUMN checksum_sha256 VARCHAR(32) NULL AFTER file_path`,
      );
      await dataSource.query(
        `ALTER TABLE documents
           ADD COLUMN is_active TINYINT(1) NULL DEFAULT 1 AFTER sections`,
      );
      await dataSource.query(
        `ALTER TABLE chunks
           ADD COLUMN chunk_type VARCHAR(10) NULL AFTER search_terms`,
      );

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        const migration = new AddStructuredIngestion1712700000000();
        await migration.up(runner);
        await migration.up(runner);
      } finally {
        await runner.release();
      }

      await expect(
        dataSource.query('SELECT id FROM source_files WHERE id = ?', [fileId]),
      ).resolves.toHaveLength(1);
      await expect(
        dataSource.query(
          `SELECT parser_version, chunk_version, ingestion_key, is_active
             FROM documents WHERE id = ?`,
          [documentId],
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          parser_version: 'legacy-flat-1',
          chunk_version: 'legacy-char-v1',
          ingestion_key: expect.stringMatching(/^[a-f0-9]{64}$/),
          is_active: 1,
        }),
      ]);
      await expect(
        dataSource.query(
          `SELECT stable_key, tokenizer_version, is_active
             FROM chunks WHERE id = ?`,
          [chunkId],
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          stable_key: expect.stringMatching(/^[a-f0-9]{64}$/),
          tokenizer_version: 'legacy-char-v1',
          is_active: 1,
        }),
      ]);
      await expect(
        dataSource.query(
          `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                  COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
                  COLUMN_DEFAULT AS defaultValue
             FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND (
                (TABLE_NAME = 'source_files'
                  AND COLUMN_NAME = 'checksum_sha256')
                OR
                (TABLE_NAME = 'documents' AND COLUMN_NAME = 'is_active')
                OR
                (TABLE_NAME = 'chunks' AND COLUMN_NAME = 'chunk_type')
              )
            ORDER BY TABLE_NAME`,
        ),
      ).resolves.toEqual([
        {
          tableName: 'chunks',
          columnName: 'chunk_type',
          columnType: 'varchar(20)',
          nullable: 'NO',
          defaultValue: 'child',
        },
        {
          tableName: 'documents',
          columnName: 'is_active',
          columnType: 'tinyint(1)',
          nullable: 'NO',
          defaultValue: '0',
        },
        {
          tableName: 'source_files',
          columnName: 'checksum_sha256',
          columnType: 'char(64)',
          nullable: 'YES',
          defaultValue: null,
        },
      ]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('repairs same-name generated columns, indexes, and foreign keys without deleting rows', async () => {
    const schema = `ingestion_definition_retry_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createDataSource(schema, [
      ...preStructuredMigrations,
      AddStructuredIngestion1712700000000,
      AddParseAttemptLeases1712800000000,
      CreateHybridRetrieval1712900000000,
    ]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const checksum = 'd'.repeat(64);

    try {
      await dataSource.initialize();
      await dataSource.runMigrations();
      await seedSource(dataSource, { userId, projectId, fileId, checksum });
      const chunkService = new ChunkService(
        dataSource.getRepository(Chunk),
        {} as never,
      );
      const service = new StructuredIngestionService(
        dataSource,
        chunkService,
        noopIndexActivation(),
      );
      await beginAttempt(dataSource, fileId, 1, 'definition-attempt');
      await service.activate({
        file_id: fileId,
        project_id: projectId,
        source_checksum: checksum,
        parse_generation: 1,
        attempt_token: 'definition-attempt',
        result: parseResult('markdown-ast-definition-fixture'),
      });

      await dataSource.query(
        `ALTER TABLE documents
           DROP INDEX uq_documents_file_active,
           DROP COLUMN active_marker,
           ADD COLUMN active_marker TINYINT
             GENERATED ALWAYS AS (CASE WHEN is_active = 0 THEN 1 ELSE NULL END) STORED,
           ADD INDEX uq_documents_file_active (active_marker, file_id)`,
      );
      await dataSource.query(
        `ALTER TABLE chunks
           DROP FOREIGN KEY chunks_parent_id_fkey`,
      );
      await dataSource.query(
        `ALTER TABLE chunks
           ADD CONSTRAINT chunks_parent_id_fkey
             FOREIGN KEY (parent_id) REFERENCES chunks(id)
             ON DELETE CASCADE ON UPDATE CASCADE`,
      );

      const runner = dataSource.createQueryRunner();
      await runner.connect();
      try {
        await new AddStructuredIngestion1712700000000().up(runner);
      } finally {
        await runner.release();
      }

      await expect(
        dataSource.query('SELECT id FROM source_files WHERE id = ?', [fileId]),
      ).resolves.toHaveLength(1);
      await expect(
        dataSource.query(
          `SELECT NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS position,
                  COLUMN_NAME AS columnName
             FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'documents'
              AND INDEX_NAME = 'uq_documents_file_active'
            ORDER BY SEQ_IN_INDEX`,
        ),
      ).resolves.toEqual([
        { nonUnique: 0, position: 1, columnName: 'file_id' },
        { nonUnique: 0, position: 2, columnName: 'active_marker' },
      ]);
      await expect(
        dataSource.query(
          `SELECT DELETE_RULE AS deleteRule, UPDATE_RULE AS updateRule
             FROM information_schema.REFERENTIAL_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'chunks'
              AND CONSTRAINT_NAME = 'chunks_parent_id_fkey'`,
        ),
      ).resolves.toEqual([{ deleteRule: 'SET NULL', updateRule: 'NO ACTION' }]);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('fences a failed older parse generation after a newer generation succeeds', async () => {
    const schema = `ingestion_generation_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createDataSource(schema, [
      ...preStructuredMigrations,
      AddStructuredIngestion1712700000000,
      AddParseAttemptLeases1712800000000,
      CreateHybridRetrieval1712900000000,
    ]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const sourceBytes = Buffer.from('# 当前版本');
    const checksum = createHash('sha256').update(sourceBytes).digest('hex');
    const sourcePath = `/tmp/${fileId}.md`;
    const sourceRepo = dataSource.getRepository(SourceFile);

    try {
      await fs.writeFile(sourcePath, sourceBytes);
      await dataSource.initialize();
      await dataSource.runMigrations();
      await seedSource(dataSource, { userId, projectId, fileId, checksum });
      await sourceRepo.update(fileId, {
        file_path: sourcePath,
        file_type: FileType.MD,
        parse_generation: 1,
      });
      const chunkService = new ChunkService(
        dataSource.getRepository(Chunk),
        {} as never,
      );
      const ingestion = new StructuredIngestionService(
        dataSource,
        chunkService,
        noopIndexActivation(),
      );
      const worker = new ParseWorker(sourceRepo, ingestion);
      let rejectOld!: (reason: Error) => void;
      const oldParse = new Promise<ParseResult>((_, reject) => {
        rejectOld = reject;
      });
      let parseCalls = 0;
      (
        worker as unknown as {
          parseByType: () => Promise<ParseResult>;
        }
      ).parseByType = jest.fn(async () => {
        parseCalls += 1;
        return parseCalls === 1
          ? oldParse
          : parseResult('markdown-ast-generation-2');
      });

      const attemptA = worker.handleParse({
        data: { fileId, projectId, parseGeneration: 1 },
      } as never);
      await waitForStatus(sourceRepo, fileId, ParseStatus.PARSING);
      await sourceRepo.update(
        { id: fileId, project_id: projectId, parse_generation: 1 },
        {
          parse_generation: 2,
          parse_status: ParseStatus.PENDING,
          error_message: null,
        },
      );
      await worker.handleParse({
        data: { fileId, projectId, parseGeneration: 2 },
      } as never);
      rejectOld(new Error('older parser failed late'));
      await expect(attemptA).rejects.toThrow('older parser failed late');

      await expect(sourceRepo.findOneByOrFail({ id: fileId })).resolves.toEqual(
        expect.objectContaining({
          parse_generation: 2,
          parse_status: ParseStatus.DONE,
          error_message: null,
        }),
      );
    } finally {
      await fs.rm(sourcePath, { force: true });
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });

  it('recovers an expired same-generation attempt and ignores late failure and DONE redelivery', async () => {
    const schema = `ingestion_attempt_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const dataSource = createDataSource(schema, [
      ...preStructuredMigrations,
      AddStructuredIngestion1712700000000,
      AddParseAttemptLeases1712800000000,
      CreateHybridRetrieval1712900000000,
    ]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const fileId = randomUUID();
    const sourceBytes = Buffer.from('# 当前版本');
    const checksum = createHash('sha256').update(sourceBytes).digest('hex');
    const sourcePath = `/tmp/${fileId}.md`;
    const sourceRepo = dataSource.getRepository(SourceFile);

    try {
      await fs.writeFile(sourcePath, sourceBytes);
      await dataSource.initialize();
      await dataSource.runMigrations();
      await seedSource(dataSource, { userId, projectId, fileId, checksum });
      await sourceRepo.update(fileId, {
        file_path: sourcePath,
        file_type: FileType.MD,
      });
      const worker = new ParseWorker(
        sourceRepo,
        new StructuredIngestionService(
          dataSource,
          new ChunkService(dataSource.getRepository(Chunk), {} as never),
          noopIndexActivation(),
        ),
      );
      let rejectOld!: (reason: Error) => void;
      const oldParse = new Promise<ParseResult>((_, reject) => {
        rejectOld = reject;
      });
      let parseCalls = 0;
      const parseByType = jest.fn(async () => {
        parseCalls += 1;
        if (parseCalls === 1) return oldParse;
        if (parseCalls === 2) return parseResult('markdown-ast-recovered');
        throw new Error('DONE redelivery parsed unexpectedly');
      });
      (
        worker as unknown as {
          parseByType: typeof parseByType;
        }
      ).parseByType = parseByType;

      const oldAttempt = worker.handleParse({
        data: { fileId, projectId, parseGeneration: 1 },
      } as never);
      await waitForStatus(sourceRepo, fileId, ParseStatus.PARSING);
      await waitForCondition(() => parseByType.mock.calls.length === 1);
      const tokenA = (await sourceRepo.findOneByOrFail({ id: fileId }))
        .parse_attempt_token;
      await expect(
        worker.handleParse({
          data: { fileId, projectId, parseGeneration: 1 },
        } as never),
      ).resolves.toBeUndefined();
      expect(parseByType).toHaveBeenCalledTimes(1);
      await expect(sourceRepo.findOneByOrFail({ id: fileId })).resolves.toEqual(
        expect.objectContaining({ parse_attempt_token: tokenA }),
      );
      await dataSource.query(
        `UPDATE source_files
            SET parse_lease_expires_at =
              DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
          WHERE id = ?`,
        [fileId],
      );

      await worker.handleParse({
        data: { fileId, projectId, parseGeneration: 1 },
      } as never);
      rejectOld(new Error('expired attempt failed late'));
      await expect(oldAttempt).rejects.toThrow('expired attempt failed late');
      const completed = await sourceRepo.findOneByOrFail({ id: fileId });
      expect(tokenA).toBeTruthy();
      expect(completed).toEqual(
        expect.objectContaining({
          parse_generation: 1,
          parse_status: ParseStatus.DONE,
          parse_attempt_token: null,
          parse_lease_expires_at: null,
          error_message: null,
        }),
      );

      await expect(
        worker.handleParse({
          data: { fileId, projectId, parseGeneration: 1 },
        } as never),
      ).resolves.toBeUndefined();
      expect(parseByType).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(sourcePath, { force: true });
      if (dataSource.isInitialized) await dataSource.destroy();
      await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    }
  });
});

async function waitForStatus(
  repository: Repository<SourceFile>,
  fileId: string,
  status: ParseStatus,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const source = await repository.findOne({
      where: { id: fileId },
    });
    if (source?.parse_status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Source ${fileId} did not reach ${status}`);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ingestion test condition');
}

async function beginAttempt(
  dataSource: DataSource,
  fileId: string,
  generation: number,
  attemptToken: string,
): Promise<void> {
  await dataSource.query(
    `UPDATE source_files
        SET parse_status = 'parsing',
            parse_attempt_token = ?,
            parse_lease_expires_at =
              DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 3 MINUTE)
      WHERE id = ? AND parse_generation = ?`,
    [attemptToken, fileId, generation],
  );
}

function createDataSource(
  database: string,
  migrations: Array<new () => MigrationInterface>,
): DataSource {
  return new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    port: mysqlPortValue(),
    username: 'root',
    password: MYSQL_PASSWORD,
    database,
    charset: 'utf8mb4',
    timezone: '+00:00',
    entities: [SourceFile, Document, Chunk],
    migrations,
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    extra: { connectionLimit: 5 },
  });
}

function mysqlPortValue(): number {
  const port = execFileSync('docker', ['port', containerName, '3306/tcp'])
    .toString()
    .trim();
  return Number(port.slice(port.lastIndexOf(':') + 1));
}

function noopIndexActivation() {
  return { stage: () => Promise.resolve(undefined) } as never;
}

async function seedSource(
  dataSource: DataSource,
  input: {
    userId: string;
    projectId: string;
    fileId: string;
    checksum: string | null;
  },
): Promise<void> {
  await dataSource.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES (?, ?, 'hash')`,
    [input.userId, `${input.userId}@example.test`],
  );
  await dataSource.query(
    `INSERT INTO projects (id, user_id, name)
     VALUES (?, ?, 'ingestion')`,
    [input.projectId, input.userId],
  );
  const hasChecksum = await dataSource.query<Array<{ present: number }>>(
    `SELECT COUNT(*) AS present
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'source_files'
        AND COLUMN_NAME = 'checksum_sha256'`,
  );
  if (Number(hasChecksum[0]?.present ?? 0) > 0) {
    await dataSource.query(
      `INSERT INTO source_files
         (id, project_id, file_name, file_type, file_path, checksum_sha256)
       VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md', ?)`,
      [input.fileId, input.projectId, input.checksum],
    );
  } else {
    await dataSource.query(
      `INSERT INTO source_files
         (id, project_id, file_name, file_type, file_path)
       VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md')`,
      [input.fileId, input.projectId],
    );
  }
}

function parseResult(parserVersion: string): ParseResult {
  return {
    title: '第一章',
    content_text: '第一章\n\n结构化正文',
    page_count: null,
    sections: [{ title: '第一章', content: '结构化正文' }],
    parser_version: parserVersion,
    ast: {
      version: 'document-ast-v1',
      location: {
        kind: 'none',
        status: 'unavailable',
        reason: 'markdown_has_no_pagination',
      },
      blocks: [
        {
          block_id: 'b'.repeat(64),
          type: 'heading',
          text: '第一章',
          heading_path: ['第一章'],
          page_start: null,
          page_end: null,
          offsets: {
            start: 0,
            end: 3,
            unit: 'utf16_code_unit',
            source: 'content_text',
          },
          metadata: { level: 1 },
        },
        {
          block_id: 'c'.repeat(64),
          type: 'paragraph',
          text: '结构化正文',
          heading_path: ['第一章'],
          page_start: null,
          page_end: null,
          offsets: {
            start: 5,
            end: 10,
            unit: 'utf16_code_unit',
            source: 'content_text',
          },
          metadata: {},
        },
      ],
    },
  };
}
