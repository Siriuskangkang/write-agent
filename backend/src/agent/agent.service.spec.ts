import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service.js';
import { ModelGateway } from '../llm/model-gateway.js';

// Mock all chain functions
jest.mock('./chains/directory.chain.js', () => ({
  directoryChain: jest.fn(),
}));
jest.mock('./chains/outline.chain.js', () => ({
  outlineChain: jest.fn(),
}));
jest.mock('./chains/content.chain.js', () => ({
  contentChain: jest.fn(),
  rewriteChain: jest.fn(),
  expandChain: jest.fn(),
  compressChain: jest.fn(),
}));
jest.mock('./chains/grounded-draft.chain.js', () => ({
  groundedDraftChain: jest.fn(),
}));

import { directoryChain } from './chains/directory.chain.js';
import { outlineChain } from './chains/outline.chain.js';
import {
  contentChain,
  rewriteChain,
  expandChain,
  compressChain,
} from './chains/content.chain.js';
import { groundedDraftChain } from './chains/grounded-draft.chain.js';

async function* makeTokenGenerator(tokens: string[]): AsyncGenerator<string> {
  await Promise.resolve();
  for (const token of tokens) {
    yield token;
  }
}

const mockModelGateway = {
  stream: jest.fn(),
  complete: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: string) => {
    if (key === 'LLM_PROVIDER') return 'anthropic';
    return defaultValue;
  }),
};

