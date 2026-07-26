import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentService } from '../content/content.service.js';
import {
  AtomicGroundingCoordinatorError,
  type AtomicGroundingOutcome,
  type PreparedAtomicGroundingGeneration,
} from '../citation/atomic-grounding/atomic-grounding-coordinator.service.js';
import {
  parseAtomicGroundingMode,
  type AtomicGroundingMode,
} from '../citation/atomic-grounding/atomic-grounding-mode.js';
import { AtomicGroundingMetricsRecorder } from '../citation/atomic-grounding/atomic-grounding.metrics.js';
import type {
  AtomicGroundingReasonCode,
  GroundedDraftProposal,
  SealedGroundedCandidateV1,
} from '../citation/atomic-grounding/contracts.js';
import type { ModelOperationIdentity } from '../llm/model-types.js';
import type { DirectoryNodeDto } from '../content/dto/save-directory.dto.js';
import { DirectoryNodeType } from '../content/dto/save-directory.dto.js';
import type { GenerateDirectoryDto } from '../content/dto/generate-directory.dto.js';
import type { GenerateOutlineDto } from '../content/dto/generate-outline.dto.js';
import {
  DeterministicAuthoringGraph,
  isDeterministicAuthoringDefinition,
} from '../authoring/graph/deterministic-authoring.graph.js';
import {
  WorkflowCancelledError,
  WorkflowLeaseLostError,
  type ClaimedWorkflowJob,
  type WorkflowExecutionEvent,
  type WorkflowExecutionOutcome,
  type WorkflowTaskContext,
  type WorkflowTaskExecutor,
} from './workflow.engine.js';
import type {
  WorkflowDomainCommitInput,
  WorkflowDomainCommitResult,
} from './workflow-domain-commit.service.js';
import { WorkflowDomainCommitService } from './workflow-domain-commit.service.js';
import { WorkflowType } from './workflow.types.js';

export interface WorkflowDomainCommitter {
  commit(
    job: ClaimedWorkflowJob,
    input: WorkflowDomainCommitInput,
  ): Promise<WorkflowDomainCommitResult>;
  findCommitted(jobId: string): Promise<WorkflowDomainCommitResult | null>;
}

type GenerationPhase =
  | 'model_started'
  | 'model_completed'
  | 'revision_required'
  | 'revision_retrieved'
  | 'revision_model_started'
  | 'revision_model_completed'
  | 'business_committed'
  | 'done'
  | 'atomic_revision_required'
  | 'atomic_revision_retrieved'
  | 'atomic_revision_model_started'
  | 'atomic_sealed'
  | 'atomic_shadow_complete';

interface GenerationCheckpoint extends Record<string, unknown> {
  phase: GenerationPhase;
  generation_attempt: number;
  output?: string;
  resource_id?: string;
  version_id?: string;
  revision_attempt?: number;
  unsupported_claims?: UnsupportedGroundingClaim[];
  sealed_candidate?: SealedGroundedCandidateV1;
  canonical_proposal?: GroundedDraftProposal;
  candidate_claim_keys?: string[];
  source_claim_texts?: string[];
  reason_codes?: AtomicGroundingReasonCode[];
  non_target_invariant_digests?: Record<string, string>;
  base_retrieval_run_id?: string;
  model_request_idempotency_key?: string;
  model_operation_identity?: ModelOperationIdentity;
  emitted_utf16?: number;
}

interface UnsupportedGroundingClaim {
  claim_id: string;
  claim_text: string;
}

const MAX_MODEL_TOKEN_BYTES = 64 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_TOKEN_EVENTS = 50_000;
const MAX_ATOMIC_TOKEN_BYTES = 16 * 1024;

export class AtomicGroundingRuntimeError extends AtomicGroundingCoordinatorError {
  constructor(
    reason: AtomicGroundingReasonCode,
    revisionAttempt: 0 | 1,
    candidateClaimKeys: string[] = [],
  ) {
    super(reason, revisionAttempt, candidateClaimKeys);
    this.name = 'AtomicGroundingRuntimeError';
  }
}

@Injectable()
export class WorkflowGenerationExecutor implements WorkflowTaskExecutor {
  constructor(
    private readonly contentService: ContentService,
    @Inject(WorkflowDomainCommitService)
    private readonly domainCommitter: WorkflowDomainCommitter,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly atomicMetrics?: AtomicGroundingMetricsRecorder,
    @Optional()
    private readonly deterministicAuthoringGraph?: DeterministicAuthoringGraph,
  ) {}

