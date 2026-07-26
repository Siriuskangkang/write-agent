import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number = 20;
}

export class ApiSuccessResponse<T> {
  @ApiProperty({ example: true })
  success!: true;

  data!: T;

  @ApiProperty({ nullable: true, example: null })
  message!: string | null;
}

export class ApiErrorResponse {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ nullable: true, example: null })
  data!: null;

  @ApiProperty({ example: '错误描述' })
  message!: string;

  @ApiProperty({ example: 'PROJECT_NOT_FOUND' })
  error_code!: string;
}

export function ok<T>(data: T): ApiSuccessResponse<T> {
  return { success: true, data, message: null };
}

export function paged<T>(
  items: T[],
  total: number,
  page: number,
  page_size: number,
) {
  return ok({ items, total, page, page_size });
}

export function fail(message: string, error_code: string): ApiErrorResponse {
  return { success: false, data: null, message, error_code };
}
