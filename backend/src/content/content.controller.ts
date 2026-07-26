import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Header,
  Param,
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
import { GenerateContentDto } from './dto/generate-content.dto.js';
import { RewriteContentDto } from './dto/rewrite-content.dto.js';
import { ExpandContentDto } from './dto/expand-content.dto.js';
import { CompressContentDto } from './dto/compress-content.dto.js';
import { ok } from '../common/dto/response.dto.js';
import { checkSseDuplicate, writeSseEvent, initSse } from './sse.utils.js';
import { WorkflowLegacyBridgeService } from '../workflow/workflow-legacy-bridge.service.js';
import { WorkflowType } from '../workflow/workflow.types.js';
import { WritingResultStatus } from '../common/enums.js';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

@ApiTags('Content')
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/content')
export class ContentController {
  private readonly logger = new Logger(ContentController.name);

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
    @Body() dto: GenerateContentDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.CONTENT,
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
    try {
      const stream = this.contentService.generateContent(
        user.sub,
        projectId,
        dto,
      );
      for await (const event of stream) {
        writeSseEvent(res, event.type, event.data);
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err, '正文生成失败');
      this.logger.error(`正文生成失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'CONTENT_GENERATION_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Post(':resultId/rewrite')
  async rewrite(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: RewriteContentDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.REWRITE,
        {
          ...(dto as unknown as Record<string, unknown>),
          result_id: resultId,
        },
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
    try {
      const stream = this.contentService.rewriteContent(
        user.sub,
        projectId,
        resultId,
        dto,
      );
      for await (const event of stream) {
        writeSseEvent(res, event.type, event.data);
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err, '重写失败');
      this.logger.error(`重写失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'REWRITE_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Post(':resultId/expand')
  async expand(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: ExpandContentDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.EXPAND,
        {
          ...(dto as unknown as Record<string, unknown>),
          result_id: resultId,
        },
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
    try {
      const stream = this.contentService.expandContent(
        user.sub,
        projectId,
        resultId,
        dto,
      );
      for await (const event of stream) {
        writeSseEvent(res, event.type, event.data);
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err, '扩写失败');
      this.logger.error(`扩写失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'EXPAND_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Post(':resultId/compress')
  async compress(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() dto: CompressContentDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.COMPRESS,
        {
          ...(dto as unknown as Record<string, unknown>),
          result_id: resultId,
        },
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
    try {
      const stream = this.contentService.compressContent(
        user.sub,
        projectId,
        resultId,
        dto,
      );
      for await (const event of stream) {
        writeSseEvent(res, event.type, event.data);
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err, '精简失败');
      this.logger.error(`精简失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'COMPRESS_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Post(':resultId/stop')
  async stop(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ) {
    const durableCancelled = await this.workflowBridge?.cancelLegacyResult(
      user.sub,
      projectId,
      resultId,
    );
    if (durableCancelled) {
      return ok({
        id: resultId,
        project_id: projectId,
        status: WritingResultStatus.STOPPED,
        workflow_job_id: resultId,
      });
    }
    const result = await this.contentService.stopGeneration(
      user.sub,
      projectId,
      resultId,
    );
    return ok(result);
  }

  @Get('section/:sectionNodeId/latest')
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getLatestBySection(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sectionNodeId') sectionNodeId: string,
  ) {
    const result = await this.contentService.getLatestResultBySection(
      user.sub,
      projectId,
      sectionNodeId,
    );
    return ok(result);
  }

  @Get(':resultId')
  async getResult(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ) {
    const result = await this.contentService.getWritingResult(
      user.sub,
      projectId,
      resultId,
    );
    return ok(result);
  }

  @Patch(':resultId')
  async updateWritingResult(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body('content') content: string,
  ) {
    return ok(
      await this.contentService.updateWritingResult(
        user.sub,
        projectId,
        resultId,
        content,
      ),
    );
  }
}