  async *execute(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    WorkflowExecutionOutcome | void,
    void
  > {
    assertGenerationWorkflow(job.workflowType);
    if (isDeterministicAuthoringDefinition(job.workflowDefinition)) {
      if (!this.deterministicAuthoringGraph) {
        throw new BadRequestException(
          '确定性写作图尚未在 worker 中完成依赖注入',
        );
      }
      return yield* this.deterministicAuthoringGraph.execute(job, context);
    }
    const restored = readCheckpoint(job.checkpoint);
    if (restored?.phase === 'done') return;
    if (isAtomicPhase(restored?.phase)) {
      if (!isAtomicContentWorkflow(job.workflowType)) {
        throw atomicRuntimeFailure(
          'ENVELOPE_INVALID',
          restored.revision_attempt === 1 ? 1 : 0,
        );
      }
      yield* this.executeAtomic(job, context, restored);
      return;
    }
    const atomicMode = this.atomicMode();
    if (
      isAtomicContentWorkflow(job.workflowType) &&
      isStrict(job) &&
      atomicMode !== 'off'
    ) {
      yield* this.executeAtomic(job, context, restored);
      return;
    }
    if (
      isAtomicContentWorkflow(job.workflowType) &&
      isStrict(job) &&
      atomicMode === 'off'
    ) {
      job = {
        ...job,
        input: {
          ...(job.input ?? {}),
          strict_citation: false,
        },
      };
    }

    let generationAttempt = Math.max(
      job.generationAttempt,
      restored?.generation_attempt ?? 0,
    );
    let output = restored?.output ?? '';
    if (restored && isRevisionPhase(restored.phase)) {
      const revisionAttempt = restored.revision_attempt ?? 1;
      const unsupportedClaims = restored.unsupported_claims ?? [];
      if (
        restored.phase === 'revision_required' &&
        unsupportedClaims.length === 0
      ) {
        throw new BadRequestException('定向修订检查点缺少 unsupported_claims');
      }
      if (restored.phase === 'revision_required') {
        if (context.signal.aborted) throw context.signal.reason;
        await this.contentService.prepareGroundingRevision(
          job.userId,
          job.projectId,
          job.id,
          unsupportedClaims,
          context.signal,
        );
        yield event(
          'grounding.revision_retrieved',
          {
            type: 'revision_retrieved',
            revision_attempt: revisionAttempt,
          },
          revisionCheckpoint(
            'revision_retrieved',
            generationAttempt,
            revisionAttempt,
            output,
            unsupportedClaims,
          ),
        );
      }
      if (
        restored.phase === 'revision_required' ||
        restored.phase === 'revision_retrieved' ||
        restored.phase === 'revision_model_started'
      ) {
        yield event(
          restored.phase === 'revision_model_started' ? 'reset' : 'meta',
          restored.phase === 'revision_model_started'
            ? {
                type: 'reset',
                reason: 'grounding_revision_stream_restarted',
                revision_attempt: revisionAttempt,
              }
            : {
                type: 'meta',
                task_type: 'grounding_targeted_revision',
                revision_attempt: revisionAttempt,
              },
          revisionCheckpoint(
            'revision_model_started',
            generationAttempt,
            revisionAttempt,
            output,
            unsupportedClaims,
          ),
        );
        let revisedOutput = '';
        let tokenEvents = 0;
        for await (const token of this.contentService.generateGroundingRevision(
          job.userId,
          job.projectId,
          job.id,
          output,
          unsupportedClaims,
          context.signal,
          {
            workflow_job_id: job.id,
            node: 'grounding_targeted_revision',
            attempt: revisionAttempt,
          },
        )) {
          assertTokenWithinLimits(token);
          tokenEvents += 1;
          if (tokenEvents > MAX_MODEL_TOKEN_EVENTS) {
            throw new BadRequestException('模型输出片段数量超过限制');
          }
          revisedOutput += token;
          if (
            Buffer.byteLength(revisedOutput, 'utf8') > MAX_MODEL_OUTPUT_BYTES
          ) {
            throw new BadRequestException('模型总输出超过限制');
          }
          yield event(
            'token',
            {
              type: 'token',
              content: token,
              paragraph_key: '',
              revision_attempt: revisionAttempt,
            },
            revisionCheckpoint(
              'revision_model_started',
              generationAttempt,
              revisionAttempt,
              output,
              unsupportedClaims,
            ),
          );
        }
        output = revisedOutput;
        yield event(
          'grounding.revision_model_completed',
          null,
          revisionCheckpoint(
            'revision_model_completed',
            generationAttempt,
            revisionAttempt,
            output,
            unsupportedClaims,
          ),
        );
      }
    }
    if (!restored || restored.phase === 'model_started') {
      const restarting = restored?.phase === 'model_started';
      const supersededAttempt = generationAttempt;
      generationAttempt += 1;
      output = '';
      yield event(
        restarting ? 'reset' : 'meta',
        restarting
          ? {
              type: 'reset',
              superseded_attempt: supersededAttempt,
              generation_attempt: generationAttempt,
              reason: 'provider_stream_restarted',
              ...(typeof restored.output === 'string'
                ? { discarded_output_chars: restored.output.length }
                : {}),
            }
          : {
              type: 'meta',
              result_id: job.id,
              workflow_job_id: job.id,
              task_type: job.workflowType,
              generation_attempt: generationAttempt,
              started_at: new Date().toISOString(),
            },
        checkpoint('model_started', generationAttempt),
      );
      let tokenEvents = 0;
      for await (const token of this.generate(
        job,
        context.signal,
        generationAttempt,
      )) {
        assertTokenWithinLimits(token);
        tokenEvents += 1;
        if (tokenEvents > MAX_MODEL_TOKEN_EVENTS) {
          throw new BadRequestException('模型输出片段数量超过限制');
        }
        output += token;
        if (Buffer.byteLength(output, 'utf8') > MAX_MODEL_OUTPUT_BYTES) {
          throw new BadRequestException('模型总输出超过限制');
        }
        yield event(
          'token',
          {
            type: 'token',
            content: token,
            paragraph_key: '',
            generation_attempt: generationAttempt,
          },
          checkpoint('model_started', generationAttempt),
        );
      }
      yield event(
        'workflow.model_completed',
        null,
        checkpoint('model_completed', generationAttempt, { output }),
      );
    }

    let committed: WorkflowDomainCommitResult;
    if (restored?.phase === 'business_committed') {
      committed =
        (await this.domainCommitter.findCommitted(job.id)) ??
        missingDomainCommit(restored);
    } else {
      if (context.signal.aborted) throw context.signal.reason;
      committed = await this.domainCommitter.commit(job, {
        contract_version: 'legacy:v0',
        output,
        ...(job.workflowType === WorkflowType.DIRECTORY
          ? { directoryNodes: parseGeneratedDirectory(output) }
          : {}),
      } as WorkflowDomainCommitInput);
      yield event(
        'workflow.business_committed',
        null,
        checkpoint('business_committed', generationAttempt, {
          resourceId: committed.resourceId,
          versionId: committed.versionId,
        }),
      );
    }

    const doneData = doneEventData(job, committed);
    yield event(
      'done',
      doneData,
      checkpoint('done', generationAttempt, {
        resourceId: committed.resourceId,
        versionId: committed.versionId,
      }),
    );
  }

  private generate(
    job: ClaimedWorkflowJob,
    signal: AbortSignal,
    generationAttempt: number,
  ): AsyncIterable<string> {
    const input = requireInput(job) as unknown as GenerateOutlineDto;
    const trace = {
      workflow_job_id: job.id,
      node: 'generate',
      attempt: generationAttempt,
    } as const;
    switch (job.workflowType) {
      case WorkflowType.DIRECTORY:
        return this.contentService.generateDirectory(
          job.userId,
          job.projectId,
          input as unknown as GenerateDirectoryDto,
          signal,
          trace,
        );
      case WorkflowType.OUTLINE:
        return this.contentService.generateOutline(
          job.userId,
          job.projectId,
          input,
          signal,
          trace,
        );
      case WorkflowType.CONTENT:
      case WorkflowType.REWRITE:
      case WorkflowType.EXPAND:
      case WorkflowType.COMPRESS:
        return this.contentService.generateWorkflowText(
          job.workflowType,
          job.userId,
          job.projectId,
          requireInput(job),
          signal,
          trace,
        );
      default:
        throw new BadRequestException(
          `当前 worker 尚不支持 ${job.workflowType} 工作流`,
        );
    }
  }

  private async *executeAtomic(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
    restored: GenerationCheckpoint | null,
  ): AsyncGenerator<WorkflowExecutionEvent> {
    const mode = this.atomicMode();
    if (mode === 'off') {
      throw new AtomicGroundingRuntimeError('ATOMIC_GROUNDING_DISABLED', 0);
    }
    if (restored?.phase === 'atomic_shadow_complete') {
      if (job.input?.strict_citation !== true || !restored.sealed_candidate) {
        throw atomicRuntimeFailure('ASSIGNMENT_CONTRACT_MISMATCH', 0);
      }
      const recovered = requireSealedOutcome(
        await this.recoverAtomic(job, context, restored),
        restored.revision_attempt === 1 ? 1 : 0,
      );
      assertAtomicCandidate(job, recovered);
      if (
        recovered.workflow.generation_attempt !== restored.generation_attempt ||
        recovered.workflow.revision_attempt !== restored.revision_attempt ||
        typeof restored.emitted_utf16 !== 'number' ||
        validateEmittedUtf16(
          recovered.server_output.text,
          restored.emitted_utf16,
        ) !== recovered.server_output.text.length
      ) {
        throw atomicRuntimeFailure(
          'ENVELOPE_INVALID',
          restored.revision_attempt === 1 ? 1 : 0,
        );
      }
      return;
    }

    const startedAt = Date.now();
    let generationAttempt = Math.max(
      job.generationAttempt,
      restored?.generation_attempt ?? 0,
    );
    let revisionAttempt: 0 | 1 = restored?.revision_attempt === 1 ? 1 : 0;
    let outcome: AtomicGroundingOutcome;
    let sealedAlreadyPersisted = false;
    if (restored?.phase === 'atomic_sealed') {
      outcome = await this.recoverAtomic(job, context, restored);
    } else if (
      restored?.phase === 'atomic_revision_required' ||
      restored?.phase === 'atomic_revision_retrieved' ||
      restored?.phase === 'atomic_revision_model_started'
    ) {
      const resumed = yield* this.resumeAtomicRevision(job, context, restored);
      outcome = resumed.outcome;
      sealedAlreadyPersisted = resumed.sealedAlreadyPersisted;
    } else {
      generationAttempt += 1;
      yield event(
        restored?.phase === 'model_started' ? 'reset' : 'meta',
        restored?.phase === 'model_started'
          ? {
              type: 'reset',
              superseded_attempt: restored.generation_attempt,
              generation_attempt: generationAttempt,
              reason: 'provider_stream_restarted',
            }
          : {
              type: 'meta',
              result_id: job.id,
              workflow_job_id: job.id,
              task_type: job.workflowType,
              generation_attempt: generationAttempt,
              started_at: new Date().toISOString(),
            },
        checkpoint('model_started', generationAttempt),
      );
      outcome = await this.generateAtomic(
        job,
        context,
        generationAttempt,
        requireInput(job),
      );
      if (outcome.kind === 'revision_required') {
        revisionAttempt = 1;
        const revisionCheckpointValue = atomicRevisionCheckpoint(
          'atomic_revision_required',
          generationAttempt,
          outcome,
        );
        yield event(
          'grounding.revision_required',
          {
            type: 'revision_required',
            revision_attempt: 1,
            reason_codes: revisionCheckpointValue.reason_codes,
            candidate_claim_keys: revisionCheckpointValue.candidate_claim_keys,
          },
          revisionCheckpointValue,
        );
        const resumed = yield* this.resumeAtomicRevision(
          job,
          context,
          revisionCheckpointValue,
        );
        outcome = resumed.outcome;
        sealedAlreadyPersisted = resumed.sealedAlreadyPersisted;
      }
    }

    const candidate = requireSealedOutcome(outcome, revisionAttempt);
    assertAtomicCandidate(job, candidate);
    generationAttempt = candidate.workflow.generation_attempt;
    const emittedUtf16 =
      restored?.phase === 'atomic_sealed'
        ? validateEmittedUtf16(
            candidate.server_output.text,
            restored.emitted_utf16,
          )
        : 0;
    const sealed = {
      ...atomicSealedCheckpoint(candidate),
      ...(emittedUtf16 > 0 ? { emitted_utf16: emittedUtf16 } : {}),
    };
    if (!sealedAlreadyPersisted) {
      yield event(
        'grounding.proposal_validated',
        {
          type: 'proposal_validated',
          workflow_type: job.workflowType,
        },
        sealed,
      );
    }

    let emitted = emittedUtf16;
    let firstToken = emitted === 0;
    for (const token of chunkAtomicOutput(
      candidate.server_output.text.slice(emittedUtf16),
    )) {
      emitted += token.length;
      const recordFirstToken =
        firstToken && this.atomicMetrics
          ? once(() => {
              this.atomicMetrics?.firstRenderedToken(
                candidate.workflow.workflow_type,
                Math.max(0, Date.now() - startedAt),
              );
            })
          : undefined;
      firstToken = false;
      yield event(
        'token',
        {
          type: 'token',
          content: token,
          paragraph_key: '',
          generation_attempt: generationAttempt,
        },
        {
          ...sealed,
          emitted_utf16: emitted,
        },
        recordFirstToken,
      );
    }
    yield event(
      'done',
      {
        type: 'done',
        result_id: job.id,
        status: 'succeeded',
        citations: [],
        server_saved: false,
        workflow_job_id: job.id,
      },
      {
        ...sealed,
        phase: 'atomic_shadow_complete',
        emitted_utf16: candidate.server_output.text.length,
      },
    );
  }

  private async *resumeAtomicRevision(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
    restored: GenerationCheckpoint,
  ): AsyncGenerator<
    WorkflowExecutionEvent,
    {
      outcome: AtomicGroundingOutcome;
      sealedAlreadyPersisted: boolean;
    }
  > {
    const proposal = restored.canonical_proposal;
    const candidateClaimKeys = restored.candidate_claim_keys ?? [];
    const reasonCodes = restored.reason_codes ?? [];
    const invariants = restored.non_target_invariant_digests;
    if (
      !proposal ||
      candidateClaimKeys.length === 0 ||
      reasonCodes.length !== candidateClaimKeys.length ||
      !invariants
    ) {
      throw atomicRuntimeFailure('REVISION_INVARIANT_VIOLATION', 1);
    }
    if (restored.phase === 'atomic_revision_required') {
      await this.atomicCall(context, () =>
        this.contentService.prepareGroundingRevision(
          job.userId,
          job.projectId,
          job.id,
          candidateClaimKeys.map((candidateClaimKey, index) => ({
            claim_id: candidateClaimKey,
            claim_text: revisionClaimText(restored, index),
          })),
          context.signal,
          restored.base_retrieval_run_id,
        ),
      );
    }
    const retrieved =
      restored.phase === 'atomic_revision_required'
        ? {
            ...restored,
            phase: 'atomic_revision_retrieved' as const,
            revision_attempt: 1,
          }
        : restored;
    if (restored.phase === 'atomic_revision_required') {
      yield event(
        'grounding.revision_retrieved',
        {
          type: 'revision_retrieved',
          revision_attempt: 1,
          reason_codes: restored.reason_codes,
          candidate_claim_keys: candidateClaimKeys,
        },
        retrieved,
      );
    }
    let sealedAlreadyPersisted = false;
    const persistSealedCandidate = context.persistProgress
      ? async (candidate: SealedGroundedCandidateV1): Promise<void> => {
          assertAtomicCandidate(job, candidate);
          await context.persistProgress?.(
            event(
              'grounding.proposal_validated',
              {
                type: 'proposal_validated',
                workflow_type: job.workflowType,
              },
              atomicSealedCheckpoint(candidate),
            ),
          );
          sealedAlreadyPersisted = true;
        }
      : undefined;
    const revisionInput = {
      ...requireInput(job),
      revision_attempt: 1,
      revision: {
        base_proposal: proposal,
        allowed_candidate_claim_keys: candidateClaimKeys,
        non_target_invariant_digests: invariants,
      },
    };
    const prepared = await this.atomicCall(context, () =>
      this.contentService.prepareAtomicGroundingRevisionModel(
        job.workflowType as 'content' | 'rewrite' | 'expand' | 'compress',
        job.userId,
        job.projectId,
        revisionInput,
        context.signal,
        {
          workflow_job_id: job.id,
          node: 'atomic_grounded_revision',
          attempt: retrieved.generation_attempt,
        },
        persistSealedCandidate,
      ),
    );
    const modelIdentity = prepared.model_identity;
    if (
      retrieved.phase === 'atomic_revision_model_started' &&
      !sameModelOperationIdentity(
        readModelOperationIdentity(retrieved.model_operation_identity),
        modelIdentity,
      )
    ) {
      throw atomicRuntimeFailure('REVISION_INVARIANT_VIOLATION', 1);
    }
    const modelStarted: GenerationCheckpoint = {
      ...retrieved,
      phase: 'atomic_revision_model_started',
      revision_attempt: 1,
      model_request_idempotency_key: modelIdentity.operation_key,
      model_operation_identity: modelIdentity,
    };
    if (retrieved.phase === 'atomic_revision_model_started') {
      const state = await this.atomicCall(context, () =>
        this.contentService.inspectAtomicGroundingRevisionModelAttempt(
          job.id,
          modelIdentity,
        ),
      );
      if (state !== 'absent') {
        throw atomicRuntimeFailure('INTERNAL_FAIL_CLOSED', 1);
      }
    } else {
      const intent = event(
        'grounding.revision_model_started',
        {
          type: 'revision_model_started',
          revision_attempt: 1,
          model_request_idempotency_key: modelIdentity.operation_key,
          model_operation_identity: modelIdentity,
        },
        modelStarted,
      );
      if (context.persistProgress) {
        await context.persistProgress(intent);
      } else {
        yield intent;
      }
    }
    const outcome = await this.generateAtomicRevision(context, prepared);
    if (outcome.kind === 'revision_required') {
      throw atomicRuntimeFailure('REVISION_EXHAUSTED', 1, candidateClaimKeys);
    }
    return { outcome, sealedAlreadyPersisted };
  }

  private generateAtomicRevision(
    context: WorkflowTaskContext,
    prepared: PreparedAtomicGroundingGeneration,
  ): Promise<AtomicGroundingOutcome> {
    return this.atomicCall(context, () =>
      this.contentService.executePreparedAtomicGroundingRevisionModel(prepared),
    );
  }

  private generateAtomic(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
    generationAttempt: number,
    input: Record<string, unknown>,
  ): Promise<AtomicGroundingOutcome> {
    return this.atomicCall(context, () =>
      this.contentService.generateAtomicGroundingCandidate(
        job.workflowType as 'content' | 'rewrite' | 'expand' | 'compress',
        job.userId,
        job.projectId,
        input,
        context.signal,
        {
          workflow_job_id: job.id,
          node: 'atomic_grounded_draft',
          attempt: generationAttempt,
        },
      ),
    );
  }

  private recoverAtomic(
    job: ClaimedWorkflowJob,
    context: WorkflowTaskContext,
    restored: GenerationCheckpoint,
  ): Promise<AtomicGroundingOutcome> {
    return this.atomicCall(context, () =>
      this.contentService.recoverAtomicGroundingCandidate(
        job.id,
        job.projectId,
        restored.sealed_candidate,
      ),
    );
  }

  private async atomicCall<T>(
    context: WorkflowTaskContext,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      if (context.signal.aborted) throw context.signal.reason;
      return await call();
    } catch (error: unknown) {
      if (
        error instanceof AtomicGroundingCoordinatorError ||
        error instanceof WorkflowCancelledError ||
        error instanceof WorkflowLeaseLostError ||
        context.signal.aborted
      ) {
        throw error;
      }
      throw new AtomicGroundingRuntimeError('INTERNAL_FAIL_CLOSED', 0);
    }
  }

