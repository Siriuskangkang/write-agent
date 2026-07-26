import { Inject, Injectable } from '@nestjs/common';
import { AgentService } from '../../agent/agent.service.js';
import type {
  GroundedDraftModelInput,
  PreparedGroundedDraft,
} from '../../agent/chains/grounded-draft.chain.js';
import { ModelGatewayError } from '../../llm/model-gateway.js';
import type { ModelOperationIdentity } from '../../llm/model-types.js';
import {
  GROUNDING_EVIDENCE_STORE,
  type GroundingAssignmentSnapshot,
  type GroundingEvidenceStore,
} from '../citation-ledger.service.js';
import {
  ATOMIC_GROUNDING_CONTRACT_VERSION,
  GROUNDED_DRAFT_SCHEMA_VERSION,
  NON_TARGET_INVARIANT_VERSION,
  type AtomicGroundingReasonCode,
  type AtomicVerificationResult,
  type AtomicVerifiedClaimV1,
  type GroundedDraftProposal,
  type SealedApprovedRenderContextV1,
  type SealedGroundedCandidateV1,
} from './contracts.js';
import { digestCanonicalV1 } from './canonical-json.js';
import { GROUNDED_DRAFT_SCHEMA } from './grounded-draft.schema.js';
import {
  AtomicGroundingVerifier,
  AtomicVerificationFailure,
} from './atomic-grounding.verifier.js';
import { renderAtomicDraftV1 } from './atomic-renderer.js';
import {
  parseSealedGroundedCandidateWorkflowV1,
  recoverSealedGroundedCandidateV1,
  sealGroundedCandidateV1,
  validateTargetedRevisionV1,
} from './sealed-grounded-candidate.js';
import {
  AtomicGroundingClosedFailure,
  AtomicGroundingExecutionFailure,
  dispositionForAtomicFailure,
  failClosedUnknownAtomicError,
} from './failure-policy.js';
import { ApprovedRenderContextService } from './approved-render-context.service.js';
import { AtomicGroundingMetricsRecorder } from './atomic-grounding.metrics.js';

export interface AtomicGroundingGenerationInput {
  workflow_job_id: string;
  project_id: string;
  workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
  generation_attempt: number;
  revision_attempt: 0 | 1;
  authoring_context: Record<string, unknown>;
  signal: AbortSignal;
  revision?: GroundedDraftModelInput['revision'];
  persist_sealed_candidate?: (
    candidate: SealedGroundedCandidateV1,
  ) => Promise<void>;
  model_request_idempotency_key?: string;
}

export type AtomicGroundingOutcome =
  | { kind: 'sealed'; candidate: SealedGroundedCandidateV1 }
  | {
      kind: 'revision_required';
      canonical_proposal: GroundedDraftProposal;
      unsupported_claims: Array<{
        candidate_claim_key: string;
        source_claim_text_nfc: string;
        reason_code: AtomicGroundingReasonCode;
      }>;
      non_target_invariant_digests: Record<string, string>;
      base_retrieval_run_id: string;
    }
  | {
      kind: 'material_gap';
      reason_code: AtomicGroundingReasonCode;
      candidate_claim_keys: string[];
    };

export interface AtomicGroundingRecoveryInput {
  workflow_job_id: string;
  project_id: string;
  checkpoint: unknown;
}

export interface PreparedAtomicGroundingGeneration {
  input: AtomicGroundingGenerationInput;
  assignment: GroundingAssignmentSnapshot;
  render_context: SealedApprovedRenderContextV1;
  draft: PreparedGroundedDraft;
  model_identity: ModelOperationIdentity;
}

export class AtomicGroundingCoordinatorError extends AtomicGroundingExecutionFailure {
  constructor(
    reason: AtomicGroundingReasonCode,
    revisionAttempt: 0 | 1,
    candidateClaimKeys: string[] = [],
  ) {
    super(reason, revisionAttempt, candidateClaimKeys);
    this.name = 'AtomicGroundingCoordinatorError';
  }
}

