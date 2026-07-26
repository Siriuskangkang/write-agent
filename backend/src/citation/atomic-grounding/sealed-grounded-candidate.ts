import { createHash, timingSafeEqual } from 'node:crypto';
import type { GroundingAssignmentSnapshot } from '../citation-ledger.service.js';
import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import { canonicalJsonV1, digestCanonicalV1 } from './canonical-json.js';
import {
  APPROVED_RENDER_CONTEXT_VERSION,
  ATOMIC_CANONICALIZER_VERSION,
  ATOMIC_CLAIM_LEDGER_VERSION,
  ATOMIC_GROUNDING_CONTRACT_VERSION,
  ATOMIC_RENDERER_VERSION,
  ATOMIC_VERIFIER_VERSION,
  CANDIDATE_CLAIM_KEY_VERSION,
  CANONICAL_ATOMIC_CLAIM_VERSION,
  CANONICAL_JSON_VERSION,
  GROUNDED_DRAFT_SCHEMA_VERSION,
  NON_TARGET_INVARIANT_VERSION,
  PERSISTED_CLAIM_ID_VERSION,
  PLAIN_TEXT_ESCAPE_VERSION,
  QUANTITY_LEXER_VERSION,
  SEALED_GROUNDED_CANDIDATE_VERSION,
  type AtomicVerificationResult,
  type AtomicVerifiedClaimV1,
  type CanonicalAtomicClaimV1,
  type GroundedDraftProposal,
  type SealedApprovedRenderContextV1,
  type SealedClaimV1,
  type SealedEvidenceSnapshotV1,
  type SealedGroundedCandidateV1,
} from './contracts.js';
import {
  renderAtomicDraftV1,
  type AtomicRenderResult,
} from './atomic-renderer.js';
import { AtomicGroundingVerifier } from './atomic-grounding.verifier.js';
import { GROUNDED_DRAFT_SCHEMA } from './grounded-draft.schema.js';
import { validateApprovedRenderContextV1 } from './approved-render-context.service.js';
import { AtomicGroundingClosedFailure } from './failure-policy.js';

export interface SealGroundedCandidateInput {
  workflow: SealedGroundedCandidateV1['workflow'];
  verification: AtomicVerificationResult;
  assignment: GroundingAssignmentSnapshot;
  render_context: SealedApprovedRenderContextV1;
}

export interface RecoverSealedCandidateInput {
  checkpoint: unknown;
  current_assignment: GroundingAssignmentSnapshot;
  current_render_context: SealedApprovedRenderContextV1;
}

export interface AtomicRevisionBaseV1 {
  verification: AtomicVerificationResult;
  allowed_candidate_claim_keys: string[];
  proposal_digest: string;
}

function invalidCandidate(): never {
  throw new TypeError('SEALED_CANDIDATE_INVALID');
}

function invalidRevision(): never {
  throw new TypeError('REVISION_INVARIANT_VIOLATION');
}

function sha256Utf8(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return canonicalJsonV1(left).equals(canonicalJsonV1(right));
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function candidateClaimKey(
  workflowJobId: string,
  generationAttempt: number,
  initialOrdinal: number,
): string {
  return sha256Utf8(
    `${CANDIDATE_CLAIM_KEY_VERSION}\0${workflowJobId.normalize('NFC')}\0` +
      `${generationAttempt}\0${initialOrdinal}`,
  );
}

function fixedDecimal(value: number): string {
  if (!Number.isFinite(value)) return invalidCandidate();
  if (Object.is(value, -0)) return '0';
  const source = String(value);
  if (!/[eE]/u.test(source)) return source;
  const [coefficient, exponentSource] = source.toLowerCase().split('e');
  const exponent = Number(exponentSource);
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const point = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const originalPoint = point < 0 ? digits.length : point;
  const targetPoint = originalPoint + exponent;
  let result: string;
  if (targetPoint <= 0) {
    result = `0.${'0'.repeat(-targetPoint)}${digits}`;
  } else if (targetPoint >= digits.length) {
    result = `${digits}${'0'.repeat(targetPoint - digits.length)}`;
  } else {
    result = `${digits.slice(0, targetPoint)}.${digits.slice(targetPoint)}`;
  }
  if (result.includes('.')) {
    result = result.replace(/0+$/u, '').replace(/\.$/u, '');
  }
  result = result.replace(/^0+(?=\d)/u, '');
  if (result.startsWith('.')) result = `0${result}`;
  return `${negative ? '-' : ''}${result}`;
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return invalidCandidate();
  }
  return Number(value);
}

function nullableRank(value: number | null): number | null {
  return value === null ? null : safeNonNegativeInteger(value);
}

