import {
  capPersistedGroundingForRead,
  type PersistedAtomicClaimV1,
  type PersistedGroundingReadInput,
} from './grounding-read-policy.js';

const canonicalClaim = () => ({
  canonical_claim_version: 'canonical-atomic-claim.v1' as const,
  candidate_claim_key: 'candidate-1',
  source_claim_text_nfc: '装机容量为 300 MW',
  rendered_claim_text: '装机容量为 300 MW',
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
  evidence_ids: ['evidence:1'],
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
});

const atomicClaim = (): PersistedAtomicClaimV1 => ({
  canonicalizer_version: 'atomic-canonicalizer.v1',
  quantity_lexer_version: 'quantity-lexer.v1',
  verifier_version: 'atomic-verifier.v1',
  canonical_claim: canonicalClaim(),
});

const supportedRow = (
  overrides: Partial<PersistedGroundingReadInput> = {},
): PersistedGroundingReadInput => ({
  contract_version: 'atomic:v1',
  atomic_claim: atomicClaim(),
  support_status: 'SUPPORTED',
  support_score: 1,
  verification_method: 'atomic_extract_exact',
  ...overrides,
});

describe('capPersistedGroundingForRead', () => {
  it.each(['atomic_extract_exact', 'atomic_typed_equivalent'] as const)(
    'preserves a closed atomic SUPPORTED row for %s',
    (verificationMethod) => {
      expect(
        capPersistedGroundingForRead(
          supportedRow({ verification_method: verificationMethod }),
        ),
      ).toEqual({
        support_status: 'SUPPORTED',
        support_score: 1,
        verification_method: verificationMethod,
      });
    },
  );

  it.each([
    ['missing assignment join', { contract_version: null }],
    ['legacy assignment', { contract_version: 'legacy:v0' }],
    ['unknown assignment', { contract_version: 'future:v9' }],
    ['null atomic claim', { atomic_claim: null }],
    ['malformed atomic claim', { atomic_claim: '{bad json' }],
    [
      'unknown canonicalizer',
      {
        atomic_claim: {
          ...atomicClaim(),
          canonicalizer_version: 'atomic-canonicalizer.v9',
        },
      },
    ],
    [
      'unknown quantity lexer',
      {
        atomic_claim: {
          ...atomicClaim(),
          quantity_lexer_version: 'quantity-lexer.v9',
        },
      },
    ],
    [
      'unknown verifier',
      {
        atomic_claim: {
          ...atomicClaim(),
          verifier_version: 'atomic-verifier.v9',
        },
      },
    ],
    [
      'unknown canonical claim',
      {
        atomic_claim: {
          ...atomicClaim(),
          canonical_claim: {
            ...canonicalClaim(),
            canonical_claim_version: 'canonical-atomic-claim.v9',
          },
        },
      },
    ],
    [
      'open atomic envelope',
      { atomic_claim: { ...atomicClaim(), unreviewed: true } },
    ],
    [
      'open canonical claim',
      {
        atomic_claim: {
          ...atomicClaim(),
          canonical_claim: { ...canonicalClaim(), unreviewed: true },
        },
      },
    ],
    [
      'legacy verification method',
      { verification_method: 'deterministic_exact' },
    ],
    ['persisted partial row', { support_status: 'PARTIAL' }],
    ['string score', { support_score: '1' }],
    ['non-unit score', { support_score: 0.99 }],
  ] satisfies Array<[string, Partial<PersistedGroundingReadInput>]>)(
    'caps %s to legacy-unverifiable',
    (_label, overrides) => {
      expect(capPersistedGroundingForRead(supportedRow(overrides))).toEqual({
        support_status: 'UNVERIFIABLE',
        support_score: 0,
        verification_method: 'legacy_unverifiable',
      });
    },
  );
});
