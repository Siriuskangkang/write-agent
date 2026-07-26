import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Chunk } from './entities/chunk.entity.js';
import { ChunkService } from './chunk.service.js';
import { ChunkController } from './chunk.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Chunk]),
    AuthModule,
    ProjectModule,
    EmbeddingModule,
  ],
  controllers: [ChunkController],
  providers: [ChunkService],
  exports: [ChunkService],
})
export class ChunkModule {}
