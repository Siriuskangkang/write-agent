import { Module } from '@nestjs/common';
import { AgentService } from './agent.service.js';
import { LLMModule } from '../llm/llm.module.js';

@Module({
  imports: [LLMModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
