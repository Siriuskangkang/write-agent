import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity.js';
import { Message } from './entities/message.entity.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto.js';
import { ProjectService } from '../project/project.service.js';

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly projectService: ProjectService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    dto: CreateSessionDto,
  ): Promise<Session> {
    await this.projectService.findOne(userId, projectId);

    const session = this.sessionRepo.create({
      project_id: projectId,
      user_id: userId,
      title: dto.title ?? '新会话',
    });
    return this.sessionRepo.save(session);
  }

  async findAll(userId: string, projectId: string): Promise<Session[]> {
    await this.projectService.findOne(userId, projectId);

    return this.sessionRepo.find({
      where: { project_id: projectId, user_id: userId },
      order: { updated_at: 'DESC' },
    });
  }

  async findMessages(
    userId: string,
    projectId: string,
    sessionId: string,
    query: ListMessagesQueryDto,
  ) {
    await this.projectService.findOne(userId, projectId);

    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, project_id: projectId, user_id: userId },
    });
    if (!session) {
      throw new NotFoundException('会话不存在');
    }

    const { page = 1, page_size = 20 } = query;

    const [items, total] = await this.messageRepo.findAndCount({
      where: { session_id: sessionId },
      order: { created_at: 'ASC' },
      skip: (page - 1) * page_size,
      take: page_size,
    });

    return { items, total, page, page_size };
  }

  async createMessage(
    userId: string,
    projectId: string,
    sessionId: string,
    dto: CreateMessageDto,
  ): Promise<Message> {
    const session = await this.getOwnedSession(userId, projectId, sessionId);

    const message = this.messageRepo.create({
      session_id: session.id,
      role: dto.role,
      content: dto.content,
      message_type: dto.message_type,
      metadata: dto.metadata ?? {},
    });
    const saved = await this.messageRepo.save(message);

    await this.sessionRepo.update(session.id, { updated_at: new Date() });
    return saved;
  }

  async remove(
    userId: string,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.getOwnedSession(userId, projectId, sessionId);
    await this.sessionRepo.remove(session);
  }

  private async getOwnedSession(
    userId: string,
    projectId: string,
    sessionId: string,
  ): Promise<Session> {
    await this.projectService.findOne(userId, projectId);

    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, project_id: projectId, user_id: userId },
    });
    if (!session) {
      throw new NotFoundException('会话不存在');
    }
    return session;
  }
}