@Injectable()
export class AtomicGroundingCoordinator {
  constructor(
    @Inject(GROUNDING_EVIDENCE_STORE)
    private readonly assignmentStore: GroundingEvidenceStore,
    private readonly renderContextService: ApprovedRenderContextService,
    private readonly agentService: AgentService,
    private readonly verifier: AtomicGroundingVerifier,
    private readonly metrics: AtomicGroundingMetricsRecorder,
  ) {}

  async generate(
    input: AtomicGroundingGenerationInput,
    prepared?: PreparedAtomicGroundingGeneration,
  ): Promise<AtomicGroundingOutcome> {
    try {
      const assignment =
        prepared?.assignment ?? (await this.loadAssignment(input));
      if (isReason(assignment)) return this.outcome(input, assignment);
      const renderContext =
        prepared?.render_context ??
        (await this.renderContextService.build({
          workflow_job_id: input.workflow_job_id,
          project_id: input.project_id,
        }));
      const generated = prepared
        ? await this.agentService.completePreparedGroundedDraft(prepared.draft)
        : await this.agentService.generateGroundedDraft(
            this.buildModelInput(input, assignment, renderContext),
            this.buildModelOptions(input),
          );

      let proposal: GroundedDraftProposal;
      try {
        proposal = GROUNDED_DRAFT_SCHEMA.parse(generated.proposal);
      } catch {
        return this.outcome(input, 'SCHEMA_INVALID');
      }
      this.metrics.proposal(
        input.workflow_type,
        proposal.status,
        GROUNDED_DRAFT_SCHEMA_VERSION,
        generated.audit.proposal_bytes,
        proposal.claims.length,
        generated.audit.repair_attempts,
      );

      const verification = this.verifier.verify({
        workflow_job_id: input.workflow_job_id,
        project_id: input.project_id,
        generation_attempt: input.generation_attempt,
        revision_attempt: input.revision_attempt,
        proposal,
        assignment_digest: assignment.snapshot_digest as string,
        evidence: assignment.evidence,
      });
      for (const claim of verification.claims) {
        this.metrics.claim(
          input.workflow_type,
          claim.verification_method,
          claim.support_status,
        );
      }

      if (verification.decision !== 'ALLOW') {
        return this.verificationOutcome(input, verification, assignment);
      }
      if (input.revision_attempt === 1) {
        const reason = this.validateRevision(input, assignment, verification);
        if (reason) return this.outcome(input, reason, verification);
      } else if (input.revision !== undefined) {
        return this.outcome(
          input,
          'REVISION_INVARIANT_VIOLATION',
          verification,
        );
      }

      const renderStartedAt = Date.now();
      try {
        renderAtomicDraftV1({
          verification,
          render_context: renderContext,
        });
      } catch {
        return this.outcome(input, 'RENDER_FAILED', verification);
      }
      const renderMilliseconds = Math.max(0, Date.now() - renderStartedAt);
      this.metrics.renderLatency(input.workflow_type, renderMilliseconds);

      let candidate: SealedGroundedCandidateV1;
      try {
        candidate = sealGroundedCandidateV1({
          workflow: {
            workflow_job_id: input.workflow_job_id,
            project_id: input.project_id,
            workflow_type: input.workflow_type,
            generation_attempt: input.generation_attempt,
            revision_attempt: input.revision_attempt,
          },
          verification,
          assignment,
          render_context: renderContext,
        });
      } catch {
        return this.outcome(input, 'ENVELOPE_INVALID', verification);
      }
      if (input.revision_attempt === 1) {
        this.metrics.revision('sealed');
        if (input.persist_sealed_candidate) {
          try {
            await input.persist_sealed_candidate(candidate);
          } catch (error: unknown) {
            throw new AtomicSealedPersistenceError(error);
          }
        }
      }
      return { kind: 'sealed', candidate };
    } catch (error: unknown) {
      if (error instanceof AtomicSealedPersistenceError) throw error.cause;
      if (error instanceof AtomicGroundingCoordinatorError) throw error;
      const reason = knownReason(error);
      if (reason) return this.outcome(input, reason);
      const disposition = failClosedUnknownAtomicError();
      this.metrics.failClosed(input.workflow_type, disposition.internal_reason);
      throw new AtomicGroundingCoordinatorError(
        disposition.internal_reason,
        input.revision_attempt,
      );
    }
  }

