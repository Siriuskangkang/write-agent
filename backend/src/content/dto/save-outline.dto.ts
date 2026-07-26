import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsInt,
  IsArray,
  IsOptional,
  IsBoolean,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// 新格式：体例栏目项
export class OutlineSectionItemDto {
  @ApiProperty({ description: '栏目名称' })
  @IsString()
  column!: string;

  @ApiProperty({ description: '是否必填' })
  @IsBoolean()
  required!: boolean;

  @ApiProperty({ description: '写作指导' })
  @IsString()
  writing_guide!: string;

  @ApiProperty({ description: '篇幅建议' })
  @IsString()
  length_suggestion!: string;

  @ApiProperty({ description: '内容要点', type: [String] })
  @IsArray()
  @IsString({ each: true })
  content_points!: string[];
}

// 参考资料
export class OutlineSourceRefDto {
  @ApiProperty({ description: '来源文件名' })
  @IsString()
  file!: string;

  @ApiPropertyOptional({ description: '页码范围' })
  @IsOptional()
  @Transform(({ value }) => (value == null ? undefined : String(value)))
  @IsString()
  pages?: string;

  @ApiProperty({ description: '相关性' })
  @IsString()
  relevance!: string;
}

// 大纲内容（新格式）
export class OutlineContentDto {
  @ApiPropertyOptional({ description: '节点标题' })
  @IsOptional()
  @IsString()
  node_title?: string;

  @ApiPropertyOptional({ description: '层级（模块/任务/小节）' })
  @IsOptional()
  @IsString()
  level?: string;

  @ApiProperty({ description: '体例栏目列表', type: [OutlineSectionItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OutlineSectionItemDto)
  sections!: OutlineSectionItemDto[];

  @ApiPropertyOptional({ description: '重点列表', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  key_points?: string[];

  @ApiPropertyOptional({ description: '难点列表', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  difficulties?: string[];

  @ApiPropertyOptional({ description: '参考资料', type: [OutlineSourceRefDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OutlineSourceRefDto)
  source_refs?: OutlineSourceRefDto[];
}

export class SaveOutlineDto {
  @ApiProperty()
  @IsString()
  chapter_node_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  section_node_id?: string;

  @ApiProperty({ description: '章节索引' })
  @IsInt()
  @Min(0)
  chapter_index!: number;

  @ApiProperty({ description: '章节标题' })
  @IsString()
  chapter_title!: string;

  @ApiProperty({ description: '基于的版本号，用于乐观锁' })
  @IsInt()
  @Min(1)
  base_version_number!: number;

  @ApiProperty({ description: '大纲内容结构' })
  @ValidateNested()
  @Type(() => OutlineContentDto)
  content!: OutlineContentDto;
}
