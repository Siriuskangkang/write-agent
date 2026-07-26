import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MessageRole, MessageType } from '../../common/enums.js';

export class CreateMessageDto {
  @ApiProperty({ enum: MessageRole })
  @IsEnum(MessageRole)
  role!: MessageRole;

  @ApiProperty()
  @IsString()
  @MaxLength(20000)
  content!: string;

  @ApiPropertyOptional({ enum: MessageType, default: MessageType.CHAT })
  @IsOptional()
  @IsEnum(MessageType)
  message_type?: MessageType = MessageType.CHAT;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