  private atomicMode(): AtomicGroundingMode {
    return parseAtomicGroundingMode(
      this.config?.get('ATOMIC_GROUNDING_MODE') ??
        process.env.ATOMIC_GROUNDING_MODE,
    );
  }
}

function doneEventData(
  job: ClaimedWorkflowJob,
  committed: WorkflowDomainCommitResult,
): Record<string, unknown> {
  return {
    type: 'done',
    result_id: committed.resourceId,
    status: 'succeeded',
    citations: committed.citations ?? [],
    server_saved: true,
    workflow_job_id: job.id,
    ...(job.workflowType === WorkflowType.DIRECTORY
      ? { directory_id: committed.resourceId }
      : {}),
    ...(job.workflowType === WorkflowType.OUTLINE
      ? { outline_id: committed.resourceId }
      : {}),
    ...(committed.versionId ? { version_id: committed.versionId } : {}),
  };
}

function checkpoint(
  phase: GenerationPhase,
  generationAttempt: number,
  values: {
    output?: string;
    resourceId?: string;
    versionId?: string;
  } = {},
): GenerationCheckpoint {
  return {
    phase,
    generation_attempt: generationAttempt,
    ...(values.output !== undefined ? { output: values.output } : {}),
    ...(values.resourceId ? { resource_id: values.resourceId } : {}),
    ...(values.versionId ? { version_id: values.versionId } : {}),
  };
}

