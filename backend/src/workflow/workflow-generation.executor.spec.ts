/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import type { ContentService } from '../content/content.service.js';
import type { AtomicGroundingOutcome } from '../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import type { AtomicGroundingMetricsRecorder } from '../citation/atomic-grounding/atomic-grounding.metrics.js';
import type { SealedGroundedCandidateV1 } from '../citation/atomic-grounding/contracts.js';
import type { ModelOperationIdentity } from '../llm/model-types.js';
import {
  WorkflowGenerationExecutor,
  parseGeneratedDirectory,
  type WorkflowDomainCommitter,
} from './workflow-generation.executor.js';
import type {
  ClaimedWorkflowJob,
  WorkflowExecutionEvent,
} from './workflow.engine.js';
import { WorkflowType } from './workflow.types.js';

describe('WorkflowGenerationExecutor', () => {
  describe('atomic shadow runtime', () => {
    it.each([WorkflowType.DIRECTORY, WorkflowType.OUTLINE])(
      'fails closed for atomic checkpoints forged onto non-content workflow %s',
      async (workflowType) => {
        const contentService = {
          generateDirectory: jest.fn(),
          generateOutline: jest.fn(),
          generateWorkflowText: jest.fn(),
        };
        const domainCommitter = committer({ resourceId: 'forbidden' });
        const executor = atomicExecutor(
          contentService,
          domainCommitter,
          'shadow_no_persist',
        );

        await expect(
          collect(
            executor.execute(
              job(
                workflowType,
                {},
                {
                  phase: 'atomic_sealed',
                  generation_attempt: 1,
                  revision_attempt: 0,
                  sealed_candidate: sealedCandidate('forged'),
                },
              ),
              { signal: new AbortController().signal },
            ),
          ),
        ).rejects.toMatchObject({
          disposition: { internal_reason: 'ENVELOPE_INVALID' },
        });
        expect(contentService.generateDirectory).not.toHaveBeenCalled();
        expect(contentService.generateOutline).not.toHaveBeenCalled();
        expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
        expect(domainCommitter.findCommitted).not.toHaveBeenCalled();
        expect(domainCommitter.commit).not.toHaveBeenCalled();
      },
    );

    it.each([
      'atomic_revision_required',
      'atomic_revision_retrieved',
      'atomic_sealed',
      'atomic_shadow_complete',
    ] as const)(
      'never routes %s through legacy commit when strictness is false, missing, or forged',
      async (phase) => {
        for (const strictness of [false, undefined, 'false']) {
          const contentService = {
            generateWorkflowText: jest.fn(),
            generateAtomicGroundingCandidate: jest.fn(),
            recoverAtomicGroundingCandidate: jest.fn(),
            prepareGroundingRevision: jest.fn(),
          };
          const domainCommitter = committer({ resourceId: 'forbidden' });
          const executor = atomicExecutor(
            contentService,
            domainCommitter,
            'off',
          );
          const input =
            strictness === undefined
              ? {}
              : { strict_citation: strictness as unknown };

          await collectSettled(
            executor.execute(
              job(WorkflowType.CONTENT, input, {
                phase,
                generation_attempt: 1,
                revision_attempt: phase.startsWith('atomic_revision') ? 1 : 0,
                canonical_proposal: {
                  schema_version: 'grounded-draft.v1',
                  status: 'draft',
                  claims: [],
                  render_fragments: [],
                  ordering: [],
                  material_gap: null,
                },
                candidate_claim_keys: ['candidate-key-1'],
                source_claim_texts: ['声明'],
                reason_codes: ['ATOM_EXACT_MISMATCH'],
                non_target_invariant_digests: { stable: 'a'.repeat(64) },
                sealed_candidate: sealedCandidate('不得进入 legacy'),
              }),
              { signal: new AbortController().signal },
            ),
          );

          expect(domainCommitter.findCommitted).not.toHaveBeenCalled();
          expect(domainCommitter.commit).not.toHaveBeenCalled();
          expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      {
        label: 'missing explicit strict contract',
        input: {},
        generationAttempt: 1,
        revisionAttempt: 0,
        candidate: sealedCandidate('已完成'),
        expectedReason: 'ASSIGNMENT_CONTRACT_MISMATCH',
      },
      {
        label: 'missing sealed candidate',
        input: { strict_citation: true },
        generationAttempt: 1,
        revisionAttempt: 0,
        candidate: undefined,
        expectedReason: 'ASSIGNMENT_CONTRACT_MISMATCH',
      },
      {
        label: 'forged generation envelope',
        input: { strict_citation: true },
        generationAttempt: 2,
        revisionAttempt: 0,
        candidate: sealedCandidate('已完成'),
        expectedReason: 'ENVELOPE_INVALID',
      },
      {
        label: 'forged revision envelope',
        input: { strict_citation: true },
        generationAttempt: 1,
        revisionAttempt: 1,
        candidate: sealedCandidate('已完成'),
        expectedReason: 'ENVELOPE_INVALID',
      },
    ])(
      'fails a completed checkpoint closed for $label',
      async ({
        input,
        generationAttempt,
        revisionAttempt,
        candidate,
        expectedReason,
      }) => {
        const contentService = {
          recoverAtomicGroundingCandidate: jest
            .fn()
            .mockResolvedValue({ kind: 'sealed', candidate }),
        };
        const domainCommitter = committer({ resourceId: 'forbidden' });
        const executor = atomicExecutor(
          contentService,
          domainCommitter,
          'shadow_no_persist',
        );

        await expect(
          collect(
            executor.execute(
              job(WorkflowType.CONTENT, input, {
                phase: 'atomic_shadow_complete',
                generation_attempt: generationAttempt,
                revision_attempt: revisionAttempt,
                emitted_utf16: candidate?.server_output.text.length ?? 0,
                sealed_candidate: candidate,
              }),
              { signal: new AbortController().signal },
            ),
          ),
        ).rejects.toMatchObject({
          disposition: { internal_reason: expectedReason },
        });
        expect(domainCommitter.commit).not.toHaveBeenCalled();
      },
    );

    it('revalidates a complete checkpoint through sealed recovery before returning success', async () => {
      const candidate = sealedCandidate('已完整发出');
      const contentService = {
        recoverAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
        generateAtomicGroundingCandidate: jest.fn(),
        generateWorkflowText: jest.fn(),
      };
      const domainCommitter = committer({ resourceId: 'forbidden' });
      const claim = job(
        WorkflowType.CONTENT,
        { strict_citation: true },
        {
          phase: 'atomic_shadow_complete',
          generation_attempt: 1,
          revision_attempt: 0,
          emitted_utf16: candidate.server_output.text.length,
          sealed_candidate: candidate,
        },
      );
      const executor = atomicExecutor(
        contentService,
        domainCommitter,
        'shadow_no_persist',
      );

      await expect(
        collect(
          executor.execute(claim, {
            signal: new AbortController().signal,
          }),
        ),
      ).resolves.toEqual([]);
      expect(
        contentService.recoverAtomicGroundingCandidate,
      ).toHaveBeenCalledWith(claim.id, claim.projectId, candidate);
      expect(
        contentService.generateAtomicGroundingCandidate,
      ).not.toHaveBeenCalled();
      expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
      expect(domainCommitter.commit).not.toHaveBeenCalled();
    });

    it.each([
      WorkflowType.CONTENT,
      WorkflowType.REWRITE,
      WorkflowType.EXPAND,
      WorkflowType.COMPRESS,
    ])(
      'falls strict %s back to the legacy contract while atomic mode is off',
      async (workflowType) => {
        const contentService = {
          generateWorkflowText: jest.fn(async function* () {
            await Promise.resolve();
            yield 'legacy strict output';
          }),
          generateAtomicGroundingCandidate: jest.fn(),
        };
        const domainCommitter = committer({ resourceId: 'legacy-result' });
        const claim = job(workflowType, {
          strict_citation: true,
          result_id: 'result-1',
        });
        const executor = atomicExecutor(contentService, domainCommitter, 'off');

        const events = await collect(
          executor.execute(claim, {
            signal: new AbortController().signal,
          }),
        );

        expect(contentService.generateWorkflowText).toHaveBeenCalledTimes(1);
        expect(
          contentService.generateAtomicGroundingCandidate,
        ).not.toHaveBeenCalled();
        expect(domainCommitter.commit).toHaveBeenCalledWith(
          expect.objectContaining({
            id: claim.id,
            input: expect.objectContaining({ strict_citation: false }),
          }),
          {
            contract_version: 'legacy:v0',
            output: 'legacy strict output',
          },
        );
        expect(events.at(-1)?.data).toMatchObject({ server_saved: true });
      },
    );

    it('keeps explicit non-strict content on the legacy commit contract', async () => {
      const contentService = {
        generateWorkflowText: jest.fn(async function* () {
          await Promise.resolve();
          yield 'legacy';
        }),
        generateAtomicGroundingCandidate: jest.fn(),
      };
      const domainCommitter = committer({ resourceId: 'legacy-result' });
      const claim = job(WorkflowType.CONTENT, { strict_citation: false });
      const executor = atomicExecutor(contentService, domainCommitter, 'off');

      const events = await collect(
        executor.execute(claim, {
          signal: new AbortController().signal,
        }),
      );

      expect(contentService.generateWorkflowText).toHaveBeenCalledTimes(1);
      expect(
        contentService.generateAtomicGroundingCandidate,
      ).not.toHaveBeenCalled();
      expect(domainCommitter.commit).toHaveBeenCalledWith(claim, {
        contract_version: 'legacy:v0',
        output: 'legacy',
      });
      expect(events.at(-1)?.data).toMatchObject({ server_saved: true });
    });

    it('streams only fixed-size sealed server bytes and completes without persistence', async () => {
      const text = `${'😀证据正文'.repeat(3000)}终`;
      const candidate = sealedCandidate(text);
      const contentService = {
        generateWorkflowText: jest.fn(),
        generateAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
      };
      const domainCommitter = committer({ resourceId: 'must-not-exist' });
      const metrics = metricRecorder();
      const claim = job(WorkflowType.CONTENT, { strict_citation: true });
      const executor = atomicExecutor(
        contentService,
        domainCommitter,
        'shadow_no_persist',
        metrics,
      );

      const events: WorkflowExecutionEvent[] = [];
      const tokenObserved = jest.fn();
      for await (const generated of executor.execute(claim, {
        signal: new AbortController().signal,
      })) {
        events.push(generated);
        if (generated.type === 'token') {
          tokenObserved();
          (
            generated as WorkflowExecutionEvent & {
              onPersisted?: () => void;
            }
          ).onPersisted?.();
        }
      }
      const tokens = events.filter((item) => item.type === 'token');

      expect(tokens.map((item) => item.data?.content).join('')).toBe(text);
      expect(
        tokens.every(
          (item) =>
            Buffer.byteLength(String(item.data?.content), 'utf8') <= 16 * 1024,
        ),
      ).toBe(true);
      expect(events.map((item) => item.type)).toEqual([
        'meta',
        'grounding.proposal_validated',
        ...tokens.map(() => 'token'),
        'done',
      ]);
      expect(events[1].checkpoint).toEqual({
        phase: 'atomic_sealed',
        generation_attempt: 1,
        revision_attempt: 0,
        sealed_candidate: candidate,
      });
      expect(JSON.stringify(events[1].checkpoint)).not.toContain(
        'provider_raw_output',
      );
      expect(events[1].checkpoint).not.toHaveProperty('output');
      expect(events.at(-1)).toMatchObject({
        data: {
          type: 'done',
          result_id: claim.id,
          workflow_job_id: claim.id,
          status: 'succeeded',
          server_saved: false,
          citations: [],
        },
        checkpoint: {
          phase: 'atomic_shadow_complete',
          sealed_candidate: candidate,
        },
      });
      expect(domainCommitter.commit).not.toHaveBeenCalled();
      expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
      expect(metrics.firstRenderedToken).toHaveBeenCalledTimes(1);
      expect(metrics.firstRenderedToken).toHaveBeenCalledWith(
        WorkflowType.CONTENT,
        expect.any(Number),
      );
      expect(
        metrics.firstRenderedToken.mock.invocationCallOrder[0],
      ).toBeGreaterThan(tokenObserved.mock.invocationCallOrder[0]);
    });

    it('recovers an atomic_sealed checkpoint with zero model calls and re-emits identical bytes', async () => {
      const candidate = sealedCandidate('崩溃后恢复😀');
      const contentService = {
        generateWorkflowText: jest.fn(),
        generateAtomicGroundingCandidate: jest.fn(),
        recoverAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
      };
      const domainCommitter = committer({ resourceId: 'must-not-exist' });
      const metrics = metricRecorder();
      const claim = job(
        WorkflowType.CONTENT,
        { strict_citation: true },
        {
          phase: 'atomic_sealed',
          generation_attempt: 1,
          revision_attempt: 0,
          sealed_candidate: candidate,
        },
      );
      const executor = atomicExecutor(
        contentService,
        domainCommitter,
        'shadow_no_persist',
        metrics,
      );

      const events = await collectPersisted(
        executor.execute(claim, {
          signal: new AbortController().signal,
        }),
      );

      expect(events.filter((item) => item.type === 'token')).toHaveLength(1);
      expect(
        events
          .filter((item) => item.type === 'token')
          .map((item) => item.data?.content)
          .join(''),
      ).toBe(candidate.server_output.text);
      expect(
        contentService.recoverAtomicGroundingCandidate,
      ).toHaveBeenCalledWith(claim.id, claim.projectId, candidate);
      expect(
        contentService.generateAtomicGroundingCandidate,
      ).not.toHaveBeenCalled();
      expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
      expect(domainCommitter.commit).not.toHaveBeenCalled();
      expect(metrics.firstRenderedToken).toHaveBeenCalledTimes(1);
      expect(metrics.firstRenderedToken).toHaveBeenCalledWith(
        WorkflowType.CONTENT,
        expect.any(Number),
      );
    });

    it('resumes after a persisted token from its code-point-safe UTF-16 offset without duplicating the prefix', async () => {
      const text = `${'证据😀'.repeat(7000)}尾`;
      const candidate = sealedCandidate(text);
      const contentService = {
        generateWorkflowText: jest.fn(),
        generateAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
        recoverAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
      };
      const executor = atomicExecutor(
        contentService,
        committer({ resourceId: 'forbidden' }),
        'shadow_no_persist',
      );
      const initial = executor
        .execute(job(WorkflowType.CONTENT, { strict_citation: true }), {
          signal: new AbortController().signal,
        })
        [Symbol.asyncIterator]();
      await initial.next();
      await initial.next();
      const firstTokenEvent = requireGeneratedEvent(await initial.next());
      expect(firstTokenEvent.type).toBe('token');
      const prefix = String(firstTokenEvent.data?.content);
      expect(firstTokenEvent.checkpoint).toMatchObject({
        phase: 'atomic_sealed',
        emitted_utf16: prefix.length,
      });
      expect(text.slice(0, prefix.length)).toBe(prefix);
      await initial.return?.();

      const resumed = await collect(
        executor.execute(
          job(
            WorkflowType.CONTENT,
            { strict_citation: true },
            firstTokenEvent.checkpoint,
          ),
          { signal: new AbortController().signal },
        ),
      );
      const suffix = resumed
        .filter((item) => item.type === 'token')
        .map((item) => item.data?.content)
        .join('');

      expect(prefix + suffix).toBe(text);
      expect(suffix).toBe(text.slice(prefix.length));
    });

    it('records TTFT only from the first token persisted callback', async () => {
      const candidate = sealedCandidate('成功持久化后才记录');
      const metrics = metricRecorder();
      const executor = atomicExecutor(
        {
          generateWorkflowText: jest.fn(),
          generateAtomicGroundingCandidate: jest
            .fn()
            .mockResolvedValue({ kind: 'sealed', candidate }),
        },
        committer({ resourceId: 'forbidden' }),
        'shadow_no_persist',
        metrics,
      );
      const iterator = executor
        .execute(job(WorkflowType.CONTENT, { strict_citation: true }), {
          signal: new AbortController().signal,
        })
        [Symbol.asyncIterator]();
      await iterator.next();
      await iterator.next();
      const token = requireGeneratedEvent(
        await iterator.next(),
      ) as WorkflowExecutionEvent & { onPersisted?: () => void };

      expect(token.type).toBe('token');
      expect(metrics.firstRenderedToken).not.toHaveBeenCalled();
      expect(token.onPersisted).toEqual(expect.any(Function));
      token.onPersisted?.();
      expect(metrics.firstRenderedToken).toHaveBeenCalledTimes(1);
      token.onPersisted?.();
      expect(metrics.firstRenderedToken).toHaveBeenCalledTimes(1);
      await iterator.return?.();
    });

    it('does not emit token or done when sealed recovery detects drift', async () => {
      const candidate = sealedCandidate('must not render');
      const contentService = {
        generateWorkflowText: jest.fn(),
        generateAtomicGroundingCandidate: jest.fn(),
        recoverAtomicGroundingCandidate: jest.fn().mockResolvedValue({
          kind: 'material_gap',
          reason_code: 'RECOVERY_ASSIGNMENT_DRIFT',
          candidate_claim_keys: ['candidate-key-1'],
        }),
      };
      const executor = atomicExecutor(
        contentService,
        committer({ resourceId: 'must-not-exist' }),
        'shadow_no_persist',
      );
      const events: WorkflowExecutionEvent[] = [];

      await expect(async () => {
        for await (const generated of executor.execute(
          job(
            WorkflowType.CONTENT,
            { strict_citation: true },
            {
              phase: 'atomic_sealed',
              generation_attempt: 1,
              revision_attempt: 0,
              sealed_candidate: candidate,
            },
          ),
          { signal: new AbortController().signal },
        )) {
          events.push(generated);
        }
      }).rejects.toMatchObject({
        disposition: {
          internal_reason: 'RECOVERY_ASSIGNMENT_DRIFT',
          public_code: 'MATERIAL_GAP',
          transition: 'WAITING_MATERIAL',
        },
        candidateClaimKeys: ['candidate-key-1'],
      });
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'token' }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'done' }),
      );
    });

    it('performs at most one targeted structured revision and seals the revised candidate', async () => {
      const candidate = sealedCandidate('修订后正文', 1);
      const revision: AtomicGroundingOutcome = {
        kind: 'revision_required',
        canonical_proposal: {
          schema_version: 'grounded-draft.v1',
          status: 'draft',
          claims: [],
          render_fragments: [],
          ordering: [],
          material_gap: null,
        },
        unsupported_claims: [
          {
            candidate_claim_key: 'candidate-key-1',
            source_claim_text_nfc: '需要修订的声明',
            reason_code: 'ATOM_EXACT_MISMATCH',
          },
        ],
        non_target_invariant_digests: {
          stable: 'a'.repeat(64),
        },
        base_retrieval_run_id: 'retrieval-run-1',
      };
      const contentService = {
        generateWorkflowText: jest.fn(),
        prepareGroundingRevision: jest.fn().mockResolvedValue(undefined),
        generateAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValueOnce(revision),
        generateAtomicGroundingRevisionCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
      };
      const domainCommitter = committer({ resourceId: 'must-not-exist' });
      const claim = job(WorkflowType.CONTENT, { strict_citation: true });
      const executor = atomicExecutor(
        contentService,
        domainCommitter,
        'shadow_no_persist',
      );

      const events = await collect(
        executor.execute(claim, {
          signal: new AbortController().signal,
        }),
      );

      expect(contentService.prepareGroundingRevision).toHaveBeenCalledTimes(1);
      expect(
        contentService.generateAtomicGroundingCandidate,
      ).toHaveBeenCalledTimes(1);
      expect(
        contentService.generateAtomicGroundingRevisionCandidate,
      ).toHaveBeenCalledWith(
        WorkflowType.CONTENT,
        claim.userId,
        claim.projectId,
        expect.objectContaining({
          revision_attempt: 1,
          revision: {
            base_proposal: revision.canonical_proposal,
            allowed_candidate_claim_keys: ['candidate-key-1'],
            non_target_invariant_digests: revision.non_target_invariant_digests,
          },
        }),
        expect.any(AbortSignal),
        expect.objectContaining({
          workflow_job_id: claim.id,
          node: 'atomic_grounded_revision',
          attempt: 1,
        }),
        undefined,
      );
      expect(
        events.find(
          (item) => item.checkpoint.phase === 'atomic_revision_required',
        )?.checkpoint,
      ).toMatchObject({
        candidate_claim_keys: ['candidate-key-1'],
        reason_codes: ['ATOM_EXACT_MISMATCH'],
      });
      expect(
        events.find((item) => item.type === 'grounding.revision_retrieved')
          ?.checkpoint,
      ).toMatchObject({
        phase: 'atomic_revision_retrieved',
        candidate_claim_keys: ['candidate-key-1'],
        reason_codes: ['ATOM_EXACT_MISMATCH'],
      });
      expect(
        events
          .filter((item) => item.type === 'token')
          .map((item) => item.data?.content)
          .join(''),
      ).toBe('修订后正文');
      expect(contentService.generateWorkflowText).not.toHaveBeenCalled();
      expect(domainCommitter.commit).not.toHaveBeenCalled();
    });

    it('recovers a revision candidate persisted inside the coordinator boundary without a second structured model call', async () => {
      const candidate = sealedCandidate('已持久化的修订正文', 1);
      const revision: AtomicGroundingOutcome = {
        kind: 'revision_required',
        canonical_proposal: {
          schema_version: 'grounded-draft.v1',
          status: 'draft',
          claims: [],
          render_fragments: [],
          ordering: [],
          material_gap: null,
        },
        unsupported_claims: [
          {
            candidate_claim_key: 'candidate-key-1',
            source_claim_text_nfc: '待修订声明',
            reason_code: 'ATOM_EXACT_MISMATCH',
          },
        ],
        non_target_invariant_digests: {},
        base_retrieval_run_id: 'retrieval-run-1',
      };
      const revisionModel = jest.fn(
        async (
          _type,
          _userId,
          _projectId,
          _input,
          _signal,
          _trace,
          persistSealedCandidate?: (
            value: SealedGroundedCandidateV1,
          ) => Promise<void>,
        ) => {
          await persistSealedCandidate?.(candidate);
          throw new Error('simulated process death after durable seal');
        },
      );
      const contentService = {
        generateWorkflowText: jest.fn(),
        prepareGroundingRevision: jest.fn(),
        generateAtomicGroundingCandidate: jest.fn().mockResolvedValue(revision),
        generateAtomicGroundingRevisionCandidate: revisionModel,
        recoverAtomicGroundingCandidate: jest
          .fn()
          .mockResolvedValue({ kind: 'sealed', candidate }),
      };
      const executor = atomicExecutor(
        contentService,
        committer({ resourceId: 'forbidden' }),
        'shadow_no_persist',
      );
      let durable: WorkflowExecutionEvent | undefined;

      await expect(
        collect(
          executor.execute(
            job(WorkflowType.CONTENT, { strict_citation: true }),
            {
              signal: new AbortController().signal,
              persistProgress: async (generated) => {
                await Promise.resolve();
                durable = generated;
              },
            },
          ),
        ),
      ).rejects.toMatchObject({
        disposition: {
          internal_reason: 'INTERNAL_FAIL_CLOSED',
        },
      });
      expect(durable).toMatchObject({
        type: 'grounding.proposal_validated',
        checkpoint: {
          phase: 'atomic_sealed',
          sealed_candidate: candidate,
        },
      });
      expect(durable?.checkpoint).not.toHaveProperty('revision_model_result');
      expect(durable?.checkpoint).not.toHaveProperty('provider_output');

      const recovered = await collectPersisted(
        executor.execute(
          job(
            WorkflowType.CONTENT,
            { strict_citation: true },
            durable?.checkpoint ?? null,
          ),
          { signal: new AbortController().signal },
        ),
      );

      expect(revisionModel).toHaveBeenCalledTimes(1);
      expect(
        contentService.recoverAtomicGroundingCandidate,
      ).toHaveBeenCalledTimes(1);
      expect(
        recovered
          .filter((item) => item.type === 'token')
          .map((item) => item.data?.content)
          .join(''),
      ).toBe(candidate.server_output.text);
    });

    it('fails closed without a second revision model call after provider success becomes ambiguous', async () => {
      const candidate = sealedCandidate('不应通过第二次模型调用生成', 1);
      const revision: AtomicGroundingOutcome = {
        kind: 'revision_required',
        canonical_proposal: {
          schema_version: 'grounded-draft.v1',
          status: 'draft',
          claims: [],
          render_fragments: [],
          ordering: [],
          material_gap: null,
        },
        unsupported_claims: [
          {
            candidate_claim_key: 'candidate-key-1',
            source_claim_text_nfc: '待修订声明',
            reason_code: 'ATOM_EXACT_MISMATCH',
          },
        ],
        non_target_invariant_digests: {},
        base_retrieval_run_id: 'retrieval-run-1',
      };
      let modelCalls = 0;
      const revisionModel = jest.fn(() => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return Promise.reject(
            new Error(
              'simulated process death after provider success before verify',
            ),
          );
        }
        return Promise.resolve({ kind: 'sealed' as const, candidate });
      });
      const inspectModelAttempt = jest.fn().mockResolvedValue('mismatch');
      const contentService = {
        generateWorkflowText: jest.fn(),
        prepareGroundingRevision: jest.fn(),
        generateAtomicGroundingCandidate: jest.fn().mockResolvedValue(revision),
        generateAtomicGroundingRevisionCandidate: revisionModel,
        inspectAtomicGroundingRevisionModelAttempt: inspectModelAttempt,
      };
      const executor = atomicExecutor(
        contentService,
        committer({ resourceId: 'forbidden' }),
        'shadow_no_persist',
      );
      let durable: WorkflowExecutionEvent | undefined;

      await expect(
        collect(
          executor.execute(
            job(WorkflowType.CONTENT, { strict_citation: true }),
            {
              signal: new AbortController().signal,
              persistProgress: (generated) => {
                durable = generated;
                return Promise.resolve();
              },
            },
          ),
        ),
      ).rejects.toMatchObject({
        disposition: { internal_reason: 'INTERNAL_FAIL_CLOSED' },
      });

      await expect(
        collect(
          executor.execute(
            job(
              WorkflowType.CONTENT,
              { strict_citation: true },
              durable?.checkpoint ?? null,
            ),
            { signal: new AbortController().signal },
          ),
        ),
      ).rejects.toMatchObject({
        disposition: { internal_reason: 'INTERNAL_FAIL_CLOSED' },
      });
      expect(durable).toMatchObject({
        type: 'grounding.revision_model_started',
        checkpoint: {
          phase: 'atomic_revision_model_started',
          model_request_idempotency_key:
            expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      });
      expect(inspectModelAttempt).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        expect.stringMatching(/^[0-9a-f]{64}$/u),
      );
      expect(modelCalls).toBe(1);
    });
  });

  it('parses and saves a generated directory on the server before done', async () => {
    const contentService = {
      generateDirectory: jest.fn(async function* () {
        await Promise.resolve();
        yield '{"nodes":[{"key":"c1","level":"章","title":"第一章",';
        yield '"children":[{"key":"s1","level":"节","title":"第一节","children":[]}]}]}';
      }),
      getCurrentDirectory: jest.fn().mockResolvedValue(null),
      saveDirectory: jest.fn().mockResolvedValue({ id: 'directory-version-1' }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer({ resourceId: 'directory-version-1' }),
    );
    const claim = job(WorkflowType.DIRECTORY, {
      additional_instruction: '按素材生成',
    });

    const events: WorkflowExecutionEvent[] = [];
    for await (const event of executor.execute(claim, {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(contentService.saveDirectory).not.toHaveBeenCalled();
    expect(executorDomainCommitter.commit).toHaveBeenCalledWith(
      claim,
      expect.objectContaining({
        output: expect.stringContaining('"nodes"'),
        directoryNodes: [
          expect.objectContaining({
            node_id: 'c1',
            parent_node_id: null,
            node_type: 'chapter',
          }),
          expect.objectContaining({
            node_id: 's1',
            parent_node_id: 'c1',
            node_type: 'section',
          }),
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      data: {
        type: 'done',
        result_id: 'directory-version-1',
        status: 'succeeded',
      },
    });
  });

  it('rejects duplicate node ids instead of persisting ambiguous structure', () => {
    expect(() =>
      parseGeneratedDirectory(
        '{"nodes":[{"key":"dup","title":"A"},{"key":"dup","title":"B"}]}',
      ),
    ).toThrow('目录节点标识重复');
  });

  it('passes the workflow AbortSignal into content generation', async () => {
    const controller = new AbortController();
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        yield '正文';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer({ resourceId: 'result-1' }),
    );
    const claim = job(WorkflowType.CONTENT, {
      chapter_node_id: 'chapter-1',
      section_node_id: 'section-1',
      strict_citation: false,
    });

    const events: WorkflowExecutionEvent[] = [];
    for await (const generatedEvent of executor.execute(claim, {
      signal: controller.signal,
    })) {
      events.push(generatedEvent);
    }

    expect(events.map((item) => item.checkpoint.phase)).toEqual([
      'model_started',
      'model_started',
      'model_completed',
      'business_committed',
      'done',
    ]);
    expect(events[0]).toMatchObject({
      type: 'meta',
      data: {
        result_id: claim.id,
        workflow_job_id: claim.id,
      },
      checkpoint: {
        phase: 'model_started',
        generation_attempt: 1,
      },
    });
    expect(events[1].checkpoint).not.toHaveProperty('output');
    expect(contentService.generateWorkflowText).toHaveBeenCalledWith(
      WorkflowType.CONTENT,
      claim.userId,
      claim.projectId,
      claim.input,
      controller.signal,
      {
        workflow_job_id: claim.id,
        node: 'generate',
        attempt: 1,
      },
    );
  });

  it('resets a superseded partial attempt before restarting the provider', async () => {
    const contentService = {
      generateDirectory: jest.fn(async function* () {
        await Promise.resolve();
        yield '{"nodes":[{"key":"fresh","title":"新目录"}]}';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer({
        resourceId: 'directory-version-fresh',
        versionId: 'directory-version-fresh',
      }),
    );
    const claim = job(
      WorkflowType.DIRECTORY,
      {},
      {
        phase: 'model_started',
        generation_attempt: 1,
        output: 'old-partial',
      },
    );
    Object.assign(claim, { generationAttempt: 1 });

    const events: WorkflowExecutionEvent[] = [];
    for await (const generatedEvent of executor.execute(claim, {
      signal: new AbortController().signal,
    })) {
      events.push(generatedEvent);
    }

    expect(events[0]).toMatchObject({
      type: 'reset',
      data: {
        type: 'reset',
        superseded_attempt: 1,
        generation_attempt: 2,
      },
      checkpoint: {
        phase: 'model_started',
        generation_attempt: 2,
      },
    });
    expect(events[0].checkpoint).not.toHaveProperty('output');
    expect(events.find((item) => item.type === 'token')?.checkpoint).toEqual({
      phase: 'model_started',
      generation_attempt: 2,
    });
    expect(
      events.find((item) => item.type === 'workflow.model_completed')
        ?.checkpoint,
    ).toMatchObject({
      phase: 'model_completed',
      generation_attempt: 2,
      output: '{"nodes":[{"key":"fresh","title":"新目录"}]}',
    });
  });

  it('rejects an unbounded provider token before persisting it', async () => {
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        yield 'x'.repeat(70_000);
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer({ resourceId: 'unused' }),
    );

    await expect(async () => {
      for await (const _event of executor.execute(
        job(WorkflowType.CONTENT, {
          chapter_node_id: 'chapter-1',
          strict_citation: false,
        }),
        { signal: new AbortController().signal },
      )) {
        void _event;
      }
    }).rejects.toThrow('模型单次输出片段超过限制');
  });

  it('does not invoke the model again after model_completed was checkpointed', async () => {
    const contentService = {
      generateDirectory: jest.fn(),
    };
    const domainCommitter = committer({
      resourceId: 'directory-version-1',
      versionId: 'directory-version-1',
    });
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      domainCommitter,
    );
    const claim = job(
      WorkflowType.DIRECTORY,
      { additional_instruction: '按素材生成' },
      {
        phase: 'model_completed',
        output: '{"nodes":[{"key":"c1","title":"第一章"}]}',
      },
    );

    const events: WorkflowExecutionEvent[] = [];
    for await (const generatedEvent of executor.execute(claim, {
      signal: new AbortController().signal,
    })) {
      events.push(generatedEvent);
    }

    expect(contentService.generateDirectory).not.toHaveBeenCalled();
    expect(domainCommitter.commit).toHaveBeenCalledTimes(1);
    expect(events.map((item) => item.checkpoint.phase)).toEqual([
      'business_committed',
      'done',
    ]);
  });

  it('re-emits done without model or domain writes after business commit was checkpointed', async () => {
    const contentService = { generateDirectory: jest.fn() };
    const domainCommitter = committerWithRecovery({
      resourceId: 'directory-version-1',
      versionId: 'directory-version-1',
      citations: [{ id: 'citation-1' }],
    });
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      domainCommitter,
    );
    const claim = job(
      WorkflowType.DIRECTORY,
      {},
      {
        phase: 'business_committed',
        output: '{"nodes":[{"key":"c1","title":"第一章"}]}',
        resource_id: 'directory-version-1',
        version_id: 'directory-version-1',
      },
    );

    const events: WorkflowExecutionEvent[] = [];
    for await (const generatedEvent of executor.execute(claim, {
      signal: new AbortController().signal,
    })) {
      events.push(generatedEvent);
    }

    expect(contentService.generateDirectory).not.toHaveBeenCalled();
    expect(domainCommitter.commit).not.toHaveBeenCalled();
    expect(domainCommitter.findCommitted).toHaveBeenCalledWith(claim.id);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'done',
        data: expect.objectContaining({
          result_id: 'directory-version-1',
          directory_id: 'directory-version-1',
          server_saved: true,
          workflow_job_id: claim.id,
          citations: [{ id: 'citation-1' }],
        }),
        checkpoint: expect.objectContaining({ phase: 'done' }),
      }),
    ]);
  });

  it('recovers a persisted targeted revision and commits the revised output once', async () => {
    const contentService = {
      prepareGroundingRevision: jest.fn().mockResolvedValue(undefined),
      generateGroundingRevision: jest.fn(async function* () {
        await Promise.resolve();
        yield '受证据支持的';
        yield '修订正文。';
      }),
    };
    const domainCommitter = committer({ resourceId: 'result-1' });
    const claim = job(
      WorkflowType.CONTENT,
      { chapter_node_id: 'chapter-1', strict_citation: false },
      {
        phase: 'revision_required',
        generation_attempt: 1,
        revision_attempt: 1,
        output: '不支持的声明。',
        unsupported_claims: [
          { claim_id: 'claim-1', claim_text: '不支持的声明。' },
        ],
      },
    );
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      domainCommitter,
    );

    const events: WorkflowExecutionEvent[] = [];
    for await (const generatedEvent of executor.execute(claim, {
      signal: new AbortController().signal,
    })) {
      events.push(generatedEvent);
    }

    expect(contentService.prepareGroundingRevision).toHaveBeenCalledWith(
      claim.userId,
      claim.projectId,
      claim.id,
      [{ claim_id: 'claim-1', claim_text: '不支持的声明。' }],
      expect.any(AbortSignal),
    );
    expect(contentService.generateGroundingRevision).toHaveBeenCalledWith(
      claim.userId,
      claim.projectId,
      claim.id,
      '不支持的声明。',
      [{ claim_id: 'claim-1', claim_text: '不支持的声明。' }],
      expect.any(AbortSignal),
      expect.objectContaining({
        workflow_job_id: claim.id,
        node: 'grounding_targeted_revision',
        attempt: 1,
      }),
    );
    expect(domainCommitter.commit).toHaveBeenCalledWith(claim, {
      contract_version: 'legacy:v0',
      output: '受证据支持的修订正文。',
    });
    expect(events.map((item) => item.checkpoint.phase)).toEqual([
      'revision_retrieved',
      'revision_model_started',
      'revision_model_started',
      'revision_model_started',
      'revision_model_completed',
      'business_committed',
      'done',
    ]);
  });

  it('throws provider failures without forwarding the raw error event', async () => {
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        throw new Error('secret upstream provider key=abc');
        yield 'unreachable';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      committer({ resourceId: 'unused' }),
    );
    const claim = job(WorkflowType.CONTENT, {
      chapter_node_id: 'chapter-1',
      strict_citation: false,
    });
    const events: unknown[] = [];

    await expect(async () => {
      for await (const generatedEvent of executor.execute(claim, {
        signal: new AbortController().signal,
      })) {
        events.push(generatedEvent);
      }
    }).rejects.toThrow('secret upstream provider');

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('never commits partial text when the model reports an incomplete terminal', async () => {
    const domainCommitter = committer({ resourceId: 'must-not-be-used' });
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        yield 'partial';
        throw new Error('模型输出不完整');
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      domainCommitter,
    );

    await expect(async () => {
      for await (const _event of executor.execute(
        job(WorkflowType.CONTENT, {
          chapter_node_id: 'chapter-1',
          strict_citation: false,
        }),
        { signal: new AbortController().signal },
      )) {
        void _event;
      }
    }).rejects.toThrow('模型输出不完整');

    expect(domainCommitter.commit).not.toHaveBeenCalled();
  });

  it('never commits when text generation rejects an unexpected tool call', async () => {
    const domainCommitter = committer({ resourceId: 'must-not-be-used' });
    const contentService = {
      generateWorkflowText: jest.fn(async function* () {
        await Promise.resolve();
        throw new Error('UNEXPECTED_TOOL_CALL');
        yield 'unreachable';
      }),
    };
    const executor = new WorkflowGenerationExecutor(
      contentService as unknown as ContentService,
      domainCommitter,
    );

    await expect(async () => {
      for await (const _event of executor.execute(
        job(WorkflowType.CONTENT, {
          chapter_node_id: 'chapter-1',
          strict_citation: false,
        }),
        { signal: new AbortController().signal },
      )) {
        void _event;
      }
    }).rejects.toThrow('UNEXPECTED_TOOL_CALL');

    expect(domainCommitter.commit).not.toHaveBeenCalled();
  });
});

