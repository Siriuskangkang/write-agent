import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: '张老师' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string | null;
}