function readCheckpoint(
  raw: Record<string, unknown> | null,
): GenerationCheckpoint | null {
  if (!raw) return null;
  const phase = raw.phase;
  if (
    phase !== 'model_started' &&
    phase !== 'model_completed' &&
    phase !== 'revision_required' &&
    phase !== 'revision_retrieved' &&
    phase !== 'revision_model_started' &&
    phase !== 'revision_model_completed' &&
    phase !== 'business_committed' &&
    phase !== 'done' &&
    phase !== 'atomic_revision_required' &&
    phase !== 'atomic_revision_retrieved' &&
    phase !== 'atomic_revision_model_started' &&
    phase !== 'atomic_sealed' &&
    phase !== 'atomic_shadow_complete'
  ) {
    return null;
  }
  if (
    phase === 'atomic_revision_required' ||
    phase === 'atomic_revision_retrieved' ||
    phase === 'atomic_revision_model_started' ||
    phase === 'atomic_sealed' ||
    phase === 'atomic_shadow_complete'
  ) {
    return {
      ...raw,
      phase,
      generation_attempt: readNonNegativeInteger(raw.generation_attempt),
      revision_attempt:
        readNonNegativeInteger(raw.revision_attempt) === 1 ? 1 : 0,
    } as GenerationCheckpoint;
  }
  return {
    phase,
    generation_attempt: readNonNegativeInteger(raw.generation_attempt),
    ...(typeof raw.output === 'string' ? { output: raw.output } : {}),
    ...(typeof raw.resource_id === 'string'
      ? { resource_id: raw.resource_id }
      : {}),
    ...(typeof raw.version_id === 'string'
      ? { version_id: raw.version_id }
      : {}),
    ...(typeof raw.revision_attempt === 'number'
      ? { revision_attempt: readNonNegativeInteger(raw.revision_attempt) }
      : {}),
    ...(Array.isArray(raw.unsupported_claims)
      ? {
          unsupported_claims: raw.unsupported_claims.flatMap((value) => {
            if (typeof value !== 'object' || value === null) return [];
            const claim = value as Record<string, unknown>;
            return typeof claim.claim_id === 'string' &&
              typeof claim.claim_text === 'string'
              ? [
                  {
                    claim_id: claim.claim_id,
                    claim_text: claim.claim_text,
                  },
                ]
              : [];
          }),
        }
      : {}),
  };
}