function sealedEvidence(
  source: AssignedEvidenceSnapshot,
): SealedEvidenceSnapshotV1 {
  if (
    typeof source.evidence_snapshot_digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(source.evidence_snapshot_digest)
  ) {
    return invalidCandidate();
  }
  const exactSpan = source.exact_span_text.normalize('NFC');
  const snapshot: SealedEvidenceSnapshotV1 = {
    evidence_id: source.evidence_id.normalize('NFC'),
    retrieval_run_id: source.retrieval_run_id.normalize('NFC'),
    chunk_id: source.chunk_id.normalize('NFC'),
    project_id: source.project_id.normalize('NFC'),
    file_id: source.file_id.normalize('NFC'),
    document_id: source.document_id.normalize('NFC'),
    ingestion_key: source.ingestion_key?.normalize('NFC') ?? null,
    exact_span_text_nfc: exactSpan,
    exact_span_document_start:
      source.exact_span_document_start === null
        ? null
        : safeNonNegativeInteger(source.exact_span_document_start),
    exact_span_document_end:
      source.exact_span_document_end === null
        ? null
        : safeNonNegativeInteger(source.exact_span_document_end),
    candidate_rank: safeNonNegativeInteger(source.candidate_rank),
    scores: {
      sparse:
        source.scores.sparse === null
          ? null
          : fixedDecimal(source.scores.sparse),
      dense:
        source.scores.dense === null ? null : fixedDecimal(source.scores.dense),
      fusion: fixedDecimal(source.scores.fusion),
      rerank: fixedDecimal(source.scores.rerank),
    },
    ranks: {
      sparse: nullableRank(source.ranks.sparse),
      dense: nullableRank(source.ranks.dense),
      fusion: safeNonNegativeInteger(source.ranks.fusion),
      rerank: safeNonNegativeInteger(source.ranks.rerank),
    },
    index_snapshot: source.index_snapshot,
    evidence_snapshot_digest: source.evidence_snapshot_digest,
  };
  canonicalJsonV1(snapshot.index_snapshot);
  return snapshot;
}

function sortedRenderContext(
  context: SealedApprovedRenderContextV1,
): SealedApprovedRenderContextV1 {
  if (context.context_version !== APPROVED_RENDER_CONTEXT_VERSION) {
    return invalidCandidate();
  }
  const entries = context.entries.map((entry) => ({
    structure_id: entry.structure_id.normalize('NFC'),
    source_kind: entry.source_kind,
    source_id: entry.source_id.normalize('NFC'),
    source_version: entry.source_version.normalize('NFC'),
    label_nfc: entry.label_nfc,
    presentation: entry.presentation,
  }));
  entries.sort((left, right) =>
    compareUtf16(left.structure_id, right.structure_id),
  );
  if (
    entries.some(
      (entry, index) =>
        index > 0 && entry.structure_id === entries[index - 1].structure_id,
    )
  ) {
    return invalidCandidate();
  }
  return {
    context_version: APPROVED_RENDER_CONTEXT_VERSION,
    entries,
  };
}

function withoutRevision<T extends { revision: unknown }>(
  claim: T,
): Omit<T, 'revision'> {
  const { revision, ...rest } = claim;
  void revision;
  return rest;
}

function invariantDigest(
  canonicalClaim:
    | Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'>
    | CanonicalAtomicClaimV1,
  evidenceRefs: AtomicVerifiedClaimV1['evidence_refs'],
): string {
  return digestCanonicalV1(NON_TARGET_INVARIANT_VERSION, {
    candidate_claim_key: canonicalClaim.candidate_claim_key,
    canonical_claim_without_revision: withoutRevision(canonicalClaim),
    evidence_refs: [...evidenceRefs].sort((left, right) =>
      compareUtf16(left.evidence_id, right.evidence_id),
    ),
    fragment_ordinal: canonicalClaim.fragment.ordinal,
    presentation: canonicalClaim.fragment.presentation,
    previous_structure_id: canonicalClaim.fragment.previous_structure_id,
    next_structure_id: canonicalClaim.fragment.next_structure_id,
  });
}

function persistedClaimId(
  workflowJobId: string,
  renderDigest: string,
  canonicalClaim: CanonicalAtomicClaimV1,
  start: number,
  end: number,
): string {
  return sha256Utf8(
    `${PERSISTED_CLAIM_ID_VERSION}\0${workflowJobId.normalize('NFC')}\0` +
      `${ATOMIC_VERIFIER_VERSION}\0${renderDigest}\0` +
      `${canonicalJsonV1(canonicalClaim).toString('utf8')}\0${start}\0${end}`,
  );
}

function validateSealInput(input: SealGroundedCandidateInput): {
  verification: AtomicVerificationResult;
  renderContext: SealedApprovedRenderContextV1;
} {
  const { workflow, assignment } = input;
  if (
    input.verification.decision !== 'ALLOW' ||
    input.verification.claims.length === 0 ||
    input.verification.claims.some(
      (claim) =>
        claim.support_status !== 'SUPPORTED' ||
        claim.support_score !== '1' ||
        (claim.verification_method !== 'atomic_extract_exact' &&
          claim.verification_method !== 'atomic_typed_equivalent'),
    ) ||
    assignment.workflow_job_id !== workflow.workflow_job_id ||
    assignment.project_id !== workflow.project_id ||
    typeof assignment.snapshot_digest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(assignment.snapshot_digest) ||
    assignment.targeted_revision_attempts !== workflow.revision_attempt ||
    !Number.isSafeInteger(workflow.generation_attempt) ||
    workflow.generation_attempt < 0 ||
    (workflow.revision_attempt !== 0 && workflow.revision_attempt !== 1)
  ) {
    return invalidCandidate();
  }
  let canonicalProposal: GroundedDraftProposal;
  try {
    canonicalProposal = GROUNDED_DRAFT_SCHEMA.parse(
      input.verification.canonical_proposal,
    );
  } catch {
    return invalidCandidate();
  }
  const verification: AtomicVerificationResult = {
    ...input.verification,
    canonical_proposal: canonicalProposal,
    claims: [...input.verification.claims],
  };
  const renderContext = sortedRenderContext(input.render_context);
  return { verification, renderContext };
}