  async prepareRevisionModel(
    input: AtomicGroundingGenerationInput,
  ): Promise<PreparedAtomicGroundingGeneration> {
    if (input.revision_attempt !== 1 || !input.revision) {
      throw new AtomicGroundingCoordinatorError(
        'REVISION_INVARIANT_VIOLATION',
        1,
      );
    }
    try {
      const assignment = await this.loadAssignment(input);
      if (isReason(assignment)) {
        throw new AtomicGroundingCoordinatorError(assignment, 1);
      }
      const renderContext = await this.renderContextService.build({
        workflow_job_id: input.workflow_job_id,
        project_id: input.project_id,
      });
      const draft = this.agentService.prepareGroundedDraft(
        this.buildModelInput(input, assignment, renderContext),
        this.buildModelOptions(input),
      );
      return {
        input,
        assignment,
        render_context: renderContext,
        draft,
        model_identity: draft.operation.identity,
      };
    } catch (error: unknown) {
      if (error instanceof AtomicGroundingCoordinatorError) throw error;
      const reason = knownReason(error);
      if (reason) throw new AtomicGroundingCoordinatorError(reason, 1);
      const disposition = failClosedUnknownAtomicError();
      this.metrics.failClosed(input.workflow_type, disposition.internal_reason);
      throw new AtomicGroundingCoordinatorError(disposition.internal_reason, 1);
    }
  }

  executePreparedRevision(
    prepared: PreparedAtomicGroundingGeneration,
  ): Promise<AtomicGroundingOutcome> {
    return this.generate(prepared.input, prepared);
  }

  async inspectRevisionModelAttempt(
    workflowJobId: string,
    operation: string | ModelOperationIdentity,
  ): Promise<'absent' | 'recorded' | 'mismatch' | 'unknown'> {
    return this.agentService.inspectGroundedDraftOperation(
      workflowJobId,
      operation,
    );
  }

  private buildModelInput(
    input: AtomicGroundingGenerationInput,
    assignment: GroundingAssignmentSnapshot,
    renderContext: SealedApprovedRenderContextV1,
  ): GroundedDraftModelInput {
    return {
      workflow_type: input.workflow_type,
      workflow_job_id: input.workflow_job_id,
      generation_attempt: input.generation_attempt,
      revision_attempt: input.revision_attempt,
      authoring_context: input.authoring_context,
      approved_render_context: renderContext,
      evidence: assignment.evidence.map((item) => ({
        evidence_id: item.evidence_id,
        exact_span_text: item.exact_span_text,
        source_boundary: 'untrusted_evidence',
      })),
      ...(input.revision ? { revision: input.revision } : {}),
    };
  }

  private buildModelOptions(input: AtomicGroundingGenerationInput): {
    signal: AbortSignal;
    trace: {
      workflow_job_id: string;
      node: string;
      attempt: number;
    };
    request_idempotency_key?: string;
  } {
    return {
      signal: input.signal,
      trace: {
        workflow_job_id: input.workflow_job_id,
        node:
          input.revision_attempt === 1
            ? 'atomic_grounded_revision'
            : 'atomic_grounded_draft',
        attempt: input.generation_attempt,
      },
      ...(input.model_request_idempotency_key
        ? {
            request_idempotency_key: input.model_request_idempotency_key,
          }
        : {}),
    };
  }

