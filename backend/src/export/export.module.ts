import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { ExportJob } from './entities/export-job.entity.js';
import { ExportService } from './export.service.js';
import { ExportController } from './export.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExportJob]),
    BullModule.registerQueue({ name: 'export' }),
    AuthModule,
    ProjectModule,
  ],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
