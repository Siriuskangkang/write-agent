import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { WorkflowType } from '../workflow.types.js';

export const PUBLIC_GENERATION_WORKFLOW_TYPES = [
  WorkflowType.DIRECTORY,
  WorkflowType.OUTLINE,
  WorkflowType.CONTENT,
  WorkflowType.REWRITE,
  WorkflowType.EXPAND,
  WorkflowType.COMPRESS,
] as const;

export type PublicGenerationWorkflowType =
  (typeof PUBLIC_GENERATION_WORKFLOW_TYPES)[number];

export class CreateWorkflowDto {
  @ApiProperty({ enum: PUBLIC_GENERATION_WORKFLOW_TYPES })
  @IsIn(PUBLIC_GENERATION_WORKFLOW_TYPES)
  workflow_type!: PublicGenerationWorkflowType;

  @ApiPropertyOptional({
    description: '显式复用时返回原任务；省略时服务端生成唯一键，不进行隐式去重',
    maxLength: 128,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  idempotency_key?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ['authoring-approval-ui.v1'] })
  @IsOptional()
  @IsIn(['authoring-approval-ui.v1'])
  client_contract_version?: 'authoring-approval-ui.v1';
}
