import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { AuthModule } from './auth/auth.module.js';
import { ProjectModule } from './project/project.module.js';
import { SessionModule } from './session/session.module.js';
import { FileModule } from './file/file.module.js';
import { ChunkModule } from './chunk/chunk.module.js';
import { RetrievalModule } from './retrieval/retrieval.module.js';
import { CitationModule } from './citation/citation.module.js';
import { ExportModule } from './export/export.module.js';
import { AgentModule } from './agent/agent.module.js';
import { ContentModule } from './content/content.module.js';
import { StyleTemplateModule } from './style-template/style-template.module.js';
import { LLMModule } from './llm/llm.module.js';
import { validateEnvironment } from './config/environment.js';
import { WorkflowModule } from './workflow/workflow.module.js';
import { StorageModule } from './storage/storage.module.js';
import { OperationsModule } from './operations/operations.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql' as const,
        host: config.get<string>('DATABASE_HOST', 'localhost'),
        port: config.get<number>('DATABASE_PORT', 3306),
        username: config.get<string>('DATABASE_USER', 'root'),
        password: config.get<string>('DATABASE_PASSWORD', ''),
        database: config.get<string>('DATABASE_NAME', 'textweaver'),
        charset: 'utf8mb4',
        timezone: '+08:00',
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        redis: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD', '') || undefined,
        },
      }),
    }),
    AuthModule,
    ProjectModule,
    SessionModule,
    FileModule,
    ChunkModule,
    RetrievalModule,
    CitationModule,
    ExportModule,
    LLMModule,
    AgentModule,
    ContentModule,
    StyleTemplateModule,
    WorkflowModule,
    StorageModule,
    OperationsModule,
  ],
})
export class AppModule {}
