import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import type {
  AtomicClaimProposal,
  Comparator,
  GroundedDraftProposal,
  QuantityDimension,
  QuantityProposal,
} from './contracts.js';
import {
  AtomicGroundingVerifier,
  AtomicVerificationFailure,
} from './atomic-grounding.verifier.js';

const DIGEST = 'a'.repeat(64);
const ASSIGNMENT_DIGEST = 'b'.repeat(64);

interface QuantityFixture {
  surface: string;
  dimension: QuantityDimension;
  value: string;
  unit: string | null;
  comparator?: Comparator;
  range_end?: string | null;
}

function quantity(
  text: string,
  fixture: QuantityFixture,
  index: number,
): QuantityProposal {
  const start = text.indexOf(fixture.surface);
  if (start < 0) throw new Error(`missing test quantity ${fixture.surface}`);
  return {
    quantity_id: `q${index + 1}`,
    surface: fixture.surface,
    start_utf16: start,
    end_utf16: start + fixture.surface.length,
    dimension: fixture.dimension,
    value: fixture.value,
    unit: fixture.unit,
    comparator: fixture.comparator ?? 'eq',
    range_end: fixture.range_end ?? null,
  };
}

function proposal(
  claimText: string,
  quantities: QuantityFixture[] = [],
  options: {
    evidenceIds?: string[];
    polarity?: AtomicClaimProposal['polarity'];
    quantifier?: AtomicClaimProposal['quantifier'];
    revisionKey?: string | null;
  } = {},
): GroundedDraftProposal {
  const claim: AtomicClaimProposal = {
    proposal_claim_id: 'c1',
    revision_of_candidate_claim_key: options.revisionKey ?? null,
    claim_text: claimText,
    span: {
      fragment_id: 'f1',
      start_utf16: 0,
      end_utf16: claimText.length,
    },
    subject: {
      surface: claimText.slice(0, 1),
      start_utf16: 0,
      end_utf16: 1,
    },
    predicate: {
      surface: claimText.slice(1, 2),
      start_utf16: 1,
      end_utf16: 2,
    },
    polarity: options.polarity ?? 'affirmed',
    quantifier: options.quantifier ?? 'plain',
    quantities: quantities.map((item, index) =>
      quantity(claimText, item, index),
    ),
    evidence_ids: options.evidenceIds ?? ['evidence:1'],
  };
  return {
    schema_version: 'grounded-draft.v1',
    status: 'draft',
    claims: [claim],
    render_fragments: [
      {
        fragment_id: 'f1',
        kind: 'claim_ref',
        claim_id: 'c1',
        presentation: 'sentence',
      },
    ],
    ordering: ['f1'],
    material_gap: null,
  };
}

function evidence(
  exactSpanText: string,
  overrides: Partial<AssignedEvidenceSnapshot> = {},
): AssignedEvidenceSnapshot {
  return {
    evidence_id: 'evidence:1',
    chunk_id: 'chunk-1',
    project_id: 'project-1',
    file_id: 'file-1',
    document_id: 'document-1',
    retrieval_run_id: 'run-1',
    ingestion_key: 'ingestion-1',
    content: exactSpanText,
    exact_span_text: exactSpanText,
    chunk_char_start: 0,
    exact_span_document_start: 0,
    exact_span_document_end: exactSpanText.length,
    candidate_rank: 1,
    scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    page_start: 1,
    page_end: 1,
    heading_path: ['第一章'],
    index_snapshot: { version: 1 },
    evidence_snapshot_digest: DIGEST,
    ...overrides,
  };
}

function verify(
  draft: GroundedDraftProposal,
  evidenceRows: AssignedEvidenceSnapshot[],
  revisionAttempt: 0 | 1 = 0,
) {
  return new AtomicGroundingVerifier().verify({
    workflow_job_id: 'job-1',
    project_id: 'project-1',
    generation_attempt: 2,
    revision_attempt: revisionAttempt,
    proposal: draft,
    assignment_digest: ASSIGNMENT_DIGEST,
    evidence: evidenceRows,
  });
}

