import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class GenerateOutlineDto {
  @ApiProperty()
  @IsString()
  chapter_node_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  section_node_id?: string;

  @ApiProperty()
  @IsString()
  chapter_title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  section_title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  section_description?: string = '';
}
