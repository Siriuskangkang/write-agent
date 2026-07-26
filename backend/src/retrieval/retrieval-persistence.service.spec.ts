import { RetrievalPersistenceService } from './retrieval-persistence.service.js';

describe('RetrievalPersistenceService terminalization', () => {
  it('best-effort terminalizes RUNNING when transactional candidate persistence fails', async () => {
    const update = jest
      .fn<
        Promise<{ affected: number }>,
        [Record<string, unknown>, Record<string, unknown>]
      >()
      .mockResolvedValue({ affected: 1 });
    const runRepository = {
      update,
    };
    const service = new RetrievalPersistenceService(
      runRepository as never,
      {} as never,
      {} as never,
      {
        transaction: jest
          .fn()
          .mockRejectedValue(new Error('candidate insert failed')),
      } as never,
      {
        get: (_key: string, fallback?: unknown) => fallback,
      } as never,
    );

    await expect(
      service.complete('run-1', {
        state: 'READY',
        error_code: null,
        error_message: null,
        latency_ms: 10,
        sparse_count: 1,
        dense_count: 1,
        fused_count: 1,
        legacy_count: 1,
        selected_count: 1,
        embedding_cost_usd: null,
        embedding_input_tokens: null,
        embedding_estimated_cost_usd: null,
        embedding_estimated_input_tokens: null,
        embedding_usage_estimated: false,
        index_versions: [],
        canonical_state: 'READY',
        canonical_latency_ms: 5,
        canonical_count: 1,
        canonical_error_code: null,
        canonical_error_message: null,
        shadow_state: 'READY',
        shadow_latency_ms: 5,
        shadow_count: 1,
        shadow_error_code: null,
        shadow_error_message: null,
        candidates: [],
        evidence: [],
      }),
    ).rejects.toThrow('candidate insert failed');
    expect(update).toHaveBeenCalledTimes(1);
    const [criteria, values] = update.mock.calls[0];
    expect(criteria).toEqual({ id: 'run-1', state: 'RUNNING' });
    expect(values).toMatchObject({
      state: 'ERROR',
      error_code: 'RUN_PERSISTENCE_FAILED',
    });
    expect(values.completed_at).toBeInstanceOf(Date);
  });
});
