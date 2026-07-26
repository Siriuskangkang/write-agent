import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiCookieAuth, ApiOperation } from '@nestjs/swagger';
import { ChunkService } from './chunk.service.js';
import { PaginationQueryDto } from '../common/dto/response.dto.js';
import { ok, paged } from '../common/dto/response.dto.js';
import { JwtAuthGuard } from '../common/guards/auth.guard.js';
import type { JwtPayload } from '../common/guards/auth.guard.js';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ProjectService } from '../project/project.service.js';

class ListChunksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  file_id?: string;
}

@ApiTags('Chunks')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:id/chunks')
export class ChunkController {
  constructor(
    private readonly chunkService: ChunkService,
    private readonly projectService: ProjectService,
  ) {}

  @Get()
  @ApiOperation({ summary: '获取项目切块列表' })
  async listChunks(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Query() query: ListChunksQueryDto,
  ) {
    await this.projectService.findOne(user.sub, projectId);
    const { items, total } = await this.chunkService.getChunksByProjectId(
      projectId,
      {
        keyword: query.keyword,
        file_id: query.file_id,
        page: query.page,
        page_size: query.page_size,
      },
    );
    return paged(items, total, query.page ?? 1, query.page_size ?? 20);
  }

  @Get(':chunkId')
  @ApiOperation({ summary: '获取切块详情' })
  async getChunk(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
  ) {
    await this.projectService.findOne(user.sub, projectId);
    const chunk = await this.chunkService.getChunkByProjectId(
      projectId,
      chunkId,
    );
    if (!chunk) {
      throw new NotFoundException('Chunk not found');
    }
    return ok(chunk);
  }
}
