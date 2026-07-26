import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EmbeddingService } from '../embedding/embedding.service.js';
import { QdrantSchemaMismatchError, QdrantService } from './qdrant.service.js';
import type {
  DenseIndexSnapshot,
  DenseRetrieverPort,
  DenseSearchResult,
  RetrievalCandidate,
  RetrievalQueryPlan,
} from './types.js';

export interface DenseChunkRow {
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string | null;
  content: string;
  section_title: string | null;
  heading_path: string | string[] | null;
  page_start: number | null;
  page_end: number | null;
  char_start: number | null;
  char_end: number | null;
  position: number;
  token_count: number;
  file_name?: string;
  keywords?: string | string[] | null;
}

interface CoverageRow {
  id: string | null;
  file_id: string;
  ingestion_key: string;
  index_version: string | null;
  status: string | null;
  collection_name: string | null;
  embedding_model: string | null;
  embedding_dimension: number | string | null;
  published_namespace: string | null;
  point_count: number | string | null;
}

@Injectable()
export class DenseRetriever implements DenseRetrieverPort {
  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly qdrant: QdrantService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async search(
    request: RetrievalQueryPlan & { project_id: string; limit: number },
  ): Promise<DenseSearchResult> {
    const coverage = await this.readCoverage(request.project_id);
    let snapshots = coverage.map(toIndexSnapshot);
    const readyIndexes = coverage
      .filter(
        (item): item is CoverageRow & { id: string; status: 'READY' } =>
          item.id !== null &&
          item.status === 'READY' &&
          item.published_namespace !== null,
      )
      .map(toIndexSnapshot);
    if (
      coverage.some(
        (item) =>
          item.id === null ||
          item.status !== 'READY' ||
          item.published_namespace === null,
      )
    ) {
      return {
        candidates: [],
        state: 'unavailable',
        error_code: 'DENSE_INDEX_COVERAGE_INCOMPLETE',
        query_embedding: null,
        index_versions: snapshots,
        embedding_usage: null,
      };
    }
    try {
      const namespaces = readyIndexes
        .map((item) => item.namespace)
        .filter((item): item is string => item !== null);
      const counts =
        'countNamespaces' in this.qdrant
          ? await this.qdrant.countNamespaces(request.project_id, namespaces)
          : new Map(
              readyIndexes.map((item) => [
                item.namespace as string,
                item.expected_point_count,
              ]),
            );
      snapshots = snapshots.map((item) => ({
        ...item,
        observed_point_count:
          item.namespace === null ? null : (counts.get(item.namespace) ?? 0),
      }));
      if (
        snapshots.some(
          (item) =>
            item.status === 'READY' &&
            item.observed_point_count !== item.expected_point_count,
        )
      ) {
        return {
          candidates: [],
          state: 'unavailable',
          error_code: 'INDEX_POINTS_MISSING',
          query_embedding: null,
          index_versions: snapshots,
          embedding_usage: null,
        };
      }
    } catch (error) {
      return {
        candidates: [],
        state: 'unavailable',
        error_code:
          error instanceof QdrantSchemaMismatchError
            ? 'QDRANT_SCHEMA_MISMATCH'
            : 'QDRANT_UNAVAILABLE',
        query_embedding: null,
        index_versions: snapshots,
        embedding_usage: null,
      };
    }
    const embeddings = this.embeddings as unknown as {
      generateEmbeddingDetailed?: EmbeddingService['generateEmbeddingDetailed'];
      generateEmbedding: EmbeddingService['generateEmbedding'];
    };
    const embeddingResult =
      typeof embeddings.generateEmbeddingDetailed === 'function'
        ? await embeddings.generateEmbeddingDetailed(request.dense_query)
        : {
            vector: await embeddings.generateEmbedding(request.dense_query),
            usage: null,
          };
    const queryEmbedding = embeddingResult.vector;
    if (!queryEmbedding) {
      return {
        candidates: [],
        state: 'unavailable',
        error_code: 'EMBEDDING_UNAVAILABLE',
        query_embedding: null,
        index_versions: snapshots,
        embedding_usage: null,
      };
    }

    try {
      const points = await this.qdrant.search(
        request.project_id,
        queryEmbedding,
        request.limit,
        readyIndexes
          .map((item) => item.namespace)
          .filter((item): item is string => item !== null),
      );
      if (
        points.length === 0 &&
        snapshots.some((item) => item.expected_point_count > 0)
      ) {
        return {
          candidates: [],
          state: 'unavailable',
          error_code: 'INDEX_POINTS_MISSING',
          query_embedding: queryEmbedding,
          index_versions: snapshots.map((item) => ({
            ...item,
            observed_point_count:
              item.expected_point_count > 0 ? 0 : item.observed_point_count,
          })),
          embedding_usage: this.embeddingUsage(
            request.dense_query,
            embeddingResult.usage,
          ),
        };
      }
      if (points.length === 0) {
        return {
          candidates: [],
          state: 'ready',
          error_code: null,
          query_embedding: queryEmbedding,
          index_versions: snapshots,
          embedding_usage: this.embeddingUsage(
            request.dense_query,
            embeddingResult.usage,
          ),
        };
      }
      const ids = points.map((point) => pointChunkId(point));
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await this.dataSource.query<DenseChunkRow[]>(
        `SELECT c.id AS chunk_id,
                c.project_id,
                c.file_id,
                c.document_id,
                c.ingestion_key,
                c.content,
                c.section_title,
                c.heading_path,
                c.page_start,
                c.page_end,
                c.char_start,
                c.char_end,
                c.position,
                c.token_count,
                sf.file_name,
                c.keywords
           FROM chunks c
           JOIN source_files sf ON sf.id = c.file_id
          WHERE c.id IN (${placeholders})
            AND c.project_id = ?
            AND c.is_active = 1
            AND c.chunk_type = 'child'`,
        [...ids, request.project_id],
      );
      const byId = new Map(rows.map((row) => [row.chunk_id, row]));
      const candidates = points
        .map((point) => {
          const chunkId = pointChunkId(point);
          const row = byId.get(chunkId);
          return row ? toDenseCandidate(row, point.score, point.vector) : null;
        })
        .filter(
          (candidate): candidate is RetrievalCandidate => candidate !== null,
        );

      return {
        candidates,
        state: 'ready',
        error_code: null,
        query_embedding: queryEmbedding,
        index_versions: snapshots,
        embedding_usage: this.embeddingUsage(
          request.dense_query,
          embeddingResult.usage,
        ),
      };
    } catch (error) {
      return {
        candidates: [],
        state: 'unavailable',
        error_code:
          error instanceof QdrantSchemaMismatchError
            ? 'QDRANT_SCHEMA_MISMATCH'
            : 'QDRANT_UNAVAILABLE',
        query_embedding: queryEmbedding,
        index_versions: snapshots,
        embedding_usage: this.embeddingUsage(
          request.dense_query,
          embeddingResult.usage,
        ),
      };
    }
  }

