import type { StructuredOutputSchema } from '../../llm/model-types.js';
import {
  GROUNDED_DRAFT_SCHEMA_VERSION,
  type AtomicClaimProposal,
  type GroundedDraftProposal,
  type MaterialGapReason,
  type Polarity,
  type Quantifier,
  type QuantityProposal,
  type RenderFragmentProposal,
  type SurfaceAnchorProposal,
} from './contracts.js';
import { isWellFormedUnicodeScalarV1 } from './well-formed-unicode.js';

const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_CLAIMS = 500;
const MAX_RENDER_FRAGMENTS = 2_000;
const MAX_NESTED_ITEMS = 256;
const MAX_EVIDENCE_IDS = 3;
const MAX_CLAIM_TEXT_BYTES = 1_000;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

const polarities = ['affirmed', 'negated'] as const;
const quantifiers = [
  'plain',
  'all',
  'none',
  'not_all',
  'not_none',
  'some',
  'other',
] as const;
const comparators = [
  'eq',
  'gt',
  'gte',
  'lt',
  'lte',
  'approx',
  'range',
] as const;
const dimensions = [
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
] as const;
const materialGapReasons = [
  'NO_EVIDENCE',
  'INSUFFICIENT_EVIDENCE',
  'AMBIGUOUS_EVIDENCE',
  'UNSUPPORTED_QUANTIFIER',
] as const;

const stringSchema = { type: 'string' } as const;
const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: SAFE_ID.source,
} as const;
const offsetSchema = {
  type: 'integer',
  minimum: 0,
  maximum: 4 * 1024 * 1024,
} as const;
const anchorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['surface', 'start_utf16', 'end_utf16'],
  properties: {
    surface: { type: 'string', minLength: 1 },
    start_utf16: offsetSchema,
    end_utf16: offsetSchema,
  },
} as const;
const quantitySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'quantity_id',
    'surface',
    'start_utf16',
    'end_utf16',
    'dimension',
    'value',
    'unit',
    'comparator',
    'range_end',
  ],
  properties: {
    quantity_id: idSchema,
    surface: { type: 'string', minLength: 1 },
    start_utf16: offsetSchema,
    end_utf16: offsetSchema,
    dimension: { type: 'string', enum: dimensions },
    value: { type: 'string', pattern: DECIMAL.source },
    unit: { oneOf: [stringSchema, { type: 'null' }] },
    comparator: { type: 'string', enum: comparators },
    range_end: {
      oneOf: [{ type: 'string', pattern: DECIMAL.source }, { type: 'null' }],
    },
  },
} as const;
const claimSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'proposal_claim_id',
    'revision_of_candidate_claim_key',
    'claim_text',
    'span',
    'subject',
    'predicate',
    'polarity',
    'quantifier',
    'quantities',
    'evidence_ids',
  ],
  properties: {
    proposal_claim_id: idSchema,
    revision_of_candidate_claim_key: {
      oneOf: [idSchema, { type: 'null' }],
    },
    claim_text: { type: 'string', minLength: 1, maxLength: 1_000 },
    span: {
      type: 'object',
      additionalProperties: false,
      required: ['fragment_id', 'start_utf16', 'end_utf16'],
      properties: {
        fragment_id: idSchema,
        start_utf16: { const: 0 },
        end_utf16: offsetSchema,
      },
    },
    subject: anchorSchema,
    predicate: anchorSchema,
    polarity: { type: 'string', enum: polarities },
    quantifier: { type: 'string', enum: quantifiers },
    quantities: {
      type: 'array',
      maxItems: MAX_NESTED_ITEMS,
      items: quantitySchema,
    },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_EVIDENCE_IDS,
      uniqueItems: true,
      items: idSchema,
    },
  },
} as const;
const fragmentSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['fragment_id', 'kind', 'claim_id', 'presentation'],
      properties: {
        fragment_id: idSchema,
        kind: { const: 'claim_ref' },
        claim_id: idSchema,
        presentation: {
          type: 'string',
          enum: ['sentence', 'bullet', 'ordered_item'],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['fragment_id', 'kind', 'structure_id', 'presentation'],
      properties: {
        fragment_id: idSchema,
        kind: { const: 'structure_ref' },
        structure_id: idSchema,
        presentation: {
          type: 'string',
          enum: ['heading_1', 'heading_2', 'heading_3', 'column'],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['fragment_id', 'kind', 'token'],
      properties: {
        fragment_id: idSchema,
        kind: { const: 'separator' },
        token: {
          type: 'string',
          enum: ['space', 'line_break', 'paragraph_break'],
        },
      },
    },
  ],
} as const;
const materialGapSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason_code', 'missing_topics'],
  properties: {
    reason_code: { type: 'string', enum: materialGapReasons },
    missing_topics: {
      type: 'array',
      maxItems: MAX_NESTED_ITEMS,
      items: stringSchema,
    },
  },
} as const;

const groundedDraftJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'status',
    'claims',
    'render_fragments',
    'ordering',
    'material_gap',
  ],
  properties: {
    schema_version: { const: GROUNDED_DRAFT_SCHEMA_VERSION },
    status: { type: 'string', enum: ['draft', 'material_gap'] },
    claims: {
      type: 'array',
      maxItems: MAX_CLAIMS,
      items: claimSchema,
    },
    render_fragments: {
      type: 'array',
      maxItems: MAX_RENDER_FRAGMENTS,
      items: fragmentSchema,
    },
    ordering: {
      type: 'array',
      maxItems: MAX_RENDER_FRAGMENTS,
      uniqueItems: true,
      items: idSchema,
    },
    material_gap: { oneOf: [{ type: 'null' }, materialGapSchema] },
  },
  allOf: [
    {
      if: { properties: { status: { const: 'draft' } } },
      then: {
        properties: {
          claims: { minItems: 1 },
          render_fragments: { minItems: 1 },
          ordering: { minItems: 1 },
          material_gap: { type: 'null' },
        },
      },
    },
    {
      if: { properties: { status: { const: 'material_gap' } } },
      then: {
        properties: {
          claims: { maxItems: 0 },
          render_fragments: { maxItems: 0 },
          ordering: { maxItems: 0 },
          material_gap: materialGapSchema,
        },
      },
    },
  ],
} as const;

function fail(message: string): never {
  throw new TypeError(`invalid grounded draft: ${message}`);
}

function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return fail(`${label} must be an object`);
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    return fail(`${label} has unknown or missing fields`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    !isWellFormedUnicodeScalarV1(value)
  ) {
    return fail(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
  return value.normalize('NFC');
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SAFE_ID.test(parsed)) return fail(`${label} is not a safe identifier`);
  return parsed;
}

function hasForbiddenClaimControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function claimText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_CLAIM_TEXT_BYTES
  ) {
    return fail(`${label} exceeds the UTF-8 byte limit`);
  }
  const parsed = text(value, label);
  if (hasForbiddenClaimControl(parsed) || parsed.includes('```')) {
    return fail(`${label} exceeds limits or contains forbidden bytes`);
  }
  return parsed;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return fail(`${label} is outside the closed enum`);
  }
  return value as T;
}

function array(value: unknown, limit: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    return fail(`${label} must be a bounded array`);
  }
  return value;
}

function decimal(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!DECIMAL.test(parsed)) return fail(`${label} must be fixed decimal`);
  return parsed;
}

function parseAnchor(value: unknown, label: string): SurfaceAnchorProposal {
  const item = record(value, ['surface', 'start_utf16', 'end_utf16'], label);
  return {
    surface: text(item.surface, `${label}.surface`),
    start_utf16: integer(item.start_utf16, `${label}.start_utf16`),
    end_utf16: integer(item.end_utf16, `${label}.end_utf16`),
  };
}

