/* eslint-disable @typescript-eslint/unbound-method */
import type {
  GroundingAssignmentSnapshot,
  GroundingEvidenceStore,
} from '../citation-ledger.service.js';
import { SqlGroundingEvidenceStore } from '../sql-grounding-evidence.store.js';
import type { AgentService } from '../../agent/agent.service.js';
import type { GroundedDraftProposal } from './contracts.js';
import { AtomicGroundingVerifier } from './atomic-grounding.verifier.js';
import { ApprovedRenderContextService } from './approved-render-context.service.js';
import {
  AtomicGroundingMetricsRecorder,
  type AtomicMetricPoint,
} from './atomic-grounding.metrics.js';
import {
  ATOMIC_GROUNDING_REASON_CODES,
  type AtomicGroundingReasonCode,
} from './contracts.js';
import {
  AtomicGroundingClosedFailure,
  dispositionForAtomicFailure,
} from './failure-policy.js';
import {
  AtomicGroundingCoordinator,
  AtomicGroundingCoordinatorError,
} from './atomic-grounding-coordinator.service.js';

const workflow = {
  workflow_job_id: 'job-1',
  project_id: 'project-1',
  workflow_type: 'content',
  generation_attempt: 2,
  revision_attempt: 0,
  authoring_context: { project_name: '教材项目' },
  signal: new AbortController().signal,
} as const;

