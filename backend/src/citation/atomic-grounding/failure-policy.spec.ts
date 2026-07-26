import {
  ATOMIC_GROUNDING_REASON_CODES,
  type AtomicFailureDisposition,
  type AtomicGroundingReasonCode,
} from './contracts.js';
import {
  AtomicGroundingClosedFailure,
  AtomicGroundingExecutionFailure,
  dispositionForAtomicFailure,
  failClosedUnknownAtomicError,
} from './failure-policy.js';

const waitingStructured = (
  internal_reason: AtomicGroundingReasonCode,
): AtomicFailureDisposition => ({
  internal_reason,
  public_code: 'STRUCTURED_OUTPUT_INVALID',
  transition: 'WAITING_MATERIAL',
});

const waitingMaterial = (
  internal_reason: AtomicGroundingReasonCode,
): AtomicFailureDisposition => ({
  internal_reason,
  public_code: 'MATERIAL_GAP',
  transition: 'WAITING_MATERIAL',
});

const revisionSensitive = (
  internal_reason: AtomicGroundingReasonCode,
  attempt: 0 | 1,
): AtomicFailureDisposition =>
  attempt === 0
    ? {
        internal_reason,
        public_code: 'GROUNDING_REVISION_REQUIRED',
        transition: 'REVISION_REQUIRED',
      }
    : waitingMaterial(internal_reason);

function expected(
  reason: AtomicGroundingReasonCode,
  attempt: 0 | 1,
): AtomicFailureDisposition {
  switch (reason) {
    case 'SCHEMA_INVALID':
    case 'RENDER_GRAPH_INVALID':
      return waitingStructured(reason);
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
      return revisionSensitive(reason, attempt);
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
}

describe('atomic failure policy', () => {
  it('defines a duplicate-free closed reason-code tuple', () => {
    expect(new Set(ATOMIC_GROUNDING_REASON_CODES).size).toBe(
      ATOMIC_GROUNDING_REASON_CODES.length,
    );
  });

  it.each([0, 1] as const)(
    'maps every reason exactly at revision attempt %i',
    (attempt) => {
      for (const reason of ATOMIC_GROUNDING_REASON_CODES) {
        expect(dispositionForAtomicFailure(reason, attempt)).toEqual(
          expected(reason, attempt),
        );
      }
    },
  );

  it('fails unknown exceptions closed without leaking their message', () => {
    const secret = 'fixture-secret-error-message';
    const disposition = failClosedUnknownAtomicError();

    expect(disposition).toEqual({
      internal_reason: 'INTERNAL_FAIL_CLOSED',
      public_code: 'ATOMIC_GROUNDING_FAILED',
      transition: 'FAILED',
    });
    expect(JSON.stringify({ disposition, caught: undefined })).not.toContain(
      secret,
    );
  });

  it('rejects a forged reason outside the closed tuple', () => {
    expect(
      () =>
        new AtomicGroundingClosedFailure(
          'SECRET_REASON' as AtomicGroundingReasonCode,
        ),
    ).toThrow('ATOMIC_GROUNDING_CLOSED_FAILURE_INVALID');
  });

  it('derives disposition only from an explicit closed reason and revision attempt', () => {
    expect(
      new AtomicGroundingExecutionFailure('ATOM_EXACT_MISMATCH', 0).disposition,
    ).toEqual({
      internal_reason: 'ATOM_EXACT_MISMATCH',
      public_code: 'GROUNDING_REVISION_REQUIRED',
      transition: 'REVISION_REQUIRED',
    });
    expect(
      new AtomicGroundingExecutionFailure('ATOM_EXACT_MISMATCH', 1).disposition,
    ).toEqual({
      internal_reason: 'ATOM_EXACT_MISMATCH',
      public_code: 'MATERIAL_GAP',
      transition: 'WAITING_MATERIAL',
    });
    expect(
      () =>
        new AtomicGroundingExecutionFailure('ATOM_EXACT_MISMATCH', 2 as 0 | 1),
    ).toThrow('ATOMIC_GROUNDING_REVISION_ATTEMPT_INVALID');
  });
});
