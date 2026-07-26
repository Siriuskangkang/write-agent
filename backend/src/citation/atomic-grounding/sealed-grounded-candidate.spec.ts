import type { GroundingAssignmentSnapshot } from '../citation-ledger.service.js';
import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import { digestCanonicalV1 } from './canonical-json.js';
import type {
  AtomicVerificationResult,
  CanonicalAtomicClaimV1,
  GroundedDraftProposal,
  SealedApprovedRenderContextV1,
} from './contracts.js';
import {
  sealGroundedCandidateV1,
  validateTargetedRevisionV1,
  type AtomicRevisionBaseV1,
  type SealGroundedCandidateInput,
} from './sealed-grounded-candidate.js';

const FIRST_KEY =
  '4387ecf2490363d8a622c336934a02010010f41ac0f38fab0fcf851a9b27f8bb';
const SECOND_KEY =
  '9a38bec5c750ab77ba02b21c4a15590fd86ab955b289da210f9846f1eb8704e2';
const ASSIGNMENT_SNAPSHOT_DIGEST = 'd'.repeat(64);

function evidence(
  evidenceId: string,
  text: string,
  rank: number,
): AssignedEvidenceSnapshot {
  return {
    evidence_id: evidenceId,
    chunk_id: `chunk-${evidenceId}`,
    project_id: 'project-1',
    file_id: `file-${evidenceId}`,
    document_id: `document-${evidenceId}`,
    retrieval_run_id: 'run-1',
    ingestion_key: `ingestion-${evidenceId}`,
    content: `unsealed prefix ${text} suffix`,
    exact_span_text: text,
    chunk_char_start: 10,
    exact_span_document_start: rank * 10,
    exact_span_document_end: rank * 10 + text.length,
    candidate_rank: rank,
    scores: {
      sparse: rank === 1 ? null : 0.25,
      dense: rank === 1 ? 0.125 : null,
      fusion: rank === 1 ? 1e-7 : 0.5,
      rerank: rank === 1 ? 0.75 : 1,
    },
    ranks: {
      sparse: rank === 1 ? null : rank,
      dense: rank === 1 ? rank : null,
      fusion: rank,
      rerank: rank,
    },
    page_start: 1,
    page_end: 1,
    heading_path: ['第一章'],
    index_snapshot: {
      generation: 7,
      shard: evidenceId,
    },
    evidence_snapshot_digest:
      evidenceId === 'evidence:1' ? 'a'.repeat(64) : 'b'.repeat(64),
  };
}

function proposal(
  firstText = '太阳能供电。',
  secondText = '储能系统稳定。',
): GroundedDraftProposal {
  return {
    schema_version: 'grounded-draft.v1',
    status: 'draft',
    claims: [
      {
        proposal_claim_id: 'claim-1',
        revision_of_candidate_claim_key: null,
        claim_text: firstText,
        span: {
          fragment_id: 'claim-fragment-1',
          start_utf16: 0,
          end_utf16: firstText.length,
        },
        subject: { surface: '太', start_utf16: 0, end_utf16: 1 },
        predicate: { surface: '阳', start_utf16: 1, end_utf16: 2 },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [],
        evidence_ids: ['evidence:2'],
      },
      {
        proposal_claim_id: 'claim-2',
        revision_of_candidate_claim_key: null,
        claim_text: secondText,
        span: {
          fragment_id: 'claim-fragment-2',
          start_utf16: 0,
          end_utf16: secondText.length,
        },
        subject: { surface: '储', start_utf16: 0, end_utf16: 1 },
        predicate: { surface: '能', start_utf16: 1, end_utf16: 2 },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [],
        evidence_ids: ['evidence:1'],
      },
    ],
    render_fragments: [
      {
        fragment_id: 'heading-fragment',
        kind: 'structure_ref',
        structure_id: 'heading',
        presentation: 'heading_1',
      },
      {
        fragment_id: 'line',
        kind: 'separator',
        token: 'line_break',
      },
      {
        fragment_id: 'claim-fragment-1',
        kind: 'claim_ref',
        claim_id: 'claim-1',
        presentation: 'sentence',
      },
      {
        fragment_id: 'paragraph',
        kind: 'separator',
        token: 'paragraph_break',
      },
      {
        fragment_id: 'claim-fragment-2',
        kind: 'claim_ref',
        claim_id: 'claim-2',
        presentation: 'sentence',
      },
    ],
    ordering: [
      'heading-fragment',
      'line',
      'claim-fragment-1',
      'paragraph',
      'claim-fragment-2',
    ],
    material_gap: null,
  };
}

