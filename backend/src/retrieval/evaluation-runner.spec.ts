import {
  MysqlQdrantEvaluationPipeline,
  ProductionEvaluationPipeline,
  runEvaluation,
  signEvaluationPayload,
} from './evaluation-runner.js';

describe('runEvaluation', () => {
  it('executes ingestion and both pipelines from corpus plus independent judgments', async () => {
    const pipeline = {
      source: 'mysql-qdrant-production-v1' as const,
      ingest: jest.fn().mockResolvedValue(undefined),
      retrieveLegacy: jest.fn().mockResolvedValue({
        ranked_chunk_ids: ['a'],
        latency_ms: 10,
        cost_usd: 0,
      }),
      retrieveHybrid: jest.fn().mockResolvedValue({
        ranked_chunk_ids: ['a', 'b'],
        sparse_ranked_chunk_ids: ['a'],
        dense_ranked_chunk_ids: ['b', 'a'],
        latency_ms: 30,
        cost_usd: 0.001,
      }),
    };
    const dataset = {
      dataset: 'fixture',
      k: 3,
      corpus: [
        { chunk_id: 'a', file_id: 'f1', content: '闭环控制' },
        { chunk_id: 'b', file_id: 'f2', content: '位置检测' },
      ],
      judgments: [
        {
          id: 'sample-1',
          query: '闭环控制位置检测',
          relevant_chunk_ids: ['a', 'b'],
        },
      ],
    };

    const report = await runEvaluation(
      dataset,
      pipeline,
      { max_latency_p95_ms: 50 },
      binding(),
    );

    expect(pipeline.ingest).toHaveBeenCalledWith(dataset.corpus);
    expect(pipeline.retrieveLegacy).toHaveBeenCalledWith('闭环控制位置检测', 3);
    expect(pipeline.retrieveHybrid).toHaveBeenCalledWith('闭环控制位置检测', 3);
    expect(report).toMatchObject({
      schema_version: 'rag-eval-v2',
      source: 'mysql-qdrant-production-v1',
      sample_count: 1,
      positive_judgment_count: 2,
      traces: [
        {
          sample_id: 'sample-1',
          legacy: { ranked_chunk_ids: ['a'] },
          hybrid: {
            ranked_chunk_ids: ['a', 'b'],
            sparse_ranked_chunk_ids: ['a'],
            dense_ranked_chunk_ids: ['b', 'a'],
          },
        },
      ],
      gate_observation: { passed: true },
    });
  });

  it('fails before ingestion when any judgment has no relevant corpus chunk', async () => {
    const pipeline = {
      source: 'mysql-qdrant-production-v1' as const,
      ingest: jest.fn(),
      retrieveLegacy: jest.fn(),
      retrieveHybrid: jest.fn(),
    };

    await expect(
      runEvaluation(
        {
          dataset: 'empty-judgment',
          k: 3,
          corpus: [{ chunk_id: 'a', file_id: 'f1', content: '闭环控制' }],
          judgments: [
            {
              id: 'sample-1',
              query: '闭环控制',
              relevant_chunk_ids: [],
            },
          ],
        },
        pipeline,
        { max_latency_p95_ms: 50 },
        binding(),
      ),
    ).rejects.toThrow('at least one relevant chunk');
    expect(pipeline.ingest).not.toHaveBeenCalled();
  });

  it('fails before ingestion when the dataset has fewer positive judgments than the configured threshold', async () => {
    const pipeline = {
      source: 'mysql-qdrant-production-v1' as const,
      ingest: jest.fn(),
      retrieveLegacy: jest.fn(),
      retrieveHybrid: jest.fn(),
    };

    await expect(
      runEvaluation(
        {
          dataset: 'too-few-positives',
          k: 3,
          corpus: [
            { chunk_id: 'a', file_id: 'f1', content: '闭环控制' },
            { chunk_id: 'b', file_id: 'f2', content: '位置检测' },
          ],
          judgments: [
            {
              id: 'sample-1',
              query: '闭环控制',
              relevant_chunk_ids: ['a'],
            },
            {
              id: 'sample-2',
              query: '位置检测',
              relevant_chunk_ids: ['b'],
            },
          ],
        },
        pipeline,
        {
          max_latency_p95_ms: 50,
          min_positive_judgments: 3,
        } as never,
        binding(),
      ),
    ).rejects.toThrow('positive relevance judgments');
    expect(pipeline.ingest).not.toHaveBeenCalled();
  });

  it('production evaluator derives rankings instead of reading them from fixtures', async () => {
    const pipeline = new ProductionEvaluationPipeline(32);
    const report = await runEvaluation(
      {
        dataset: 'actual',
        k: 2,
        corpus: [
          {
            chunk_id: 'relevant',
            file_id: 'f1',
            content: '闭环控制使用位置检测反馈误差',
          },
          {
            chunk_id: 'noise',
            file_id: 'f2',
            content: '餐饮服务卫生规范',
          },
        ],
        judgments: [
          {
            id: 'q1',
            query: '闭环控制位置检测',
            relevant_chunk_ids: ['relevant'],
          },
        ],
      },
      pipeline,
      { max_latency_p95_ms: 500 },
      binding(),
    );

    expect(report.traces[0]?.hybrid.ranked_chunk_ids[0]).toBe('relevant');
  });

  it('production MySQL+Qdrant evaluation uses the same HybridRetriever orchestration as online retrieval', async () => {
    const indexer = { replaceCorpus: jest.fn().mockResolvedValue(undefined) };
    const hybrid = {
      retrieve: jest.fn().mockResolvedValue({
        state: 'READY',
        evidence: [{ chunk_id: 'hybrid-a' }],
        sparse_ranked_chunk_ids: ['sparse-a'],
        dense_ranked_chunk_ids: ['dense-a'],
        embedding_cost_usd: '0.00001000',
      }),
    };
    const legacy = {
      search: jest.fn().mockResolvedValue([{ chunk_id: 'legacy-a' }]),
    };
    const pipeline = new MysqlQdrantEvaluationPipeline(
      'evaluation-project',
      indexer,
      hybrid as never,
      legacy as never,
    );

    await pipeline.ingest([
      { chunk_id: 'hybrid-a', file_id: 'file-a', content: '闭环控制' },
    ]);
    const result = await pipeline.retrieveHybrid('闭环控制', 8);

    expect(hybrid.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'evaluation-project',
        query: '闭环控制',
        top_k: 8,
        mode: 'hybrid',
        gate_decision: true,
      }),
    );
    expect(result).toMatchObject({
      ranked_chunk_ids: ['hybrid-a'],
      sparse_ranked_chunk_ids: ['sparse-a'],
      dense_ranked_chunk_ids: ['dense-a'],
      cost_usd: 0.00001,
    });
  });

  it('signs the immutable payload rather than trusting its gate observation', () => {
    const signed = signEvaluationPayload(
      { schema_version: 'rag-eval-v2', gate_observation: { passed: true } },
      'a-secure-evaluation-secret-that-is-long-enough',
    );
    expect(signed.signature).toMatch(/^[a-f0-9]{64}$/);
  });
});

function binding() {
  return {
    code_commit: 'abcdef123456',
    index_version: 'rag-v1',
    collection_name: 'chunks',
    embedding_model: 'fixture-embedding',
    embedding_dimension: 32,
    retrieval_config_hash: 'c'.repeat(64),
    generated_at: '2026-07-25T00:00:00.000Z',
    expires_at: '2026-08-25T00:00:00.000Z',
  };
}
