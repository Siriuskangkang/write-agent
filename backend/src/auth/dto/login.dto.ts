import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({ require_tld: false })
  email!: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  password!: string;
}
