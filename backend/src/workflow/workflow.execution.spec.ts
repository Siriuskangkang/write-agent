/* eslint-disable @typescript-eslint/unbound-method */
import { randomUUID } from 'node:crypto';
import {
  WorkflowCancelledError,
  WorkflowEngine,
  WorkflowLeaseLostError,
  type ClaimedWorkflowJob,
  type WorkflowExecutionStore,
  type WorkflowTaskContext,
  type WorkflowTaskExecutor,
  type WorkflowExecutionEvent,
  type WorkflowExecutionOutcome,
} from './workflow.engine.js';
import type { ContentService } from '../content/content.service.js';
import type { SealedGroundedCandidateV1 } from '../citation/atomic-grounding/contracts.js';
import {
  WorkflowGenerationExecutor,
  type WorkflowDomainCommitter,
} from './workflow-generation.executor.js';
import { WorkflowType } from './workflow.types.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function claimedJob(
  overrides: Partial<ClaimedWorkflowJob> = {},
): ClaimedWorkflowJob {
  return {
    id: JOB_ID,
    userId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    workflowType: WorkflowType.CONTENT,
    input: { section_node_id: 'section-1' },
    checkpoint: { node: 'generate', output: '已有' },
    leaseToken: randomUUID(),
    fencingToken: 3,
    generationAttempt: 0,
    ...overrides,
  };
}