function assertClaimIdentity(
  workflow: SealedGroundedCandidateV1['workflow'],
  claim: AtomicVerifiedClaimV1,
): void {
  const base = claim.canonical_claim_base;
  const expectedInitialKey = candidateClaimKey(
    workflow.workflow_job_id,
    workflow.generation_attempt,
    base.fragment.ordinal,
  );
  const expectedKey =
    base.revision.attempt === 1 &&
    base.revision.revision_of_candidate_claim_key !== null
      ? base.revision.revision_of_candidate_claim_key
      : expectedInitialKey;
  if (
    base.canonical_claim_version !== CANONICAL_ATOMIC_CLAIM_VERSION ||
    claim.candidate_claim_key !== base.candidate_claim_key ||
    claim.candidate_claim_key !== expectedKey ||
    base.revision.attempt !== workflow.revision_attempt
  ) {
    invalidCandidate();
  }
}

function buildSealedClaims(
  workflow: SealedGroundedCandidateV1['workflow'],
  verification: AtomicVerificationResult,
  rendered: AtomicRenderResult,
  renderDigest: string,
  assignmentEvidence: Map<string, AssignedEvidenceSnapshot>,
): SealedClaimV1[] {
  const verifiedByKey = new Map(
    verification.claims.map((claim) => [claim.candidate_claim_key, claim]),
  );
  if (verifiedByKey.size !== verification.claims.length) {
    return invalidCandidate();
  }
  const claims: SealedClaimV1[] = rendered.claims.map((span) => {
    const verified = verifiedByKey.get(span.candidate_claim_key);
    if (
      !verified ||
      span.fragment_ordinal !==
        verified.canonical_claim_base.fragment.ordinal ||
      rendered.text.slice(
        span.output_char_start_utf16,
        span.output_char_end_utf16,
      ) !== span.rendered_claim_text
    ) {
      return invalidCandidate();
    }
    assertClaimIdentity(workflow, verified);
    const evidenceRefs = [...verified.evidence_refs].sort((left, right) =>
      compareUtf16(left.evidence_id, right.evidence_id),
    );
    const canonicalEvidenceIds = [
      ...verified.canonical_claim_base.evidence_ids,
    ].sort(compareUtf16);
    if (
      evidenceRefs.length === 0 ||
      new Set(evidenceRefs.map((ref) => ref.evidence_id)).size !==
        evidenceRefs.length ||
      !sameCanonical(
        canonicalEvidenceIds,
        evidenceRefs.map((ref) => ref.evidence_id),
      ) ||
      evidenceRefs.some((ref) => {
        const evidence = assignmentEvidence.get(ref.evidence_id);
        return (
          !evidence ||
          evidence.evidence_snapshot_digest !== ref.evidence_snapshot_digest
        );
      })
    ) {
      return invalidCandidate();
    }
    const canonicalClaim: CanonicalAtomicClaimV1 = {
      ...verified.canonical_claim_base,
      evidence_ids: canonicalEvidenceIds,
      rendered_claim_text: span.rendered_claim_text,
    };
    return {
      candidate_claim_key: verified.candidate_claim_key,
      persisted_claim_id: persistedClaimId(
        workflow.workflow_job_id,
        renderDigest,
        canonicalClaim,
        span.output_char_start_utf16,
        span.output_char_end_utf16,
      ),
      canonical_claim: canonicalClaim,
      output_char_start_utf16: span.output_char_start_utf16,
      output_char_end_utf16: span.output_char_end_utf16,
      support_status: 'SUPPORTED',
      support_score: '1',
      verification_method: verified.verification_method as
        | 'atomic_extract_exact'
        | 'atomic_typed_equivalent',
      evidence_refs: evidenceRefs,
      non_target_invariant_digest: invariantDigest(
        canonicalClaim,
        evidenceRefs,
      ),
    };
  });
  if (claims.length !== verification.claims.length) return invalidCandidate();
  claims.sort(
    (left, right) =>
      left.output_char_start_utf16 - right.output_char_start_utf16,
  );
  return claims;
}

function envelopeDigestInput(
  envelope: Omit<SealedGroundedCandidateV1, 'digests'> & {
    digests: Omit<SealedGroundedCandidateV1['digests'], 'envelope_digest'>;
  },
): unknown {
  return envelope;
}

