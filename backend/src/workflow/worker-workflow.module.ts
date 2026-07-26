import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModule } from '../content/content.module.js';
import { WorkflowEvent } from './entities/workflow-event.entity.js';
import { WorkflowJob } from './entities/workflow-job.entity.js';
import { WorkflowDomainCommit } from './entities/workflow-domain-commit.entity.js';
import { MysqlWorkflowExecutionStore } from './mysql-workflow-execution.store.js';
import {
  WORKFLOW_EXECUTION_STORE,
  WORKFLOW_TASK_EXECUTOR,
  WorkflowEngine,
} from './workflow.engine.js';
import { WorkflowGenerationExecutor } from './workflow-generation.executor.js';
import { WorkflowProcessor, WORKFLOW_QUEUE } from './workflow.processor.js';
import { WorkflowModule } from './workflow.module.js';
import { WorkflowRecoveryDispatcher } from './workflow-recovery.dispatcher.js';
import { WorkflowDomainCommitService } from './workflow-domain-commit.service.js';
import { CitationModule } from '../citation/citation.module.js';
import { AuthoringModule } from '../authoring/authoring.module.js';
import { DeterministicAuthoringGraph } from '../authoring/graph/deterministic-authoring.graph.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkflowJob,
      WorkflowEvent,
      WorkflowDomainCommit,
    ]),
    BullModule.registerQueue({ name: WORKFLOW_QUEUE }),
    WorkflowModule,
    ContentModule,
    CitationModule,
    AuthoringModule,
    StorageModule,
  ],
  providers: [
    MysqlWorkflowExecutionStore,
    DeterministicAuthoringGraph,
    WorkflowGenerationExecutor,
    WorkflowDomainCommitService,
    {
      provide: WORKFLOW_EXECUTION_STORE,
      useExisting: MysqlWorkflowExecutionStore,
    },
    {
      provide: WORKFLOW_TASK_EXECUTOR,
      useExisting: WorkflowGenerationExecutor,
    },
    WorkflowEngine,
    WorkflowProcessor,
    WorkflowRecoveryDispatcher,
  ],
})
export class WorkerWorkflowModule {}
