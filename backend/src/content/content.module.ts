import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { AgentModule } from '../agent/agent.module.js';
import { ProjectModule } from '../project/project.module.js';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CitationModule } from '../citation/citation.module.js';
import { StyleTemplateModule } from '../style-template/style-template.module.js';
import { SSE_REDIS_CLIENT } from './content.constants.js';
import { ContentService } from './content.service.js';
import { ContentSharedService } from './content-shared.service.js';
import { DirectoryService } from './directory.service.js';
import { OutlineService } from './outline.service.js';
import { ContentGenerationService } from './content-generation.service.js';
import { DirectoryController } from './directory.controller.js';
import { OutlineController } from './outline.controller.js';
import { ContentController } from './content.controller.js';
import { WritingResult } from './entities/writing-result.entity.js';
import { ContentVersion } from './entities/content-version.entity.js';
import { DirectoryVersion } from './entities/directory-version.entity.js';
import { OutlineVersion } from './entities/outline-version.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { WorkflowModule } from '../workflow/workflow.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WritingResult,
      ContentVersion,
      DirectoryVersion,
      OutlineVersion,
      Chunk,
    ]),
    AgentModule,
    ProjectModule,
    RetrievalModule,
    AuthModule,
    CitationModule,
    StyleTemplateModule,
    WorkflowModule,
  ],
  controllers: [DirectoryController, OutlineController, ContentController],
  providers: [
    ContentSharedService,
    DirectoryService,
    OutlineService,
    ContentGenerationService,
    ContentService,
    {
      provide: SSE_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD', '') || undefined,
          lazyConnect: true,
        }),
    },
  ],
  exports: [ContentService],
})
export class ContentModule {}
