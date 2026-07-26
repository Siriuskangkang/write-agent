import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SessionService } from './session.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto.js';
import { ok, paged } from '../common/dto/response.dto.js';

@ApiTags('Sessions')
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Post()
  async create(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSessionDto,
  ) {
    const session = await this.sessionService.create(user.sub, projectId, dto);
    return ok(session);
  }

  @Get()
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const sessions = await this.sessionService.findAll(user.sub, projectId);
    return ok(sessions);
  }

  @Get(':sessionId/messages')
  async findMessages(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    const result = await this.sessionService.findMessages(
      user.sub,
      projectId,
      sessionId,
      query,
    );
    return paged(result.items, result.total, result.page, result.page_size);
  }

  @Post(':sessionId/messages')
  async createMessage(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: CreateMessageDto,
  ) {
    const message = await this.sessionService.createMessage(
      user.sub,
      projectId,
      sessionId,
      dto,
    );
    return ok(message);
  }

  @Delete(':sessionId')
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ) {
    await this.sessionService.remove(user.sub, projectId, sessionId);
    return ok(null);
  }
}