function isRevisionPhase(phase: GenerationPhase): boolean {
  return (
    phase === 'revision_required' ||
    phase === 'revision_retrieved' ||
    phase === 'revision_model_started' ||
    phase === 'revision_model_completed'
  );
}

function isAtomicContentWorkflow(
  workflowType: WorkflowType,
): workflowType is
  | WorkflowType.CONTENT
  | WorkflowType.REWRITE
  | WorkflowType.EXPAND
  | WorkflowType.COMPRESS {
  return (
    workflowType === WorkflowType.CONTENT ||
    workflowType === WorkflowType.REWRITE ||
    workflowType === WorkflowType.EXPAND ||
    workflowType === WorkflowType.COMPRESS
  );
}

function isStrict(job: ClaimedWorkflowJob): boolean {
  return job.input?.strict_citation !== false;
}

function isAtomicPhase(
  phase: GenerationPhase | undefined,
): phase is
  | 'atomic_revision_required'
  | 'atomic_revision_retrieved'
  | 'atomic_revision_model_started'
  | 'atomic_sealed'
  | 'atomic_shadow_complete' {
  return (
    phase === 'atomic_revision_required' ||
    phase === 'atomic_revision_retrieved' ||
    phase === 'atomic_revision_model_started' ||
    phase === 'atomic_sealed' ||
    phase === 'atomic_shadow_complete'
  );
}

