import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class RewriteContentDto {
  @ApiProperty()
  @IsString()
  instruction!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  additional_context?: string;
}
