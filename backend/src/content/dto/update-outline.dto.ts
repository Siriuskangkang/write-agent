import { ApiProperty } from '@nestjs/swagger';
import { ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OutlineContentDto } from './save-outline.dto.js';

export class UpdateOutlineDto {
  @ApiProperty({ description: '更新后的大纲内容', type: OutlineContentDto })
  @ValidateNested()
  @Type(() => OutlineContentDto)
  content!: OutlineContentDto;
}
