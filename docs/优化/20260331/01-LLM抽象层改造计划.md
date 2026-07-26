# LLM 抽象层改造计划

## 模块：backend/src/llm

### 目标
将当前硬编码的 Anthropic 客户端改造为可切换的 LLM 抽象层，支持 Anthropic 和 DeepSeek。

---

## 一、新增文件

### 1.1 接口定义
**文件：`backend/src/llm/llm.interface.ts`**

```typescript
export interface LLMProvider {
  streamCompletion(prompt: string, systemPrompt?: string): AsyncIterable<any>;
}

export interface LLMConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}
```

### 1.2 Anthropic Provider
**文件：`backend/src/llm/providers/anthropic.provider.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, LLMConfig } from '../llm.interface';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  async *streamCompletion(prompt: string, systemPrompt?: string) {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt || '',
      messages: [{ role: 'user', content: prompt }],
    });

    for await (const event of stream) {
      yield event;
    }
  }
}
```

### 1.3 DeepSeek Provider
**文件：`backend/src/llm/providers/deepseek.provider.ts`**

```typescript
import OpenAI from 'openai';
import { LLMProvider, LLMConfig } from '../llm.interface';

export class DeepSeekProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.model = config.model;
  }

  async *streamCompletion(prompt: string, systemPrompt?: string) {
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.content) {
        // 转换为 Anthropic 格式
        yield {
          type: 'content_block_delta',
          delta: {
            type: 'text_delta',
            text: chunk.choices[0].delta.content,
          },
        };
      }
    }
  }
}
```

### 1.4 LLM 工厂
**文件：`backend/src/llm/llm.factory.ts`**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider } from './llm.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { DeepSeekProvider } from './providers/deepseek.provider';

@Injectable()
export class LLMFactory {
  private readonly logger = new Logger(LLMFactory.name);

  constructor(private configService: ConfigService) {}

  createProvider(): LLMProvider {
    const provider = this.configService.get('LLM_PROVIDER', 'anthropic');
    this.logger.log(`Creating LLM provider: ${provider}`);

    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: this.configService.get('ANTHROPIC_API_KEY'),
          baseURL: this.configService.get('ANTHROPIC_BASE_URL'),
          model: this.configService.get('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
        });

      case 'deepseek':
        return new DeepSeekProvider({
          apiKey: this.configService.get('DEEPSEEK_API_KEY'),
          baseURL: this.configService.get('DEEPSEEK_BASE_URL'),
          model: this.configService.get('DEEPSEEK_MODEL', 'deepseek-chat'),
        });

      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}
```

---

## 二、修改现有文件

### 2.1 修改 AgentService
**文件：`backend/src/agent/agent.service.ts`**

**删除：**
```typescript
import Anthropic from '@anthropic-ai/sdk';
private readonly client: Anthropic;
private readonly model: string;
```

**新增：**
```typescript
import { LLMFactory } from '../llm/llm.factory';
import { LLMProvider } from '../llm/llm.interface';

private llmProvider: LLMProvider;

constructor(
  private readonly configService: ConfigService,
  private readonly llmFactory: LLMFactory,
) {
  this.llmProvider = this.llmFactory.createProvider();
}
```

### 2.2 修改 AgentModule
**文件：`backend/src/agent/agent.module.ts`**

```typescript
import { LLMModule } from '../llm/llm.module';

@Module({
  imports: [LLMModule],
  providers: [AgentService],
  exports: [AgentService],
})
```

---

## 三、环境变量

**文件：`backend/.env`**

```env
LLM_PROVIDER=anthropic

ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-6

DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

---

## 四、依赖安装

```bash
cd backend && npm install openai
```
