import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AgentService } from '../agent/agent.service.js';
import { ProjectService } from '../project/project.service.js';
import { StyleTemplateService } from '../style-template/style-template.service.js';
import { ContentSharedService } from './content-shared.service.js';
import { DirectoryVersion } from './entities/directory-version.entity.js';
import { OutlineVersion } from './entities/outline-version.entity.js';
import { GenerateOutlineDto } from './dto/generate-outline.dto.js';
import { SaveOutlineDto, OutlineContentDto } from './dto/save-outline.dto.js';
import type { ModelTraceMetadata } from '../llm/model-types.js';

interface DirectoryNode {
  node_id: string;
  parent_node_id?: string | null;
  order_index?: number;
  title: string;
  level_label?: string;
}

function isDirectoryNode(value: unknown): value is DirectoryNode {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.node_id === 'string' &&
    typeof node.title === 'string' &&
    (node.parent_node_id === undefined ||
      node.parent_node_id === null ||
      typeof node.parent_node_id === 'string') &&
    (node.order_index === undefined || typeof node.order_index === 'number') &&
    (node.level_label === undefined || typeof node.level_label === 'string')
  );
}

function getDirectoryNodes(value: unknown): DirectoryNode[] {
  return Array.isArray(value) ? value.filter(isDirectoryNode) : [];
}

@Injectable()
export class OutlineService {
  private readonly logger = new Logger(OutlineService.name);

  constructor(
    @InjectRepository(DirectoryVersion)
    private readonly directoryVersionRepo: Repository<DirectoryVersion>,
    @InjectRepository(OutlineVersion)
    private readonly outlineVersionRepo: Repository<OutlineVersion>,
    private readonly agentService: AgentService,
    private readonly projectService: ProjectService,
    private readonly styleTemplateService: StyleTemplateService,
    private readonly contentSharedService: ContentSharedService,
  ) {}

  private buildOutlineScope(
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string | null,
  ) {
    return {
      project_id: projectId,
      chapter_node_id: chapterNodeId,
      section_node_id: sectionNodeId ?? IsNull(),
    };
  }

  async *generateOutline(
    userId: string,
    projectId: string,
    dto: GenerateOutlineDto,
    signal?: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    const project = await this.projectService.findOne(userId, projectId);
    const template =
      await this.styleTemplateService.getProjectActiveTemplate(projectId);
    if (!template || !template.features) {
      throw new ConflictException('请先上传并分析体例文件');
    }

    const materials = await this.contentSharedService.retrieveMaterials(
      projectId,
      `${dto.chapter_title} ${dto.section_title ?? ''} ${dto.section_description ?? ''}`,
    );

    const currentDir = await this.directoryVersionRepo.findOne({
      where: { project_id: projectId, is_current: true },
    });
    let sectionList: string | undefined;
    if (currentDir && Array.isArray(currentDir.content)) {
      const children = getDirectoryNodes(currentDir.content)
        .filter((node) => node.parent_node_id === dto.chapter_node_id)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
      if (children.length > 0) {
        sectionList = children
          .map(
            (section, index) =>
              `  ${index + 1}. ${section.title}${section.level_label ? `（${section.level_label}）` : ''}`,
          )
          .join('\n');
      }
    }

    const stylePrompt = await this.contentSharedService.getStructureTreePrompt(
      projectId,
      'outline',
    );

    const context = {
      projectName: project.name,
      style: project.style,
      chapterTitle: dto.chapter_title,
      sectionTitle: dto.section_title ?? dto.chapter_title,
      sectionDescription: dto.section_description ?? '',
      retrievedMaterials: materials,
      sectionList,
      stylePrompt,
    };
    yield* signal || trace
      ? this.agentService.generateStream('outline', context, {
          ...(signal ? { signal } : {}),
          ...(trace ? { trace } : {}),
        })
      : this.agentService.generateStream('outline', context);
  }

  async getOutline(
    userId: string,
    projectId: string,
    outlineId: string,
  ): Promise<OutlineVersion> {
    await this.projectService.findOne(userId, projectId);
    const outline = await this.outlineVersionRepo.findOne({
      where: { id: outlineId, project_id: projectId },
    });
    if (!outline) throw new NotFoundException('大纲不存在');
    return outline;
  }

  async saveOutlineFromGeneration(
    userId: string,
    projectId: string,
    dto: GenerateOutlineDto,
    rawContent: string,
  ): Promise<OutlineVersion> {
    await this.projectService.findOne(userId, projectId);
    let parsedContent: Record<string, unknown>;
    try {
      const cleaned = rawContent
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
      const jsonStart = cleaned.indexOf('{');
      const jsonEnd = cleaned.lastIndexOf('}');
      const jsonStr =
        jsonStart >= 0 && jsonEnd > jsonStart
          ? cleaned.slice(jsonStart, jsonEnd + 1)
          : cleaned;
      const parsed: unknown = JSON.parse(jsonStr);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new BadRequestException('大纲内容必须是 JSON 对象');
      }
      parsedContent = parsed as Record<string, unknown>;
    } catch {
      this.logger.error(
        `大纲内容解析失败，原始内容前500字: ${rawContent.slice(0, 500)}`,
      );
      throw new BadRequestException('大纲内容解析失败');
    }

