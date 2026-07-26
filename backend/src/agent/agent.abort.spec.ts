/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service.js';
import type { ModelGateway } from '../llm/model-gateway.js';

describe('AgentService cancellation propagation', () => {
  it('passes the workflow AbortSignal through the chain to the provider', async () => {
    const gateway = {
      stream: jest.fn(async function* () {
        await Promise.resolve();
        yield {
          type: 'text_delta',
          text: 'ok',
          attempt: 1,
        } as const;
      }),
    };
    const config = { get: () => 'deepseek' };
    const service = new AgentService(
      config as unknown as ConfigService,
      gateway as unknown as ModelGateway,
    );
    const controller = new AbortController();

    const output: string[] = [];
    for await (const token of service.generateStream(
      'directory',
      {
        projectName: '教材',
        projectType: null,
        targetAudience: null,
        targetChapters: 1,
        style: '教材',
        description: null,
        retrievedMaterials: '',
        stylePrompt: '',
      },
      { signal: controller.signal },
    )) {
      output.push(token);
    }

    expect(output).toEqual(['ok']);
    expect(gateway.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        response_mode: 'text',
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user' }),
        ]),
        signal: controller.signal,
      }),
    );
  });
});