function parseQuantity(value: unknown, label: string): QuantityProposal {
  const item = record(
    value,
    [
      'quantity_id',
      'surface',
      'start_utf16',
      'end_utf16',
      'dimension',
      'value',
      'unit',
      'comparator',
      'range_end',
    ],
    label,
  );
  const comparator = enumValue(
    item.comparator,
    comparators,
    `${label}.comparator`,
  );
  const rangeEnd =
    item.range_end === null
      ? null
      : decimal(item.range_end, `${label}.range_end`);
  if ((comparator === 'range') !== (rangeEnd !== null)) {
    return fail(`${label}.range_end does not match comparator`);
  }
  return {
    quantity_id: identifier(item.quantity_id, `${label}.quantity_id`),
    surface: text(item.surface, `${label}.surface`),
    start_utf16: integer(item.start_utf16, `${label}.start_utf16`),
    end_utf16: integer(item.end_utf16, `${label}.end_utf16`),
    dimension: enumValue(item.dimension, dimensions, `${label}.dimension`),
    value: decimal(item.value, `${label}.value`),
    unit: item.unit === null ? null : text(item.unit, `${label}.unit`),
    comparator,
    range_end: rangeEnd,
  };
}

function parseClaim(value: unknown, index: number): AtomicClaimProposal {
  const label = `claims[${index}]`;
  const item = record(
    value,
    [
      'proposal_claim_id',
      'revision_of_candidate_claim_key',
      'claim_text',
      'span',
      'subject',
      'predicate',
      'polarity',
      'quantifier',
      'quantities',
      'evidence_ids',
    ],
    label,
  );
  const span = record(
    item.span,
    ['fragment_id', 'start_utf16', 'end_utf16'],
    `${label}.span`,
  );
  const start = integer(span.start_utf16, `${label}.span.start_utf16`);
  if (start !== 0) return fail(`${label}.span.start_utf16 must be zero`);
  const quantities = array(
    item.quantities,
    MAX_NESTED_ITEMS,
    `${label}.quantities`,
  ).map((quantity, quantityIndex) =>
    parseQuantity(quantity, `${label}.quantities[${quantityIndex}]`),
  );
  const evidenceIds = array(
    item.evidence_ids,
    MAX_EVIDENCE_IDS,
    `${label}.evidence_ids`,
  ).map((id, evidenceIndex) =>
    identifier(id, `${label}.evidence_ids[${evidenceIndex}]`),
  );
  if (evidenceIds.length === 0) return fail(`${label}.evidence_ids is empty`);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    return fail(`${label}.evidence_ids contains duplicates`);
  }
  return {
    proposal_claim_id: identifier(
      item.proposal_claim_id,
      `${label}.proposal_claim_id`,
    ),
    revision_of_candidate_claim_key:
      item.revision_of_candidate_claim_key === null
        ? null
        : identifier(
            item.revision_of_candidate_claim_key,
            `${label}.revision_of_candidate_claim_key`,
          ),
    claim_text: claimText(item.claim_text, `${label}.claim_text`),
    span: {
      fragment_id: identifier(span.fragment_id, `${label}.span.fragment_id`),
      start_utf16: 0,
      end_utf16: integer(span.end_utf16, `${label}.span.end_utf16`),
    },
    subject: parseAnchor(item.subject, `${label}.subject`),
    predicate: parseAnchor(item.predicate, `${label}.predicate`),
    polarity: enumValue(
      item.polarity,
      polarities,
      `${label}.polarity`,
    ) as Polarity,
    quantifier: enumValue(
      item.quantifier,
      quantifiers,
      `${label}.quantifier`,
    ) as Quantifier,
    quantities,
    evidence_ids: evidenceIds.sort(),
  };
}

