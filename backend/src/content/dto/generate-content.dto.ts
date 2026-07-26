import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsOptional,
  IsInt,
  IsString,
  IsBoolean,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

export class GenerateContentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  session_id?: string;

  @ApiProperty()
  @IsString()
  chapter_node_id!: string;

  @ApiProperty()
  @IsString()
  section_node_id!: string;

  @ApiPropertyOptional({ description: '章标题，用于素材检索' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  chapter_title?: string;

  @ApiPropertyOptional({ description: '节标题，用于素材检索' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  section_title?: string;

  @ApiPropertyOptional({ default: 2000 })
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(10000)
  word_count?: number = 2000;

  @ApiPropertyOptional({ default: '教材' })
  @IsOptional()
  @IsString()
  style?: string = '教材';

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  strict_citation?: boolean = true;
}