describe('AtomicGroundingVerifier', () => {
  it('supports a full exact extract and generates the fixed candidate key', () => {
    const result = verify(proposal('系统支持并网运行。'), [
      evidence('系统支持并网运行'),
    ]);

    expect(result).toMatchObject({
      decision: 'ALLOW',
      material_gap_reason: null,
      claims: [
        {
          candidate_claim_key:
            '177af1b766dc17ee94b980f8499a739480b99b7332b4205e6f3e763079c8e154',
          support_status: 'SUPPORTED',
          support_score: '1',
          verification_method: 'atomic_extract_exact',
          evidence_refs: [
            {
              evidence_id: 'evidence:1',
              evidence_snapshot_digest: DIGEST,
            },
          ],
          reason_codes: [],
        },
      ],
    });
    expect(result.claims[0].canonical_claim_base).not.toHaveProperty(
      'rendered_claim_text',
    );
  });

  it.each([
    [
      'power',
      '装机容量为0.3GW。',
      [{ surface: '0.3GW', dimension: 'power', value: '0.3', unit: 'GW' }],
      '装机容量为300MW',
    ],
    [
      'duration',
      '建设周期为12个月。',
      [{ surface: '12个月', dimension: 'duration', value: '12', unit: '个月' }],
      '建设周期为1年',
    ],
    [
      'ratio',
      '完成比例为50%。',
      [{ surface: '50%', dimension: 'ratio', value: '50', unit: '%' }],
      '完成比例为0.5',
    ],
    [
      'strict comparator',
      '装机容量超过300MW。',
      [
        {
          surface: '超过300MW',
          dimension: 'power',
          value: '300',
          unit: 'MW',
          comparator: 'gt',
        },
      ],
      '装机容量大于300MW',
    ],
  ] as const)(
    'supports typed equivalent %s only with an equal skeleton',
    (_name, claimText, quantities, span) => {
      const result = verify(proposal(claimText, [...quantities]), [
        evidence(span),
      ]);

      expect(result.claims[0]).toMatchObject({
        support_status: 'SUPPORTED',
        support_score: '1',
        verification_method: 'atomic_typed_equivalent',
        reason_codes: [],
      });
      expect(result.decision).toBe('ALLOW');
    },
  );

  it.each(['容量为发 电量', '容量为发　电量'])(
    'rejects an internal-space exact mismatch: %s',
    (span) => {
      const result = verify(proposal('容量为发电量。'), [evidence(span)]);

      expect(result.claims[0]).toMatchObject({
        support_status: 'UNSUPPORTED',
        support_score: '0',
        verification_method: 'atomic_unsupported',
        reason_codes: ['ATOM_TYPED_SKELETON_MISMATCH'],
      });
      expect(result.decision).not.toBe('ALLOW');
    },
  );

  it('rejects an internal-space typed skeleton mismatch', () => {
    const result = verify(
      proposal('容量为0.3GW。', [
        {
          surface: '0.3GW',
          dimension: 'power',
          value: '0.3',
          unit: 'GW',
        },
      ]),
      [evidence('容量 为300MW')],
    );

    expect(result.claims[0]).toMatchObject({
      support_status: 'UNSUPPORTED',
      support_score: '0',
      verification_method: 'atomic_unsupported',
      reason_codes: ['ATOM_TYPED_SKELETON_MISMATCH'],
    });
    expect(result.decision).not.toBe('ALLOW');
  });

  it('maps full-width spaces to ASCII without deleting an internal space', () => {
    const result = verify(proposal('容量为发 电量。'), [
      evidence('容量为发　电量'),
    ]);

    expect(result).toMatchObject({
      decision: 'ALLOW',
      claims: [
        {
          support_status: 'SUPPORTED',
          verification_method: 'atomic_extract_exact',
        },
      ],
    });
  });

  it.each([
    [
      'missing quantity',
      '甲为300MW，乙为400MW。',
      [
        { surface: '300MW', dimension: 'power', value: '300', unit: 'MW' },
        { surface: '400MW', dimension: 'power', value: '400', unit: 'MW' },
      ],
      '甲为300MW，乙为空',
      'ATOM_QUANTITY_MISMATCH',
    ],
    [
      'reordered quantity',
      '甲为300MW，乙为400MW。',
      [
        { surface: '300MW', dimension: 'power', value: '300', unit: 'MW' },
        { surface: '400MW', dimension: 'power', value: '400', unit: 'MW' },
      ],
      '甲为400MW，乙为300MW',
      'ATOM_QUANTITY_MISMATCH',
    ],
    [
      'wrong adjacent value',
      '甲为300MW。',
      [{ surface: '300MW', dimension: 'power', value: '300', unit: 'MW' }],
      '甲为301MW',
      'ATOM_QUANTITY_MISMATCH',
    ],
    [
      'gte versus gt',
      '容量至少300MW。',
      [
        {
          surface: '至少300MW',
          dimension: 'power',
          value: '300',
          unit: 'MW',
          comparator: 'gte',
        },
      ],
      '容量超过300MW',
      'ATOM_QUANTITY_MISMATCH',
    ],
    [
      'different skeleton',
      '甲容量为300MW。',
      [{ surface: '300MW', dimension: 'power', value: '300', unit: 'MW' }],
      '乙容量为300MW',
      'ATOM_TYPED_SKELETON_MISMATCH',
    ],
    [
      'polarity',
      '系统可以运行。',
      [],
      '系统不能运行',
      'ATOM_POLARITY_MISMATCH',
    ],
    [
      'quantifier',
      '不是所有系统都可以运行。',
      [],
      '所有系统都可以运行',
      'ATOM_QUANTIFIER_MISMATCH',
      { quantifier: 'not_all' as const },
    ],
    [
      'approx exact-only',
      '容量约300MW。',
      [
        {
          surface: '约300MW',
          dimension: 'power',
          value: '300',
          unit: 'MW',
          comparator: 'approx',
        },
      ],
      '容量约为300MW',
      'ATOM_EXACT_MISMATCH',
    ],
    [
      'range exact-only',
      '容量300至400MW。',
      [
        {
          surface: '300至400MW',
          dimension: 'power',
          value: '300',
          unit: 'MW',
          comparator: 'range',
          range_end: '400',
        },
      ],
      '容量300到400MW',
      'ATOM_EXACT_MISMATCH',
    ],
    [
      'other dimension exact-only',
      '指标为1。',
      [{ surface: '1', dimension: 'other', value: '1', unit: null }],
      '指标为+1',
      'ATOM_EXACT_MISMATCH',
    ],
  ] as const)(
    'rejects %s',
    (_name, claimText, quantities, span, reason, options = {}) => {
      const result = verify(proposal(claimText, [...quantities], options), [
        evidence(span),
      ]);

      expect(result.claims[0]).toMatchObject({
        support_status: 'UNSUPPORTED',
        support_score: '0',
        verification_method: 'atomic_unsupported',
        reason_codes: [reason],
      });
      expect(result.decision).toBe('TARGETED_RETRIEVAL_REVISION');
    },
  );

  it('requires every evidence record to support the whole atom', () => {
    const draft = proposal(
      '甲容量为300MW，乙容量为400MW。',
      [
        { surface: '300MW', dimension: 'power', value: '300', unit: 'MW' },
        { surface: '400MW', dimension: 'power', value: '400', unit: 'MW' },
      ],
      { evidenceIds: ['evidence:1', 'evidence:2'] },
    );
    const result = verify(draft, [
      evidence('甲容量为300MW', { evidence_id: 'evidence:1' }),
      evidence('乙容量为400MW', { evidence_id: 'evidence:2' }),
    ]);

    expect(result.claims[0]).toMatchObject({
      support_status: 'UNSUPPORTED',
      reason_codes: ['ATOM_EVIDENCE_MOSAIC_UNSUPPORTED'],
    });
    expect(result.decision).not.toBe('ALLOW');
  });

  it('rejects one irrelevant evidence among otherwise exact records', () => {
    const draft = proposal('系统支持并网运行。', [], {
      evidenceIds: ['evidence:1', 'evidence:2', 'evidence:3'],
    });
    const result = verify(draft, [
      evidence('系统支持并网运行', { evidence_id: 'evidence:1' }),
      evidence('系统支持并网运行', { evidence_id: 'evidence:2' }),
      evidence('无关事实', { evidence_id: 'evidence:3' }),
    ]);

    expect(result.claims[0].support_status).toBe('UNSUPPORTED');
    expect(result.decision).not.toBe('ALLOW');
  });

  it.each([
    [
      'unknown proposal evidence',
      proposal('系统支持并网运行。', [], {
        evidenceIds: ['evidence:missing'],
      }),
      [evidence('系统支持并网运行')],
      'EVIDENCE_UNKNOWN',
    ],
    [
      'duplicate assigned evidence',
      proposal('系统支持并网运行。'),
      [evidence('系统支持并网运行'), evidence('系统支持并网运行')],
      'ASSIGNMENT_SNAPSHOT_DRIFT',
    ],
    [
      'missing snapshot digest',
      proposal('系统支持并网运行。'),
      [
        evidence('系统支持并网运行', {
          evidence_snapshot_digest: undefined,
        }),
      ],
      'EVIDENCE_SNAPSHOT_DRIFT',
    ],
    [
      'missing exact span text',
      proposal('系统支持并网运行。'),
      [
        evidence('系统支持并网运行', {
          exact_span_text: undefined as unknown as string,
        }),
      ],
      'EVIDENCE_SNAPSHOT_DRIFT',
    ],
    [
      'project mismatch',
      proposal('系统支持并网运行。'),
      [evidence('系统支持并网运行', { project_id: 'project-2' })],
      'EVIDENCE_OWNERSHIP_INVALID',
    ],
  ] as const)(
    'fails closed for %s with stable attempt transitions',
    (_name, draft, rows, reason) => {
      const first = verify(draft, [...rows], 0);
      const second = verify(draft, [...rows], 1);

      expect(first.material_gap_reason).toBe(reason);
      expect(second.material_gap_reason).toBe(reason);
      if (reason === 'EVIDENCE_UNKNOWN') {
        expect(first.decision).toBe('TARGETED_RETRIEVAL_REVISION');
        expect(second.decision).toBe('WAITING_MATERIAL');
      } else {
        expect(first.decision).toBe('WAITING_MATERIAL');
        expect(second.decision).toBe('WAITING_MATERIAL');
      }
    },
  );

  it('rejects server-authority fields through schema validation before support', () => {
    const draft = {
      ...proposal('系统支持并网运行。'),
      support_status: 'SUPPORTED',
    } as unknown as GroundedDraftProposal;

    const result = verify(draft, [evidence('系统支持并网运行')]);

    expect(result).toMatchObject({
      decision: 'WAITING_MATERIAL',
      claims: [],
      material_gap_reason: 'SCHEMA_INVALID',
    });
  });

  it('maps an injected unknown exception to a sanitized fail-closed failure', () => {
    const secret = 'fixture-secret-raw-provider-error';
    const row = evidence('系统支持并网运行');
    Object.defineProperty(row, 'evidence_id', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    const verifier = new AtomicGroundingVerifier();

    let caught: unknown;
    try {
      verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        generation_attempt: 2,
        revision_attempt: 0,
        proposal: proposal('系统支持并网运行。'),
        assignment_digest: ASSIGNMENT_DIGEST,
        evidence: [row],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AtomicVerificationFailure);
    expect(caught).toMatchObject({
      disposition: {
        internal_reason: 'INTERNAL_FAIL_CLOSED',
        public_code: 'ATOMIC_GROUNDING_FAILED',
        transition: 'FAILED',
      },
    });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).message).not.toContain(secret);
  });

  it('does not expose a replaceable evidence-support authority', () => {
    const VerifierWithUnexpectedArgument =
      AtomicGroundingVerifier as unknown as new (
        value: unknown,
      ) => AtomicGroundingVerifier;
    const verifier = new VerifierWithUnexpectedArgument(() => ({
      supported: true,
      method: 'exact',
      reason: null,
    }));

    const result = verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      generation_attempt: 2,
      revision_attempt: 0,
      proposal: proposal('系统支持并网运行。'),
      assignment_digest: ASSIGNMENT_DIGEST,
      evidence: [evidence('无关事实')],
    });

    expect(result.decision).not.toBe('ALLOW');
    expect(result.claims[0]?.support_status).not.toBe('SUPPORTED');
  });

  it('rejects candidate-key revision metadata on an initial attempt', () => {
    const result = verify(
      proposal('系统支持并网运行。', [], {
        revisionKey: 'stale-candidate-key',
      }),
      [evidence('系统支持并网运行')],
      0,
    );

    expect(result).toMatchObject({
      decision: 'WAITING_MATERIAL',
      material_gap_reason: 'REVISION_INVARIANT_VIOLATION',
    });
  });

  it('has no runtime import or call edge to the legacy free-text authority', () => {
    jest.resetModules();
    let legacyModuleLoads = 0;
    const forbidden = {
      parseVisibleOutput: jest.fn(),
      extractVisibleStatements: jest.fn(),
      splitCoordinatedPropositions: jest.fn(),
      verify: jest.fn(),
      review: jest.fn(),
    };
    jest.doMock('../grounding-verifier.js', () => {
      legacyModuleLoads += 1;
      return {
        ...forbidden,
        GroundingVerifier: class {
          verify = forbidden.verify;
        },
        SemanticGroundingReviewer: class {
          review = forbidden.review;
        },
      };
    });

    jest.isolateModules(() => {
      const atomic = jest.requireActual<
        typeof import('./atomic-grounding.verifier.js')
      >('./atomic-grounding.verifier.js');
      expect(atomic.AtomicGroundingVerifier).toBeDefined();
    });

    expect(legacyModuleLoads).toBe(0);
    for (const spy of Object.values(forbidden)) {
      expect(spy).not.toHaveBeenCalled();
    }
    jest.dontMock('../grounding-verifier.js');
  });
});
