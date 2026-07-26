import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';

export class ExpandContentDto {
  @ApiPropertyOptional({ default: 3000 })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(20000)
  target_word_count?: number = 3000;
}