describe('AtomicGroundingCoordinator', () => {
  it('loads the assignment once and returns a fully sealed candidate', async () => {
    const points: AtomicMetricPoint[] = [];
    const { coordinator, store, agent } = harness(points);

    const outcome = await coordinator.generate(workflow);

    expect(outcome.kind).toBe('sealed');
    if (outcome.kind !== 'sealed') throw new Error('expected sealed outcome');
    expect(outcome.candidate.server_output.text).toContain('系统容量为300MW');
    expect(outcome.candidate.claims).toHaveLength(1);
    expect(store.loadAssignment).toHaveBeenCalledTimes(1);
    expect(agent.generateGroundedDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow_job_id: 'job-1',
        approved_render_context: context(),
        evidence: [
          {
            evidence_id: 'evidence-1',
            exact_span_text: '系统容量为300MW。',
            source_boundary: 'untrusted_evidence',
          },
        ],
      }),
      expect.objectContaining({
        signal: workflow.signal,
        trace: {
          workflow_job_id: 'job-1',
          node: 'atomic_grounded_draft',
          attempt: 2,
        },
      }),
    );
    expect(
      points.filter((point) => point.name === 'grounding_proposal_bytes'),
    ).toEqual([
      expect.objectContaining({
        value: 7_777,
      }),
    ]);
    expect(
      points.filter(
        (point) => point.name === 'grounding_structured_repair_total',
      ),
    ).toEqual([expect.objectContaining({ value: 1 })]);
    expect(
      points.filter((point) => point.name === 'grounding_render_latency_ms'),
    ).toHaveLength(1);
    expect(
      points.filter(
        (point) => point.name === 'grounding_time_to_first_rendered_token_ms',
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(points)).not.toContain('audit-only-run');
  });

  it('returns a stable material gap without rendering or sealing naked output', async () => {
    const points: AtomicMetricPoint[] = [];
    const gap: GroundedDraftProposal = {
      schema_version: 'grounded-draft.v1',
      status: 'material_gap',
      claims: [],
      render_fragments: [],
      ordering: [],
      material_gap: {
        reason_code: 'NO_EVIDENCE',
        missing_topics: ['容量'],
      },
    };
    const { coordinator } = harness(points, gap);

    await expect(coordinator.generate(workflow)).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'NO_EVIDENCE',
      candidate_claim_keys: [],
    });
    expect(
      points.filter((point) => point.name === 'grounding_material_gap_total'),
    ).toHaveLength(1);
    expect(
      points.filter((point) => point.name === 'grounding_fail_closed_total'),
    ).toHaveLength(1);
    expect(
      points.filter((point) => point.name === 'grounding_render_latency_ms'),
    ).toHaveLength(0);
  });

  it.each([
    [
      'missing assignment',
      null,
      {
        kind: 'material_gap',
        reason_code: 'ASSIGNMENT_MISSING',
        candidate_claim_keys: [],
      },
    ],
    [
      'wrong contract',
      assignment({ contract_version: 'legacy:v0' }),
      {
        kind: 'material_gap',
        reason_code: 'ASSIGNMENT_CONTRACT_MISMATCH',
        candidate_claim_keys: [],
      },
    ],
    [
      'wrong project',
      assignment({ project_id: 'project-other' }),
      {
        kind: 'material_gap',
        reason_code: 'ASSIGNMENT_PROJECT_MISMATCH',
        candidate_claim_keys: [],
      },
    ],
    [
      'non-terminal retrieval',
      assignment({ retrieval_state: 'ERROR' }),
      {
        kind: 'material_gap',
        reason_code: 'RETRIEVAL_STATE_INVALID',
        candidate_claim_keys: [],
      },
    ],
  ])('fails closed for %s', async (_label, assigned, expected) => {
    const points: AtomicMetricPoint[] = [];
    const { coordinator, agent } = harness(points, validProposal(), assigned);

    await expect(coordinator.generate(workflow)).resolves.toEqual(expected);
    expect(agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('converts an unknown thrown value to a non-leaking catch-all disposition', async () => {
    const points: AtomicMetricPoint[] = [];
    const { coordinator, agent } = harness(points);
    agent.generateGroundedDraft.mockRejectedValue(
      new Error('PROMPT_CLAIM_EVIDENCE_SECRET'),
    );

    await expect(
      coordinator.generate(workflow),
    ).rejects.toMatchObject<AtomicGroundingCoordinatorError>({
      message: 'ATOMIC_GROUNDING_FAILED',
      disposition: {
        internal_reason: 'INTERNAL_FAIL_CLOSED',
        public_code: 'ATOMIC_GROUNDING_FAILED',
        transition: 'FAILED',
      },
    });
    expect(JSON.stringify(points)).not.toContain(
      'PROMPT_CLAIM_EVIDENCE_SECRET',
    );
  });

  it.each(ATOMIC_GROUNDING_REASON_CODES)(
    'preserves the exact typed closed reason %s at the coordinator dependency boundary',
    async (reason) => {
      const points: AtomicMetricPoint[] = [];
      const { coordinator, agent } = harness(points);
      agent.generateGroundedDraft.mockRejectedValue(
        new AtomicGroundingClosedFailure(reason),
      );
      const disposition = dispositionForAtomicFailure(reason, 0);

      if (disposition.transition === 'FAILED') {
        await expect(coordinator.generate(workflow)).rejects.toMatchObject({
          disposition,
        });
      } else {
        await expect(coordinator.generate(workflow)).resolves.toEqual({
          kind: 'material_gap',
          reason_code: reason,
          candidate_claim_keys: [],
        });
      }
      expect(
        points.filter(
          (point) =>
            point.name === 'grounding_fail_closed_total' &&
            point.labels.reason === reason,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    'EVIDENCE_INGESTION_INACTIVE',
    'EVIDENCE_NOT_SELECTED',
    'EVIDENCE_RUN_DRIFT',
    'EVIDENCE_OFFSET_DRIFT',
    'EVIDENCE_LEGACY_AMBIGUOUS',
    'EVIDENCE_SNAPSHOT_DRIFT',
    'ASSIGNMENT_SNAPSHOT_DRIFT',
  ] satisfies AtomicGroundingReasonCode[])(
    'preserves typed assignment loader failure %s instead of collapsing to internal',
    async (reason) => {
      const points: AtomicMetricPoint[] = [];
      const { coordinator, store, agent } = harness(points);
      store.loadAssignment.mockRejectedValue(
        new AtomicGroundingClosedFailure(reason),
      );

      await expect(coordinator.generate(workflow)).resolves.toEqual({
        kind: 'material_gap',
        reason_code: reason,
        candidate_claim_keys: [],
      });
      expect(agent.generateGroundedDraft).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'assignment metadata project drift',
      { job_project_id: 'project-other' },
      'ASSIGNMENT_PROJECT_MISMATCH',
    ],
    [
      'primary run omitted from references',
      { retrieval_run_refs: '["run-other"]' },
      'EVIDENCE_RUN_DRIFT',
    ],
    [
      'primary run state drift',
      { primary_run_state: 'ERROR' },
      'RETRIEVAL_STATE_INVALID',
    ],
  ] satisfies Array<
    [string, Record<string, unknown>, AtomicGroundingReasonCode]
  >)(
    'preserves %s from the real SQL assignment store through generate',
    async (_label, overrides, reason) => {
      const standard = harness([]);
      const coordinator = new AtomicGroundingCoordinator(
        realSqlAssignmentStore(overrides),
        standard.renderContextService,
        standard.agent,
        new AtomicGroundingVerifier(),
        new AtomicGroundingMetricsRecorder(),
      );

      await expect(coordinator.generate(workflow)).resolves.toEqual({
        kind: 'material_gap',
        reason_code: reason,
        candidate_claim_keys: [],
      });
      expect(standard.agent.generateGroundedDraft).not.toHaveBeenCalled();
    },
  );

  it('allows exactly one candidate-key-scoped revision over merged evidence', async () => {
    const oldAssignment = assignment();
    oldAssignment.evidence[0].content = '系统容量为100MW。';
    oldAssignment.evidence[0].exact_span_text = '系统容量为100MW。';
    const initial = harness([], validProposal(), oldAssignment);
    const required = await initial.coordinator.generate(workflow);
    if (required.kind !== 'revision_required') {
      throw new Error('expected revision_required outcome');
    }
    expect(required.unsupported_claims).toHaveLength(1);

    const newEvidence = {
      ...oldAssignment.evidence[0],
      evidence_id: 'evidence-2',
      content: '系统容量为200MW。',
      exact_span_text: '系统容量为200MW。',
      evidence_snapshot_digest: 'c'.repeat(64),
    };
    const revisedAssignment = assignment({
      targeted_revision_attempts: 1,
      evidence: [oldAssignment.evidence[0], newEvidence],
    });
    const revisedProposal = validProposal();
    revisedProposal.claims[0] = {
      ...revisedProposal.claims[0],
      revision_of_candidate_claim_key:
        required.unsupported_claims[0].candidate_claim_key,
      claim_text: '系统容量为200MW。',
      evidence_ids: ['evidence-2'],
      quantities: [
        {
          ...revisedProposal.claims[0].quantities[0],
          surface: '200MW',
          value: '200',
        },
      ],
    };
    const revised = harness([], revisedProposal, revisedAssignment);
    let durableCandidate: unknown;
    const persistSealedCandidate = jest.fn(async (candidate) => {
      await Promise.resolve();
      durableCandidate = candidate;
    });

    const outcome = await revised.coordinator.generate({
      ...workflow,
      revision_attempt: 1,
      revision: {
        base_proposal: required.canonical_proposal,
        allowed_candidate_claim_keys: required.unsupported_claims.map(
          (claim) => claim.candidate_claim_key,
        ),
        non_target_invariant_digests: required.non_target_invariant_digests,
      },
      persist_sealed_candidate: persistSealedCandidate,
    });

    expect(outcome.kind).toBe('sealed');
    if (outcome.kind !== 'sealed') throw new Error('expected sealed outcome');
    expect(outcome.candidate.claims[0].candidate_claim_key).toBe(
      required.unsupported_claims[0].candidate_claim_key,
    );
    expect(outcome.candidate.server_output.text).toContain('200MW');
    expect(persistSealedCandidate).toHaveBeenCalledTimes(1);
    expect(durableCandidate).toEqual(outcome.candidate);
  });

  it('fails closed as REVISION_EXHAUSTED when the one revision remains unsupported', async () => {
    const oldAssignment = assignment();
    oldAssignment.evidence[0].content = '系统容量为100MW。';
    oldAssignment.evidence[0].exact_span_text = '系统容量为100MW。';
    const initial = harness([], validProposal(), oldAssignment);
    const required = await initial.coordinator.generate(workflow);
    if (required.kind !== 'revision_required') {
      throw new Error('expected revision_required outcome');
    }
    const exhausted = harness(
      [],
      {
        ...required.canonical_proposal,
        claims: required.canonical_proposal.claims.map((claim) => ({
          ...claim,
          revision_of_candidate_claim_key:
            required.unsupported_claims[0].candidate_claim_key,
        })),
      },
      assignment({
        targeted_revision_attempts: 1,
        evidence: oldAssignment.evidence,
      }),
    );

    await expect(
      exhausted.coordinator.generate({
        ...workflow,
        revision_attempt: 1,
        revision: {
          base_proposal: required.canonical_proposal,
          allowed_candidate_claim_keys: required.unsupported_claims.map(
            (claim) => claim.candidate_claim_key,
          ),
          non_target_invariant_digests: required.non_target_invariant_digests,
        },
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'REVISION_EXHAUSTED',
      candidate_claim_keys: [
        required.unsupported_claims[0].candidate_claim_key,
      ],
    });
  });

  it('recovers a sealed checkpoint with zero model calls', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const recovery = harness([]);

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint: generated.candidate,
      }),
    ).resolves.toEqual(generated);
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('reports a stored envelope digest mismatch at the recovery boundary', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const checkpoint = {
      ...generated.candidate,
      digests: {
        ...generated.candidate.digests,
        envelope_digest: '0'.repeat(64),
      },
    };
    const recovery = harness([]);

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint,
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'ENVELOPE_DIGEST_MISMATCH',
      candidate_claim_keys: [],
    });
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('rejects a digested workflow attempt corruption before loading current dependencies', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const checkpoint = {
      ...generated.candidate,
      workflow: {
        ...generated.candidate.workflow,
        revision_attempt: 1 as const,
      },
    };
    const recovery = harness([]);

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint,
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'ENVELOPE_DIGEST_MISMATCH',
      candidate_claim_keys: [],
    });
    expect(recovery.store.loadAssignment).not.toHaveBeenCalled();
    expect(recovery.renderContextService.build).not.toHaveBeenCalled();
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('reports current assignment drift at the recovery boundary', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const recovery = harness(
      [],
      validProposal(),
      assignment({ snapshot_digest: 'd'.repeat(64) }),
    );

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint: generated.candidate,
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'RECOVERY_ASSIGNMENT_DRIFT',
      candidate_claim_keys: [],
    });
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('maps a real current SQL assignment dependency failure to recovery assignment drift', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const recovery = harness([]);
    const coordinator = new AtomicGroundingCoordinator(
      realSqlAssignmentStore({ primary_run_state: 'ERROR' }),
      recovery.renderContextService,
      recovery.agent,
      new AtomicGroundingVerifier(),
      new AtomicGroundingMetricsRecorder(),
    );

    await expect(
      coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint: generated.candidate,
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'RECOVERY_ASSIGNMENT_DRIFT',
      candidate_claim_keys: [],
    });
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it('reports current render-context drift at the recovery boundary', async () => {
    const initial = harness([]);
    const generated = await initial.coordinator.generate(workflow);
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const recovery = harness([]);
    recovery.renderContextService.build.mockResolvedValue({
      ...context(),
      entries: context().entries.map((entry) => ({
        ...entry,
        source_version: '2',
      })),
    });

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint: generated.candidate,
      }),
    ).resolves.toEqual({
      kind: 'material_gap',
      reason_code: 'RECOVERY_RENDER_CONTEXT_DRIFT',
      candidate_claim_keys: [],
    });
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['missing pinned directory', []],
    [
      'stale pinned directory',
      [
        {
          id: 'directory-other',
          project_id: 'project-1',
          version_number: 2,
          content: [],
        },
      ],
    ],
  ])(
    'maps a real approved-render-context %s failure to recovery context drift',
    async (_label, directoryRows) => {
      const initial = harness([]);
      const generated = await initial.coordinator.generate(workflow);
      if (generated.kind !== 'sealed') {
        throw new Error('expected sealed outcome');
      }
      const recovery = harness([]);
      const coordinator = new AtomicGroundingCoordinator(
        recovery.store,
        realRenderContextService(directoryRows),
        recovery.agent,
        new AtomicGroundingVerifier(),
        new AtomicGroundingMetricsRecorder(),
      );

      await expect(
        coordinator.recover({
          workflow_job_id: 'job-1',
          project_id: 'project-1',
          checkpoint: generated.candidate,
        }),
      ).resolves.toEqual({
        kind: 'material_gap',
        reason_code: 'RECOVERY_RENDER_CONTEXT_DRIFT',
        candidate_claim_keys: [],
      });
      expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
    },
  );

  it('recovers a revision-1 sealed checkpoint with its exact workflow attempts and zero model calls', async () => {
    const oldAssignment = assignment();
    oldAssignment.evidence[0].content = '系统容量为100MW。';
    oldAssignment.evidence[0].exact_span_text = '系统容量为100MW。';
    const initial = harness([], validProposal(), oldAssignment);
    const required = await initial.coordinator.generate(workflow);
    if (required.kind !== 'revision_required') {
      throw new Error('expected revision_required outcome');
    }
    const newEvidence = {
      ...oldAssignment.evidence[0],
      evidence_id: 'evidence-2',
      content: '系统容量为200MW。',
      exact_span_text: '系统容量为200MW。',
      evidence_snapshot_digest: 'c'.repeat(64),
    };
    const revisedAssignment = assignment({
      targeted_revision_attempts: 1,
      evidence: [oldAssignment.evidence[0], newEvidence],
    });
    const revisedProposal = validProposal();
    revisedProposal.claims[0] = {
      ...revisedProposal.claims[0],
      revision_of_candidate_claim_key:
        required.unsupported_claims[0].candidate_claim_key,
      claim_text: '系统容量为200MW。',
      evidence_ids: ['evidence-2'],
      quantities: [
        {
          ...revisedProposal.claims[0].quantities[0],
          surface: '200MW',
          value: '200',
        },
      ],
    };
    const revised = harness([], revisedProposal, revisedAssignment);
    const generated = await revised.coordinator.generate({
      ...workflow,
      revision_attempt: 1,
      revision: {
        base_proposal: required.canonical_proposal,
        allowed_candidate_claim_keys: required.unsupported_claims.map(
          (claim) => claim.candidate_claim_key,
        ),
        non_target_invariant_digests: required.non_target_invariant_digests,
      },
    });
    if (generated.kind !== 'sealed') throw new Error('expected sealed outcome');
    const recovery = harness([], validProposal(), revisedAssignment);

    await expect(
      recovery.coordinator.recover({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        checkpoint: generated.candidate,
      }),
    ).resolves.toEqual(generated);
    expect(recovery.store.loadAssignment).toHaveBeenCalledTimes(1);
    expect(recovery.agent.generateGroundedDraft).not.toHaveBeenCalled();
  });
});