  async recover(
    input: AtomicGroundingRecoveryInput,
  ): Promise<AtomicGroundingOutcome> {
    let recoveryGenerationInput: AtomicGroundingGenerationInput = {
      workflow_job_id: input.workflow_job_id,
      project_id: input.project_id,
      workflow_type: 'content',
      generation_attempt: 0,
      revision_attempt: 0,
      authoring_context: {},
      signal: new AbortController().signal,
    };
    try {
      const workflow = parseSealedGroundedCandidateWorkflowV1(input.checkpoint);
      recoveryGenerationInput = {
        ...recoveryGenerationInput,
        workflow_type: workflow.workflow_type,
        generation_attempt: workflow.generation_attempt,
        revision_attempt: workflow.revision_attempt,
      };
      if (
        workflow.workflow_job_id !== input.workflow_job_id ||
        workflow.project_id !== input.project_id
      ) {
        return this.outcome(recoveryGenerationInput, 'ENVELOPE_INVALID');
      }
      let assignment: GroundingAssignmentSnapshot | AtomicGroundingReasonCode;
      try {
        assignment = await this.loadAssignment(recoveryGenerationInput);
      } catch {
        return this.outcome(
          recoveryGenerationInput,
          'RECOVERY_ASSIGNMENT_DRIFT',
        );
      }
      if (isReason(assignment)) {
        return this.outcome(
          recoveryGenerationInput,
          'RECOVERY_ASSIGNMENT_DRIFT',
        );
      }
      let renderContext: SealedApprovedRenderContextV1;
      try {
        renderContext = await this.renderContextService.build({
          workflow_job_id: input.workflow_job_id,
          project_id: input.project_id,
        });
      } catch {
        return this.outcome(
          recoveryGenerationInput,
          'RECOVERY_RENDER_CONTEXT_DRIFT',
        );
      }
      const candidate = recoverSealedGroundedCandidateV1({
        checkpoint: input.checkpoint,
        current_assignment: assignment,
        current_render_context: renderContext,
      });
      return { kind: 'sealed', candidate };
    } catch (error: unknown) {
      if (error instanceof AtomicGroundingCoordinatorError) throw error;
      const reason = knownReason(error) ?? 'ENVELOPE_INVALID';
      return this.outcome(recoveryGenerationInput, reason);
    }
  }

  private async loadAssignment(
    input: AtomicGroundingGenerationInput,
  ): Promise<GroundingAssignmentSnapshot | AtomicGroundingReasonCode> {
    const assignment = await this.assignmentStore.loadAssignment(
      input.workflow_job_id,
    );
    if (!assignment) return 'ASSIGNMENT_MISSING';
    if (
      assignment.contract_version !== ATOMIC_GROUNDING_CONTRACT_VERSION ||
      assignment.strict_mode !== true
    ) {
      return 'ASSIGNMENT_CONTRACT_MISMATCH';
    }
    if (
      assignment.workflow_job_id !== input.workflow_job_id ||
      assignment.project_id !== input.project_id
    ) {
      return 'ASSIGNMENT_PROJECT_MISMATCH';
    }
    if (assignment.retrieval_state === 'NO_HIT') return 'NO_HIT';
    if (
      assignment.retrieval_state !== 'READY' &&
      assignment.retrieval_state !== 'DEGRADED'
    ) {
      return 'RETRIEVAL_STATE_INVALID';
    }
    if (
      assignment.targeted_revision_attempts !== input.revision_attempt ||
      typeof assignment.snapshot_digest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(assignment.snapshot_digest)
    ) {
      return 'ASSIGNMENT_SNAPSHOT_DRIFT';
    }
    if (assignment.evidence.length === 0) return 'NO_EVIDENCE';
    const evidenceIds = new Set<string>();
    const runRefs = new Set(
      assignment.retrieval_run_refs ?? [assignment.retrieval_run_id],
    );
    for (const evidence of assignment.evidence) {
      if (
        evidence.project_id !== input.project_id ||
        !runRefs.has(evidence.retrieval_run_id)
      ) {
        return 'EVIDENCE_OWNERSHIP_INVALID';
      }
      if (
        evidenceIds.has(evidence.evidence_id) ||
        typeof evidence.evidence_snapshot_digest !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(evidence.evidence_snapshot_digest) ||
        typeof evidence.exact_span_text !== 'string' ||
        evidence.exact_span_text.length === 0
      ) {
        return 'EVIDENCE_SNAPSHOT_DRIFT';
      }
      evidenceIds.add(evidence.evidence_id);
    }
    return assignment;
  }

