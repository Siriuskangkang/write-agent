import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum DirectoryNodeType {
  CHAPTER = 'chapter',
  SECTION = 'section',
}

export class DirectoryNodeDto {
  @ApiProperty({ description: '节点唯一标识' })
  @IsString()
  node_id!: string;

  @ApiPropertyOptional({ description: '父节点 ID，顶层节点为 null' })
  @IsOptional()
  @IsString()
  parent_node_id?: string | null;

  @ApiProperty({ description: '节点类型', enum: DirectoryNodeType })
  @IsEnum(DirectoryNodeType)
  node_type!: DirectoryNodeType;

  @ApiProperty({ description: '排序索引' })
  @IsInt()
  @Min(0)
  order_index!: number;

  @ApiProperty({ description: '标题' })
  @IsString()
  title!: string;

  @ApiPropertyOptional({ description: '描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: '素材支撑' })
  @IsOptional()
  @IsString()
  material_support?: string;

  @ApiPropertyOptional({ description: '体例层级标签（如：模块、项目、任务）' })
  @IsOptional()
  @IsString()
  level_label?: string;

  @ApiPropertyOptional({ description: '来源文件', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  source_files?: string[];
}

export class SaveDirectoryDto {
  @ApiProperty({ description: '基于的版本号，用于乐观锁' })
  @IsInt()
  @Min(1)
  base_version_number!: number;

  @ApiProperty({ description: '目录节点列表', type: [DirectoryNodeDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DirectoryNodeDto)
  nodes!: DirectoryNodeDto[];
}
