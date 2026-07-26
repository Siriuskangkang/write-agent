import { NotFoundException } from '@nestjs/common';
import type { ContentService } from '../../content/content.service.js';
import type { SealedGroundedCandidateV1 } from '../../citation/atomic-grounding/contracts.js';
import { MaterialGapError } from '../../citation/material-gap.error.js';
import type {
  ClaimedWorkflowJob,
  WorkflowExecutionEvent,
  WorkflowExecutionOutcome,
} from '../../workflow/workflow.engine.js';
import { WorkflowType } from '../../workflow/workflow.types.js';
import type { AuthoringCommitService } from '../commit/authoring-commit.service.js';
import type { AuthoringProposal } from '../proposal/authoring-proposal.entity.js';
import type { AuthoringProposalService } from '../proposal/authoring-proposal.service.js';
import type { StorageReadinessService } from '../../storage/storage-readiness.service.js';
import {
  AuthoringGraphLimitError,
  AuthoringModelCallBudget,
  DETERMINISTIC_AUTHORING_NODES,
  DeterministicAuthoringGraph,
} from './deterministic-authoring.graph.js';

interface Mocks {
  content: {
    assertProjectOwner: jest.Mock;
    generateDirectory: jest.Mock;
    generateOutline: jest.Mock;
    generateAtomicGroundingCandidate: jest.Mock;
    recoverAtomicGroundingCandidate: jest.Mock;
    prepareGroundingRevision: jest.Mock;
    generateAtomicGroundingRevisionCandidate: jest.Mock;
  };
  proposals: {
    findActive: jest.Mock;
    store: jest.Mock;
  };
  commits: {
    commitApproved: jest.Mock;
  };
  storage: {
    assertReady: jest.Mock;
  };
}

