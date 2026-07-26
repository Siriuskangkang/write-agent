import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { RetrievalService } from './retrieval.service.js';
import { RetrieveDto } from './dto/retrieve.dto.js';
import { ok } from '../common/dto/response.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ProjectService } from '../project/project.service.js';

@ApiTags('Retrieval')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:id/retrieve')
export class RetrievalController {
  constructor(
    private readonly retrievalService: RetrievalService,
    private readonly projectService: ProjectService,
  ) {}

  @Post()
  @ApiOperation({ summary: '混合检索项目素材' })
  async retrieve(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() dto: RetrieveDto,
  ) {
    await this.projectService.findOne(user.sub, projectId);
    const results = await this.retrievalService.retrieve(projectId, dto);
    return ok(results);
  }
}
