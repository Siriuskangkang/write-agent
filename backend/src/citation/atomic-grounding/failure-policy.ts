import { BadRequestException } from '@nestjs/common';
import { ATOMIC_GROUNDING_REASON_CODES } from './contracts.js';
import type {
  AtomicFailureDisposition,
  AtomicGroundingReasonCode,
} from './contracts.js';

export class AtomicGroundingExecutionFailure extends Error {
  readonly reason: AtomicGroundingReasonCode;
  readonly revisionAttempt: 0 | 1;
  readonly candidateClaimKeys: string[];
  readonly disposition: AtomicFailureDisposition;

  constructor(
    reason: AtomicGroundingReasonCode,
    revisionAttempt: 0 | 1,
    candidateClaimKeys: string[] = [],
  ) {
    if (revisionAttempt !== 0 && revisionAttempt !== 1) {
      throw new TypeError('ATOMIC_GROUNDING_REVISION_ATTEMPT_INVALID');
    }
    const trustedDisposition = dispositionForAtomicFailure(
      reason,
      revisionAttempt,
    );
    super(trustedDisposition.public_code);
    this.name = 'AtomicGroundingExecutionFailure';
    this.reason = trustedDisposition.internal_reason;
    this.revisionAttempt = revisionAttempt;
    this.candidateClaimKeys = [...candidateClaimKeys];
    this.disposition = trustedDisposition;
  }
}

export class AtomicGroundingClosedFailure extends BadRequestException {
  constructor(
    readonly reason: AtomicGroundingReasonCode,
    legacyMessage = 'ATOMIC_GROUNDING_CLOSED_FAILURE',
  ) {
    if (!ATOMIC_GROUNDING_REASON_CODES.includes(reason)) {
      throw new TypeError('ATOMIC_GROUNDING_CLOSED_FAILURE_INVALID');
    }
    super(legacyMessage);
    this.name = 'AtomicGroundingClosedFailure';
  }
}

function waitingMaterial(
  internal_reason: AtomicGroundingReasonCode,
): AtomicFailureDisposition {
  return {
    internal_reason,
    public_code: 'MATERIAL_GAP',
    transition: 'WAITING_MATERIAL',
  };
}

function revisionSensitive(
  internal_reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
): AtomicFailureDisposition {
  return revisionAttempt === 0
    ? {
        internal_reason,
        public_code: 'GROUNDING_REVISION_REQUIRED',
        transition: 'REVISION_REQUIRED',
      }
    : waitingMaterial(internal_reason);
}

function assertNever(value: never): never {
  throw new Error(`unreachable atomic failure reason: ${String(value)}`);
}

export function dispositionForAtomicFailure(
  reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
): AtomicFailureDisposition {
  switch (reason) {
    case 'SCHEMA_INVALID':
    case 'RENDER_GRAPH_INVALID':
      return {
        internal_reason: reason,
        public_code: 'STRUCTURED_OUTPUT_INVALID',
        transition: 'WAITING_MATERIAL',
      };
    case 'NO_EVIDENCE':
    case 'INSUFFICIENT_EVIDENCE':
    case 'AMBIGUOUS_EVIDENCE':
    case 'UNSUPPORTED_QUANTIFIER':
    case 'EMPTY_STRICT_DRAFT':
    case 'ASSIGNMENT_MISSING':
    case 'ASSIGNMENT_CONTRACT_MISMATCH':
    case 'ASSIGNMENT_PROJECT_MISMATCH':
    case 'ASSIGNMENT_SNAPSHOT_DRIFT':
    case 'NO_HIT':
    case 'RETRIEVAL_STATE_INVALID':
    case 'EVIDENCE_OWNERSHIP_INVALID':
    case 'EVIDENCE_INGESTION_INACTIVE':
    case 'EVIDENCE_OFFSET_DRIFT':
    case 'EVIDENCE_RUN_DRIFT':
    case 'EVIDENCE_LEGACY_AMBIGUOUS':
    case 'EVIDENCE_SNAPSHOT_DRIFT':
    case 'RENDER_CONTEXT_INVALID':
    case 'RENDER_FAILED':
    case 'REVISION_INVARIANT_VIOLATION':
    case 'REVISION_EXHAUSTED':
    case 'ENVELOPE_INVALID':
    case 'ENVELOPE_DIGEST_MISMATCH':
    case 'RECOVERY_ASSIGNMENT_DRIFT':
    case 'RECOVERY_RENDER_CONTEXT_DRIFT':
      return waitingMaterial(reason);
    case 'EVIDENCE_UNKNOWN':
    case 'EVIDENCE_NOT_SELECTED':
    case 'ATOM_ANCHOR_MISMATCH':
    case 'ATOM_POLARITY_MISMATCH':
    case 'ATOM_QUANTIFIER_MISMATCH':
    case 'ATOM_QUANTITY_MISMATCH':
    case 'ATOM_EXACT_MISMATCH':
    case 'ATOM_TYPED_SKELETON_MISMATCH':
    case 'ATOM_EVIDENCE_MOSAIC_UNSUPPORTED':
      return revisionSensitive(reason, revisionAttempt);
    case 'ATOMIC_GROUNDING_DISABLED':
      return {
        internal_reason: reason,
        public_code: 'ATOMIC_GROUNDING_UNAVAILABLE',
        transition: 'FAILED',
      };
    case 'ATOMIC_COMMIT_NOT_AUTHORIZED':
      return {
        internal_reason: reason,
        public_code: 'ATOMIC_COMMIT_NOT_AUTHORIZED',
        transition: 'FAILED',
      };
    case 'INTERNAL_FAIL_CLOSED':
      return {
        internal_reason: reason,
        public_code: 'ATOMIC_GROUNDING_FAILED',
        transition: 'FAILED',
      };
  }
  return assertNever(reason);
}

export function failClosedUnknownAtomicError(): AtomicFailureDisposition {
  return {
    internal_reason: 'INTERNAL_FAIL_CLOSED',
    public_code: 'ATOMIC_GROUNDING_FAILED',
    transition: 'FAILED',
  };
}