  private verificationOutcome(
    input: AtomicGroundingGenerationInput,
    verification: AtomicVerificationResult,
    assignment: GroundingAssignmentSnapshot,
  ): AtomicGroundingOutcome {
    const reason = verification.material_gap_reason ?? 'INTERNAL_FAIL_CLOSED';
    if (
      verification.decision === 'TARGETED_RETRIEVAL_REVISION' &&
      input.revision_attempt === 0
    ) {
      const unsupportedClaims = unsupported(verification);
      if (unsupportedClaims.length > 0) {
        this.metrics.failClosed(input.workflow_type, reason);
        this.metrics.revision('required');
        const allowed = new Set(
          unsupportedClaims.map((claim) => claim.candidate_claim_key),
        );
        return {
          kind: 'revision_required',
          canonical_proposal: verification.canonical_proposal,
          unsupported_claims: unsupportedClaims,
          non_target_invariant_digests: invariantDigests(verification, allowed),
          base_retrieval_run_id: assignment.retrieval_run_id,
        };
      }
    }
    if (input.revision_attempt === 1) {
      this.metrics.revision('exhausted');
      return this.outcome(input, 'REVISION_EXHAUSTED', verification);
    }
    return this.outcome(input, reason, verification);
  }

  private validateRevision(
    input: AtomicGroundingGenerationInput,
    assignment: GroundingAssignmentSnapshot,
    next: AtomicVerificationResult,
  ): AtomicGroundingReasonCode | null {
    const revision = input.revision;
    if (!revision || revision.allowed_candidate_claim_keys.length === 0) {
      return 'REVISION_INVARIANT_VIOLATION';
    }
    let baseProposal: GroundedDraftProposal;
    try {
      baseProposal = GROUNDED_DRAFT_SCHEMA.parse(revision.base_proposal);
    } catch {
      return 'REVISION_INVARIANT_VIOLATION';
    }
    const base = this.verifier.verify({
      workflow_job_id: input.workflow_job_id,
      project_id: input.project_id,
      generation_attempt: input.generation_attempt,
      revision_attempt: 0,
      proposal: baseProposal,
      assignment_digest: assignment.snapshot_digest as string,
      evidence: assignment.evidence,
    });
    const allowed = new Set(revision.allowed_candidate_claim_keys);
    if (allowed.size !== revision.allowed_candidate_claim_keys.length) {
      return 'REVISION_INVARIANT_VIOLATION';
    }
    const expectedInvariants = invariantDigests(base, allowed);
    if (
      !sameClosedMap(expectedInvariants, revision.non_target_invariant_digests)
    ) {
      return 'REVISION_INVARIANT_VIOLATION';
    }
    try {
      validateTargetedRevisionV1(
        {
          verification: base,
          allowed_candidate_claim_keys: revision.allowed_candidate_claim_keys,
          proposal_digest: digestCanonicalV1(
            GROUNDED_DRAFT_SCHEMA_VERSION,
            base.canonical_proposal,
          ),
        },
        next,
      );
      return null;
    } catch {
      return 'REVISION_INVARIANT_VIOLATION';
    }
  }

