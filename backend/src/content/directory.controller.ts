import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
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
import { GenerateDirectoryDto } from './dto/generate-directory.dto.js';
import { SaveDirectoryDto } from './dto/save-directory.dto.js';
import { ok } from '../common/dto/response.dto.js';
import { checkSseDuplicate, writeSseEvent, initSse } from './sse.utils.js';
import { WorkflowLegacyBridgeService } from '../workflow/workflow-legacy-bridge.service.js';
import { WorkflowType } from '../workflow/workflow.types.js';

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

@ApiTags('Directory')
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/directory')
export class DirectoryController {
  private readonly logger = new Logger(DirectoryController.name);

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
    @Body() dto: GenerateDirectoryDto,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    if (this.workflowBridge) {
      await this.workflowBridge.run(
        user.sub,
        projectId,
        WorkflowType.DIRECTORY,
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
    const resultId = `dir-${Date.now()}`;
    writeSseEvent(res, 'meta', {
      type: 'meta',
      result_id: resultId,
      task_type: 'directory',
      started_at: new Date().toISOString(),
    });
    try {
      const stream = this.contentService.generateDirectory(
        user.sub,
        projectId,
        dto,
      );
      for await (const token of stream) {
        writeSseEvent(res, 'token', {
          type: 'token',
          content: token,
          paragraph_key: '',
        });
      }
      writeSseEvent(res, 'done', {
        type: 'done',
        result_id: resultId,
        status: 'succeeded',
        citations: [],
      });
    } catch (err: unknown) {
      const message = getErrorMessage(err, '目录生成失败');
      this.logger.error(`目录生成失败: ${message}`);
      writeSseEvent(res, 'error', {
        type: 'error',
        message,
        error_code: 'DIRECTORY_GENERATION_FAILED',
      });
    } finally {
      cleanup();
    }
    res.end();
  }

  @Get()
  async getCurrent(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const dir = await this.contentService.getCurrentDirectory(
      user.sub,
      projectId,
    );
    return ok(dir);
  }

  @Get('versions')
  async getVersions(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const versions = await this.contentService.getDirectoryVersions(
      user.sub,
      projectId,
    );
    return ok(versions);
  }

  @Get(':versionId')
  async getVersion(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    const version = await this.contentService.getDirectoryVersion(
      user.sub,
      projectId,
      versionId,
    );
    return ok(version);
  }

  @Post('save')
  async save(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SaveDirectoryDto,
  ) {
    const saved = await this.contentService.saveDirectory(
      user.sub,
      projectId,
      dto,
    );
    return ok(saved);
  }

  @Patch('node/:nodeId')
  async updateNode(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId') nodeId: string,
    @Body('title') title: string,
  ) {
    return ok(
      await this.contentService.updateDirectoryNode(
        user.sub,
        projectId,
        nodeId,
        title,
      ),
    );
  }

  @Delete('node/:nodeId')
  async deleteNode(
    @CurrentUser() user: JwtPayload,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('nodeId') nodeId: string,
  ) {
    await this.contentService.deleteDirectoryNode(user.sub, projectId, nodeId);
    return ok(null);
  }
}