export function sealGroundedCandidateV1(
  input: SealGroundedCandidateInput,
): SealedGroundedCandidateV1 {
  try {
    const { verification, renderContext } = validateSealInput(input);
    const assignmentEvidence = new Map(
      input.assignment.evidence.map((item) => [item.evidence_id, item]),
    );
    if (assignmentEvidence.size !== input.assignment.evidence.length) {
      return invalidCandidate();
    }
    const rendered = renderAtomicDraftV1({
      verification,
      render_context: renderContext,
    });
    const renderDigest = sha256Utf8(
      `${ATOMIC_RENDERER_VERSION}\0${rendered.text}`,
    );
    const claims = buildSealedClaims(
      input.workflow,
      verification,
      rendered,
      renderDigest,
      assignmentEvidence,
    );
    const referencedEvidenceIds = new Set(
      claims.flatMap((claim) =>
        claim.evidence_refs.map((reference) => reference.evidence_id),
      ),
    );
    const evidenceSnapshots = [...referencedEvidenceIds]
      .map((evidenceId) => {
        const item = assignmentEvidence.get(evidenceId);
        if (!item) return invalidCandidate();
        return sealedEvidence(item);
      })
      .sort((left, right) => compareUtf16(left.evidence_id, right.evidence_id));
    const proposalDigest = digestCanonicalV1(
      GROUNDED_DRAFT_SCHEMA_VERSION,
      verification.canonical_proposal,
    );
    const renderContextDigest = digestCanonicalV1(
      APPROVED_RENDER_CONTEXT_VERSION,
      renderContext,
    );
    const assignmentDigest = sha256Utf8(
      `${ATOMIC_GROUNDING_CONTRACT_VERSION}\0${input.assignment.snapshot_digest}`,
    );
    const ledgerDigest = digestCanonicalV1(ATOMIC_CLAIM_LEDGER_VERSION, claims);
    const withoutEnvelopeDigest = {
      envelope_version: SEALED_GROUNDED_CANDIDATE_VERSION,
      contract_version: ATOMIC_GROUNDING_CONTRACT_VERSION,
      schema_version: GROUNDED_DRAFT_SCHEMA_VERSION,
      canonical_json_version: CANONICAL_JSON_VERSION,
      canonicalizer_version: ATOMIC_CANONICALIZER_VERSION,
      quantity_lexer_version: QUANTITY_LEXER_VERSION,
      plain_text_escape_version: PLAIN_TEXT_ESCAPE_VERSION,
      renderer_version: ATOMIC_RENDERER_VERSION,
      verifier_version: ATOMIC_VERIFIER_VERSION,
      workflow: {
        ...input.workflow,
        workflow_job_id: input.workflow.workflow_job_id.normalize('NFC'),
        project_id: input.workflow.project_id.normalize('NFC'),
      },
      canonical_proposal: verification.canonical_proposal,
      render_context: renderContext,
      server_output: {
        text: rendered.text,
        utf8_byte_length: rendered.utf8_byte_length,
        utf16_length: rendered.utf16_length,
      },
      claims,
      evidence_snapshots: evidenceSnapshots,
      digests: {
        proposal_digest: proposalDigest,
        render_context_digest: renderContextDigest,
        render_digest: renderDigest,
        assignment_digest: assignmentDigest,
        ledger_digest: ledgerDigest,
      },
    } satisfies Omit<SealedGroundedCandidateV1, 'digests'> & {
      digests: Omit<SealedGroundedCandidateV1['digests'], 'envelope_digest'>;
    };
    const envelopeDigest = digestCanonicalV1(
      SEALED_GROUNDED_CANDIDATE_VERSION,
      envelopeDigestInput(withoutEnvelopeDigest),
    );
    return {
      ...withoutEnvelopeDigest,
      digests: {
        ...withoutEnvelopeDigest.digests,
        envelope_digest: envelopeDigest,
      },
    };
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === 'SEALED_CANDIDATE_INVALID'
    ) {
      throw error;
    }
    return invalidCandidate();
  }
}

function revisionInvariant(claim: AtomicVerifiedClaimV1): string {
  return invariantDigest(claim.canonical_claim_base, claim.evidence_refs);
}

export function validateTargetedRevisionV1(
  base: AtomicRevisionBaseV1,
  next: AtomicVerificationResult,
): void {
  try {
    const canonicalBaseProposal = GROUNDED_DRAFT_SCHEMA.parse(
      base.verification.canonical_proposal,
    );
    const expectedBaseDigest = digestCanonicalV1(
      GROUNDED_DRAFT_SCHEMA_VERSION,
      canonicalBaseProposal,
    );
    const allowed = new Set(base.allowed_candidate_claim_keys);
    if (
      !constantTimeEqual(expectedBaseDigest, base.proposal_digest) ||
      allowed.size === 0 ||
      allowed.size !== base.allowed_candidate_claim_keys.length ||
      base.verification.claims.length !== next.claims.length
    ) {
      return invalidRevision();
    }
    const canonicalNextProposal = GROUNDED_DRAFT_SCHEMA.parse(
      next.canonical_proposal,
    );
    if (
      !sameCanonical(
        canonicalBaseProposal.ordering,
        canonicalNextProposal.ordering,
      ) ||
      !sameCanonical(
        canonicalBaseProposal.render_fragments,
        canonicalNextProposal.render_fragments,
      )
    ) {
      return invalidRevision();
    }
    const baseProposalClaims = new Map(
      canonicalBaseProposal.claims.map((claim) => [
        canonicalBaseProposal.ordering.indexOf(claim.span.fragment_id),
        claim,
      ]),
    );
    const nextProposalClaims = new Map(
      canonicalNextProposal.claims.map((claim) => [
        canonicalNextProposal.ordering.indexOf(claim.span.fragment_id),
        claim,
      ]),
    );
    const seenTargets = new Set<string>();
    for (let index = 0; index < base.verification.claims.length; index += 1) {
      const previous = base.verification.claims[index];
      const replacement = next.claims[index];
      if (
        previous.candidate_claim_key !== replacement.candidate_claim_key ||
        replacement.canonical_claim_base.revision.attempt !== 1
      ) {
        return invalidRevision();
      }
      const key = previous.candidate_claim_key;
      const target = allowed.has(key);
      const previousProposal = baseProposalClaims.get(
        previous.canonical_claim_base.fragment.ordinal,
      );
      const replacementProposal = nextProposalClaims.get(
        replacement.canonical_claim_base.fragment.ordinal,
      );
      if (!previousProposal || !replacementProposal) return invalidRevision();
      if (target) {
        seenTargets.add(key);
        if (
          replacement.canonical_claim_base.revision
            .revision_of_candidate_claim_key !== key ||
          replacementProposal.revision_of_candidate_claim_key !== key ||
          previous.canonical_claim_base.fragment.ordinal !==
            replacement.canonical_claim_base.fragment.ordinal ||
          previous.canonical_claim_base.fragment.presentation !==
            replacement.canonical_claim_base.fragment.presentation ||
          previous.canonical_claim_base.fragment.previous_structure_id !==
            replacement.canonical_claim_base.fragment.previous_structure_id ||
          previous.canonical_claim_base.fragment.next_structure_id !==
            replacement.canonical_claim_base.fragment.next_structure_id
        ) {
          return invalidRevision();
        }
      } else if (
        replacement.canonical_claim_base.revision
          .revision_of_candidate_claim_key !== null ||
        replacementProposal.revision_of_candidate_claim_key !== null ||
        revisionInvariant(previous) !== revisionInvariant(replacement) ||
        !sameCanonical(previousProposal, replacementProposal)
      ) {
        return invalidRevision();
      }
      if (
        replacement.canonical_claim_base.source_claim_text_nfc !==
          replacementProposal.claim_text ||
        !sameCanonical(
          replacement.canonical_claim_base.evidence_ids,
          replacementProposal.evidence_ids,
        )
      ) {
        return invalidRevision();
      }
    }
    if (seenTargets.size !== allowed.size) return invalidRevision();
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === 'REVISION_INVARIANT_VIOLATION'
    ) {
      throw error;
    }
    return invalidRevision();
  }
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalidCandidate();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return invalidCandidate();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidCandidate();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.normalize('NFC') !== value) {
    return invalidCandidate();
  }
  return value;
}

