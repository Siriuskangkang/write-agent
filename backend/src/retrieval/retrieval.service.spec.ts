import { RetrievalService } from './retrieval.service.js';

describe('RetrievalService compatibility adapter', () => {
  it('returns hybrid evidence through the legacy result shape', async () => {
    const hybrid = {
      retrieve: jest.fn().mockResolvedValue({
        run_id: 'run-1',
        state: 'READY',
        error_code: null,
        error_message: null,
        used_tokens: 10,
        evidence: [
          {
            evidence_id: 'evidence:chunk-1',
            chunk_id: 'chunk-1',
            content: '闭环控制材料',
            exact_span: {
              text: '闭环控制材料',
              char_start: 0,
              char_end: 6,
            },
            source: {
              file_id: 'file-1',
              document_id: 'doc-1',
              ingestion_key: 'v1',
              page_start: 2,
              page_end: 2,
              section_title: '进给系统',
              heading_path: ['第一章', '进给系统'],
            },
            scores: {
              sparse: 3,
              dense: 0.9,
              fusion: 0.03,
              rerank: 0.8,
            },
            ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
            token_count: 10,
          },
        ],
      }),
    };
    const service = new RetrievalService(
      hybrid as never,
      { search: jest.fn() } as never,
      { get: () => 'hybrid' } as never,
      { canUseHybrid: jest.fn().mockResolvedValue(true) } as never,
    );

    await expect(
      service.retrieve('project-1', {
        query: '闭环控制',
        task_type: 'content',
        top_k: 8,
      }),
    ).resolves.toEqual([
      {
        chunk_id: 'chunk-1',
        content: '闭环控制材料',
        file_name: '',
        file_id: 'file-1',
        page_number: 2,
        page_end: 2,
        section_title: '进给系统',
        heading_path: ['第一章', '进给系统'],
        score: 0.8,
        keywords: [],
        retrieval_run_id: 'run-1',
        exact_span: {
          text: '闭环控制材料',
          char_start: 0,
          char_end: 6,
        },
      },
    ]);
    expect(hybrid.retrieve).toHaveBeenCalledWith({
      project_id: 'project-1',
      query: '闭环控制',
      task_type: 'content',
      top_k: 8,
      token_budget: 6_000,
      mode: 'hybrid',
      gate_decision: true,
    });
  });

  it('exposes NO_HIT and DEGRADED distinctly through the detailed API', async () => {
    const hybrid = {
      retrieve: jest.fn().mockResolvedValue({
        run_id: 'run-2',
        state: 'DEGRADED',
        error_code: 'QDRANT_UNAVAILABLE',
        error_message: 'connection refused',
        evidence: [],
        used_tokens: 0,
      }),
    };
    const service = new RetrievalService(
      hybrid as never,
      { search: jest.fn() } as never,
      { get: () => 'hybrid' } as never,
      { canUseHybrid: jest.fn().mockResolvedValue(true) } as never,
    );

    await expect(
      service.retrieveDetailed('project-1', {
        query: '测试',
        task_type: 'outline',
      }),
    ).resolves.toMatchObject({
      state: 'DEGRADED',
      error_code: 'QDRANT_UNAVAILABLE',
    });
  });

  it('defaults to shadow mode and returns legacy results while recording hybrid', async () => {
    const legacyCandidate = {
      chunk_id: 'legacy-1',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'doc-1',
      ingestion_key: 'v1',
      content: '旧链路素材',
      section_title: '旧标题',
      heading_path: ['旧章'],
      page_start: 1,
      page_end: 1,
      char_start: 0,
      char_end: 5,
      position: 0,
      token_count: 5,
      source: 'sparse',
      source_score: 2,
    };
    const hybrid = {
      retrieve: jest.fn().mockResolvedValue({
        run_id: 'run-shadow',
        state: 'READY',
        error_code: null,
        error_message: null,
        evidence: [
          {
            chunk_id: 'hybrid-only',
          },
        ],
        legacy_candidates: [legacyCandidate],
        used_tokens: 5,
      }),
    };
    const service = new RetrievalService(
      hybrid as never,
      { search: jest.fn() } as never,
      { get: (_key: string, fallback: string) => fallback } as never,
      { canUseHybrid: jest.fn().mockResolvedValue(false) } as never,
    );

    const result = await service.retrieve('project-1', {
      query: '旧链路',
      task_type: 'content',
    });

    expect(result.map((item) => item.chunk_id)).toEqual(['legacy-1']);
    expect(hybrid.retrieve).toHaveBeenCalledTimes(1);
  });

  it('fails closed to shadow when hybrid is configured without a passing report', async () => {
    const hybrid = {
      retrieve: jest.fn().mockResolvedValue({
        run_id: 'run-gated',
        state: 'READY',
        error_code: null,
        error_message: null,
        evidence: [{ chunk_id: 'hybrid-only' }],
        legacy_candidates: [],
        used_tokens: 1,
      }),
    };
    const service = new RetrievalService(
      hybrid as never,
      { search: jest.fn() } as never,
      { get: () => 'hybrid' } as never,
      { canUseHybrid: jest.fn().mockResolvedValue(false) } as never,
    );

    await expect(
      service.retrieveDetailed('project-1', {
        query: '门禁',
        task_type: 'directory',
      }),
    ).resolves.toMatchObject({
      canonical_path: 'legacy_like',
      shadow_state: 'READY',
      evidence: [],
    });
  });
});