function readModelOperationIdentity(
  value: unknown,
): ModelOperationIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const identity = value as Record<string, unknown>;
  const nullableIdentifiers = [identity.schema_id, identity.schema_version];
  const nullableHashes = [identity.schema_sha256];
  if (
    identity.version !== 'model-operation.v1' ||
    !isLowerSha256(identity.operation_key) ||
    !isLowerSha256(identity.request_fingerprint) ||
    !isLowerSha256(identity.prompt_sha256) ||
    !isSafeModelIdentifier(identity.provider) ||
    !isSafeModelIdentifier(identity.model) ||
    nullableIdentifiers.some(
      (item) => item !== null && !isSafeModelIdentifier(item),
    ) ||
    nullableHashes.some((item) => item !== null && !isLowerSha256(item))
  ) {
    return null;
  }
  return identity as unknown as ModelOperationIdentity;
}

function sameModelOperationIdentity(
  left: ModelOperationIdentity | null,
  right: ModelOperationIdentity,
): boolean {
  return (
    left !== null &&
    left.version === right.version &&
    left.operation_key === right.operation_key &&
    left.request_fingerprint === right.request_fingerprint &&
    left.prompt_sha256 === right.prompt_sha256 &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.schema_id === right.schema_id &&
    left.schema_version === right.schema_version &&
    left.schema_sha256 === right.schema_sha256
  );
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeModelIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  );
}

