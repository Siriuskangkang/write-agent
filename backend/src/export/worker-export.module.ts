import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExportJob } from './entities/export-job.entity.js';
import { ExportService } from './export.service.js';
import { ExportWorker } from './export.worker.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExportJob]),
    BullModule.registerQueue({ name: 'export' }),
  ],
  providers: [ExportService, ExportWorker],
})
export class WorkerExportModule {}
