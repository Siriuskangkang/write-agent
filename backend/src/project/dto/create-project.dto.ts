import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ example: '深度学习教材' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: '教材' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ example: '计算机专业本科生' })
  @IsOptional()
  @IsString()
  target_audience?: string;

  @ApiPropertyOptional({ example: 10, default: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  target_chapters?: number;

  @ApiPropertyOptional({ example: '教材', default: '教材' })
  @IsOptional()
  @IsString()
  style?: string;

  @ApiPropertyOptional({ example: '一本面向本科生的深度学习教材' })
  @IsOptional()
  @IsString()
  description?: string;
}
