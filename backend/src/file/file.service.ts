import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, QueryRunner, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import * as Bull from 'bull';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SourceFile } from './entities/source-file.entity.js';
import { Document } from './entities/document.entity.js';
import { FileType, ParseStatus } from '../common/enums.js';
import { ChunkService } from '../chunk/chunk.service.js';
import { ProjectService } from '../project/project.service.js';
import { CitationMap } from '../citation/entities/citation-map.entity.js';
import { FileUploadOutbox } from './entities/file-upload-outbox.entity.js';
import { FileCleanupRecord } from './entities/file-cleanup-record.entity.js';
import { FileUploadOutboxDispatcher } from './file-upload-outbox.dispatcher.js';
import { discardQueryRunnerConnection } from './discard-query-runner-connection.js';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import { databaseDeadlineAfter, databaseNow } from './retry-dispatcher.js';
import { StorageReadinessService } from '../storage/storage-readiness.service.js';
import { StorageRequestService } from '../storage/storage-request.service.js';
import { parseStorageAuthorityConfig } from '../storage/storage.config.js';
import { formatStorageKey } from '../storage/storage-key.js';
import { StorageObject } from '../storage/entities/storage-object.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { assertStoragePathMayBeDeleted } from '../storage/storage-path-policy.js';

const DEFAULT_MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const DEFAULT_USER_STORAGE_QUOTA = 500 * 1024 * 1024;
const MAX_OOXML_ENTRY_SIZE = 16 * 1024 * 1024;
const MAX_OOXML_TOTAL_SIZE = 64 * 1024 * 1024;
const MOVE_WRITER_LEASE_SECONDS = 2 * 60;
const UNCERTAIN_COMMIT_GRACE_SECONDS = 5 * 60;
const UNCERTAIN_RECOVERY_LOCK_WAIT_SECONDS = 2;
const ALLOWED_FILE_TYPES = new Set<FileType>(Object.values(FileType));
const ALLOWED_MIME_TYPES: Record<FileType, ReadonlySet<string>> = {
  [FileType.PDF]: new Set(['application/pdf']),
  [FileType.DOCX]: new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  [FileType.PPTX]: new Set([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]),
  [FileType.MD]: new Set([
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    '',
  ]),
  [FileType.TXT]: new Set(['text/plain', '']),
};

type MoveIntentPlan = Pick<
  FileMoveIntent,
  | 'id'
  | 'source_path'
  | 'destination_path'
  | 'file_id'
  | 'project_id'
  | 'user_id'
  | 'file_size'
  | 'writer_token'
>;

