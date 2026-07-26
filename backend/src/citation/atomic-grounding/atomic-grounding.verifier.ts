import { createHash } from 'node:crypto';
import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import {
  CANDIDATE_CLAIM_KEY_VERSION,
  CANONICAL_ATOMIC_CLAIM_VERSION,
  GROUNDED_DRAFT_SCHEMA_VERSION,
  type AtomicClaimProposal,
  type AtomicFailureDisposition,
  type AtomicGroundingReasonCode,
  type AtomicVerificationInput,
  type AtomicVerificationResult,
  type AtomicVerifiedClaimV1,
  type CanonicalAtomicClaimV1,
  type CanonicalQuantityV1,
  type GroundedDraftProposal,
  type RecomputedAtomV1,
} from './contracts.js';
import {
  dispositionForAtomicFailure,
  failClosedUnknownAtomicError,
} from './failure-policy.js';
import { GROUNDED_DRAFT_SCHEMA } from './grounded-draft.schema.js';
import {
  type AnalyzedAtomicTextV1,
  analyzeAtomicTextV1,
  recomputeAtomV1,
} from './quantity-lexer.js';

interface EvidenceComparison {
  supported: boolean;
  method: 'exact' | 'typed' | null;
  reason: AtomicGroundingReasonCode | null;
}

export class AtomicVerificationFailure extends Error {
  readonly disposition: AtomicFailureDisposition;

  constructor(disposition: AtomicFailureDisposition) {
    super(disposition.public_code);
    this.name = 'AtomicVerificationFailure';
    this.disposition = disposition;
  }
}

function safeFallbackProposal(): GroundedDraftProposal {
  return {
    schema_version: GROUNDED_DRAFT_SCHEMA_VERSION,
    status: 'material_gap',
    claims: [],
    render_fragments: [],
    ordering: [],
    material_gap: {
      reason_code: 'NO_EVIDENCE',
      missing_topics: [],
    },
  };
}

function decisionFor(
  reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
): AtomicVerificationResult['decision'] {
  const disposition = dispositionForAtomicFailure(reason, revisionAttempt);
  if (disposition.transition === 'REVISION_REQUIRED') {
    return 'TARGETED_RETRIEVAL_REVISION';
  }
  if (disposition.transition === 'WAITING_MATERIAL') {
    return 'WAITING_MATERIAL';
  }
  throw new AtomicVerificationFailure(disposition);
}

function failedResult(
  proposal: GroundedDraftProposal,
  reason: AtomicGroundingReasonCode,
  revisionAttempt: 0 | 1,
  claims: AtomicVerifiedClaimV1[] = [],
): AtomicVerificationResult {
  return {
    decision: decisionFor(reason, revisionAttempt),
    canonical_proposal: proposal,
    claims,
    material_gap_reason: reason,
  };
}

function normalizeExtractText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u3000/gu, ' ')
    .replace(/^ +/u, '')
    .replace(/ +$/u, '')
    .replace(/[。！？!?；;.]$/u, '');
}

function quantityTuple(quantity: CanonicalQuantityV1): string {
  return [
    quantity.dimension,
    quantity.base_value,
    quantity.base_unit ?? '',
    quantity.comparator,
    quantity.range_end_base_value ?? '',
  ].join('\0');
}

function typedSkeleton(
  text: string,
  quantities: CanonicalQuantityV1[],
): string {
  let result = text.normalize('NFC');
  for (let index = quantities.length - 1; index >= 0; index -= 1) {
    const quantity = quantities[index];
    result =
      result.slice(0, quantity.start_utf16) +
      `__Q${index}__` +
      result.slice(quantity.end_utf16);
  }
  return normalizeExtractText(result);
}

