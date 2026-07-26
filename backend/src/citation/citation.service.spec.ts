import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PublicCitationDto } from './dto/citation-response.dto.js';
import {
  buildPublicCitationLedger,
  CitationService,
} from './citation.service.js';
import type { PersistedAtomicClaimV1 } from './grounding-read-policy.js';

const persistedAtomicClaim = (): PersistedAtomicClaimV1 => ({
  canonicalizer_version: 'atomic-canonicalizer.v1',
  quantity_lexer_version: 'quantity-lexer.v1',
  verifier_version: 'atomic-verifier.v1',
  canonical_claim: {
    canonical_claim_version: 'canonical-atomic-claim.v1',
    candidate_claim_key: 'candidate-1',
    source_claim_text_nfc: '声明一',
    rendered_claim_text: '声明一',
    subject_anchor: { surface_nfc: '声明', start_utf16: 0, end_utf16: 2 },
    predicate_anchor: { surface_nfc: '一', start_utf16: 2, end_utf16: 3 },
    polarity: 'affirmed',
    quantifier: 'plain',
    quantities: [],
    evidence_ids: ['evidence-1'],
    fragment: {
      ordinal: 0,
      presentation: 'sentence',
      previous_structure_id: null,
      next_structure_id: null,
    },
    revision: {
      attempt: 0,
      revision_of_candidate_claim_key: null,
    },
  },
});

const persistedCitationEntity = () => ({
  id: 'citation-1',
  claim_id: 'claim-1',
  evidence_id: 'evidence-1',
  chunk_id: 'chunk-1',
  file_id: 'file-1',
  evidence_text: '证据',
  support_status: 'SUPPORTED',
  support_score: 1,
  verification_method: 'atomic_extract_exact',
  evidence_char_start: 10,
  evidence_char_end: 12,
  chunk_char_start: 0,
  chunk_char_end: 2,
  candidate_rank: 1,
  sparse_rank: 1,
  dense_rank: 1,
  fusion_rank: 1,
  rerank_rank: 1,
  sparse_score: 1,
  dense_score: 1,
  fusion_score: 1,
  rerank_score: 1,
  page_number: 2,
  section_title: '第一章',
  created_at: new Date('2026-01-01T00:00:00Z'),
});

const persistedCitationRaw = (overrides: Record<string, unknown> = {}) => ({
  file_name: '教材.pdf',
  file_type: 'pdf',
  claim_text: '声明一',
  output_char_start: 5,
  output_char_end: 8,
  page_start: 2,
  page_end: 2,
  heading_path: '["第一章"]',
  contract_version: 'atomic:v1',
  atomic_claim: persistedAtomicClaim(),
  ...overrides,
});

