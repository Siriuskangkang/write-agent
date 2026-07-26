import {
  Controller,
  Get,
  Post,
  Put,
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
import { ProjectService } from './project.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto.js';
import { UpdateProjectStateDto } from './dto/update-project-state.dto.js';
import { ok, paged } from '../common/dto/response.dto.js';

@ApiTags('Projects')
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProjectDto) {
    const project = await this.projectService.create(user.sub, dto);
    return ok(project);
  }

  @Get()
  async findAll(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListProjectsQueryDto,
  ) {
    const result = await this.projectService.findAll(user.sub, query);
    return paged(result.items, result.total, result.page, result.page_size);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const project = await this.projectService.findOne(user.sub, id);
    return ok(project);
  }

  @Put(':id')
  async update(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    const project = await this.projectService.update(user.sub, id, dto);
    return ok(project);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.projectService.remove(user.sub, id);
    return ok(null);
  }

  @Get(':id/state')
  async getState(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const state = await this.projectService.getState(user.sub, id);
    return ok(state);
  }

  @Put(':id/state')
  async updateState(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectStateDto,
  ) {
    const state = await this.projectService.updateState(user.sub, id, dto);
    return ok(state);
  }
}