function compareOneEvidenceDefault(
  recomputed: RecomputedAtomV1,
  evidenceText: string,
): EvidenceComparison {
  if (
    normalizeExtractText(recomputed.source_claim_text_nfc) ===
    normalizeExtractText(evidenceText)
  ) {
    return { supported: true, method: 'exact', reason: null };
  }
  let evidence: AnalyzedAtomicTextV1;
  try {
    evidence = analyzeAtomicTextV1(evidenceText);
  } catch {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_EXACT_MISMATCH',
    };
  }
  const typedEligible =
    recomputed.quantifier !== 'some' &&
    recomputed.quantifier !== 'other' &&
    evidence.quantifier !== 'some' &&
    evidence.quantifier !== 'other' &&
    evidence.typed_equivalence_eligible &&
    recomputed.quantities.every(
      (quantity) => quantity.typed_equivalence_eligible,
    ) &&
    evidence.quantities.every(
      (quantity) => quantity.typed_equivalence_eligible,
    );
  if (!typedEligible) {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_EXACT_MISMATCH',
    };
  }
  if (recomputed.polarity !== evidence.polarity) {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_POLARITY_MISMATCH',
    };
  }
  if (recomputed.quantifier !== evidence.quantifier) {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_QUANTIFIER_MISMATCH',
    };
  }
  if (
    recomputed.quantities.length !== evidence.quantities.length ||
    recomputed.quantities.some(
      (quantity, index) =>
        quantityTuple(quantity) !== quantityTuple(evidence.quantities[index]),
    )
  ) {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_QUANTITY_MISMATCH',
    };
  }
  if (
    typedSkeleton(recomputed.source_claim_text_nfc, recomputed.quantities) !==
    typedSkeleton(evidence.source_text_nfc, evidence.quantities)
  ) {
    return {
      supported: false,
      method: null,
      reason: 'ATOM_TYPED_SKELETON_MISMATCH',
    };
  }
  return { supported: true, method: 'typed', reason: null };
}

function candidateClaimKey(
  workflowJobId: string,
  generationAttempt: number,
  initialClaimFragmentOrdinal: number,
): string {
  return createHash('sha256')
    .update(CANDIDATE_CLAIM_KEY_VERSION, 'utf8')
    .update('\0', 'utf8')
    .update(workflowJobId.normalize('NFC'), 'utf8')
    .update('\0', 'utf8')
    .update(String(generationAttempt), 'utf8')
    .update('\0', 'utf8')
    .update(String(initialClaimFragmentOrdinal), 'utf8')
    .digest('hex');
}

function structureNeighbor(
  proposal: GroundedDraftProposal,
  ordinal: number,
  direction: -1 | 1,
): string | null {
  const fragments = new Map(
    proposal.render_fragments.map((fragment) => [
      fragment.fragment_id,
      fragment,
    ]),
  );
  for (
    let index = ordinal + direction;
    index >= 0 && index < proposal.ordering.length;
    index += direction
  ) {
    const fragment = fragments.get(proposal.ordering[index]);
    if (fragment?.kind === 'structure_ref') return fragment.structure_id;
  }
  return null;
}

function canonicalClaimBase(
  input: AtomicVerificationInput,
  proposal: GroundedDraftProposal,
  claim: AtomicClaimProposal,
  recomputed: RecomputedAtomV1,
): Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'> {
  const ordinal = proposal.ordering.indexOf(claim.span.fragment_id);
  const fragment = proposal.render_fragments.find(
    (
      item,
    ): item is Extract<
      GroundedDraftProposal['render_fragments'][number],
      { kind: 'claim_ref' }
    > =>
      item.kind === 'claim_ref' && item.fragment_id === claim.span.fragment_id,
  );
  if (ordinal < 0 || !fragment) {
    throw new TypeError('closed render graph invariant violated');
  }
  const candidateKey =
    input.revision_attempt === 1 &&
    claim.revision_of_candidate_claim_key !== null
      ? claim.revision_of_candidate_claim_key
      : candidateClaimKey(
          input.workflow_job_id,
          input.generation_attempt,
          ordinal,
        );
  return {
    canonical_claim_version: CANONICAL_ATOMIC_CLAIM_VERSION,
    candidate_claim_key: candidateKey,
    source_claim_text_nfc: recomputed.source_claim_text_nfc,
    subject_anchor: recomputed.subject_anchor,
    predicate_anchor: recomputed.predicate_anchor,
    polarity: recomputed.polarity,
    quantifier: recomputed.quantifier,
    quantities: recomputed.quantities,
    evidence_ids: [...claim.evidence_ids],
    fragment: {
      ordinal,
      presentation: fragment.presentation,
      previous_structure_id: structureNeighbor(proposal, ordinal, -1),
      next_structure_id: structureNeighbor(proposal, ordinal, 1),
    },
    revision: {
      attempt: input.revision_attempt,
      revision_of_candidate_claim_key: claim.revision_of_candidate_claim_key,
    },
  };
}

