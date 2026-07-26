import { LLMStreamOptions } from '../../llm/llm.interface.js';
import { ModelGateway, ModelGatewayError } from '../../llm/model-gateway.js';
import { SYSTEM_PROMPT } from '../prompts/system.prompt.js';
import { buildOutlinePrompt } from '../prompts/outline.prompt.js';

export interface OutlineChainInput {
  projectName: string;
  style: string;
  chapterTitle: string;
  sectionTitle: string;
  sectionDescription: string;
  retrievedMaterials: string;
  sectionList?: string;
  stylePrompt?: string;
}

export async function* outlineChain(
  modelGateway: ModelGateway,
  input: OutlineChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildOutlinePrompt(input);

  const stream = modelGateway.stream({
    response_mode: 'text',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    ...(options?.timeout_ms ? { timeout_ms: options.timeout_ms } : {}),
  });

  for await (const event of stream) {
    if (event.type === 'text_delta') yield event.text;
    if (event.type === 'error') throw new ModelGatewayError(event.error);
  }
}
