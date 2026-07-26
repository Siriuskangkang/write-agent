import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ChunkService } from '../chunk/chunk.service.js';
import { CHUNK_VERSION } from '../chunk/chunker.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { ParseStatus } from '../common/enums.js';
import { Document } from './entities/document.entity.js';
import { SourceFile } from './entities/source-file.entity.js';
import type { ParseResult } from './parsers/document-ast.js';
import { IndexActivationRecorder } from '../retrieval/index-activation-recorder.js';

export interface ActivateIngestionInput {
  file_id: string;
  project_id: string;
  source_checksum: string;
  parse_generation: number;
  attempt_token: string;
  result: ParseResult;
}

@Injectable()
export class StructuredIngestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly chunkService: ChunkService,
    private readonly indexActivation: IndexActivationRecorder,
  ) {}

  async activate(input: ActivateIngestionInput): Promise<Document> {
    if (
      !Number.isSafeInteger(input.parse_generation) ||
      input.parse_generation < 1
    ) {
      throw new Error('Invalid parse generation');
    }
    if (!input.attempt_token) throw new Error('Invalid parse attempt token');
    const ingestionKey = createIngestionKey({
      source_checksum: input.source_checksum,
      parser_version: input.result.parser_version,
      chunk_version: CHUNK_VERSION,
    });

    return this.dataSource.transaction(async (manager) => {
      const source = await manager.findOne(SourceFile, {
        where: { id: input.file_id, project_id: input.project_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!source) {
        throw new Error('Source file does not belong to the parse job');
      }
      if (source.parse_generation !== input.parse_generation) {
        throw new Error('Stale parse generation');
      }
      if (
        source.parse_status !== ParseStatus.PARSING ||
        source.parse_attempt_token !== input.attempt_token
      ) {
        throw new Error('Stale parse attempt');
      }
      const leaseRows: unknown = await manager.query(
        `SELECT
           (parse_lease_expires_at > CURRENT_TIMESTAMP(6)) AS leaseActive
         FROM source_files
         WHERE id = ? AND project_id = ? AND parse_generation = ?
           AND parse_attempt_token = ?`,
        [
          input.file_id,
          input.project_id,
          input.parse_generation,
          input.attempt_token,
        ],
      );
      const leaseActive =
        Array.isArray(leaseRows) &&
        leaseRows.length > 0 &&
        Number((leaseRows[0] as { leaseActive?: unknown }).leaseActive) === 1;
      if (!leaseActive) throw new Error('Stale parse attempt');
      if (
        source.checksum_sha256 &&
        source.checksum_sha256.toLowerCase() !==
          input.source_checksum.toLowerCase()
      ) {
        throw new Error('Source file checksum changed after upload');
      }

      const existing = await manager.findOne(Document, {
        where: {
          file_id: input.file_id,
          ingestion_key: ingestionKey,
        },
      });

      if (existing) {
        if (!existing.is_active) {
          await manager.update(
            Document,
            { file_id: input.file_id, is_active: true },
            { is_active: false },
          );
          await manager.update(
            Chunk,
            { file_id: input.file_id, is_active: true },
            { is_active: false },
          );
          await manager.update(
            Document,
            { id: existing.id },
            { is_active: true },
          );
          await manager.update(
            Chunk,
            { document_id: existing.id },
            { is_active: true },
          );
          existing.is_active = true;
        }
        await this.completeAttempt(manager, input, {
          checksum_sha256: input.source_checksum,
          active_ingestion_key: ingestionKey,
        });
        await this.indexActivation.stage(manager, {
          project_id: input.project_id,
          file_id: input.file_id,
          document_id: existing.id,
          ingestion_key: existing.ingestion_key,
          chunk_version: existing.chunk_version ?? CHUNK_VERSION,
        });
        return existing;
      }

      await manager.update(
        Document,
        { file_id: input.file_id, is_active: true },
        { is_active: false },
      );
      await manager.update(
        Chunk,
        { file_id: input.file_id, is_active: true },
        { is_active: false },
      );

      const document = manager.create(Document, {
        file_id: input.file_id,
        project_id: input.project_id,
        title: input.result.title,
        content_text: input.result.content_text,
        page_count: input.result.page_count,
        sections: input.result.sections,
        source_checksum: input.source_checksum,
        parser_version: input.result.parser_version,
        chunk_version: CHUNK_VERSION,
        ingestion_key: ingestionKey,
        ast: input.result.ast,
        is_active: true,
      });
      const savedDocument = await manager.save(Document, document);

      await this.chunkService.createChunksForDocument(
        input.project_id,
        input.file_id,
        savedDocument.id,
        {
          content_text: input.result.content_text,
          sections: input.result.sections,
          ast: input.result.ast,
          ingestion_key: ingestionKey,
        },
        manager,
      );
      await this.indexActivation.stage(manager, {
        project_id: input.project_id,
        file_id: input.file_id,
        document_id: savedDocument.id,
        ingestion_key: ingestionKey,
        chunk_version: CHUNK_VERSION,
      });
      await this.completeAttempt(manager, input, {
        checksum_sha256: input.source_checksum,
        active_ingestion_key: ingestionKey,
      });
      return savedDocument;
    });
  }

  private async completeAttempt(
    manager: EntityManager,
    input: ActivateIngestionInput,
    values: Pick<SourceFile, 'checksum_sha256' | 'active_ingestion_key'>,
  ): Promise<void> {
    const completed = await manager.update(
      SourceFile,
      {
        id: input.file_id,
        project_id: input.project_id,
        parse_generation: input.parse_generation,
        parse_status: ParseStatus.PARSING,
        parse_attempt_token: input.attempt_token,
      },
      {
        ...values,
        parse_status: ParseStatus.DONE,
        error_message: null,
        parse_attempt_token: null,
        parse_lease_expires_at: null,
      },
    );
    if (completed.affected !== 1) throw new Error('Stale parse attempt');
  }
}

export function createIngestionKey(input: {
  source_checksum: string;
  parser_version: string;
  chunk_version: string;
}): string {
  if (!/^[a-f0-9]{64}$/i.test(input.source_checksum)) {
    throw new Error('source_checksum must be a SHA-256 digest');
  }
  return createHash('sha256')
    .update(
      [
        input.source_checksum.toLowerCase(),
        input.parser_version,
        input.chunk_version,
      ].join('\0'),
    )
    .digest('hex');
}