function claimBase(
  candidateClaimKey: string,
  sourceText: string,
  ordinal: number,
  evidenceId: string,
  revisionAttempt: 0 | 1 = 0,
  revisionOf: string | null = null,
): Omit<CanonicalAtomicClaimV1, 'rendered_claim_text'> {
  return {
    canonical_claim_version: 'canonical-atomic-claim.v1',
    candidate_claim_key: candidateClaimKey,
    source_claim_text_nfc: sourceText,
    subject_anchor: {
      surface_nfc: sourceText.slice(0, 1),
      start_utf16: 0,
      end_utf16: 1,
    },
    predicate_anchor: {
      surface_nfc: sourceText.slice(1, 2),
      start_utf16: 1,
      end_utf16: 2,
    },
    polarity: 'affirmed',
    quantifier: 'plain',
    quantities: [],
    evidence_ids: [evidenceId],
    fragment: {
      ordinal,
      presentation: 'sentence',
      previous_structure_id: 'heading',
      next_structure_id: null,
    },
    revision: {
      attempt: revisionAttempt,
      revision_of_candidate_claim_key: revisionOf,
    },
  };
}

function verification(
  firstText = '太阳能供电。',
  secondText = '储能系统稳定。',
): AtomicVerificationResult {
  return {
    decision: 'ALLOW',
    canonical_proposal: proposal(firstText, secondText),
    claims: [
      {
        candidate_claim_key: FIRST_KEY,
        canonical_claim_base: claimBase(FIRST_KEY, firstText, 2, 'evidence:2'),
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_extract_exact',
        evidence_refs: [
          {
            evidence_id: 'evidence:2',
            evidence_snapshot_digest: 'b'.repeat(64),
          },
        ],
        reason_codes: [],
      },
      {
        candidate_claim_key: SECOND_KEY,
        canonical_claim_base: claimBase(
          SECOND_KEY,
          secondText,
          4,
          'evidence:1',
        ),
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_typed_equivalent',
        evidence_refs: [
          {
            evidence_id: 'evidence:1',
            evidence_snapshot_digest: 'a'.repeat(64),
          },
        ],
        reason_codes: [],
      },
    ],
    material_gap_reason: null,
  };
}

function context(): SealedApprovedRenderContextV1 {
  return {
    context_version: 'approved-render-context.v1',
    entries: [
      {
        structure_id: 'z-unused',
        source_kind: 'style_template',
        source_id: 'style-1',
        source_version: '2',
        label_nfc: '附录',
        presentation: 'heading_3',
      },
      {
        structure_id: 'heading',
        source_kind: 'outline',
        source_id: 'outline-1',
        source_version: '4',
        label_nfc: '能源系统',
        presentation: 'heading_1',
      },
    ],
  };
}

function assignment(): GroundingAssignmentSnapshot {
  return {
    workflow_job_id: 'job-1',
    project_id: 'project-1',
    retrieval_run_id: 'run-1',
    retrieval_state: 'READY',
    strict_mode: true,
    targeted_revision_attempts: 0,
    snapshot_digest: ASSIGNMENT_SNAPSHOT_DIGEST,
    evidence: [
      evidence('evidence:2', '太阳能供电', 2),
      evidence('evidence:1', '储能系统稳定', 1),
    ],
  };
}

function sealInput(): SealGroundedCandidateInput {
  return {
    workflow: {
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      workflow_type: 'content',
      generation_attempt: 2,
      revision_attempt: 0,
    },
    verification: verification(),
    assignment: assignment(),
    render_context: context(),
  };
}

function revisionBase(): AtomicRevisionBaseV1 {
  const baseVerification = verification();
  return {
    verification: baseVerification,
    allowed_candidate_claim_keys: [FIRST_KEY],
    proposal_digest: digestCanonicalV1(
      'grounded-draft.v1',
      baseVerification.canonical_proposal,
    ),
  };
}

