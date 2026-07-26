import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { Document } from '../file/entities/document.entity.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { DenseIndexDispatcher } from './dense-index.dispatcher.js';
import { DenseIndexGcService } from './dense-index-gc.service.js';
import { DenseIndexService } from './dense-index.service.js';
import { DenseIndexWorker } from './dense-index.worker.js';
import { RetrievalCandidateRecord } from './entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from './entities/retrieval-index-version.entity.js';
import { RetrievalRun } from './entities/retrieval-run.entity.js';
import { RetrievalRunIndexVersion } from './entities/retrieval-run-index.entity.js';
import { INDEX_VERSION_RECORDER } from './injection-tokens.js';
import { QdrantService } from './qdrant.service.js';
import { RetrievalPersistenceService } from './retrieval-persistence.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SourceFile,
      Document,
      Chunk,
      RetrievalRun,
      RetrievalCandidateRecord,
      RetrievalIndexVersion,
      RetrievalRunIndexVersion,
    ]),
    BullModule.registerQueue({ name: 'dense-index' }),
    EmbeddingModule,
  ],
  providers: [
    QdrantService,
    RetrievalPersistenceService,
    DenseIndexService,
    DenseIndexDispatcher,
    DenseIndexGcService,
    DenseIndexWorker,
    {
      provide: INDEX_VERSION_RECORDER,
      useExisting: RetrievalPersistenceService,
    },
  ],
})
export class WorkerRetrievalModule {}