describe('CitationService result ownership', () => {
  const createService = (
    resultRows: unknown[],
    policyError?: Error,
  ): {
    service: CitationService;
    queryBuilder: { getRawAndEntities: jest.Mock };
    stateRepo: { findOne: jest.Mock; save: jest.Mock };
  } => {
    const queryBuilder = {
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawAndEntities: jest.fn().mockResolvedValue({ raw: [], entities: [] }),
    };
    const citationRepo = {
      manager: { query: jest.fn().mockResolvedValue(resultRows) },
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const stateRepo = {
      findOne: jest.fn().mockResolvedValue({
        project_id: 'project-1',
        material_gaps: [],
      }),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
    };
    const policy = {
      assertOwner: jest.fn(() =>
        policyError ? Promise.reject(policyError) : Promise.resolve(),
      ),
    };
    return {
      service: new CitationService(
        citationRepo as never,
        stateRepo as never,
        policy as never,
      ),
      queryBuilder,
      stateRepo,
    };
  };

  it('returns 404 before citation lookup for a missing or foreign result', async () => {
    const { service, queryBuilder } = createService([]);

    await expect(
      service.getCitationsByResultId('user-1', 'project-1', 'result-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.markMaterialGap('user-1', 'project-1', 'result-2', '缺素材'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queryBuilder.getRawAndEntities).not.toHaveBeenCalled();
  });

  it('returns 403 for a foreign project before probing result ids', async () => {
    const { service } = createService(
      [],
      new ForbiddenException('无权访问该项目'),
    );

    await expect(
      service.getCitationsByResultId('user-2', 'project-1', 'result-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows result-scoped citation lookup and material-gap writes', async () => {
    const { service, stateRepo } = createService([{ id: 'result-1' }]);

    await expect(
      service.getCitationsByResultId('user-1', 'project-1', 'result-1'),
    ).resolves.toEqual([]);
    await expect(
      service.markMaterialGap('user-1', 'project-1', 'result-1', '缺素材'),
    ).resolves.toMatchObject({
      material_gaps: [
        expect.objectContaining({
          result_id: 'result-1',
          reason: '缺素材',
        }),
      ],
    });
    expect(stateRepo.save).toHaveBeenCalledTimes(1);
  });

  it('preserves public fields while exposing a closed atomic SUPPORTED row', async () => {
    const { service, queryBuilder } = createService([{ id: 'result-1' }]);
    queryBuilder.getRawAndEntities.mockResolvedValue({
      raw: [persistedCitationRaw()],
      entities: [persistedCitationEntity()],
    });

    await expect(
      service.getCitationsByResultId('user-1', 'project-1', 'result-1'),
    ).resolves.toEqual([
      expect.objectContaining({
        claim_id: 'claim-1',
        claim_text: '声明一',
        evidence_id: 'evidence-1',
        support_status: 'SUPPORTED',
        support_score: 1,
        verification_method: 'atomic_extract_exact',
        page_start: 2,
        heading_path: ['第一章'],
      }),
    ]);
    expect(queryBuilder.leftJoin).toHaveBeenCalledWith(
      'grounding_assignments',
      'ga',
      expect.stringContaining('ga.workflow_job_id = gc.workflow_job_id'),
    );
  });

  it.each([
    ['missing assignment', { contract_version: null }],
    ['legacy assignment', { contract_version: 'legacy:v0' }],
    ['missing atomic claim', { atomic_claim: null }],
    [
      'unknown verifier',
      {
        atomic_claim: {
          ...persistedAtomicClaim(),
          verifier_version: 'atomic-verifier.v9',
        },
      },
    ],
  ])('caps persisted support for %s', async (_label, rawOverrides) => {
    const { service, queryBuilder } = createService([{ id: 'result-1' }]);
    queryBuilder.getRawAndEntities.mockResolvedValue({
      raw: [persistedCitationRaw(rawOverrides)],
      entities: [persistedCitationEntity()],
    });

    const citations = await service.getCitationsByResultId(
      'user-1',
      'project-1',
      'result-1',
    );

    expect(citations[0]).toMatchObject({
      claim_id: 'claim-1',
      claim_text: '声明一',
      evidence_id: 'evidence-1',
      support_status: 'UNVERIFIABLE',
      support_score: 0,
      verification_method: 'legacy_unverifiable',
      page_start: 2,
      heading_path: ['第一章'],
    });
  });

  it('renders a safe GB/T ledger with stable source dedupe and claim links', () => {
    const base: PublicCitationDto = {
      id: 'citation-1',
      claim_id: 'claim-1',
      claim_text: '声明一',
      output_char_start: 5,
      output_char_end: 8,
      evidence_id: 'evidence-1',
      chunk_id: 'chunk-1',
      file_id: 'file-1',
      file_name: '教材.pdf',
      file_type: 'pdf',
      evidence_text: '证据',
      support_status: 'SUPPORTED',
      support_score: 1,
      verification_method: 'deterministic_exact',
      evidence_char_start: 10,
      evidence_char_end: 12,
      chunk_char_start: 0,
      chunk_char_end: 2,
      candidate_rank: 1,
      scores: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
      ranks: { sparse: 1, dense: 1, fusion: 1, rerank: 1 },
      page_start: 2,
      page_end: 2,
      heading_path: ['第一章'],
      reference_text: 'legacy',
      created_at: new Date('2026-01-01T00:00:00Z'),
    };

    const ledger = buildPublicCitationLedger([
      { ...base, id: 'citation-2', claim_id: 'claim-2', output_char_start: 20 },
      base,
    ]);

    expect(ledger.references).toEqual([
      expect.objectContaining({ number: 1, file_id: 'file-1' }),
    ]);
    expect(ledger.claim_links).toEqual([
      { claim_id: 'claim-1', reference_number: 1 },
      { claim_id: 'claim-2', reference_number: 1 },
    ]);
    expect(
      ledger.citations.every((citation) => citation.reference_number === 1),
    ).toBe(true);
    expect(ledger).not.toHaveProperty('retrieval_run_id');
    expect(ledger).not.toHaveProperty('index_snapshot');
  });
});
