import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CreateHybridRetrieval1712900000000 } from '../../migrations/1712900000000-CreateHybridRetrieval.js';
import { HardenHybridRetrieval1713000000000 } from '../../migrations/1713000000000-HardenHybridRetrieval.js';
import { CompleteHybridRetrievalFencing1713100000000 } from '../../migrations/1713100000000-CompleteHybridRetrievalFencing.js';
import { RetainReactivatableDenseNamespaces1713200000000 } from '../../migrations/1713200000000-RetainReactivatableDenseNamespaces.js';
import { SparseRetriever } from './sparse-retriever.js';
import { RetrievalRun } from './entities/retrieval-run.entity.js';
import { RetrievalCandidateRecord } from './entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from './entities/retrieval-index-version.entity.js';
import { RetrievalPersistenceService } from './retrieval-persistence.service.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { Document } from '../file/entities/document.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { QdrantService } from './qdrant.service.js';
import { DenseIndexService } from './dense-index.service.js';
import { DenseIndexWorker } from './dense-index.worker.js';
import { IndexActivationRecorder } from './index-activation-recorder.js';
import { RetrievalRunIndexVersion } from './entities/retrieval-run-index.entity.js';
import { ProductionEvaluationHarness } from './production-evaluation-harness.js';
import { runEvaluation } from './evaluation-runner.js';
import { DenseIndexGcService } from './dense-index-gc.service.js';
import { DenseRetriever } from './dense-retriever.js';

const mysqlDescribe =
  process.env.RETRIEVAL_MYSQL_TEST === '1' ? describe : describe.skip;

jest.setTimeout(120_000);

