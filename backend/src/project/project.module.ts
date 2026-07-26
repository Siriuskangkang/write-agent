import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectState } from './entities/project-state.entity.js';
import { ProjectService } from './project.service.js';
import { ProjectController } from './project.controller.js';
import { ProjectAccessPolicy } from './project-access.policy.js';
import { AuthModule } from '../auth/auth.module.js';
import { SourceFile } from '../file/entities/source-file.entity.js';
import { Document } from '../file/entities/document.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { StyleTemplate } from '../style-template/entities/style-template.entity.js';
import { CitationMap } from '../citation/entities/citation-map.entity.js';
import { DirectoryVersion } from '../content/entities/directory-version.entity.js';
import { OutlineVersion } from '../content/entities/outline-version.entity.js';
import { ContentVersion } from '../content/entities/content-version.entity.js';
import { WritingResult } from '../content/entities/writing-result.entity.js';
import { Session } from '../session/entities/session.entity.js';
import { Message } from '../session/entities/message.entity.js';
import { ExportJob } from '../export/entities/export-job.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectState,
      SourceFile,
      Document,
      Chunk,
      StyleTemplate,
      CitationMap,
      DirectoryVersion,
      OutlineVersion,
      ContentVersion,
      WritingResult,
      Session,
      Message,
      ExportJob,
    ]),
    AuthModule,
  ],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectAccessPolicy],
  exports: [ProjectService, ProjectAccessPolicy],
})
export class ProjectModule {}