function validRevision(): AtomicVerificationResult {
  const next = verification('太阳能可持续供电。', '储能系统稳定。');
  next.canonical_proposal.claims[0].revision_of_candidate_claim_key = FIRST_KEY;
  next.claims[0].canonical_claim_base = claimBase(
    FIRST_KEY,
    '太阳能可持续供电。',
    2,
    'evidence:2',
    1,
    FIRST_KEY,
  );
  next.claims[1].canonical_claim_base = claimBase(
    SECOND_KEY,
    '储能系统稳定。',
    4,
    'evidence:1',
    1,
    null,
  );
  return next;
}

describe('sealGroundedCandidateV1', () => {
  it('produces fixed digest goldens and complete versioned envelope bytes', () => {
    const sealed = sealGroundedCandidateV1(sealInput());

    expect(sealed.server_output.text).toBe(
      '# 能源系统\n' +
        '<!-- paragraph_key:p1 -->\n' +
        '太阳能供电。\n\n' +
        '<!-- paragraph_key:p2 -->\n' +
        '储能系统稳定。',
    );
    expect(sealed.digests).toEqual({
      proposal_digest:
        '4c584a53587ea4a67ba3bd766dab03dfc62206c6d8395a0371c836bbcc6d8e30',
      render_context_digest:
        'f7b9b7191d3cf14e773d939fff40df59e5b066683e6d3a953cd7b8e5cafc1844',
      render_digest:
        'ea198ec9a06f24ec1b797389688e7eab0f6ead75af8e916f09daf268321326a1',
      assignment_digest:
        'c7df66533f102051698d5d47c11147f7dbae44b6aac51676b3d26dc5cbed35be',
      ledger_digest:
        '25e7abc1931723db4312f44595cf7026ae952811f768be879730866b84a76077',
      envelope_digest:
        '7feea1c0d03fa7d5e4d61d1cff583a6ecf6cfbf5e146e4e2a72095e8498709ac',
    });
    expect(sealed).toMatchObject({
      envelope_version: 'sealed-grounded-candidate.v1',
      contract_version: 'atomic:v1',
      schema_version: 'grounded-draft.v1',
      canonical_json_version: 'canonical-json.v1',
      canonicalizer_version: 'atomic-canonicalizer.v1',
      quantity_lexer_version: 'quantity-lexer.v1',
      plain_text_escape_version: 'escape-plain-text.v1',
      renderer_version: 'atomic-renderer.v1',
      verifier_version: 'atomic-verifier.v1',
    });
  });

  it('sorts claims, context, evidence snapshots and evidence refs by contract', () => {
    const input = sealInput();
    input.verification.claims.reverse();
    input.verification.claims[0].evidence_refs = [
      {
        evidence_id: 'evidence:2',
        evidence_snapshot_digest: 'b'.repeat(64),
      },
      {
        evidence_id: 'evidence:1',
        evidence_snapshot_digest: 'a'.repeat(64),
      },
    ];
    input.verification.claims[0].canonical_claim_base.evidence_ids = [
      'evidence:1',
      'evidence:2',
    ];
    const sealed = sealGroundedCandidateV1(input);

    expect(sealed.claims.map((claim) => claim.candidate_claim_key)).toEqual([
      FIRST_KEY,
      SECOND_KEY,
    ]);
    expect(
      sealed.render_context.entries.map((entry) => entry.structure_id),
    ).toEqual(['heading', 'z-unused']);
    expect(
      sealed.evidence_snapshots.map((snapshot) => snapshot.evidence_id),
    ).toEqual(['evidence:1', 'evidence:2']);
    expect(
      sealed.claims[1].evidence_refs.map((ref) => ref.evidence_id),
    ).toEqual(['evidence:1', 'evidence:2']);
    expect(sealed.evidence_snapshots[0].scores).toEqual({
      sparse: null,
      dense: '0.125',
      fusion: '0.0000001',
      rerank: '0.75',
    });
  });

  it('keeps candidate keys stable but changes persisted IDs and later offsets after target growth', () => {
    const before = sealGroundedCandidateV1(sealInput());
    const revisedInput = sealInput();
    revisedInput.workflow.revision_attempt = 1;
    revisedInput.assignment.targeted_revision_attempts = 1;
    revisedInput.verification = validRevision();
    const after = sealGroundedCandidateV1(revisedInput);

    expect(after.claims.map((claim) => claim.candidate_claim_key)).toEqual(
      before.claims.map((claim) => claim.candidate_claim_key),
    );
    expect(after.claims[0].persisted_claim_id).not.toBe(
      before.claims[0].persisted_claim_id,
    );
    expect(after.claims[1].persisted_claim_id).not.toBe(
      before.claims[1].persisted_claim_id,
    );
    expect(after.claims[1].output_char_start_utf16).toBeGreaterThan(
      before.claims[1].output_char_start_utf16,
    );
    expect(after.claims[1].non_target_invariant_digest).toBe(
      before.claims[1].non_target_invariant_digest,
    );
  });

  it.each([
    [
      'non-ALLOW',
      (input: SealGroundedCandidateInput) => {
        input.verification.decision = 'WAITING_MATERIAL';
      },
    ],
    [
      'no claims',
      (input: SealGroundedCandidateInput) => {
        input.verification.claims = [];
      },
    ],
    [
      'unsupported claim',
      (input: SealGroundedCandidateInput) => {
        input.verification.claims[0].support_status = 'UNSUPPORTED';
      },
    ],
    [
      'missing evidence digest',
      (input: SealGroundedCandidateInput) => {
        delete input.assignment.evidence[0].evidence_snapshot_digest;
      },
    ],
    [
      'non-finite score',
      (input: SealGroundedCandidateInput) => {
        input.assignment.evidence[0].scores.fusion = Number.NaN;
      },
    ],
    [
      'assignment project mismatch',
      (input: SealGroundedCandidateInput) => {
        input.assignment.project_id = 'other-project';
      },
    ],
    [
      'assignment job mismatch',
      (input: SealGroundedCandidateInput) => {
        input.assignment.workflow_job_id = 'other-job';
      },
    ],
    [
      'missing assignment digest',
      (input: SealGroundedCandidateInput) => {
        delete input.assignment.snapshot_digest;
      },
    ],
  ])('fails closed before sealing: %s', (_name, mutate) => {
    const input = sealInput();
    mutate(input);
    expect(() => sealGroundedCandidateV1(input)).toThrow(
      'SEALED_CANDIDATE_INVALID',
    );
  });
});