function recomputeFailureReason(error: unknown): AtomicGroundingReasonCode {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('anchor') || message.includes('span')) {
    return 'ATOM_ANCHOR_MISMATCH';
  }
  if (message.includes('polarity')) return 'ATOM_POLARITY_MISMATCH';
  if (message.includes('quantifier')) return 'ATOM_QUANTIFIER_MISMATCH';
  if (message.includes('quantity')) return 'ATOM_QUANTITY_MISMATCH';
  return 'SCHEMA_INVALID';
}

function unverifiableClaim(
  base: Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'>,
  evidenceRefs: AtomicVerifiedClaimV1['evidence_refs'],
  reason: AtomicGroundingReasonCode,
): AtomicVerifiedClaimV1 {
  return {
    candidate_claim_key: base.candidate_claim_key,
    canonical_claim_base: base,
    support_status: 'UNVERIFIABLE',
    support_score: '0',
    verification_method: 'atomic_unverifiable',
    evidence_refs: evidenceRefs,
    reason_codes: [reason],
  };
}

export class AtomicGroundingVerifier {
  verify(input: AtomicVerificationInput): AtomicVerificationResult {
    try {
      return this.verifyClosed(input);
    } catch (error) {
      if (error instanceof AtomicVerificationFailure) throw error;
      throw new AtomicVerificationFailure(failClosedUnknownAtomicError());
    }
  }