function job(
  workflowType: WorkflowType,
  input: Record<string, unknown>,
  checkpoint: Record<string, unknown> | null = null,
): ClaimedWorkflowJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    workflowType,
    input,
    checkpoint,
    leaseToken: '44444444-4444-4444-8444-444444444444',
    fencingToken: 1,
    generationAttempt:
      typeof checkpoint?.generation_attempt === 'number'
        ? checkpoint.generation_attempt
        : 0,
  };
}

let executorDomainCommitter: jest.Mocked<WorkflowDomainCommitter>;

function committer(
  result: Awaited<ReturnType<WorkflowDomainCommitter['commit']>>,
): jest.Mocked<WorkflowDomainCommitter> {
  executorDomainCommitter = {
    commit: jest.fn().mockResolvedValue(result),
    findCommitted: jest.fn().mockResolvedValue(null),
  };
  return executorDomainCommitter;
}

function committerWithRecovery(
  result: Awaited<ReturnType<WorkflowDomainCommitter['commit']>>,
): jest.Mocked<WorkflowDomainCommitter> & {
  findCommitted: jest.Mock<Promise<typeof result>, [string]>;
} {
  const value = {
    commit: jest.fn().mockResolvedValue(result),
    findCommitted: jest.fn().mockResolvedValue(result),
  };
  executorDomainCommitter = value;
  return value as typeof value & jest.Mocked<WorkflowDomainCommitter>;
}

