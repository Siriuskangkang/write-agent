import {
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectState } from './entities/project-state.entity.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto.js';
import { UpdateProjectStateDto } from './dto/update-project-state.dto.js';
import { ProjectAccessPolicy } from './project-access.policy.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { Document } from '../file/entities/document.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { StyleTemplate } from '../style-template/entities/style-template.entity.js';
import { CitationMap } from '../citation/entities/citation-map.entity.js';
import { DirectoryVersion } from '../content/entities/directory-version.entity.js';
import { OutlineVersion } from '../content/entities/outline-version.entity.js';
import { ContentVersion } from '../content/entities/content-version.entity.js';
import { WritingResult } from '../content/entities/writing-result.entity.js';
import { Session } from '../session/entities/session.entity.js';
import { Message } from '../session/entities/message.entity.js';
import { ExportJob } from '../export/entities/export-job.entity.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseStorageAuthorityConfig } from '../storage/storage.config.js';

@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);
  private readonly uploadDir: string;

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectState)
    private readonly stateRepo: Repository<ProjectState>,
    @InjectRepository(SourceFile)
    private readonly fileRepo: Repository<SourceFile>,
    @InjectRepository(Document)
    private readonly docRepo: Repository<Document>,
    @InjectRepository(Chunk)
    private readonly chunkRepo: Repository<Chunk>,
    @InjectRepository(StyleTemplate)
    private readonly styleTemplateRepo: Repository<StyleTemplate>,
    @InjectRepository(CitationMap)
    private readonly citationRepo: Repository<CitationMap>,
    @InjectRepository(DirectoryVersion)
    private readonly directoryVersionRepo: Repository<DirectoryVersion>,
    @InjectRepository(OutlineVersion)
    private readonly outlineVersionRepo: Repository<OutlineVersion>,
    @InjectRepository(ContentVersion)
    private readonly contentVersionRepo: Repository<ContentVersion>,
    @InjectRepository(WritingResult)
    private readonly writingResultRepo: Repository<WritingResult>,
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(ExportJob)
    private readonly exportJobRepo: Repository<ExportJob>,
    private readonly projectAccessPolicy: ProjectAccessPolicy,
  ) {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
  }

  async create(userId: string, dto: CreateProjectDto): Promise<Project> {
    const project = this.projectRepo.create({
      ...dto,
      user_id: userId,
    });
    const saved = await this.projectRepo.save(project);

    const state = this.stateRepo.create({
      project_id: saved.id,
      completed_chapters: [],
      pending_items: [],
      material_gaps: [],
    });
    await this.stateRepo.save(state);

    return saved;
  }

  async findAll(userId: string, query: ListProjectsQueryDto) {
    const { page = 1, page_size = 20, status, keyword } = query;

    const qb = this.projectRepo
      .createQueryBuilder('p')
      .where('p.user_id = :userId', { userId });

    if (status) {
      qb.andWhere('p.status = :status', { status });
    }

    if (keyword) {
      qb.andWhere('(p.name LIKE :kw OR p.description LIKE :kw)', {
        kw: `%${keyword}%`,
      });
    }

    qb.orderBy('p.updated_at', 'DESC');
    qb.skip((page - 1) * page_size).take(page_size);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, page_size };
  }

  async findOne(userId: string, id: string): Promise<Project> {
    return this.projectAccessPolicy.assertOwner(userId, id);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateProjectDto,
  ): Promise<Project> {
    const project = await this.findOne(userId, id);
    Object.assign(project, dto);
    return this.projectRepo.save(project);
  }

  async remove(userId: string, id: string): Promise<void> {
    const project = await this.findOne(userId, id);
    if (parseStorageAuthorityConfig(process.env).mode === 'broker') {
      throw new ConflictException('STORAGE_PROJECT_DELETE_REQUIRES_TOMBSTONE');
    }

    const files = await this.fileRepo.find({
      where: { project_id: id },
    });

    for (const file of files) {
      try {
        await fs.unlink(file.file_path);
      } catch (error) {
        this.logger.warn(
          `Failed to delete physical file: ${file.file_path}`,
          error,
        );
      }
    }

    const projectDir = path.join(this.uploadDir, id);
    try {
      await fs.rm(projectDir, { recursive: true, force: true });
    } catch {
      this.logger.warn(`Failed to delete project directory: ${projectDir}`);
    }

    await this.projectRepo.manager.transaction(async (manager) => {
      const lockedProjects: unknown = await manager.query(
        `SELECT id
           FROM projects
          WHERE id = ? AND user_id = ?
          FOR UPDATE`,
        [id, userId],
      );
      if (!Array.isArray(lockedProjects) || lockedProjects.length === 0) {
        throw new NotFoundException('项目不存在');
      }

      const sessions = await manager.find(Session, {
        where: { project_id: id },
      });
      const sessionIds = sessions.map((s) => s.id);

      if (sessionIds.length > 0) {
        await manager.delete(Message, { session_id: In(sessionIds) });
      }
      await manager.delete(Session, { project_id: id });

      await manager.delete(ExportJob, { project_id: id });

      const writingResults = await manager.find(WritingResult, {
        where: { project_id: id },
      });
      const resultIds = writingResults.map((r) => r.id);

      if (resultIds.length > 0) {
        await manager.delete(ContentVersion, { result_id: In(resultIds) });
      }
      await manager.delete(WritingResult, { project_id: id });

      await manager.delete(OutlineVersion, { project_id: id });
      await manager.delete(DirectoryVersion, { project_id: id });

      await manager.delete(CitationMap, { project_id: id });
      await manager.delete(Chunk, { project_id: id });
      await manager.delete(Document, { project_id: id });
      await manager.delete(SourceFile, { project_id: id });

      await manager.delete(StyleTemplate, { projectId: id });

      await manager.delete(ProjectState, { project_id: id });
      const projectDelete = await manager.delete(Project, {
        id: project.id,
        user_id: userId,
      });
      if (projectDelete.affected !== 1) {
        throw new NotFoundException('项目不存在');
      }
    });

    this.logger.log(`Project ${id} and all related data deleted successfully`);
  }

  async getState(userId: string, projectId: string): Promise<ProjectState> {
    await this.findOne(userId, projectId);
    const state = await this.stateRepo.findOne({
      where: { project_id: projectId },
    });
    if (!state) {
      throw new NotFoundException('项目状态不存在');
    }
    return state;
  }

  async updateState(
    userId: string,
    projectId: string,
    dto: UpdateProjectStateDto,
  ): Promise<ProjectState> {
    const state = await this.getState(userId, projectId);
    Object.assign(state, dto);
    return this.stateRepo.save(state);
  }
}
