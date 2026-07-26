import { GROUNDED_DRAFT_SCHEMA } from './grounded-draft.schema.js';

const claimC1 = {
  proposal_claim_id: 'c1',
  revision_of_candidate_claim_key: null,
  claim_text: '系统容量为300MW。',
  span: {
    fragment_id: 'f1',
    start_utf16: 0,
    end_utf16: 11,
  },
  subject: {
    surface: '系统',
    start_utf16: 0,
    end_utf16: 2,
  },
  predicate: {
    surface: '容量为',
    start_utf16: 2,
    end_utf16: 5,
  },
  polarity: 'affirmed',
  quantifier: 'plain',
  quantities: [
    {
      quantity_id: 'q1',
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
  evidence_ids: ['evidence:z', 'evidence:a'],
};

const validDraft = {
  schema_version: 'grounded-draft.v1',
  status: 'draft',
  claims: [claimC1],
  render_fragments: [
    {
      fragment_id: 'f1',
      kind: 'claim_ref',
      claim_id: 'c1',
      presentation: 'sentence',
    },
  ],
  ordering: ['f1'],
  material_gap: null,
};

function indexedClaim(index: number) {
  const claimId = `c${index}`;
  const fragmentId = `f${index}`;
  return {
    ...claimC1,
    proposal_claim_id: claimId,
    span: {
      ...claimC1.span,
      fragment_id: fragmentId,
    },
    quantities: claimC1.quantities.map((quantity) => ({
      ...quantity,
      quantity_id: `q${index}`,
    })),
  };
}

function draftWithClaimCount(count: number) {
  const claims = Array.from({ length: count }, (_, index) =>
    indexedClaim(index),
  );
  const render_fragments = claims.map((claim) => ({
    fragment_id: claim.span.fragment_id,
    kind: 'claim_ref',
    claim_id: claim.proposal_claim_id,
    presentation: 'sentence',
  }));
  return {
    ...validDraft,
    claims,
    render_fragments,
    ordering: render_fragments.map((fragment) => fragment.fragment_id),
  };
}

const gap = {
  reason_code: 'NO_EVIDENCE',
  missing_topics: ['项目容量'],
};

function draftWithClaimRef(claimId: string): unknown {
  return {
    ...validDraft,
    render_fragments: [
      {
        ...validDraft.render_fragments[0],
        claim_id: claimId,
      },
    ],
  };
}

function draftWithFragment(fragment: Record<string, unknown>): unknown {
  return {
    ...validDraft,
    render_fragments: [...validDraft.render_fragments, fragment],
    ordering: ['f1', fragment.fragment_id],
  };
}

describe('GROUNDED_DRAFT_SCHEMA', () => {
  it('parses a closed draft and canonicalizes set-like evidence IDs', () => {
    const parsed = GROUNDED_DRAFT_SCHEMA.parse(validDraft);

    expect(parsed).toEqual({
      ...validDraft,
      claims: [
        {
          ...claimC1,
          evidence_ids: ['evidence:a', 'evidence:z'],
        },
      ],
    });
  });

  it('fully describes a recursively closed provider JSON schema', () => {
    const schema = GROUNDED_DRAFT_SCHEMA.json_schema;

    expect(schema).toMatchObject({
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
    });
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":true');
    expect(schema.properties.claims.maxItems).toBe(500);
    expect(schema.properties.render_fragments.maxItems).toBe(2_000);
    expect(schema.properties.claims.items.properties.claim_text).toMatchObject({
      maxLength: 1_000,
    });
    expect(
      schema.properties.claims.items.properties.evidence_ids,
    ).toMatchObject({
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    });
  });

  it.each([
    ['unknown version', { ...validDraft, schema_version: 'grounded-draft.v2' }],
    ['extra field', { ...validDraft, support_status: 'SUPPORTED' }],
    [
      'symbol field',
      { ...validDraft, [Symbol('hidden-authority-field')]: true },
    ],
    [
      'empty draft',
      { ...validDraft, claims: [], render_fragments: [], ordering: [] },
    ],
    ['duplicate claim id', { ...validDraft, claims: [claimC1, claimC1] }],
    ['dangling claim ref', draftWithClaimRef('missing')],
    ['ordering duplicate', { ...validDraft, ordering: ['f1', 'f1'] }],
    [
      'literal fragment',
      draftWithFragment({
        fragment_id: 'f2',
        kind: 'literal',
        text: '事实',
      }),
    ],
    [
      'material gap with claims',
      { ...validDraft, status: 'material_gap', material_gap: gap },
    ],
    ['draft with material gap', { ...validDraft, material_gap: gap }],
    [
      'quantity exponent',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            quantities: [{ ...claimC1.quantities[0], value: '3e2' }],
          },
        ],
      },
    ],
    [
      'range without end',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            quantities: [
              {
                ...claimC1.quantities[0],
                comparator: 'range',
                range_end: null,
              },
            ],
          },
        ],
      },
    ],
    [
      'server authority field',
      {
        ...validDraft,
        claims: [{ ...claimC1, support_status: 'SUPPORTED' }],
      },
    ],
    [
      'server score field',
      {
        ...validDraft,
        claims: [{ ...claimC1, support_score: '1' }],
      },
    ],
    [
      'server output offset field',
      {
        ...validDraft,
        claims: [{ ...claimC1, output_char_start: 0 }],
      },
    ],
    [
      'retrieval metadata field',
      {
        ...validDraft,
        claims: [{ ...claimC1, retrieval_run_id: 'run-1' }],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => GROUNDED_DRAFT_SCHEMA.parse(value)).toThrow();
  });

  it.each([
    ['isolated high surrogate', '\uD800'],
    ['isolated low surrogate', '\uDC00'],
  ])('rejects claim text containing an %s', (_name, surrogate) => {
    const claimText = `${claimC1.claim_text}${surrogate}`;
    const draft = {
      ...validDraft,
      claims: [
        {
          ...claimC1,
          claim_text: claimText,
          span: {
            ...claimC1.span,
            end_utf16: claimText.length,
          },
        },
      ],
    };

    expect(() => GROUNDED_DRAFT_SCHEMA.parse(draft)).toThrow();
  });

  it('preserves a valid astral pair and its UTF-16 claim span', () => {
    const claimText = `${claimC1.claim_text}😀𐐷`;
    const draft = {
      ...validDraft,
      claims: [
        {
          ...claimC1,
          claim_text: claimText,
          span: {
            ...claimC1.span,
            end_utf16: claimText.length,
          },
        },
      ],
    };

    const parsed = GROUNDED_DRAFT_SCHEMA.parse(draft);

    expect(parsed.claims[0].claim_text).toBe(claimText);
    expect(parsed.claims[0].span.end_utf16).toBe(claimText.length);
  });

  it('accepts a closed material-gap signal and NFC-normalizes strings', () => {
    expect(
      GROUNDED_DRAFT_SCHEMA.parse({
        schema_version: 'grounded-draft.v1',
        status: 'material_gap',
        claims: [],
        render_fragments: [],
        ordering: [],
        material_gap: {
          reason_code: 'NO_EVIDENCE',
          missing_topics: ['Cafe\u0301'],
        },
      }),
    ).toEqual({
      schema_version: 'grounded-draft.v1',
      status: 'material_gap',
      claims: [],
      render_fragments: [],
      ordering: [],
      material_gap: {
        reason_code: 'NO_EVIDENCE',
        missing_topics: ['Café'],
      },
    });
  });

  it.each([
    ['more than 500 claims', draftWithClaimCount(501)],
    [
      'more than 2000 render fragments',
      {
        ...validDraft,
        render_fragments: [
          validDraft.render_fragments[0],
          ...Array.from({ length: 2_000 }, (_, index) => ({
            fragment_id: `separator-${index}`,
            kind: 'separator',
            token: 'space',
          })),
        ],
        ordering: [
          'f1',
          ...Array.from({ length: 2_000 }, (_, index) => `separator-${index}`),
        ],
      },
    ],
    [
      'more than three evidence IDs',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            evidence_ids: [
              'evidence:1',
              'evidence:2',
              'evidence:3',
              'evidence:4',
            ],
          },
        ],
      },
    ],
    [
      'claim text over 1000 UTF-8 bytes',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            claim_text: `${'数'.repeat(334)}。`,
            span: {
              ...claimC1.span,
              end_utf16: 335,
            },
            subject: { surface: '数', start_utf16: 0, end_utf16: 1 },
            predicate: { surface: '数', start_utf16: 1, end_utf16: 2 },
            quantities: [],
          },
        ],
      },
    ],
    [
      'decomposed claim text over 1000 raw UTF-8 bytes',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            claim_text: `${'e\u0301'.repeat(334)}。`,
            span: {
              ...claimC1.span,
              end_utf16: 335,
            },
            subject: { surface: 'é', start_utf16: 0, end_utf16: 1 },
            predicate: { surface: 'é', start_utf16: 1, end_utf16: 2 },
            quantities: [],
          },
        ],
      },
    ],
    [
      'unsafe ID characters',
      {
        ...validDraft,
        claims: [{ ...claimC1, proposal_claim_id: 'c1\ninjected' }],
        render_fragments: [
          {
            ...validDraft.render_fragments[0],
            claim_id: 'c1\ninjected',
          },
        ],
      },
    ],
    [
      'claim control character',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            claim_text: '系统\u0001容量为300MW。',
            span: { ...claimC1.span, end_utf16: 12 },
            subject: { surface: '系统', start_utf16: 0, end_utf16: 2 },
            predicate: { surface: '容量为', start_utf16: 3, end_utf16: 6 },
            quantities: [
              {
                ...claimC1.quantities[0],
                start_utf16: 6,
                end_utf16: 11,
              },
            ],
          },
        ],
      },
    ],
    [
      'claim Markdown fence',
      {
        ...validDraft,
        claims: [
          {
            ...claimC1,
            claim_text: '```系统容量为300MW。```',
            span: { ...claimC1.span, end_utf16: 17 },
            subject: { surface: '系统', start_utf16: 3, end_utf16: 5 },
            predicate: { surface: '容量为', start_utf16: 5, end_utf16: 8 },
            quantities: [
              {
                ...claimC1.quantities[0],
                start_utf16: 8,
                end_utf16: 13,
              },
            ],
          },
        ],
      },
    ],
  ])('enforces the closed runtime limit: %s', (_name, value) => {
    expect(() => GROUNDED_DRAFT_SCHEMA.parse(value)).toThrow();
  });

  it('canonicalizes claims and fragments by declared render order', () => {
    const first = indexedClaim(1);
    const second = indexedClaim(2);
    const input = {
      ...validDraft,
      claims: [second, first],
      render_fragments: [
        {
          fragment_id: 'f2',
          kind: 'claim_ref',
          claim_id: 'c2',
          presentation: 'sentence',
        },
        {
          fragment_id: 'separator-1',
          kind: 'separator',
          token: 'space',
        },
        {
          fragment_id: 'f1',
          kind: 'claim_ref',
          claim_id: 'c1',
          presentation: 'sentence',
        },
      ],
      ordering: ['f1', 'separator-1', 'f2'],
    };

    const parsed = GROUNDED_DRAFT_SCHEMA.parse(input);

    expect(parsed.claims.map((claim) => claim.proposal_claim_id)).toEqual([
      'c1',
      'c2',
    ]);
    expect(
      parsed.render_fragments.map((fragment) => fragment.fragment_id),
    ).toEqual(['f1', 'separator-1', 'f2']);
  });
});