  private verifyClosed(
    input: AtomicVerificationInput,
  ): AtomicVerificationResult {
    let proposal: GroundedDraftProposal;
    try {
      proposal = GROUNDED_DRAFT_SCHEMA.parse(input.proposal);
    } catch {
      return failedResult(
        safeFallbackProposal(),
        'SCHEMA_INVALID',
        input.revision_attempt,
      );
    }
    if (
      typeof input.workflow_job_id !== 'string' ||
      input.workflow_job_id.length === 0 ||
      typeof input.project_id !== 'string' ||
      input.project_id.length === 0 ||
      !Number.isSafeInteger(input.generation_attempt) ||
      input.generation_attempt < 0
    ) {
      return failedResult(proposal, 'SCHEMA_INVALID', input.revision_attempt);
    }
    if (input.assignment_digest.length === 0) {
      return failedResult(
        proposal,
        'ASSIGNMENT_MISSING',
        input.revision_attempt,
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(input.assignment_digest)) {
      return failedResult(
        proposal,
        'ASSIGNMENT_CONTRACT_MISMATCH',
        input.revision_attempt,
      );
    }
    if (proposal.status === 'material_gap') {
      return failedResult(
        proposal,
        proposal.material_gap?.reason_code ?? 'NO_EVIDENCE',
        input.revision_attempt,
      );
    }
    if (
      input.revision_attempt === 0 &&
      proposal.claims.some(
        (claim) => claim.revision_of_candidate_claim_key !== null,
      )
    ) {
      return failedResult(
        proposal,
        'REVISION_INVARIANT_VIOLATION',
        input.revision_attempt,
      );
    }
    if (input.evidence.length === 0) {
      return failedResult(proposal, 'NO_EVIDENCE', input.revision_attempt);
    }
    const evidenceIds = input.evidence.map((item) => item.evidence_id);
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      return failedResult(
        proposal,
        'ASSIGNMENT_SNAPSHOT_DRIFT',
        input.revision_attempt,
      );
    }
    if (input.evidence.some((item) => item.project_id !== input.project_id)) {
      return failedResult(
        proposal,
        'EVIDENCE_OWNERSHIP_INVALID',
        input.revision_attempt,
      );
    }
    if (
      input.evidence.some(
        (item) =>
          typeof item.evidence_snapshot_digest !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(item.evidence_snapshot_digest) ||
          typeof item.exact_span_text !== 'string' ||
          item.exact_span_text.length === 0,
      )
    ) {
      return failedResult(
        proposal,
        'EVIDENCE_SNAPSHOT_DRIFT',
        input.revision_attempt,
      );
    }
    const evidenceById = new Map(
      input.evidence.map((item) => [item.evidence_id, item]),
    );
    const verifiedClaims: AtomicVerifiedClaimV1[] = [];
    for (const claim of proposal.claims) {
      let recomputed: RecomputedAtomV1;
      try {
        recomputed = recomputeAtomV1(claim);
      } catch (error) {
        const reason = recomputeFailureReason(error);
        return failedResult(
          proposal,
          reason,
          input.revision_attempt,
          verifiedClaims,
        );
      }
      const base = canonicalClaimBase(input, proposal, claim, recomputed);
      const evidenceRows: AssignedEvidenceSnapshot[] = [];
      for (const evidenceId of claim.evidence_ids) {
        const assigned = evidenceById.get(evidenceId);
        if (!assigned) {
          const currentRefs = evidenceRows.map((item) => ({
            evidence_id: item.evidence_id,
            evidence_snapshot_digest: item.evidence_snapshot_digest as string,
          }));
          verifiedClaims.push(
            unverifiableClaim(base, currentRefs, 'EVIDENCE_UNKNOWN'),
          );
          return failedResult(
            proposal,
            'EVIDENCE_UNKNOWN',
            input.revision_attempt,
            verifiedClaims,
          );
        }
        evidenceRows.push(assigned);
      }
      const evidenceRefs = evidenceRows.map((item) => ({
        evidence_id: item.evidence_id,
        evidence_snapshot_digest: item.evidence_snapshot_digest as string,
      }));
      const perEvidence = evidenceRows.map((item) =>
        compareOneEvidenceDefault(recomputed, item.exact_span_text),
      );
      const supported =
        perEvidence.length > 0 &&
        perEvidence.every((comparison) => comparison.supported);
      if (!supported) {
        const reason =
          perEvidence.length > 1 &&
          perEvidence.every((comparison) => !comparison.supported)
            ? 'ATOM_EVIDENCE_MOSAIC_UNSUPPORTED'
            : (perEvidence.find((comparison) => !comparison.supported)
                ?.reason ?? 'ATOM_EXACT_MISMATCH');
        verifiedClaims.push({
          candidate_claim_key: base.candidate_claim_key,
          canonical_claim_base: base,
          support_status: 'UNSUPPORTED',
          support_score: '0',
          verification_method: 'atomic_unsupported',
          evidence_refs: evidenceRefs,
          reason_codes: [reason],
        });
        return failedResult(
          proposal,
          reason,
          input.revision_attempt,
          verifiedClaims,
        );
      }
      verifiedClaims.push({
        candidate_claim_key: base.candidate_claim_key,
        canonical_claim_base: base,
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: perEvidence.some(
          (comparison) => comparison.method === 'typed',
        )
          ? 'atomic_typed_equivalent'
          : 'atomic_extract_exact',
        evidence_refs: evidenceRefs,
        reason_codes: [],
      });
    }
    return {
      decision: 'ALLOW',
      canonical_proposal: proposal,
      claims: verifiedClaims,
      material_gap_reason: null,
    };
  }
}
