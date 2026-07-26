import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CitationMap } from './entities/citation-map.entity.js';
import { ProjectState } from '../project/entities/project-state.entity.js';
import { CitationService } from './citation.service.js';
import { CitationController } from './citation.controller.js';
import { ProjectModule } from '../project/project.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GroundingAssignment } from './entities/grounding-assignment.entity.js';
import { GroundingClaim } from './entities/grounding-claim.entity.js';
import { GroundingVerifier } from './grounding-verifier.js';
import {
  CitationLedgerService,
  GROUNDING_EVIDENCE_STORE,
} from './citation-ledger.service.js';
import { SqlGroundingEvidenceStore } from './sql-grounding-evidence.store.js';
import { LLMModule } from '../llm/llm.module.js';
import { GROUNDING_SEMANTIC_REVIEWER } from './grounding-verifier.js';
import { SemanticGroundingReviewService } from './semantic-grounding-review.service.js';
import { AgentModule } from '../agent/agent.module.js';
import { ApprovedRenderContextService } from './atomic-grounding/approved-render-context.service.js';
import { AtomicGroundingVerifier } from './atomic-grounding/atomic-grounding.verifier.js';
import {
  ATOMIC_GROUNDING_METRIC_SINK,
  AtomicGroundingMetricsRecorder,
  AtomicGroundingPrometheusExporter,
} from './atomic-grounding/atomic-grounding.metrics.js';
import { AtomicGroundingCoordinator } from './atomic-grounding/atomic-grounding-coordinator.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CitationMap,
      ProjectState,
      GroundingAssignment,
      GroundingClaim,
    ]),
    ProjectModule,
    AuthModule,
    LLMModule,
    AgentModule,
  ],
  controllers: [CitationController],
  providers: [
    CitationService,
    GroundingVerifier,
    SqlGroundingEvidenceStore,
    CitationLedgerService,
    SemanticGroundingReviewService,
    ApprovedRenderContextService,
    AtomicGroundingVerifier,
    AtomicGroundingPrometheusExporter,
    AtomicGroundingMetricsRecorder,
    AtomicGroundingCoordinator,
    {
      provide: GROUNDING_EVIDENCE_STORE,
      useExisting: SqlGroundingEvidenceStore,
    },
    {
      provide: GROUNDING_SEMANTIC_REVIEWER,
      useExisting: SemanticGroundingReviewService,
    },
    {
      provide: ATOMIC_GROUNDING_METRIC_SINK,
      useExisting: AtomicGroundingPrometheusExporter,
    },
  ],
  exports: [
    CitationService,
    GroundingVerifier,
    SqlGroundingEvidenceStore,
    CitationLedgerService,
    AtomicGroundingCoordinator,
    AtomicGroundingMetricsRecorder,
    AtomicGroundingPrometheusExporter,
  ],
})
export class CitationModule {}
