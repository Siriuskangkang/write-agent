import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { CitationService } from './citation.service.js';
import { MarkMaterialGapDto } from './dto/mark-material-gap.dto.js';
import { ok } from '../common/dto/response.dto.js';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@ApiTags('Citations')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/content')
export class CitationController {
  constructor(private readonly citationService: CitationService) {}

  @Get(':resultId/citations')
  @ApiOperation({ summary: '获取正文结果的所有引用' })
  async getCitationsByResult(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ) {
    const citations = await this.citationService.getCitationsByResultId(
      user.sub,
      projectId,
      resultId,
    );
    return ok(citations);
  }

  @Get(':citationId/citation')
  @ApiOperation({ summary: '获取单条引用详情' })
  async getCitationById(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('citationId', ParseUUIDPipe) citationId: string,
  ) {
    const citation = await this.citationService.getCitationById(
      user.sub,
      projectId,
      citationId,
    );
    return ok(citation);
  }

  @Get(':resultId/citation-ledger')
  @ApiOperation({ summary: '获取正文结果的可核验引用账本' })
  async getCitationLedgerByResult(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ) {
    const ledger = await this.citationService.getCitationLedgerByResultId(
      user.sub,
      projectId,
      resultId,
    );
    return ok(ledger);
  }

  @Post(':resultId/material-gap')
  @ApiOperation({ summary: '标记素材不足' })
  async markMaterialGap(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: MarkMaterialGapDto,
  ) {
    const result = await this.citationService.markMaterialGap(
      user.sub,
      projectId,
      resultId,
      dto.reason,
    );
    return ok(result);
  }
}
