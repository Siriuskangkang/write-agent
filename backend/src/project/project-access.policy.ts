import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from './entities/project.entity.js';

@Injectable()
export class ProjectAccessPolicy {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
  ) {}

  async assertOwner(userId: string, projectId: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
      relations: ['state'],
    });
    if (!project) {
      throw new NotFoundException('项目不存在');
    }
    if (project.user_id !== userId) {
      throw new ForbiddenException('无权访问该项目');
    }
    return project;
  }
}
