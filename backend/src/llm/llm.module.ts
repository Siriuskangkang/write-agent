import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LLMFactory } from './llm.factory';
import { ModelGateway } from './model-gateway.js';
import { ModelPricingCatalog } from './model-pricing.js';
import { ModelRun } from '../workflow/entities/model-run.entity.js';
import { ModelRunService } from '../workflow/model-run.service.js';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([ModelRun])],
  providers: [LLMFactory, ModelRunService, ModelPricingCatalog, ModelGateway],
  exports: [LLMFactory, ModelRunService, ModelPricingCatalog, ModelGateway],
})
export class LLMModule {}