mysqlDescribe('hybrid retrieval schema on MySQL 8.4', () => {
  let dataSource: DataSource;
  let projectId: string;
  let fileId: string;
  let documentId: string;
  let firstChunkId: string;
  const qdrantCollection = `write_agent_mysql_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.RETRIEVAL_MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.RETRIEVAL_MYSQL_PORT || 3306),
      username: process.env.RETRIEVAL_MYSQL_USER || 'root',
      password: process.env.RETRIEVAL_MYSQL_PASSWORD || '',
      database: process.env.RETRIEVAL_MYSQL_DATABASE,
      charset: 'utf8mb4',
      timezone: '+08:00',
      migrations: [
        CreateHybridRetrieval1712900000000,
        HardenHybridRetrieval1713000000000,
        CompleteHybridRetrievalFencing1713100000000,
        RetainReactivatableDenseNamespaces1713200000000,
      ],
      entities: [
        RetrievalRun,
        RetrievalCandidateRecord,
        RetrievalIndexVersion,
        RetrievalRunIndexVersion,
        SourceFile,
        Document,
        Chunk,
      ],
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await createPreHybridSchema(dataSource);
    await dataSource.runMigrations();
    projectId = randomUUID();
    const userId = randomUUID();
    fileId = randomUUID();
    documentId = randomUUID();
    firstChunkId = randomUUID();
    await dataSource.query(
      `INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'hash')`,
      [userId, `${userId}@example.test`],
    );
    await dataSource.query(
      `INSERT INTO projects (id, user_id, name) VALUES (?, ?, 'RAG')`,
      [projectId, userId],
    );
    await dataSource.query(
      `INSERT INTO source_files
         (id, project_id, file_name, file_type, file_path,
          active_ingestion_key, parse_status)
       VALUES (?, ?, 'fixture.md', 'md', '/tmp/fixture.md',
               REPEAT('b', 64), 'done')`,
      [fileId, projectId],
    );
    await dataSource.query(
      `INSERT INTO documents
         (id, file_id, project_id, source_checksum, parser_version,
          chunk_version, ingestion_key, ast, is_active)
       VALUES (?, ?, ?, REPEAT('a', 64), 'fixture-v1', 'parent-child-v1',
               REPEAT('b', 64), JSON_OBJECT(), 1)`,
      [documentId, fileId, projectId],
    );
    await dataSource.query(
      `INSERT INTO chunks
         (id, project_id, file_id, document_id, chunk_index, content, search_text,
          section_title, heading_path, stable_key, ingestion_key, chunk_type,
          position, token_count, is_active)
       VALUES
         (?, ?, ?, ?, 0, '闭环控制通过位置检测形成误差反馈',
          '数控机床 进给伺服系统 闭环控制通过位置检测形成误差反馈',
          '进给伺服系统', JSON_ARRAY('数控机床', '进给伺服系统'),
          REPEAT('c', 64), REPEAT('b', 64), 'child', 0, 18, 1),
         (?, ?, ?, ?, 1, '无关的餐饮服务内容',
          '其他 无关的餐饮服务内容',
          '其他', JSON_ARRAY('其他'), REPEAT('d', 64), REPEAT('b', 64),
          'child', 1, 10, 1)`,
      [
        firstChunkId,
        projectId,
        fileId,
        documentId,
        randomUUID(),
        projectId,
        fileId,
        documentId,
      ],
    );
  });

  afterAll(async () => {
    if (process.env.QDRANT_TEST_URL) {
      await fetch(
        `${process.env.QDRANT_TEST_URL}/collections/${qdrantCollection}`,
        { method: 'DELETE' },
      ).catch(() => undefined);
    }
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('installs an ngram FULLTEXT index over content and heading text', async () => {
    const rows = await dataSource.query<Array<Record<string, string>>>(
      `SHOW CREATE TABLE chunks`,
    );
    const createSql = rows[0]['Create Table'];
    expect(createSql).toContain('FULLTEXT KEY `idx_chunks_search_fulltext`');
    expect(createSql).toContain('WITH PARSER `ngram`');
    expect(createSql).toContain('`search_text` longtext NOT NULL');
  });

  it('retrieves Chinese active child evidence without a LIKE fallback', async () => {
    const retriever = new SparseRetriever(dataSource);
    const results = await retriever.search({
      project_id: projectId,
      sparse_query: '闭环控制 位置检测',
      limit: 40,
    });

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('位置检测');
    expect(results[0].heading_path).toEqual(['数控机床', '进给伺服系统']);
  });

  it('creates retrieval runs, candidate score storage and index versions', async () => {
    const tables = await dataSource.query<Array<{ tableName: string }>>(
      `SELECT TABLE_NAME AS tableName
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN
            ('retrieval_runs', 'retrieval_candidates',
             'retrieval_index_versions')
        ORDER BY TABLE_NAME`,
    );
    expect(tables.map((row) => row.tableName)).toEqual([
      'retrieval_candidates',
      'retrieval_index_versions',
      'retrieval_runs',
    ]);
  });

  it('persists run state, all candidate scores and selected exact evidence atomically', async () => {
    const service = new RetrievalPersistenceService(
      dataSource.getRepository(RetrievalRun),
      dataSource.getRepository(RetrievalCandidateRecord),
      dataSource.getRepository(RetrievalIndexVersion),
      dataSource,
      {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_COLLECTION: 'write_agent_chunks',
            EMBEDDING_MODEL: 'fixture-embedding',
            EMBEDDING_DIMENSION: 3,
          })[key] ?? fallback,
      } as never,
    );
    const plan = {
      task_type: 'content' as const,
      intent: 'explanation' as const,
      original_query: '闭环控制',
      sparse_query: '闭环控制',
      dense_query: '闭环控制 原理',
      terms: ['闭环控制'],
    };
    const runId = await service.start({
      project_id: projectId,
      query: '闭环控制',
      task_type: 'content',
      plan,
      mode: 'shadow',
      gate_decision: false,
      canonical_path: 'legacy_like',
      shadow_path: 'hybrid',
    });
    const candidate = {
      chunk_id: '11111111-1111-4111-8111-111111111111',
      project_id: projectId,
      file_id: '22222222-2222-4222-8222-222222222222',
      document_id: '33333333-3333-4333-8333-333333333333',
      ingestion_key: 'b'.repeat(64),
      content: '闭环控制材料',
      section_title: '进给系统',
      heading_path: ['第一章'],
      page_start: 2,
      page_end: 2,
      char_start: 0,
      char_end: 6,
      position: 0,
      token_count: 6,
      source: 'sparse' as const,
      source_score: 3,
      sparse_rank: 1,
      sparse_score: 3,
      dense_rank: 2,
      dense_score: 0.8,
      fusion_score: 0.03,
      fusion_rank: 1,
      rerank_score: 0.9,
      rerank_rank: 1,
    };
    const evidence = {
      evidence_id: `evidence:${candidate.chunk_id}`,
      chunk_id: candidate.chunk_id,
      content: candidate.content,
      exact_span: {
        text: candidate.content,
        char_start: 0,
        char_end: 6,
      },
      source: {
        file_id: candidate.file_id,
        document_id: candidate.document_id,
        ingestion_key: candidate.ingestion_key,
        page_start: 2,
        page_end: 2,
        section_title: '进给系统',
        heading_path: ['第一章'],
      },
      scores: {
        sparse: 3,
        dense: 0.8,
        fusion: 0.03,
        rerank: 0.9,
      },
      ranks: { sparse: 1, dense: 2, fusion: 1, rerank: 1 },
      token_count: 6,
    };

    await service.complete(runId, {
      state: 'READY',
      error_code: null,
      error_message: null,
      latency_ms: 12,
      sparse_count: 1,
      dense_count: 1,
      fused_count: 1,
      legacy_count: 1,
      selected_count: 1,
      embedding_cost_usd: '0.00001000',
      embedding_input_tokens: 5,
      embedding_estimated_cost_usd: null,
      embedding_estimated_input_tokens: null,
      embedding_usage_estimated: false,
      index_versions: [],
      canonical_state: 'READY',
      canonical_latency_ms: 8,
      canonical_count: 1,
      canonical_error_code: null,
      canonical_error_message: null,
      shadow_state: 'READY',
      shadow_latency_ms: 12,
      shadow_count: 1,
      shadow_error_code: null,
      shadow_error_message: null,
      candidates: [candidate],
      evidence: [evidence],
    });

    await expect(
      dataSource.getRepository(RetrievalRun).findOneByOrFail({ id: runId }),
    ).resolves.toMatchObject({
      state: 'READY',
      latency_ms: 12,
      selected_count: 1,
    });
    const storedCandidate = await dataSource
      .getRepository(RetrievalCandidateRecord)
      .findOneByOrFail({ retrieval_run_id: runId });
    expect(storedCandidate).toMatchObject({
      sparse_score: 3,
      dense_score: 0.8,
      selected: true,
    });
    expect(storedCandidate.evidence?.exact_span).toEqual({
      text: '闭环控制材料',
      char_start: 0,
      char_end: 6,
    });
  });

  it('reclaims an expired attempt with a new fence and never reuses job identity', async () => {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          QDRANT_COLLECTION: qdrantCollection,
          EMBEDDING_MODEL: 'fixture-embedding',
          EMBEDDING_DIMENSION: 3,
          RAG_INDEX_VERSION: 'rag-lease-v1',
        })[key] ?? fallback,
    };
    const activation = new IndexActivationRecorder(config as never);
    await dataSource.transaction((manager) =>
      activation.stage(manager, {
        project_id: projectId,
        file_id: fileId,
        document_id: documentId,
        ingestion_key: 'b'.repeat(64),
        chunk_version: 'parent-child-v1',
      }),
    );
    const persistence = new RetrievalPersistenceService(
      dataSource.getRepository(RetrievalRun),
      dataSource.getRepository(RetrievalCandidateRecord),
      dataSource.getRepository(RetrievalIndexVersion),
      dataSource,
      config as never,
    );
    const first = (await persistence.claimDispatchBatch(20)).find(
      (item) => item.index_version === 'rag-lease-v1',
    );
    if (!first) throw new Error('Expected first claim');
    await dataSource.query(
      `UPDATE retrieval_index_versions
          SET status = 'RUNNING',
              lease_expires_at = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6))
        WHERE id = ? AND claim_token = ?`,
      [first.id, first.attempt_token],
    );
    const second = (await persistence.claimDispatchBatch(20)).find(
      (item) => item.id === first.id,
    );
    if (!second) throw new Error('Expected recovery claim');

    expect(second.attempt_token).not.toBe(first.attempt_token);
    expect(second.attempt_count).toBe(first.attempt_count + 1);
    await expect(
      persistence.beginAttempt(first.id, first.attempt_token),
    ).resolves.toBeNull();
    await expect(
      persistence.beginAttempt(second.id, second.attempt_token),
    ).resolves.toMatchObject({
      id: second.id,
      attempt_token: second.attempt_token,
    });
  });

  it('atomically terminalizes an expired final attempt instead of leaving RUNNING forever', async () => {
    const config = {
      get: (key: string, fallback?: unknown) =>
        ({
          QDRANT_COLLECTION: qdrantCollection,
          EMBEDDING_MODEL: 'fixture-embedding',
          EMBEDDING_DIMENSION: 3,
          RAG_INDEX_VERSION: 'rag-terminal-v1',
        })[key] ?? fallback,
    };
    await dataSource.transaction((manager) =>
      new IndexActivationRecorder(config as never).stage(manager, {
        project_id: projectId,
        file_id: fileId,
        document_id: documentId,
        ingestion_key: 'b'.repeat(64),
        chunk_version: 'parent-child-v1',
      }),
    );
    const persistence = new RetrievalPersistenceService(
      dataSource.getRepository(RetrievalRun),
      dataSource.getRepository(RetrievalCandidateRecord),
      dataSource.getRepository(RetrievalIndexVersion),
      dataSource,
      config as never,
    );
    const claim = (await persistence.claimDispatchBatch(20)).find(
      (item) => item.index_version === 'rag-terminal-v1',
    );
    if (!claim) throw new Error('Expected final attempt claim');
    await dataSource.query(
      `UPDATE retrieval_index_versions
          SET status = 'RUNNING',
              max_attempts = attempt_count,
              lease_expires_at =
                TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6))
        WHERE id = ?`,
      [claim.id],
    );

    await persistence.claimDispatchBatch(20);

    await expect(
      dataSource
        .getRepository(RetrievalIndexVersion)
        .findOneByOrFail({ id: claim.id }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      error_code: 'LEASE_EXPIRED_MAX_ATTEMPTS',
      next_retry_at: null,
    });
  });

  const qdrantIt = process.env.QDRANT_TEST_URL ? it : it.skip;
  qdrantIt(
    'fences a blocked old ingestion after a newer ingestion publishes READY',
    async () => {
      const raceFileId = randomUUID();
      const ingestionA = '1'.repeat(64);
      const ingestionB = '2'.repeat(64);
      const documentA = randomUUID();
      const documentB = randomUUID();
      const chunkA = randomUUID();
      const chunkB = randomUUID();
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            active_ingestion_key, parse_status)
         VALUES (?, ?, 'race.md', 'md', '/tmp/race.md', ?, 'done')`,
        [raceFileId, projectId, ingestionA],
      );
      await insertDocumentAndChunk(
        dataSource,
        projectId,
        raceFileId,
        documentA,
        chunkA,
        ingestionA,
        '旧版本闭环控制',
      );
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_URL: process.env.QDRANT_TEST_URL,
            QDRANT_COLLECTION: qdrantCollection,
            QDRANT_TIMEOUT_MS: 5_000,
            EMBEDDING_DIMENSION: 3,
            EMBEDDING_MODEL: 'fixture-embedding',
            RAG_INDEX_VERSION: 'rag-race-v1',
          })[key] ?? fallback,
      };
      const activation = new IndexActivationRecorder(config as never);
      await dataSource.transaction((manager) =>
        activation.stage(manager, {
          project_id: projectId,
          file_id: raceFileId,
          document_id: documentA,
          ingestion_key: ingestionA,
          chunk_version: 'parent-child-v1',
        }),
      );
      const persistence = new RetrievalPersistenceService(
        dataSource.getRepository(RetrievalRun),
        dataSource.getRepository(RetrievalCandidateRecord),
        dataSource.getRepository(RetrievalIndexVersion),
        dataSource,
        config as never,
      );
      const qdrant = new QdrantService(config as never);
      const claimA = (await persistence.claimDispatchBatch(20)).find(
        (item) => item.file_id === raceFileId,
      );
      if (!claimA) throw new Error('Expected ingestion A claim');
      await persistence.beginAttempt(claimA.id, claimA.attempt_token);
      let releaseA!: (value: number[][]) => void;
      const blockedEmbedding = new Promise<number[][]>((resolve) => {
        releaseA = resolve;
      });
      const indexA = new DenseIndexService(
        { generateEmbeddings: () => blockedEmbedding } as never,
        qdrant,
        persistence,
      ).index({
        record_id: claimA.id,
        attempt_token: claimA.attempt_token,
        project_id: projectId,
        file_id: raceFileId,
        document_id: documentA,
        ingestion_key: ingestionA,
        chunk_version: 'parent-child-v1',
        chunks: [
          { id: chunkA, content: '旧版本闭环控制', chunk_type: 'child' },
        ],
      });

      await dataSource.query(
        `UPDATE source_files SET active_ingestion_key = ? WHERE id = ?`,
        [ingestionB, raceFileId],
      );
      await dataSource.query(
        `UPDATE chunks SET is_active = 0 WHERE file_id = ?`,
        [raceFileId],
      );
      await insertDocumentAndChunk(
        dataSource,
        projectId,
        raceFileId,
        documentB,
        chunkB,
        ingestionB,
        '新版本位置检测反馈',
      );
      await dataSource.transaction((manager) =>
        activation.stage(manager, {
          project_id: projectId,
          file_id: raceFileId,
          document_id: documentB,
          ingestion_key: ingestionB,
          chunk_version: 'parent-child-v1',
        }),
      );
      const claimB = (await persistence.claimDispatchBatch(20)).find(
        (item) =>
          item.file_id === raceFileId && item.ingestion_key === ingestionB,
      );
      if (!claimB) throw new Error('Expected ingestion B claim');
      await persistence.beginAttempt(claimB.id, claimB.attempt_token);
      await new DenseIndexService(
        {
          generateEmbeddings: () => Promise.resolve([[1, 0, 0]]),
        } as never,
        qdrant,
        persistence,
      ).index({
        record_id: claimB.id,
        attempt_token: claimB.attempt_token,
        project_id: projectId,
        file_id: raceFileId,
        document_id: documentB,
        ingestion_key: ingestionB,
        chunk_version: 'parent-child-v1',
        chunks: [
          { id: chunkB, content: '新版本位置检测反馈', chunk_type: 'child' },
        ],
      });
      releaseA([[0, 1, 0]]);
      await indexA;

      await expect(
        dataSource
          .getRepository(RetrievalIndexVersion)
          .findOneByOrFail({ id: claimA.id }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        error_code: 'STALE_INDEX_VERSION',
      });
      await expect(
        dataSource
          .getRepository(RetrievalIndexVersion)
          .findOneByOrFail({ id: claimB.id }),
      ).resolves.toMatchObject({ status: 'READY' });
      const results = await qdrant.search(projectId, [1, 0, 0], 40, [
        `${claimB.id}:${claimB.attempt_token}`,
      ]);
      expect(results.map((item) => item.payload.chunk_id)).toEqual([chunkB]);
    },
  );

  qdrantIt(
    'runs a staged dense-index job against real MySQL and Qdrant',
    async () => {
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_URL: process.env.QDRANT_TEST_URL,
            QDRANT_COLLECTION: qdrantCollection,
            QDRANT_TIMEOUT_MS: 5_000,
            EMBEDDING_DIMENSION: 3,
            EMBEDDING_MODEL: 'fixture-embedding',
            RAG_INDEX_VERSION: 'rag-integration-v1',
          })[key] ?? fallback,
      };
      const activation = new IndexActivationRecorder(config as never);
      await dataSource.transaction((manager) =>
        activation.stage(manager, {
          project_id: projectId,
          file_id: fileId,
          document_id: documentId,
          ingestion_key: 'b'.repeat(64),
          chunk_version: 'parent-child-v1',
        }),
      );
      const persistence = new RetrievalPersistenceService(
        dataSource.getRepository(RetrievalRun),
        dataSource.getRepository(RetrievalCandidateRecord),
        dataSource.getRepository(RetrievalIndexVersion),
        dataSource,
        config as never,
      );
      const qdrant = new QdrantService(config as never);
      const indexer = new DenseIndexService(
        {
          generateEmbeddings: (inputs: string[]) =>
            Promise.resolve(inputs.map((_input, index) => [1, index / 10, 0])),
        } as never,
        qdrant,
        persistence,
      );
      const row = await dataSource
        .getRepository(RetrievalIndexVersion)
        .findOneByOrFail({
          file_id: fileId,
          ingestion_key: 'b'.repeat(64),
          index_version: 'rag-integration-v1',
        });
      const worker = new DenseIndexWorker(
        persistence,
        dataSource.getRepository(Chunk),
        indexer,
      );
      const claim = (await persistence.claimDispatchBatch(20)).find(
        (item) => item.id === row.id,
      );
      if (!claim) throw new Error('Expected a dense index claim');
      await worker.handle({
        data: {
          indexVersionId: row.id,
          attemptToken: claim.attempt_token,
          attempt: claim.attempt_count,
        },
      } as never);

      await expect(
        dataSource
          .getRepository(RetrievalIndexVersion)
          .findOneByOrFail({ id: row.id }),
      ).resolves.toMatchObject({ status: 'READY', point_count: 2 });
      await expect(
        qdrant.search(projectId, [1, 0, 0], 40, [
          `${row.id}:${claim.attempt_token}`,
        ]),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            payload: expect.objectContaining({ chunk_id: firstChunkId }),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            vector: expect.any(Array),
          }),
        ]),
      );
    },
  );

  qdrantIt(
    'degrades when a real READY point is deleted after coverage count but before vector search',
    async () => {
      const isolatedUserId = randomUUID();
      const isolatedProjectId = randomUUID();
      const isolatedFileId = randomUUID();
      const isolatedDocumentId = randomUUID();
      const isolatedChunkId = randomUUID();
      const isolatedIngestion = '6'.repeat(64);
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'hash')`,
        [isolatedUserId, `${isolatedUserId}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO projects (id, user_id, name)
         VALUES (?, ?, 'Dense TOCTOU')`,
        [isolatedProjectId, isolatedUserId],
      );
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            active_ingestion_key, parse_status)
         VALUES (?, ?, 'dense-race.md', 'md', '/tmp/dense-race.md', ?, 'done')`,
        [isolatedFileId, isolatedProjectId, isolatedIngestion],
      );
      await insertDocumentAndChunk(
        dataSource,
        isolatedProjectId,
        isolatedFileId,
        isolatedDocumentId,
        isolatedChunkId,
        isolatedIngestion,
        '闭环控制位置反馈',
      );
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_URL: process.env.QDRANT_TEST_URL,
            QDRANT_COLLECTION: qdrantCollection,
            QDRANT_TIMEOUT_MS: 5_000,
            EMBEDDING_DIMENSION: 3,
            EMBEDDING_MODEL: 'fixture-embedding',
            RAG_INDEX_VERSION: 'rag-integration-v1',
          })[key] ?? fallback,
      };
      const activation = new IndexActivationRecorder(config as never);
      await dataSource.transaction((manager) =>
        activation.stage(manager, {
          project_id: isolatedProjectId,
          file_id: isolatedFileId,
          document_id: isolatedDocumentId,
          ingestion_key: isolatedIngestion,
          chunk_version: 'parent-child-v1',
        }),
      );
      const persistence = new RetrievalPersistenceService(
        dataSource.getRepository(RetrievalRun),
        dataSource.getRepository(RetrievalCandidateRecord),
        dataSource.getRepository(RetrievalIndexVersion),
        dataSource,
        config as never,
      );
      const qdrant = new QdrantService(config as never);
      const row = await dataSource
        .getRepository(RetrievalIndexVersion)
        .findOneByOrFail({
          file_id: isolatedFileId,
          ingestion_key: isolatedIngestion,
          index_version: 'rag-integration-v1',
        });
      const claim = await persistence.claimSpecificIndex(row.id);
      if (!claim) throw new Error('Expected dense TOCTOU claim');
      await persistence.beginAttempt(claim.id, claim.attempt_token);
      await new DenseIndexService(
        {
          generateEmbeddings: () => Promise.resolve([[1, 0, 0]]),
        } as never,
        qdrant,
        persistence,
      ).index({
        record_id: claim.id,
        attempt_token: claim.attempt_token,
        project_id: isolatedProjectId,
        file_id: isolatedFileId,
        document_id: isolatedDocumentId,
        ingestion_key: isolatedIngestion,
        chunk_version: 'parent-child-v1',
        chunks: [
          {
            id: isolatedChunkId,
            content: '闭环控制位置反馈',
            chunk_type: 'child',
          },
        ],
      });
      const readyRow = await dataSource
        .getRepository(RetrievalIndexVersion)
        .findOneByOrFail({ id: row.id });
      const namespace = readyRow.published_namespace as string;
      const racingQdrant = {
        configuredIndexVersion: qdrant.configuredIndexVersion,
        countNamespaces: async (
          currentProject: string,
          namespaces: string[],
        ) => {
          const counts = await qdrant.countNamespaces(
            currentProject,
            namespaces,
          );
          await qdrant.deleteNamespace(namespace);
          return counts;
        },
        search: (
          currentProject: string,
          vector: number[],
          limit: number,
          namespaces: string[],
        ) => qdrant.search(currentProject, vector, limit, namespaces),
      };
      const retriever = new DenseRetriever(
        {
          generateEmbeddingDetailed: () =>
            Promise.resolve({ vector: [1, 0, 0], usage: null }),
        } as never,
        racingQdrant as never,
        dataSource,
      );

      await expect(
        retriever.search({
          project_id: isolatedProjectId,
          task_type: 'content',
          intent: 'explanation',
          original_query: '闭环控制',
          sparse_query: '闭环控制',
          dense_query: '闭环控制',
          terms: ['闭环控制'],
          limit: 40,
        }),
      ).resolves.toMatchObject({
        state: 'unavailable',
        error_code: 'INDEX_POINTS_MISSING',
        index_versions: [
          expect.objectContaining({
            id: row.id,
            expected_point_count: 1,
            observed_point_count: 0,
          }),
        ],
      });
    },
  );

  qdrantIt(
    'retains an old READY namespace as debt even when it is later reactivated',
    async () => {
      const gcFileId = randomUUID();
      const ingestionB = '4'.repeat(64);
      const ingestionC = '5'.repeat(64);
      const documentB = randomUUID();
      const documentC = randomUUID();
      const chunkB = randomUUID();
      const chunkC = randomUUID();
      await dataSource.query(
        `INSERT INTO source_files
           (id, project_id, file_name, file_type, file_path,
            active_ingestion_key, parse_status)
         VALUES (?, ?, 'gc.md', 'md', '/tmp/gc.md', ?, 'done')`,
        [gcFileId, projectId, ingestionB],
      );
      await insertDocumentAndChunk(
        dataSource,
        projectId,
        gcFileId,
        documentB,
        chunkB,
        ingestionB,
        'B版本闭环控制',
      );
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_URL: process.env.QDRANT_TEST_URL,
            QDRANT_COLLECTION: qdrantCollection,
            QDRANT_TIMEOUT_MS: 5_000,
            EMBEDDING_DIMENSION: 3,
            EMBEDDING_MODEL: 'fixture-embedding',
            RAG_INDEX_VERSION: 'rag-gc-v1',
          })[key] ?? fallback,
      };
      const activation = new IndexActivationRecorder(config as never);
      const persistence = new RetrievalPersistenceService(
        dataSource.getRepository(RetrievalRun),
        dataSource.getRepository(RetrievalCandidateRecord),
        dataSource.getRepository(RetrievalIndexVersion),
        dataSource,
        config as never,
      );
      const qdrant = new QdrantService(config as never);
      const publish = async (
        document: string,
        chunk: string,
        ingestion: string,
        vector: number[],
      ) => {
        await dataSource.transaction((manager) =>
          activation.stage(manager, {
            project_id: projectId,
            file_id: gcFileId,
            document_id: document,
            ingestion_key: ingestion,
            chunk_version: 'parent-child-v1',
          }),
        );
        const row = await dataSource
          .getRepository(RetrievalIndexVersion)
          .findOneByOrFail({
            file_id: gcFileId,
            ingestion_key: ingestion,
            index_version: 'rag-gc-v1',
          });
        const claim = await persistence.claimSpecificIndex(row.id);
        if (!claim) throw new Error('Expected GC race claim');
        await persistence.beginAttempt(claim.id, claim.attempt_token);
        await new DenseIndexService(
          {
            generateEmbeddings: () => Promise.resolve([vector]),
          } as never,
          qdrant,
          persistence,
        ).index({
          record_id: claim.id,
          attempt_token: claim.attempt_token,
          project_id: projectId,
          file_id: gcFileId,
          document_id: document,
          ingestion_key: ingestion,
          chunk_version: 'parent-child-v1',
          chunks: [{ id: chunk, content: ingestion, chunk_type: 'child' }],
        });
        return `${claim.id}:${claim.attempt_token}`;
      };
      const namespaceB = await publish(
        documentB,
        chunkB,
        ingestionB,
        [0, 1, 0],
      );
      await dataSource.query(
        `UPDATE source_files SET active_ingestion_key = ? WHERE id = ?`,
        [ingestionC, gcFileId],
      );
      await dataSource.query(
        `UPDATE chunks SET is_active = 0 WHERE file_id = ?`,
        [gcFileId],
      );
      await insertDocumentAndChunk(
        dataSource,
        projectId,
        gcFileId,
        documentC,
        chunkC,
        ingestionC,
        'C版本位置反馈',
      );
      const namespaceC = await publish(
        documentC,
        chunkC,
        ingestionC,
        [1, 0, 0],
      );

      await new DenseIndexGcService(persistence).collect();

      await expect(
        dataSource.getRepository(RetrievalIndexVersion).findOneByOrFail({
          file_id: gcFileId,
          ingestion_key: ingestionB,
          index_version: 'rag-gc-v1',
        }),
      ).resolves.toMatchObject({
        retention_debt_reason: 'REACTIVATABLE_NAMESPACE_RETAINED',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        retention_debt_recorded_at: expect.any(Date),
      });
      await dataSource.query(
        `UPDATE source_files SET active_ingestion_key = ? WHERE id = ?`,
        [ingestionB, gcFileId],
      );
      await new DenseIndexGcService(persistence).collect();
      await expect(
        qdrant.countNamespaces(projectId, [namespaceB, namespaceC]),
      ).resolves.toEqual(
        new Map([
          [namespaceB, 1],
          [namespaceC, 1],
        ]),
      );
      await expect(
        qdrant.search(projectId, [0, 1, 0], 40, [namespaceB]),
      ).resolves.toEqual([
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          payload: expect.objectContaining({ chunk_id: chunkB }),
        }),
      ]);
    },
  );

  qdrantIt(
    'runs and cleans a production evaluation through the online hybrid orchestration',
    async () => {
      const config = {
        get: (key: string, fallback?: unknown) =>
          ({
            QDRANT_URL: process.env.QDRANT_TEST_URL,
            QDRANT_COLLECTION: qdrantCollection,
            QDRANT_TIMEOUT_MS: 5_000,
            EMBEDDING_DIMENSION: 3,
            EMBEDDING_MODEL: 'fixture-embedding',
            EMBEDDING_PRICE_PER_MILLION_USD: 1,
            RAG_INDEX_VERSION: 'rag-production-eval-v1',
          })[key] ?? fallback,
      };
      const embeddings = {
        configuredModel: 'fixture-embedding',
        configuredPricePerMillionUsd: 1,
        generateEmbeddingsDetailed: (inputs: string[]) =>
          Promise.resolve({
            vectors: inputs.map((input) =>
              input.includes('餐饮') ? [0, 1, 0] : [1, 0, 0],
            ),
            usage: {
              input_tokens: Math.max(1, inputs.length * 3),
              source: 'actual' as const,
            },
          }),
        generateEmbeddingDetailed: (input: string) =>
          Promise.resolve({
            vector: input.includes('餐饮') ? [0, 1, 0] : [1, 0, 0],
            usage: { input_tokens: 3, source: 'actual' as const },
          }),
      };
      const harness = new ProductionEvaluationHarness(
        dataSource,
        config as never,
        embeddings as never,
        new QdrantService(config as never),
      );
      const relevantId = randomUUID();
      const noiseId = randomUUID();
      await harness.initialize();
      try {
        const report = await runEvaluation(
          {
            dataset: 'production-harness-fixture',
            k: 2,
            corpus: [
              {
                chunk_id: relevantId,
                file_id: 'servo',
                content: '闭环控制通过位置检测反馈误差',
              },
              {
                chunk_id: noiseId,
                file_id: 'food',
                content: '餐饮服务卫生规范',
              },
            ],
            judgments: [
              {
                id: 'q1',
                query: '闭环控制位置检测',
                relevant_chunk_ids: [relevantId],
              },
            ],
          },
          harness.createPipeline(),
          { max_latency_p95_ms: 5_000 },
          {
            code_commit: 'fixture-commit',
            index_version: 'rag-production-eval-v1',
            collection_name: qdrantCollection,
            embedding_model: 'fixture-embedding',
            embedding_dimension: 3,
            retrieval_config_hash: 'c'.repeat(64),
            generated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        );
        expect(report.source).toBe('mysql-qdrant-production-v1');
        expect(report.traces[0]?.hybrid.ranked_chunk_ids).toContain(relevantId);
      } finally {
        await harness.cleanup();
      }
      const rows = await dataSource.query<Array<{ count: string | number }>>(
        `SELECT COUNT(*) AS count FROM projects WHERE id = ?`,
        [harness.projectId],
      );
      expect(Number(rows[0]?.count ?? -1)).toBe(0);
    },
  );
});

