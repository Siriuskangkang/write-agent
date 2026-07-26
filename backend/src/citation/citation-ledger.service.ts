import { Inject, Injectable } from '@nestjs/common';
import {
  GroundingRevisionRequiredError,
  MaterialGapError,
} from './material-gap.error.js';
import {
  GroundingVerifier,
  type AssignedEvidenceSnapshot,
  type GroundingVerificationResult,
} from './grounding-verifier.js';
import type { RetrievalState } from '../retrieval/types.js';
import type { GroundingContractVersion } from './entities/grounding-assignment.entity.js';

export const GROUNDING_EVIDENCE_STORE = Symbol('GROUNDING_EVIDENCE_STORE');

export interface GroundingAssignmentSnapshot {
  workflow_job_id: string;
  project_id: string;
  retrieval_run_id: string;
  retrieval_run_refs?: string[];
  retrieval_state: RetrievalState;
  contract_version: GroundingContractVersion;
  strict_mode: boolean;
  targeted_revision_attempts: number;
  snapshot_digest?: string;
  evidence: AssignedEvidenceSnapshot[];
}

export interface GroundingEvidenceStore {
  loadAssignment(
    workflowJobId: string,
  ): Promise<GroundingAssignmentSnapshot | null>;
  saveLedger(
    manager: unknown,
    resultId: string,
    ledger: GroundingVerificationResult,
  ): Promise<void>;
}

export interface PrepareGroundingInput {
  workflow_job_id: string;
  project_id: string;
  output: string;
}

@Injectable()
export class CitationLedgerService {
  constructor(
    @Inject(GROUNDING_EVIDENCE_STORE)
    private readonly store: GroundingEvidenceStore,
    private readonly verifier: GroundingVerifier,
  ) {}

  async prepare(
    input: PrepareGroundingInput,
  ): Promise<GroundingVerificationResult | null> {
    const assignment = await this.store.loadAssignment(input.workflow_job_id);
    if (!assignment) {
      throw new MaterialGapError('写作任务缺少可审计的证据分配');
    }
    if (assignment.project_id !== input.project_id) {
      throw new Error('Grounding assignment project mismatch');
    }
    const result = await this.verifier.verify({
      workflow_job_id: input.workflow_job_id,
      project_id: input.project_id,
      retrieval_run_id: assignment.retrieval_run_id,
      retrieval_run_refs: assignment.retrieval_run_refs ?? [
        assignment.retrieval_run_id,
      ],
      output: input.output,
      evidence: assignment.evidence,
      strict: assignment.strict_mode,
      targeted_revision_attempts: assignment.targeted_revision_attempts,
      assignment_snapshot_digest: assignment.snapshot_digest,
    });
    const insufficientClaimIds = result.claims
      .filter(
        (claim) =>
          claim.support_status === 'PARTIAL' ||
          claim.support_status === 'UNSUPPORTED' ||
          claim.support_status === 'UNVERIFIABLE',
      )
      .map((claim) => claim.claim_id);
    if (result.decision === 'TARGETED_RETRIEVAL_REVISION') {
      throw new GroundingRevisionRequiredError(
        result.claims
          .filter((claim) => insufficientClaimIds.includes(claim.claim_id))
          .map((claim) => ({
            claim_id: claim.claim_id,
            claim_text: claim.claim_text,
          })),
      );
    }
    if (result.decision === 'WAITING_MATERIAL') {
      throw new MaterialGapError(
        '素材不足，无法支持正文中的关键声明',
        insufficientClaimIds,
      );
    }
    return result;
  }

  async persist(
    manager: unknown,
    resultId: string,
    prepared: GroundingVerificationResult | null,
  ): Promise<void> {
    if (!prepared) return;
    await this.store.saveLedger(manager, resultId, prepared);
  }
}
