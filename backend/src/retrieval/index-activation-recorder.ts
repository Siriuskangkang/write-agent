import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';

@Injectable()
export class IndexActivationRecorder {
  private readonly indexVersion: string;
  private readonly collection: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimension: number;

  constructor(config: ConfigService) {
    this.indexVersion = String(config.get('RAG_INDEX_VERSION', 'rag-v1'));
    this.collection = String(
      config.get('QDRANT_COLLECTION', 'write_agent_chunks'),
    );
    this.embeddingModel = String(
      config.get('EMBEDDING_MODEL', 'text-embedding-3-small'),
    );
    this.embeddingDimension = Number(config.get('EMBEDDING_DIMENSION', 1536));
  }

  async stage(
    manager: EntityManager,
    input: {
      project_id: string;
      file_id: string;
      document_id: string;
      ingestion_key: string;
      chunk_version: string;
    },
  ): Promise<void> {
    const id = stableUuid(
      `${input.file_id}:${input.ingestion_key}:${this.indexVersion}`,
    );
    await manager.query(
      `INSERT IGNORE INTO retrieval_index_versions
         (id, project_id, file_id, document_id, ingestion_key, chunk_version,
          index_version, provider, collection_name, embedding_model,
          embedding_dimension, distance, sparse_parser, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'qdrant', ?, ?, ?, 'Cosine', 'ngram',
               'PENDING')`,
      [
        id,
        input.project_id,
        input.file_id,
        input.document_id,
        input.ingestion_key,
        input.chunk_version,
        this.indexVersion,
        this.collection,
        this.embeddingModel,
        this.embeddingDimension,
      ],
    );
  }
}

function stableUuid(identity: string): string {
  const hex = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}