describe('AgentService', () => {
  let service: AgentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    (directoryChain as jest.Mock).mockImplementation(() =>
      makeTokenGenerator([]),
    );
    (outlineChain as jest.Mock).mockImplementation(() =>
      makeTokenGenerator([]),
    );
    (contentChain as jest.Mock).mockImplementation(() =>
      makeTokenGenerator([]),
    );
    (rewriteChain as jest.Mock).mockImplementation(() =>
      makeTokenGenerator([]),
    );
    (expandChain as jest.Mock).mockImplementation(() => makeTokenGenerator([]));
    (compressChain as jest.Mock).mockImplementation(() =>
      makeTokenGenerator([]),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ModelGateway, useValue: mockModelGateway },
      ],
    }).compile();

    service = module.get<AgentService>(AgentService);
  });

  describe('generateStream', () => {
    it('routes "directory" type to directoryChain', async () => {
      (directoryChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['token1', 'token2']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('directory', {
        projectName: '测试项目',
      } as any)) {
        tokens.push(token);
      }

      expect(directoryChain).toHaveBeenCalledWith(
        mockModelGateway,
        expect.objectContaining({ projectName: '测试项目' }),
      );
      expect(tokens).toEqual(['token1', 'token2']);
    });

    it('routes "outline" type to outlineChain', async () => {
      (outlineChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['outline-token']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('outline', {
        chapterTitle: '第一章',
      } as any)) {
        tokens.push(token);
      }

      expect(outlineChain).toHaveBeenCalledWith(
        mockModelGateway,
        expect.objectContaining({ chapterTitle: '第一章' }),
      );
      expect(tokens).toEqual(['outline-token']);
    });

    it('routes "content" type to contentChain', async () => {
      (contentChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['content-token']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('content', {
        outline: '{}',
      } as any)) {
        tokens.push(token);
      }

      expect(contentChain).toHaveBeenCalled();
      expect(tokens).toEqual(['content-token']);
    });

    it('routes "rewrite" type to rewriteChain', async () => {
      (rewriteChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['rewrite-token']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('rewrite', {
        originalContent: '原始内容',
        instruction: '改写指令',
      } as any)) {
        tokens.push(token);
      }

      expect(rewriteChain).toHaveBeenCalled();
      expect(tokens).toEqual(['rewrite-token']);
    });

    it('routes "expand" type to expandChain', async () => {
      (expandChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['expand-token']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('expand', {
        originalContent: '原始内容',
        targetWordCount: 3000,
      } as any)) {
        tokens.push(token);
      }

      expect(expandChain).toHaveBeenCalled();
      expect(tokens).toEqual(['expand-token']);
    });

    it('routes "compress" type to compressChain', async () => {
      (compressChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(['compress-token']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream('compress', {
        originalContent: '原始内容',
        targetWordCount: 500,
      } as any)) {
        tokens.push(token);
      }

      expect(compressChain).toHaveBeenCalled();
      expect(tokens).toEqual(['compress-token']);
    });

    it('yields multiple tokens in order', async () => {
      const expectedTokens = ['第', '一', '章', '内', '容'];
      (directoryChain as jest.Mock).mockImplementation(() =>
        makeTokenGenerator(expectedTokens),
      );

      const tokens: string[] = [];
      for await (const token of service.generateStream(
        'directory',
        {} as any,
      )) {
        tokens.push(token);
      }

      expect(tokens).toEqual(expectedTokens);
    });
  });

  describe('streamCompletion', () => {
    it('delegates to llmProvider.streamCompletion', async () => {
      async function* mockStream() {
        await Promise.resolve();
        yield 'completion-token';
      }
      mockModelGateway.stream.mockReturnValue(
        (async function* () {
          for await (const text of mockStream()) {
            yield { type: 'text_delta', text, attempt: 1 } as const;
          }
        })(),
      );

      const tokens: unknown[] = [];
      for await (const token of service.streamCompletion(
        'test prompt',
        'system prompt',
        0.7,
      )) {
        tokens.push(token);
      }

      expect(mockModelGateway.stream).toHaveBeenCalledWith({
        response_mode: 'text',
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: 'test prompt' },
        ],
        temperature: 0.7,
      });
      expect(tokens).toEqual([
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'completion-token' },
        },
      ]);
    });

    it('works without optional parameters', async () => {
      async function* mockStream() {
        await Promise.resolve();
        yield 'token';
      }
      mockModelGateway.stream.mockReturnValue(
        (async function* () {
          for await (const text of mockStream()) {
            yield { type: 'text_delta', text, attempt: 1 } as const;
          }
        })(),
      );

      const tokens: unknown[] = [];
      for await (const token of service.streamCompletion('only prompt')) {
        tokens.push(token);
      }

      expect(mockModelGateway.stream).toHaveBeenCalledWith({
        response_mode: 'text',
        messages: [{ role: 'user', content: 'only prompt' }],
      });
    });
  });

  describe('generateGroundedDraft', () => {
    it('returns the grounded chain result without replacing its audit', async () => {
      const generated = {
        proposal: {
          schema_version: 'grounded-draft.v1',
          status: 'material_gap',
          claims: [],
          render_fragments: [],
          ordering: [],
          material_gap: {
            reason_code: 'NO_EVIDENCE',
            missing_topics: ['容量'],
          },
        },
        audit: {
          repair_attempts: 1,
          proposal_bytes: 7_777,
          model_run_id: 'distinctive-run-id',
        },
      } as const;
      (groundedDraftChain as jest.Mock).mockResolvedValue(generated);
      const options = {
        signal: new AbortController().signal,
        timeout_ms: 4_321,
        trace: {
          workflow_job_id: '11111111-1111-4111-8111-111111111111',
          node: 'atomic_grounded_draft',
          attempt: 2,
        },
      };
      const modelInput = {
        workflow_type: 'content',
        workflow_job_id: options.trace.workflow_job_id,
        generation_attempt: 2,
        revision_attempt: 0,
        authoring_context: {},
        approved_render_context: {
          context_version: 'approved-render-context.v1',
          entries: [],
        },
        evidence: [],
      } as const;

      await expect(
        service.generateGroundedDraft(modelInput, options),
      ).resolves.toBe(generated);
      expect(groundedDraftChain).toHaveBeenCalledWith(
        mockModelGateway,
        modelInput,
        options,
      );
    });
  });

  describe('initialization', () => {
    it('routes model calls through ModelGateway', () => {
      expect(mockModelGateway).toHaveProperty('stream');
    });

    it('logs the LLM provider type', () => {
      expect(mockConfigService.get).toHaveBeenCalledWith(
        'LLM_PROVIDER',
        'anthropic',
      );
    });
  });
});