function parseFragment(value: unknown, index: number): RenderFragmentProposal {
  const label = `render_fragments[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'claim_ref') {
    const item = record(
      value,
      ['fragment_id', 'kind', 'claim_id', 'presentation'],
      label,
    );
    return {
      fragment_id: identifier(item.fragment_id, `${label}.fragment_id`),
      kind,
      claim_id: identifier(item.claim_id, `${label}.claim_id`),
      presentation: enumValue(
        item.presentation,
        ['sentence', 'bullet', 'ordered_item'] as const,
        `${label}.presentation`,
      ),
    };
  }
  if (kind === 'structure_ref') {
    const item = record(
      value,
      ['fragment_id', 'kind', 'structure_id', 'presentation'],
      label,
    );
    return {
      fragment_id: identifier(item.fragment_id, `${label}.fragment_id`),
      kind,
      structure_id: identifier(item.structure_id, `${label}.structure_id`),
      presentation: enumValue(
        item.presentation,
        ['heading_1', 'heading_2', 'heading_3', 'column'] as const,
        `${label}.presentation`,
      ),
    };
  }
  if (kind === 'separator') {
    const item = record(value, ['fragment_id', 'kind', 'token'], label);
    return {
      fragment_id: identifier(item.fragment_id, `${label}.fragment_id`),
      kind,
      token: enumValue(
        item.token,
        ['space', 'line_break', 'paragraph_break'] as const,
        `${label}.token`,
      ),
    };
  }
  return fail(`${label}.kind is outside the closed union`);
}

function assertProposalUtf8Bytes(value: unknown, limit: number): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('proposal is not JSON serializable');
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > limit
  ) {
    fail('proposal exceeds the UTF-8 byte limit');
  }
}

function parseClosedProposalObject(value: unknown): GroundedDraftProposal {
  const item = record(
    value,
    [
      'schema_version',
      'status',
      'claims',
      'render_fragments',
      'ordering',
      'material_gap',
    ],
    'proposal',
  );
  if (item.schema_version !== GROUNDED_DRAFT_SCHEMA_VERSION) {
    return fail('schema_version is not allowlisted');
  }
  const status = enumValue(
    item.status,
    ['draft', 'material_gap'] as const,
    'status',
  );
  const claims = array(item.claims, MAX_CLAIMS, 'claims').map(parseClaim);
  const renderFragments = array(
    item.render_fragments,
    MAX_RENDER_FRAGMENTS,
    'render_fragments',
  ).map(parseFragment);
  const ordering = array(item.ordering, MAX_RENDER_FRAGMENTS, 'ordering').map(
    (id, index) => identifier(id, `ordering[${index}]`),
  );
  let materialGap: GroundedDraftProposal['material_gap'] = null;
  if (item.material_gap !== null) {
    const gap = record(
      item.material_gap,
      ['reason_code', 'missing_topics'],
      'material_gap',
    );
    materialGap = {
      reason_code: enumValue(
        gap.reason_code,
        materialGapReasons,
        'material_gap.reason_code',
      ) as MaterialGapReason,
      missing_topics: array(
        gap.missing_topics,
        MAX_NESTED_ITEMS,
        'material_gap.missing_topics',
      ).map((topic, index) =>
        text(topic, `material_gap.missing_topics[${index}]`, true),
      ),
    };
  }
  if (
    status === 'material_gap' &&
    (claims.length !== 0 ||
      renderFragments.length !== 0 ||
      ordering.length !== 0 ||
      materialGap === null)
  ) {
    return fail('material_gap status has draft content or no gap');
  }
  if (
    status === 'draft' &&
    (claims.length === 0 ||
      renderFragments.length === 0 ||
      ordering.length === 0 ||
      materialGap !== null)
  ) {
    return fail('draft status is empty or contains a material gap');
  }
  return {
    schema_version: GROUNDED_DRAFT_SCHEMA_VERSION,
    status,
    claims,
    render_fragments: renderFragments,
    ordering,
    material_gap: materialGap,
  };
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    fail(`${label} contains duplicates`);
}

function assertUniqueIdsAndClosedRenderGraph(
  draft: GroundedDraftProposal,
): void {
  assertUnique(
    draft.claims.map((claim) => claim.proposal_claim_id),
    'proposal claim IDs',
  );
  assertUnique(
    draft.render_fragments.map((fragment) => fragment.fragment_id),
    'fragment IDs',
  );
  assertUnique(draft.ordering, 'ordering');
  const fragmentIds = new Set(
    draft.render_fragments.map((fragment) => fragment.fragment_id),
  );
  if (
    draft.ordering.length !== fragmentIds.size ||
    draft.ordering.some((id) => !fragmentIds.has(id))
  ) {
    fail('ordering must contain every fragment exactly once');
  }
  const claims = new Map(
    draft.claims.map((claim) => [claim.proposal_claim_id, claim]),
  );
  const counts = new Map<string, number>();
  for (const fragment of draft.render_fragments) {
    if (fragment.kind !== 'claim_ref') continue;
    const claim = claims.get(fragment.claim_id);
    if (!claim || claim.span.fragment_id !== fragment.fragment_id) {
      fail('claim_ref is dangling or disagrees with claim span');
    }
    counts.set(fragment.claim_id, (counts.get(fragment.claim_id) ?? 0) + 1);
  }
  for (const claim of draft.claims) {
    if (counts.get(claim.proposal_claim_id) !== 1) {
      fail('each claim must have exactly one claim_ref');
    }
  }
}

function exactAnchor(
  claimText: string,
  anchor: SurfaceAnchorProposal,
  label: string,
): void {
  if (
    anchor.start_utf16 >= anchor.end_utf16 ||
    anchor.end_utf16 > claimText.length ||
    claimText.slice(anchor.start_utf16, anchor.end_utf16) !== anchor.surface
  ) {
    fail(`${label} does not exactly anchor claim_text`);
  }
}

function assertClaimSpansAndAnchors(draft: GroundedDraftProposal): void {
  for (const claim of draft.claims) {
    if (claim.span.end_utf16 !== claim.claim_text.length) {
      fail('claim span must occupy its entire fragment');
    }
    exactAnchor(claim.claim_text, claim.subject, 'subject');
    exactAnchor(claim.claim_text, claim.predicate, 'predicate');
    if (
      claim.subject.start_utf16 < claim.predicate.end_utf16 &&
      claim.subject.end_utf16 > claim.predicate.start_utf16
    ) {
      fail('subject and predicate anchors overlap');
    }
    assertUnique(
      claim.quantities.map((quantity) => quantity.quantity_id),
      'quantity IDs',
    );
    let previousEnd = -1;
    const sorted = [...claim.quantities].sort(
      (left, right) => left.start_utf16 - right.start_utf16,
    );
    for (const quantity of sorted) {
      if (
        quantity.start_utf16 >= quantity.end_utf16 ||
        quantity.end_utf16 > claim.claim_text.length ||
        claim.claim_text.slice(quantity.start_utf16, quantity.end_utf16) !==
          quantity.surface ||
        claim.claim_text.indexOf(quantity.surface) !== quantity.start_utf16 ||
        claim.claim_text.lastIndexOf(quantity.surface) !==
          quantity.start_utf16 ||
        quantity.start_utf16 < previousEnd
      ) {
        fail('quantity span is ambiguous, invalid, or overlapping');
      }
      previousEnd = quantity.end_utf16;
    }
  }
}

function canonicalizeProposalOrder(
  draft: GroundedDraftProposal,
): GroundedDraftProposal {
  const ordinalByFragmentId = new Map(
    draft.ordering.map((fragmentId, ordinal) => [fragmentId, ordinal]),
  );
  return {
    ...draft,
    claims: draft.claims
      .map((claim) => ({
        ...claim,
        quantities: [...claim.quantities].sort(
          (left, right) => left.start_utf16 - right.start_utf16,
        ),
        evidence_ids: [...claim.evidence_ids].sort(),
      }))
      .sort(
        (left, right) =>
          (ordinalByFragmentId.get(left.span.fragment_id) as number) -
          (ordinalByFragmentId.get(right.span.fragment_id) as number),
      ),
    render_fragments: [...draft.render_fragments].sort(
      (left, right) =>
        (ordinalByFragmentId.get(left.fragment_id) as number) -
        (ordinalByFragmentId.get(right.fragment_id) as number),
    ),
  };
}

export const GROUNDED_DRAFT_SCHEMA = {
  id: GROUNDED_DRAFT_SCHEMA_VERSION,
  version: GROUNDED_DRAFT_SCHEMA_VERSION,
  json_schema: groundedDraftJsonSchema,
  parse(value: unknown): GroundedDraftProposal {
    assertProposalUtf8Bytes(value, MAX_PROPOSAL_BYTES);
    const draft = parseClosedProposalObject(value);
    assertUniqueIdsAndClosedRenderGraph(draft);
    assertClaimSpansAndAnchors(draft);
    return canonicalizeProposalOrder(draft);
  },
} satisfies StructuredOutputSchema<GroundedDraftProposal>;
