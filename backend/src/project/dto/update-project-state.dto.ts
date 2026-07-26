import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsArray, IsUUID } from 'class-validator';

export class UpdateProjectStateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  current_directory_version_id?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  completed_chapters?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  in_progress_chapter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  in_progress_section?: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  pending_items?: any[];

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  material_gaps?: any[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  user_notes?: string;
}
