import {
  GroundingVerifier,
  type AssignedEvidenceSnapshot,
} from './grounding-verifier.js';

const evidence = (
  overrides: Partial<AssignedEvidenceSnapshot> = {},
): AssignedEvidenceSnapshot => ({
  evidence_id: 'evidence:chunk-1',
  chunk_id: 'chunk-1',
  project_id: 'project-1',
  file_id: 'file-1',
  document_id: 'document-1',
  retrieval_run_id: 'run-1',
  ingestion_key: 'ingestion-1',
  content: '本项目装机容量为 300 MW，预计年发电量为 12 亿千瓦时。',
  exact_span_text: '装机容量为 300 MW',
  chunk_char_start: 100,
  exact_span_document_start: 103,
  exact_span_document_end: 115,
  candidate_rank: 1,
  scores: {
    sparse: 4.2,
    dense: 0.81,
    fusion: 0.06,
    rerank: 0.94,
  },
  ranks: {
    sparse: 2,
    dense: 1,
    fusion: 1,
    rerank: 1,
  },
  page_start: 3,
  page_end: 3,
  heading_path: ['第一章', '项目概况'],
  index_snapshot: { index_version: 'rag-v1' },
  ...overrides,
});

function expectLegacyCapped(
  claims: Array<{
    support_status: string;
    support_score: number;
    verification_method: string;
  }>,
): void {
  expect(claims).not.toHaveLength(0);
  for (const claim of claims) {
    expect(claim).toMatchObject({
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
  }
}

describe('GroundingVerifier', () => {
  const verifier = new GroundingVerifier();

  it('derives claim and evidence offsets from server-owned text', async () => {
    const output =
      '<!-- paragraph_key:p1 -->\n装机容量为 300 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: true,
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      claim_text: '装机容量为 300 MW。',
      normalized_claim_text: '装机容量为300mw',
      output_char_start: 1,
      output_char_end: 14,
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
    expect(result.claims[0].links[0]).toMatchObject({
      evidence_id: 'evidence:chunk-1',
      exact_span_text: '装机容量为 300 MW',
      exact_span_chunk_start: 3,
      exact_span_chunk_end: 15,
      exact_span_document_start: 103,
      exact_span_document_end: 115,
    });
  });

  it('rejects evidence assigned to a different project or retrieval run', async () => {
    const output =
      '装机容量为 300 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    await expect(
      verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output,
        evidence: [evidence({ project_id: 'project-2' })],
        strict: true,
      }),
    ).rejects.toThrow('不属于当前项目');

    await expect(
      verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output,
        evidence: [evidence({ retrieval_run_id: 'run-2' })],
        strict: true,
      }),
    ).rejects.toThrow('不属于本次检索');
  });

  it('parses sealed evidence from every run but never authorizes it', async () => {
    const claim = '装机容量为 300 MW。';
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-new',
      retrieval_run_refs: ['run-1', 'run-new'],
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [evidence({ retrieval_run_id: 'run-1' })],
      strict: true,
    });

    expect(result.decision).toBe('TARGETED_RETRIEVAL_REVISION');
    expectLegacyCapped(result.claims);
    expect(result.retrieval_run_refs).toEqual(['run-1', 'run-new']);
  });

  it('rejects missing evidence and tampered exact-span offsets', async () => {
    const output =
      '装机容量为 300 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:missing"]} -->';

    await expect(
      verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output,
        evidence: [evidence()],
        strict: true,
      }),
    ).rejects.toThrow('未分配给本次写作');

    const assigned = evidence({ exact_span_document_start: 104 });
    await expect(
      verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: output.replace('evidence:missing', 'evidence:chunk-1'),
        evidence: [assigned],
        strict: true,
      }),
    ).rejects.toThrow('证据偏移不一致');
  });

  it('caps a loose numeric contradiction as legacy unverifiable', async () => {
    const output =
      '装机容量为 500 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 500 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: false,
    });

    expect(result.claims[0]).toMatchObject({
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
    expect(result.decision).toBe('ALLOW_WITH_UNSUPPORTED');
  });

  it('requires one targeted revision before raising a strict material gap', async () => {
    const output =
      '装机容量为 500 MW。\n' +
      '<!-- claim_evidence:{"claim_text":"装机容量为 500 MW。","evidence_ids":["evidence:chunk-1"]} -->';

    const first = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: true,
      targeted_revision_attempts: 0,
    });
    expect(first.decision).toBe('TARGETED_RETRIEVAL_REVISION');

    const second = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: true,
      targeted_revision_attempts: 1,
    });
    expect(second.decision).toBe('WAITING_MATERIAL');
  });

  it('does not let strict mode bypass grounding by omitting claim markers', async () => {
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: '本项目装机容量为 500 MW。',
      evidence: [evidence()],
      strict: true,
      targeted_revision_attempts: 1,
    });

    expect(result.decision).toBe('WAITING_MATERIAL');
  });

  it('records unmarked loose-mode output as explicitly unverifiable', async () => {
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: '<!-- paragraph_key:p1 -->\n本项目装机容量为 500 MW。',
      evidence: [evidence()],
      strict: false,
    });

    expect(result.decision).toBe('ALLOW_WITH_UNSUPPORTED');
    expect(result.claims).toEqual([
      expect.objectContaining({
        claim_text: '本项目装机容量为 500 MW。',
        support_status: 'UNVERIFIABLE',
        support_score: 0,
        verification_method: 'legacy_unverifiable',
        links: [],
      }),
    ]);
  });

  it('never invokes semantic review to upgrade legacy claims', async () => {
    let reviewCalls = 0;
    const semanticVerifier = new GroundingVerifier({
      async review(input) {
        await Promise.resolve();
        reviewCalls += 1;
        return input.claims.map((claim) => ({
          claim_index: claim.claim_index,
          support_status: 'SUPPORTED' as const,
          support_score: 0.91,
        }));
      },
    });
    const output =
      '项目具备稳定安全运行能力。\n' +
      '<!-- claim_evidence:{"claim_text":"项目具备稳定安全运行能力。","evidence_ids":["evidence:chunk-1"]} -->\n' +
      '系统拥有持续可靠服务能力。\n' +
      '<!-- claim_evidence:{"claim_text":"系统拥有持续可靠服务能力。","evidence_ids":["evidence:chunk-1"]} -->';
    const span = '项目具有稳定、安全的运行能力，系统具备持续、可靠的服务能力';

    const result = await semanticVerifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: true,
    });

    expect(reviewCalls).toBe(0);
    expect(result.decision).toBe('TARGETED_RETRIEVAL_REVISION');
    expectLegacyCapped(result.claims);
  });

  it('rejects marker-only, partial-marker, and non-adjacent marker bypasses', async () => {
    const cases = [
      '<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->',
      '装机容量为 300 MW，利润率必达 99%。\n<!-- claim_evidence:{"claim_text":"装机容量为 300 MW","evidence_ids":["evidence:chunk-1"]} -->',
      '装机容量为 300 MW。\n未标注的另一事实。\n<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->',
    ];

    for (const output of cases) {
      await expect(
        verifier.verify({
          workflow_job_id: 'job-1',
          project_id: 'project-1',
          retrieval_run_id: 'run-1',
          output,
          evidence: [evidence()],
          strict: true,
        }),
      ).rejects.toThrow('必须紧邻并完整匹配可见声明');
    }
  });

  it('covers every visible factual statement and reports visible-only offsets', async () => {
    const first =
      '装机容量为 300 MW。<!-- claim_evidence:{"claim_text":"装机容量为 300 MW。","evidence_ids":["evidence:chunk-1"]} -->';
    const output = `${first}\n第二个事实没有证据。`;
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: true,
      targeted_revision_attempts: 1,
    });

    expect(result.decision).toBe('WAITING_MATERIAL');
    expect(result.claims[0]).toMatchObject({
      claim_text: '装机容量为 300 MW。',
      output_char_start: 0,
      output_char_end: 13,
    });
    expect(result.claims[1]).toMatchObject({
      claim_text: '第二个事实没有证据。',
      support_status: 'UNVERIFIABLE',
    });
    expect(result.claims[1].output_char_start).toBe(first.indexOf('<!--') + 1);
  });

  it.each([
    ['entity', '甲公司装机容量为 300 MW。', '乙公司装机容量为 300 MW'],
    ['unit', '装机容量为 300 kW。', '装机容量为 300 MW'],
    ['negation', '装机容量为 300 MW。', '装机容量不为 300 MW'],
    ['chinese number', '装机容量为三千兆瓦。', '装机容量为三百兆瓦'],
  ])('vetoes deterministic %s contradictions', async (_name, claim, span) => {
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: false,
    });

    expect(result.claims[0]).toMatchObject({
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
    expect(result.decision).toBe('ALLOW_WITH_UNSUPPORTED');
  });

  it('uses only the exact span, never other chunk text, for support', async () => {
    const claim = '系统具备安全性。';
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: '乙公司装机容量为 300 MW。系统具备安全性。',
          exact_span_text: '乙公司装机容量为 300 MW',
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: '乙公司装机容量为 300 MW'.length,
        }),
      ],
      strict: false,
    });

    expectLegacyCapped(result.claims);
  });

  it('never lets semantic review override a deterministic veto', async () => {
    const semanticVerifier = new GroundingVerifier({
      review() {
        return Promise.resolve([
          {
            claim_index: 0,
            support_status: 'SUPPORTED',
            support_score: 1,
          },
        ]);
      },
    });
    const claim = '甲公司装机容量为 300 MW。';
    const span = '乙公司装机容量为 300 MW';
    const result = await semanticVerifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: false,
    });

    expectLegacyCapped(result.claims);
  });

  it('never lets semantic review upgrade deterministic partial support', async () => {
    const semanticVerifier = new GroundingVerifier({
      review() {
        return Promise.resolve([
          {
            claim_index: 0,
            support_status: 'SUPPORTED',
            support_score: 1,
          },
        ]);
      },
    });
    const claim = '北京基地年发电量达到300兆瓦时。';
    const span = '上海基地年发电量达到300兆瓦时';

    const result = await semanticVerifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: true,
      targeted_revision_attempts: 1,
    });

    expect(result.decision).toBe('WAITING_MATERIAL');
    expectLegacyCapped(result.claims);
  });

  it.each([
    ['thousands separator', '装机容量为1,000 MW。', '装机容量为1000 MW'],
    ['SI power conversion', '装机容量为0.3 GW。', '装机容量为300 MW'],
    [
      'compound Chinese energy',
      '年发电量为1.2亿千瓦时。',
      '年发电量为一亿二千万千瓦时',
    ],
    ['month/year conversion', '建设周期为12个月。', '建设周期为1年'],
    ['percentage conversion', '完成比例为50%。', '完成比例为百分之五十'],
    ['double negation', '系统可以运行。', '系统并非不能运行'],
    ['signed decimal', '环境温度为-2.5度。', '环境温度为负二点五度'],
  ])(
    'deterministically supports equivalent %s expressions',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    ['different SI power', '装机容量为0.3 GW。', '装机容量为30 MW'],
    ['different duration', '建设周期为12个月。', '建设周期为2年'],
    ['different percentage', '完成比例为50%。', '完成比例为百分之五'],
    ['single negation', '系统可以运行。', '系统不能运行'],
    ['different signed decimal', '环境温度为-2.5度。', '环境温度为2.5度'],
  ])('rejects non-equivalent %s expressions', async (_label, claim, span) => {
    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: false,
    });

    expectLegacyCapped(result.claims);
  });

  it.each([
    [
      'swapped subjects and polarity',
      '甲系统可以运行但乙系统不能运行。',
      '甲系统不能运行但乙系统可以运行',
    ],
    ['longer duration', '建设周期为1年。', '建设周期为1年半'],
    ['lower-bounded duration', '建设周期为1年。', '建设周期为1年以上'],
    ['lower-bounded ratio', '完成比例为50%。', '完成比例为50%以上'],
    ['partial completion', '项目已完成。', '项目已完成一半'],
  ])(
    'never treats a substring or clause-wide negation parity as support: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    ['并网 is an entity term', '并网容量为300MW。', '网容量为300MW'],
    [
      '和田 is a place name',
      '和田基地装机容量为300MW。',
      '田基地装机容量为300MW',
    ],
    ['与会 is an entity term', '与会人数为300。', '会人数为300'],
    ['及格 is an entity term', '及格率为90%。', '格率为90%'],
    ['internal 并网 term', '项目并网容量为300MW。', '项目，网容量为300MW'],
  ])(
    'does not delete a coordinator character from an entity: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    [
      'swapped quantities joined by 和',
      '甲容量为300MW和乙容量为400MW。',
      '甲容量为400MW和乙容量为300MW',
    ],
    [
      'swapped polarity joined by 和',
      '甲系统可以运行和乙系统不能运行。',
      '甲系统不能运行和乙系统可以运行',
    ],
    [
      'swapped quantities joined by 与',
      '甲容量为300MW与乙容量为400MW。',
      '甲容量为400MW与乙容量为300MW',
    ],
    [
      'swapped polarity joined by 及',
      '甲系统可以运行及乙系统不能运行。',
      '甲系统不能运行及乙系统可以运行',
    ],
    [
      'not all is not all negative',
      '不是所有系统都可以运行。',
      '所有系统都不能运行',
    ],
    [
      'not all damaged is not none damaged',
      '并非所有设备都损坏。',
      '所有设备都没有损坏',
    ],
    ['not none is not none', '并非没有任何设备损坏。', '没有任何设备损坏'],
  ])(
    'binds coordinated subjects and quantified negation instead of treating terms as bags: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    [
      'reordered 和/与 clauses',
      '甲容量为300MW和乙容量为400MW。',
      '乙容量为400MW与甲容量为300MW',
    ],
    [
      'omitted value predicate',
      '甲容量为300MW和乙容量400MW。',
      '甲容量为300MW与乙容量为400MW',
    ],
    [
      'predicate synonym with reordered clauses',
      '甲系统能够运行以及乙系统不能运行。',
      '乙系统不能运行与甲系统可以运行',
    ],
    ['not-all synonym', '并非全部设备都损坏。', '不是所有设备都损坏'],
    ['not-none synonym', '并非没有任何设备损坏。', '不是没有设备损坏'],
  ])(
    'supports coordinated propositions only when every subject mapping agrees: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it('fails closed as partial when a quantified negation scope is not modeled', async () => {
    const claim = '并非部分设备损坏。';
    const span = '部分设备损坏';

    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: false,
    });

    expect(result.claims[0]).toMatchObject({
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
    });
  });

  it.each([
    ['at least before 为', '装机容量至少为300MW。', '装机容量为400MW'],
    ['at most before 为', '装机容量至多为300MW。', '装机容量为200MW'],
    ['not below', '装机容量不低于300MW。', '装机容量为400MW'],
    ['not above', '装机容量不高于300MW。', '装机容量为200MW'],
    ['not less than', '装机容量不少于300MW。', '装机容量为400MW'],
    ['not exceeding', '装机容量不超过300MW。', '装机容量为200MW'],
    ['greater than', '装机容量超过300MW。', '装机容量为400MW'],
    ['lower than', '装机容量低于300MW。', '装机容量为200MW'],
    [
      'equivalent strict lower bound',
      '装机容量超过300MW。',
      '装机容量大于300MW',
    ],
    [
      'equivalent strict upper bound',
      '装机容量低于300MW。',
      '装机容量小于300MW',
    ],
    ['approximately equal', '装机容量约等于300MW。', '装机容量为300MW'],
    ['compatible lower bounds', '装机容量至少为300MW。', '装机容量不低于400MW'],
  ])(
    'supports compatible comparator wording: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    ['at least conflict', '装机容量至少为300MW。', '装机容量为299MW'],
    ['at most conflict', '装机容量至多为300MW。', '装机容量为301MW'],
    ['strict greater conflict', '装机容量超过300MW。', '装机容量为300MW'],
    ['strict lower conflict', '装机容量低于300MW。', '装机容量为300MW'],
    ['weaker strict lower bound', '装机容量超过300MW。', '装机容量大于299MW'],
    ['weaker strict upper bound', '装机容量低于300MW。', '装机容量小于301MW'],
    [
      'inclusive lower equality boundary',
      '装机容量超过300MW。',
      '装机容量不低于300MW',
    ],
    [
      'inclusive upper equality boundary',
      '装机容量低于300MW。',
      '装机容量不高于300MW',
    ],
    ['approximate conflict', '装机容量约等于300MW。', '装机容量为310MW'],
    [
      'incompatible lower bounds',
      '装机容量至少为300MW。',
      '装机容量不少于200MW',
    ],
  ])(
    'rejects incompatible comparator wording: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it.each([
    ['predicate synonym', '系统能够运行。', '系统可以运行'],
    ['money large unit', '投资额为1.23亿元。', '投资额为一亿二千三百万元'],
    ['mixed power multiplier', '装机容量为30 MW。', '装机容量为3万kW'],
    [
      'mixed energy multiplier',
      '年发电量为1.2亿kWh。',
      '年发电量为一亿二千万千瓦时',
    ],
    ['ratio scalar', '完成比例为50%。', '完成比例为0.5'],
  ])(
    'supports subject-bound equivalent proposition expressions: %s',
    async (_label, claim, span) => {
      const result = await verifier.verify({
        workflow_job_id: 'job-1',
        project_id: 'project-1',
        retrieval_run_id: 'run-1',
        output: `${claim}\n<!-- claim_evidence:${JSON.stringify({
          claim_text: claim,
          evidence_ids: ['evidence:chunk-1'],
        })} -->`,
        evidence: [
          evidence({
            content: span,
            exact_span_text: span,
            chunk_char_start: 0,
            exact_span_document_start: 0,
            exact_span_document_end: span.length,
          }),
        ],
        strict: true,
        targeted_revision_attempts: 1,
      });

      expect(result.decision).toBe('WAITING_MATERIAL');
      expectLegacyCapped(result.claims);
    },
  );

  it('treats fenced control lines and headings as structure while grounding code facts', async () => {
    const claim = '装机容量为 300 MW。';
    const output =
      '# 第一章 项目概况\n' +
      '```text\n' +
      `${claim}\n` +
      `<!-- claim_evidence:${JSON.stringify({
        claim_text: claim,
        evidence_ids: ['evidence:chunk-1'],
      })} -->\n` +
      '```';

    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [evidence()],
      strict: true,
    });

    expect(result.decision).toBe('TARGETED_RETRIEVAL_REVISION');
    expectLegacyCapped(result.claims);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].claim_text).toBe(claim);
  });

  it('requires markers for factual table rows but not table headers', async () => {
    const row = '| 装机容量 | 300 MW |';
    const output =
      '| 指标 | 数值 |\n' +
      '| --- | --- |\n' +
      `${row}\n` +
      `<!-- claim_evidence:${JSON.stringify({
        claim_text: row,
        evidence_ids: ['evidence:chunk-1'],
      })} -->`;
    const span = '装机容量 300 MW';

    const result = await verifier.verify({
      workflow_job_id: 'job-1',
      project_id: 'project-1',
      retrieval_run_id: 'run-1',
      output,
      evidence: [
        evidence({
          content: span,
          exact_span_text: span,
          chunk_char_start: 0,
          exact_span_document_start: 0,
          exact_span_document_end: span.length,
        }),
      ],
      strict: true,
    });

    expect(result.decision).toBe('TARGETED_RETRIEVAL_REVISION');
    expectLegacyCapped(result.claims);
    expect(result.claims.map((item) => item.claim_text)).toEqual([row]);
  });
});
