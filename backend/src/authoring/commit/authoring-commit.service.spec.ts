import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { digestCanonicalV1 } from '../../citation/atomic-grounding/canonical-json.js';
import type { SealedGroundedCandidateV1 } from '../../citation/atomic-grounding/contracts.js';
import type { ClaimedWorkflowJob } from '../../workflow/workflow.engine.js';
import { WorkflowLeaseLostError } from '../../workflow/workflow.engine.js';
import { WorkflowStatus, WorkflowType } from '../../workflow/workflow.types.js';
import {
  AuthoringCommitError,
  AuthoringCommitService,
  type ApprovedAuthoringProposalRow,
} from './authoring-commit.service.js';

type QueryHandler = (sql: string, parameters: readonly unknown[]) => unknown;

interface Harness {
  service: AuthoringCommitService;
  queries: Array<{ sql: string; parameters: readonly unknown[] }>;
}

const FOUR_MIB = 4 * 1024 * 1024;

function harness(handler: QueryHandler): Harness {
  const queries: Array<{
    sql: string;
    parameters: readonly unknown[];
  }> = [];
  const manager = {
    query: (
      sql: string,
      parameters: readonly unknown[] = [],
    ): Promise<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: normalized, parameters });
      return Promise.resolve(handler(normalized, parameters));
    },
  } as unknown as EntityManager;
  const dataSource = {
    transaction: <T>(
      callback: (entityManager: EntityManager) => Promise<T>,
    ): Promise<T> => callback(manager),
  } as DataSource;
  return {
    service: new AuthoringCommitService(dataSource),
    queries,
  };
}

function job(
  workflowType: WorkflowType = WorkflowType.CONTENT,
  input: Record<string, unknown> = {
    chapter_node_id: 'chapter-1',
    chapter_title: '第一章',
  },
): ClaimedWorkflowJob {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    workflowType,
    input,
    checkpoint: null,
    leaseToken: '44444444-4444-4444-8444-444444444444',
    fencingToken: 7,
    generationAttempt: 1,
  };
}

function workflowRow(
  claimed: ClaimedWorkflowJob,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: claimed.id,
    user_id: claimed.userId,
    project_id: claimed.projectId,
    workflow_type: claimed.workflowType,
    status: WorkflowStatus.RUNNING,
    cancel_requested_at: null,
    lease_token: claimed.leaseToken,
    fencing_token: claimed.fencingToken,
    lease_active: 1,
    ...overrides,
  };
}

function proposalRow(
  claimed: ClaimedWorkflowJob,
  payload: Buffer,
  overrides: Partial<ApprovedAuthoringProposalRow> = {},
): ApprovedAuthoringProposalRow {
  const artifact =
    claimed.workflowType === WorkflowType.DIRECTORY
      ? 'directory'
      : claimed.workflowType === WorkflowType.OUTLINE
        ? 'outline'
        : 'body';
  return {
    id: '55555555-5555-4555-8555-555555555555',
    job_id: claimed.id,
    project_id: claimed.projectId,
    user_id: claimed.userId,
    artifact_kind: artifact,
    status: 'APPROVED',
    payload,
    payload_utf8_bytes: payload.length,
    payload_sha256: createHash('sha256').update(payload).digest('hex'),
    expires_active: 1,
    resource_id: null,
    resource_version: null,
    ...overrides,
  };
}

function initialHandler(
  claimed: ClaimedWorkflowJob,
  proposal: ApprovedAuthoringProposalRow,
  afterInitial: QueryHandler,
  workflowOverrides: Partial<Record<string, unknown>> = {},
): QueryHandler {
  return (sql, parameters) => {
    if (sql.includes('FROM workflow_jobs')) {
      return [workflowRow(claimed, workflowOverrides)];
    }
    if (sql.includes('FROM authoring_proposals')) return [proposal];
    if (sql.includes('FROM workflow_domain_commits')) return [];
    return afterInitial(sql, parameters);
  };
}