describe('validateTargetedRevisionV1', () => {
  it('accepts exactly one allowlisted replacement while preserving non-target claims', () => {
    expect(() =>
      validateTargetedRevisionV1(revisionBase(), validRevision()),
    ).not.toThrow();
  });

  it.each([
    [
      'add',
      (next: AtomicVerificationResult) => {
        next.claims.push(structuredClone(next.claims[1]));
      },
    ],
    [
      'delete',
      (next: AtomicVerificationResult) => {
        next.claims.pop();
      },
    ],
    [
      'reorder',
      (next: AtomicVerificationResult) => {
        next.claims.reverse();
      },
    ],
    [
      'non-target text',
      (next: AtomicVerificationResult) => {
        next.claims[1].canonical_claim_base.source_claim_text_nfc =
          '篡改文本。';
      },
    ],
    [
      'non-target evidence',
      (next: AtomicVerificationResult) => {
        next.claims[1].evidence_refs[0].evidence_id = 'evidence:other';
      },
    ],
    [
      'target ordinal',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.fragment.ordinal = 3;
      },
    ],
    [
      'target presentation',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.fragment.presentation = 'bullet';
      },
    ],
    [
      'target previous structure',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.fragment.previous_structure_id =
          'other';
      },
    ],
    [
      'target next structure',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.fragment.next_structure_id =
          'other';
      },
    ],
    [
      'wrong attempt',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.revision.attempt = 0;
      },
    ],
    [
      'missing one-to-one replacement',
      (next: AtomicVerificationResult) => {
        next.claims[0].canonical_claim_base.revision.revision_of_candidate_claim_key =
          null;
        next.canonical_proposal.claims[0].revision_of_candidate_claim_key =
          null;
      },
    ],
  ])('rejects revision invariant violation: %s', (_name, mutate) => {
    const next = validRevision();
    mutate(next);
    expect(() => validateTargetedRevisionV1(revisionBase(), next)).toThrow(
      'REVISION_INVARIANT_VIOLATION',
    );
  });

  it('rejects a stale base proposal digest', () => {
    const base = revisionBase();
    base.proposal_digest = '0'.repeat(64);
    expect(() => validateTargetedRevisionV1(base, validRevision())).toThrow(
      'REVISION_INVARIANT_VIOLATION',
    );
  });
});
