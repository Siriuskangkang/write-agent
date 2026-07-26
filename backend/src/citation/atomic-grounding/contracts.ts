import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';

export const ATOMIC_GROUNDING_CONTRACT_VERSION = 'atomic:v1' as const;
export const GROUNDED_DRAFT_SCHEMA_VERSION = 'grounded-draft.v1' as const;
export const CANONICAL_JSON_VERSION = 'canonical-json.v1' as const;
export const ATOMIC_CANONICALIZER_VERSION = 'atomic-canonicalizer.v1' as const;
export const QUANTITY_LEXER_VERSION = 'quantity-lexer.v1' as const;
export const ATOMIC_VERIFIER_VERSION = 'atomic-verifier.v1' as const;
export const CANONICAL_ATOMIC_CLAIM_VERSION =
  'canonical-atomic-claim.v1' as const;
export const CANDIDATE_CLAIM_KEY_VERSION = 'candidate-claim-key.v1' as const;
export const APPROVED_RENDER_CONTEXT_VERSION =
  'approved-render-context.v1' as const;
export const PLAIN_TEXT_ESCAPE_VERSION = 'escape-plain-text.v1' as const;
export const ATOMIC_RENDERER_VERSION = 'atomic-renderer.v1' as const;
export const SEALED_GROUNDED_CANDIDATE_VERSION =
  'sealed-grounded-candidate.v1' as const;
export const PERSISTED_CLAIM_ID_VERSION = 'persisted-claim-id.v1' as const;
export const ATOMIC_CLAIM_LEDGER_VERSION = 'atomic-claim-ledger.v1' as const;
export const NON_TARGET_INVARIANT_VERSION = 'non-target-invariant.v1' as const;

export type Polarity = 'affirmed' | 'negated';

export type Quantifier =
  | 'plain'
  | 'all'
  | 'none'
  | 'not_all'
  | 'not_none'
  | 'some'
  | 'other';

export type Comparator =
  | 'eq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'approx'
  | 'range';

export type QuantityDimension =
  | 'count'
  | 'ratio'
  | 'duration'
  | 'power'
  | 'energy'
  | 'currency'
  | 'length'
  | 'mass'
  | 'temperature'
  | 'other';

export interface QuantityProposal {
  quantity_id: string;
  surface: string;
  start_utf16: number;
  end_utf16: number;
  dimension: QuantityDimension;
  value: string;
  unit: string | null;
  comparator: Comparator;
  range_end: string | null;
}

export interface SurfaceAnchorProposal {
  surface: string;
  start_utf16: number;
  end_utf16: number;
}

export interface AtomicClaimProposal {
  proposal_claim_id: string;
  revision_of_candidate_claim_key: string | null;
  claim_text: string;
  span: {
    fragment_id: string;
    start_utf16: 0;
    end_utf16: number;
  };
  subject: SurfaceAnchorProposal;
  predicate: SurfaceAnchorProposal;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: QuantityProposal[];
  evidence_ids: string[];
}

export type RenderFragmentProposal =
  | {
      fragment_id: string;
      kind: 'claim_ref';
      claim_id: string;
      presentation: 'sentence' | 'bullet' | 'ordered_item';
    }
  | {
      fragment_id: string;
      kind: 'structure_ref';
      structure_id: string;
      presentation: 'heading_1' | 'heading_2' | 'heading_3' | 'column';
    }
  | {
      fragment_id: string;
      kind: 'separator';
      token: 'space' | 'line_break' | 'paragraph_break';
    };

export type MaterialGapReason =
  | 'NO_EVIDENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'AMBIGUOUS_EVIDENCE'
  | 'UNSUPPORTED_QUANTIFIER';

export interface GroundedDraftProposal {
  schema_version: typeof GROUNDED_DRAFT_SCHEMA_VERSION;
  status: 'draft' | 'material_gap';
  claims: AtomicClaimProposal[];
  render_fragments: RenderFragmentProposal[];
  ordering: string[];
  material_gap: null | {
    reason_code: MaterialGapReason;
    missing_topics: string[];
  };
}

export interface CanonicalTextAnchorV1 {
  surface_nfc: string;
  start_utf16: number;
  end_utf16: number;
}

