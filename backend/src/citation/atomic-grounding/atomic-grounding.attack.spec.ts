import type { AssignedEvidenceSnapshot } from '../grounding-verifier.js';
import type {
  AtomicClaimProposal,
  GroundedDraftProposal,
  QuantityProposal,
} from './contracts.js';
import { AtomicGroundingVerifier } from './atomic-grounding.verifier.js';

const DIGEST = 'a'.repeat(64);

function quantity(
  claimText: string,
  surface: string,
  value: string,
  unit: string | null,
  dimension: QuantityProposal['dimension'],
  comparator: QuantityProposal['comparator'] = 'eq',
): QuantityProposal {
  const start = claimText.indexOf(surface);
  return {
    quantity_id: `q${start}`,
    surface,
    start_utf16: start,
    end_utf16: start + surface.length,
    dimension,
    value,
    unit,
    comparator,
    range_end: null,
  };
}

function quantitiesFor(text: string): QuantityProposal[] {
  const fixtures: Array<
    [
      string,
      string,
      string | null,
      QuantityProposal['dimension'],
      QuantityProposal['comparator']?,
    ]
  > = [];
  for (const match of text.matchAll(/(?:300|400)MW/gu)) {
    fixtures.push([match[0], match[0].slice(0, 3), 'MW', 'power']);
  }
  if (text.includes('1年')) fixtures.push(['1年', '1', '年', 'duration']);
  if (text.includes('50%以上')) {
    fixtures.push(['50%以上', '50', '%', 'ratio', 'gte']);
  } else if (text.includes('50%')) {
    fixtures.push(['50%', '50', '%', 'ratio']);
  }
  if (text.includes('一亿亿瓦')) {
    fixtures.push(['一亿亿瓦', '200000000', '瓦', 'power']);
  }
  return fixtures.map(([surface, value, unit, dimension, comparator]) =>
    quantity(text, surface, value, unit, dimension, comparator),
  );
}

function draft(claimText: string): GroundedDraftProposal {
  let quantifier: AtomicClaimProposal['quantifier'] = 'plain';
  if (claimText.startsWith('不是所有')) quantifier = 'not_all';
  const claim: AtomicClaimProposal = {
    proposal_claim_id: 'c1',
    revision_of_candidate_claim_key: null,
    claim_text: claimText,
    span: { fragment_id: 'f1', start_utf16: 0, end_utf16: claimText.length },
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
    polarity: 'affirmed',
    quantifier,
    quantities: quantitiesFor(claimText),
    evidence_ids: ['evidence:1'],
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

function evidence(text: string): AssignedEvidenceSnapshot {
  return {
    evidence_id: 'evidence:1',
    chunk_id: 'chunk-1',
    project_id: 'project-1',
    file_id: 'file-1',
    document_id: 'document-1',
    retrieval_run_id: 'run-1',
    ingestion_key: 'ingestion-1',
    content: text,
    exact_span_text: text,
    chunk_char_start: 0,
    exact_span_document_start: 0,
    exact_span_document_end: text.length,
    candidate_rank: 1,
    scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
    page_start: 1,
    page_end: 1,
    heading_path: [],
    index_snapshot: {},
    evidence_snapshot_digest: DIGEST,
  };
}

describe('atomic grounding attack corpus', () => {
  it.each([
    ['系统支持并网运行。', '系统支持，网运行'],
    ['系统支持和田基地运行。', '系统支持，田基地运行'],
    ['系统支持与会人员使用。', '系统支持，会人员使用'],
    ['系统支持及格率提高。', '系统支持，格率提高'],
    ['甲容量为300MW和乙容量为400MW。', '甲容量为400MW和乙容量为300MW。'],
    ['不是所有系统都可以运行。', '所有系统都不能运行。'],
    ['建设周期为1年。', '建设周期为1年半。'],
    ['建设周期为1年。', '建设周期为1年以上。'],
    ['完成比例为50%。', '完成比例为50%以上。'],
    ['项目已完成。', '项目已完成一半。'],
    ['容量为一亿亿瓦。', '容量为200兆瓦'],
  ])('never supports adversarial pair %#', (claimText, span) => {
    const result = new AtomicGroundingVerifier().verify({
      workflow_job_id: 'job-attack',
      project_id: 'project-1',
      generation_attempt: 0,
      revision_attempt: 0,
      proposal: draft(claimText),
      assignment_digest: 'b'.repeat(64),
      evidence: [evidence(span)],
    });

    expect(
      result.claims.some((claim) => claim.support_status === 'SUPPORTED'),
    ).toBe(false);
    expect(result.decision).not.toBe('ALLOW');
  });
});