async function collect(
  events: AsyncIterable<WorkflowExecutionEvent>,
): Promise<WorkflowExecutionEvent[]> {
  const collected: WorkflowExecutionEvent[] = [];
  for await (const generated of events) collected.push(generated);
  return collected;
}

async function collectPersisted(
  events: AsyncIterable<WorkflowExecutionEvent>,
): Promise<WorkflowExecutionEvent[]> {
  const collected: WorkflowExecutionEvent[] = [];
  for await (const generated of events) {
    collected.push(generated);
    (
      generated as WorkflowExecutionEvent & {
        onPersisted?: () => void;
      }
    ).onPersisted?.();
  }
  return collected;
}

async function collectSettled(
  events: AsyncIterable<WorkflowExecutionEvent>,
): Promise<void> {
  try {
    await collect(events);
  } catch {
    // The assertion is the independent no-legacy-write boundary.
  }
}

function requireGeneratedEvent(
  result: IteratorResult<WorkflowExecutionEvent, void>,
): WorkflowExecutionEvent {
  if (result.done) throw new Error('expected generated workflow event');
  return result.value;
}

function atomicExecutor(
  contentService: Record<string, unknown>,
  domainCommitter: jest.Mocked<WorkflowDomainCommitter>,
  mode: 'off' | 'shadow_no_persist',
  metrics = metricRecorder(),
): WorkflowGenerationExecutor {
  type AtomicExecutorConstructor = new (
    content: ContentService,
    committer: WorkflowDomainCommitter,
    config: { get: (key: string, fallback?: unknown) => unknown },
    recorder: AtomicGroundingMetricsRecorder,
  ) => WorkflowGenerationExecutor;
  const Constructor =
    WorkflowGenerationExecutor as unknown as AtomicExecutorConstructor;
  const adaptedContentService =
    adaptAtomicRevisionModelBoundary(contentService);
  return new Constructor(
    adaptedContentService as unknown as ContentService,
    domainCommitter,
    {
      get: (key: string, fallback?: unknown) =>
        key === 'ATOMIC_GROUNDING_MODE' ? mode : fallback,
    },
    metrics as unknown as AtomicGroundingMetricsRecorder,
  );
}

