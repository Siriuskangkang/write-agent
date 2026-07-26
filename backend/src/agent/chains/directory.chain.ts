import { LLMStreamOptions } from '../../llm/llm.interface.js';
import { ModelGateway, ModelGatewayError } from '../../llm/model-gateway.js';
import { SYSTEM_PROMPT } from '../prompts/system.prompt.js';
import { buildDirectoryPrompt } from '../prompts/directory.prompt.js';

export interface DirectoryChainInput {
  projectName: string;
  projectType: string | null;
  targetAudience: string | null;
  targetChapters: number;
  style: string;
  description: string | null;
  retrievedMaterials: string;
  stylePrompt: string;
}

export async function* directoryChain(
  modelGateway: ModelGateway,
  input: DirectoryChainInput,
  options?: LLMStreamOptions,
): AsyncGenerator<string> {
  const userPrompt = buildDirectoryPrompt(input);

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