function integer(value: unknown): number {
  return safeNonNegativeInteger(value);
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}

function digest(value: unknown): string {
  const parsed = string(value);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) return invalidCandidate();
  return parsed;
}

function enumString<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T {
  const parsed = string(value);
  if (!allowed.includes(parsed as T)) return invalidCandidate();
  return parsed as T;
}

function parseAnchor(value: unknown): CanonicalAtomicClaimV1['subject_anchor'] {
  const item = record(value, ['surface_nfc', 'start_utf16', 'end_utf16']);
  return {
    surface_nfc: string(item.surface_nfc),
    start_utf16: integer(item.start_utf16),
    end_utf16: integer(item.end_utf16),
  };
}

function parseQuantity(
  value: unknown,
): CanonicalAtomicClaimV1['quantities'][number] {
  const item = record(value, [
    'ordinal',
    'surface_nfc',
    'start_utf16',
    'end_utf16',
    'dimension',
    'base_value',
    'base_unit',
    'comparator',
    'range_end_base_value',
    'typed_equivalence_eligible',
  ]);
  if (typeof item.typed_equivalence_eligible !== 'boolean') {
    return invalidCandidate();
  }
  return {
    ordinal: integer(item.ordinal),
    surface_nfc: string(item.surface_nfc),
    start_utf16: integer(item.start_utf16),
    end_utf16: integer(item.end_utf16),
    dimension: enumString(item.dimension, [
      'count',
      'ratio',
      'duration',
      'power',
      'energy',
      'currency',
      'length',
      'mass',
      'temperature',
      'other',
    ] as const),
    base_value: string(item.base_value),
    base_unit: item.base_unit === null ? null : string(item.base_unit),
    comparator: enumString(item.comparator, [
      'eq',
      'gt',
      'gte',
      'lt',
      'lte',
      'approx',
      'range',
    ] as const),
    range_end_base_value:
      item.range_end_base_value === null
        ? null
        : string(item.range_end_base_value),
    typed_equivalence_eligible: item.typed_equivalence_eligible,
  };
}

function parseCanonicalClaim(value: unknown): CanonicalAtomicClaimV1 {
  const item = record(value, [
    'canonical_claim_version',
    'candidate_claim_key',
    'source_claim_text_nfc',
    'rendered_claim_text',
    'subject_anchor',
    'predicate_anchor',
    'polarity',
    'quantifier',
    'quantities',
    'evidence_ids',
    'fragment',
    'revision',
  ]);
  if (item.canonical_claim_version !== CANONICAL_ATOMIC_CLAIM_VERSION) {
    return invalidCandidate();
  }
  const fragment = record(item.fragment, [
    'ordinal',
    'presentation',
    'previous_structure_id',
    'next_structure_id',
  ]);
  const revision = record(item.revision, [
    'attempt',
    'revision_of_candidate_claim_key',
  ]);
  const attempt = integer(revision.attempt);
  if (attempt !== 0 && attempt !== 1) return invalidCandidate();
  return {
    canonical_claim_version: CANONICAL_ATOMIC_CLAIM_VERSION,
    candidate_claim_key: string(item.candidate_claim_key),
    source_claim_text_nfc: string(item.source_claim_text_nfc),
    rendered_claim_text: string(item.rendered_claim_text),
    subject_anchor: parseAnchor(item.subject_anchor),
    predicate_anchor: parseAnchor(item.predicate_anchor),
    polarity: enumString(item.polarity, ['affirmed', 'negated'] as const),
    quantifier: enumString(item.quantifier, [
      'plain',
      'all',
      'none',
      'not_all',
      'not_none',
      'some',
      'other',
    ] as const),
    quantities: array(item.quantities).map(parseQuantity),
    evidence_ids: array(item.evidence_ids).map(string),
    fragment: {
      ordinal: integer(fragment.ordinal),
      presentation: enumString(fragment.presentation, [
        'sentence',
        'bullet',
        'ordered_item',
      ] as const),
      previous_structure_id:
        fragment.previous_structure_id === null
          ? null
          : string(fragment.previous_structure_id),
      next_structure_id:
        fragment.next_structure_id === null
          ? null
          : string(fragment.next_structure_id),
    },
    revision: {
      attempt,
      revision_of_candidate_claim_key:
        revision.revision_of_candidate_claim_key === null
          ? null
          : string(revision.revision_of_candidate_claim_key),
    },
  };
}

