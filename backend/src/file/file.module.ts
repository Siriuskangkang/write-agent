import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { SourceFile } from './entities/source-file.entity.js';
import { Document } from './entities/document.entity.js';
import { FileService } from './file.service.js';
import { FileController } from './file.controller.js';
import { ChunkModule } from '../chunk/chunk.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { CitationMap } from '../citation/entities/citation-map.entity.js';
import { ProjectUploadGuard } from './guards/project-upload.guard.js';
import { FileUploadOutbox } from './entities/file-upload-outbox.entity.js';
import { FileCleanupRecord } from './entities/file-cleanup-record.entity.js';
import { FileUploadOutboxDispatcher } from './file-upload-outbox.dispatcher.js';
import { FileCleanupDispatcher } from './file-cleanup.dispatcher.js';
import { FileMoveIntent } from './entities/file-move-intent.entity.js';
import { FileMoveIntentDispatcher } from './file-move-intent.dispatcher.js';
import { StorageModule } from '../storage/storage.module.js';
import { StorageObject } from '../storage/entities/storage-object.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SourceFile,
      Document,
      CitationMap,
      FileUploadOutbox,
      FileCleanupRecord,
      FileMoveIntent,
      StorageObject,
    ]),
    BullModule.registerQueue({ name: 'file-parse' }),
    ChunkModule,
    AuthModule,
    ProjectModule,
    StorageModule,
  ],
  controllers: [FileController],
  providers: [
    FileService,
    ProjectUploadGuard,
    FileUploadOutboxDispatcher,
    FileCleanupDispatcher,
    FileMoveIntentDispatcher,
  ],
  exports: [FileService],
})
export class FileModule {}
