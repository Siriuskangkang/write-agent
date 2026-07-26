import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { WorkflowEvent } from './entities/workflow-event.entity.js';
import { WorkflowJob } from './entities/workflow-job.entity.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowService } from './workflow.service.js';
import { WORKFLOW_QUEUE } from './workflow.processor.js';
import { WorkflowDispatchService } from './workflow-dispatch.service.js';
import { WorkflowEventStreamService } from './workflow-event-stream.service.js';
import { WorkflowLegacyBridgeService } from './workflow-legacy-bridge.service.js';
import { LLMModule } from '../llm/llm.module.js';
import { AuthoringModule } from '../authoring/authoring.module.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowJob, WorkflowEvent]),
    BullModule.registerQueue({ name: WORKFLOW_QUEUE }),
    AuthModule,
    ProjectModule,
    LLMModule,
    AuthoringModule,
    StorageModule,
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    WorkflowDispatchService,
    WorkflowEventStreamService,
    WorkflowLegacyBridgeService,
  ],
  exports: [
    WorkflowService,
    LLMModule,
    WorkflowDispatchService,
    WorkflowEventStreamService,
    WorkflowLegacyBridgeService,
  ],
})
export class WorkflowModule {}