function parseEvidenceRef(
  value: unknown,
): SealedClaimV1['evidence_refs'][number] {
  const item = record(value, ['evidence_id', 'evidence_snapshot_digest']);
  return {
    evidence_id: string(item.evidence_id),
    evidence_snapshot_digest: digest(item.evidence_snapshot_digest),
  };
}

function parseSealedClaim(value: unknown): SealedClaimV1 {
  const item = record(value, [
    'candidate_claim_key',
    'persisted_claim_id',
    'canonical_claim',
    'output_char_start_utf16',
    'output_char_end_utf16',
    'support_status',
    'support_score',
    'verification_method',
    'evidence_refs',
    'non_target_invariant_digest',
  ]);
  if (item.support_status !== 'SUPPORTED' || item.support_score !== '1') {
    return invalidCandidate();
  }
  return {
    candidate_claim_key: string(item.candidate_claim_key),
    persisted_claim_id: digest(item.persisted_claim_id),
    canonical_claim: parseCanonicalClaim(item.canonical_claim),
    output_char_start_utf16: integer(item.output_char_start_utf16),
    output_char_end_utf16: integer(item.output_char_end_utf16),
    support_status: 'SUPPORTED',
    support_score: '1',
    verification_method: enumString(item.verification_method, [
      'atomic_extract_exact',
      'atomic_typed_equivalent',
    ] as const),
    evidence_refs: array(item.evidence_refs).map(parseEvidenceRef),
    non_target_invariant_digest: digest(item.non_target_invariant_digest),
  };
}

function parseRenderContext(value: unknown): SealedApprovedRenderContextV1 {
  try {
    return validateApprovedRenderContextV1(value);
  } catch {
    return invalidCandidate();
  }
}

function parseEvidenceSnapshot(value: unknown): SealedEvidenceSnapshotV1 {
  const item = record(value, [
    'evidence_id',
    'retrieval_run_id',
    'chunk_id',
    'project_id',
    'file_id',
    'document_id',
    'ingestion_key',
    'exact_span_text_nfc',
    'exact_span_document_start',
    'exact_span_document_end',
    'candidate_rank',
    'scores',
    'ranks',
    'index_snapshot',
    'evidence_snapshot_digest',
  ]);
  const scores = record(item.scores, ['sparse', 'dense', 'fusion', 'rerank']);
  const ranks = record(item.ranks, ['sparse', 'dense', 'fusion', 'rerank']);
  const indexSnapshot = record(
    item.index_snapshot,
    Reflect.ownKeys(item.index_snapshot as object).filter(
      (key): key is string => typeof key === 'string',
    ),
  );
  canonicalJsonV1(indexSnapshot);
  return {
    evidence_id: string(item.evidence_id),
    retrieval_run_id: string(item.retrieval_run_id),
    chunk_id: string(item.chunk_id),
    project_id: string(item.project_id),
    file_id: string(item.file_id),
    document_id: string(item.document_id),
    ingestion_key:
      item.ingestion_key === null ? null : string(item.ingestion_key),
    exact_span_text_nfc: string(item.exact_span_text_nfc),
    exact_span_document_start: nullableInteger(item.exact_span_document_start),
    exact_span_document_end: nullableInteger(item.exact_span_document_end),
    candidate_rank: integer(item.candidate_rank),
    scores: {
      sparse: scores.sparse === null ? null : string(scores.sparse),
      dense: scores.dense === null ? null : string(scores.dense),
      fusion: string(scores.fusion),
      rerank: string(scores.rerank),
    },
    ranks: {
      sparse: nullableInteger(ranks.sparse),
      dense: nullableInteger(ranks.dense),
      fusion: integer(ranks.fusion),
      rerank: integer(ranks.rerank),
    },
    index_snapshot: indexSnapshot,
    evidence_snapshot_digest: digest(item.evidence_snapshot_digest),
  };
}

