import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import * as Bull from 'bull';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExportJob } from './entities/export-job.entity.js';
import { ExportFormat, ExportScope } from '../common/enums.js';
import { ProjectService } from '../project/project.service.js';

export interface CreateExportJobInput {
  format: ExportFormat;
  scope: ExportScope;
  chapter_ids?: string[];
  include_citations?: boolean;
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly exportDir: string;

  constructor(
    @InjectRepository(ExportJob)
    private readonly exportJobRepo: Repository<ExportJob>,
    @InjectQueue('export')
    private readonly exportQueue: Bull.Queue,
    @Optional() private readonly projectService?: ProjectService,
  ) {
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    this.exportDir = path.join(uploadDir, 'exports');
  }

  async createExportJob(
    userId: string,
    projectId: string,
    input: CreateExportJobInput,
  ): Promise<ExportJob> {
    await this.getProjectService().findOne(userId, projectId);

    const job = this.exportJobRepo.create({
      project_id: projectId,
      format: input.format,
      scope: input.scope,
      chapter_ids: input.chapter_ids ?? null,
      include_citations: input.include_citations ?? true,
      status: 'pending',
    });

    const saved = await this.exportJobRepo.save(job);

    await this.exportQueue.add('generate', {
      exportJobId: saved.id,
      projectId,
    });

    this.logger.log(`Export job ${saved.id} queued for project ${projectId}`);
    return saved;
  }

  async getExportJob(
    userId: string,
    projectId: string,
    exportId: string,
  ): Promise<ExportJob> {
    await this.getProjectService().findOne(userId, projectId);

    const job = await this.exportJobRepo.findOne({
      where: { id: exportId, project_id: projectId },
    });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }
    return job;
  }

  async getExportFilePath(
    userId: string,
    projectId: string,
    exportId: string,
  ): Promise<string> {
    const job = await this.getExportJob(userId, projectId, exportId);
    if (job.status !== 'completed' || !job.file_path) {
      throw new NotFoundException('Export file not ready');
    }

    try {
      await fs.access(job.file_path);
    } catch {
      throw new NotFoundException('Export file not found on disk');
    }

    return job.file_path;
  }

  async getExportDir(): Promise<string> {
    await fs.mkdir(this.exportDir, { recursive: true });
    return this.exportDir;
  }

  private getProjectService(): ProjectService {
    if (!this.projectService) {
      throw new Error('ProjectService is unavailable in the worker context');
    }
    return this.projectService;
  }
}