    const currentDir = await this.directoryVersionRepo.findOne({
      where: { project_id: projectId, is_current: true },
    });
    let chapterIndex = 0;
    if (currentDir && Array.isArray(currentDir.content)) {
      const chapters = getDirectoryNodes(currentDir.content)
        .filter((node) => !node.parent_node_id)
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
      chapterIndex = Math.max(
        0,
        chapters.findIndex((node) => node.node_id === dto.chapter_node_id),
      );
    }

    return this.outlineVersionRepo.manager.transaction(async (manager) => {
      const lockedProjects: unknown = await manager.query(
        `SELECT id FROM projects WHERE id = ? FOR UPDATE`,
        [projectId],
      );
      if (!Array.isArray(lockedProjects) || lockedProjects.length === 0) {
        throw new NotFoundException('项目不存在');
      }
      const versionRepo = manager.getRepository(OutlineVersion);
      const outlineScope = this.buildOutlineScope(
        projectId,
        dto.chapter_node_id,
        dto.section_node_id,
      );
      await versionRepo.update(
        { ...outlineScope, is_current: true },
        { is_current: false },
      );
      const versionNumber = await this.getNextVersion(
        manager,
        projectId,
        dto.chapter_node_id,
        dto.section_node_id,
      );
      return versionRepo.save(
        versionRepo.create({
          project_id: projectId,
          chapter_node_id: dto.chapter_node_id,
          section_node_id: dto.section_node_id ?? null,
          chapter_index: chapterIndex,
          chapter_title: dto.chapter_title,
          version_number: versionNumber,
          content: parsedContent,
          is_current: true,
        }),
      );
    });
  }

  async saveOutline(
    userId: string,
    projectId: string,
    dto: SaveOutlineDto,
  ): Promise<OutlineVersion> {
    await this.projectService.findOne(userId, projectId);

    return this.outlineVersionRepo.manager.transaction(async (manager) => {
      const lockedProjects: unknown = await manager.query(
        `SELECT id FROM projects WHERE id = ? FOR UPDATE`,
        [projectId],
      );
      if (!Array.isArray(lockedProjects) || lockedProjects.length === 0) {
        throw new NotFoundException('项目不存在');
      }
      const versionRepo = manager.getRepository(OutlineVersion);
      const outlineScope = this.buildOutlineScope(
        projectId,
        dto.chapter_node_id,
        dto.section_node_id,
      );
      const current = await versionRepo.findOne({
        where: { ...outlineScope, is_current: true },
      });
      if (current && current.version_number !== dto.base_version_number) {
        throw new ConflictException('大纲已被修改，请刷新后重试');
      }

      await versionRepo.update(
        { ...outlineScope, is_current: true },
        { is_current: false },
      );
      const versionNumber = await this.getNextVersion(
        manager,
        projectId,
        dto.chapter_node_id,
        dto.section_node_id,
      );
      return versionRepo.save(
        versionRepo.create({
          project_id: projectId,
          chapter_node_id: dto.chapter_node_id,
          section_node_id: dto.section_node_id ?? null,
          chapter_index: dto.chapter_index,
          chapter_title: dto.chapter_title,
          version_number: versionNumber,
          content: dto.content,
          is_current: true,
        }),
      );
    });
  }

  async getLatestOutlineByChapter(
    userId: string,
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string,
  ): Promise<OutlineVersion | null> {
    await this.projectService.findOne(userId, projectId);
    return this.outlineVersionRepo.findOne({
      where: {
        ...this.buildOutlineScope(projectId, chapterNodeId, sectionNodeId),
        is_current: true,
      },
    });
  }

  async updateOutline(
    userId: string,
    projectId: string,
    id: string,
    content: OutlineContentDto,
  ): Promise<OutlineVersion> {
    await this.projectService.findOne(userId, projectId);
    const outline = await this.outlineVersionRepo.findOne({
      where: { id, project_id: projectId },
    });
    if (!outline) throw new NotFoundException('大纲不存在');
    const update: Pick<OutlineVersion, 'content'> = { content };
    await this.outlineVersionRepo.update({ id, project_id: projectId }, update);
    return this.outlineVersionRepo.findOneOrFail({
      where: { id, project_id: projectId },
    });
  }

  private async getNextVersion(
    manager: Repository<OutlineVersion>['manager'],
    projectId: string,
    chapterNodeId: string,
    sectionNodeId?: string | null,
  ): Promise<number> {
    const rows: unknown = await manager.query(
      `SELECT COALESCE(MAX(version_number), 0) AS maxVersion
         FROM outline_versions
        WHERE project_id = ?
          AND chapter_node_id = ?
          AND section_node_id <=> ?`,
      [projectId, chapterNodeId, sectionNodeId ?? null],
    );
    if (!Array.isArray(rows) || rows.length === 0) return 1;
    return Number((rows[0] as { maxVersion?: unknown }).maxVersion ?? 0) + 1;
  }
}
