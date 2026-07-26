import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider } from './llm.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { DeepSeekProvider } from './providers/deepseek.provider';
import type { ModelAdapter } from './model-types.js';

export type ModelProvider = LLMProvider & ModelAdapter;

@Injectable()
export class LLMFactory {
  constructor(private configService: ConfigService) {}

  createProvider(): ModelProvider {
    const provider = this.configService.get<string>(
      'LLM_PROVIDER',
      'anthropic',
    );

    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: this.configService.get('ANTHROPIC_API_KEY') || '',
          baseURL: this.configService.get('ANTHROPIC_BASE_URL'),
          model: this.configService.get('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
        });
      case 'deepseek':
        return new DeepSeekProvider({
          apiKey: this.configService.get('DEEPSEEK_API_KEY') || '',
          baseURL: this.configService.get(
            'DEEPSEEK_BASE_URL',
            'https://api.deepseek.com',
          ),
          model: this.configService.get('DEEPSEEK_MODEL', 'deepseek-chat'),
        });
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}
