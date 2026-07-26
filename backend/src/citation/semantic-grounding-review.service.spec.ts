import { SemanticGroundingReviewService } from './semantic-grounding-review.service.js';

describe('SemanticGroundingReviewService', () => {
  it('uses one structured temperature-zero call with bounded retries and tokens', async () => {
    const gateway = {
      estimateWorstCaseCost: jest.fn().mockReturnValue('0.005000'),
      calculateUsageCost: jest.fn().mockReturnValue('0.000900'),
      complete: jest.fn().mockResolvedValue({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        structured_output: {
          reviews: [
            {
              claim_index: 0,
              support_status: 'SUPPORTED',
              support_score: 0.9,
            },
          ],
        },
      }),
    };
    const config = {
      get: (_key: string, fallback: unknown) => fallback,
    };
    const service = new SemanticGroundingReviewService(
      gateway as never,
      config as never,
    );

    await expect(
      service.review({
        workflow_job_id: 'job-1',
        claims: [
          {
            claim_index: 0,
            claim_text: '装机容量为三百兆瓦',
            evidence_text: '装机容量为 300 MW',
          },
        ],
      }),
    ).resolves.toEqual([
      {
        claim_index: 0,
        support_status: 'SUPPORTED',
        support_score: 0.9,
      },
    ]);
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(gateway.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        response_mode: 'structured',
        temperature: 0,
        max_tokens: 1_200,
        max_retries: 0,
        max_repair_attempts: 0,
        timeout_ms: 30_000,
        trace: {
          workflow_job_id: 'job-1',
          node: 'grounding_semantic_review',
          attempt: 1,
        },
      }),
    );
  });

  it('does not call a model when the semantic-review budget is disabled', async () => {
    const gateway = {
      estimateWorstCaseCost: jest.fn().mockReturnValue('0.005000'),
      calculateUsageCost: jest.fn(),
      complete: jest.fn(),
    };
    const config = {
      get: (key: string, fallback: unknown) =>
        key === 'GROUNDING_SEMANTIC_REVIEW_ENABLED' ? 'false' : fallback,
    };
    const service = new SemanticGroundingReviewService(
      gateway as never,
      config as never,
    );

    await expect(
      service.review({
        workflow_job_id: 'job-1',
        claims: [],
      }),
    ).resolves.toEqual([]);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown pricing', null],
    ['worst-case cost over budget', '0.010001'],
  ])('does not call a model for %s', async (_label, estimatedCost) => {
    const gateway = {
      estimateWorstCaseCost: jest.fn().mockReturnValue(estimatedCost),
      calculateUsageCost: jest.fn(),
      complete: jest.fn(),
    };
    const config = {
      get: (key: string, fallback: unknown) =>
        key === 'GROUNDING_SEMANTIC_REVIEW_MAX_COST_USD' ? 0.01 : fallback,
    };
    const service = new SemanticGroundingReviewService(
      gateway as never,
      config as never,
    );

    await expect(
      service.review({
        workflow_job_id: 'job-1',
        claims: [
          {
            claim_index: 0,
            claim_text: '声明',
            evidence_text: '证据',
          },
        ],
      }),
    ).resolves.toEqual([]);
    expect(gateway.complete).not.toHaveBeenCalled();
  });

  it('does not release a semantic verdict when metered usage exceeds budget', async () => {
    const gateway = {
      estimateWorstCaseCost: jest.fn().mockReturnValue('0.005000'),
      calculateUsageCost: jest.fn().mockReturnValue('0.010001'),
      complete: jest.fn().mockResolvedValue({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
        structured_output: {
          reviews: [
            {
              claim_index: 0,
              support_status: 'SUPPORTED',
              support_score: 1,
            },
          ],
        },
      }),
    };
    const config = {
      get: (key: string, fallback: unknown) =>
        key === 'GROUNDING_SEMANTIC_REVIEW_MAX_COST_USD' ? 0.01 : fallback,
    };
    const service = new SemanticGroundingReviewService(
      gateway as never,
      config as never,
    );

    await expect(
      service.review({
        workflow_job_id: 'job-1',
        claims: [
          {
            claim_index: 0,
            claim_text: '声明',
            evidence_text: '证据',
          },
        ],
      }),
    ).resolves.toEqual([]);
  });
});