  private async readCoverage(projectId: string): Promise<CoverageRow[]> {
    return this.dataSource.query<CoverageRow[]>(
      `SELECT riv.id,
              sf.id AS file_id,
              sf.active_ingestion_key AS ingestion_key,
              riv.index_version,
              riv.status,
              riv.collection_name,
              riv.embedding_model,
              riv.embedding_dimension,
              riv.published_namespace,
              riv.point_count
         FROM source_files sf
         LEFT JOIN retrieval_index_versions riv
           ON riv.file_id = sf.id
          AND riv.project_id = sf.project_id
          AND riv.ingestion_key = sf.active_ingestion_key
          AND riv.index_version = ?
        WHERE sf.project_id = ?
          AND sf.active_ingestion_key IS NOT NULL
          AND sf.parse_status = 'done'
        ORDER BY sf.id ASC`,
      [this.qdrant.configuredIndexVersion, projectId],
    );
  }

  private embeddingUsage(
    input: string,
    usage: { input_tokens: number; source: 'actual' | 'estimated' } | null,
  ): DenseSearchResult['embedding_usage'] {
    const model = this.embeddings.configuredModel ?? 'unknown';
    const normalizedUsage = usage ?? {
      input_tokens: Math.max(1, Math.ceil(input.length / 2)),
      source: 'estimated' as const,
    };
    const inputTokens = normalizedUsage.input_tokens;
    const price = this.embeddings.configuredPricePerMillionUsd ?? null;
    const cost =
      price !== null ? ((inputTokens * price) / 1_000_000).toFixed(8) : null;
    return {
      model,
      actual_input_tokens:
        normalizedUsage.source === 'actual' ? inputTokens : null,
      estimated_input_tokens:
        normalizedUsage.source === 'estimated' ? inputTokens : null,
      cost_usd: normalizedUsage.source === 'actual' ? cost : null,
      estimated_cost_usd: normalizedUsage.source === 'estimated' ? cost : null,
      source: normalizedUsage.source,
    };
  }
}

function toDenseCandidate(
  row: DenseChunkRow,
  score: number,
  embedding: number[],
): RetrievalCandidate {
  return {
    ...row,
    heading_path: normalizeHeadingPath(row.heading_path),
    page_start: nullableNumber(row.page_start),
    page_end: nullableNumber(row.page_end),
    char_start: nullableNumber(row.char_start),
    char_end: nullableNumber(row.char_end),
    position: Number(row.position),
    token_count: Number(row.token_count),
    source: 'dense',
    source_score: Number(score),
    embedding,
    file_name: row.file_name,
    keywords: normalizeKeywords(row.keywords),
  };
}

function toIndexSnapshot(row: CoverageRow): DenseIndexSnapshot {
  return {
    id: row.id,
    file_id: row.file_id,
    ingestion_key: row.ingestion_key,
    index_version: row.index_version ?? '',
    status: row.id === null ? 'MISSING' : String(row.status),
    collection_name: row.collection_name,
    embedding_model: row.embedding_model,
    embedding_dimension:
      row.embedding_dimension === null ? null : Number(row.embedding_dimension),
    namespace: row.published_namespace,
    expected_point_count: Number(row.point_count ?? 0),
    observed_point_count: null,
  };
}

function normalizeKeywords(
  value: string | string[] | null | undefined,
): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function pointChunkId(point: {
  id: string | number;
  payload: Record<string, unknown>;
}): string {
  const chunkId = point.payload.chunk_id;
  return typeof chunkId === 'string' || typeof chunkId === 'number'
    ? String(chunkId)
    : String(point.id);
}

function normalizeHeadingPath(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function nullableNumber(value: number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}
