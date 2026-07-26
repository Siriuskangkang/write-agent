import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import { StyleTemplate } from './entities/style-template.entity.js';
import { CreateStyleTemplateDto } from './dto/create-style-template.dto.js';
import { UpdateStyleTemplateDto } from './dto/update-style-template.dto.js';
import type { StyleFeatures } from './entities/style-template.entity.js';
import { ProjectAccessPolicy } from '../project/project-access.policy.js';
import { assertStoragePathMayBeDeleted } from '../storage/storage-path-policy.js';

@Injectable()
export class StyleTemplateService {
  constructor(
    @InjectRepository(StyleTemplate)
    private readonly styleTemplateRepository: Repository<StyleTemplate>,
    private readonly projectAccessPolicy: ProjectAccessPolicy,
  ) {}

  async create(
    userId: string,
    dto: CreateStyleTemplateDto,
  ): Promise<StyleTemplate> {
    await this.projectAccessPolicy.assertOwner(userId, dto.projectId);
    const oldTemplates = await this.styleTemplateRepository.find({
      where: { projectId: dto.projectId },
    });

    for (const oldTemplate of oldTemplates) {
      if (oldTemplate.filePath) {
        assertStoragePathMayBeDeleted(oldTemplate.filePath);
        try {
          await fs.unlink(oldTemplate.filePath);
        } catch {
          // 文件可能已被删除，忽略错误
        }
      }
      await this.styleTemplateRepository.remove(oldTemplate);
    }

    const template = this.styleTemplateRepository.create({
      name: dto.name,
      projectId: dto.projectId,
      filePath: dto.filePath ?? null,
      referenceFileIds: null,
      status: 'pending',
    });

    return this.styleTemplateRepository.save(template);
  }

  async findAll(userId: string, projectId: string): Promise<StyleTemplate[]> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    return this.styleTemplateRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
    });
  }

  async findActiveByProject(
    userId: string,
    projectId: string,
  ): Promise<StyleTemplate | null> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const templates = await this.styleTemplateRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return templates[0] || null;
  }

  async getProjectActiveTemplate(
    projectId: string,
  ): Promise<StyleTemplate | null> {
    return this.styleTemplateRepository.findOne({
      where: {
        projectId,
        status: 'completed',
      },
      order: {
        updatedAt: 'DESC',
      },
    });
  }

  async findOne(id: string): Promise<StyleTemplate> {
    const template = await this.styleTemplateRepository.findOne({
      where: { id },
    });

    if (!template) {
      throw new NotFoundException(`StyleTemplate with ID ${id} not found`);
    }

    return template;
  }

  async findOneForUser(
    userId: string,
    id: string,
    projectId?: string,
  ): Promise<StyleTemplate> {
    if (projectId) {
      await this.projectAccessPolicy.assertOwner(userId, projectId);
      const scopedTemplate = await this.styleTemplateRepository.findOne({
        where: { id, projectId },
      });
      if (!scopedTemplate) {
        throw new NotFoundException(`StyleTemplate with ID ${id} not found`);
      }
      return scopedTemplate;
    }

    const template = await this.styleTemplateRepository.findOne({
      where: { id },
      select: { id: true, projectId: true },
    });
    if (!template) {
      throw new NotFoundException(`StyleTemplate with ID ${id} not found`);
    }
    await this.projectAccessPolicy.assertOwner(userId, template.projectId);
    return this.styleTemplateRepository.findOneOrFail({
      where: { id: template.id, projectId: template.projectId },
    });
  }

  async update(
    id: string,
    dto: UpdateStyleTemplateDto,
  ): Promise<StyleTemplate> {
    const template = await this.findOne(id);

    const { panel_assignment, ...rest } = dto;

    Object.assign(template, rest);

    if (panel_assignment !== undefined) {
      if (!template.features) {
        throw new BadRequestException('请先完成体例分析');
      }
      template.features = {
        ...template.features,
        panel_assignment,
      };
    }

    template.updatedAt = new Date();

    return this.styleTemplateRepository.save(template);
  }

  async updateForUser(
    userId: string,
    projectId: string | undefined,
    id: string,
    dto: UpdateStyleTemplateDto,
  ): Promise<StyleTemplate> {
    const template = await this.findOneForUser(userId, id, projectId);
    const { panel_assignment, ...rest } = dto;
    const baseFeatures = dto.features ?? template.features;
    const features =
      panel_assignment === undefined
        ? baseFeatures
        : baseFeatures
          ? { ...baseFeatures, panel_assignment }
          : (() => {
              throw new BadRequestException('请先完成体例分析');
            })();

    await this.styleTemplateRepository.update(
      { id: template.id, projectId: template.projectId },
      { ...rest, features, updatedAt: new Date() },
    );
    return this.styleTemplateRepository.findOneOrFail({
      where: { id: template.id, projectId: template.projectId },
    });
  }

  async remove(id: string): Promise<void> {
    const template = await this.findOne(id);
    if (template.filePath) {
      assertStoragePathMayBeDeleted(template.filePath);
      try {
        await fs.unlink(template.filePath);
      } catch {
        // ignore
      }
    }
    await this.styleTemplateRepository.remove(template);
  }

  async removeForUser(
    userId: string,
    projectId: string | undefined,
    id: string,
  ): Promise<void> {
    const template = await this.findOneForUser(userId, id, projectId);
    if (template.filePath) {
      assertStoragePathMayBeDeleted(template.filePath);
      try {
        await fs.unlink(template.filePath);
      } catch {
        // ignore
      }
    }
    await this.styleTemplateRepository.delete({
      id: template.id,
      projectId: template.projectId,
    });
  }

  async createFromText(
    userId: string,
    projectId: string,
  ): Promise<StyleTemplate> {
    await this.projectAccessPolicy.assertOwner(userId, projectId);
    const oldTemplates = await this.styleTemplateRepository.find({
      where: { projectId },
    });

    for (const oldTemplate of oldTemplates) {
      if (oldTemplate.filePath) {
        assertStoragePathMayBeDeleted(oldTemplate.filePath);
        try {
          await fs.unlink(oldTemplate.filePath);
        } catch {
          // ignore
        }
      }
      await this.styleTemplateRepository.remove(oldTemplate);
    }

    const template = this.styleTemplateRepository.create({
      name: '粘贴体例',
      projectId,
      filePath: null,
      referenceFileIds: null,
      status: 'pending',
    });

    return this.styleTemplateRepository.save(template);
  }

  async updateAnalysisResult(
    id: string,
    features: StyleFeatures | null,
    status: 'completed' | 'failed',
    errorMessage?: string,
  ): Promise<void> {
    const template = await this.findOne(id);
    await this.styleTemplateRepository.update(
      { id, projectId: template.projectId },
      {
        features,
        status,
        errorMessage,
        updatedAt: new Date(),
      },
    );
  }
}