export function isAcceptedUploadDeclaration(
  originalName: string,
  mimetype: string,
): boolean {
  const extension = path.extname(originalName).toLowerCase().slice(1);
  if (!ALLOWED_FILE_TYPES.has(extension as FileType)) return false;
  return ALLOWED_MIME_TYPES[extension as FileType].has(
    mimetype.trim().toLowerCase(),
  );
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);
  private readonly uploadDir: string;

  constructor(
    @InjectRepository(SourceFile)
    private readonly fileRepo: Repository<SourceFile>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(CitationMap)
    private readonly citationRepo: Repository<CitationMap>,
    @InjectQueue('file-parse')
    private readonly parseQueue: Bull.Queue,
    @InjectRepository(FileUploadOutbox)
    private readonly outboxRepo: Repository<FileUploadOutbox>,
    @InjectRepository(FileCleanupRecord)
    private readonly cleanupRepo: Repository<FileCleanupRecord>,
    @InjectRepository(FileMoveIntent)
    private readonly moveIntentRepo: Repository<FileMoveIntent>,
    private readonly chunkService: ChunkService,
    private readonly projectService: ProjectService,
    private readonly outboxDispatcher: FileUploadOutboxDispatcher,
    @Optional()
    private readonly storageReadiness?: StorageReadinessService,
    @Optional()
    private readonly storageRequests?: StorageRequestService,
  ) {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
  }

  async uploadFiles(
    userId: string,
    projectId: string,
    files: Express.Multer.File[],
  ): Promise<SourceFile[]> {
    if (this.storageConfig().mode === 'broker') {
      return this.uploadFilesWithBroker(userId, projectId, files);
    }
    const uploadOperationId = randomUUID();
    const plannedFileIds = new Map(
      files.map((file) => [file, randomUUID()] as const),
    );
    const plannedIntentIds = new Map(
      files.map((file) => [file, randomUUID()] as const),
    );
    const temporaryPaths = new Set(
      files
        .map((file) => path.resolve(file.path))
        .filter((filePath) => this.isWithinQuarantine(filePath)),
    );
    const movedPaths = new Set<string>();
    const activeIntentIds: string[] = [];
    const activeIntents: MoveIntentPlan[] = [];
    const results: SourceFile[] = [];
    const writerToken = `upload-writer:${process.pid}:${uploadOperationId}`;
    let queryRunner:
      | ReturnType<
          Repository<SourceFile>['manager']['connection']['createQueryRunner']
        >
      | undefined;
    let transactionStarted = false;
    let lockHeld = false;
    let connectionPoisoned = false;
    let connectionDiscarded = false;
    let dbCommitted = false;
    const commitState: {
      outcome: 'not-attempted' | 'uncertain';
    } = { outcome: 'not-attempted' };

    try {
      await this.assertQuarantineFiles(files);
      await this.projectService.findOne(userId, projectId);
      const fileSizes = new Map<Express.Multer.File, number>();
      const checksums = new Map<Express.Multer.File, string>();
      for (const file of files) {
        const originalName = Buffer.from(file.originalname, 'latin1').toString(
          'utf8',
        );
        const fileType = path
          .extname(originalName)
          .toLowerCase()
          .slice(1) as FileType;
        fileSizes.set(file, await this.assertUploadableFile(file, fileType));
        checksums.set(
          file,
          createHash('sha256')
            .update(await fs.readFile(file.path))
            .digest('hex'),
        );
      }

      queryRunner = this.fileRepo.manager.connection.createQueryRunner();
      connectionPoisoned = true;
      await queryRunner.connect();
      connectionPoisoned = false;
      const lock = `upload-quota:${userId}`;
      const lockResult: unknown = await queryRunner.query(
        'SELECT GET_LOCK(?, 10) AS acquired',
        [lock],
      );
      const lockRow = Array.isArray(lockResult)
        ? (lockResult as unknown[])[0]
        : undefined;
      const acquired =
        lockRow && typeof lockRow === 'object' && 'acquired' in lockRow
          ? (lockRow as { acquired: unknown }).acquired
          : undefined;
      if (Number(acquired) !== 1) {
        throw new BadRequestException(
          'Upload quota is busy; retry the request',
        );
      }
      lockHeld = true;
      connectionPoisoned = true;
      await queryRunner.startTransaction();
      transactionStarted = true;
      connectionPoisoned = false;
      await this.assertWithinUserQuota(
        userId,
        files,
        fileSizes,
        queryRunner.manager,
      );

      const projectDir = path.join(this.uploadDir, projectId);

      for (const file of files) {
        await this.renewActiveMoveIntents(activeIntentIds, writerToken);
        const originalName = Buffer.from(file.originalname, 'latin1').toString(
          'utf8',
        );
        const ext = path.extname(originalName).toLowerCase().slice(1);
        const fileType = ext as FileType;
        await fs.mkdir(projectDir, { recursive: true });
        const destinationPath = path.join(
          projectDir,
          this.createStoredFilename(originalName),
        );
        const fileId = plannedFileIds.get(file);
        const intentId = plannedIntentIds.get(file);
        if (!fileId || !intentId) {
          throw new Error('Upload operation identity is incomplete');
        }
        const moveIntent: MoveIntentPlan = {
          id: intentId,
          source_path: file.path,
          destination_path: destinationPath,
          file_id: fileId,
          project_id: projectId,
          user_id: userId,
          file_size: fileSizes.get(file) ?? file.size,
          writer_token: writerToken,
        };
        await this.moveIntentRepo.insert({
          ...moveIntent,
          status: 'ACTIVE',
          recover_after: databaseDeadlineAfter(MOVE_WRITER_LEASE_SECONDS),
          attempts: 0,
          last_error: null,
          lease_owner: writerToken,
          lease_expires_at: databaseDeadlineAfter(MOVE_WRITER_LEASE_SECONDS),
          next_attempt_at: databaseNow(),
        });
        activeIntentIds.push(intentId);
        activeIntents.push(moveIntent);
        await this.renewActiveMoveIntents(activeIntentIds, writerToken);
        await fs.rename(file.path, destinationPath);
        temporaryPaths.delete(file.path);
        movedPaths.add(destinationPath);
        await this.renewActiveMoveIntents(activeIntentIds, writerToken);

        const fileRepo = queryRunner.manager.getRepository(SourceFile);
        const entity = fileRepo.create({
          id: fileId,
          project_id: projectId,
          file_name: originalName,
          file_type: fileType,
          file_size: fileSizes.get(file) ?? file.size,
          file_path: destinationPath,
          checksum_sha256: checksums.get(file),
          active_ingestion_key: null,
          parse_generation: 1,
          parse_status: ParseStatus.PENDING,
        });
        const saved = await fileRepo.save(entity);
        const outbox = queryRunner.manager
          .getRepository(FileUploadOutbox)
          .create({
            file_id: saved.id,
            project_id: projectId,
            parse_generation: 1,
            job_id: `file-parse:${saved.id}`,
            status: 'pending',
            attempts: 0,
            last_error: null,
          });
        await queryRunner.manager.getRepository(FileUploadOutbox).save(outbox);
        await this.renewActiveMoveIntents(activeIntentIds, writerToken);
        results.push(saved);
      }
      if (activeIntentIds.length > 0) {
        await this.renewActiveMoveIntents(activeIntentIds, writerToken);
        const deleted = await queryRunner.manager
          .getRepository(FileMoveIntent)
          .delete({
            id: In(activeIntentIds),
            writer_token: writerToken,
            lease_owner: writerToken,
          });
        if (deleted.affected !== activeIntentIds.length) {
          throw new Error('Upload lost ownership of its move intents');
        }
      }
      connectionPoisoned = true;
      try {
        await queryRunner.commitTransaction();
        dbCommitted = true;
        transactionStarted = false;
        connectionPoisoned = false;
      } catch (commitError: unknown) {
        transactionStarted = false;
        commitState.outcome = 'uncertain';
        connectionPoisoned = true;
        try {
          discardQueryRunnerConnection(queryRunner);
          connectionDiscarded = true;
          lockHeld = false;
        } catch (discardError: unknown) {
          const message =
            discardError instanceof Error
              ? discardError.message
              : String(discardError);
          this.logger.error(
            `Failed to destroy connection after uncertain upload commit: ${message}`,
          );
        }

        await this.preserveUncertainMoveIntents(activeIntents, commitError);
        throw commitError;
      }
    } catch (error: unknown) {
      let uploadError = error;
      if (commitState.outcome === 'uncertain') {
        throw uploadError;
      }
      if (transactionStarted && queryRunner) {
        try {
          connectionPoisoned = true;
          await queryRunner.rollbackTransaction();
          transactionStarted = false;
          connectionPoisoned = false;
        } catch (rollbackError: unknown) {
          connectionPoisoned = true;
          uploadError = new AggregateError(
            [error, rollbackError],
            'Upload failed and transaction rollback failed',
          );
        }
      }
      const cleanupFailures = await this.cleanupPaths([
        ...temporaryPaths,
        ...movedPaths,
      ]);
      if (cleanupFailures.length > 0) {
        await this.persistCleanupFailures(cleanupFailures, uploadError);
      } else if (activeIntentIds.length > 0) {
        try {
          await this.moveIntentRepo.delete({
            id: In(activeIntentIds),
            writer_token: writerToken,
            lease_owner: writerToken,
          });
        } catch (intentError: unknown) {
          const message =
            intentError instanceof Error
              ? intentError.message
              : String(intentError);
          this.logger.error(
            `Failed to clear recovered file move intents: ${message}`,
          );
        }
      }
      throw uploadError;
    } finally {
      if (lockHeld && queryRunner && !connectionPoisoned) {
        try {
          const releaseResult: unknown = await queryRunner.query(
            'SELECT RELEASE_LOCK(?) AS released',
            [`upload-quota:${userId}`],
          );
          const releaseRow = Array.isArray(releaseResult)
            ? (releaseResult as unknown[])[0]
            : undefined;
          const released =
            releaseRow &&
            typeof releaseRow === 'object' &&
            'released' in releaseRow
              ? (releaseRow as { released: unknown }).released
              : undefined;
          if (Number(released) !== 1) {
            connectionPoisoned = true;
            this.logger.error(
              'Failed to release upload quota lock: MySQL did not confirm quota lock release',
            );
          }
        } catch (releaseError: unknown) {
          connectionPoisoned = true;
          const message =
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError);
          this.logger.error(`Failed to release upload quota lock: ${message}`);
        }
      }
      if (
        queryRunner &&
        queryRunner.isReleased === false &&
        connectionPoisoned &&
        !connectionDiscarded
      ) {
        try {
          discardQueryRunnerConnection(queryRunner);
          connectionDiscarded = true;
        } catch (discardError: unknown) {
          const message =
            discardError instanceof Error
              ? discardError.message
              : String(discardError);
          this.logger.error(
            `Failed to destroy poisoned upload connection: ${message}`,
          );
        }
      } else if (
        queryRunner &&
        queryRunner.isReleased === false &&
        !connectionDiscarded
      ) {
        try {
          await queryRunner.release();
        } catch (releaseError: unknown) {
          const message =
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError);
          this.logger.error(
            `Failed to release upload query runner: ${message}`,
          );
          try {
            discardQueryRunnerConnection(queryRunner);
          } catch (discardError: unknown) {
            const discardMessage =
              discardError instanceof Error
                ? discardError.message
                : String(discardError);
            this.logger.error(
              `Failed to destroy upload connection after pool release failure: ${discardMessage}`,
            );
          }
        }
      }
    }

    if (!dbCommitted) {
      throw new Error('Upload transaction completed without a commit verdict');
    }
    this.dispatchCommittedOutbox();
    return results;
  }

  private async uploadFilesWithBroker(
    userId: string,
    projectId: string,
    files: Express.Multer.File[],
  ): Promise<SourceFile[]> {
    const config = this.storageConfig();
    if (
      config.mode !== 'broker' ||
      !config.protectedRoot ||
      !config.quarantineRoot ||
      !this.storageReadiness ||
      !this.storageRequests
    ) {
      throw new Error('STORAGE_AUTHORITY_UNPROVEN');
    }
    const authority = await this.storageReadiness.assertReady();
    const plans: Array<{
      file: Express.Multer.File;
      fileId: string;
      objectId: string;
      intentId: string;
      authorizationId: string;
      originalName: string;
      fileType: FileType;
      byteSize: number;
      checksum: string;
      storageKey: string;
      quarantineKey: string;
      destinationPath: string;
    }> = [];
    let metadataCommitted = false;
    let queryRunner:
      | ReturnType<
          Repository<SourceFile>['manager']['connection']['createQueryRunner']
        >
      | undefined;
    let transactionStarted = false;
    let lockHeld = false;
    let commitAttempted = false;

    try {
      await this.assertQuarantineFiles(files);
      await this.projectService.findOne(userId, projectId);
      for (const file of files) {
        const originalName = Buffer.from(file.originalname, 'latin1').toString(
          'utf8',
        );
        const fileType = path
          .extname(originalName)
          .toLowerCase()
          .slice(1) as FileType;
        const byteSize = await this.assertUploadableFile(file, fileType);
        const checksum = createHash('sha256')
          .update(await fs.readFile(file.path))
          .digest('hex');
        const fileId = randomUUID();
        const objectId = randomUUID();
        const intentId = randomUUID();
        const authorizationId = randomUUID();
        const storageKey = formatStorageKey({
          project_id: projectId,
          source_file_id: fileId,
          generation_decimal: '1',
          checksum_sha256: checksum,
        });
        const quarantineKey = `${intentId}.upload`;
        const canonicalQuarantinePath = path.join(
          config.quarantineRoot,
          quarantineKey,
        );
        await fs.rename(file.path, canonicalQuarantinePath);
        file.path = canonicalQuarantinePath;
        plans.push({
          file,
          fileId,
          objectId,
          intentId,
          authorizationId,
          originalName,
          fileType,
          byteSize,
          checksum,
          storageKey,
          quarantineKey,
          destinationPath: path.join(config.protectedRoot, storageKey),
        });
      }

      queryRunner = this.fileRepo.manager.connection.createQueryRunner();
      await queryRunner.connect();
      const lockResult: unknown = await queryRunner.query(
        'SELECT GET_LOCK(?, 10) AS acquired',
        [`upload-quota:${userId}`],
      );
      const lockRow = Array.isArray(lockResult)
        ? (lockResult as unknown[])[0]
        : undefined;
      if (
        !lockRow ||
        typeof lockRow !== 'object' ||
        !('acquired' in lockRow) ||
        Number((lockRow as { acquired: unknown }).acquired) !== 1
      ) {
        throw new BadRequestException(
          'Upload quota is busy; retry the request',
        );
      }
      lockHeld = true;
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.assertWithinUserQuota(
        userId,
        files,
        new Map(plans.map((plan) => [plan.file, plan.byteSize])),
        queryRunner.manager,
      );

      const results: SourceFile[] = [];
      for (const plan of plans) {
        const sourceRepo = queryRunner.manager.getRepository(SourceFile);
        const saved = await sourceRepo.save(
          sourceRepo.create({
            id: plan.fileId,
            project_id: projectId,
            file_name: plan.originalName,
            file_type: plan.fileType,
            file_size: plan.byteSize,
            file_path: plan.destinationPath,
            checksum_sha256: plan.checksum,
            active_ingestion_key: null,
            parse_generation: 1,
            parse_status: ParseStatus.PENDING,
            deleted_at: null,
            deleted_by: null,
          }),
        );
        const outboxRepo = queryRunner.manager.getRepository(FileUploadOutbox);
        await outboxRepo.save(
          outboxRepo.create({
            id: plan.authorizationId,
            file_id: saved.id,
            project_id: projectId,
            parse_generation: 1,
            storage_intent_id: null,
            job_id: `file-parse:${saved.id}`,
            status: 'storage_preparing',
            attempts: 0,
            last_error: null,
          }),
        );
        results.push(saved);
      }
      for (const plan of plans) {
        const result = await this.storageRequests.request(queryRunner, {
          operation_version: 'storage-operation.v1',
          kind: 'PROMOTE',
          actor_id: userId,
          intent_id: plan.intentId,
          project_id: projectId,
          source_file_id: plan.fileId,
          object_id: plan.objectId,
          object_generation_decimal: '1',
          storage_key: plan.storageKey,
          quarantine_key: plan.quarantineKey,
          expected_sha256: plan.checksum,
          expected_size_decimal: String(plan.byteSize),
          authorization_kind: 'UPLOAD_COMMIT',
          authorization_id: plan.authorizationId,
          storage_epoch: authority.storage_epoch,
        });
        if (result.status === 'REJECTED') {
          throw new Error(result.result_code || 'STORAGE_PROMOTION_REJECTED');
        }
      }
      commitAttempted = true;
      await queryRunner.commitTransaction();
      transactionStarted = false;
      metadataCommitted = true;
      return results;
    } catch (error) {
      if (transactionStarted && queryRunner) {
        await queryRunner.rollbackTransaction();
      }
      if (!metadataCommitted && !commitAttempted) {
        const cleanupFailures = await this.cleanupPaths([
          ...plans.map((plan) => plan.file.path),
          ...files
            .map((file) => file.path)
            .filter(
              (filePath) =>
                this.isWithinQuarantine(path.resolve(filePath)) &&
                !plans.some((plan) => plan.file.path === filePath),
            ),
        ]);
        if (cleanupFailures.length > 0) {
          await this.persistCleanupFailures(cleanupFailures, error);
        }
      } else if (!metadataCommitted) {
        this.logger.warn(
          `Broker upload commit is uncertain; retained quarantine files: ${plans
            .map((plan) => plan.quarantineKey)
            .join(',')}`,
        );
      }
      throw error;
    } finally {
      if (lockHeld && queryRunner) {
        try {
          await queryRunner.query('SELECT RELEASE_LOCK(?) AS released', [
            `upload-quota:${userId}`,
          ]);
        } catch (error) {
          this.logger.error(
            `Failed to release broker upload quota lock: ${String(error)}`,
          );
        }
      }
      if (queryRunner && !queryRunner.isReleased) {
        await queryRunner.release();
      }
    }
  }

  private async releaseRecoveryRunner(
    recoveryRunner: QueryRunner,
    connectionSafe: boolean,
  ): Promise<void> {
    if (recoveryRunner.isReleased) return;
    if (!connectionSafe) {
      try {
        discardQueryRunnerConnection(recoveryRunner);
      } catch (discardError: unknown) {
        const message =
          discardError instanceof Error
            ? discardError.message
            : String(discardError);
        this.logger.error(
          `Failed to destroy uncertain commit recovery connection: ${message}`,
        );
      }
      return;
    }

    try {
      await recoveryRunner.release();
    } catch (releaseError: unknown) {
      const message =
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError);
      this.logger.error(
        `Failed to release uncertain commit recovery connection: ${message}`,
      );
      try {
        discardQueryRunnerConnection(recoveryRunner);
      } catch (discardError: unknown) {
        const discardMessage =
          discardError instanceof Error
            ? discardError.message
            : String(discardError);
        this.logger.error(
          `Failed to destroy uncertain commit recovery connection: ${discardMessage}`,
        );
      }
    }
  }

  private async preserveUncertainMoveIntents(
    intents: MoveIntentPlan[],
    commitError: unknown,
  ): Promise<void> {
    if (intents.length === 0) return;
    const commitMessage =
      commitError instanceof Error ? commitError.message : String(commitError);
    let recoveryRunner: QueryRunner | undefined;
    let connectionSafe = false;
    try {
      recoveryRunner =
        this.moveIntentRepo.manager.connection.createQueryRunner();
      await recoveryRunner.connect();
      const timeoutRows: unknown = await recoveryRunner.query(
        'SELECT @@SESSION.innodb_lock_wait_timeout AS lockWaitTimeout',
      );
      const timeoutRow =
        Array.isArray(timeoutRows) &&
        timeoutRows[0] !== null &&
        typeof timeoutRows[0] === 'object'
          ? (timeoutRows[0] as Record<string, unknown>)
          : undefined;
      const originalLockWaitTimeout = Number(timeoutRow?.lockWaitTimeout);
      if (
        !Number.isInteger(originalLockWaitTimeout) ||
        originalLockWaitTimeout <= 0
      ) {
        throw new Error(
          'Could not read the recovery connection lock wait timeout',
        );
      }
      await recoveryRunner.query(
        `SET SESSION innodb_lock_wait_timeout = ${UNCERTAIN_RECOVERY_LOCK_WAIT_SECONDS}`,
      );
      await recoveryRunner.manager.getRepository(FileMoveIntent).upsert(
        intents.map((intent) => ({
          ...intent,
          status: 'UNCERTAIN' as const,
          recover_after: databaseDeadlineAfter(UNCERTAIN_COMMIT_GRACE_SECONDS),
          attempts: 0,
          last_error: `Uncertain upload commit: ${commitMessage}`,
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: databaseDeadlineAfter(
            UNCERTAIN_COMMIT_GRACE_SECONDS,
          ),
        })),
        ['id'],
      );
      await recoveryRunner.query('SET SESSION innodb_lock_wait_timeout = ?', [
        originalLockWaitTimeout,
      ]);
      connectionSafe = true;
    } catch (recoveryError: unknown) {
      const recoveryMessage =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
      this.logger.error(
        `Upload commit outcome is uncertain and recovery intent persistence failed; files were retained: ${commitMessage}; recovery error: ${recoveryMessage}`,
      );
    } finally {
      if (recoveryRunner) {
        await this.releaseRecoveryRunner(recoveryRunner, connectionSafe);
      }
    }
  }

  private dispatchCommittedOutbox(): void {
    try {
      void Promise.resolve(this.outboxDispatcher.dispatchPending()).catch(
        (dispatchError: unknown) => {
          const message =
            dispatchError instanceof Error
              ? dispatchError.message
              : String(dispatchError);
          this.logger.error(`Upload outbox dispatch deferred: ${message}`);
        },
      );
    } catch (dispatchError: unknown) {
      const message =
        dispatchError instanceof Error
          ? dispatchError.message
          : String(dispatchError);
      this.logger.error(`Upload outbox dispatch deferred: ${message}`);
    }
  }

  async listFiles(
    userId: string,
    projectId: string,
    options: {
      page?: number;
      page_size?: number;
      parse_status?: ParseStatus;
      file_type?: FileType;
    },
  ): Promise<{ items: SourceFile[]; total: number }> {
    await this.projectService.findOne(userId, projectId);
    const page = options.page ?? 1;
    const pageSize = options.page_size ?? 20;

    const qb = this.fileRepo
      .createQueryBuilder('f')
      .leftJoin(
        'style_templates',
        'st',
        'st.project_id = f.project_id AND JSON_CONTAINS(st.reference_file_ids, JSON_QUOTE(f.id))',
      )
      .where('f.project_id = :projectId', { projectId })
      .andWhere('st.id IS NULL');
    if (this.storageConfig().mode === 'broker') {
      qb.andWhere('f.deleted_at IS NULL');
    }

    if (options.parse_status) {
      qb.andWhere('f.parse_status = :status', { status: options.parse_status });
    }
    if (options.file_type) {
      qb.andWhere('f.file_type = :type', { type: options.file_type });
    }

    qb.orderBy('f.uploaded_at', 'DESC');

    const total = await qb.getCount();
    const items = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    return { items, total };
  }

  async getFile(
    userId: string,
    projectId: string,
    fileId: string,
  ): Promise<SourceFile> {
    await this.projectService.findOne(userId, projectId);
    const file = await this.fileRepo.findOne({
      where:
        this.storageConfig().mode === 'broker'
          ? { id: fileId, project_id: projectId, deleted_at: IsNull() }
          : { id: fileId, project_id: projectId },
    });
    if (!file) throw new NotFoundException('File not found');
    return file;
  }

  async getParseResult(
    userId: string,
    projectId: string,
    fileId: string,
  ): Promise<Document | null> {
    await this.getFile(userId, projectId, fileId);
    return this.docRepo.findOne({
      where: { file_id: fileId, project_id: projectId, is_active: true },
    });
  }

  async reparse(
    userId: string,
    projectId: string,
    fileId: string,
  ): Promise<void> {
    await this.getFile(userId, projectId, fileId);
    if (this.storageConfig().mode === 'broker') {
      throw new BadRequestException(
        'STORAGE_REPARSE_REQUIRES_NEW_OBJECT_GENERATION',
      );
    }
    await this.fileRepo.manager.transaction(async (manager) => {
      const sourceRepo = manager.getRepository(SourceFile);
      const outboxRepo = manager.getRepository(FileUploadOutbox);
      const source = await sourceRepo.findOne({
        where: { id: fileId, project_id: projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!source) throw new NotFoundException('File not found');
      const currentGeneration = source.parse_generation;
      const nextGeneration = currentGeneration + 1;
      const updated = await sourceRepo.update(
        {
          id: fileId,
          project_id: projectId,
          parse_generation: currentGeneration,
        },
        {
          parse_generation: nextGeneration,
          parse_status: ParseStatus.PENDING,
          error_message: null,
          parse_attempt_token: null,
          parse_lease_expires_at: null,
        },
      );
      if (updated.affected !== 1) {
        throw new Error('Failed to advance parse generation');
      }

      const existing = await outboxRepo.findOne({
        where: { file_id: fileId },
        lock: { mode: 'pessimistic_write' },
      });
      const event = {
        file_id: fileId,
        project_id: projectId,
        parse_generation: nextGeneration,
        job_id: `file-reparse:${fileId}:${nextGeneration}`,
        status: 'pending' as const,
        attempts: 0,
        last_error: null,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: databaseNow(),
      };
      if (existing) {
        await outboxRepo.update({ id: existing.id }, event);
      } else {
        await outboxRepo.insert(event);
      }
    });

    await this.outboxDispatcher.dispatchPending();

    this.logger.log(`Re-queued file ${fileId} for parsing`);
  }

  async deleteFile(
    userId: string | null,
    projectId: string,
    fileId: string,
  ): Promise<void> {
    if (this.storageConfig().mode === 'broker') {
      return this.deleteFileWithBroker(userId, projectId, fileId);
    }
    if (userId) {
      await this.projectService.findOne(userId, projectId);
    }

    const file = await this.fileRepo.findOne({
      where: { id: fileId, project_id: projectId },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    await this.citationRepo.delete({ project_id: projectId, file_id: fileId });
    await this.chunkService.deleteByFileId(fileId);
    await this.docRepo.delete({ file_id: fileId });
    await this.fileRepo.delete(fileId);

    try {
      await fs.unlink(file.file_path);
    } catch {
      this.logger.warn(`Failed to delete physical file: ${file.file_path}`);
    }
  }

  private async deleteFileWithBroker(
    userId: string | null,
    projectId: string,
    fileId: string,
  ): Promise<void> {
    if (!userId || !this.storageReadiness || !this.storageRequests) {
      throw new Error('STORAGE_AUTHORITY_UNPROVEN');
    }
    await this.projectService.findOne(userId, projectId);
    const authority = await this.storageReadiness.assertReady();
    const queryRunner = this.fileRepo.manager.connection.createQueryRunner();
    await queryRunner.connect();
    let transactionStarted = false;
    let storageObject: StorageObject | null = null;
    try {
      await queryRunner.startTransaction();
      transactionStarted = true;
      const sourceRepo = queryRunner.manager.getRepository(SourceFile);
      const source = await sourceRepo.findOne({
        where: { id: fileId, project_id: projectId, deleted_at: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!source) throw new NotFoundException('File not found');
      storageObject = await queryRunner.manager
        .getRepository(StorageObject)
        .findOne({
          where: {
            project_id: projectId,
            source_file_id: fileId,
            generation: String(source.parse_generation),
            state: 'AVAILABLE',
          },
          lock: { mode: 'pessimistic_write' },
        });
      if (!storageObject) throw new Error('STORAGE_OBJECT_NOT_AVAILABLE');
      const tombstonedAt = new Date();
      const updated = await sourceRepo.update(
        { id: fileId, project_id: projectId, deleted_at: IsNull() },
        {
          deleted_at: tombstonedAt,
          deleted_by: userId,
          active_ingestion_key: null,
          parse_attempt_token: null,
          parse_lease_expires_at: null,
        },
      );
      if (updated.affected !== 1) {
        throw new Error('SOURCE_FILE_TOMBSTONE_CONFLICT');
      }
      await queryRunner.manager.update(
        Document,
        { file_id: fileId, project_id: projectId },
        { is_active: false },
      );
      await queryRunner.manager.update(
        Chunk,
        { file_id: fileId, project_id: projectId },
        { is_active: false },
      );
      const result = await this.storageRequests.request(queryRunner, {
        operation_version: 'storage-operation.v1',
        kind: 'DELETE_BLOB',
        actor_id: userId,
        intent_id: randomUUID(),
        project_id: projectId,
        source_file_id: fileId,
        object_id: storageObject.id,
        object_generation_decimal: String(storageObject.generation),
        storage_key: storageObject.storage_key,
        quarantine_key: null,
        expected_sha256: storageObject.checksum_sha256,
        expected_size_decimal: String(storageObject.byte_size),
        authorization_kind: 'SOURCE_FILE_TOMBSTONE',
        authorization_id: fileId,
        storage_epoch: authority.storage_epoch,
      });
      if (result.status === 'REJECTED') {
        throw new Error(result.result_code || 'STORAGE_DELETE_REJECTED');
      }
      await queryRunner.commitTransaction();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      if (!queryRunner.isReleased) await queryRunner.release();
    }
  }

  private async assertUploadableFile(
    file: Express.Multer.File,
    fileType: FileType,
  ): Promise<number> {
    if (!ALLOWED_FILE_TYPES.has(fileType)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.originalname}`,
      );
    }

    if (!isAcceptedUploadDeclaration(file.originalname, file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file MIME type: ${file.originalname}`,
      );
    }

    const maxUploadSize = Math.min(
      this.parseSize(
        process.env.MAX_FILE_SIZE || process.env.MAX_UPLOAD_SIZE,
        DEFAULT_MAX_UPLOAD_SIZE,
      ),
      DEFAULT_MAX_UPLOAD_SIZE,
    );
    const stat = await fs.stat(file.path);
    if (stat.size > maxUploadSize) {
      throw new BadRequestException(`File too large: ${file.originalname}`);
    }

    await this.assertMagicBytes(file.path, fileType);
    return stat.size;
  }

  private async assertQuarantineFiles(
    files: Express.Multer.File[],
  ): Promise<void> {
    for (const file of files) {
      const resolvedPath = path.resolve(file.path);
      if (!this.isWithinQuarantine(resolvedPath)) {
        throw new BadRequestException('Upload file is outside quarantine');
      }
      const stat = await fs.lstat(resolvedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new BadRequestException(
          'Upload file is not a regular quarantine file',
        );
      }
      file.path = resolvedPath;
    }
  }

  private isWithinQuarantine(filePath: string): boolean {
    const config = this.storageConfig();
    const quarantineRoot =
      config.mode === 'broker' && config.quarantineRoot
        ? config.quarantineRoot
        : path.resolve(this.uploadDir, '.quarantine');
    const relative = path.relative(quarantineRoot, path.resolve(filePath));
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  }

  private async assertWithinUserQuota(
    userId: string,
    files: Express.Multer.File[],
    fileSizes: Map<Express.Multer.File, number>,
    manager: Pick<Repository<SourceFile>['manager'], 'createQueryBuilder'>,
  ): Promise<void> {
    const quota = this.parseSize(
      process.env.MAX_USER_STORAGE,
      DEFAULT_USER_STORAGE_QUOTA,
    );
    const existing = await manager
      .createQueryBuilder(SourceFile, 'file')
      .innerJoin('projects', 'project', 'project.id = file.project_id')
      .select('COALESCE(SUM(file.file_size), 0)', 'total')
      .where('project.user_id = :userId', { userId })
      .getRawOne<{ total: string | number }>();
    const incoming = files.reduce(
      (total, file) => total + (fileSizes.get(file) ?? 0),
      0,
    );
    const used = Number(existing?.total ?? 0);
    if (!Number.isFinite(used) || used + incoming > quota) {
      throw new BadRequestException('User storage quota exceeded');
    }
  }

  private async assertMagicBytes(
    filePath: string,
    fileType: FileType,
  ): Promise<void> {
    const handle = await fs.open(filePath, 'r');
    const header = Buffer.alloc(8192);
    try {
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const bytes = header.subarray(0, bytesRead);
      const isZip = bytes.subarray(0, 4).equals(Buffer.from('PK\x03\x04'));

      if (
        (fileType === FileType.PDF &&
          !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) ||
        ((fileType === FileType.DOCX || fileType === FileType.PPTX) && !isZip)
      ) {
        throw new BadRequestException('File contents do not match its type');
      }
    } finally {
      await handle.close();
    }

    if (fileType === FileType.DOCX || fileType === FileType.PPTX) {
      const isDocx = fileType === FileType.DOCX;
      const requiredPart = isDocx
        ? 'word/document.xml'
        : 'ppt/presentation.xml';
      const requiredContentType = isDocx
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
        : 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
      try {
        const archive = new AdmZip(filePath);
        let totalUncompressedSize = 0;
        for (const entry of archive.getEntries()) {
          const entrySize = entry.header.size;
          if (
            !Number.isSafeInteger(entrySize) ||
            entrySize < 0 ||
            entrySize > MAX_OOXML_ENTRY_SIZE
          ) {
            throw new BadRequestException(
              'OOXML archive entry exceeds its size limit',
            );
          }
          totalUncompressedSize += entrySize;
          if (totalUncompressedSize > MAX_OOXML_TOTAL_SIZE) {
            throw new BadRequestException(
              'OOXML archive exceeds its uncompressed size limit',
            );
          }
        }
        const contentTypes = archive.getEntry('[Content_Types].xml');
        const contentTypeXml = contentTypes?.getData().toString('utf8') ?? '';
        const mapsMainPart = hasContentTypeOverride(
          contentTypeXml,
          `/${requiredPart}`,
          requiredContentType,
        );
        if (!contentTypes || !mapsMainPart || !archive.getEntry(requiredPart)) {
          throw new BadRequestException('File contents do not match its type');
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException('File contents do not match its type');
      }
    }

    if (fileType === FileType.MD || fileType === FileType.TXT) {
      const contents = await fs.readFile(filePath);
      const decoded = contents.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(contents)) {
        throw new BadRequestException('Text uploads must be UTF-8 encoded');
      }
      if (decoded.includes('\u0000')) {
        throw new BadRequestException('Text uploads must not contain NUL');
      }
      let disallowedControls = 0;
      let characterCount = 0;
      for (const character of decoded) {
        characterCount += 1;
        const codePoint = character.codePointAt(0) ?? 0;
        if (
          codePoint < 0x20 &&
          codePoint !== 0x09 &&
          codePoint !== 0x0a &&
          codePoint !== 0x0d
        ) {
          disallowedControls += 1;
        }
      }
      if (disallowedControls / Math.max(characterCount, 1) > 0.01) {
        throw new BadRequestException(
          'Text uploads contain too many control characters',
        );
      }
    }
  }

  private createStoredFilename(originalName: string): string {
    const extension = path.extname(originalName).toLowerCase();
    const safeBase = path
      .basename(originalName, extension)
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_');
    return `${Date.now()}_${randomUUID()}_${safeBase}${extension}`;
  }

  private async renewActiveMoveIntents(
    intentIds: string[],
    writerToken: string,
  ): Promise<void> {
    if (intentIds.length === 0) return;
    const result = await this.moveIntentRepo.update(
      {
        id: In(intentIds),
        status: 'ACTIVE',
        writer_token: writerToken,
        lease_owner: writerToken,
      },
      {
        recover_after: databaseDeadlineAfter(MOVE_WRITER_LEASE_SECONDS),
        lease_expires_at: databaseDeadlineAfter(MOVE_WRITER_LEASE_SECONDS),
      },
    );
    if (result.affected !== intentIds.length) {
      throw new Error('Upload lost ownership of its active move intents');
    }
  }

  private async cleanupPaths(paths: string[]): Promise<string[]> {
    const failures: string[] = [];
    for (const filePath of paths) {
      try {
        assertStoragePathMayBeDeleted(filePath);
        await fs.unlink(filePath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          failures.push(filePath);
          this.logger.warn(`Failed to clean upload file: ${filePath}`);
        }
      }
    }
    return failures;
  }

  private storageConfig() {
    return parseStorageAuthorityConfig(process.env);
  }

  private async persistCleanupFailures(
    paths: string[],
    cause: unknown,
  ): Promise<void> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      await this.cleanupRepo.save(
        paths.map((filePath) =>
          this.cleanupRepo.create({
            file_path: filePath,
            reason,
            attempts: 0,
            last_error: null,
          }),
        ),
      );
    } catch (recordError: unknown) {
      const detail =
        recordError instanceof Error
          ? recordError.message
          : String(recordError);
      throw new AggregateError(
        [cause, recordError],
        `Upload failed and cleanup records could not be persisted: ${detail}`,
      );
    }
  }

  private parseSize(value: string | undefined, fallback: number): number {
    if (!value) return fallback;

    const normalized = value.trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
      return parseInt(normalized, 10);
    }

    const match = normalized.match(/^(\d+)(kb|mb|gb)$/);
    if (!match) return fallback;

    const size = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
      case 'kb':
        return size * 1024;
      case 'mb':
        return size * 1024 * 1024;
      case 'gb':
        return size * 1024 * 1024 * 1024;
      default:
        return fallback;
    }
  }
}

function hasContentTypeOverride(
  xml: string,
  partName: string,
  contentType: string,
): boolean {
  if (XMLValidator.validate(xml) !== true) return false;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    parseAttributeValue: false,
    processEntities: false,
  });
  const parsed = parser.parse(xml) as unknown;
  const document = asUnknownRecord(parsed);
  const types = asUnknownRecord(document?.['Types']);
  const overrides = Array.isArray(types?.['Override'])
    ? types['Override']
    : [types?.['Override']];
  return overrides.some((override) => {
    const attributes = asUnknownRecord(override);
    return (
      attributes?.['PartName'] === partName &&
      attributes['ContentType'] === contentType
    );
  });
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
