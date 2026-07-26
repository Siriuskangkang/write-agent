import { PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsIn } from 'class-validator';
import { ProjectStatus } from '../../common/enums.js';

export class UpdateProjectDto extends PartialType(CreateProjectDto) {
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsIn(Object.values(ProjectStatus))
  status?: ProjectStatus;
}
