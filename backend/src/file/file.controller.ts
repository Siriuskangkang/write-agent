import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  NotFoundException,
  BadRequestException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import {
  ApiTags,
  ApiCookieAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileService, isAcceptedUploadDeclaration } from './file.service.js';
import { ListFilesQueryDto } from './dto/list-files-query.dto.js';
import { ok, paged } from '../common/dto/response.dto.js';
import { diskStorage } from 'multer';
import type { StorageEngine } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { ProjectUploadGuard } from './guards/project-upload.guard.js';
import { parseStorageAuthorityConfig } from '../storage/storage.config.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const quarantineStorage = createQuarantineStorage();

@ApiTags('Files')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:id/files')
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post()
  @ApiOperation({ summary: '上传文件（支持批量）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @UseGuards(ProjectUploadGuard)
  @UseInterceptors(
    FilesInterceptor('files', 50, {
      storage: quarantineStorage,
      fileFilter: (_req, file, cb) => {
        if (!isAcceptedUploadDeclaration(file.originalname, file.mimetype)) {
          cb(
            new BadRequestException('Unsupported file type or MIME type'),
            false,
          );
          return;
        }
        cb(null, true);
      },
      // Multer rejects a stream when it reaches fileSize, so one extra byte is
      // required to accept the exact 50 MiB boundary. FileService independently
      // rejects stat.size > 50 MiB.
      limits: { files: 50, fileSize: MAX_UPLOAD_BYTES + 1 },
    }),
  )
  async uploadFiles(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded');
    }
    const result = await this.fileService.uploadFiles(
      user.sub,
      projectId,
      files,
    );
    return ok(result);
  }

  @Get()
  @ApiOperation({ summary: '获取文件列表' })
  async listFiles(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Query() query: ListFilesQueryDto,
  ) {
    const { items, total } = await this.fileService.listFiles(
      user.sub,
      projectId,
      {
        page: query.page,
        page_size: query.page_size,
        parse_status: query.parse_status,
        file_type: query.file_type,
      },
    );
    return paged(items, total, query.page ?? 1, query.page_size ?? 20);
  }

  @Get(':fileId')
  @ApiOperation({ summary: '获取文件详情' })
  async getFile(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    const file = await this.fileService.getFile(user.sub, projectId, fileId);
    return ok(file);
  }

  @Get(':fileId/parse-result')
  @ApiOperation({ summary: '获取解析结果' })
  async getParseResult(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    const doc = await this.fileService.getParseResult(
      user.sub,
      projectId,
      fileId,
    );
    if (!doc) {
      throw new NotFoundException('Parse result not found');
    }
    return ok(doc);
  }

  @Post(':fileId/reparse')
  @ApiOperation({ summary: '重新解析文件' })
  async reparse(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    await this.fileService.reparse(user.sub, projectId, fileId);
    return ok({ message: 'Reparse queued' });
  }

  @Delete(':fileId')
  @ApiOperation({ summary: '删除文件' })
  async deleteFile(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    await this.fileService.deleteFile(user.sub, projectId, fileId);
    return ok({ message: 'File deleted' });
  }
}

function createQuarantineStorage(): StorageEngine {
  const disk = diskStorage({
    destination: (_req, _file, cb) => {
      let quarantineDir: string;
      try {
        const storage = parseStorageAuthorityConfig(process.env);
        quarantineDir =
          storage.mode === 'broker' && storage.quarantineRoot
            ? storage.quarantineRoot
            : path.join(process.env.UPLOAD_DIR || './uploads', '.quarantine');
      } catch (error) {
        cb(error as Error, '');
        return;
      }
      fs.mkdirSync(quarantineDir, { recursive: true });
      cb(null, quarantineDir);
    },
    filename: (_req, file, cb) => {
      const originalName = Buffer.from(file.originalname, 'latin1').toString(
        'utf8',
      );
      const ext = path.extname(originalName);
      const safeName = path
        .basename(originalName, ext)
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_');
      cb(null, `${randomUUID()}_${safeName}${ext}`);
    },
  });
  return {
    _handleFile(req, file, cb): void {
      disk._handleFile(req, file, cb);
    },
    _removeFile(req, file, cb): void {
      const quarantineDir = path.dirname(file.path);
      disk._removeFile(req, file, (error) => {
        fs.rmdir(quarantineDir, (directoryError) => {
          if (
            directoryError &&
            directoryError.code !== 'ENOENT' &&
            directoryError.code !== 'ENOTEMPTY'
          ) {
            cb(directoryError);
            return;
          }
          cb(error);
        });
      });
    },
  };
}
