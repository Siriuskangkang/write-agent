import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isDeepStrictEqual } from 'node:util';
import { Repository } from 'typeorm';
import { AgentService } from '../agent/agent.service.js';
import { ProjectService } from '../project/project.service.js';
import { StyleTemplateService } from '../style-template/style-template.service.js';
import { ContentSharedService } from './content-shared.service.js';
import { DirectoryVersion } from './entities/directory-version.entity.js';
import { ProjectState } from '../project/entities/project-state.entity.js';
import { GenerateDirectoryDto } from './dto/generate-directory.dto.js';
import { SaveDirectoryDto } from './dto/save-directory.dto.js';
import type { ModelTraceMetadata } from '../llm/model-types.js';

interface DirectoryNode {
  node_id: string;
  parent_node_id?: string | null;
  title: string;
}

function isDirectoryNode(value: unknown): value is DirectoryNode {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.node_id === 'string' &&
    typeof node.title === 'string' &&
    (node.parent_node_id === undefined ||
      node.parent_node_id === null ||
      typeof node.parent_node_id === 'string')
  );
}

function getDirectoryNodes(value: unknown): DirectoryNode[] {
  return Array.isArray(value) ? value.filter(isDirectoryNode) : [];
}

@Injectable()
export class DirectoryService {
  private readonly logger = new Logger(DirectoryService.name);

  constructor(
    @InjectRepository(DirectoryVersion)
    private readonly directoryVersionRepo: Repository<DirectoryVersion>,
    private readonly agentService: AgentService,
    private readonly projectService: ProjectService,
    private readonly styleTemplateService: StyleTemplateService,
    private readonly contentSharedService: ContentSharedService,
  ) {}

  async *generateDirectory(
    userId: string,
    projectId: string,
    dto: GenerateDirectoryDto,
    signal?: AbortSignal,
    trace?: ModelTraceMetadata,
  ): AsyncGenerator<string> {
    void dto;
    const project = await this.projectService.findOne(userId, projectId);
    const template =
      await this.styleTemplateService.getProjectActiveTemplate(projectId);
    if (!template || !template.features) {
      throw new ConflictException('请先上传并分析体例文件');
    }

    const materials = await this.contentSharedService.retrieveMaterials(
      projectId,
      project.name + ' ' + (project.description ?? ''),
    );
    const stylePrompt = await this.contentSharedService.getStructureTreePrompt(
      projectId,
      'directory',
    );

    const context = {
      projectName: project.name,
      projectType: project.type,
      targetAudience: project.target_audience,
      targetChapters: project.target_chapters,
      style: project.style,
      description: project.description,
      retrievedMaterials: materials,
      stylePrompt,
    };
    yield* signal || trace
      ? this.agentService.generateStream('directory', context, {
          ...(signal ? { signal } : {}),
          ...(trace ? { trace } : {}),
        })
      : this.agentService.generateStream('directory', context);
  }

  async getDirectoryVersions(
    userId: string,
    projectId: string,
  ): Promise<DirectoryVersion[]> {
    await this.projectService.findOne(userId, projectId);
    return this.directoryVersionRepo.find({
      where: { project_id: projectId },
      order: { version_number: 'DESC' },
    });
  }

  async getCurrentDirectory(
    userId: string,
    projectId: string,
  ): Promise<DirectoryVersion | null> {
    await this.projectService.findOne(userId, projectId);
    return this.directoryVersionRepo.findOne({
      where: { project_id: projectId, is_current: true },
    });
  }

  async getDirectoryVersion(
    userId: string,
    projectId: string,
    versionId: string,
  ): Promise<DirectoryVersion> {
    await this.projectService.findOne(userId, projectId);
    const version = await this.directoryVersionRepo.findOne({
      where: { id: versionId, project_id: projectId },
    });
    if (!version) throw new NotFoundException('目录版本不存在');
    return version;
  }

  async saveDirectory(
    userId: string,
    projectId: string,
    dto: SaveDirectoryDto,
  ): Promise<DirectoryVersion> {
    await this.projectService.findOne(userId, projectId);

    return this.directoryVersionRepo.manager.transaction(async (manager) => {
      const lockedProjects: unknown = await manager.query(
        `SELECT id FROM projects WHERE id = ? FOR UPDATE`,
        [projectId],
      );
      if (!Array.isArray(lockedProjects) || lockedProjects.length === 0) {
        throw new NotFoundException('项目不存在');
      }
      const versionRepo = manager.getRepository(DirectoryVersion);
      const current = await versionRepo.findOne({
        where: { project_id: projectId, is_current: true },
      });
      if (current && isDeepStrictEqual(current.content, dto.nodes)) {
        return current;
      }
      if (current && current.version_number !== dto.base_version_number) {
        throw new ConflictException('目录已被修改，请刷新后重试');
      }

      await versionRepo.update(
        { project_id: projectId, is_current: true },
        { is_current: false },
      );
      const rows: unknown = await manager.query(
        `SELECT COALESCE(MAX(version_number), 0) AS maxVersion
           FROM directory_versions
          WHERE project_id = ?`,
        [projectId],
      );
      const versionNumber = this.readNextVersion(rows);
      const saved = await versionRepo.save(
        versionRepo.create({
          project_id: projectId,
          version_number: versionNumber,
          content: dto.nodes,
          is_current: true,
        }),
      );

      const stateUpdate = await manager.update(
        ProjectState,
        { project_id: projectId },
        { current_directory_version_id: saved.id },
      );
      if (stateUpdate.affected !== 1) {
        throw new NotFoundException('项目状态不存在');
      }
      return saved;
    });
  }

  async updateDirectoryNode(
    userId: string,
    projectId: string,
    nodeId: string,
    title: string,
  ): Promise<DirectoryVersion> {
    await this.projectService.findOne(userId, projectId);
    const current = await this.directoryVersionRepo.findOne({
      where: { project_id: projectId, is_current: true },
    });
    if (!current) throw new NotFoundException('当前目录版本不存在');
    const nodes = getDirectoryNodes(current.content);
    const node = nodes.find((node) => node.node_id === nodeId);
    if (!node) throw new NotFoundException('目录节点不存在');
    node.title = title;
    await this.directoryVersionRepo.update(
      { id: current.id, project_id: projectId },
      { content: nodes },
    );
    return this.directoryVersionRepo.findOneOrFail({
      where: { id: current.id, project_id: projectId },
    });
  }

  async deleteDirectoryNode(
    userId: string,
    projectId: string,
    nodeId: string,
  ): Promise<void> {
    await this.projectService.findOne(userId, projectId);
    const current = await this.directoryVersionRepo.findOne({
      where: { project_id: projectId, is_current: true },
    });
    if (!current) throw new NotFoundException('当前目录版本不存在');
    const nodes = getDirectoryNodes(current.content);
    const filtered = nodes.filter(
      (node) => node.node_id !== nodeId && node.parent_node_id !== nodeId,
    );
    await this.directoryVersionRepo.update(
      { id: current.id, project_id: projectId },
      { content: filtered },
    );
  }

  private readNextVersion(rows: unknown): number {
    if (!Array.isArray(rows) || rows.length === 0) return 1;
    const maxVersion = Number(
      (rows[0] as { maxVersion?: unknown }).maxVersion ?? 0,
    );
    return maxVersion + 1;
  }
}
