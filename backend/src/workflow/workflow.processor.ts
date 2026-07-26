import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type * as Bull from 'bull';
import { WorkflowEngine } from './workflow.engine.js';

export const WORKFLOW_QUEUE = 'workflow';
export const WORKFLOW_RUN_JOB = 'run';

@Processor(WORKFLOW_QUEUE)
export class WorkflowProcessor {
  private readonly logger = new Logger(WorkflowProcessor.name);

  constructor(private readonly engine: WorkflowEngine) {}

  @Process(WORKFLOW_RUN_JOB)
  async handle(job: Bull.Job<{ jobId: string }>): Promise<void> {
    this.logger.debug(`Workflow trigger received for ${job.data.jobId}`);
    await this.engine.run(job.data.jobId);
  }
}