function harness(
  points: AtomicMetricPoint[],
  proposal = validProposal(),
  assigned: GroundingAssignmentSnapshot | null = assignment(),
) {
  const store = {
    loadAssignment: jest.fn(() => Promise.resolve(assigned)),
    saveLedger: jest.fn(),
  } satisfies jest.Mocked<GroundingEvidenceStore>;
  const renderContextService = {
    build: jest.fn(() => Promise.resolve(context())),
  } as unknown as jest.Mocked<ApprovedRenderContextService>;
  const agent = {
    generateGroundedDraft: jest.fn(() =>
      Promise.resolve({
        proposal,
        audit: {
          repair_attempts: 1 as const,
          proposal_bytes: 7_777,
          model_run_id: 'audit-only-run',
        },
      }),
    ),
  } as unknown as jest.Mocked<AgentService>;
  const metrics = new AtomicGroundingMetricsRecorder({
    record: (point) => points.push(point),
  });
  return {
    coordinator: new AtomicGroundingCoordinator(
      store,
      renderContextService,
      agent,
      new AtomicGroundingVerifier(),
      metrics,
    ),
    store,
    renderContextService,
    agent,
  };
}

function context() {
  return {
    context_version: 'approved-render-context.v1' as const,
    entries: [
      {
        structure_id: 'heading',
        source_kind: 'outline' as const,
        source_id: 'outline-1',
        source_version: '1',
        label_nfc: '能源系统',
        presentation: 'heading_1' as const,
      },
    ],
  };
}

