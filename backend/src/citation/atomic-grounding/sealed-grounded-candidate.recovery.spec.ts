import type { GroundingAssignmentSnapshot } from '../citation-ledger.service.js';
import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import type {
  AtomicVerificationResult,
  CanonicalAtomicClaimV1,
  GroundedDraftProposal,
  SealedApprovedRenderContextV1,
  SealedGroundedCandidateV1,
} from './contracts.js';
import {
  recoverSealedGroundedCandidateV1,
  sealGroundedCandidateV1,
  type RecoverSealedCandidateInput,
  type SealGroundedCandidateInput,
} from './sealed-grounded-candidate.js';

const KEY = '4387ecf2490363d8a622c336934a02010010f41ac0f38fab0fcf851a9b27f8bb';

function evidence(): AssignedEvidenceSnapshot {
  return {
    evidence_id: 'evidence:1',
    chunk_id: 'chunk-1',
    project_id: 'project-1',
    file_id: 'file-1',
    document_id: 'document-1',
    retrieval_run_id: 'run-1',
    ingestion_key: 'ingestion-1',
    content: '系统支持并网运行',
    exact_span_text: '系统支持并网运行',
    chunk_char_start: 0,
    exact_span_document_start: 10,
    exact_span_document_end: 18,
    candidate_rank: 1,
    scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    page_start: 1,
    page_end: 1,
    heading_path: ['第一章'],
    index_snapshot: { version: 1 },
    evidence_snapshot_digest: 'a'.repeat(64),
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
    snapshot_digest: 'b'.repeat(64),
    evidence: [evidence()],
  };
}

function context(): SealedApprovedRenderContextV1 {
  return {
    context_version: 'approved-render-context.v1',
    entries: [
      {
        structure_id: 'heading',
        source_kind: 'outline',
        source_id: 'outline-1',
        source_version: '1',
        label_nfc: '并网',
        presentation: 'heading_1',
      },
    ],
  };
}

function proposal(): GroundedDraftProposal {
  const text = '系统支持并网运行。';
  return {
    schema_version: 'grounded-draft.v1',
    status: 'draft',
    claims: [
      {
        proposal_claim_id: 'claim-1',
        revision_of_candidate_claim_key: null,
        claim_text: text,
        span: {
          fragment_id: 'claim-fragment',
          start_utf16: 0,
          end_utf16: text.length,
        },
        subject: { surface: '系', start_utf16: 0, end_utf16: 1 },
        predicate: { surface: '统', start_utf16: 1, end_utf16: 2 },
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
        fragment_id: 'claim-fragment',
        kind: 'claim_ref',
        claim_id: 'claim-1',
        presentation: 'sentence',
      },
    ],
    ordering: ['heading-fragment', 'line', 'claim-fragment'],
    material_gap: null,
  };
}

