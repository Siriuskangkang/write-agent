import type {
  AtomicClaimProposal,
  Comparator,
  QuantityDimension,
  QuantityProposal,
} from './contracts.js';
import { lexQuantitiesV1, recomputeAtomV1 } from './quantity-lexer.js';

function quantityProposal(
  quantity_id: string,
  text: string,
  surface: string,
  dimension: QuantityDimension,
  value: string,
  unit: string | null,
  comparator: Comparator = 'eq',
  range_end: string | null = null,
): QuantityProposal {
  const start_utf16 = text.indexOf(surface);
  return {
    quantity_id,
    surface,
    start_utf16,
    end_utf16: start_utf16 + surface.length,
    dimension,
    value,
    unit,
    comparator,
    range_end,
  };
}

function claim(
  claim_text = '系统容量为300MW。',
  overrides: Partial<AtomicClaimProposal> = {},
): AtomicClaimProposal {
  return {
    proposal_claim_id: 'c1',
    revision_of_candidate_claim_key: null,
    claim_text,
    span: {
      fragment_id: 'f1',
      start_utf16: 0,
      end_utf16: claim_text.length,
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
      quantityProposal('q1', claim_text, '300MW', 'power', '300', 'MW'),
    ],
    evidence_ids: ['evidence:1'],
    ...overrides,
  };
}

describe('lexQuantitiesV1', () => {
  it('returns every quantity in left-to-right UTF-16 order', () => {
    expect(
      lexQuantitiesV1('甲为0.3GW，乙为300MW，周期12个月，占比50%。'),
    ).toMatchObject([
      {
        ordinal: 0,
        dimension: 'power',
        base_value: '300000000',
        base_unit: 'W',
        comparator: 'eq',
      },
      {
        ordinal: 1,
        dimension: 'power',
        base_value: '300000000',
        base_unit: 'W',
        comparator: 'eq',
      },
      {
        ordinal: 2,
        dimension: 'duration',
        base_value: '12',
        base_unit: 'month',
        comparator: 'eq',
      },
      {
        ordinal: 3,
        dimension: 'ratio',
        base_value: '0.5',
        base_unit: null,
        comparator: 'eq',
      },
    ]);
  });

  it.each([
    ['三千兆瓦', 'power', '3000000000', 'W'],
    ['1.2亿千瓦时', 'energy', '120000000000', 'Wh'],
    ['百分之五十', 'ratio', '0.5', null],
    ['一年', 'duration', '12', 'month'],
    ['人民币2万元', 'currency', '20000', 'CNY'],
    ['3个', 'count', '3', 'count'],
    ['1.5公里', 'length', '1500', 'm'],
    ['2公斤', 'mass', '2000', 'g'],
    ['负二点五摄氏度', 'temperature', '-2.5', 'celsius'],
    ['−2°C', 'temperature', '-2', 'celsius'],
    ['一万亿瓦', 'power', '1000000000000', 'W'],
    ['一万亿三千万瓦', 'power', '1000030000000', 'W'],
    ['300W', 'power', '300', 'W'],
    ['300kW', 'power', '300000', 'W'],
    ['300MWh', 'energy', '300000000', 'Wh'],
    ['0.5', 'other', '0.5', null],
  ])(
    'normalizes %s without floating-point arithmetic',
    (text, dimension, baseValue, baseUnit) => {
      expect(lexQuantitiesV1(text)).toEqual([
        expect.objectContaining({
          ordinal: 0,
          surface_nfc: text,
          dimension,
          base_value: baseValue,
          base_unit: baseUnit,
        }),
      ]);
    },
  );

  it.each([
    ['超过300MW', 'gt'],
    ['大于300MW', 'gt'],
    ['不少于300MW', 'gte'],
    ['至少300MW', 'gte'],
    ['小于300MW', 'lt'],
    ['不超过300MW', 'lte'],
    ['约300MW', 'approx'],
    ['300至400MW', 'range'],
  ])('classifies comparator %s as %s', (text, comparator) => {
    expect(lexQuantitiesV1(text)).toEqual([
      expect.objectContaining({
        surface_nfc: text,
        comparator,
        range_end_base_value: comparator === 'range' ? '400000000' : null,
        typed_equivalence_eligible:
          comparator !== 'approx' && comparator !== 'range',
      }),
    ]);
  });

  it('reports exact UTF-16 offsets around astral characters', () => {
    expect(lexQuantitiesV1('😀容量300MW。')).toEqual([
      expect.objectContaining({
        surface_nfc: '300MW',
        start_utf16: 4,
        end_utf16: 9,
      }),
    ]);
  });

  it.each([
    ['exponent form', '容量3e2MW'],
    ['malformed decimal', '容量1..2MW'],
    ['multiple decimal points', '容量1.2.3MW'],
    ['ambiguous mixed comparator', '容量至少不超过300MW'],
    ['repeated yi multiplier', '容量一亿亿瓦'],
    ['repeated wan multiplier', '容量一万万瓦'],
    ['repeated yi after wan-yi', '容量一万亿三亿二亿瓦'],
    ['repeated wan after wan-yi', '容量一万亿三万二万瓦'],
    ['reversed large units after wan-yi', '容量一万亿三万二亿瓦'],
    ['repeated small unit', '容量一百百瓦'],
    ['out-of-order small units', '容量一十百瓦'],
    ['repeated implicit small unit', '容量十十瓦'],
  ])('rejects %s', (_name, text) => {
    expect(() => lexQuantitiesV1(text)).toThrow();
  });

  it('never deletes or classifies coordinator characters', () => {
    expect(lexQuantitiesV1('和田300MW与乙方400MW')).toMatchObject([
      { surface_nfc: '300MW', start_utf16: 2 },
      { surface_nfc: '400MW', start_utf16: 10 },
    ]);
  });
});

