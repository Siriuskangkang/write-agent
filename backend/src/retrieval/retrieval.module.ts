import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { RetrievalService } from './retrieval.service.js';
import { RetrievalController } from './retrieval.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { SparseRetriever } from './sparse-retriever.js';
import { DenseRetriever } from './dense-retriever.js';
import { QdrantService } from './qdrant.service.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { LegacyShadowRetriever } from './legacy-shadow-retriever.js';
import { RetrievalPersistenceService } from './retrieval-persistence.service.js';
import { RetrievalRun } from './entities/retrieval-run.entity.js';
import { RetrievalCandidateRecord } from './entities/retrieval-candidate.entity.js';
import { RetrievalIndexVersion } from './entities/retrieval-index-version.entity.js';
import { RetrievalRunIndexVersion } from './entities/retrieval-run-index.entity.js';
import {
  DENSE_RETRIEVER,
  INDEX_VERSION_RECORDER,
  LEGACY_RETRIEVER,
  RETRIEVAL_RUN_RECORDER,
  SPARSE_RETRIEVER,
} from './injection-tokens.js';
import { DenseIndexService } from './dense-index.service.js';
import { RagEvaluationGate } from './evaluation-gate.js';
import { NeighborExpander } from './neighbor-expander.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Chunk,
      SourceFile,
      RetrievalRun,
      RetrievalCandidateRecord,
      RetrievalIndexVersion,
      RetrievalRunIndexVersion,
    ]),
    AuthModule,
    ProjectModule,
    EmbeddingModule,
  ],
  controllers: [RetrievalController],
  providers: [
    RetrievalService,
    SparseRetriever,
    DenseRetriever,
    QdrantService,
    LegacyShadowRetriever,
    RetrievalPersistenceService,
    DenseIndexService,
    HybridRetriever,
    NeighborExpander,
    RagEvaluationGate,
    { provide: SPARSE_RETRIEVER, useExisting: SparseRetriever },
    { provide: DENSE_RETRIEVER, useExisting: DenseRetriever },
    { provide: LEGACY_RETRIEVER, useExisting: LegacyShadowRetriever },
    {
      provide: RETRIEVAL_RUN_RECORDER,
      useExisting: RetrievalPersistenceService,
    },
    {
      provide: INDEX_VERSION_RECORDER,
      useExisting: RetrievalPersistenceService,
    },
  ],
  exports: [RetrievalService, DenseIndexService, QdrantService],
})
export class RetrievalModule {}
