import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class MarkMaterialGapDto {
  @ApiProperty({ description: '素材不足原因' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
