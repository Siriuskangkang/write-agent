import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Header,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as express from 'express';
import type Redis from 'ioredis';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ContentService } from './content.service.js';
import { SSE_REDIS_CLIENT } from './content.constants.js';
import { GenerateOutlineDto } from './dto/generate-outline.dto.js';
import { SaveOutlineDto } from './dto/save-outline.dto.js';
import { UpdateOutlineDto } from './dto/update-outline.dto.js';
import { ok } from '../common/dto/response.dto.js';
import { checkSseDuplicate, writeSseEvent, initSse } from './sse.utils.js';
import { WorkflowLegacyBridgeService } from '../workflow/workflow-legacy-bridge.service.js';
import { WorkflowType } from '../workflow/workflow.types.js';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

@ApiTags('Outline')
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/outline')
export class OutlineController {
  private readonly logger = new Logger(OutlineController.name);

  constructor(
    private readonly contentService: ContentService,
    @Inject(SSE_REDIS_CLIENT) private readonly redis: Redis,
    @Optional()
    private readonly workflowBridge?: WorkflowLegacyBridgeService,
  ) {}

  @Post('generate')
  async generate(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: GenerateOutlineDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.OUTLINE,
        dto as unknown as Record<string, unknown>,
        req,
        res,
      );
      return;
    }
    const requestId = req.headers['x-request-id'] as string | undefined;
    if (await checkSseDuplicate(this.redis, requestId)) {
      res.status(409).json({
        error: 'Duplicate request',
        message: '请求已在处理中，请勿重复提交',
      });
      return;
    }
    await this.contentService.assertProjectOwner(user.sub, projectId);
    const cleanup = initSse(res);
    writeSseEvent(res, 'meta', {
      type: 'meta',
      result_id: '',
      task_type: 'outline',
      started_at: new Date().toISOString(),
    });
    let fullContent = '';
    try {
      const stream = this.contentService.generateOutline(
        user.sub,
        projectId,
        dto,
      );
      for await (const token of stream) {
        fullContent += token;
        writeSseEvent(res, 'token', {
          type: 'token',
          content: token,
          paragraph_key: '',
        });
      }

      // 流结束后后端直接解析并保存大纲
      const saved = await this.contentService.saveOutlineFromGeneration(
        user.sub,
        projectId,
        dto,
        fullContent,
      );

      writeSseEvent(res, 'done', {
        type: 'done',
        result_id: saved.id,
        outline_id: saved.id,
        status: 'succeeded',
        citations: [],
      });
    } catch (err: unknown) {
      const message = getErrorMessage(err, '大纲生成失败');
      this.logger.error(`大纲生成失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'OUTLINE_GENERATION_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Get(':outlineId')
  async getOutline(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('outlineId', ParseUUIDPipe) outlineId: string,
  ) {
    const outline = await this.contentService.getOutline(
      user.sub,
      projectId,
      outlineId,
    );
    return ok(outline);
  }

  @Get('chapter/:chapterNodeId/latest')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getLatestByChapter(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('chapterNodeId') chapterNodeId: string,
    @Query('section_node_id') sectionNodeId?: string,
  ) {
    const outline = await this.contentService.getLatestOutlineByChapter(
      user.sub,
      projectId,
      chapterNodeId,
      sectionNodeId,
    );
    return ok(outline);
  }

  @Post('save')
  async save(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveOutlineDto,
  ) {
    this.logger.warn(
      `[OutlineController.save] 被调用! chapter=${dto.chapter_node_id}, base_version=${dto.base_version_number}, content_keys=${Object.keys(dto.content || {}).join(',')}`,
    );
    const saved = await this.contentService.saveOutline(
      user.sub,
      projectId,
      dto,
    );
    return ok(saved);
  }

  @Patch(':outlineId')
  async updateOutline(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('outlineId', ParseUUIDPipe) outlineId: string,
    @Body() dto: UpdateOutlineDto,
  ) {
    return ok(
      await this.contentService.updateOutline(
        user.sub,
        projectId,
        outlineId,
        dto.content,
      ),
    );
  }
}
