import { Module } from '@nestjs/common';
import { EmbeddingService } from './embedding.service.js';

@Module({
  providers: [EmbeddingService],
  exports: [EmbeddingService],
})
export class EmbeddingModule {}
