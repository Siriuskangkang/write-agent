import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ContentService } from './content.service.js';
import { ContentSharedService } from './content-shared.service.js';
import { DirectoryService } from './directory.service.js';
import { OutlineService } from './outline.service.js';
import { ContentGenerationService } from './content-generation.service.js';
import { WritingResult } from './entities/writing-result.entity.js';
import { ContentVersion } from './entities/content-version.entity.js';
import { DirectoryVersion } from './entities/directory-version.entity.js';
import { OutlineVersion } from './entities/outline-version.entity.js';
import { Chunk } from '../chunk/entities/chunk.entity.js';
import { AgentService } from '../agent/agent.service.js';
import { ProjectService } from '../project/project.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { CitationService } from '../citation/citation.service.js';
import { StyleTemplateService } from '../style-template/style-template.service.js';
import { AtomicGroundingCoordinator } from '../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import { DirectoryNodeType } from './dto/save-directory.dto.js';
import {
  TaskType,
  WritingResultStatus,
  CitationUseType,
} from '../common/enums.js';

interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asStreamEvent(value: unknown): StreamEvent {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    !isRecord(value.data)
  ) {
    throw new Error(
      'Expected a stream event with a type and object data payload',
    );
  }
  return { type: value.type, data: value.data };
}

async function* makeTokenGenerator(tokens: string[]): AsyncGenerator<string> {
  await Promise.resolve();
  for (const token of tokens) {
    yield token;
  }
}

const makeWritingResultMock = (
  overrides: Partial<WritingResult> = {},
): WritingResult =>
  ({
    id: 'result-1',
    project_id: 'proj-1',
    session_id: null,
    chapter_node_id: 'ch-1',
    section_node_id: 'sec-1',
    chapter_index: null,
    chapter_title: null,
    section_title: null,
    task_type: TaskType.GENERATE,
    status: WritingResultStatus.STREAMING,
    content_text: '原始内容',
    word_count: null,
    style: null,
    version_number: 1,
    parent_result_id: null,
    error_message: null,
    created_at: new Date('2024-01-01'),
    completed_at: null,
    ...overrides,
  }) as WritingResult;

const mockWritingResultRepo = {
  create: jest.fn((dto: Partial<WritingResult>) => ({
    ...dto,
    id: 'result-new',
    created_at: new Date(),
  })),
  save: jest.fn(),
  findOne: jest.fn(),
  findOneOrFail: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
  count: jest.fn().mockResolvedValue(0),
};

const mockContentVersionRepoMethods = {
  create: jest.fn((dto: Partial<ContentVersion>) => dto),
  save: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
  count: jest.fn().mockResolvedValue(0),
};

const mockContentVersionRepo = {
  ...mockContentVersionRepoMethods,
  manager: {
    transaction: jest.fn(
      async <T>(
        callback: (manager: {
          query(sql: string): Promise<Array<Record<string, unknown>>>;
          getRepository(): typeof mockContentVersionRepoMethods;
        }) => Promise<T>,
      ): Promise<T> =>
        callback({
          query: (sql: string) =>
            Promise.resolve(
              sql.includes('MAX(version_number)')
                ? [{ maxVersion: 0 }]
                : [{ id: 'result-new' }],
            ),
          getRepository: () => mockContentVersionRepoMethods,
        }),
    ),
  },
};

const mockDirectoryVersionRepoMethods = {
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findOneOrFail: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
  create: jest.fn((dto: Partial<DirectoryVersion>) => dto),
  save: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
};

const mockDirectoryVersionRepo = {
  ...mockDirectoryVersionRepoMethods,
  manager: {
    transaction: jest.fn(
      async <T>(
        callback: (manager: {
          query(sql: string): Promise<Array<Record<string, unknown>>>;
          getRepository(): typeof mockDirectoryVersionRepoMethods;
          update(): Promise<{ affected: number }>;
        }) => Promise<T>,
      ): Promise<T> =>
        callback({
          query: (sql: string) =>
            Promise.resolve(
              sql.includes('MAX(version_number)')
                ? [{ maxVersion: 0 }]
                : [{ id: 'proj-1' }],
            ),
          getRepository: () => mockDirectoryVersionRepoMethods,
          update: () => Promise.resolve({ affected: 1 }),
        }),
    ),
  },
};

