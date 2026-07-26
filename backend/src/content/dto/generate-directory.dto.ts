import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GenerateDirectoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  additional_instruction?: string;
}