  private outcome(
    input: AtomicGroundingGenerationInput,
    reason: AtomicGroundingReasonCode,
    verification?: AtomicVerificationResult,
  ): AtomicGroundingOutcome {
    const disposition = dispositionForAtomicFailure(
      reason,
      input.revision_attempt,
    );
    this.metrics.failClosed(input.workflow_type, disposition.internal_reason);
    if (disposition.transition === 'FAILED') {
      throw new AtomicGroundingCoordinatorError(
        disposition.internal_reason,
        input.revision_attempt,
      );
    }
    this.metrics.materialGap(disposition.internal_reason);
    return {
      kind: 'material_gap',
      reason_code: disposition.internal_reason,
      candidate_claim_keys:
        verification?.claims.map((claim) => claim.candidate_claim_key) ?? [],
    };
  }
}

class AtomicSealedPersistenceError extends Error {
  constructor(readonly cause: unknown) {
    super('ATOMIC_SEALED_PERSISTENCE_FAILED');
    this.name = 'AtomicSealedPersistenceError';
  }
}

function unsupported(verification: AtomicVerificationResult): Array<{
  candidate_claim_key: string;
  source_claim_text_nfc: string;
  reason_code: AtomicGroundingReasonCode;
}> {
  return verification.claims
    .filter((claim) => claim.support_status !== 'SUPPORTED')
    .map((claim) => ({
      candidate_claim_key: claim.candidate_claim_key,
      source_claim_text_nfc: claim.canonical_claim_base.source_claim_text_nfc,
      reason_code:
        claim.reason_codes[0] ??
        verification.material_gap_reason ??
        'INTERNAL_FAIL_CLOSED',
    }));
}

function invariantDigests(
  verification: AtomicVerificationResult,
  excluded: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const claims = verification.claims
    .filter((claim) => !excluded.has(claim.candidate_claim_key))
    .sort((left, right) =>
      left.candidate_claim_key.localeCompare(right.candidate_claim_key),
    );
  for (const claim of claims) {
    result[claim.candidate_claim_key] = invariantDigest(claim);
  }
  return result;
}

function invariantDigest(claim: AtomicVerifiedClaimV1): string {
  const { revision, ...canonicalClaimWithoutRevision } =
    claim.canonical_claim_base;
  void revision;
  return digestCanonicalV1(NON_TARGET_INVARIANT_VERSION, {
    candidate_claim_key: claim.candidate_claim_key,
    canonical_claim_without_revision: canonicalClaimWithoutRevision,
    evidence_refs: [...claim.evidence_refs].sort((left, right) =>
      left.evidence_id.localeCompare(right.evidence_id),
    ),
    fragment_ordinal: claim.canonical_claim_base.fragment.ordinal,
    presentation: claim.canonical_claim_base.fragment.presentation,
    previous_structure_id:
      claim.canonical_claim_base.fragment.previous_structure_id,
    next_structure_id: claim.canonical_claim_base.fragment.next_structure_id,
  });
}

function sameClosedMap(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort();
  const rightEntries = Object.entries(right).sort();
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value,
    )
  );
}

function isReason(
  value: GroundingAssignmentSnapshot | AtomicGroundingReasonCode,
): value is AtomicGroundingReasonCode {
  return typeof value === 'string';
}

function knownReason(error: unknown): AtomicGroundingReasonCode | null {
  if (error instanceof AtomicGroundingClosedFailure) {
    return error.reason;
  }
  if (error instanceof AtomicVerificationFailure) {
    return error.disposition.internal_reason;
  }
  if (
    error instanceof ModelGatewayError &&
    error.modelError.code === 'STRUCTURED_OUTPUT_INVALID'
  ) {
    return 'SCHEMA_INVALID';
  }
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case 'RENDER_CONTEXT_INVALID':
      return 'RENDER_CONTEXT_INVALID';
    case 'RENDER_FAILED':
      return 'RENDER_FAILED';
    case 'REVISION_INVARIANT_VIOLATION':
      return 'REVISION_INVARIANT_VIOLATION';
    case 'SEALED_CANDIDATE_INVALID':
      return 'ENVELOPE_INVALID';
    default:
      return null;
  }
}
