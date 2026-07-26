import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class CreateSessionDto {
  @ApiPropertyOptional({ example: '新会话', default: '新会话' })
  @IsOptional()
  @IsString()
  title?: string;
}