function parseCheckpoint(value: unknown): SealedGroundedCandidateV1 {
  const item = record(value, [
    'envelope_version',
    'contract_version',
    'schema_version',
    'canonical_json_version',
    'canonicalizer_version',
    'quantity_lexer_version',
    'plain_text_escape_version',
    'renderer_version',
    'verifier_version',
    'workflow',
    'canonical_proposal',
    'render_context',
    'server_output',
    'claims',
    'evidence_snapshots',
    'digests',
  ]);
  if (
    item.envelope_version !== SEALED_GROUNDED_CANDIDATE_VERSION ||
    item.contract_version !== ATOMIC_GROUNDING_CONTRACT_VERSION ||
    item.schema_version !== GROUNDED_DRAFT_SCHEMA_VERSION ||
    item.canonical_json_version !== CANONICAL_JSON_VERSION ||
    item.canonicalizer_version !== ATOMIC_CANONICALIZER_VERSION ||
    item.quantity_lexer_version !== QUANTITY_LEXER_VERSION ||
    item.plain_text_escape_version !== PLAIN_TEXT_ESCAPE_VERSION ||
    item.renderer_version !== ATOMIC_RENDERER_VERSION ||
    item.verifier_version !== ATOMIC_VERIFIER_VERSION
  ) {
    return invalidCandidate();
  }
  const workflow = record(item.workflow, [
    'workflow_job_id',
    'project_id',
    'workflow_type',
    'generation_attempt',
    'revision_attempt',
  ]);
  const revisionAttempt = integer(workflow.revision_attempt);
  if (revisionAttempt !== 0 && revisionAttempt !== 1) {
    return invalidCandidate();
  }
  const serverOutput = record(item.server_output, [
    'text',
    'utf8_byte_length',
    'utf16_length',
  ]);
  const digests = record(item.digests, [
    'proposal_digest',
    'render_context_digest',
    'render_digest',
    'assignment_digest',
    'ledger_digest',
    'envelope_digest',
  ]);
  let canonicalProposal: GroundedDraftProposal;
  try {
    canonicalProposal = GROUNDED_DRAFT_SCHEMA.parse(item.canonical_proposal);
  } catch {
    return invalidCandidate();
  }
  return {
    envelope_version: SEALED_GROUNDED_CANDIDATE_VERSION,
    contract_version: ATOMIC_GROUNDING_CONTRACT_VERSION,
    schema_version: GROUNDED_DRAFT_SCHEMA_VERSION,
    canonical_json_version: CANONICAL_JSON_VERSION,
    canonicalizer_version: ATOMIC_CANONICALIZER_VERSION,
    quantity_lexer_version: QUANTITY_LEXER_VERSION,
    plain_text_escape_version: PLAIN_TEXT_ESCAPE_VERSION,
    renderer_version: ATOMIC_RENDERER_VERSION,
    verifier_version: ATOMIC_VERIFIER_VERSION,
    workflow: {
      workflow_job_id: string(workflow.workflow_job_id),
      project_id: string(workflow.project_id),
      workflow_type: enumString(workflow.workflow_type, [
        'content',
        'rewrite',
        'expand',
        'compress',
      ] as const),
      generation_attempt: integer(workflow.generation_attempt),
      revision_attempt: revisionAttempt,
    },
    canonical_proposal: canonicalProposal,
    render_context: parseRenderContext(item.render_context),
    server_output: {
      text: string(serverOutput.text),
      utf8_byte_length: integer(serverOutput.utf8_byte_length),
      utf16_length: integer(serverOutput.utf16_length),
    },
    claims: array(item.claims).map(parseSealedClaim),
    evidence_snapshots: array(item.evidence_snapshots).map(
      parseEvidenceSnapshot,
    ),
    digests: {
      proposal_digest: digest(digests.proposal_digest),
      render_context_digest: digest(digests.render_context_digest),
      render_digest: digest(digests.render_digest),
      assignment_digest: digest(digests.assignment_digest),
      ledger_digest: digest(digests.ledger_digest),
      envelope_digest: digest(digests.envelope_digest),
    },
  };
}

export function parseSealedGroundedCandidateWorkflowV1(
  checkpoint: unknown,
): SealedGroundedCandidateV1['workflow'] {
  let parsed: SealedGroundedCandidateV1;
  try {
    parsed = parseCheckpoint(checkpoint);
  } catch {
    throw recoveryFailure('ENVELOPE_INVALID');
  }
  const storedEnvelopeDigest = digestCanonicalV1(
    SEALED_GROUNDED_CANDIDATE_VERSION,
    withoutEnvelopeDigest(parsed),
  );
  if (
    !constantTimeEqual(storedEnvelopeDigest, parsed.digests.envelope_digest)
  ) {
    throw recoveryFailure('ENVELOPE_DIGEST_MISMATCH');
  }
  return parsed.workflow;
}

