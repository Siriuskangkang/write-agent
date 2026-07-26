import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  Res,
  StreamableFile,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ExportService } from './export.service.js';
import { CreateExportJobDto } from './dto/create-export-job.dto.js';
import { ok } from '../common/dto/response.dto.js';

@ApiTags('Export')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:id/export')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Post()
  @ApiOperation({ summary: '创建导出任务' })
  async createExportJob(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateExportJobDto,
  ) {
    const job = await this.exportService.createExportJob(user.sub, projectId, {
      format: dto.format,
      scope: dto.scope,
      chapter_ids: dto.chapter_ids,
      include_citations: dto.include_citations,
    });
    return ok(job);
  }

  @Get(':exportId')
  @ApiOperation({ summary: '查询导出任务状态' })
  async getExportJob(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
  ) {
    const job = await this.exportService.getExportJob(
      user.sub,
      projectId,
      exportId,
    );

    // 如果任务完成，添加下载 URL
    const result = {
      ...job,
      download_url:
        job.status === 'completed'
          ? `/api/projects/${projectId}/export/${exportId}/download`
          : null,
    };

    return ok(result);
  }

  @Get(':exportId/download')
  @ApiOperation({ summary: '下载导出文件' })
  async downloadExport(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const filePath = await this.exportService.getExportFilePath(
      user.sub,
      projectId,
      exportId,
    );

    const ext = path.extname(filePath).toLowerCase();
    const filename = `export-${exportId}${ext}`;

    const contentType =
      ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/markdown; charset=utf-8';

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });

    const stream = fs.createReadStream(filePath);
    return new StreamableFile(stream);
  }
}
