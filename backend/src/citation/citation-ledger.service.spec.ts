import { MaterialGapError } from './material-gap.error.js';
import {
  CitationLedgerService,
  type GroundingAssignmentSnapshot,
  type GroundingEvidenceStore,
} from './citation-ledger.service.js';
import { GroundingVerifier } from './grounding-verifier.js';

class MemoryEvidenceStore implements GroundingEvidenceStore {
  assignment: GroundingAssignmentSnapshot | null;
  savedResults: string[] = [];

  constructor(assignment: GroundingAssignmentSnapshot | null) {
    this.assignment = assignment;
  }

  async loadAssignment(): Promise<GroundingAssignmentSnapshot | null> {
    await Promise.resolve();
    return this.assignment;
  }

  async saveLedger(_manager: unknown, resultId: string): Promise<void> {
    await Promise.resolve();
    this.savedResults.push(resultId);
  }
}

const assignment = (): GroundingAssignmentSnapshot => ({
  workflow_job_id: 'job-1',
  project_id: 'project-1',
  retrieval_run_id: 'run-1',
  retrieval_state: 'READY',
  contract_version: 'legacy:v0',
  strict_mode: true,
  targeted_revision_attempts: 1,
  evidence: [
    {
      evidence_id: 'evidence:chunk-1',
      chunk_id: 'chunk-1',
      project_id: 'project-1',
      file_id: 'file-1',
      document_id: 'document-1',
      retrieval_run_id: 'run-1',
      ingestion_key: 'ingestion-1',
      content: '本项目装机容量为 300 MW。',
      exact_span_text: '装机容量为 300 MW',
      chunk_char_start: 100,
      exact_span_document_start: 103,
      exact_span_document_end: 115,
      candidate_rank: 1,
      scores: { sparse: 4, dense: 0.8, fusion: 0.06, rerank: 0.9 },
      ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
      page_start: 2,
      page_end: 2,
      heading_path: ['项目概况'],
      index_snapshot: { index_version: 'rag-v1' },
    },
  ],
});

describe('CitationLedgerService', () => {
  it('fails closed when a new authoring workflow has no assignment', async () => {
    const service = new CitationLedgerService(
      new MemoryEvidenceStore(null),
      new GroundingVerifier(),
    );

    await expect(
      service.prepare({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        output: '未绑定证据的正文。',
      }),
    ).rejects.toBeInstanceOf(MaterialGapError);
  });

  it('does not persist a result when strict grounding has a material gap', async () => {
    const store = new MemoryEvidenceStore(assignment());
    const service = new CitationLedgerService(store, new GroundingVerifier());
    const output =
      '装机容量为 500 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 500 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    await expect(
      service.prepare({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        output,
      }),
    ).rejects.toBeInstanceOf(MaterialGapError);
    expect(store.savedResults).toEqual([]);
  });

  it('never authorizes an exact legacy marker in strict mode', async () => {
    const store = new MemoryEvidenceStore(assignment());
    const service = new CitationLedgerService(store, new GroundingVerifier());
    const output =
      '装机容量为 300 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    await expect(
      service.prepare({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        output,
      }),
    ).rejects.toBeInstanceOf(MaterialGapError);
    expect(store.savedResults).toEqual([]);
  });

  it('persists capped loose legacy claims only after a result id is supplied', async () => {
    const looseAssignment = assignment();
    looseAssignment.strict_mode = false;
    const store = new MemoryEvidenceStore(looseAssignment);
    const service = new CitationLedgerService(store, new GroundingVerifier());
    const output =
      '装机容量为 300 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    const prepared = await service.prepare({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      output,
    });
    expect(prepared).toMatchObject({
      decision: 'ALLOW_WITH_UNSUPPORTED',
      claims: [
        expect.objectContaining({
          support_status: 'UNVERIFIABLE',
          support_score: 0,
          verification_method: 'legacy_unverifiable',
        }),
      ],
    });
    expect(store.savedResults).toEqual([]);
    await service.persist({}, 'result-1', prepared);
    expect(store.savedResults).toEqual(['result-1']);
  });
});