describe('AuthoringCommitService', () => {
  it('rejects payload digest mismatch before any business write', async () => {
    const claimed = job();
    const payload = Buffer.from('exact body', 'utf8');
    const proposal = proposalRow(claimed, payload, {
      payload_sha256: '0'.repeat(64),
    });
    const testHarness = harness(
      initialHandler(claimed, proposal, () => {
        throw new Error('unexpected business query');
      }),
    );

    await expect(
      testHarness.service.commitApproved(claimed),
    ).rejects.toMatchObject({
      code: 'AUTHORING_PAYLOAD_DIGEST_MISMATCH',
    });
    expect(
      testHarness.queries.some((query) => query.sql.startsWith('INSERT INTO')),
    ).toBe(false);
  });

  it('rejects an expired approved proposal', async () => {
    const claimed = job();
    const payload = Buffer.from('body', 'utf8');
    const proposal = proposalRow(claimed, payload, { expires_active: 0 });
    const testHarness = harness(
      initialHandler(claimed, proposal, () => {
        throw new Error('unexpected business query');
      }),
    );

    await expect(testHarness.service.commitApproved(claimed)).rejects.toEqual(
      new AuthoringCommitError('AUTHORING_PROPOSAL_EXPIRED'),
    );
  });

  it('rejects a lost workflow fence', async () => {
    const claimed = job();
    const payload = Buffer.from('body', 'utf8');
    const proposal = proposalRow(claimed, payload);
    const testHarness = harness(
      initialHandler(
        claimed,
        proposal,
        () => {
          throw new Error('unexpected business query');
        },
        { fencing_token: claimed.fencingToken + 1 },
      ),
    );

    await expect(
      testHarness.service.commitApproved(claimed),
    ).rejects.toBeInstanceOf(WorkflowLeaseLostError);
  });

  it('returns an existing receipt without requiring an active lease', async () => {
    const payload = Buffer.from('body', 'utf8');
    const base = job();
    const claimed: ClaimedWorkflowJob = {
      ...base,
      workflowDefinition: 'deterministic-authoring.v1',
      checkpoint: {
        sealed_candidate: atomicCandidate(base, 'body', 'f'.repeat(64)),
      },
    };
    const receipt = {
      resourceId: '66666666-6666-4666-8666-666666666666',
      versionId: '77777777-7777-4777-8777-777777777777',
    };
    const proposal = proposalRow(claimed, payload, {
      status: 'COMMITTED',
      resource_id: receipt.resourceId,
      resource_version: 1,
    });
    const testHarness = harness((sql) => {
      if (sql.includes('FROM workflow_jobs')) {
        return [
          workflowRow(claimed, {
            status: WorkflowStatus.SUCCEEDED,
            lease_token: null,
            lease_active: 0,
          }),
        ];
      }
      if (sql.includes('FROM authoring_proposals')) return [proposal];
      if (sql.includes('FROM workflow_domain_commits')) {
        return [
          {
            workflow_type: claimed.workflowType,
            resource_id: receipt.resourceId,
            version_id: receipt.versionId,
            commit_payload: JSON.stringify(receipt),
          },
        ];
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(testHarness.service.commitApproved(claimed)).resolves.toEqual(
      receipt,
    );
    expect(
      testHarness.queries.some(
        (query) =>
          query.sql.startsWith('INSERT INTO') ||
          query.sql.startsWith('UPDATE '),
      ),
    ).toBe(false);
  });

  it('stores exact body bytes and inherits an approved parent scope', async () => {
    const parentId = '88888888-8888-4888-8888-888888888888';
    const claimed = job(WorkflowType.REWRITE, { result_id: parentId });
    const exact = '  第一行\r\n第二行  ';
    const payload = Buffer.from(exact, 'utf8');
    const proposal = proposalRow(claimed, payload);
    let writingParameters: readonly unknown[] = [];
    let versionParameters: readonly unknown[] = [];
    const testHarness = harness(
      initialHandler(claimed, proposal, (sql, parameters) => {
        if (sql.includes('FROM writing_results wr')) {
          return [
            {
              session_id: '99999999-9999-4999-8999-999999999999',
              chapter_node_id: 'chapter-parent',
              section_node_id: 'section-parent',
              chapter_index: 3,
              chapter_title: '父章节',
              section_title: '父小节',
              style: 'formal',
            },
          ];
        }
        if (sql.startsWith('INSERT INTO writing_results')) {
          writingParameters = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO content_versions')) {
          versionParameters = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE authoring_proposals')) {
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO workflow_domain_commits')) {
          return { affectedRows: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    );

    const receipt = await testHarness.service.commitApproved(claimed);

    expect(writingParameters[10]).toBe(exact);
    expect(writingParameters[3]).toBe('chapter-parent');
    expect(writingParameters[4]).toBe('section-parent');
    expect(writingParameters[13]).toBe(parentId);
    expect(versionParameters).toEqual([
      receipt.versionId,
      receipt.resourceId,
      exact,
    ]);
    expect(
      testHarness.queries.find((query) =>
        query.sql.includes('FROM writing_results wr'),
      )?.parameters,
    ).toEqual([parentId, claimed.projectId, 'succeeded']);
  });

  it('commits exact body and its sealed atomic ledger in one transaction', async () => {
    const text = '装机容量为 300 MW';
    const base = job();
    const snapshotDigest = 'f'.repeat(64);
    const candidate = atomicCandidate(base, text, snapshotDigest);
    const claimed: ClaimedWorkflowJob = {
      ...base,
      workflowDefinition: 'deterministic-authoring.v1',
      checkpoint: { sealed_candidate: candidate },
    };
    const proposal = proposalRow(claimed, Buffer.from(text, 'utf8'));
    let writingParameters: readonly unknown[] = [];
    let claimParameters: readonly unknown[] = [];
    let citationParameters: readonly unknown[] = [];
    let domainCommitParameters: readonly unknown[] = [];
    const testHarness = harness(
      initialHandler(claimed, proposal, (sql, parameters) => {
        if (sql.includes('FROM grounding_assignments')) {
          return [
            {
              contract_version: 'atomic:v1',
              snapshot_digest: snapshotDigest,
              targeted_revision_attempts: 0,
            },
          ];
        }
        if (sql.startsWith('INSERT INTO writing_results')) {
          writingParameters = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO content_versions')) {
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO grounding_claims')) {
          claimParameters = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO citation_maps')) {
          citationParameters = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE authoring_proposals')) {
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO workflow_domain_commits')) {
          domainCommitParameters = parameters;
          return { affectedRows: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    );

    const receipt = await testHarness.service.commitApproved(claimed);

    expect(writingParameters[10]).toBe(text);
    expect(claimParameters.slice(0, 11)).toEqual([
      candidate.claims[0].persisted_claim_id,
      claimed.id,
      claimed.projectId,
      receipt.resourceId,
      text,
      text,
      0,
      text.length,
      'SUPPORTED',
      1,
      'atomic_extract_exact',
    ]);
    expect(JSON.parse(String(claimParameters[11]))).toEqual({
      canonicalizer_version: candidate.canonicalizer_version,
      quantity_lexer_version: candidate.quantity_lexer_version,
      verifier_version: candidate.verifier_version,
      canonical_claim: candidate.claims[0].canonical_claim,
    });
    expect(citationParameters[1]).toBe(claimed.projectId);
    expect(citationParameters[2]).toBe(receipt.resourceId);
    expect(citationParameters[4]).toBe(
      candidate.evidence_snapshots[0].chunk_id,
    );
    expect(citationParameters[10]).toBe(candidate.claims[0].persisted_claim_id);
    expect(
      testHarness.queries.find((query) =>
        query.sql.includes('FROM grounding_assignments'),
      )?.parameters,
    ).toEqual([claimed.id, claimed.projectId]);
    expect(JSON.parse(String(domainCommitParameters[5]))).toMatchObject({
      resourceId: receipt.resourceId,
      versionId: receipt.versionId,
      grounding: {
        contract_version: 'atomic:v1',
        ledger_digest: candidate.digests.ledger_digest,
        envelope_digest: candidate.digests.envelope_digest,
      },
    });
  });

  it('fails closed before business writes when deterministic body lost its sealed candidate', async () => {
    const claimed: ClaimedWorkflowJob = {
      ...job(),
      workflowDefinition: 'deterministic-authoring.v1',
    };
    const payload = Buffer.from('body', 'utf8');
    const proposal = proposalRow(claimed, payload);
    const testHarness = harness(
      initialHandler(claimed, proposal, () => {
        throw new Error('unexpected business query');
      }),
    );

    await expect(testHarness.service.commitApproved(claimed)).rejects.toEqual(
      new AuthoringCommitError('AUTHORING_GROUNDING_INVALID'),
    );
    expect(
      testHarness.queries.some((query) => query.sql.startsWith('INSERT INTO')),
    ).toBe(false);
  });

  it('commits exactly 4 MiB of body text without changing the decoded value', async () => {
    const claimed = job();
    const payload = Buffer.alloc(FOUR_MIB, 0x61);
    const proposal = proposalRow(claimed, payload);
    let committedText: unknown;
    const testHarness = harness(
      initialHandler(claimed, proposal, (sql, parameters) => {
        if (sql.startsWith('INSERT INTO writing_results')) {
          committedText = parameters[10];
          return { affectedRows: 1 };
        }
        if (
          sql.startsWith('INSERT INTO content_versions') ||
          sql.startsWith('INSERT INTO workflow_domain_commits') ||
          sql.startsWith('UPDATE authoring_proposals')
        ) {
          return { affectedRows: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    );

    const receipt = await testHarness.service.commitApproved(claimed);
    expect(receipt.resourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof committedText).toBe('string');
    expect(Buffer.byteLength(committedText as string, 'utf8')).toBe(FOUR_MIB);
    expect(Buffer.from(committedText as string, 'utf8')).toEqual(payload);
  });

  it('rejects body text larger than 4 MiB before any business write', async () => {
    const claimed = job();
    const payload = Buffer.alloc(FOUR_MIB + 1, 0x61);
    const proposal = proposalRow(claimed, payload);
    const testHarness = harness(
      initialHandler(claimed, proposal, () => {
        throw new Error('unexpected business query');
      }),
    );

    await expect(
      testHarness.service.commitApproved(claimed),
    ).rejects.toMatchObject({
      code: 'AUTHORING_PAYLOAD_INVALID',
    });
    expect(
      testHarness.queries.some((query) => query.sql.startsWith('INSERT INTO')),
    ).toBe(false);
  });

  it('serializes directory version allocation and updates the current pointer', async () => {
    const claimed = job(WorkflowType.DIRECTORY);
    const nodes = [
      {
        node_id: 'chapter-1',
        parent_node_id: null,
        title: '第一章',
      },
    ];
    const payload = Buffer.from(JSON.stringify(nodes), 'utf8');
    const proposal = proposalRow(claimed, payload);
    let directoryInsert: readonly unknown[] = [];
    let pointerUpdate: readonly unknown[] = [];
    const testHarness = harness(
      initialHandler(claimed, proposal, (sql, parameters) => {
        if (sql.includes('FROM project_states')) {
          return [{ id: 'state-1', current_directory_version_id: null }];
        }
        if (sql.startsWith('UPDATE directory_versions')) {
          return { affectedRows: 1 };
        }
        if (sql.includes('MAX(version_number)')) {
          return [{ max_version: 4 }];
        }
        if (sql.startsWith('INSERT INTO directory_versions')) {
          directoryInsert = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE project_states')) {
          pointerUpdate = parameters;
          return { affectedRows: 1 };
        }
        if (sql.startsWith('UPDATE authoring_proposals')) {
          return { affectedRows: 1 };
        }
        if (sql.startsWith('INSERT INTO workflow_domain_commits')) {
          return { affectedRows: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    );

    const receipt = await testHarness.service.commitApproved(claimed);

    expect(directoryInsert[2]).toBe(5);
    expect(JSON.parse(String(directoryInsert[3]))).toEqual(nodes);
    expect(pointerUpdate).toEqual([receipt.versionId, claimed.projectId]);
    expect(receipt.resourceId).toBe(receipt.versionId);
    const stateLockIndex = testHarness.queries.findIndex((query) =>
      query.sql.includes('FROM project_states'),
    );
    const headClearIndex = testHarness.queries.findIndex((query) =>
      query.sql.startsWith('UPDATE directory_versions'),
    );
    expect(stateLockIndex).toBeGreaterThanOrEqual(0);
    expect(headClearIndex).toBeGreaterThan(stateLockIndex);
  });

  it('rejects a directory payload that is not an array of safe JSON values', async () => {
    const claimed = job(WorkflowType.DIRECTORY);
    const payload = Buffer.from('{"nodes":[]}', 'utf8');
    const proposal = proposalRow(claimed, payload);
    const testHarness = harness(
      initialHandler(claimed, proposal, () => {
        throw new Error('unexpected business query');
      }),
    );

    await expect(
      testHarness.service.commitApproved(claimed),
    ).rejects.toMatchObject({
      code: 'AUTHORING_PAYLOAD_INVALID',
    });
  });
});

function atomicCandidate(
  claimed: ClaimedWorkflowJob,
  text: string,
  assignmentSnapshotDigest: string,
): SealedGroundedCandidateV1 {
  const evidenceId = 'evidence-1';
  const candidateClaimKey = 'b'.repeat(64);
  const persistedClaimId = 'c'.repeat(64);
  const evidenceSnapshotDigest = 'd'.repeat(64);
  const canonicalClaim = {
    canonical_claim_version: 'canonical-atomic-claim.v1' as const,
    candidate_claim_key: candidateClaimKey,
    source_claim_text_nfc: text,
    rendered_claim_text: text,
    subject_anchor: {
      surface_nfc: '装机容量',
      start_utf16: 0,
      end_utf16: 4,
    },
    predicate_anchor: {
      surface_nfc: '为',
      start_utf16: 4,
      end_utf16: 5,
    },
    polarity: 'affirmed' as const,
    quantifier: 'plain' as const,
    quantities: [
      {
        ordinal: 0,
        surface_nfc: '300 MW',
        start_utf16: 6,
        end_utf16: 12,
        dimension: 'power' as const,
        base_value: '300000000',
        base_unit: 'W',
        comparator: 'eq' as const,
        range_end_base_value: null,
        typed_equivalence_eligible: true,
      },
    ],
    evidence_ids: [evidenceId],
    fragment: {
      ordinal: 0,
      presentation: 'sentence' as const,
      previous_structure_id: null,
      next_structure_id: null,
    },
    revision: {
      attempt: 0 as const,
      revision_of_candidate_claim_key: null,
    },
  };
  const withoutEnvelopeDigest = {
    envelope_version: 'sealed-grounded-candidate.v1' as const,
    contract_version: 'atomic:v1' as const,
    schema_version: 'grounded-draft.v1' as const,
    canonical_json_version: 'canonical-json.v1' as const,
    canonicalizer_version: 'atomic-canonicalizer.v1' as const,
    quantity_lexer_version: 'quantity-lexer.v1' as const,
    plain_text_escape_version: 'escape-plain-text.v1' as const,
    renderer_version: 'atomic-renderer.v1' as const,
    verifier_version: 'atomic-verifier.v1' as const,
    workflow: {
      workflow_job_id: claimed.id,
      project_id: claimed.projectId,
      workflow_type: 'content' as const,
      generation_attempt: 1,
      revision_attempt: 0 as const,
    },
    canonical_proposal: {
      schema_version: 'grounded-draft.v1' as const,
      status: 'draft' as const,
      claims: [
        {
          proposal_claim_id: 'proposal-claim-1',
          revision_of_candidate_claim_key: null,
          claim_text: text,
          span: {
            fragment_id: 'claim-fragment-1',
            start_utf16: 0 as const,
            end_utf16: text.length,
          },
          subject: { surface: '装机容量', start_utf16: 0, end_utf16: 4 },
          predicate: { surface: '为', start_utf16: 4, end_utf16: 5 },
          polarity: 'affirmed' as const,
          quantifier: 'plain' as const,
          quantities: [
            {
              quantity_id: 'quantity-1',
              surface: '300 MW',
              start_utf16: 6,
              end_utf16: 12,
              dimension: 'power' as const,
              value: '300',
              unit: 'MW',
              comparator: 'eq' as const,
              range_end: null,
            },
          ],
          evidence_ids: [evidenceId],
        },
      ],
      render_fragments: [
        {
          fragment_id: 'claim-fragment-1',
          kind: 'claim_ref' as const,
          claim_id: 'proposal-claim-1',
          presentation: 'sentence' as const,
        },
      ],
      ordering: ['claim-fragment-1'],
      material_gap: null,
    },
    render_context: {
      context_version: 'approved-render-context.v1' as const,
      entries: [],
    },
    server_output: {
      text,
      utf8_byte_length: Buffer.byteLength(text, 'utf8'),
      utf16_length: text.length,
    },
    claims: [
      {
        candidate_claim_key: candidateClaimKey,
        persisted_claim_id: persistedClaimId,
        canonical_claim: canonicalClaim,
        output_char_start_utf16: 0,
        output_char_end_utf16: text.length,
        support_status: 'SUPPORTED' as const,
        support_score: '1' as const,
        verification_method: 'atomic_extract_exact' as const,
        evidence_refs: [
          {
            evidence_id: evidenceId,
            evidence_snapshot_digest: evidenceSnapshotDigest,
          },
        ],
        non_target_invariant_digest: 'e'.repeat(64),
      },
    ],
    evidence_snapshots: [
      {
        evidence_id: evidenceId,
        retrieval_run_id: 'retrieval-run-1',
        chunk_id: 'chunk-1',
        project_id: claimed.projectId,
        file_id: 'file-1',
        document_id: 'document-1',
        ingestion_key: 'ingestion-1',
        exact_span_text_nfc: text,
        exact_span_document_start: 10,
        exact_span_document_end: 10 + text.length,
        candidate_rank: 1,
        scores: {
          sparse: null,
          dense: '0.9',
          fusion: '0.9',
          rerank: '1',
        },
        ranks: { sparse: null, dense: 1, fusion: 1, rerank: 1 },
        index_snapshot: { generation: 1 },
        evidence_snapshot_digest: evidenceSnapshotDigest,
      },
    ],
    digests: {
      proposal_digest: '1'.repeat(64),
      render_context_digest: '2'.repeat(64),
      render_digest: '3'.repeat(64),
      assignment_digest: createHash('sha256')
        .update(`atomic:v1\0${assignmentSnapshotDigest}`, 'utf8')
        .digest('hex'),
      ledger_digest: '4'.repeat(64),
    },
  };
  const envelopeDigest = digestCanonicalV1(
    'sealed-grounded-candidate.v1',
    withoutEnvelopeDigest,
  );
  return {
    ...withoutEnvelopeDigest,
    digests: {
      ...withoutEnvelopeDigest.digests,
      envelope_digest: envelopeDigest,
    },
  };
}
