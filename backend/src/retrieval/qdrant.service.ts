import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface QdrantPointPayload {
  chunk_id?: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string;
  chunk_version: string;
  index_version: string;
  chunk_type: 'parent' | 'child';
  is_active: boolean;
  index_record_id: string;
  attempt_token: string;
  index_namespace: string;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: QdrantPointPayload;
}

export interface QdrantSearchPoint {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
  vector: number[];
}

export class QdrantUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'QdrantUnavailableError';
  }
}

export class QdrantSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QdrantSchemaMismatchError';
  }
}

@Injectable()
export class QdrantService {
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly dimension: number;
  private readonly indexVersion: string;
  private collectionReady = false;

  constructor(config: ConfigService) {
    this.baseUrl = String(
      config.get('QDRANT_URL', 'http://127.0.0.1:6333'),
    ).replace(/\/+$/, '');
    this.collection = String(
      config.get('QDRANT_COLLECTION', 'write_agent_chunks'),
    );
    this.apiKey = String(config.get('QDRANT_API_KEY', '')).trim() || null;
    this.timeoutMs = positiveInteger(
      config.get('QDRANT_TIMEOUT_MS', 5_000),
      'QDRANT_TIMEOUT_MS',
    );
    this.dimension = positiveInteger(
      config.get('EMBEDDING_DIMENSION', 1536),
      'EMBEDDING_DIMENSION',
    );
    this.indexVersion = String(config.get('RAG_INDEX_VERSION', 'rag-v1'));
  }

  get configuredIndexVersion(): string {
    return this.indexVersion;
  }

  get configuredCollection(): string {
    return this.collection;
  }

  get configuredDimension(): number {
    return this.dimension;
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;
    const path = `/collections/${encodeURIComponent(this.collection)}`;
    const existing = await this.request('GET', path, undefined, [404]);
    if (existing.status === 404) {
      await this.request('PUT', path, {
        vectors: { size: this.dimension, distance: 'Cosine' },
        on_disk_payload: true,
      });
      this.collectionReady = true;
      return;
    }

    const body = await parseJson(existing);
    const vectors = readObject(
      readObject(readObject(body.result).config).params,
    ).vectors;
    const vectorConfig = readObject(vectors);
    const size = Number(vectorConfig.size);
    const distance =
      typeof vectorConfig.distance === 'string' ? vectorConfig.distance : '';
    if (size !== this.dimension || distance.toLowerCase() !== 'cosine') {
      throw new QdrantSchemaMismatchError(
        `Qdrant collection ${this.collection} expects ${this.dimension}/Cosine but found ${String(size)}/${distance || 'unknown'}`,
      );
    }
    this.collectionReady = true;
  }

  async upsert(points: QdrantPoint[], signal?: AbortSignal): Promise<void> {
    if (points.length === 0) return;
    points.forEach((point) => this.assertVector(point.vector));
    await this.ensureCollection();
    await this.request(
      'PUT',
      `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      { points },
      [],
      signal,
    );
  }

  async upsertAttempt(
    points: QdrantPoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.upsert(points, signal);
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await this.ensureCollection();
    await this.request(
      'POST',
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        filter: {
          must: [{ key: 'index_namespace', match: { value: namespace } }],
        },
      },
    );
  }

  async countNamespaces(
    projectId: string,
    namespaces: string[],
  ): Promise<Map<string, number>> {
    await this.ensureCollection();
    const counts = await Promise.all(
      namespaces.map(async (namespace) => {
        const response = await this.request(
          'POST',
          `/collections/${encodeURIComponent(this.collection)}/points/count`,
          {
            exact: true,
            filter: {
              must: [
                { key: 'project_id', match: { value: projectId } },
                {
                  key: 'index_version',
                  match: { value: this.indexVersion },
                },
                { key: 'chunk_type', match: { value: 'child' } },
                { key: 'is_active', match: { value: true } },
                {
                  key: 'index_namespace',
                  match: { value: namespace },
                },
              ],
            },
          },
        );
        const body = await parseJson(response);
        return [namespace, Number(readObject(body.result).count ?? 0)] as const;
      }),
    );
    return new Map(counts);
  }

  async search(
    projectId: string,
    vector: number[],
    limit: number,
    readyNamespaces: string[],
  ): Promise<QdrantSearchPoint[]> {
    if (readyNamespaces.length === 0) return [];
    this.assertVector(vector);
    await this.ensureCollection();
    const response = await this.request(
      'POST',
      `/collections/${encodeURIComponent(this.collection)}/points/query`,
      {
        query: vector,
        filter: {
          must: [
            { key: 'project_id', match: { value: projectId } },
            {
              key: 'index_version',
              match: { value: this.indexVersion },
            },
            { key: 'chunk_type', match: { value: 'child' } },
            { key: 'is_active', match: { value: true } },
            {
              key: 'index_namespace',
              match: { any: readyNamespaces },
            },
          ],
        },
        limit,
        with_payload: true,
        with_vector: true,
      },
    );
    const body = await parseJson(response);
    const points = readObject(body.result).points;
    return Array.isArray(points)
      ? points.map((point) => {
          const value = readObject(point);
          return {
            id: value.id as string | number,
            score: Number(value.score),
            payload: readObject(value.payload),
            vector: Array.isArray(value.vector) ? value.vector.map(Number) : [],
          };
        })
      : [];
  }

  private assertVector(vector: number[]): void {
    if (
      vector.length !== this.dimension ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new QdrantSchemaMismatchError(
        `Embedding dimension must be ${this.dimension}`,
      );
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    allowedStatuses: number[] = [],
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new QdrantUnavailableError(
        `Qdrant request failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const detail = await response.text().catch(() => '');
      throw new QdrantUnavailableError(
        `Qdrant ${method} ${path} returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    return response;
  }
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return readObject(await response.json());
  } catch (error) {
    throw new QdrantUnavailableError('Qdrant returned invalid JSON', {
      cause: error,
    });
  }
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
