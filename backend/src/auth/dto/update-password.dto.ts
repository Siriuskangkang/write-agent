import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class UpdatePasswordDto {
  @ApiProperty({ example: 'oldPassword123' })
  @IsString()
  old_password!: string;

  @ApiProperty({ example: 'newPassword456', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  new_password!: string;
}
