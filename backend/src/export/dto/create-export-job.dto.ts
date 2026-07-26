import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsArray,
  IsUUID,
  IsBoolean,
  ArrayMinSize,
  ValidateIf,
} from 'class-validator';
import { ExportFormat, ExportScope } from '../../common/enums.js';

export class CreateExportJobDto {
  @ApiProperty({ enum: ExportFormat })
  @IsEnum(ExportFormat)
  format!: ExportFormat;

  @ApiProperty({ enum: ExportScope })
  @IsEnum(ExportScope)
  scope!: ExportScope;

  @ApiPropertyOptional({
    type: [String],
    description: '章节 ID 列表（scope=chapters 时必填）',
  })
  @ValidateIf(
    (o: Pick<CreateExportJobDto, 'scope' | 'chapter_ids'>) =>
      o.scope === ExportScope.CHAPTERS || o.chapter_ids != null,
  )
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  chapter_ids?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  include_citations?: boolean;
}
