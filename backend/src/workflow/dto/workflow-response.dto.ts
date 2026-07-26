import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { WorkflowJob } from '../entities/workflow-job.entity.js';
import { WorkflowStatus, WorkflowType } from '../workflow.types.js';

export class PublicWorkflowErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

export class PublicWorkflowJobDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  project_id!: string;

  @ApiProperty({ enum: WorkflowType })
  workflow_type!: WorkflowType;

  @ApiProperty({ enum: WorkflowStatus })
  status!: WorkflowStatus;

  @ApiPropertyOptional({ nullable: true })
  cancel_requested_at!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  approved_at!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  started_at!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  completed_at!: Date | null;

  @ApiProperty()
  created_at!: Date;

  @ApiProperty()
  updated_at!: Date;

  @ApiPropertyOptional({ type: PublicWorkflowErrorDto, nullable: true })
  error!: PublicWorkflowErrorDto | null;
}

export function toPublicWorkflowJob(job: WorkflowJob): PublicWorkflowJobDto {
  const hasPublicError =
    job.status === WorkflowStatus.FAILED ||
    job.status === WorkflowStatus.WAITING_MATERIAL ||
    job.public_error_code !== null ||
    job.public_error_message !== null;
  return {
    id: job.id,
    project_id: job.project_id,
    workflow_type: job.workflow_type,
    status: job.status,
    cancel_requested_at: job.cancel_requested_at,
    approved_at: job.approved_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    created_at: job.created_at,
    updated_at: job.updated_at,
    error: hasPublicError
      ? {
          code: job.public_error_code ?? 'WORKFLOW_FAILED',
          message:
            job.public_error_message ?? '任务执行失败，请稍后重试或联系管理员',
        }
      : null,
  };
}