const mockOutlineVersionRepoMethods = {
  findOne: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue(undefined),
  create: jest.fn((dto: Partial<OutlineVersion>) => dto),
  save: jest.fn(),
  count: jest.fn().mockResolvedValue(0),
  findOneOrFail: jest.fn(),
};

const mockOutlineVersionRepo = {
  ...mockOutlineVersionRepoMethods,
  manager: {
    transaction: jest.fn(
      async <T>(
        callback: (manager: {
          query(sql: string): Promise<Array<Record<string, unknown>>>;
          getRepository(): typeof mockOutlineVersionRepoMethods;
        }) => Promise<T>,
      ): Promise<T> =>
        callback({
          query: (sql: string) =>
            Promise.resolve(
              sql.includes('MAX(version_number)')
                ? [{ maxVersion: 0 }]
                : [{ id: 'proj-1' }],
            ),
          getRepository: () => mockOutlineVersionRepoMethods,
        }),
    ),
  },
};

const mockChunkRepo = {
  find: jest.fn().mockResolvedValue([]),
};

const mockProject = {
  id: 'proj-1',
  name: '测试项目',
  description: '项目描述',
  type: 'textbook',
  target_audience: '学生',
  target_chapters: 10,
  style: '简洁',
};

const mockAgentService = {
  generateStream: jest.fn(() => makeTokenGenerator([])),
};

const mockProjectService = {
  findOne: jest.fn().mockResolvedValue(mockProject),
  updateState: jest.fn().mockResolvedValue(undefined),
};

const mockRetrievalService = {
  retrieve: jest.fn().mockResolvedValue([]),
};

const mockCitationService = {
  createCitations: jest.fn().mockResolvedValue([]),
  getCitationsByResultId: jest.fn().mockResolvedValue([]),
};

const mockStyleTemplateService = {
  findAll: jest.fn().mockResolvedValue([]),
  getProjectActiveTemplate: jest.fn().mockResolvedValue({
    status: 'completed',
    features: { structure_tree: null },
  }),
};

const mockAtomicGroundingCoordinator = {
  generate: jest.fn(),
  recover: jest.fn(),
};