function atomicRevisionCheckpoint(
  phase: 'atomic_revision_required' | 'atomic_revision_retrieved',
  generationAttempt: number,
  outcome: Extract<AtomicGroundingOutcome, { kind: 'revision_required' }>,
): GenerationCheckpoint {
  return {
    phase,
    generation_attempt: generationAttempt,
    revision_attempt: 1,
    canonical_proposal: outcome.canonical_proposal,
    candidate_claim_keys: outcome.unsupported_claims.map(
      (claim) => claim.candidate_claim_key,
    ),
    source_claim_texts: outcome.unsupported_claims.map(
      (claim) => claim.source_claim_text_nfc,
    ),
    reason_codes: outcome.unsupported_claims.map((claim) => claim.reason_code),
    non_target_invariant_digests: outcome.non_target_invariant_digests,
    base_retrieval_run_id: outcome.base_retrieval_run_id,
  };
}

function atomicSealedCheckpoint(
  candidate: SealedGroundedCandidateV1,
): GenerationCheckpoint {
  return {
    phase: 'atomic_sealed',
    generation_attempt: candidate.workflow.generation_attempt,
    revision_attempt: candidate.workflow.revision_attempt,
    sealed_candidate: candidate,
  };
}

function requireSealedOutcome(
  outcome: AtomicGroundingOutcome,
  revisionAttempt: 0 | 1,
): SealedGroundedCandidateV1 {
  if (outcome.kind === 'sealed') return outcome.candidate;
  if (outcome.kind === 'revision_required') {
    throw atomicRuntimeFailure(
      revisionAttempt === 1
        ? 'REVISION_EXHAUSTED'
        : 'REVISION_INVARIANT_VIOLATION',
      revisionAttempt,
      outcome.unsupported_claims.map((claim) => claim.candidate_claim_key),
    );
  }
  throw atomicRuntimeFailure(
    outcome.reason_code,
    revisionAttempt,
    outcome.candidate_claim_keys,
  );
}

function atomicRuntimeFailure(
  reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
  candidateClaimKeys: string[] = [],
): AtomicGroundingRuntimeError {
  return new AtomicGroundingRuntimeError(
    reason,
    revisionAttempt,
    candidateClaimKeys,
  );
}

function revisionClaimText(
  checkpointValue: GenerationCheckpoint,
  index: number,
): string {
  const value = checkpointValue.source_claim_texts?.[index];
  if (typeof value !== 'string' || value.length === 0) {
    throw atomicRuntimeFailure('REVISION_INVARIANT_VIOLATION', 1);
  }
  return value;
}

function assertAtomicCandidate(
  job: ClaimedWorkflowJob,
  candidate: SealedGroundedCandidateV1,
): void {
  if (
    candidate.contract_version !== 'atomic:v1' ||
    candidate.workflow.workflow_job_id !== job.id ||
    candidate.workflow.project_id !== job.projectId ||
    candidate.workflow.workflow_type !== String(job.workflowType) ||
    candidate.server_output.utf8_byte_length !==
      Buffer.byteLength(candidate.server_output.text, 'utf8') ||
    candidate.server_output.utf16_length !==
      candidate.server_output.text.length ||
    Buffer.byteLength(candidate.server_output.text, 'utf8') >
      MAX_MODEL_OUTPUT_BYTES
  ) {
    throw atomicRuntimeFailure('ENVELOPE_INVALID', 0);
  }
}

