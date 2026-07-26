import { Process, Processor } from '@nestjs/bull';
import { Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Raw, Repository } from 'typeorm';
import * as Bull from 'bull';
import { SourceFile } from './entities/source-file.entity.js';
import { FileType, ParseStatus } from '../common/enums.js';
import { parsePdf } from './parsers/pdf.parser.js';
import { parseDocx } from './parsers/docx.parser.js';
import { parsePptx } from './parsers/pptx.parser.js';
import { parseMarkdown } from './parsers/markdown.parser.js';
import { parseTxt } from './parsers/txt.parser.js';
import type { ParseContext, ParseResult } from './parsers/document-ast.js';
import { StructuredIngestionService } from './structured-ingestion.service.js';
import { readVerifiedFileSnapshot } from './verified-file-snapshot.js';
import { DEFAULT_PARSER_BUDGET } from './parsers/document-ast.js';
import { StorageObject } from '../storage/entities/storage-object.entity.js';
import { StorageReadinessService } from '../storage/storage-readiness.service.js';
import { parseStorageAuthorityConfig } from '../storage/storage.config.js';
import { formatStorageKey } from '../storage/storage-key.js';
import * as path from 'node:path';

interface ParseJobData {
  fileId: string;
  projectId: string;
  parseGeneration: number;
}

const PARSE_ATTEMPT_LEASE_SECONDS = 180;

@Processor('file-parse')
export class ParseWorker {
  private readonly logger = new Logger(ParseWorker.name);

  constructor(
    @InjectRepository(SourceFile)
    private readonly fileRepo: Repository<SourceFile>,
    private readonly ingestionService: StructuredIngestionService,
    @Optional()
    @InjectRepository(StorageObject)
    private readonly storageObjectRepo?: Repository<StorageObject>,
    @Optional()
    private readonly storageReadiness?: StorageReadinessService,
  ) {}

  @Process('parse')
  async handleParse(job: Bull.Job<ParseJobData>) {
    const { fileId, projectId, parseGeneration } = job.data;
    this.logger.log(`Parsing file ${fileId}`);
    if (!Number.isSafeInteger(parseGeneration) || parseGeneration < 1) {
      this.logger.error(`Parse job ${fileId} has no valid generation`);
      return;
    }

    const file = await this.fileRepo.findOne({ where: { id: fileId } });
    if (!file) {
      this.logger.error(`File ${fileId} not found`);
      return;
    }
    if (file.project_id !== projectId) {
      this.logger.error(
        `File ${fileId} does not belong to project ${projectId}`,
      );
      return;
    }
    if (file.parse_generation !== parseGeneration) {
      this.logger.warn(
        `Ignoring stale parse generation ${parseGeneration} for ${fileId}`,
      );
      return;
    }
    if (file.parse_status === ParseStatus.DONE) {
      this.logger.log(
        `Parse generation ${parseGeneration} for ${fileId} is already complete`,
      );
      return;
    }
    if (file.deleted_at) {
      this.logger.warn(`Ignoring tombstoned source file ${fileId}`);
      return;
    }

    await this.assertBrokerObjectAvailable(file, parseGeneration);

    const attemptToken = randomUUID();
    const claimed = await this.fileRepo.update(
      {
        id: fileId,
        project_id: projectId,
        parse_generation: parseGeneration,
        parse_status: Raw(
          (alias) =>
            `(${alias} IN (:...claimableStatuses) OR (` +
            `${alias} = :parsingStatus AND (` +
            '`parse_lease_expires_at` IS NULL OR ' +
            '`parse_lease_expires_at` <= CURRENT_TIMESTAMP(6))))',
          {
            claimableStatuses: [ParseStatus.PENDING, ParseStatus.FAILED],
            parsingStatus: ParseStatus.PARSING,
          },
        ),
      },
      {
        parse_status: ParseStatus.PARSING,
        error_message: null,
        parse_attempt_token: attemptToken,
        parse_lease_expires_at: () =>
          `DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ${PARSE_ATTEMPT_LEASE_SECONDS} SECOND)`,
      },
    );
    if (claimed.affected !== 1) return;

    try {
      const snapshot = await readVerifiedFileSnapshot(file.file_path, {
        expected_checksum: file.checksum_sha256,
        expected_size:
          file.file_size === null || file.file_size === undefined
            ? null
            : Number(file.file_size),
        max_bytes: DEFAULT_PARSER_BUDGET.max_bytes,
      });
      const result = await this.parseByType(file.file_type, file.file_path, {
        source_checksum: snapshot.checksum,
        source_bytes: snapshot.bytes,
      });

      await this.ingestionService.activate({
        file_id: fileId,
        project_id: projectId,
        source_checksum: snapshot.checksum,
        parse_generation: parseGeneration,
        attempt_token: attemptToken,
        result,
      });

      this.logger.log(`File ${fileId} fully processed`);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Unknown parse error';
      this.logger.error(`Failed to parse file ${fileId}: ${message}`);
      await this.fileRepo.update(
        {
          id: fileId,
          project_id: projectId,
          parse_generation: parseGeneration,
          parse_status: ParseStatus.PARSING,
          parse_attempt_token: attemptToken,
        },
        {
          parse_status: ParseStatus.FAILED,
          error_message: message,
          parse_attempt_token: null,
          parse_lease_expires_at: null,
        },
      );
      throw err;
    }
  }

  private async assertBrokerObjectAvailable(
    file: SourceFile,
    parseGeneration: number,
  ): Promise<void> {
    const config = parseStorageAuthorityConfig(process.env);
    if (config.mode !== 'broker') return;
    if (
      !config.protectedRoot ||
      !this.storageObjectRepo ||
      !this.storageReadiness ||
      !file.checksum_sha256 ||
      file.file_size === null ||
      file.file_size === undefined
    ) {
      throw new Error('STORAGE_AUTHORITY_UNPROVEN');
    }
    await this.storageReadiness.assertReady();
    const storageKey = formatStorageKey({
      project_id: file.project_id,
      source_file_id: file.id,
      generation_decimal: String(parseGeneration),
      checksum_sha256: file.checksum_sha256,
    });
    const storageObject = await this.storageObjectRepo.findOne({
      where: {
        project_id: file.project_id,
        source_file_id: file.id,
        generation: String(parseGeneration),
        storage_key: storageKey,
        checksum_sha256: file.checksum_sha256,
        byte_size: String(file.file_size),
        state: 'AVAILABLE',
      },
    });
    const expectedPath = path.join(config.protectedRoot, storageKey);
    if (!storageObject || path.resolve(file.file_path) !== expectedPath) {
      throw new Error('STORAGE_OBJECT_NOT_AVAILABLE');
    }
  }

  private async parseByType(
    fileType: FileType,
    filePath: string,
    context: ParseContext,
  ): Promise<ParseResult> {
    switch (fileType) {
      case FileType.PDF:
        return parsePdf(filePath, context);
      case FileType.DOCX:
        return parseDocx(filePath, context);
      case FileType.PPTX:
        return parsePptx(filePath, context);
      case FileType.MD:
        return parseMarkdown(filePath, context);
      case FileType.TXT:
        return parseTxt(filePath, context);
      default:
        throw new Error('Unsupported file type');
    }
  }
}
