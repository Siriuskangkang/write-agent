import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/response.dto.js';
import { ProjectStatus } from '../../common/enums.js';

export class ListProjectsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsIn(Object.values(ProjectStatus))
  status?: ProjectStatus;

  @ApiPropertyOptional({ description: '按名称或描述搜索' })
  @IsOptional()
  @IsString()
  keyword?: string;
}
