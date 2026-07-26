import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { ChunkService } from '../chunk/chunk.service.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { SourceFile } from './entities/source-file.entity.js';
import { Document } from './entities/document.entity.js';
import { ParseWorker } from './parse.worker.js';
import { FileUploadOutbox } from './entities/file-upload-outbox.entity.js';
import { FileUploadOutboxDispatcher } from './file-upload-outbox.dispatcher.js';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import { FileMoveIntentDispatcher } from './file-move-intent.dispatcher.js';
import { FileCleanupRecord } from './entities/file-cleanup-record.entity.js';
import { FileCleanupDispatcher } from './file-cleanup.dispatcher.js';
import { StructuredIngestionService } from './structured-ingestion.service.js';
import { RetrievalIndexVersion } from '../retrieval/entities/retrieval-index-version.entity.js';
import { IndexActivationRecorder } from '../retrieval/index-activation-recorder.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageObject } from '../storage/entities/storage-object.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SourceFile,
      Document,
      Chunk,
      FileUploadOutbox,
      FileMoveIntent,
      FileCleanupRecord,
      RetrievalIndexVersion,
      StorageObject,
    ]),
    BullModule.registerQueue({ name: 'file-parse' }),
    EmbeddingModule,
    StorageModule,
  ],
  providers: [
    ChunkService,
    ParseWorker,
    FileUploadOutboxDispatcher,
    FileMoveIntentDispatcher,
    FileCleanupDispatcher,
    StructuredIngestionService,
    IndexActivationRecorder,
  ],
})
export class WorkerFileModule {}
