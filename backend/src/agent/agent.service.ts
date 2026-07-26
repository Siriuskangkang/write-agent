import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMStreamEvent, LLMStreamOptions } from '../llm/llm.interface';
import { ModelGateway, ModelGatewayError } from '../llm/model-gateway.js';
import {
  directoryChain,
  DirectoryChainInput,
} from './chains/directory.chain.js';
import { outlineChain, OutlineChainInput } from './chains/outline.chain.js';
import {
  contentChain,
  ContentChainInput,
  rewriteChain,
  RewriteChainInput,
  expandChain,
  ExpandChainInput,
  compressChain,
  CompressChainInput,
} from './chains/content.chain.js';
import {
  groundedDraftChain,
  completePreparedGroundedDraftChain,
  prepareGroundedDraftChain,
  type GroundedDraftGenerationResult,
  type GroundedDraftModelInput,
  type PreparedGroundedDraft,
} from './chains/grounded-draft.chain.js';
import type { ModelOperationIdentity } from '../llm/model-types.js';

export type ChainType =
  | 'directory'
  | 'outline'
  | 'content'
  | 'rewrite'
  | 'expand'
  | 'compress';

export type ChainInput =
  | DirectoryChainInput
  | OutlineChainInput
  | ContentChainInput
  | RewriteChainInput
  | ExpandChainInput
  | CompressChainInput;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  constructor(
    private readonly configService: ConfigService,
    private readonly modelGateway: ModelGateway,
  ) {
    const provider = this.configService.get<string>(
      'LLM_PROVIDER',
      'anthropic',
    );
    this.logger.log(`LLM provider initialized: ${provider}`);
  }

  async *generateStream(
    type: ChainType,
    context: ChainInput,
    options?: LLMStreamOptions,
  ): AsyncGenerator<string> {
    switch (type) {
      case 'directory':
        yield* options
          ? directoryChain(
              this.modelGateway,
              context as DirectoryChainInput,
              options,
            )
          : directoryChain(this.modelGateway, context as DirectoryChainInput);
        break;
      case 'outline':
        yield* options
          ? outlineChain(
              this.modelGateway,
              context as OutlineChainInput,
              options,
            )
          : outlineChain(this.modelGateway, context as OutlineChainInput);
        break;
      case 'content':
        yield* options
          ? contentChain(
              this.modelGateway,
              context as ContentChainInput,
              options,
            )
          : contentChain(this.modelGateway, context as ContentChainInput);
        break;
      case 'rewrite':
        yield* options
          ? rewriteChain(
              this.modelGateway,
              context as RewriteChainInput,
              options,
            )
          : rewriteChain(this.modelGateway, context as RewriteChainInput);
        break;
      case 'expand':
        yield* options
          ? expandChain(this.modelGateway, context as ExpandChainInput, options)
          : expandChain(this.modelGateway, context as ExpandChainInput);
        break;
      case 'compress':
        yield* options
          ? compressChain(
              this.modelGateway,
              context as CompressChainInput,
              options,
            )
          : compressChain(this.modelGateway, context as CompressChainInput);
        break;
    }
  }

  async generateGroundedDraft(
    input: GroundedDraftModelInput,
    options: LLMStreamOptions,
  ): Promise<GroundedDraftGenerationResult> {
    return groundedDraftChain(this.modelGateway, input, options);
  }

  prepareGroundedDraft(
    input: GroundedDraftModelInput,
    options: LLMStreamOptions,
  ): PreparedGroundedDraft {
    return prepareGroundedDraftChain(this.modelGateway, input, options);
  }

  async completePreparedGroundedDraft(
    prepared: PreparedGroundedDraft,
  ): Promise<GroundedDraftGenerationResult> {
    return completePreparedGroundedDraftChain(this.modelGateway, prepared);
  }

  async inspectGroundedDraftOperation(
    workflowJobId: string,
    operation: string | ModelOperationIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch' | 'unknown'> {
    return this.modelGateway.inspectOperation(workflowJobId, operation);
  }

  async *streamCompletion(
    prompt: string,
    systemPrompt?: string,
    temperature?: number,
    options?: LLMStreamOptions,
  ): AsyncGenerator<LLMStreamEvent> {
    for await (const event of this.modelGateway.stream({
      response_mode: 'text',
      messages: [
        ...(systemPrompt
          ? [{ role: 'system' as const, content: systemPrompt }]
          : []),
        { role: 'user', content: prompt },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.trace ? { trace: options.trace } : {}),
      ...(options?.timeout_ms ? { timeout_ms: options.timeout_ms } : {}),
    })) {
      if (event.type === 'text_delta') {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: event.text },
        };
      } else if (event.type === 'error') {
        throw new ModelGatewayError(event.error);
      } else {
        yield { type: event.type };
      }
    }
  }
}