function verification(): AtomicVerificationResult {
  const canonicalClaimBase: Omit<
    CanonicalAtomicClaimV1,
    'rendered_claim_text'
  > = {
    canonical_claim_version: 'canonical-atomic-claim.v1',
    candidate_claim_key: KEY,
    source_claim_text_nfc: '系统支持并网运行。',
    subject_anchor: { surface_nfc: '系', start_utf16: 0, end_utf16: 1 },
    predicate_anchor: { surface_nfc: '统', start_utf16: 1, end_utf16: 2 },
    polarity: 'affirmed',
    quantifier: 'plain',
    quantities: [],
    evidence_ids: ['evidence:1'],
    fragment: {
      ordinal: 2,
      presentation: 'sentence',
      previous_structure_id: 'heading',
      next_structure_id: null,
    },
    revision: { attempt: 0, revision_of_candidate_claim_key: null },
  };
  return {
    decision: 'ALLOW',
    canonical_proposal: proposal(),
    claims: [
      {
        candidate_claim_key: KEY,
        canonical_claim_base: canonicalClaimBase,
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_extract_exact',
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

function recoveryInput(
  checkpoint: unknown,
  overrides: Partial<RecoverSealedCandidateInput> = {},
): RecoverSealedCandidateInput {
  return {
    checkpoint,
    current_assignment: assignment(),
    current_render_context: context(),
    ...overrides,
  };
}

function checkpointUnsupportedByCurrentEvidence(): SealedGroundedCandidateV1 {
  const input = sealInput();
  const unsupportedText = '月球由奶酪构成。';
  const proposalClaim = input.verification.canonical_proposal.claims[0];
  proposalClaim.claim_text = unsupportedText;
  proposalClaim.span.end_utf16 = unsupportedText.length;
  proposalClaim.subject = {
    surface: '月',
    start_utf16: 0,
    end_utf16: 1,
  };
  proposalClaim.predicate = {
    surface: '球',
    start_utf16: 1,
    end_utf16: 2,
  };
  const canonicalClaim = input.verification.claims[0].canonical_claim_base;
  canonicalClaim.source_claim_text_nfc = unsupportedText;
  canonicalClaim.subject_anchor = {
    surface_nfc: '月',
    start_utf16: 0,
    end_utf16: 1,
  };
  canonicalClaim.predicate_anchor = {
    surface_nfc: '球',
    start_utf16: 1,
    end_utf16: 2,
  };
  return sealGroundedCandidateV1(input);
}

function mutate(
  sealed: SealedGroundedCandidateV1,
  path: string,
  value: unknown,
): unknown {
  const clone = JSON.parse(JSON.stringify(sealed)) as Record<string, unknown>;
  const parts = path.split('.');
  let cursor = clone;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
  return clone;
}

describe('recoverSealedGroundedCandidateV1', () => {
  it('closed-parses and reconstructs the full envelope without mutating checkpoint', () => {
    const sealed = sealGroundedCandidateV1(sealInput());
    const checkpoint = JSON.parse(
      JSON.stringify(sealed),
    ) as SealedGroundedCandidateV1;
    Object.freeze(checkpoint);

    const recovered = recoverSealedGroundedCandidateV1(
      recoveryInput(checkpoint),
    );

    expect(recovered).toEqual(sealed);
    expect(recovered).not.toBe(checkpoint);
    expect(recovered.claims).not.toBe(checkpoint.claims);
  });

  it.each([
    ['proposal', 'canonical_proposal.claims.0.polarity', 'negated'],
    ['context label', 'render_context.entries.0.label_nfc', '篡改'],
    ['output byte', 'server_output.text', 'naked output'],
    ['claim offset', 'claims.0.output_char_start_utf16', 0],
    ['claim status', 'claims.0.support_status', 'UNSUPPORTED'],
    ['claim method', 'claims.0.verification_method', 'atomic_unverifiable'],
    [
      'evidence index snapshot',
      'evidence_snapshots.0.index_snapshot.version',
      2,
    ],
    ['assignment digest', 'digests.assignment_digest', '0'.repeat(64)],
  ])('rejects tampered %s', (_name, path, value) => {
    const sealed = sealGroundedCandidateV1(sealInput());
    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(mutate(sealed, path, value)),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');
  });

  it.each([
    ['envelope_version', 'sealed-grounded-candidate.v0'],
    ['contract_version', 'legacy:v0'],
    ['schema_version', 'grounded-draft.v0'],
    ['canonical_json_version', 'canonical-json.v0'],
    ['canonicalizer_version', 'atomic-canonicalizer.v0'],
    ['quantity_lexer_version', 'quantity-lexer.v0'],
    ['plain_text_escape_version', 'escape-plain-text.v0'],
    ['renderer_version', 'atomic-renderer.v0'],
    ['verifier_version', 'atomic-verifier.v0'],
  ])('rejects changed version %s', (field, value) => {
    const sealed = sealGroundedCandidateV1(sealInput());
    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(mutate(sealed, field, value)),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');
  });

  it('rejects digest-only, naked-output and unknown-field checkpoints', () => {
    const sealed = sealGroundedCandidateV1(sealInput());
    for (const checkpoint of [
      { digests: sealed.digests },
      { server_output: sealed.server_output },
      { ...sealed, provider_output: 'untrusted' },
    ]) {
      expect(() =>
        recoverSealedGroundedCandidateV1(recoveryInput(checkpoint)),
      ).toThrow('SEALED_CANDIDATE_INVALID');
    }
  });

  it('rejects current assignment, evidence and render-context drift', () => {
    const sealed = sealGroundedCandidateV1(sealInput());
    const changedAssignment = assignment();
    changedAssignment.snapshot_digest = 'c'.repeat(64);
    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(sealed, { current_assignment: changedAssignment }),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');

    const changedEvidence = assignment();
    changedEvidence.evidence[0].evidence_snapshot_digest = 'c'.repeat(64);
    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(sealed, { current_assignment: changedEvidence }),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');

    const changedContext = context();
    changedContext.entries[0].source_version = '2';
    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(sealed, { current_render_context: changedContext }),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');
  });

  it('rejects a self-consistent six-digest checkpoint unsupported by current sealed evidence', () => {
    const checkpoint = checkpointUnsupportedByCurrentEvidence();

    expect(() =>
      recoverSealedGroundedCandidateV1(recoveryInput(checkpoint)),
    ).toThrow('SEALED_CANDIDATE_INVALID');
  });

  it('rejects current assignment targeted revision-attempt drift', () => {
    const checkpoint = sealGroundedCandidateV1(sealInput());
    const currentAssignment = assignment();
    currentAssignment.targeted_revision_attempts = 1;

    expect(() =>
      recoverSealedGroundedCandidateV1(
        recoveryInput(checkpoint, {
          current_assignment: currentAssignment,
        }),
      ),
    ).toThrow('SEALED_CANDIDATE_INVALID');
  });
});
