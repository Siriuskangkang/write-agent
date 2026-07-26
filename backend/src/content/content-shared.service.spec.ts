import { ContentSharedService } from './content-shared.service.js';

describe('ContentSharedService atomic revision retrieval', () => {
  it('compacts many unsupported claims to the retrieval query contract', async () => {
    const retrievalService = {
      retrieveEvidenceSnapshot: jest.fn().mockResolvedValue({
        run_id: 'revision-run-1',
        state: 'READY',
        error_code: null,
        error_message: null,
        evidence: [],
        used_tokens: 0,
      }),
    };
    const groundingStore = {
      replaceEvidenceAfterTargetedRetrieval: jest.fn(),
    };
    const service = new ContentSharedService(
      {} as never,
      retrievalService as never,
      {} as never,
      groundingStore as never,
    );
    const claims = Array.from({ length: 30 }, (_, index) => ({
      claim_id: `claim-${index}`,
      claim_text: `第${index + 1}条人工智能基础数据服务声明${'需要核实的详细内容'.repeat(20)}`,
    }));

    await service.retrieveRevisionGroundingMaterials(
      'project-1',
      'job-1',
      claims,
      new AbortController().signal,
    );

    const retrievalCalls = retrievalService.retrieveEvidenceSnapshot.mock
      .calls as unknown as Array<[string, { query: string }, unknown]>;
    const request = retrievalCalls[0]?.[1];
    expect(request).toBeDefined();
    if (!request) throw new Error('missing retrieval request');
    expect(request.query.length).toBeGreaterThan(0);
    expect(request.query.length).toBeLessThanOrEqual(500);
  });

  it('binds retries to the same workflow revision retrieval operation', async () => {
    const result = {
      run_id: 'revision-run-1',
      state: 'READY',
      error_code: null,
      error_message: null,
      evidence: [],
      used_tokens: 0,
    } as const;
    const retrievalService = {
      retrieveEvidenceSnapshot: jest.fn().mockResolvedValue(result),
    };
    const groundingStore = {
      loadAssignment: jest.fn().mockResolvedValue({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'base-run-1',
        targeted_revision_attempts: 1,
      }),
      replaceEvidenceAfterTargetedRetrieval: jest
        .fn()
        .mockRejectedValueOnce(
          new Error('simulated crash before assignment replacement'),
        )
        .mockResolvedValueOnce(undefined),
    };
    const service = new ContentSharedService(
      {} as never,
      retrievalService as never,
      {} as never,
      groundingStore as never,
    );
    const input = [{ claim_id: 'candidate-key-1', claim_text: '待修订声明' }];

    await expect(
      service.retrieveRevisionGroundingMaterials(
        'project-1',
        'job-1',
        input,
        new AbortController().signal,
        'base-run-1',
      ),
    ).rejects.toThrow('simulated crash');
    await service.retrieveRevisionGroundingMaterials(
      'project-1',
      'job-1',
      input,
      new AbortController().signal,
      'base-run-1',
    );

    expect(retrievalService.retrieveEvidenceSnapshot).toHaveBeenCalledTimes(2);
    const retrievalCalls = retrievalService.retrieveEvidenceSnapshot.mock
      .calls as unknown as Array<[string, unknown, unknown]>;
    for (const call of retrievalCalls) {
      expect(call[2]).toEqual({
        workflow_job_id: 'job-1',
        revision_attempt: 1,
      });
    }
    expect(
      groundingStore.replaceEvidenceAfterTargetedRetrieval,
    ).toHaveBeenCalledTimes(2);
    expect(
      groundingStore.replaceEvidenceAfterTargetedRetrieval,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ retrieval_run_id: 'revision-run-1' }),
    );
  });
});