function validProposal(): GroundedDraftProposal {
  const text = '系统容量为300MW。';
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
        subject: { surface: '系统', start_utf16: 0, end_utf16: 2 },
        predicate: { surface: '容量为', start_utf16: 2, end_utf16: 5 },
        polarity: 'affirmed',
        quantifier: 'plain',
        quantities: [
          {
            quantity_id: 'quantity-1',
            surface: '300MW',
            start_utf16: 5,
            end_utf16: 10,
            dimension: 'power',
            value: '300',
            unit: 'MW',
            comparator: 'eq',
            range_end: null,
          },
        ],
        evidence_ids: ['evidence-1'],
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
        fragment_id: 'claim-fragment',
        kind: 'claim_ref',
        claim_id: 'claim-1',
        presentation: 'sentence',
      },
    ],
    ordering: ['heading-fragment', 'claim-fragment'],
    material_gap: null,
  };
}

function assignment(
  overrides: Partial<GroundingAssignmentSnapshot> = {},
): GroundingAssignmentSnapshot {
  return {
    workflow_job_id: 'job-1',
    project_id: 'project-1',
    retrieval_run_id: 'run-1',
    retrieval_run_refs: ['run-1'],
    retrieval_state: 'READY',
    contract_version: 'atomic:v1',
    strict_mode: true,
    targeted_revision_attempts: 0,
    snapshot_digest: 'a'.repeat(64),
    evidence: [
      {
        evidence_id: 'evidence-1',
        chunk_id: 'chunk-1',
        project_id: 'project-1',
        file_id: 'file-1',
        document_id: 'document-1',
        retrieval_run_id: 'run-1',
        ingestion_key: 'ingestion-1',
        content: '系统容量为300MW。',
        exact_span_text: '系统容量为300MW。',
        chunk_char_start: 0,
        exact_span_document_start: 0,
        exact_span_document_end: 11,
        candidate_rank: 1,
        scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
        ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
        page_start: 1,
        page_end: 1,
        heading_path: ['第一章'],
        index_snapshot: { version: '1' },
        evidence_snapshot_digest: 'b'.repeat(64),
      },
    ],
    ...overrides,
  };
}