function* chunkAtomicOutput(text: string): Generator<string> {
  let chunk = '';
  let bytes = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (bytes > 0 && bytes + codePointBytes > MAX_ATOMIC_TOKEN_BYTES) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
    chunk += codePoint;
    bytes += codePointBytes;
  }
  if (chunk.length > 0) yield chunk;
}

function validateEmittedUtf16(text: string, value: unknown): number {
  const emitted = readNonNegativeInteger(value);
  if (
    emitted > text.length ||
    (emitted > 0 &&
      emitted < text.length &&
      isHighSurrogate(text.charCodeAt(emitted - 1)) &&
      isLowSurrogate(text.charCodeAt(emitted)))
  ) {
    throw atomicRuntimeFailure('ENVELOPE_INVALID', 0);
  }
  return emitted;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function revisionCheckpoint(
  phase:
    | 'revision_retrieved'
    | 'revision_model_started'
    | 'revision_model_completed',
  generationAttempt: number,
  revisionAttempt: number,
  output: string,
  unsupportedClaims: UnsupportedGroundingClaim[],
): GenerationCheckpoint {
  return {
    phase,
    generation_attempt: generationAttempt,
    revision_attempt: revisionAttempt,
    output,
    unsupported_claims: unsupportedClaims,
  };
}

function missingDomainCommit(
  checkpointValue: GenerationCheckpoint,
): WorkflowDomainCommitResult {
  if (!checkpointValue.resource_id) {
    throw new BadRequestException('工作流检查点缺少 resource_id');
  }
  return {
    resourceId: checkpointValue.resource_id,
    ...(checkpointValue.version_id
      ? { versionId: checkpointValue.version_id }
      : {}),
  };
}

function assertGenerationWorkflow(type: WorkflowType): void {
  switch (type) {
    case WorkflowType.DIRECTORY:
    case WorkflowType.OUTLINE:
    case WorkflowType.CONTENT:
    case WorkflowType.REWRITE:
    case WorkflowType.EXPAND:
    case WorkflowType.COMPRESS:
      return;
    default:
      throw new BadRequestException(`当前 worker 尚不支持 ${type} 工作流`);
  }
}

export function parseGeneratedDirectory(
  rawContent: string,
): DirectoryNodeDto[] {
  const parsed = parseGeneratedJson(rawContent);
  const roots = asRecord(parsed).nodes;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new BadRequestException('目录格式错误：缺少 nodes 字段');
  }
  const nodes: DirectoryNodeDto[] = [];
  const ids = new Set<string>();

  const flatten = (rawNodes: unknown[], parentId: string | null) => {
    rawNodes.forEach((rawNode, index) => {
      const node = asRecord(rawNode);
      const nodeId = requireString(node, 'key');
      const title = requireString(node, 'title');
      if (ids.has(nodeId)) {
        throw new BadRequestException(`目录节点标识重复: ${nodeId}`);
      }
      ids.add(nodeId);
      const children = node.children;
      if (children !== undefined && !Array.isArray(children)) {
        throw new BadRequestException(
          `目录节点 children 必须是数组: ${nodeId}`,
        );
      }
      const childNodes = Array.isArray(children) ? children : [];
      nodes.push({
        node_id: nodeId,
        parent_node_id: parentId,
        node_type:
          parentId === null || childNodes.length > 0
            ? DirectoryNodeType.CHAPTER
            : DirectoryNodeType.SECTION,
        order_index: index,
        title,
        ...(typeof node.description === 'string'
          ? { description: node.description }
          : {}),
        ...(typeof node.material_support === 'string'
          ? { material_support: node.material_support }
          : {}),
        ...(typeof node.level === 'string' ? { level_label: node.level } : {}),
      });
      flatten(childNodes, nodeId);
    });
  };
  flatten(roots, null);
  return nodes;
}

function parseGeneratedJson(rawContent: string): unknown {
  const cleaned = rawContent
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const json =
    start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new BadRequestException('目录内容解析失败');
  }
}

function requireInput(job: ClaimedWorkflowJob): Record<string, unknown> {
  if (job.input === null) {
    throw new BadRequestException('工作流缺少输入');
  }
  return job.input;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('工作流数据必须是对象');
  }
  return value as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || item.trim() === '') {
    throw new BadRequestException(`工作流字段 ${key} 不能为空`);
  }
  return item;
}

function event(
  type: string,
  data: Record<string, unknown> | null,
  checkpoint: Record<string, unknown>,
  onPersisted?: () => void,
): WorkflowExecutionEvent {
  return { type, data, checkpoint, ...(onPersisted ? { onPersisted } : {}) };
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

function readNonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function assertTokenWithinLimits(token: string): void {
  if (Buffer.byteLength(token, 'utf8') > MAX_MODEL_TOKEN_BYTES) {
    throw new BadRequestException('模型单次输出片段超过限制');
  }
}