export interface CanonicalQuantityV1 {
  ordinal: number;
  surface_nfc: string;
  start_utf16: number;
  end_utf16: number;
  dimension: QuantityDimension;
  base_value: string;
  base_unit: string | null;
  comparator: Comparator;
  range_end_base_value: string | null;
  typed_equivalence_eligible: boolean;
}

export interface CanonicalAtomicClaimV1 {
  canonical_claim_version: typeof CANONICAL_ATOMIC_CLAIM_VERSION;
  candidate_claim_key: string;
  source_claim_text_nfc: string;
  rendered_claim_text: string;
  subject_anchor: CanonicalTextAnchorV1;
  predicate_anchor: CanonicalTextAnchorV1;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: CanonicalQuantityV1[];
  evidence_ids: string[];
  fragment: {
    ordinal: number;
    presentation: 'sentence' | 'bullet' | 'ordered_item';
    previous_structure_id: string | null;
    next_structure_id: string | null;
  };
  revision: {
    attempt: 0 | 1;
    revision_of_candidate_claim_key: string | null;
  };
}

export type CanonicalQuantityOccurrenceV1 = CanonicalQuantityV1;

export interface RecomputedAtomV1 {
  source_claim_text_nfc: string;
  subject_anchor: CanonicalTextAnchorV1;
  predicate_anchor: CanonicalTextAnchorV1;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: CanonicalQuantityV1[];
}

export interface AtomicVerificationInput {
  workflow_job_id: string;
  project_id: string;
  generation_attempt: number;
  revision_attempt: 0 | 1;
  proposal: GroundedDraftProposal;
  assignment_digest: string;
  evidence: AssignedEvidenceSnapshot[];
}

export interface AtomicVerifiedClaimV1 {
  candidate_claim_key: string;
  canonical_claim_base: Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'>;
  support_status: 'SUPPORTED' | 'UNSUPPORTED' | 'UNVERIFIABLE';
  support_score: '1' | '0';
  verification_method:
    | 'atomic_extract_exact'
    | 'atomic_typed_equivalent'
    | 'atomic_unsupported'
    | 'atomic_unverifiable';
  evidence_refs: Array<{
    evidence_id: string;
    evidence_snapshot_digest: string;
  }>;
  reason_codes: AtomicGroundingReasonCode[];
}

export interface AtomicVerificationResult {
  decision: 'ALLOW' | 'TARGETED_RETRIEVAL_REVISION' | 'WAITING_MATERIAL';
  canonical_proposal: GroundedDraftProposal;
  claims: AtomicVerifiedClaimV1[];
  material_gap_reason: AtomicGroundingReasonCode | null;
}

export interface SealedApprovedRenderContextV1 {
  context_version: typeof APPROVED_RENDER_CONTEXT_VERSION;
  entries: Array<{
    structure_id: string;
    source_kind: 'workflow_input' | 'directory' | 'outline' | 'style_template';
    source_id: string;
    source_version: string;
    label_nfc: string;
    presentation: 'heading_1' | 'heading_2' | 'heading_3' | 'column';
  }>;
}

export interface SealedEvidenceSnapshotV1 {
  evidence_id: string;
  retrieval_run_id: string;
  chunk_id: string;
  project_id: string;
  file_id: string;
  document_id: string;
  ingestion_key: string | null;
  exact_span_text_nfc: string;
  exact_span_document_start: number | null;
  exact_span_document_end: number | null;
  candidate_rank: number;
  scores: {
    sparse: string | null;
    dense: string | null;
    fusion: string;
    rerank: string;
  };
  ranks: {
    sparse: number | null;
    dense: number | null;
    fusion: number;
    rerank: number;
  };
  index_snapshot: Record<string, unknown>;
  evidence_snapshot_digest: string;
}

export interface SealedClaimV1 {
  candidate_claim_key: string;
  persisted_claim_id: string;
  canonical_claim: CanonicalAtomicClaimV1;
  output_char_start_utf16: number;
  output_char_end_utf16: number;
  support_status: 'SUPPORTED';
  support_score: '1';
  verification_method: 'atomic_extract_exact' | 'atomic_typed_equivalent';
  evidence_refs: Array<{
    evidence_id: string;
    evidence_snapshot_digest: string;
  }>;
  non_target_invariant_digest: string;
}

