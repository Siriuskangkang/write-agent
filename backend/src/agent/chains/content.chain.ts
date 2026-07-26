import { LLMStreamOptions } from '../../llm/llm.interface.js';
import { ModelGateway, ModelGatewayError } from '../../llm/model-gateway.js';
import { SYSTEM_PROMPT } from '../prompts/system.prompt.js';
import {
  buildContentPrompt,
  buildRewritePrompt,
  buildExpandPrompt,
  buildCompressPrompt,
} from '../prompts/content.prompt.js';

export interface ContentChainInput {
  projectName: string;
  style: string;
  chapterTitle: string;
  sectionTitle: string;
  outline: string;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
  wordCount: number;
  strictCitation: boolean;
  stylePrompt?: string;
}

export interface RewriteChainInput {
  originalContent: string;
  instruction: string;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
}

export interface ExpandChainInput {
  originalContent: string;
  targetWordCount: number;
  retrievedMaterials: string;
  assignedEvidenceIds?: string[];
}

export interface CompressChainInput {
  originalContent: string;
  targetWordCount: number;
  retrievedMaterials?: string;
  assignedEvidenceIds?: string[];
}

export async function* contentChain(
  modelGateway: ModelGateway,
  input: ContentChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildContentPrompt(input);

  yield* streamText(modelGateway, userPrompt, options);
}

export async function* rewriteChain(
  modelGateway: ModelGateway,
  input: RewriteChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildRewritePrompt(input);

  yield* streamText(modelGateway, userPrompt, options);
}

export async function* expandChain(
  modelGateway: ModelGateway,
  input: ExpandChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildExpandPrompt(input);

  yield* streamText(modelGateway, userPrompt, options);
}

export async function* compressChain(
  modelGateway: ModelGateway,
  input: CompressChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildCompressPrompt(input);

  yield* streamText(modelGateway, userPrompt, options);
}

async function* streamText(
  modelGateway: ModelGateway,
  userPrompt: string,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  for await (const event of modelGateway.stream({
    response_mode: 'text',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    ...(options?.timeout_ms ? { timeout_ms: options.timeout_ms } : {}),
  })) {
    if (event.type === 'text_delta') yield event.text;
    if (event.type === 'error') throw new ModelGatewayError(event.error);
  }
}
