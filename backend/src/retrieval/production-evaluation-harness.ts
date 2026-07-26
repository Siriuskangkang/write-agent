import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { EmbeddingService } from '../embedding/embedding.service.js';
import { Document } from '../file/entities/document.entity.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { DenseIndexService } from './dense-index.service.js';
import { DenseIndexWorker } from './dense-index.worker.js';
import { DenseRetriever } from './dense-retriever.js';
import { RetrievalCandidateRecord } from './entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from './entities/retrieval-index-version.entity.js';
import { RetrievalRunIndexVersion } from './entities/retrieval-run-index.entity.js';
import { RetrievalRun } from './entities/retrieval-run.entity.js';
import type {
  EvaluationCorpusIndexer,
  RetrievalEvaluationDataset,
} from './evaluation-runner.js';
import { MysqlQdrantEvaluationPipeline } from './evaluation-runner.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { IndexActivationRecorder } from './index-activation-recorder.js';
import { LegacyShadowRetriever } from './legacy-shadow-retriever.js';
import { NeighborExpander } from './neighbor-expander.js';
import { QdrantService } from './qdrant.service.js';
import { RetrievalPersistenceService } from './retrieval-persistence.service.js';
import { SparseRetriever } from './sparse-retriever.js';

export class ProductionEvaluationHarness implements EvaluationCorpusIndexer {
  readonly projectId = randomUUID();
  private readonly userId = randomUUID();
  private readonly persistence: RetrievalPersistenceService;
  private initialized = false;
  private ingested = false;
  private readonly attemptedNamespaces = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly embeddings: EmbeddingService,
    private readonly qdrant: QdrantService,
  ) {
    this.persistence = new RetrievalPersistenceService(
      dataSource.getRepository(RetrievalRun),
      dataSource.getRepository(RetrievalCandidateRecord),
      dataSource.getRepository(RetrievalIndexVersion),
      dataSource,
      config,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO users (id, email, password_hash, nickname)
         VALUES (?, ?, ?, 'RAG evaluation')`,
        [
          this.userId,
          `rag-evaluation-${this.userId}@invalid.local`,
          'evaluation-account-not-login-capable',
        ],
      );
      await manager.query(
        `INSERT INTO projects
           (id, user_id, name, type, target_chapters, style, status)
         VALUES (?, ?, 'RAG production evaluation', 'evaluation', 1,
                 '教材', 'draft')`,
        [this.projectId, this.userId],
      );
    });
    this.initialized = true;
  }

  createPipeline(): MysqlQdrantEvaluationPipeline {
    if (!this.initialized) {
      throw new Error('Production evaluation harness is not initialized');
    }
    const legacy = new LegacyShadowRetriever(this.dataSource);
    const hybrid = new HybridRetriever(
      new SparseRetriever(this.dataSource),
      new DenseRetriever(this.embeddings, this.qdrant, this.dataSource),
      legacy,
      this.persistence,
      new NeighborExpander(this.dataSource),
    );
    return new MysqlQdrantEvaluationPipeline(
      this.projectId,
      this,
      hybrid,
      legacy,
    );
  }

  async replaceCorpus(
    corpus: RetrievalEvaluationDataset['corpus'],
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('Production evaluation harness is not initialized');
    }
    if (this.ingested) {
      throw new Error('Production evaluation corpus can only be ingested once');
    }
    const grouped = new Map<string, RetrievalEvaluationDataset['corpus']>();
    for (const item of corpus) {
      const values = grouped.get(item.file_id) ?? [];
      values.push(item);
      grouped.set(item.file_id, values);
    }
    const stagedIds: string[] = [];
    const activation = new IndexActivationRecorder(this.config);
    for (const [fixtureFileId, items] of grouped) {
      const fileId = randomUUID();
      const documentId = randomUUID();
      const ingestionKey = sha256(
        `${this.projectId}:${fixtureFileId}:${JSON.stringify(items)}`,
      );
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO source_files
             (id, project_id, file_name, file_type, file_size, file_path,
              checksum_sha256, active_ingestion_key, parse_status)
           VALUES (?, ?, ?, 'md', ?, ?, ?, ?, 'done')`,
          [
            fileId,
            this.projectId,
            `evaluation-${fixtureFileId}.md`,
            items.reduce((sum, item) => sum + item.content.length, 0),
            `/evaluation/${fixtureFileId}.md`,
            sha256(items.map((item) => item.content).join('\n')),
            ingestionKey,
          ],
        );
        await manager.query(
          `INSERT INTO documents
             (id, file_id, project_id, title, content_text, source_checksum,
              parser_version, chunk_version, ingestion_key, ast, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 'evaluation-v1', 'parent-child-v1',
                   ?, JSON_OBJECT('version', 'evaluation-v1', 'blocks',
                                  JSON_ARRAY()), 1)`,
          [
            documentId,
            fileId,
            this.projectId,
            fixtureFileId,
            items.map((item) => item.content).join('\n'),
            sha256(items.map((item) => item.content).join('\n')),
            ingestionKey,
          ],
        );
        for (const [position, item] of items.entries()) {
          await manager.query(
            `INSERT INTO chunks
               (id, project_id, file_id, document_id, chunk_index, content,
                search_text, section_title, stable_key, ingestion_key,
                chunk_type, position, token_count, tokenizer_version,
                heading_path, char_start, char_end, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'child', ?, ?,
                     'evaluation-v1', ?, 0, ?, 1)`,
            [
              item.chunk_id,
              this.projectId,
              fileId,
              documentId,
              position,
              item.content,
              `${(item.heading_path ?? []).join(' ')} ${item.content}`,
              item.heading_path?.at(-1) ?? null,
              sha256(`${documentId}:${item.chunk_id}`),
              ingestionKey,
              position,
              Math.max(1, Math.ceil(item.content.length / 2)),
              JSON.stringify(item.heading_path ?? []),
              item.content.length,
            ],
          );
        }
        await activation.stage(manager, {
          project_id: this.projectId,
          file_id: fileId,
          document_id: documentId,
          ingestion_key: ingestionKey,
          chunk_version: 'parent-child-v1',
        });
      });
      const rows = await this.dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM retrieval_index_versions
          WHERE project_id = ? AND file_id = ? AND ingestion_key = ?
            AND index_version = ?`,
        [
          this.projectId,
          fileId,
          ingestionKey,
          String(this.config.get('RAG_INDEX_VERSION', 'rag-v1')),
        ],
      );
      if (!rows[0]) throw new Error('Evaluation dense index was not staged');
      stagedIds.push(rows[0].id);
    }
    for (const id of stagedIds) {
      await this.indexAndWait(id);
    }
    this.ingested = true;
  }

  async cleanup(): Promise<void> {
    if (!this.initialized) return;
    let namespaces: Array<{ namespace: string }> = [];
    try {
      namespaces = await this.dataSource.query<Array<{ namespace: string }>>(
        `SELECT published_namespace AS namespace
           FROM retrieval_index_versions
          WHERE project_id = ? AND published_namespace IS NOT NULL`,
        [this.projectId],
      );
    } catch {
      namespaces = [];
    }
    let qdrantCleanupError: unknown;
    const cleanupNamespaces = new Set([
      ...namespaces.map((row) => row.namespace),
      ...this.attemptedNamespaces,
    ]);
    for (const namespace of cleanupNamespaces) {
      try {
        await this.qdrant.deleteNamespace(namespace);
      } catch (error) {
        qdrantCleanupError ??= error;
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(`DELETE FROM retrieval_runs WHERE project_id = ?`, [
        this.projectId,
      ]);
      await manager.query(
        `DELETE FROM retrieval_index_versions WHERE project_id = ?`,
        [this.projectId],
      );
      await manager.query(`DELETE FROM chunks WHERE project_id = ?`, [
        this.projectId,
      ]);
      await manager.query(`DELETE FROM documents WHERE project_id = ?`, [
        this.projectId,
      ]);
      await manager.query(`DELETE FROM source_files WHERE project_id = ?`, [
        this.projectId,
      ]);
      await manager.query(`DELETE FROM projects WHERE id = ?`, [
        this.projectId,
      ]);
      await manager.query(`DELETE FROM users WHERE id = ?`, [this.userId]);
    });
    this.initialized = false;
    this.ingested = false;
    this.attemptedNamespaces.clear();
    if (qdrantCleanupError) {
      throw new Error('Production evaluation Qdrant cleanup failed', {
        cause: qdrantCleanupError,
      });
    }
  }

  private async indexAndWait(indexVersionId: string): Promise<void> {
    const claim = await this.persistence.claimSpecificIndex(indexVersionId);
    if (!claim) throw new Error('Evaluation dense index could not be claimed');
    this.attemptedNamespaces.add(`${claim.id}:${claim.attempt_token}`);
    const worker = new DenseIndexWorker(
      this.persistence,
      this.dataSource.getRepository(Chunk),
      new DenseIndexService(this.embeddings, this.qdrant, this.persistence),
    );
    await worker.handle({
      data: {
        indexVersionId,
        attemptToken: claim.attempt_token,
        attempt: claim.attempt_count,
      },
    } as never);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const rows = await this.dataSource.query<
        Array<{ status: string; error_message: string | null }>
      >(
        `SELECT status, error_message
           FROM retrieval_index_versions WHERE id = ?`,
        [indexVersionId],
      );
      const row = rows[0];
      if (row?.status === 'READY') return;
      if (row?.status === 'FAILED') {
        throw new Error(
          `Evaluation dense index failed: ${row.error_message ?? 'unknown'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for evaluation dense index READY');
  }
}

export function createProductionEvaluationDataSource(): DataSource {
  return new DataSource({
    type: 'mysql',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 3306),
    username: process.env.DATABASE_USER || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'textweaver',
    charset: 'utf8mb4',
    timezone: '+08:00',
    entities: [
      SourceFile,
      Document,
      Chunk,
      RetrievalRun,
      RetrievalCandidateRecord,
      RetrievalIndexVersion,
      RetrievalRunIndexVersion,
    ],
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
