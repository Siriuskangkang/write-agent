import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';

export class CompressContentDto {
  @ApiPropertyOptional({ default: 1000 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(10000)
  target_word_count?: number = 1000;
}
