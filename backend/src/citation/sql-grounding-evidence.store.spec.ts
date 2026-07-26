import { BadRequestException } from '@nestjs/common';
import { SqlGroundingEvidenceStore } from './sql-grounding-evidence.store.js';
import { MaterialGapError } from './material-gap.error.js';
import type { AtomicGroundingReasonCode } from './atomic-grounding/contracts.js';

const evidenceRow = (overrides: Record<string, unknown> = {}) => ({
  workflow_job_id: 'job-1',
  job_project_id: 'project-1',
  assignment_project_id: 'project-1',
  retrieval_run_id: 'run-1',
  retrieval_run_refs: '["run-1"]',
  run_project_id: 'project-1',
  run_state: 'READY',
  primary_run_project_id: 'project-1',
  primary_run_state: 'READY',
  evidence_retrieval_run_id: 'run-1',
  evidence_run_project_id: 'project-1',
  evidence_run_state: 'READY',
  retrieval_state: 'READY',
  contract_version: 'atomic:v1',
  strict_mode: 1,
  targeted_revision_attempts: 0,
  evidence_ids: '["evidence:chunk-1"]',
  evidence_json: JSON.stringify({
    evidence_id: 'evidence:chunk-1',
    chunk_id: 'chunk-1',
    exact_span: {
      text: '装机容量为 300 MW',
      char_start: 103,
      char_end: 115,
    },
    source: {
      file_id: 'file-1',
      document_id: 'document-1',
      ingestion_key: 'ingestion-1',
      page_start: 3,
      page_end: 3,
      heading_path: ['第一章'],
    },
  }),
  selected: 1,
  chunk_id: 'chunk-1',
  chunk_project_id: 'project-1',
  file_id: 'file-1',
  document_id: 'document-1',
  candidate_ingestion_key: 'ingestion-1',
  chunk_ingestion_key: 'ingestion-1',
  active_ingestion_key: 'ingestion-1',
  document_ingestion_key: 'ingestion-1',
  chunk_active: 1,
  document_active: 1,
  content: '本项目装机容量为 300 MW。',
  chunk_char_start: 100,
  sparse_rank: 2,
  dense_rank: 1,
  fusion_rank: 1,
  rerank_rank: 1,
  sparse_score: 4.2,
  dense_score: 0.8,
  fusion_score: 0.06,
  rerank_score: 0.9,
  ...overrides,
});