async function insertDocumentAndChunk(
  dataSource: DataSource,
  projectId: string,
  fileId: string,
  documentId: string,
  chunkId: string,
  ingestionKey: string,
  content: string,
): Promise<void> {
  await dataSource.query(
    `INSERT INTO documents
       (id, file_id, project_id, source_checksum, parser_version,
        chunk_version, ingestion_key, ast, is_active)
     VALUES (?, ?, ?, REPEAT('a', 64), 'fixture-v1', 'parent-child-v1',
             ?, JSON_OBJECT(), 1)`,
    [documentId, fileId, projectId, ingestionKey],
  );
  await dataSource.query(
    `INSERT INTO chunks
       (id, project_id, file_id, document_id, chunk_index, content, search_text,
        stable_key, ingestion_key, chunk_type, position, token_count, is_active)
     VALUES (?, ?, ?, ?, 0, ?, ?, SHA2(CONCAT(?, ?), 256), ?,
             'child', 0, 10, 1)`,
    [
      chunkId,
      projectId,
      fileId,
      documentId,
      content,
      content,
      documentId,
      ingestionKey,
      ingestionKey,
    ],
  );
}

async function createPreHybridSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    CREATE TABLE users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      nickname VARCHAR(100) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await dataSource.query(`
    CREATE TABLE projects (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) NULL,
      target_audience TEXT NULL,
      target_chapters INT NOT NULL DEFAULT 10,
      style VARCHAR(50) NOT NULL DEFAULT '教材',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      description TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await dataSource.query(`
    CREATE TABLE source_files (
      id VARCHAR(36) PRIMARY KEY,
      project_id VARCHAR(36) NOT NULL,
      file_name VARCHAR(500) NOT NULL,
      file_type VARCHAR(20) NOT NULL,
      file_size BIGINT NULL,
      file_path VARCHAR(1000) NOT NULL,
      checksum_sha256 CHAR(64) NULL,
      active_ingestion_key CHAR(64) NULL,
      parse_generation INT NOT NULL DEFAULT 1,
      parse_attempt_token CHAR(36) NULL,
      parse_lease_expires_at DATETIME(6) NULL,
      parse_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      error_message TEXT NULL,
      uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await dataSource.query(`
    CREATE TABLE documents (
      id VARCHAR(36) PRIMARY KEY,
      file_id VARCHAR(36) NOT NULL,
      project_id VARCHAR(36) NOT NULL,
      title VARCHAR(500) NULL,
      content_text TEXT NULL,
      page_count INT NULL,
      sections JSON NULL,
      source_checksum CHAR(64) NOT NULL,
      parser_version VARCHAR(50) NOT NULL,
      chunk_version VARCHAR(50) NOT NULL,
      ingestion_key CHAR(64) NOT NULL,
      ast JSON NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      parsed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  await dataSource.query(`
    CREATE TABLE chunks (
      id VARCHAR(36) PRIMARY KEY,
      project_id VARCHAR(36) NOT NULL,
      file_id VARCHAR(36) NOT NULL,
      document_id VARCHAR(36) NOT NULL,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL,
      section_title VARCHAR(500) NULL,
      page_number INT NULL,
      keywords JSON NULL,
      search_terms JSON NULL,
      stable_key CHAR(64) NULL,
      ingestion_key CHAR(64) NULL,
      chunk_type VARCHAR(20) NOT NULL DEFAULT 'child',
      parent_id VARCHAR(36) NULL,
      position INT NOT NULL DEFAULT 0,
      token_count INT NOT NULL DEFAULT 0,
      tokenizer_version VARCHAR(50) NOT NULL DEFAULT 'legacy-char-v1',
      overlap_previous_tokens INT NOT NULL DEFAULT 0,
      heading_path JSON NULL,
      page_start INT NULL,
      page_end INT NULL,
      block_ids JSON NULL,
      char_start INT NULL,
      char_end INT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FULLTEXT KEY idx_chunks_content_fulltext (content)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
}