describe('DeterministicAuthoringGraph', () => {
  test('executes the fixed node order in shadow mode without business writes', async () => {
    const mocks = createMocks();
    const signal = new AbortController().signal;
    let receivedSignal: AbortSignal | undefined;
    mocks.content.generateDirectory.mockImplementation(
      (
        _userId: string,
        _projectId: string,
        _input: unknown,
        modelSignal: AbortSignal,
      ) => {
        receivedSignal = modelSignal;
        return tokens(
          '{"nodes":[{"key":"chapter-1","title":"第一章","children":[]}]}',
        );
      },
    );
    const graph = createGraph(mocks);

    const execution = await collect(
      graph.execute(
        job({
          workflowType: WorkflowType.DIRECTORY,
          workflowDefinition: 'deterministic-authoring-shadow.v1',
        }),
        { signal },
      ),
    );

    expect(
      execution.events
        .filter((item) => item.type === 'authoring.node_completed')
        .map((item) => item.data?.node),
    ).toEqual(DETERMINISTIC_AUTHORING_NODES);
    expect(execution.outcome).toEqual({
      kind: 'SUSPENDED',
      reason: 'SHADOW_COMPLETED',
    });
    expect(receivedSignal).toBe(signal);
    expect(mocks.storage.assertReady).not.toHaveBeenCalled();
    expect(mocks.proposals.store).not.toHaveBeenCalled();
    expect(mocks.commits.commitApproved).not.toHaveBeenCalled();
  });

  test('stores exact server bytes and suspends enforce mode for approval', async () => {
    const mocks = createMocks();
    const output = '第一节\n这是精确的 UTF-8 正文。';
    const candidate = sealedCandidate(output);
    mocks.content.generateAtomicGroundingCandidate.mockResolvedValue({
      kind: 'sealed',
      candidate,
    });
    let storedPayload: Buffer | undefined;
    mocks.proposals.store.mockImplementation(
      (
        _job: ClaimedWorkflowJob,
        input: {
          payload: Buffer;
          artifactKind: string;
          schemaVersion: string;
        },
      ) => {
        storedPayload = input.payload;
        return Promise.resolve(
          proposal(input.payload, input.artifactKind, input.schemaVersion),
        );
      },
    );
    const graph = createGraph(mocks);

    const execution = await collect(
      graph.execute(job(), { signal: new AbortController().signal }),
    );

    expect(execution.outcome).toEqual({
      kind: 'SUSPENDED',
      reason: 'WAITING_APPROVAL',
    });
    expect(mocks.storage.assertReady).toHaveBeenCalledTimes(1);
    expect(storedPayload?.equals(Buffer.from(output, 'utf8'))).toBe(true);
    expect(storedPayload?.toString('utf8')).toBe(output);
    expect(
      execution.events.find(
        (event) => event.type === 'authoring.proposal_sealed',
      )?.checkpoint.sealed_candidate,
    ).toBe(candidate);
    expect(mocks.commits.commitApproved).not.toHaveBeenCalled();
  });

  test('recovers an approved proposal and commits without rerunning a model', async () => {
    const mocks = createMocks();
    const candidate = sealedCandidate('正文');
    mocks.proposals.findActive.mockResolvedValue(
      proposal(Buffer.from('正文'), 'body', 'authoring-body.v1', 'APPROVED'),
    );
    mocks.content.recoverAtomicGroundingCandidate.mockResolvedValue({
      kind: 'sealed',
      candidate,
    });
    let committedJob: ClaimedWorkflowJob | undefined;
    mocks.commits.commitApproved.mockImplementation(
      (value: ClaimedWorkflowJob) => {
        committedJob = value;
        return Promise.resolve({
          resourceId: 'resource-1',
          versionId: 'version-1',
        });
      },
    );
    const graph = createGraph(mocks);

    const execution = await collect(
      graph.execute(
        job({
          checkpoint: {
            graph_version: 'deterministic-authoring-graph.v1',
            phase: 'waiting_approval',
            completed_nodes: [...DETERMINISTIC_AUTHORING_NODES],
            model_calls: 1,
            revision_attempts: 0,
            artifact_kind: 'body',
            schema_version: 'authoring-body.v1',
            proposal_id: 'proposal-1',
            proposal_digest: 'a'.repeat(64),
            sealed_candidate: candidate,
          },
        }),
        { signal: new AbortController().signal },
      ),
    );

    expect(execution.outcome).toEqual({ kind: 'COMPLETED' });
    expect(execution.events.map((item) => item.type)).toEqual([
      'authoring.committed',
      'done',
    ]);
    expect(
      mocks.content.generateAtomicGroundingCandidate,
    ).not.toHaveBeenCalled();
    expect(mocks.proposals.store).not.toHaveBeenCalled();
    expect(mocks.content.recoverAtomicGroundingCandidate).toHaveBeenCalledWith(
      'job-1',
      'project-1',
      candidate,
    );
    expect(committedJob?.checkpoint?.sealed_candidate).toBe(candidate);
  });

  test('propagates strict material gaps as MaterialGapError', async () => {
    const mocks = createMocks();
    mocks.content.generateAtomicGroundingCandidate.mockResolvedValue({
      kind: 'material_gap',
      reason_code: 'NO_EVIDENCE',
      candidate_claim_keys: ['claim-1'],
    });
    const graph = createGraph(mocks);

    await expect(
      collect(graph.execute(job(), { signal: new AbortController().signal })),
    ).rejects.toMatchObject({
      name: 'MaterialGapError',
      unsupportedClaimIds: ['claim-1'],
    } satisfies Partial<MaterialGapError>);
    expect(mocks.proposals.store).not.toHaveBeenCalled();
  });

  test('fails closed before enforce generation when storage is not ready', async () => {
    const mocks = createMocks();
    mocks.storage.assertReady.mockRejectedValue(
      new Error('STORAGE_AUTHORITY_UNPROVEN'),
    );
    const graph = createGraph(mocks);

    await expect(
      collect(graph.execute(job(), { signal: new AbortController().signal })),
    ).rejects.toThrow('STORAGE_AUTHORITY_UNPROVEN');
    expect(mocks.content.assertProjectOwner).not.toHaveBeenCalled();
    expect(mocks.proposals.findActive).not.toHaveBeenCalled();
  });

  test('rejects a targeted revision beyond the graph cap', async () => {
    const mocks = createMocks();
    mocks.content.generateAtomicGroundingCandidate.mockResolvedValue({
      kind: 'revision_required',
      canonical_proposal: {
        schema_version: 'grounded-draft.v1',
        status: 'draft',
        claims: [],
        render_fragments: [],
        ordering: [],
        material_gap: null,
      },
      unsupported_claims: [
        {
          candidate_claim_key: 'claim-1',
          source_claim_text_nfc: '缺少证据',
          reason_code: 'NO_EVIDENCE',
        },
      ],
      non_target_invariant_digests: {},
      base_retrieval_run_id: 'retrieval-1',
    });
    const graph = createGraph(mocks);
    const cappedJob = job({
      checkpoint: {
        graph_version: 'deterministic-authoring-graph.v1',
        phase: 'executing',
        completed_nodes: [],
        model_calls: 0,
        revision_attempts: 2,
      },
    });

    await expect(
      collect(
        graph.execute(cappedJob, {
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'AUTHORING_REVISION_LIMIT',
    } satisfies Partial<AuthoringGraphLimitError>);
    expect(
      mocks.content.generateAtomicGroundingRevisionCandidate,
    ).not.toHaveBeenCalled();
  });

  test('rejects the tenth orchestration model call and honors abort', async () => {
    const budget = new AuthoringModelCallBudget();
    const signal = new AbortController().signal;
    for (let index = 0; index < 9; index += 1) {
      await expect(
        budget.run(signal, (received) => Promise.resolve(received)),
      ).resolves.toBe(signal);
    }
    await expect(
      budget.run(signal, () => Promise.resolve('tenth')),
    ).rejects.toMatchObject({
      code: 'AUTHORING_MODEL_CALL_LIMIT',
    } satisfies Partial<AuthoringGraphLimitError>);

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      new AuthoringModelCallBudget().run(controller.signal, () =>
        Promise.resolve('no'),
      ),
    ).rejects.toThrow('cancelled');
  });
});

function createMocks(): Mocks {
  return {
    content: {
      assertProjectOwner: jest.fn().mockResolvedValue({ id: 'project-1' }),
      generateDirectory: jest.fn(),
      generateOutline: jest.fn(),
      generateAtomicGroundingCandidate: jest.fn(),
      recoverAtomicGroundingCandidate: jest.fn(),
      prepareGroundingRevision: jest.fn().mockResolvedValue(undefined),
      generateAtomicGroundingRevisionCandidate: jest.fn(),
    },
    proposals: {
      findActive: jest
        .fn()
        .mockRejectedValue(new NotFoundException('not found')),
      store: jest.fn(),
    },
    commits: {
      commitApproved: jest.fn(),
    },
    storage: {
      assertReady: jest.fn().mockResolvedValue({
        storage_epoch: 'epoch-1',
        storage_contract_version: 'storage-broker.v1',
      }),
    },
  };
}

function createGraph(mocks: Mocks): DeterministicAuthoringGraph {
  return new DeterministicAuthoringGraph(
    mocks.content as unknown as ContentService,
    mocks.proposals as unknown as AuthoringProposalService,
    mocks.commits as unknown as AuthoringCommitService,
    mocks.storage as unknown as StorageReadinessService,
  );
}

function job(values: Partial<ClaimedWorkflowJob> = {}): ClaimedWorkflowJob {
  return {
    id: 'job-1',
    userId: 'user-1',
    projectId: 'project-1',
    workflowType: WorkflowType.CONTENT,
    input: {
      chapter_node_id: 'chapter-1',
      section_node_id: 'section-1',
      strict_citation: true,
    },
    checkpoint: null,
    leaseToken: 'lease-1',
    fencingToken: 1,
    generationAttempt: 0,
    workflowDefinition: 'deterministic-authoring.v1',
    ...values,
  };
}

function proposal(
  payload: Buffer,
  artifactKind: string,
  schemaVersion: string,
  status: 'ACTIVE' | 'APPROVED' = 'ACTIVE',
): AuthoringProposal {
  return {
    id: 'proposal-1',
    job_id: 'job-1',
    project_id: 'project-1',
    user_id: 'user-1',
    sequence: '1',
    artifact_kind: artifactKind as AuthoringProposal['artifact_kind'],
    schema_version: schemaVersion,
    status,
    payload,
    payload_sha256: 'a'.repeat(64),
    payload_utf8_bytes: String(payload.byteLength),
    expires_at: new Date(Date.now() + 60_000),
    approved_at: status === 'APPROVED' ? new Date() : null,
    committed_at: null,
    resource_id: null,
    resource_version: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function sealedCandidate(text: string): SealedGroundedCandidateV1 {
  return {
    contract_version: 'atomic:v1',
    workflow: {
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      workflow_type: 'content',
      generation_attempt: 1,
      revision_attempt: 0,
    },
    server_output: {
      text,
      utf8_byte_length: Buffer.byteLength(text, 'utf8'),
      utf16_length: text.length,
    },
    claims: [],
  } as unknown as SealedGroundedCandidateV1;
}

async function* tokens(value: string): AsyncGenerator<string> {
  await Promise.resolve();
  yield value;
}

async function collect(
  generator: AsyncGenerator<
    WorkflowExecutionEvent,
    WorkflowExecutionOutcome,
    void
  >,
): Promise<{
  events: WorkflowExecutionEvent[];
  outcome: WorkflowExecutionOutcome;
}> {
  const events: WorkflowExecutionEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}
