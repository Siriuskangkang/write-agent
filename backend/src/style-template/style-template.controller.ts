import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Sse,
  MessageEvent,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { StyleTemplateService } from './style-template.service.js';
import { StyleAnalyzer } from './analyzers/style-analyzer.js';
import { StyleTemplateTextCacheService } from './style-template-text-cache.service.js';
import { UpdateStyleTemplateDto } from './dto/update-style-template.dto.js';
import { Observable, from, switchMap, map } from 'rxjs';

@Controller('style-templates')
@UseGuards(JwtAuthGuard)
export class StyleTemplateController {
  constructor(
    private readonly styleTemplateService: StyleTemplateService,
    private readonly styleAnalyzer: StyleAnalyzer,
    private readonly textCacheService: StyleTemplateTextCacheService,
  ) {}

  @Post('analyze-text')
  async analyzeText(
    @CurrentUser() user: JwtPayload,
    @Body('projectId') projectId: string,
    @Body('textContent') textContent: string,
  ) {
    if (!projectId) {
      throw new BadRequestException('缺少 projectId');
    }
    if (!textContent || !textContent.trim()) {
      throw new BadRequestException('体例内容不能为空');
    }

    const template = await this.styleTemplateService.createFromText(
      user.sub,
      projectId,
    );

    // 将 textContent 暂存入内存，供 SSE 接口使用
    this.textCacheService.set(template.id, textContent.trim());

    return template;
  }

  @Get()
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('projectId') projectId: string,
  ) {
    return this.styleTemplateService.findAll(user.sub, projectId);
  }

  @Get('project/:projectId/active')
  findActiveByProject(
    @CurrentUser() user: JwtPayload,
    @Param('projectId') projectId: string,
  ) {
    return this.styleTemplateService.findActiveByProject(user.sub, projectId);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.styleTemplateService.findOneForUser(user.sub, id, projectId);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateStyleTemplateDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.styleTemplateService.updateForUser(
      user.sub,
      projectId,
      id,
      dto,
    );
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ) {
    await this.styleTemplateService.removeForUser(user.sub, projectId, id);
    return { message: 'Template deleted successfully' };
  }

  @Get(':id/analyze')
  @Sse()
  analyze(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('projectId') projectId?: string,
  ): Observable<MessageEvent> {
    return from(
      this.styleTemplateService.findOneForUser(user.sub, id, projectId),
    ).pipe(
      switchMap((template) => {
        const textContent = this.textCacheService.get(id);
        return this.styleAnalyzer.analyzeStream(
          template.id,
          template.filePath,
          textContent,
        );
      }),
      map((event) => ({
        type: event.type,
        data: event.data,
      })),
    );
  }
}
