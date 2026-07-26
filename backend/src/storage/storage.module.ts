import { Module } from '@nestjs/common';
import { StorageReadinessService } from './storage-readiness.service.js';
import { StorageRequestService } from './storage-request.service.js';

@Module({
  providers: [StorageReadinessService, StorageRequestService],
  exports: [StorageReadinessService, StorageRequestService],
})
export class StorageModule {}
