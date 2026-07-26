import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { WORKFLOW_QUEUE } from '../workflow/workflow.processor.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { RequestCorrelationMiddleware } from './request-correlation.middleware.js';
import { WorkerHeartbeatService } from './worker-heartbeat.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: WORKFLOW_QUEUE })],
  controllers: [OperationsController],
  providers: [OperationsService, WorkerHeartbeatService],
  exports: [WorkerHeartbeatService],
})
export class OperationsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestCorrelationMiddleware).forRoutes('*');
  }
}
