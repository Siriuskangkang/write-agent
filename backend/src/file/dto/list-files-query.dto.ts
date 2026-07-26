import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/response.dto.js';
import { FileType, ParseStatus } from '../../common/enums.js';

export class ListFilesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParseStatus })
  @IsOptional()
  @IsEnum(ParseStatus)
  parse_status?: ParseStatus;

  @ApiPropertyOptional({ enum: FileType })
  @IsOptional()
  @IsEnum(FileType)
  file_type?: FileType;
}
