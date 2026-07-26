import type { ClaimSupportStatus } from './grounding-verifier.js';
import {
  ATOMIC_CANONICALIZER_VERSION,
  ATOMIC_VERIFIER_VERSION,
  CANONICAL_ATOMIC_CLAIM_VERSION,
  QUANTITY_LEXER_VERSION,
  type CanonicalAtomicClaimV1,
} from './atomic-grounding/contracts.js';

export interface PersistedAtomicClaimV1 {
  canonicalizer_version: typeof ATOMIC_CANONICALIZER_VERSION;
  quantity_lexer_version: typeof QUANTITY_LEXER_VERSION;
  verifier_version: typeof ATOMIC_VERIFIER_VERSION;
  canonical_claim: CanonicalAtomicClaimV1;
}

export interface PersistedGroundingReadInput {
  contract_version: unknown;
  atomic_claim: unknown;
  support_status: unknown;
  support_score: unknown;
  verification_method: unknown;
}

export interface PersistedGroundingReadVerdict {
  support_status: ClaimSupportStatus;
  support_score: number;
  verification_method: string;
}

const CAPPED_VERDICT: PersistedGroundingReadVerdict = {
  support_status: 'UNVERIFIABLE',
  support_score: 0,
  verification_method: 'legacy_unverifiable',
};

const ALLOWED_ATOMIC_METHODS = [
  'atomic_extract_exact',
  'atomic_typed_equivalent',
] as const;

export function capPersistedGroundingForRead(
  input: PersistedGroundingReadInput,
): PersistedGroundingReadVerdict {
  const method = input.verification_method;
  if (
    input.contract_version !== 'atomic:v1' ||
    input.support_status !== 'SUPPORTED' ||
    input.support_score !== 1 ||
    !ALLOWED_ATOMIC_METHODS.includes(
      method as (typeof ALLOWED_ATOMIC_METHODS)[number],
    ) ||
    !isPersistedAtomicClaimV1(input.atomic_claim)
  ) {
    return { ...CAPPED_VERDICT };
  }
  return {
    support_status: 'SUPPORTED',
    support_score: 1,
    verification_method: method as (typeof ALLOWED_ATOMIC_METHODS)[number],
  };
}

function isPersistedAtomicClaimV1(value: unknown): boolean {
  const parsed = parseJson(value);
  if (
    !hasExactKeys(parsed, [
      'canonicalizer_version',
      'quantity_lexer_version',
      'verifier_version',
      'canonical_claim',
    ])
  ) {
    return false;
  }
  return (
    parsed.canonicalizer_version === ATOMIC_CANONICALIZER_VERSION &&
    parsed.quantity_lexer_version === QUANTITY_LEXER_VERSION &&
    parsed.verifier_version === ATOMIC_VERIFIER_VERSION &&
    isCanonicalAtomicClaimV1(parsed.canonical_claim)
  );
}

function isCanonicalAtomicClaimV1(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      'canonical_claim_version',
      'candidate_claim_key',
      'source_claim_text_nfc',
      'rendered_claim_text',
      'subject_anchor',
      'predicate_anchor',
      'polarity',
      'quantifier',
      'quantities',
      'evidence_ids',
      'fragment',
      'revision',
    ])
  ) {
    return false;
  }
  if (
    value.canonical_claim_version !== CANONICAL_ATOMIC_CLAIM_VERSION ||
    !isString(value.candidate_claim_key) ||
    !isString(value.source_claim_text_nfc) ||
    !isString(value.rendered_claim_text) ||
    !isAnchor(value.subject_anchor) ||
    !isAnchor(value.predicate_anchor) ||
    !includes(['affirmed', 'negated'] as const, value.polarity) ||
    !includes(
      ['plain', 'all', 'none', 'not_all', 'not_none', 'some', 'other'] as const,
      value.quantifier,
    ) ||
    !Array.isArray(value.quantities) ||
    !value.quantities.every(isQuantity) ||
    !Array.isArray(value.evidence_ids) ||
    !value.evidence_ids.every(isString) ||
    !hasExactKeys(value.fragment, [
      'ordinal',
      'presentation',
      'previous_structure_id',
      'next_structure_id',
    ]) ||
    !isInteger(value.fragment.ordinal) ||
    !includes(
      ['sentence', 'bullet', 'ordered_item'] as const,
      value.fragment.presentation,
    ) ||
    !isNullableString(value.fragment.previous_structure_id) ||
    !isNullableString(value.fragment.next_structure_id) ||
    !hasExactKeys(value.revision, [
      'attempt',
      'revision_of_candidate_claim_key',
    ]) ||
    (value.revision.attempt !== 0 && value.revision.attempt !== 1) ||
    !isNullableString(value.revision.revision_of_candidate_claim_key)
  ) {
    return false;
  }
  return true;
}

function isAnchor(value: unknown): boolean {
  return (
    hasExactKeys(value, ['surface_nfc', 'start_utf16', 'end_utf16']) &&
    isString(value.surface_nfc) &&
    isInteger(value.start_utf16) &&
    isInteger(value.end_utf16)
  );
}

function isQuantity(value: unknown): boolean {
  return (
    hasExactKeys(value, [
      'ordinal',
      'surface_nfc',
      'start_utf16',
      'end_utf16',
      'dimension',
      'base_value',
      'base_unit',
      'comparator',
      'range_end_base_value',
      'typed_equivalence_eligible',
    ]) &&
    isInteger(value.ordinal) &&
    isString(value.surface_nfc) &&
    isInteger(value.start_utf16) &&
    isInteger(value.end_utf16) &&
    includes(
      [
        'count',
        'ratio',
        'duration',
        'power',
        'energy',
        'currency',
        'length',
        'mass',
        'temperature',
        'other',
      ] as const,
      value.dimension,
    ) &&
    isString(value.base_value) &&
    isNullableString(value.base_unit) &&
    includes(
      ['eq', 'gt', 'gte', 'lt', 'lte', 'approx', 'range'] as const,
      value.comparator,
    ) &&
    isNullableString(value.range_end_base_value) &&
    typeof value.typed_equivalence_eligible === 'boolean'
  );
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hasExactKeys<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function includes<T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}