describe('WorkflowEngine', () => {
  describe('atomic_shadow_complete validation', () => {
    it.each([
      {
        name: 'missing sealed candidate',
        mode: 'shadow_no_persist',
        input: { strict_citation: true },
        candidate: undefined,
        emittedUtf16: 0,
        recovery: 'reject',
      },
      {
        name: 'corrupt current assignment or render dependency',
        mode: 'shadow_no_persist',
        input: { strict_citation: true },
        candidate: completeCandidate('完成正文'),
        emittedUtf16: 4,
        recovery: 'reject',
      },
      {
        name: 'incomplete emitted offset',
        mode: 'shadow_no_persist',
        input: { strict_citation: true },
        candidate: completeCandidate('完成正文'),
        emittedUtf16: 3,
        recovery: 'sealed',
      },
      {
        name: 'mode off',
        mode: 'off',
        input: { strict_citation: true },
        candidate: completeCandidate('完成正文'),
        emittedUtf16: 4,
        recovery: 'sealed',
      },
      {
        name: 'non-strict contract mismatch',
        mode: 'shadow_no_persist',
        input: { strict_citation: false },
        candidate: completeCandidate('完成正文'),
        emittedUtf16: 4,
        recovery: 'sealed',
      },
    ])(
      'fails closed and never completes a $name checkpoint',
      async ({ mode, input, candidate, emittedUtf16, recovery }) => {
        const claim = claimedJob({
          input,
          checkpoint: {
            phase: 'atomic_shadow_complete',
            generation_attempt: 1,
            revision_attempt: 0,
            ...(candidate ? { sealed_candidate: candidate } : {}),
            emitted_utf16: emittedUtf16,
          },
        });
        const store = fakeStore();
        store.claim.mockResolvedValue(claim);
        const recoverAtomicGroundingCandidate =
          recovery === 'sealed'
            ? jest.fn().mockResolvedValue({ kind: 'sealed', candidate })
            : jest.fn().mockRejectedValue(new Error('recovery drift'));
        const engine = new WorkflowEngine(
          store,
          atomicGenerationExecutor({ recoverAtomicGroundingCandidate }, mode),
          { workerId: 'atomic-complete-validator', cancelPollMs: 5 },
        );

        await engine.run(JOB_ID);

        expect(store.complete).not.toHaveBeenCalled();
        expect(store.fail).toHaveBeenCalledTimes(1);
      },
    );

    it('revalidates a complete sealed checkpoint before the engine marks success', async () => {
      const candidate = completeCandidate('完成正文');
      const claim = claimedJob({
        input: { strict_citation: true },
        checkpoint: {
          phase: 'atomic_shadow_complete',
          generation_attempt: 1,
          revision_attempt: 0,
          sealed_candidate: candidate,
          emitted_utf16: candidate.server_output.utf16_length,
        },
      });
      const store = fakeStore();
      store.claim.mockResolvedValue(claim);
      const recoverAtomicGroundingCandidate = jest
        .fn()
        .mockResolvedValue({ kind: 'sealed', candidate });
      const engine = new WorkflowEngine(
        store,
        atomicGenerationExecutor(
          { recoverAtomicGroundingCandidate },
          'shadow_no_persist',
        ),
        { workerId: 'atomic-complete-validator', cancelPollMs: 5 },
      );

      await engine.run(JOB_ID);

      expect(recoverAtomicGroundingCandidate).toHaveBeenCalledWith(
        JOB_ID,
        claim.projectId,
        candidate,
      );
      expect(store.fail).not.toHaveBeenCalled();
      expect(store.complete).toHaveBeenCalledWith(claim);
    });
  });

  it('does nothing when another worker owns the durable lease', async () => {
    const store = fakeStore();
    store.claim.mockResolvedValue(null);
    const executor = fakeExecutor();
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-b',
      cancelPollMs: 5,
    });

    await engine.run(JOB_ID);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('resumes with the persisted checkpoint and fences every progress write', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    const executor = fakeExecutor([
      {
        type: 'token',
        data: { type: 'token', content: '继续' },
        checkpoint: { node: 'generate', output: '已有继续' },
      },
      {
        type: 'done',
        data: { type: 'done', result_id: 'result-1' },
        checkpoint: { node: 'complete', output: '已有继续' },
      },
    ]);
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 5,
    });

    await engine.run(JOB_ID);

    const [executedJob, executionContext] = executor.execute.mock.calls[0];
    expect(executedJob).toMatchObject({
      checkpoint: { node: 'generate', output: '已有' },
    });
    expect(executionContext.signal).toBeInstanceOf(AbortSignal);
    expect(store.persistProgress).toHaveBeenNthCalledWith(
      1,
      claim,
      'token',
      { type: 'token', content: '继续' },
      { node: 'generate', output: '已有继续' },
    );
    expect(store.persistProgress).toHaveBeenNthCalledWith(
      2,
      claim,
      'done',
      { type: 'done', result_id: 'result-1' },
      { node: 'complete', output: '已有继续' },
    );
    expect(store.complete).toHaveBeenCalledWith(claim);
  });

  it('uses the async iterator return outcome to suspend without completing', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    const outcome: WorkflowExecutionOutcome = {
      kind: 'SUSPENDED',
      reason: 'WAITING_APPROVAL',
    };
    const executor: WorkflowTaskExecutor = {
      execute: jest.fn(async function* () {
        await Promise.resolve();
        yield* [];
        return outcome;
      }),
    };
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'authoring-worker',
      cancelPollMs: 5,
    });

    await engine.run(JOB_ID);

    expect(store.suspend).toHaveBeenCalledWith(claim, 'WAITING_APPROVAL');
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('runs the event callback only after its progress write succeeds', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    const afterPersist = jest.fn();
    const progress = jest.fn();
    store.persistProgress.mockImplementation(async () => {
      progress();
      await Promise.resolve();
    });
    const executor = fakeExecutor([
      {
        type: 'token',
        data: { type: 'token', content: '可见' },
        checkpoint: { phase: 'atomic_sealed', emitted_utf16: 2 },
        onPersisted: afterPersist,
      },
    ]);
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 5,
    });

    await engine.run(JOB_ID);

    expect(afterPersist).toHaveBeenCalledTimes(1);
    expect(afterPersist.mock.invocationCallOrder[0]).toBeGreaterThan(
      progress.mock.invocationCallOrder[0],
    );
  });

  it('does not run the event callback when the progress write is fenced', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    store.persistProgress.mockRejectedValue(new WorkflowCancelledError());
    const afterPersist = jest.fn();
    const event: WorkflowExecutionEvent = {
      type: 'token',
      data: { type: 'token', content: '不可见' },
      checkpoint: { phase: 'atomic_sealed', emitted_utf16: 3 },
      onPersisted: afterPersist,
    };
    const engine = new WorkflowEngine(store, fakeExecutor([event]), {
      workerId: 'worker-a',
      cancelPollMs: 5,
    });

    await engine.run(JOB_ID);

    expect(afterPersist).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('aborts a provider stream when durable cancellation is observed', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    store.inspectControl
      .mockResolvedValueOnce('active')
      .mockResolvedValue('cancelled');
    let observedAbort = false;
    const executor: WorkflowTaskExecutor = {
      execute: jest.fn(async function* (
        _job: ClaimedWorkflowJob,
        context: WorkflowTaskContext,
      ) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            observedAbort = true;
            resolve();
            return;
          }
          context.signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw new DOMException('aborted', 'AbortError');
        yield {
          type: 'unreachable',
          data: null,
          checkpoint: {},
        };
      }),
    };
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 1,
    });

    await engine.run(JOB_ID);

    expect(observedAbort).toBe(true);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('never completes after a terminal fence rejects the completion callback', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    store.complete.mockRejectedValue(new WorkflowCancelledError());
    const executor = fakeExecutor([]);
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 5,
    });

    await expect(engine.run(JOB_ID)).resolves.toBeUndefined();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('does not turn a lost lease into a workflow failure', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    store.persistProgress.mockRejectedValue(new WorkflowLeaseLostError());
    const executor = fakeExecutor([
      {
        type: 'token',
        data: { type: 'token', content: 'late worker' },
        checkpoint: { output: 'late worker' },
      },
    ]);
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 5,
    });

    await expect(engine.run(JOB_ID)).resolves.toBeUndefined();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('records an unrelated AbortError as a workflow failure', async () => {
    const claim = claimedJob();
    const store = fakeStore();
    store.claim.mockResolvedValue(claim);
    const executor: WorkflowTaskExecutor = {
      execute: jest.fn(async function* () {
        await Promise.resolve();
        throw new DOMException('provider timeout', 'AbortError');
        yield {
          type: 'unreachable',
          data: null,
          checkpoint: {},
        };
      }),
    };
    const engine = new WorkflowEngine(store, executor, {
      workerId: 'worker-a',
      cancelPollMs: 1,
    });

    await engine.run(JOB_ID);

    expect(store.fail).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({ name: 'AbortError' }),
    );
  });
});