describe('ContentService', () => {
  let service: ContentService;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset defaults
    mockStyleTemplateService.getProjectActiveTemplate.mockResolvedValue({
      status: 'completed',
      features: { structure_tree: null },
    });
    mockAgentService.generateStream.mockImplementation(() =>
      makeTokenGenerator([]),
    );
    mockProjectService.findOne.mockResolvedValue(mockProject);

    moduleRef = await Test.createTestingModule({
      providers: [
        ContentSharedService,
        DirectoryService,
        OutlineService,
        ContentGenerationService,
        ContentService,
        {
          provide: getRepositoryToken(WritingResult),
          useValue: mockWritingResultRepo,
        },
        {
          provide: getRepositoryToken(ContentVersion),
          useValue: mockContentVersionRepo,
        },
        {
          provide: getRepositoryToken(DirectoryVersion),
          useValue: mockDirectoryVersionRepo,
        },
        {
          provide: getRepositoryToken(OutlineVersion),
          useValue: mockOutlineVersionRepo,
        },
        { provide: getRepositoryToken(Chunk), useValue: mockChunkRepo },
        { provide: AgentService, useValue: mockAgentService },
        { provide: ProjectService, useValue: mockProjectService },
        { provide: RetrievalService, useValue: mockRetrievalService },
        { provide: CitationService, useValue: mockCitationService },
        { provide: StyleTemplateService, useValue: mockStyleTemplateService },
        {
          provide: AtomicGroundingCoordinator,
          useValue: mockAtomicGroundingCoordinator,
        },
      ],
    }).compile();

    service = moduleRef.get<ContentService>(ContentService);
  });

  it('returns one buffered atomic outcome from ownership-prepared context', async () => {
    const generationService = moduleRef.get<ContentGenerationService>(
      ContentGenerationService,
    );
    const prepared = {
      workflow_job_id: 'job-1',
      project_id: 'proj-1',
      workflow_type: 'content',
      generation_attempt: 2,
      revision_attempt: 0,
      authoring_context: { project_name: '测试项目' },
      signal: new AbortController().signal,
    } as const;
    const prepare = jest.fn().mockResolvedValue(prepared);
    (
      generationService as unknown as {
        prepareAtomicGroundingInput: typeof prepare;
      }
    ).prepareAtomicGroundingInput = prepare;
    const outcome = {
      kind: 'material_gap',
      reason_code: 'NO_EVIDENCE',
      candidate_claim_keys: [],
    } as const;
    mockAtomicGroundingCoordinator.generate.mockResolvedValue(outcome);

    await expect(
      service.generateAtomicGroundingCandidate(
        'content',
        'user-1',
        'proj-1',
        { chapter_node_id: 'ch-1', section_node_id: 'sec-1' },
        prepared.signal,
        {
          workflow_job_id: 'job-1',
          node: 'generation',
          attempt: 2,
        },
      ),
    ).resolves.toBe(outcome);
    expect(prepare).toHaveBeenCalled();
    expect(mockAtomicGroundingCoordinator.generate).toHaveBeenCalledWith(
      prepared,
    );
  });

  it('prepares a structured revision from the merged assignment without initial retrieval', async () => {
    const shared = moduleRef.get<ContentSharedService>(ContentSharedService);
    const merged = {
      materials: '[evidence_id: revised]\\n精确证据: 修订证据',
      evidenceIds: ['revised'],
    };
    const load = jest
      .spyOn(shared, 'loadGroundingMaterials')
      .mockResolvedValue(merged);
    const retrieve = jest.spyOn(shared, 'retrieveGroundingMaterials');
    const inherit = jest.spyOn(shared, 'inheritGroundingMaterials');
    const outcome = {
      kind: 'material_gap',
      reason_code: 'REVISION_EXHAUSTED',
      candidate_claim_keys: ['candidate-key-1'],
    } as const;
    mockAtomicGroundingCoordinator.generate.mockResolvedValue(outcome);
    const signal = new AbortController().signal;
    const persistSealedCandidate = jest.fn();
    const input = {
      chapter_node_id: 'ch-1',
      section_node_id: 'sec-1',
      strict_citation: true,
      revision_attempt: 1,
      revision: {
        base_proposal: {
          schema_version: 'grounded-draft.v1',
          status: 'draft',
          claims: [],
          render_fragments: [],
          ordering: [],
          material_gap: null,
        },
        allowed_candidate_claim_keys: ['candidate-key-1'],
        non_target_invariant_digests: {},
      },
    };

    await expect(
      service.generateAtomicGroundingRevisionCandidate(
        'content',
        'user-1',
        'proj-1',
        input,
        signal,
        {
          workflow_job_id: 'job-1',
          node: 'atomic_grounded_revision',
          attempt: 2,
        },
        persistSealedCandidate,
      ),
    ).resolves.toBe(outcome);

    expect(load).toHaveBeenCalledWith('proj-1', 'job-1');
    expect(retrieve).not.toHaveBeenCalled();
    expect(inherit).not.toHaveBeenCalled();
    expect(mockAtomicGroundingCoordinator.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_job_id: 'job-1',
        revision_attempt: 1,
        revision: input.revision,
        persist_sealed_candidate: persistSealedCandidate,
      }),
    );
  });

  // ─── generateDirectory ──────────────────────────────────────────────────────

  describe('generateDirectory', () => {
    it('throws ConflictException when no active template', async () => {
      mockStyleTemplateService.getProjectActiveTemplate.mockResolvedValue(null);

      const gen = service.generateDirectory('user-1', 'proj-1', {} as any);
      await expect(gen.next()).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when template has no features', async () => {
      mockStyleTemplateService.getProjectActiveTemplate.mockResolvedValue({
        status: 'completed',
        features: null,
      });

      const gen = service.generateDirectory('user-1', 'proj-1', {} as any);
      await expect(gen.next()).rejects.toThrow(ConflictException);
    });

    it('yields tokens from agentService when template exists', async () => {
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator(['目', '录', '内', '容']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateDirectory(
        'user-1',
        'proj-1',
        {} as any,
      )) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['目', '录', '内', '容']);
      expect(mockAgentService.generateStream).toHaveBeenCalledWith(
        'directory',
        expect.objectContaining({ projectName: '测试项目' }),
      );
    });
  });

  // ─── generateOutline ────────────────────────────────────────────────────────

  describe('generateOutline', () => {
    it('throws ConflictException when no active template', async () => {
      mockStyleTemplateService.getProjectActiveTemplate.mockResolvedValue(null);

      const gen = service.generateOutline('user-1', 'proj-1', {
        chapter_title: '第一章',
        chapter_node_id: 'ch-1',
      } as any);
      await expect(gen.next()).rejects.toThrow(ConflictException);
    });

    it('yields tokens when template exists', async () => {
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator(['大纲内容']),
      );

      const tokens: string[] = [];
      for await (const token of service.generateOutline('user-1', 'proj-1', {
        chapter_title: '第一章',
        chapter_node_id: 'ch-1',
        section_title: '第一节',
      } as any)) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['大纲内容']);
      expect(mockAgentService.generateStream).toHaveBeenCalledWith(
        'outline',
        expect.objectContaining({ chapterTitle: '第一章' }),
      );
    });

    it('builds sectionList from directory when available', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue({
        project_id: 'proj-1',
        is_current: true,
        content: [
          {
            node_id: 'sec-1',
            parent_node_id: 'ch-1',
            title: '第一节',
            order_index: 0,
          },
          {
            node_id: 'sec-2',
            parent_node_id: 'ch-1',
            title: '第二节',
            order_index: 1,
          },
          {
            node_id: 'ch-1',
            parent_node_id: null,
            title: '第一章',
            order_index: 0,
          },
        ],
      });
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator([]),
      );

      const tokens: string[] = [];
      for await (const token of service.generateOutline('user-1', 'proj-1', {
        chapter_title: '第一章',
        chapter_node_id: 'ch-1',
      } as any)) {
        tokens.push(token);
      }

      const calls: unknown = mockAgentService.generateStream.mock.calls;
      const firstCall: unknown = Array.isArray(calls) ? calls[0] : undefined;
      if (!Array.isArray(firstCall)) {
        throw new Error('Expected generateStream to be called');
      }
      const options: unknown = firstCall[1];
      if (!isRecord(options)) {
        throw new Error('Expected generateStream options to be an object');
      }
      expect(options.sectionList).toContain('第一节');
    });
  });

  // ─── generateContent ─────────────────────────────────────────────────────────

  describe('generateContent', () => {
    beforeEach(() => {
      const savedResult = makeWritingResultMock({ id: 'result-new' });
      mockWritingResultRepo.save.mockResolvedValue({
        ...savedResult,
        created_at: new Date(),
      });
    });

    it('throws ConflictException when no active template', async () => {
      mockStyleTemplateService.getProjectActiveTemplate.mockResolvedValue(null);

      const gen = service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any);
      await expect(gen.next()).rejects.toThrow(ConflictException);
    });

    it('first yields meta event with result_id', async () => {
      const gen = service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any);

      const first = asStreamEvent((await gen.next()).value);
      expect(first.type).toBe('meta');
      expect(first.data.task_type).toBe(TaskType.GENERATE);
    });

    it('yields token events for each token', async () => {
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator(['正', '文', '内', '容']),
      );

      const events: StreamEvent[] = [];
      for await (const event of service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any)) {
        events.push(asStreamEvent(event));
      }

      const tokenEvents = events.filter((e) => e.type === 'token');
      expect(tokenEvents).toHaveLength(4);
      expect(tokenEvents[0]?.data.content).toBe('正');
    });

    it('yields done event at the end', async () => {
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator(['内容']),
      );

      const events: StreamEvent[] = [];
      for await (const event of service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any)) {
        events.push(asStreamEvent(event));
      }

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.data.status).toBe(WritingResultStatus.SUCCEEDED);
    });

    it('yields error event when agentService throws', async () => {
      mockAgentService.generateStream.mockImplementation(() => {
        throw new Error('LLM error');
      });

      const events: StreamEvent[] = [];
      for await (const event of service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any)) {
        events.push(asStreamEvent(event));
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.data.error_code).toBe('GENERATION_FAILED');
    });

    it('updates writing result to FAILED on error', async () => {
      mockAgentService.generateStream.mockImplementation(() => {
        throw new Error('fail');
      });

      const events: StreamEvent[] = [];
      for await (const event of service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any)) {
        events.push(asStreamEvent(event));
      }

      expect(mockWritingResultRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: WritingResultStatus.FAILED }),
      );
    });

    it('keeps an aborted workflow result STOPPED instead of reversing it to FAILED', async () => {
      mockAgentService.generateStream.mockImplementation(() => {
        throw new DOMException('cancelled', 'AbortError');
      });
      const controller = new AbortController();
      controller.abort();

      const events: unknown[] = [];
      for await (const event of service.generateContent(
        'user-1',
        'proj-1',
        {
          chapter_node_id: 'ch-1',
          section_node_id: 'sec-1',
        } as any,
        controller.signal,
      )) {
        events.push(event);
      }
      expect(events).toHaveLength(2);

      expect(mockWritingResultRepo.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: WritingResultStatus.STOPPED }),
      );
    });
  });

  // ─── getWritingResult ────────────────────────────────────────────────────────

  describe('getWritingResult', () => {
    it('returns result when found', async () => {
      const mockResult = makeWritingResultMock();
      mockWritingResultRepo.findOne.mockResolvedValue(mockResult);

      const result = await service.getWritingResult(
        'user-1',
        'proj-1',
        'result-1',
      );
      expect(result).toEqual(mockResult);
    });

    it('throws NotFoundException when result not found', async () => {
      mockWritingResultRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getWritingResult('user-1', 'proj-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── stopGeneration ──────────────────────────────────────────────────────────

  describe('stopGeneration', () => {
    it('throws NotFoundException when result not found', async () => {
      mockWritingResultRepo.findOne.mockResolvedValue(null);

      await expect(
        service.stopGeneration('user-1', 'proj-1', 'missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns result unchanged when not in STREAMING status', async () => {
      const mockResult = makeWritingResultMock({
        status: WritingResultStatus.SUCCEEDED,
      });
      mockWritingResultRepo.findOne.mockResolvedValue(mockResult);

      const result = await service.stopGeneration(
        'user-1',
        'proj-1',
        'result-1',
      );
      expect(result).toEqual(mockResult);
      expect(mockWritingResultRepo.update).not.toHaveBeenCalled();
    });

    it('updates status to STOPPED when streaming', async () => {
      const mockResult = makeWritingResultMock({
        status: WritingResultStatus.STREAMING,
      });
      const stoppedResult = {
        ...mockResult,
        status: WritingResultStatus.STOPPED,
      };
      mockWritingResultRepo.findOne.mockResolvedValue(mockResult);
      mockWritingResultRepo.findOneOrFail.mockResolvedValue(stoppedResult);

      const result = await service.stopGeneration(
        'user-1',
        'proj-1',
        'result-1',
      );

      expect(mockWritingResultRepo.update).toHaveBeenCalledWith(
        { id: mockResult.id, project_id: 'proj-1' },
        expect.objectContaining({ status: WritingResultStatus.STOPPED }),
      );
      expect(result.status).toBe(WritingResultStatus.STOPPED);
    });
  });

  // ─── saveDirectory ───────────────────────────────────────────────────────────

  describe('saveDirectory', () => {
    it('reuses the current version when a legacy client resubmits the worker-saved directory', async () => {
      const nodes = [
        {
          node_id: 'n1',
          node_type: DirectoryNodeType.CHAPTER,
          order_index: 0,
          title: '第一章',
        },
      ];
      const current = {
        id: 'dir-v1',
        project_id: 'proj-1',
        version_number: 1,
        content: nodes,
        is_current: true,
      };
      mockDirectoryVersionRepo.findOne.mockResolvedValue(current);

      await expect(
        service.saveDirectory('user-1', 'proj-1', {
          nodes,
          base_version_number: 1,
        }),
      ).resolves.toEqual(current);
      expect(mockDirectoryVersionRepo.update).not.toHaveBeenCalled();
      expect(mockDirectoryVersionRepo.save).not.toHaveBeenCalled();
    });

    it('throws ConflictException when version mismatch', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue({
        id: 'dir-v1',
        version_number: 2,
        is_current: true,
      });

      await expect(
        service.saveDirectory('user-1', 'proj-1', {
          nodes: [],
          base_version_number: 1,
        } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('saves new directory version when no conflict', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue(null);
      mockDirectoryVersionRepo.count.mockResolvedValue(0);
      const savedDir = { id: 'dir-v1', version_number: 1, is_current: true };
      mockDirectoryVersionRepo.save.mockResolvedValue(savedDir);

      const result = await service.saveDirectory('user-1', 'proj-1', {
        nodes: [{ node_id: 'n1', title: '第一章' }],
        base_version_number: undefined,
      } as any);

      expect(mockDirectoryVersionRepo.save).toHaveBeenCalled();
      expect(result).toEqual(savedDir);
    });
  });

  // ─── getCurrentDirectory ──────────────────────────────────────────────────────

  describe('getCurrentDirectory', () => {
    it('returns current directory version', async () => {
      const mockDir = { id: 'dir-1', is_current: true };
      mockDirectoryVersionRepo.findOne.mockResolvedValue(mockDir);

      const result = await service.getCurrentDirectory('user-1', 'proj-1');
      expect(result).toEqual(mockDir);
    });

    it('returns null when no current directory', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue(null);

      const result = await service.getCurrentDirectory('user-1', 'proj-1');
      expect(result).toBeNull();
    });
  });

  // ─── updateDirectoryNode ──────────────────────────────────────────────────────

  describe('updateDirectoryNode', () => {
    it('rejects a foreign project before looking up a directory resource', async () => {
      mockProjectService.findOne.mockRejectedValue(
        new ForbiddenException('无权访问该项目'),
      );

      await expect(
        service.updateDirectoryNode('other-user', 'proj-1', 'node-1', '新标题'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockDirectoryVersionRepo.findOne).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when no current directory', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateDirectoryNode('user-1', 'proj-1', 'node-1', '新标题'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when node not found', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue({
        id: 'dir-1',
        content: [{ node_id: 'other-node', title: '其他节点' }],
      });

      await expect(
        service.updateDirectoryNode(
          'user-1',
          'proj-1',
          'node-missing',
          '新标题',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('updates node title in current directory', async () => {
      const updatedDir = {
        id: 'dir-1',
        content: [{ node_id: 'n1', title: '新标题' }],
      };
      mockDirectoryVersionRepo.findOne.mockResolvedValue({
        id: 'dir-1',
        content: [{ node_id: 'n1', title: '旧标题' }],
      });
      mockDirectoryVersionRepo.findOneOrFail.mockResolvedValue(updatedDir);

      const result = await service.updateDirectoryNode(
        'user-1',
        'proj-1',
        'n1',
        '新标题',
      );

      expect(mockDirectoryVersionRepo.update).toHaveBeenCalledWith(
        { id: 'dir-1', project_id: 'proj-1' },
        expect.objectContaining({
          content: [{ node_id: 'n1', title: '新标题' }],
        }),
      );
      expect(result).toEqual(updatedDir);
    });
  });

  // ─── deleteDirectoryNode ─────────────────────────────────────────────────────

  describe('deleteDirectoryNode', () => {
    it('throws NotFoundException when no current directory', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteDirectoryNode('user-1', 'proj-1', 'node-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('removes node and its children', async () => {
      mockDirectoryVersionRepo.findOne.mockResolvedValue({
        id: 'dir-1',
        content: [
          { node_id: 'ch-1', parent_node_id: null, title: '第一章' },
          { node_id: 'sec-1', parent_node_id: 'ch-1', title: '第一节' },
        ],
      });

      await service.deleteDirectoryNode('user-1', 'proj-1', 'ch-1');

      expect(mockDirectoryVersionRepo.update).toHaveBeenCalledWith(
        { id: 'dir-1', project_id: 'proj-1' },
        expect.objectContaining({ content: [] }),
      );
    });
  });

  // ─── parseStructuredCitations (private — tested via generateContent) ─────────

  describe('parseStructuredCitations (via generateContent)', () => {
    beforeEach(() => {
      const savedResult = makeWritingResultMock({ id: 'result-new' });
      mockWritingResultRepo.save.mockResolvedValue({
        ...savedResult,
        created_at: new Date(),
      });
    });

    it('stores citations when content contains citation markers', async () => {
      const contentWithCitations = `<!-- paragraph_key: p1 -->
Some content here
<!-- citations: p1 -->
- [chunk-abc](use_type: rewrite) description here
`;
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator([contentWithCitations]),
      );

      const mockChunk = {
        id: 'chunk-abc',
        file_id: 'file-1',
        content: '引用内容',
        page_number: 1,
        section_title: '章节1',
      };
      mockChunkRepo.find.mockResolvedValue([mockChunk]);
      mockCitationService.getCitationsByResultId.mockResolvedValue([
        {
          id: 'cit-1',
          paragraph_key: 'p1',
          chunk_id: 'chunk-abc',
          use_type: CitationUseType.REWRITE,
        },
      ]);

      const events: any[] = [];
      for await (const event of service.generateContent('user-1', 'proj-1', {
        chapter_node_id: 'ch-1',
        section_node_id: 'sec-1',
      } as any)) {
        events.push(event);
      }

      expect(mockCitationService.createCitations).toHaveBeenCalled();
    });
  });

  // ─── rewriteContent ──────────────────────────────────────────────────────────

  describe('rewriteContent', () => {
    beforeEach(() => {
      const original = makeWritingResultMock({ content_text: '原始内容' });
      mockWritingResultRepo.findOne.mockResolvedValue(original);
      const savedResult = makeWritingResultMock({
        id: 'result-rewrite',
        task_type: TaskType.REWRITE,
      });
      mockWritingResultRepo.save.mockResolvedValue({
        ...savedResult,
        created_at: new Date(),
      });
    });

    it('first yields meta event with REWRITE task_type', async () => {
      const gen = service.rewriteContent('user-1', 'proj-1', 'result-1', {
        instruction: '改写指令',
      } as any);

      const first = asStreamEvent((await gen.next()).value);
      expect(first.type).toBe('meta');
      expect(first.data.task_type).toBe(TaskType.REWRITE);
    });

    it('yields done event after streaming', async () => {
      mockAgentService.generateStream.mockImplementation(() =>
        makeTokenGenerator(['改写内容']),
      );

      const events: StreamEvent[] = [];
      for await (const event of service.rewriteContent(
        'user-1',
        'proj-1',
        'result-1',
        {
          instruction: '指令',
        } as any,
      )) {
        events.push(asStreamEvent(event));
      }

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.data.status).toBe(WritingResultStatus.SUCCEEDED);
    });
  });

  // ─── saveOutlineFromGeneration ────────────────────────────────────────────────

  describe('saveOutlineFromGeneration', () => {
    it('throws BadRequestException when content is invalid JSON', async () => {
      await expect(
        service.saveOutlineFromGeneration(
          'user-1',
          'proj-1',
          {
            chapter_node_id: 'ch-1',
            chapter_title: '第一章',
          } as any,
          'not valid json',
        ),
      ).rejects.toThrow();
    });

    it('saves outline version from valid JSON content', async () => {
      const savedOutline = { id: 'outline-1', version_number: 1 };
      mockOutlineVersionRepo.save.mockResolvedValue(savedOutline);

      const result = await service.saveOutlineFromGeneration(
        'user-1',
        'proj-1',
        {
          chapter_node_id: 'ch-1',
          chapter_title: '第一章',
          section_node_id: null,
        } as any,
        JSON.stringify({ items: ['条目1', '条目2'] }),
      );

      expect(mockOutlineVersionRepo.save).toHaveBeenCalled();
      expect(result).toEqual(savedOutline);
    });
  });

  // ─── updateWritingResult ─────────────────────────────────────────────────────

  describe('updateWritingResult', () => {
    it('does not update a result outside the owned project', async () => {
      mockWritingResultRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateWritingResult(
          'user-1',
          'proj-1',
          'foreign-result',
          '新内容',
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockWritingResultRepo.update).not.toHaveBeenCalled();
    });

    it('updates content and returns result', async () => {
      const updated = makeWritingResultMock({ content_text: '新内容' });
      mockWritingResultRepo.findOne.mockResolvedValue(updated);
      mockWritingResultRepo.findOneOrFail.mockResolvedValue(updated);

      const result = await service.updateWritingResult(
        'user-1',
        'proj-1',
        'result-1',
        '新内容',
      );

      expect(mockWritingResultRepo.update).toHaveBeenCalledWith(
        { id: 'result-1', project_id: 'proj-1' },
        { content_text: '新内容' },
      );
      expect(result).toEqual(updated);
    });
  });
});
