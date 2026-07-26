import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StyleTemplate } from './entities/style-template.entity.js';
import { StyleTemplateController } from './style-template.controller.js';
import { StyleTemplateService } from './style-template.service.js';
import { StyleAnalyzer } from './analyzers/style-analyzer.js';
import { StyleTemplateTextCacheService } from './style-template-text-cache.service.js';
import { AgentModule } from '../agent/agent.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectModule } from '../project/project.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([StyleTemplate]),
    AgentModule,
    AuthModule,
    ProjectModule,
  ],
  controllers: [StyleTemplateController],
  providers: [
    StyleTemplateService,
    StyleAnalyzer,
    StyleTemplateTextCacheService,
  ],
  exports: [StyleTemplateService],
})
export class StyleTemplateModule {}