function fakeExecutor(
  events: Array<{
    type: string;
    data: Record<string, unknown> | null;
    checkpoint: Record<string, unknown>;
    onPersisted?: () => void;
  }> = [],
): jest.Mocked<WorkflowTaskExecutor> {
  return {
    execute: jest.fn(async function* () {
      await Promise.resolve();
      for (const event of events) yield event;
    }),
  };
}

function fakeStore(): jest.Mocked<WorkflowExecutionStore> {
  return {
    claim: jest.fn(),
    inspectControl: jest.fn().mockResolvedValue('active'),
    persistProgress: jest.fn(),
    suspend: jest.fn(),
    complete: jest.fn(),
    fail: jest.fn(),
  };
}

function atomicGenerationExecutor(
  content: Record<string, unknown>,
  mode: string,
): WorkflowGenerationExecutor {
  const domainCommitter: jest.Mocked<WorkflowDomainCommitter> = {
    commit: jest.fn().mockResolvedValue({ resourceId: 'forbidden' }),
    findCommitted: jest.fn().mockResolvedValue(null),
  };
  return new WorkflowGenerationExecutor(
    content as unknown as ContentService,
    domainCommitter,
    { get: () => mode } as never,
  );
}

function completeCandidate(text: string): SealedGroundedCandidateV1 {
  return {
    envelope_version: 'sealed-grounded-candidate.v1',
    contract_version: 'atomic:v1',
    schema_version: 'grounded-draft.v1',
    canonical_json_version: 'canonical-json.v1',
    canonicalizer_version: 'atomic-canonicalizer.v1',
    quantity_lexer_version: 'quantity-lexer.v1',
    plain_text_escape_version: 'escape-plain-text.v1',
    renderer_version: 'atomic-renderer.v1',
    verifier_version: 'atomic-verifier.v1',
    workflow: {
      workflow_job_id: JOB_ID,
      project_id: '33333333-3333-4333-8333-333333333333',
      workflow_type: 'content',
      generation_attempt: 1,
      revision_attempt: 0,
    },
    canonical_proposal: {
      schema_version: 'grounded-draft.v1',
      status: 'draft',
      claims: [],
      render_fragments: [],
      ordering: [],
      material_gap: null,
    },
    render_context: {
      context_version: 'approved-render-context.v1',
      entries: [],
    },
    server_output: {
      text,
      utf8_byte_length: Buffer.byteLength(text, 'utf8'),
      utf16_length: text.length,
    },
    claims: [],
    evidence_snapshots: [],
    digests: {
      proposal_digest: '1'.repeat(64),
      render_context_digest: '2'.repeat(64),
      render_digest: '3'.repeat(64),
      assignment_digest: '4'.repeat(64),
      ledger_digest: '5'.repeat(64),
      envelope_digest: '6'.repeat(64),
    },
  };
}
