import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsIn,
  IsOptional,
  IsInt,
  Min,
  Max,
  Length,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RetrieveDto {
  @ApiProperty({ description: '检索查询', minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  query!: string;

  @ApiProperty({
    enum: ['directory', 'outline', 'content'],
    description: '任务类型',
  })
  @IsIn(['directory', 'outline', 'content'])
  task_type!: 'directory' | 'outline' | 'content';

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  top_k?: number = 10;
}