function realSqlAssignmentStore(
  overrides: Record<string, unknown>,
): SqlGroundingEvidenceStore {
  const metadata = {
    workflow_job_id: 'job-1',
    job_project_id: 'project-1',
    assignment_project_id: 'project-1',
    retrieval_run_id: 'run-1',
    retrieval_run_refs: '["run-1"]',
    retrieval_state: 'READY',
    contract_version: 'atomic:v1',
    primary_run_project_id: 'project-1',
    primary_run_state: 'READY',
    strict_mode: 1,
    targeted_revision_attempts: 0,
    evidence_ids: '["evidence-1"]',
    snapshot_digest: null,
    ...overrides,
  };
  const dataSource = {
    query: jest.fn(async (sql: string) => {
      await Promise.resolve();
      if (sql.includes('FROM grounding_assignments ga')) return [metadata];
      if (sql.includes('FROM retrieval_runs')) {
        return [
          {
            id: 'run-1',
            project_id: 'project-1',
            state: metadata.primary_run_state,
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  return new SqlGroundingEvidenceStore(dataSource as never);
}

function realRenderContextService(
  directoryRows: Array<Record<string, unknown>>,
): ApprovedRenderContextService {
  const dataSource = {
    query: jest.fn(async (sql: string) => {
      await Promise.resolve();
      if (sql.includes('FROM workflow_jobs')) {
        return [
          {
            id: 'job-1',
            project_id: 'project-1',
            request_hash: 'request-hash-1',
            input: {
              chapter_node_id: 'chapter-1',
              section_node_id: 'section-1',
              directory_version_id: 'directory-1',
              directory_version: 1,
            },
          },
        ];
      }
      if (sql.includes('FROM directory_versions')) return directoryRows;
      if (
        sql.includes('FROM outline_versions') ||
        sql.includes('FROM style_templates')
      ) {
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  return new ApprovedRenderContextService(dataSource as never);
}