function verifyEnvelopeAgainstCurrentAssignment(
  envelope: SealedGroundedCandidateV1,
  assignment: GroundingAssignmentSnapshot,
): AtomicVerificationResult {
  if (
    assignment.targeted_revision_attempts !==
      envelope.workflow.revision_attempt ||
    typeof assignment.snapshot_digest !== 'string'
  ) {
    return invalidCandidate();
  }
  const verification = new AtomicGroundingVerifier().verify({
    workflow_job_id: envelope.workflow.workflow_job_id,
    project_id: envelope.workflow.project_id,
    generation_attempt: envelope.workflow.generation_attempt,
    revision_attempt: envelope.workflow.revision_attempt,
    proposal: envelope.canonical_proposal,
    assignment_digest: assignment.snapshot_digest,
    evidence: assignment.evidence,
  });
  if (
    verification.decision !== 'ALLOW' ||
    verification.claims.length !== envelope.claims.length ||
    !sameCanonical(verification.canonical_proposal, envelope.canonical_proposal)
  ) {
    return invalidCandidate();
  }
  for (let index = 0; index < verification.claims.length; index += 1) {
    const fresh = verification.claims[index];
    const stored = envelope.claims[index];
    const {
      rendered_claim_text: renderedClaimText,
      ...storedCanonicalClaimBase
    } = stored.canonical_claim;
    void renderedClaimText;
    if (
      fresh.support_status !== 'SUPPORTED' ||
      fresh.support_score !== '1' ||
      fresh.candidate_claim_key !== stored.candidate_claim_key ||
      fresh.candidate_claim_key !==
        fresh.canonical_claim_base.candidate_claim_key ||
      fresh.verification_method !== stored.verification_method ||
      fresh.canonical_claim_base.revision.attempt !==
        envelope.workflow.revision_attempt ||
      stored.canonical_claim.revision.attempt !==
        envelope.workflow.revision_attempt ||
      !sameCanonical(fresh.canonical_claim_base, storedCanonicalClaimBase) ||
      !sameCanonical(fresh.evidence_refs, stored.evidence_refs)
    ) {
      return invalidCandidate();
    }
  }
  return verification;
}

function withoutEnvelopeDigest(envelope: SealedGroundedCandidateV1): unknown {
  const { envelope_digest: envelopeDigest, ...otherDigests } = envelope.digests;
  void envelopeDigest;
  return {
    ...envelope,
    digests: otherDigests,
  };
}

export function recoverSealedGroundedCandidateV1(
  input: RecoverSealedCandidateInput,
): SealedGroundedCandidateV1 {
  try {
    const parsed = parseCheckpoint(input.checkpoint);
    const storedEnvelopeDigest = digestCanonicalV1(
      SEALED_GROUNDED_CANDIDATE_VERSION,
      withoutEnvelopeDigest(parsed),
    );
    if (
      !constantTimeEqual(storedEnvelopeDigest, parsed.digests.envelope_digest)
    ) {
      throw recoveryFailure('ENVELOPE_DIGEST_MISMATCH');
    }
    if (
      typeof input.current_assignment.snapshot_digest !== 'string' ||
      !constantTimeEqual(
        sha256Utf8(
          `${ATOMIC_GROUNDING_CONTRACT_VERSION}\0${input.current_assignment.snapshot_digest}`,
        ),
        parsed.digests.assignment_digest,
      )
    ) {
      throw recoveryFailure('RECOVERY_ASSIGNMENT_DRIFT');
    }
    let currentRenderContext: SealedApprovedRenderContextV1;
    try {
      currentRenderContext = validateApprovedRenderContextV1(
        input.current_render_context,
      );
    } catch {
      throw recoveryFailure('RECOVERY_RENDER_CONTEXT_DRIFT');
    }
    const currentRenderContextDigest = digestCanonicalV1(
      APPROVED_RENDER_CONTEXT_VERSION,
      currentRenderContext,
    );
    if (
      !constantTimeEqual(
        currentRenderContextDigest,
        parsed.digests.render_context_digest,
      )
    ) {
      throw recoveryFailure('RECOVERY_RENDER_CONTEXT_DRIFT');
    }
    let freshVerification: AtomicVerificationResult;
    try {
      freshVerification = verifyEnvelopeAgainstCurrentAssignment(
        parsed,
        input.current_assignment,
      );
    } catch {
      throw recoveryFailure('RECOVERY_ASSIGNMENT_DRIFT');
    }
    let recovered: SealedGroundedCandidateV1;
    try {
      recovered = sealGroundedCandidateV1({
        workflow: parsed.workflow,
        verification: freshVerification,
        assignment: input.current_assignment,
        render_context: currentRenderContext,
      });
    } catch {
      throw recoveryFailure('ENVELOPE_INVALID');
    }
    for (const key of [
      'proposal_digest',
      'render_context_digest',
      'render_digest',
      'assignment_digest',
      'ledger_digest',
      'envelope_digest',
    ] as const) {
      if (!constantTimeEqual(recovered.digests[key], parsed.digests[key])) {
        throw recoveryFailure(
          key === 'assignment_digest'
            ? 'RECOVERY_ASSIGNMENT_DRIFT'
            : key === 'render_context_digest'
              ? 'RECOVERY_RENDER_CONTEXT_DRIFT'
              : 'ENVELOPE_DIGEST_MISMATCH',
        );
      }
    }
    if (!sameCanonical(recovered, parsed)) {
      throw recoveryFailure('ENVELOPE_DIGEST_MISMATCH');
    }
    return recovered;
  } catch (error) {
    if (error instanceof AtomicGroundingClosedFailure) {
      throw error;
    }
    if (
      error instanceof TypeError &&
      error.message === 'SEALED_CANDIDATE_INVALID'
    ) {
      throw recoveryFailure('ENVELOPE_INVALID');
    }
    throw recoveryFailure('ENVELOPE_INVALID');
  }
}

function recoveryFailure(
  reason:
    | 'ENVELOPE_INVALID'
    | 'ENVELOPE_DIGEST_MISMATCH'
    | 'RECOVERY_ASSIGNMENT_DRIFT'
    | 'RECOVERY_RENDER_CONTEXT_DRIFT',
): AtomicGroundingClosedFailure {
  return new AtomicGroundingClosedFailure(reason, 'SEALED_CANDIDATE_INVALID');
}