describe('recomputeAtomV1', () => {
  it('recomputes anchors, polarity, quantifier, and canonical quantities', () => {
    expect(recomputeAtomV1(claim())).toEqual({
      source_claim_text_nfc: '系统容量为300MW。',
      subject_anchor: {
        surface_nfc: '系统',
        start_utf16: 0,
        end_utf16: 2,
      },
      predicate_anchor: {
        surface_nfc: '容量为',
        start_utf16: 2,
        end_utf16: 5,
      },
      polarity: 'affirmed',
      quantifier: 'plain',
      quantities: [
        {
          ordinal: 0,
          surface_nfc: '300MW',
          start_utf16: 5,
          end_utf16: 10,
          dimension: 'power',
          base_value: '300000000',
          base_unit: 'W',
          comparator: 'eq',
          range_end_base_value: null,
          typed_equivalence_eligible: true,
        },
      ],
    });
  });

  it.each([
    [
      'anchor surface',
      claim('系统容量为300MW。', {
        subject: { surface: '系', start_utf16: 0, end_utf16: 2 },
      }),
    ],
    [
      'anchor overlap',
      claim('系统容量为300MW。', {
        predicate: { surface: '统容量为', start_utf16: 1, end_utf16: 5 },
      }),
    ],
    ['polarity', claim('系统容量为300MW。', { polarity: 'negated' })],
    [
      'quantifier',
      claim('所有系统容量为300MW。', {
        span: {
          fragment_id: 'f1',
          start_utf16: 0,
          end_utf16: 13,
        },
        subject: { surface: '系统', start_utf16: 2, end_utf16: 4 },
        predicate: { surface: '容量为', start_utf16: 4, end_utf16: 7 },
        quantifier: 'plain',
        quantities: [
          quantityProposal(
            'q1',
            '所有系统容量为300MW。',
            '300MW',
            'power',
            '300',
            'MW',
          ),
        ],
      }),
    ],
    [
      'quantity value',
      claim('系统容量为300MW。', {
        quantities: [
          quantityProposal(
            'q1',
            '系统容量为300MW。',
            '300MW',
            'power',
            '400',
            'MW',
          ),
        ],
      }),
    ],
    ['quantity cardinality', claim('系统容量为300MW。', { quantities: [] })],
    [
      'quantity overlap',
      claim('系统容量为300MW。', {
        quantities: [
          quantityProposal(
            'q1',
            '系统容量为300MW。',
            '300MW',
            'power',
            '300',
            'MW',
          ),
          {
            ...quantityProposal(
              'q2',
              '系统容量为300MW。',
              '300MW',
              'power',
              '300',
              'MW',
            ),
          },
        ],
      }),
    ],
    [
      'out-of-range quantity',
      claim('系统容量为300MW。', {
        quantities: [
          {
            ...quantityProposal(
              'q1',
              '系统容量为300MW。',
              '300MW',
              'power',
              '300',
              'MW',
            ),
            end_utf16: 99,
          },
        ],
      }),
    ],
  ])('rejects server-field mismatch: %s', (_name, value) => {
    expect(() => recomputeAtomV1(value)).toThrow();
  });

  it.each(['换行\n事实。', '控制\u0001事实。', '```事实```'])(
    'rejects control or fence bytes in source text',
    (claim_text) => {
      expect(() =>
        recomputeAtomV1(
          claim(claim_text, {
            span: {
              fragment_id: 'f1',
              start_utf16: 0,
              end_utf16: claim_text.length,
            },
            quantities: [],
          }),
        ),
      ).toThrow();
    },
  );

  it('marks some/other quantifiers exact-only', () => {
    const claimText = '部分系统容量为300MW。';
    const result = recomputeAtomV1(
      claim(claimText, {
        span: {
          fragment_id: 'f1',
          start_utf16: 0,
          end_utf16: claimText.length,
        },
        subject: { surface: '系统', start_utf16: 2, end_utf16: 4 },
        predicate: { surface: '容量为', start_utf16: 4, end_utf16: 7 },
        quantifier: 'some',
        quantities: [
          quantityProposal('q1', claimText, '300MW', 'power', '300', 'MW'),
        ],
      }),
    );

    expect(result.quantifier).toBe('some');
    expect(result.quantities[0].typed_equivalence_eligible).toBe(false);
  });

  it('marks conflicting closed polarity occurrences exact-only', () => {
    const claimText = '系统不能不以0.3GW运行。';
    const result = recomputeAtomV1(
      claim(claimText, {
        span: {
          fragment_id: 'f1',
          start_utf16: 0,
          end_utf16: claimText.length,
        },
        subject: { surface: '系统', start_utf16: 0, end_utf16: 2 },
        predicate: { surface: '运行', start_utf16: 11, end_utf16: 13 },
        quantities: [
          quantityProposal('q1', claimText, '0.3GW', 'power', '0.3', 'GW'),
        ],
      }),
    );

    expect(result.quantities[0].typed_equivalence_eligible).toBe(false);
  });

  it.each([
    [
      '比例为百分之五十。',
      {
        surface: '百分之五十',
        dimension: 'ratio' as const,
        value: '50',
        unit: '百分之',
      },
      {
        subject: { surface: '比例', start_utf16: 0, end_utf16: 2 },
        predicate: { surface: '为', start_utf16: 2, end_utf16: 3 },
      },
      '0.5',
    ],
    [
      '发电量为1.2亿千瓦时。',
      {
        surface: '1.2亿千瓦时',
        dimension: 'energy' as const,
        value: '120000000',
        unit: '千瓦时',
      },
      {
        subject: { surface: '发电量', start_utf16: 0, end_utf16: 3 },
        predicate: { surface: '为', start_utf16: 3, end_utf16: 4 },
      },
      '120000000000',
    ],
    [
      '完成比例为0.5。',
      {
        surface: '0.5',
        dimension: 'ratio' as const,
        value: '0.5',
        unit: null,
      },
      {
        subject: { surface: '完成', start_utf16: 0, end_utf16: 2 },
        predicate: { surface: '比例为', start_utf16: 2, end_utf16: 5 },
      },
      '0.5',
    ],
  ])(
    'recomputes proposal semantics for %s',
    (claimText, fixture, anchors, baseValue) => {
      const result = recomputeAtomV1(
        claim(claimText, {
          span: {
            fragment_id: 'f1',
            start_utf16: 0,
            end_utf16: claimText.length,
          },
          ...anchors,
          quantities: [
            quantityProposal(
              'q1',
              claimText,
              fixture.surface,
              fixture.dimension,
              fixture.value,
              fixture.unit,
            ),
          ],
        }),
      );

      expect(result.quantities[0].base_value).toBe(baseValue);
    },
  );
});