function adaptAtomicRevisionModelBoundary(
  contentService: Record<string, unknown>,
): Record<string, unknown> {
  const legacyGenerate =
    contentService.generateAtomicGroundingRevisionCandidate;
  if (
    typeof legacyGenerate !== 'function' ||
    typeof contentService.prepareAtomicGroundingRevisionModel === 'function'
  ) {
    return contentService;
  }
  const identity = testModelOperationIdentity();
  const inspect = contentService.inspectAtomicGroundingRevisionModelAttempt;
  return {
    ...contentService,
    prepareAtomicGroundingRevisionModel: jest.fn((...args: unknown[]) =>
      Promise.resolve({
        model_identity: identity,
        __legacy_args: args,
      }),
    ),
    executePreparedAtomicGroundingRevisionModel: jest.fn(
      (prepared: { __legacy_args: unknown[] }) =>
        (legacyGenerate as (...args: unknown[]) => Promise<unknown>)(
          ...prepared.__legacy_args,
        ),
    ),
    ...(typeof inspect === 'function'
      ? {
          inspectAtomicGroundingRevisionModelAttempt: jest.fn(
            (workflowJobId: string, operation: ModelOperationIdentity) =>
              (
                inspect as (
                  jobId: string,
                  operationKey: string,
                ) => Promise<unknown>
              )(workflowJobId, operation.operation_key),
          ),
        }
      : {}),
  };
}

function testModelOperationIdentity(): ModelOperationIdentity {
  return {
    version: 'model-operation.v1',
    operation_key: '1'.repeat(64),
    request_fingerprint: '2'.repeat(64),
    prompt_sha256: '3'.repeat(64),
    provider: 'fake',
    model: 'model-1',
    schema_id: 'grounded-draft.v1',
    schema_version: 'grounded-draft.v1',
    schema_sha256: '4'.repeat(64),
  };
}

function metricRecorder() {
  return {
    firstRenderedToken: jest.fn(),
  };
}

function sealedCandidate(
  text: string,
  revisionAttempt: 0 | 1 = 0,
): SealedGroundedCandidateV1 {
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
      workflow_job_id: '11111111-1111-4111-8111-111111111111',
      project_id: '33333333-3333-4333-8333-333333333333',
      workflow_type: 'content',
      generation_attempt: 1,
      revision_attempt: revisionAttempt,
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