const assignmentDataSource = (
  row: ReturnType<typeof evidenceRow>,
  indexes: Array<Record<string, unknown>> = [],
) => ({
  query: jest.fn(async (sql: string) => {
    await Promise.resolve();
    if (sql.includes('FROM grounding_assignments ga')) return [row];
    if (sql.includes('FROM retrieval_runs')) {
      return [
        {
          id: row.retrieval_run_id,
          project_id: row.primary_run_project_id,
          state: row.primary_run_state,
        },
      ];
    }
    if (sql.includes('FROM retrieval_candidates rc')) return [row];
    if (sql.includes('FROM retrieval_run_index_versions')) return indexes;
    if (sql.includes('UPDATE grounding_assignments')) {
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }),
});

describe('SqlGroundingEvidenceStore', () => {
  it('loads only selected evidence from the job-bound active ingestion', async () => {
    const dataSource = assignmentDataSource(evidenceRow(), [
      {
        retrieval_run_id: 'run-1',
        file_id: 'file-1',
        ingestion_key: 'ingestion-1',
        index_version: 'rag-v1',
        status: 'READY',
      },
    ]);
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    const loaded = await store.loadAssignment('job-1');

    expect(loaded).toMatchObject({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      retrieval_state: 'READY',
      contract_version: 'atomic:v1',
      strict_mode: true,
      evidence: [
        {
          evidence_id: 'evidence:chunk-1',
          chunk_id: 'chunk-1',
          content: '本项目装机容量为 300 MW。',
          exact_span_text: '装机容量为 300 MW',
          exact_span_document_start: 103,
          exact_span_document_end: 115,
          index_snapshot: {
            file_id: 'file-1',
            ingestion_key: 'ingestion-1',
            index_version: 'rag-v1',
            status: 'READY',
          },
        },
      ],
    });
    expect(loaded?.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded?.evidence[0].evidence_snapshot_digest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('SET snapshot_digest = ?'),
      [loaded?.snapshot_digest, 'job-1'],
    );
  });

  it('loads the sealed old and targeted runs as one revision assignment', async () => {
    const assignment = {
      workflow_job_id: 'job-1',
      job_project_id: 'project-1',
      assignment_project_id: 'project-1',
      retrieval_run_id: 'run-new',
      primary_run_project_id: 'project-1',
      retrieval_state: 'READY',
      contract_version: 'atomic:v1',
      primary_run_state: 'READY',
      retrieval_run_refs: '["run-old","run-new"]',
      strict_mode: 1,
      targeted_revision_attempts: 1,
      evidence_ids: '["evidence:old","evidence:new"]',
      snapshot_digest: null,
    };
    const candidate = (evidenceId: string, runId: string, chunkId: string) =>
      evidenceRow({
        retrieval_run_id: runId,
        evidence_retrieval_run_id: runId,
        run_state: 'READY',
        evidence_run_project_id: 'project-1',
        evidence_run_state: 'READY',
        evidence_ids: assignment.evidence_ids,
        chunk_id: chunkId,
        file_id: `file-${chunkId}`,
        document_id: `document-${chunkId}`,
        candidate_ingestion_key: `ingestion-${chunkId}`,
        chunk_ingestion_key: `ingestion-${chunkId}`,
        active_ingestion_key: `ingestion-${chunkId}`,
        document_ingestion_key: `ingestion-${chunkId}`,
        content: `${evidenceId} content`,
        chunk_char_start: 0,
        evidence_json: JSON.stringify({
          evidence_id: evidenceId,
          chunk_id: chunkId,
          exact_span: {
            text: `${evidenceId} content`,
            char_start: 0,
            char_end: `${evidenceId} content`.length,
          },
          source: {
            file_id: `file-${chunkId}`,
            document_id: `document-${chunkId}`,
            ingestion_key: `ingestion-${chunkId}`,
            page_start: 1,
            page_end: 1,
            heading_path: [],
          },
        }),
      });
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        await Promise.resolve();
        if (sql.includes('FROM grounding_assignments ga')) return [assignment];
        if (sql.includes('FROM retrieval_runs')) {
          return [
            { id: 'run-old', project_id: 'project-1', state: 'READY' },
            { id: 'run-new', project_id: 'project-1', state: 'READY' },
          ];
        }
        if (sql.includes('FROM retrieval_candidates rc')) {
          return [
            candidate('evidence:old', 'run-old', 'chunk-old'),
            candidate('evidence:new', 'run-new', 'chunk-new'),
          ];
        }
        if (sql.includes('FROM retrieval_run_index_versions')) {
          return [];
        }
        if (sql.includes('UPDATE grounding_assignments')) {
          return { affectedRows: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    const loaded = await store.loadAssignment('job-1');

    expect(loaded).toMatchObject({
      retrieval_run_id: 'run-new',
      retrieval_run_refs: ['run-old', 'run-new'],
      evidence: [
        { evidence_id: 'evidence:old', retrieval_run_id: 'run-old' },
        { evidence_id: 'evidence:new', retrieval_run_id: 'run-new' },
      ],
    });
  });

  it('fails closed when one legacy evidence id resolves to different run snapshots', async () => {
    const assignment = {
      workflow_job_id: 'job-1',
      job_project_id: 'project-1',
      assignment_project_id: 'project-1',
      retrieval_run_id: 'run-new',
      primary_run_project_id: 'project-1',
      retrieval_state: 'READY',
      contract_version: 'atomic:v1',
      primary_run_state: 'READY',
      retrieval_run_refs: '["run-old","run-new"]',
      strict_mode: 1,
      targeted_revision_attempts: 1,
      evidence_ids: '["legacy:chunk-1"]',
      snapshot_digest: null,
    };
    const candidate = (runId: string, text: string) =>
      evidenceRow({
        retrieval_run_id: runId,
        evidence_retrieval_run_id: runId,
        evidence_ids: assignment.evidence_ids,
        content: text,
        chunk_char_start: 0,
        evidence_json: JSON.stringify({
          evidence_id: 'legacy:chunk-1',
          chunk_id: 'chunk-1',
          exact_span: {
            text,
            char_start: 0,
            char_end: text.length,
          },
          source: {
            file_id: 'file-1',
            document_id: 'document-1',
            ingestion_key: 'ingestion-1',
            page_start: 1,
            page_end: 1,
            heading_path: [],
          },
        }),
      });
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        await Promise.resolve();
        if (sql.includes('FROM grounding_assignments ga')) return [assignment];
        if (sql.includes('FROM retrieval_runs')) {
          return [
            { id: 'run-old', project_id: 'project-1', state: 'READY' },
            { id: 'run-new', project_id: 'project-1', state: 'READY' },
          ];
        }
        if (sql.includes('FROM retrieval_candidates rc')) {
          return [
            candidate('run-old', '装机容量为300MW'),
            candidate('run-new', '年发电量为12亿千瓦时'),
          ];
        }
        if (sql.includes('FROM retrieval_run_index_versions')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toThrow(
      'legacy evidence id 歧义',
    );
  });

  it('deduplicates an identical evidence snapshot from the same run', async () => {
    const row = evidenceRow();
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        await Promise.resolve();
        if (sql.includes('FROM grounding_assignments ga')) return [row];
        if (sql.includes('FROM retrieval_runs')) {
          return [{ id: 'run-1', project_id: 'project-1', state: 'READY' }];
        }
        if (sql.includes('FROM retrieval_candidates rc')) return [row, row];
        if (sql.includes('FROM retrieval_run_index_versions')) return [];
        if (sql.includes('UPDATE grounding_assignments')) {
          return { affectedRows: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    const loaded = await store.loadAssignment('job-1');

    expect(loaded?.evidence).toHaveLength(1);
    expect(loaded?.evidence[0]).toMatchObject({
      evidence_id: 'evidence:chunk-1',
      retrieval_run_id: 'run-1',
    });
  });

  it('rejects a persisted assignment whose canonical snapshot digest changed', async () => {
    const dataSource = assignmentDataSource(
      evidenceRow({ snapshot_digest: '0'.repeat(64) }),
    );
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toThrow(
      '快照摘要不一致',
    );
  });

  it('changes the assignment digest when only the contract version changes', async () => {
    let contractVersion: 'atomic:v1' | 'legacy:v0' = 'atomic:v1';
    let persistedDigest: string | null = null;
    const row = evidenceRow();
    const dataSource = {
      query: jest.fn(async (sql: string, parameters?: unknown[]) => {
        await Promise.resolve();
        if (sql.includes('FROM grounding_assignments ga')) {
          return [
            {
              ...row,
              contract_version: contractVersion,
              snapshot_digest: persistedDigest,
            },
          ];
        }
        if (sql.includes('FROM retrieval_runs')) {
          return [{ id: 'run-1', project_id: 'project-1', state: 'READY' }];
        }
        if (sql.includes('FROM retrieval_candidates rc')) return [row];
        if (sql.includes('FROM retrieval_run_index_versions')) return [];
        if (sql.includes('UPDATE grounding_assignments')) {
          persistedDigest = String(parameters?.[0]);
          return { affectedRows: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);
    const atomic = await store.loadAssignment('job-1');

    contractVersion = 'legacy:v0';

    await expect(store.loadAssignment('job-1')).rejects.toThrow(
      '快照摘要不一致',
    );
    expect(atomic?.contract_version).toBe('atomic:v1');
  });

  it('rejects commit when an unreferenced assigned candidate drifts', async () => {
    const secondEvidence = {
      evidence_id: 'evidence:chunk-2',
      chunk_id: 'chunk-2',
      exact_span: {
        text: '年发电量为 12 亿千瓦时',
        char_start: 200,
        char_end: 214,
      },
      source: {
        file_id: 'file-2',
        document_id: 'document-2',
        ingestion_key: 'ingestion-2',
        page_start: 4,
        page_end: 4,
        heading_path: ['第二章'],
      },
    };
    const metadata = evidenceRow({
      evidence_ids: '["evidence:chunk-1","evidence:chunk-2"]',
    });
    const secondRow = evidenceRow({
      evidence_ids: metadata.evidence_ids,
      evidence_json: JSON.stringify(secondEvidence),
      chunk_id: 'chunk-2',
      file_id: 'file-2',
      document_id: 'document-2',
      candidate_ingestion_key: 'ingestion-2',
      chunk_ingestion_key: 'ingestion-2',
      active_ingestion_key: 'ingestion-2',
      document_ingestion_key: 'ingestion-2',
      content: '年发电量为 12 亿千瓦时',
      chunk_char_start: 200,
      rerank_rank: 2,
      rerank_score: 0.8,
    });
    let drifted = false;
    let persistedDigest: string | undefined;
    const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
      await Promise.resolve();
      if (sql.includes('FROM grounding_assignments ga')) {
        return [
          {
            ...metadata,
            snapshot_digest: persistedDigest ?? null,
          },
        ];
      }
      if (sql.includes('FROM grounding_assignments')) {
        return [
          {
            ...metadata,
            snapshot_digest: persistedDigest,
          },
        ];
      }
      if (sql.includes('FROM retrieval_runs')) {
        return [{ id: 'run-1', project_id: 'project-1', state: 'READY' }];
      }
      if (sql.includes('FROM retrieval_candidates rc')) {
        return [
          metadata,
          {
            ...secondRow,
            rerank_score: drifted ? 0.4 : secondRow.rerank_score,
          },
        ];
      }
      if (sql.includes('FROM retrieval_run_index_versions')) return [];
      if (sql.includes('UPDATE grounding_assignments')) {
        persistedDigest = parameters?.[0] as string | undefined;
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO')) return { affectedRows: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const dataSource = { query };
    const store = new SqlGroundingEvidenceStore(dataSource as never);
    const loaded = await store.loadAssignment('job-1');
    persistedDigest = loaded?.snapshot_digest;
    drifted = true;
    const first = loaded!.evidence[0];

    await expect(
      store.saveLedger({ query } as never, 'result-1', {
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        retrieval_run_refs: ['run-1'],
        assignment_snapshot_digest: loaded!.snapshot_digest,
        decision: 'ALLOW',
        claims: [
          {
            claim_id: 'claim-1',
            claim_text: '装机容量为 300 MW。',
            normalized_claim_text: '装机容量为300mw',
            output_char_start: 0,
            output_char_end: 13,
            support_status: 'SUPPORTED',
            support_score: 1,
            verification_method: 'deterministic_exact',
            links: [
              {
                ...first,
                exact_span_chunk_start: 3,
                exact_span_chunk_end: 15,
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('快照');
  });

  it.each([
    ['foreign job project', { job_project_id: 'project-2' }],
    [
      'foreign retrieval project',
      {
        primary_run_project_id: 'project-2',
        evidence_run_project_id: 'project-2',
      },
    ],
    ['unselected candidate', { selected: 0 }],
    ['inactive document', { document_active: 0 }],
    ['stale ingestion', { active_ingestion_key: 'ingestion-2' }],
  ])('rejects %s before verification', async (_label, overrides) => {
    const dataSource = assignmentDataSource(evidenceRow(overrides));
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    [
      'unselected candidate',
      (row: ReturnType<typeof evidenceRow>) => {
        row.selected = 0;
      },
      'EVIDENCE_NOT_SELECTED',
    ],
    [
      'inactive ingestion',
      (row: ReturnType<typeof evidenceRow>) => {
        row.document_active = 0;
      },
      'EVIDENCE_INGESTION_INACTIVE',
    ],
    [
      'retrieval run drift',
      (row: ReturnType<typeof evidenceRow>) => {
        row.evidence_run_state = 'ERROR';
      },
      'EVIDENCE_RUN_DRIFT',
    ],
    [
      'exact span offset drift',
      (row: ReturnType<typeof evidenceRow>) => {
        const evidence = JSON.parse(row.evidence_json) as Record<
          string,
          Record<string, unknown>
        >;
        evidence.exact_span.char_start = 104;
        row.evidence_json = JSON.stringify(evidence);
      },
      'EVIDENCE_OFFSET_DRIFT',
    ],
  ] satisfies Array<
    [
      string,
      (row: ReturnType<typeof evidenceRow>) => void,
      AtomicGroundingReasonCode,
    ]
  >)(
    'throws the typed closed reason for %s',
    async (_label, mutate, reason) => {
      const row = evidenceRow();
      mutate(row);
      const store = new SqlGroundingEvidenceStore(
        assignmentDataSource(row) as never,
      );

      await expect(store.loadAssignment('job-1')).rejects.toMatchObject({
        reason,
      });
    },
  );

  it.each([
    [
      'assignment project drift',
      { job_project_id: 'project-other' },
      'ASSIGNMENT_PROJECT_MISMATCH',
    ],
    [
      'assignment contract drift',
      { contract_version: 'future:v2' },
      'ASSIGNMENT_CONTRACT_MISMATCH',
    ],
    [
      'primary retrieval state drift',
      { primary_run_state: 'ERROR' },
      'RETRIEVAL_STATE_INVALID',
    ],
    [
      'primary run omitted from refs',
      { retrieval_run_refs: '["run-other"]' },
      'EVIDENCE_RUN_DRIFT',
    ],
    [
      'malformed run refs',
      { retrieval_run_refs: 'not-json' },
      'EVIDENCE_RUN_DRIFT',
    ],
    [
      'referenced run row disappeared',
      { retrieval_run_refs: '["run-1","run-missing"]' },
      'EVIDENCE_RUN_DRIFT',
    ],
    [
      'malformed assigned evidence ids',
      { evidence_ids: 'not-json' },
      'ASSIGNMENT_SNAPSHOT_DRIFT',
    ],
  ] satisfies Array<
    [string, Record<string, unknown>, AtomicGroundingReasonCode]
  >)('types metadata/run failure for %s', async (_label, overrides, reason) => {
    const store = new SqlGroundingEvidenceStore(
      assignmentDataSource(evidenceRow(overrides)) as never,
    );

    await expect(store.loadAssignment('job-1')).rejects.toMatchObject({
      reason,
    });
  });

  it('types duplicate assignment metadata as assignment snapshot drift', async () => {
    const row = evidenceRow();
    const dataSource = assignmentDataSource(row);
    dataSource.query.mockImplementation(async (sql: string) => {
      await Promise.resolve();
      if (sql.includes('FROM grounding_assignments ga')) return [row, row];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toMatchObject({
      reason: 'ASSIGNMENT_SNAPSHOT_DRIFT',
    });
  });

  it('rejects assignments whose evidence id is missing from persisted candidates', async () => {
    const dataSource = assignmentDataSource(
      evidenceRow({ evidence_ids: '["evidence:missing"]' }),
    );
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toThrow(
      '未找到已分配证据',
    );
  });

  it.each([
    [true, 'atomic:v1'],
    [false, 'legacy:v0'],
  ] as const)(
    'persists the locked retrieval state and explicit %s contract',
    async (strictMode, contractVersion) => {
      const manager = {
        query: jest
          .fn()
          .mockResolvedValueOnce([
            {
              job_project_id: 'project-1',
              run_project_id: 'project-1',
              retrieval_state: 'READY',
              evidence: JSON.stringify({ evidence_id: 'evidence:chunk-1' }),
            },
          ])
          .mockResolvedValueOnce({ affectedRows: 1 }),
      };
      const dataSource = {
        transaction: async <T>(
          callback: (value: typeof manager) => Promise<T>,
        ): Promise<T> => callback(manager),
      };
      const store = new SqlGroundingEvidenceStore(dataSource as never);

      await store.assignEvidence({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        retrieval_state: 'DEGRADED',
        evidence_ids: ['evidence:chunk-1'],
        strict_mode: strictMode,
        contract_version: contractVersion,
      });

      const assignCalls = manager.query.mock.calls as unknown[][];
      expect((assignCalls[1][1] as unknown[])[3]).toBe('READY');
      expect(String(assignCalls[1][0])).toContain('contract_version');
      expect(assignCalls[1][1]).toEqual([
        'job-1',
        'project-1',
        'run-1',
        'READY',
        '["run-1"]',
        '["evidence:chunk-1"]',
        strictMode ? 1 : 0,
        contractVersion,
      ]);
    },
  );

  it.each([
    ['mismatched snapshot', { run_state: 'DEGRADED' }],
    ['non-terminal run', { run_state: 'RUNNING', retrieval_state: 'RUNNING' }],
  ])('rejects %s assignment state', async (_label, overrides) => {
    const mapped = {
      ...overrides,
      ...(overrides.run_state
        ? { primary_run_state: overrides.run_state }
        : {}),
    };
    const dataSource = assignmentDataSource(evidenceRow(mapped));
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(store.loadAssignment('job-1')).rejects.toThrow('检索状态无效');
  });

  it('inherits each cited evidence from its own retrieval run for compress', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            job_project_id: 'project-1',
            primary_run_project_id: 'project-1',
            primary_run_state: 'READY',
            evidence_retrieval_run_id: 'run-old',
            evidence_run_project_id: 'project-1',
            evidence_run_state: 'READY',
            evidence: JSON.stringify({ evidence_id: 'evidence:old' }),
          },
          {
            job_project_id: 'project-1',
            primary_run_project_id: 'project-1',
            primary_run_state: 'READY',
            evidence_retrieval_run_id: 'run-new',
            evidence_run_project_id: 'project-1',
            evidence_run_state: 'READY',
            evidence: JSON.stringify({ evidence_id: 'evidence:new' }),
          },
        ])
        .mockResolvedValueOnce({ affectedRows: 1 }),
    };
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          retrieval_run_id: 'run-new',
          retrieval_state: 'READY',
          contract_version: 'atomic:v1',
          retrieval_run_refs: '["run-old","run-new"]',
          evidence_retrieval_run_id: 'run-old',
          evidence_id: 'evidence:old',
        },
        {
          retrieval_run_id: 'run-new',
          retrieval_state: 'READY',
          contract_version: 'atomic:v1',
          retrieval_run_refs: '["run-old","run-new"]',
          evidence_retrieval_run_id: 'run-new',
          evidence_id: 'evidence:new',
        },
      ]),
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);
    const inherited = {
      workflow_job_id: 'compress-job',
      project_id: 'project-1',
      retrieval_run_id: 'run-new',
      retrieval_run_refs: ['run-old', 'run-new'],
      retrieval_state: 'READY',
      contract_version: 'atomic:v1' as const,
      strict_mode: true,
      targeted_revision_attempts: 0,
      evidence: [],
    };
    const assign = jest
      .spyOn(store, 'assignEvidence')
      .mockRejectedValue(
        new BadRequestException('证据 evidence:old 未包含在检索快照中'),
      );
    jest.spyOn(store, 'loadAssignment').mockResolvedValue(inherited);

    await expect(
      store.inheritEvidenceAssignment({
        workflow_job_id: 'compress-job',
        project_id: 'project-1',
        parent_result_id: 'result-1',
        strict_mode: true,
        contract_version: 'atomic:v1',
      }),
    ).resolves.toBe(inherited);
    expect(assign).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO grounding_assignments'),
      [
        'compress-job',
        'project-1',
        'run-new',
        'READY',
        '["run-old","run-new"]',
        '["evidence:old","evidence:new"]',
        1,
        'atomic:v1',
      ],
    );
    const queryCalls = dataSource.query.mock.calls as unknown as Array<
      [string, ...unknown[]]
    >;
    const inheritanceSql = queryCalls[0]?.[0] ?? '';
    expect(inheritanceSql).toContain("ga.contract_version = 'atomic:v1'");
    expect(inheritanceSql).toContain('gc.atomic_claim IS NOT NULL');
    expect(inheritanceSql).toContain(
      '$.canonical_claim.canonical_claim_version',
    );
    expect(inheritanceSql).toContain("= 'canonical-atomic-claim.v1'");
    expect(inheritanceSql).toContain('$.verifier_version');
    expect(inheritanceSql).toContain("= 'atomic-verifier.v1'");
    expect(inheritanceSql).toContain("gc.support_status = 'SUPPORTED'");
    expect(inheritanceSql).toContain(
      "gc.verification_method IN ('atomic_extract_exact', 'atomic_typed_equivalent')",
    );
    expect(inheritanceSql).toContain('cm.evidence_id IS NOT NULL');
    expect(inheritanceSql).toContain('cm.snapshot_digest IS NOT NULL');
    expect(inheritanceSql).toContain('AND NOT EXISTS (');
    expect(inheritanceSql).toContain(
      'LEFT JOIN grounding_assignments parent_ga',
    );
    expect(inheritanceSql).toContain('NOT EXISTS (');
    expect(inheritanceSql).toContain('EXISTS (');
  });

  it('rejects a legacy parent even when its persisted support columns say SUPPORTED', async () => {
    const legacyRow = {
      retrieval_run_id: 'run-1',
      retrieval_state: 'READY',
      retrieval_run_refs: '["run-1"]',
      evidence_retrieval_run_id: 'run-1',
      evidence_id: 'evidence:old',
    };
    const dataSource = {
      query: jest.fn(async (sql: string) => {
        await Promise.resolve();
        return sql.includes("ga.contract_version = 'atomic:v1'")
          ? []
          : [legacyRow];
      }),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await expect(
      store.inheritEvidenceAssignment({
        workflow_job_id: 'compress-job',
        project_id: 'project-1',
        parent_result_id: 'legacy-result',
        strict_mode: true,
        contract_version: 'atomic:v1',
      }),
    ).rejects.toThrow('没有可继承的可信证据');
  });

  it('atomically merges revision evidence and run refs for the reserved first attempt', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          {
            retrieval_run_id: 'run-old',
            retrieval_run_refs: '["run-old"]',
            evidence_ids: '["evidence:old"]',
            contract_version: 'atomic:v1',
            strict_mode: 1,
            targeted_revision_attempts: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            job_project_id: 'project-1',
            run_project_id: 'project-1',
            retrieval_state: 'READY',
            evidence: JSON.stringify({ evidence_id: 'evidence:new' }),
          },
        ])
        .mockResolvedValueOnce({ affectedRows: 1 }),
    };
    const dataSource = {
      transaction: async <T>(
        callback: (value: typeof manager) => Promise<T>,
      ): Promise<T> => callback(manager),
    };
    const store = new SqlGroundingEvidenceStore(dataSource as never);

    await store.replaceEvidenceAfterTargetedRetrieval({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-new',
      retrieval_state: 'DEGRADED',
      evidence_ids: ['evidence:new'],
      strict_mode: true,
      contract_version: 'atomic:v1',
      revision_attempt: 1,
    });

    const replaceCalls = manager.query.mock.calls as unknown[][];
    expect(String(replaceCalls[2][0])).toContain(
      'targeted_revision_attempts = ?',
    );
    expect(String(replaceCalls[2][0])).toContain('snapshot_digest = NULL');
    expect(String(replaceCalls[2][0])).toContain('retrieval_run_refs = ?');
    expect(replaceCalls[2][1]).toEqual([
      'run-new',
      'READY',
      '["run-old","run-new"]',
      '["evidence:old","evidence:new"]',
      1,
      'atomic:v1',
      'job-1',
      'project-1',
      1,
    ]);
  });

  it.each([
    ['legacy contract', 'legacy:v0' as const, true],
    ['non-strict legacy contract', 'legacy:v0' as const, false],
    ['non-strict atomic contract', 'atomic:v1' as const, false],
  ])(
    'rejects %s targeted replacement before opening a transaction',
    async (_label, contractVersion, strictMode) => {
      const transaction = jest.fn(async () => {
        await Promise.resolve();
        throw new Error('transaction must not start');
      });
      const store = new SqlGroundingEvidenceStore({
        transaction,
      } as never);

      await expect(
        store.replaceEvidenceAfterTargetedRetrieval({
          workflow_job_id: 'job-1',
          project_id: 'project-1',
          retrieval_run_id: 'run-new',
          retrieval_state: 'READY',
          evidence_ids: ['evidence:new'],
          strict_mode: strictMode,
          contract_version: contractVersion,
          revision_attempt: 1,
        }),
      ).rejects.toBeInstanceOf(MaterialGapError);
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
