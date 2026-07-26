import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnvironment } from './config/environment.js';
import { WorkerFileModule } from './file/worker-file.module.js';
import { WorkerExportModule } from './export/worker-export.module.js';
import { WorkerWorkflowModule } from './workflow/worker-workflow.module.js';
import { WorkerRetrievalModule } from './retrieval/worker-retrieval.module.js';
import { StorageModule } from './storage/storage.module.js';
import { OperationsModule } from './operations/operations.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'mysql' as const,
        host: config.getOrThrow<string>('DATABASE_HOST'),
        port: config.getOrThrow<number>('DATABASE_PORT'),
        username: config.getOrThrow<string>('DATABASE_USER'),
        password: config.getOrThrow<string>('DATABASE_PASSWORD'),
        database: config.getOrThrow<string>('DATABASE_NAME'),
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
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          password: config.getOrThrow<string>('REDIS_PASSWORD'),
        },
      }),
    }),
    WorkerFileModule,
    WorkerExportModule,
    WorkerWorkflowModule,
    WorkerRetrievalModule,
    StorageModule,
    OperationsModule,
  ],
})
export class WorkerModule {}
