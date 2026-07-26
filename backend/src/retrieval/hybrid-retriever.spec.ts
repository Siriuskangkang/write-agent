import { HybridRetriever } from './hybrid-retriever.js';
import type {
  DenseSearchResult,
  FusedCandidate,
  RetrievalCandidate,
  RetrievalRunRecorder,
  SparseRetrieverPort,
} from './types.js';

function candidate(chunk_id: string): RetrievalCandidate {
  return {
    chunk_id,
    file_id: 'file-1',
    document_id: 'document-1',
    project_id: 'project-1',
    ingestion_key: 'index-v1',
    content: `证据-${chunk_id}`,
    section_title: '第一节',
    heading_path: ['第一章', '第一节'],
    page_start: 1,
    page_end: 1,
    char_start: 0,
    char_end: 4,
    position: 0,
    token_count: 4,
    source: 'sparse',
    source_score: 1,
  };
}

describe('HybridRetriever', () => {
  const complete = jest.fn().mockResolvedValue(undefined);
  const recorder: RetrievalRunRecorder = {
    start: jest.fn().mockResolvedValue('run-1'),
    complete,
  };
  const neighborExpander = {
    expand: jest.fn<
      (
        projectId: string,
        candidates: FusedCandidate[],
      ) => Promise<FusedCandidate[]>
    >((_projectId, candidates) => Promise.resolve(candidates)),
  };

  beforeEach(() => jest.clearAllMocks());

  it('reuses a completed workflow revision run without invoking retrieval backends again', async () => {
    const sparse = { search: jest.fn().mockResolvedValue([]) };
    const dense = {
      search: jest.fn().mockResolvedValue({
        candidates: [],
        state: 'ready',
        error_code: null,
      }),
    };
    const legacy = { search: jest.fn().mockResolvedValue([]) };
    const startIdempotent = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'started', run_id: 'stable-run-1' })
      .mockResolvedValueOnce({
        kind: 'recovered',
        result: {
          run_id: 'stable-run-1',
          state: 'NO_HIT',
          error_code: null,
          error_message: null,
          evidence: [],
          used_tokens: 0,
          canonical_path: 'legacy_like',
          shadow_state: 'NO_HIT',
        },
      });
    const stableRecorder = {
      start: jest.fn().mockResolvedValue('forbidden-random-run'),
      startIdempotent,
      complete: jest.fn().mockResolvedValue(undefined),
    };
    const retriever = new HybridRetriever(
      sparse,
      dense,
      legacy,
      stableRecorder as never,
      neighborExpander as never,
    );
    const request = {
      project_id: 'project-1',
      query: '待修订声明',
      task_type: 'content' as const,
      top_k: 10,
      token_budget: 6_000,
      workflow_job_id: '11111111-1111-4111-8111-111111111111',
      revision_attempt: 1 as const,
    };

    const first = await retriever.retrieve(request);
    const recovered = await retriever.retrieve(request);

    expect(first.run_id).toBe('stable-run-1');
    expect(recovered.run_id).toBe('stable-run-1');
    expect(startIdempotent).toHaveBeenCalledTimes(2);
    expect(startIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        top_k: 10,
        token_budget: 6_000,
      }),
    );
    expect(stableRecorder.start).not.toHaveBeenCalled();
    expect(sparse.search).toHaveBeenCalledTimes(1);
    expect(dense.search).toHaveBeenCalledTimes(1);
    expect(legacy.search).toHaveBeenCalledTimes(1);
  });

  it('returns DEGRADED sparse evidence when Qdrant is unavailable', async () => {
    const sparse: SparseRetrieverPort = {
      search: jest.fn().mockResolvedValue([candidate('sparse-1')]),
    };
    const retriever = new HybridRetriever(
      sparse,
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'unavailable',
          error_code: 'QDRANT_UNAVAILABLE',
        } satisfies DenseSearchResult),
      },
      { search: jest.fn().mockResolvedValue([]) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '闭环控制',
      task_type: 'content',
      top_k: 8,
      token_budget: 100,
    });

    expect(result.state).toBe('DEGRADED');
    expect(result.error_code).toBe('QDRANT_UNAVAILABLE');
    expect(result.evidence.map((item) => item.chunk_id)).toEqual(['sparse-1']);
    expect(complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ state: 'DEGRADED' }),
    );
  });

  it('returns ERROR instead of false success when sparse and dense both fail', async () => {
    const retriever = new HybridRetriever(
      { search: jest.fn().mockRejectedValue(new Error('fulltext failed')) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'unavailable',
          error_code: 'QDRANT_UNAVAILABLE',
        }),
      },
      { search: jest.fn().mockResolvedValue([]) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '安全操作',
      task_type: 'outline',
      top_k: 8,
      token_budget: 100,
    });

    expect(result).toMatchObject({
      state: 'ERROR',
      evidence: [],
      error_code: 'RETRIEVAL_BACKENDS_UNAVAILABLE',
    });
  });

  it('returns NO_HIT only when healthy backends found no candidates', async () => {
    const retriever = new HybridRetriever(
      { search: jest.fn().mockResolvedValue([]) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'ready',
          error_code: null,
        }),
      },
      { search: jest.fn().mockResolvedValue([]) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '不存在的术语',
      task_type: 'directory',
      top_k: 8,
      token_budget: 100,
    });

    expect(result.state).toBe('NO_HIT');
    expect(result.error_code).toBeNull();
  });

  it('runs legacy LIKE only as a recorded shadow and never returns it', async () => {
    const legacyOnly = candidate('legacy-only');
    const retriever = new HybridRetriever(
      { search: jest.fn().mockResolvedValue([]) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'ready',
          error_code: null,
        }),
      },
      { search: jest.fn().mockResolvedValue([legacyOnly]) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '旧链路命中',
      task_type: 'content',
      top_k: 8,
      token_budget: 100,
    });

    expect(result.state).toBe('NO_HIT');
    expect(result.evidence).toEqual([]);
    expect(complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ legacy_count: 1, selected_count: 0 }),
    );
  });

  it('expands adjacent chunks before applying the evidence budget', async () => {
    const neighbor = candidate('neighbor-1');
    neighbor.source = 'neighbor';
    neighbor.position = 1;
    neighbor.source_score = 0.8;
    neighborExpander.expand.mockResolvedValueOnce([
      {
        ...neighbor,
        sparse_rank: null,
        sparse_score: null,
        dense_rank: null,
        dense_score: null,
        fusion_score: 0.01,
        fusion_rank: 2,
        rerank_score: 0.8,
        rerank_rank: 2,
      },
    ]);
    const retriever = new HybridRetriever(
      { search: jest.fn().mockResolvedValue([candidate('sparse-1')]) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'ready',
          error_code: null,
        }),
      },
      { search: jest.fn().mockResolvedValue([]) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '闭环控制',
      task_type: 'content',
      top_k: 8,
      token_budget: 100,
    });

    expect(neighborExpander.expand).toHaveBeenCalledWith(
      'project-1',
      expect.arrayContaining([
        expect.objectContaining({ chunk_id: 'sparse-1' }),
      ]),
    );
    expect(result.evidence.map((item) => item.chunk_id)).toEqual([
      'neighbor-1',
    ]);
  });

  it('terminalizes the run when neighbor expansion throws', async () => {
    const failingNeighbor = {
      expand: jest
        .fn()
        .mockRejectedValue(new Error('neighbor database failed')),
    };
    const retriever = new HybridRetriever(
      { search: jest.fn().mockResolvedValue([candidate('sparse-1')]) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'ready',
          error_code: null,
          index_versions: [],
        }),
      },
      { search: jest.fn().mockResolvedValue([candidate('legacy-1')]) },
      recorder,
      failingNeighbor as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '闭环控制',
      task_type: 'content',
      top_k: 8,
      token_budget: 100,
      mode: 'shadow',
      gate_decision: false,
    });

    expect(result.state).toBe('ERROR');
    expect(result.error_code).toBe('RETRIEVAL_PIPELINE_FAILED');
    expect(complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        state: 'READY',
        shadow_state: 'ERROR',
        shadow_error_code: 'RETRIEVAL_PIPELINE_FAILED',
      }),
    );
  });

  it('records and returns a legacy canonical failure as ERROR', async () => {
    const retriever = new HybridRetriever(
      { search: jest.fn().mockResolvedValue([]) },
      {
        search: jest.fn().mockResolvedValue({
          candidates: [],
          state: 'ready',
          error_code: null,
          index_versions: [],
        }),
      },
      { search: jest.fn().mockRejectedValue(new Error('legacy mysql failed')) },
      recorder,
      neighborExpander as never,
    );

    const result = await retriever.retrieve({
      project_id: 'project-1',
      query: '错误',
      task_type: 'content',
      top_k: 8,
      token_budget: 100,
      mode: 'shadow',
      gate_decision: false,
    });

    expect(result.legacy_state).toBe('ERROR');
    expect(result.legacy_error_message).toContain('legacy mysql failed');
    expect(complete).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        state: 'ERROR',
        canonical_state: 'ERROR',
        canonical_error_message: 'legacy mysql failed',
      }),
    );
  });
});