export interface SealedGroundedCandidateV1 {
  envelope_version: typeof SEALED_GROUNDED_CANDIDATE_VERSION;
  contract_version: typeof ATOMIC_GROUNDING_CONTRACT_VERSION;
  schema_version: typeof GROUNDED_DRAFT_SCHEMA_VERSION;
  canonical_json_version: typeof CANONICAL_JSON_VERSION;
  canonicalizer_version: typeof ATOMIC_CANONICALIZER_VERSION;
  quantity_lexer_version: typeof QUANTITY_LEXER_VERSION;
  plain_text_escape_version: typeof PLAIN_TEXT_ESCAPE_VERSION;
  renderer_version: typeof ATOMIC_RENDERER_VERSION;
  verifier_version: typeof ATOMIC_VERIFIER_VERSION;
  workflow: {
    workflow_job_id: string;
    project_id: string;
    workflow_type: 'content' | 'rewrite' | 'expand' | 'compress';
    generation_attempt: number;
    revision_attempt: 0 | 1;
  };
  canonical_proposal: GroundedDraftProposal;
  render_context: SealedApprovedRenderContextV1;
  server_output: {
    text: string;
    utf8_byte_length: number;
    utf16_length: number;
  };
  claims: SealedClaimV1[];
  evidence_snapshots: SealedEvidenceSnapshotV1[];
  digests: {
    proposal_digest: string;
    render_context_digest: string;
    render_digest: string;
    assignment_digest: string;
    ledger_digest: string;
    envelope_digest: string;
  };
}

export const ATOMIC_GROUNDING_REASON_CODES = [
  'SCHEMA_INVALID',
  'NO_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
  'AMBIGUOUS_EVIDENCE',
  'UNSUPPORTED_QUANTIFIER',
  'EMPTY_STRICT_DRAFT',
  'RENDER_GRAPH_INVALID',
  'ASSIGNMENT_MISSING',
  'ASSIGNMENT_CONTRACT_MISMATCH',
  'ASSIGNMENT_PROJECT_MISMATCH',
  'ASSIGNMENT_SNAPSHOT_DRIFT',
  'NO_HIT',
  'RETRIEVAL_STATE_INVALID',
  'EVIDENCE_UNKNOWN',
  'EVIDENCE_OWNERSHIP_INVALID',
  'EVIDENCE_NOT_SELECTED',
  'EVIDENCE_INGESTION_INACTIVE',
  'EVIDENCE_OFFSET_DRIFT',
  'EVIDENCE_RUN_DRIFT',
  'EVIDENCE_LEGACY_AMBIGUOUS',
  'EVIDENCE_SNAPSHOT_DRIFT',
  'ATOM_ANCHOR_MISMATCH',
  'ATOM_POLARITY_MISMATCH',
  'ATOM_QUANTIFIER_MISMATCH',
  'ATOM_QUANTITY_MISMATCH',
  'ATOM_EXACT_MISMATCH',
  'ATOM_TYPED_SKELETON_MISMATCH',
  'ATOM_EVIDENCE_MOSAIC_UNSUPPORTED',
  'RENDER_CONTEXT_INVALID',
  'RENDER_FAILED',
  'REVISION_INVARIANT_VIOLATION',
  'REVISION_EXHAUSTED',
  'ENVELOPE_INVALID',
  'ENVELOPE_DIGEST_MISMATCH',
  'RECOVERY_ASSIGNMENT_DRIFT',
  'RECOVERY_RENDER_CONTEXT_DRIFT',
  'ATOMIC_GROUNDING_DISABLED',
  'ATOMIC_COMMIT_NOT_AUTHORIZED',
  'INTERNAL_FAIL_CLOSED',
] as const;

export type AtomicGroundingReasonCode =
  (typeof ATOMIC_GROUNDING_REASON_CODES)[number];

export type AtomicGroundingTransition =
  | 'REVISION_REQUIRED'
  | 'WAITING_MATERIAL'
  | 'FAILED';

export interface AtomicFailureDisposition {
  internal_reason: AtomicGroundingReasonCode;
  public_code:
    | 'STRUCTURED_OUTPUT_INVALID'
    | 'GROUNDING_REVISION_REQUIRED'
    | 'MATERIAL_GAP'
    | 'ATOMIC_GROUNDING_UNAVAILABLE'
    | 'ATOMIC_COMMIT_NOT_AUTHORIZED'
    | 'ATOMIC_GROUNDING_FAILED';
  transition: AtomicGroundingTransition;
}
