import {
  type AtomicClaimProposal,
  type CanonicalQuantityOccurrenceV1,
  type Comparator,
  type Polarity,
  type QuantityDimension,
  type QuantityProposal,
  type Quantifier,
  type RecomputedAtomV1,
} from './contracts.js';

interface FixedDecimal {
  coefficient: bigint;
  scale: number;
}

interface UnitDefinition {
  dimension: QuantityDimension;
  base_unit: string | null;
  multiplier: bigint;
  decimal_shift: number;
}

interface InternalQuantity extends CanonicalQuantityOccurrenceV1 {
  lexical_value: string;
  lexical_unit: string | null;
  lexical_range_end: string | null;
}

const DECIMAL = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const GROUPED_DECIMAL =
  /^[+−-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?)$/u;
const CHINESE_NUMBER = '负?[零〇一二两三四五六七八九十百千万亿点]+';
const ARABIC_NUMBER =
  '[+−-]?(?:(?:0|[1-9]\\d*)(?:\\.\\d+)?|[1-9]\\d{0,2}(?:,\\d{3})+(?:\\.\\d+)?)';
const NUMBER = `(?:${ARABIC_NUMBER}|${CHINESE_NUMBER})`;
const PREFIX = '(?:不超过|不少于|至少|超过|大于|小于|约)(?:为|等于)?';
const SUFFIX = '(?:及以上|及以下|以上|以下|左右)';
const UNIT =
  '(?:摄氏度|人民币元|人民币|GWh|MWh|kWh|Wh|GW|MW|kW|W|兆瓦时|千瓦时|瓦时|吉瓦|兆瓦|千瓦|瓦|亿元|万元|美元|欧元|个月|小时|分钟|公里|厘米|毫米|公斤|千克|百分比|比例|°C|℃|km|cm|mm|kg|年|月|天|日|秒|元|个|台|套|人|项|件|米|m|吨|t|克|g|%)';

const prefixComparator: Record<string, Comparator> = {
  不超过: 'lte',
  不少于: 'gte',
  至少: 'gte',
  超过: 'gt',
  大于: 'gt',
  小于: 'lt',
  约: 'approx',
};

const suffixComparator: Record<string, Comparator> = {
  及以上: 'gte',
  以上: 'gte',
  及以下: 'lte',
  以下: 'lte',
  左右: 'approx',
};

const unitDefinitions: Record<string, UnitDefinition> = {
  W: unit('power', 'W', 1),
  kW: unit('power', 'W', 1_000),
  MW: unit('power', 'W', 1_000_000),
  GW: unit('power', 'W', 1_000_000_000),
  瓦: unit('power', 'W', 1),
  千瓦: unit('power', 'W', 1_000),
  兆瓦: unit('power', 'W', 1_000_000),
  吉瓦: unit('power', 'W', 1_000_000_000),
  Wh: unit('energy', 'Wh', 1),
  kWh: unit('energy', 'Wh', 1_000),
  MWh: unit('energy', 'Wh', 1_000_000),
  GWh: unit('energy', 'Wh', 1_000_000_000),
  瓦时: unit('energy', 'Wh', 1),
  千瓦时: unit('energy', 'Wh', 1_000),
  兆瓦时: unit('energy', 'Wh', 1_000_000),
  年: unit('duration', 'month', 12),
  个月: unit('duration', 'month', 1),
  月: unit('duration', 'month', 1),
  天: unit('duration', 'second', 86_400),
  日: unit('duration', 'second', 86_400),
  小时: unit('duration', 'second', 3_600),
  分钟: unit('duration', 'second', 60),
  秒: unit('duration', 'second', 1),
  '%': shiftedUnit('ratio', null, 2),
  百分之: shiftedUnit('ratio', null, 2),
  百分比: shiftedUnit('ratio', null, 2),
  比例: unit('ratio', null, 1),
  元: unit('currency', 'CNY', 1),
  人民币元: unit('currency', 'CNY', 1),
  人民币: unit('currency', 'CNY', 1),
  万元: unit('currency', 'CNY', 10_000),
  亿元: unit('currency', 'CNY', 100_000_000),
  美元: unit('currency', 'USD', 1),
  欧元: unit('currency', 'EUR', 1),
  个: unit('count', 'count', 1),
  台: unit('count', 'count', 1),
  套: unit('count', 'count', 1),
  人: unit('count', 'count', 1),
  项: unit('count', 'count', 1),
  件: unit('count', 'count', 1),
  m: unit('length', 'm', 1),
  米: unit('length', 'm', 1),
  km: unit('length', 'm', 1_000),
  公里: unit('length', 'm', 1_000),
  cm: shiftedUnit('length', 'm', 2),
  厘米: shiftedUnit('length', 'm', 2),
  mm: shiftedUnit('length', 'm', 3),
  毫米: shiftedUnit('length', 'm', 3),
  g: unit('mass', 'g', 1),
  克: unit('mass', 'g', 1),
  kg: unit('mass', 'g', 1_000),
  公斤: unit('mass', 'g', 1_000),
  千克: unit('mass', 'g', 1_000),
  t: unit('mass', 'g', 1_000_000),
  吨: unit('mass', 'g', 1_000_000),
  '°C': unit('temperature', 'celsius', 1),
  '℃': unit('temperature', 'celsius', 1),
  摄氏度: unit('temperature', 'celsius', 1),
};

function unit(
  dimension: QuantityDimension,
  base_unit: string | null,
  multiplier: number,
): UnitDefinition {
  return {
    dimension,
    base_unit,
    multiplier: BigInt(multiplier),
    decimal_shift: 0,
  };
}

function shiftedUnit(
  dimension: QuantityDimension,
  base_unit: string | null,
  decimal_shift: number,
): UnitDefinition {
  return {
    dimension,
    base_unit,
    multiplier: 1n,
    decimal_shift,
  };
}

function normalizeFixed(value: FixedDecimal): FixedDecimal {
  let { coefficient, scale } = value;
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function fixedToString(value: FixedDecimal): string {
  const normalized = normalizeFixed(value);
  const negative = normalized.coefficient < 0n;
  let digits = (
    negative ? -normalized.coefficient : normalized.coefficient
  ).toString();
  if (normalized.scale > 0) {
    digits = digits.padStart(normalized.scale + 1, '0');
    const split = digits.length - normalized.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return `${negative ? '-' : ''}${digits}`;
}

function parseArabicFixed(raw: string): FixedDecimal | null {
  if (!GROUPED_DECIMAL.test(raw)) return null;
  const normalized = raw.replaceAll(',', '').replace('−', '-');
  if (!DECIMAL.test(normalized)) return null;
  const negative = normalized.startsWith('-');
  const unsigned = /^[+-]/u.test(normalized) ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart = ''] = unsigned.split('.');
  const coefficient = BigInt(
    `${negative ? '-' : ''}${integerPart}${decimalPart}`,
  );
  return normalizeFixed({ coefficient, scale: decimalPart.length });
}

function parseChineseFixed(raw: string): FixedDecimal | null {
  const negative = raw.startsWith('负');
  const unsigned = negative ? raw.slice(1) : raw;
  const parts = unsigned.split('点');
  if (parts.length > 2) return null;
  const integer = parseChineseInteger(parts[0]);
  if (integer === null) return null;
  const digits: Record<string, string> = {
    零: '0',
    〇: '0',
    一: '1',
    二: '2',
    两: '2',
    三: '3',
    四: '4',
    五: '5',
    六: '6',
    七: '7',
    八: '8',
    九: '9',
  };
  const decimal = parts[1] ?? '';
  if ([...decimal].some((character) => digits[character] === undefined)) {
    return null;
  }
  const decimalDigits = [...decimal]
    .map((character) => digits[character])
    .join('');
  const coefficient =
    integer * 10n ** BigInt(decimalDigits.length) +
    BigInt(decimalDigits.length === 0 ? '0' : decimalDigits);
  return normalizeFixed({
    coefficient: negative ? -coefficient : coefficient,
    scale: decimalDigits.length,
  });
}

function parseChineseInteger(raw: string): bigint | null {
  if (raw.length === 0) return 0n;
  const digits: Record<string, bigint> = {
    零: 0n,
    〇: 0n,
    一: 1n,
    二: 2n,
    两: 2n,
    三: 3n,
    四: 4n,
    五: 5n,
    六: 6n,
    七: 7n,
    八: 8n,
    九: 9n,
  };
  const smallUnits: Record<string, bigint> = {
    十: 10n,
    百: 100n,
    千: 1_000n,
  };

  const parseSmallSection = (value: string): bigint | null => {
    if (value.length === 0) return 0n;
    if (![...value].some((character) => smallUnits[character] !== undefined)) {
      if ([...value].some((character) => digits[character] === undefined)) {
        return null;
      }
      return BigInt([...value].map((character) => digits[character]).join(''));
    }

    let total = 0n;
    let pendingDigit: bigint | null = null;
    let previousUnit = 10_000n;
    let sawUnit = false;
    for (const character of value) {
      const digit = digits[character];
      if (digit !== undefined) {
        if (pendingDigit !== null) {
          if (pendingDigit === 0n && digit !== 0n) {
            pendingDigit = digit;
            continue;
          }
          return null;
        }
        pendingDigit = digit;
        continue;
      }

      const unitValue = smallUnits[character];
      if (
        unitValue === undefined ||
        unitValue >= previousUnit ||
        pendingDigit === 0n
      ) {
        return null;
      }
      if (pendingDigit === null) {
        if (unitValue !== 10n || sawUnit) return null;
        pendingDigit = 1n;
      }
      total += pendingDigit * unitValue;
      pendingDigit = null;
      previousUnit = unitValue;
      sawUnit = true;
    }
    if (pendingDigit === 0n) return null;
    return total + (pendingDigit ?? 0n);
  };

  const boundedSection = (value: string): bigint | null => {
    const parsed = parseSmallSection(value);
    return parsed !== null && parsed <= 9_999n ? parsed : null;
  };

  const compoundIndex = raw.indexOf('万亿');
  if (compoundIndex >= 0) {
    const leftRaw = raw.slice(0, compoundIndex);
    const tailRaw = raw.slice(compoundIndex + 2);
    if (raw.lastIndexOf('万亿') !== compoundIndex || /[万亿]/u.test(leftRaw)) {
      return null;
    }
    const left = boundedSection(leftRaw);
    const tail = parseChineseInteger(tailRaw);
    if (
      left === null ||
      left === 0n ||
      tail === null ||
      tail >= 1_000_000_000_000n
    ) {
      return null;
    }
    return left * 1_000_000_000_000n + tail;
  }

  const yiIndex = raw.indexOf('亿');
  const wanIndex = raw.indexOf('万');
  if (
    (yiIndex >= 0 && raw.lastIndexOf('亿') !== yiIndex) ||
    (wanIndex >= 0 && raw.lastIndexOf('万') !== wanIndex) ||
    (yiIndex >= 0 && wanIndex >= 0 && yiIndex > wanIndex)
  ) {
    return null;
  }
  if (yiIndex < 0 && wanIndex < 0) return parseSmallSection(raw);

  let total = 0n;
  let remainder = raw;
  if (yiIndex >= 0) {
    const yiSection = boundedSection(raw.slice(0, yiIndex));
    if (yiSection === null || yiSection === 0n) return null;
    total += yiSection * 100_000_000n;
    remainder = raw.slice(yiIndex + 1);
  }

  const relativeWanIndex = remainder.indexOf('万');
  if (relativeWanIndex >= 0) {
    const wanSection = boundedSection(remainder.slice(0, relativeWanIndex));
    if (wanSection === null || wanSection === 0n) return null;
    total += wanSection * 10_000n;
    remainder = remainder.slice(relativeWanIndex + 1);
  }

  const tail = boundedSection(remainder);
  return tail === null ? null : total + tail;
}

function parseNumber(raw: string): FixedDecimal | null {
  return /\d/u.test(raw) ? parseArabicFixed(raw) : parseChineseFixed(raw);
}

function multiply(
  value: FixedDecimal,
  definition: UnitDefinition,
  scaleMultiplier: bigint,
): string {
  return fixedToString({
    coefficient: value.coefficient * definition.multiplier * scaleMultiplier,
    scale: value.scale + definition.decimal_shift,
  });
}

function directUtf16Sort(values: string[]): string[] {
  return values.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function classifyComparator(
  prefix: string | undefined,
  suffix: string | undefined,
): Comparator {
  const normalizedPrefix = prefix?.replace(/(?:为|等于)$/u, '');
  const fromPrefix = normalizedPrefix
    ? prefixComparator[normalizedPrefix]
    : undefined;
  const fromSuffix = suffix ? suffixComparator[suffix] : undefined;
  if (fromPrefix && fromSuffix && fromPrefix !== fromSuffix) {
    throw new TypeError('ambiguous mixed quantity comparator');
  }
  return fromPrefix ?? fromSuffix ?? 'eq';
}

function unitFor(
  rawUnit: string | null,
  leadingContext: string,
): UnitDefinition {
  if (rawUnit) {
    const exact = unitDefinitions[rawUnit];
    if (exact) return exact;
  }
  if (
    /(?:占比|比例|比率|完成率|率)\s*(?:为|是|达到)?\s*$/u.test(leadingContext)
  ) {
    return unit('ratio', null, 1);
  }
  return unit('other', null, 1);
}

function quantityFromMatch(input: {
  surface: string;
  start: number;
  prefix?: string;
  first: string;
  scale?: string;
  unit?: string;
  suffix?: string;
  rangeEnd?: string;
}): InternalQuantity {
  const first = parseNumber(input.first);
  if (!first) throw new TypeError('malformed quantity number');
  const scaleMultiplier =
    input.scale === '亿' ? 100_000_000n : input.scale === '万' ? 10_000n : 1n;
  const definition = unitFor(
    input.unit ?? null,
    input.surface.slice(0, Math.max(0, input.surface.indexOf(input.first))),
  );
  const comparator = input.rangeEnd
    ? 'range'
    : classifyComparator(input.prefix, input.suffix);
  const rangeEnd = input.rangeEnd ? parseNumber(input.rangeEnd) : null;
  if (input.rangeEnd && !rangeEnd) {
    throw new TypeError('malformed quantity range end');
  }
  const lexicalValue = {
    coefficient: first.coefficient * scaleMultiplier,
    scale: first.scale,
  };
  const lexicalRangeEnd = rangeEnd
    ? {
        coefficient: rangeEnd.coefficient * scaleMultiplier,
        scale: rangeEnd.scale,
      }
    : null;
  return {
    ordinal: -1,
    surface_nfc: input.surface,
    start_utf16: input.start,
    end_utf16: input.start + input.surface.length,
    dimension: definition.dimension,
    base_value: multiply(first, definition, scaleMultiplier),
    base_unit: definition.base_unit,
    comparator,
    range_end_base_value: rangeEnd
      ? multiply(rangeEnd, definition, scaleMultiplier)
      : null,
    typed_equivalence_eligible:
      comparator !== 'approx' &&
      comparator !== 'range' &&
      definition.dimension !== 'other',
    lexical_value: fixedToString(lexicalValue),
    lexical_unit: input.unit ?? null,
    lexical_range_end: lexicalRangeEnd ? fixedToString(lexicalRangeEnd) : null,
  };
}

function anchored(pattern: string, flags = 'u'): RegExp {
  return new RegExp(`^(?:${pattern})`, flags);
}

const rangePattern = anchored(
  `(${NUMBER})\\s*(?:至|到|~|～|—|-)\\s*(${NUMBER})\\s*(万|亿)?\\s*(${UNIT.slice(3, -1)})`,
  'iu',
);
const percentChinesePattern = anchored(
  `(${PREFIX})?\\s*百分之(${NUMBER})\\s*(${SUFFIX})?`,
  'u',
);
const prefixedCurrencyPattern = anchored(
  `(人民币)\\s*(${NUMBER})\\s*(亿元|万元|元)\\s*(${SUFFIX})?`,
  'u',
);
const ordinaryPattern = anchored(
  `(${PREFIX})?\\s*(${NUMBER})\\s*(万|亿)?\\s*(${UNIT.slice(3, -1)})?\\s*(${SUFFIX})?`,
  'iu',
);

function malformedQuantityGuard(text: string): void {
  if (
    /[+-]?\d+(?:\.\d+)?[eE][+-]?\d+/u.test(text) ||
    /\d+\.\d*\.\d+/u.test(text) ||
    /(?:不超过|不少于|至少|超过|大于|小于|约)(?:为|等于)?\s*(?:不超过|不少于|至少|超过|大于|小于|约)/u.test(
      text,
    )
  ) {
    throw new TypeError('unsupported or ambiguous quantity syntax');
  }
}

function internalLexQuantities(text: string): InternalQuantity[] {
  const normalized = text.normalize('NFC');
  malformedQuantityGuard(normalized);
  const quantities: InternalQuantity[] = [];
  let index = 0;
  while (index < normalized.length) {
    const remaining = normalized.slice(index);
    const range = rangePattern.exec(remaining);
    if (range) {
      quantities.push(
        quantityFromMatch({
          surface: range[0],
          start: index,
          first: range[1],
          rangeEnd: range[2],
          scale: range[3],
          unit: range[4],
        }),
      );
      index += range[0].length;
      continue;
    }
    const percent = percentChinesePattern.exec(remaining);
    if (percent) {
      const value = parseNumber(percent[2]);
      if (!value) throw new TypeError('malformed Chinese percentage');
      const comparator = classifyComparator(percent[1], percent[3]);
      quantities.push({
        ordinal: -1,
        surface_nfc: percent[0],
        start_utf16: index,
        end_utf16: index + percent[0].length,
        dimension: 'ratio',
        base_value: fixedToString({
          coefficient: value.coefficient,
          scale: value.scale + 2,
        }),
        base_unit: null,
        comparator,
        range_end_base_value: null,
        typed_equivalence_eligible: comparator !== 'approx',
        lexical_value: fixedToString(value),
        lexical_unit: '百分之',
        lexical_range_end: null,
      });
      index += percent[0].length;
      continue;
    }
    const prefixedCurrency = prefixedCurrencyPattern.exec(remaining);
    if (prefixedCurrency) {
      quantities.push(
        quantityFromMatch({
          surface: prefixedCurrency[0],
          start: index,
          first: prefixedCurrency[2],
          unit: prefixedCurrency[3],
          suffix: prefixedCurrency[4],
        }),
      );
      index += prefixedCurrency[0].length;
      continue;
    }
    const ordinary = ordinaryPattern.exec(remaining);
    if (ordinary) {
      const surface = ordinary[0];
      const hasUnit = ordinary[4] !== undefined;
      const rawNumber = ordinary[2];
      const preceding = normalized.slice(Math.max(0, index - 16), index);
      const contextualBareRatio =
        !hasUnit &&
        /(?:占比|比例|比率|完成率|率)\s*(?:为|是|达到)?\s*$/u.test(preceding);
      if (hasUnit || contextualBareRatio || rawNumber.length > 0) {
        const parsed = quantityFromMatch({
          surface,
          start: index,
          prefix: ordinary[1],
          first: rawNumber,
          scale: ordinary[3],
          unit: ordinary[4],
          suffix: ordinary[5],
        });
        if (contextualBareRatio) {
          parsed.dimension = 'ratio';
          parsed.base_unit = null;
          parsed.typed_equivalence_eligible =
            parsed.comparator !== 'approx' && parsed.comparator !== 'range';
        }
        quantities.push(parsed);
        index += surface.length;
        continue;
      }
    }
    index += 1;
  }
  return quantities.map((quantity, ordinal) => ({ ...quantity, ordinal }));
}

function toPublicQuantity(
  quantity: InternalQuantity,
): CanonicalQuantityOccurrenceV1 {
  return {
    ordinal: quantity.ordinal,
    surface_nfc: quantity.surface_nfc,
    start_utf16: quantity.start_utf16,
    end_utf16: quantity.end_utf16,
    dimension: quantity.dimension,
    base_value: quantity.base_value,
    base_unit: quantity.base_unit,
    comparator: quantity.comparator,
    range_end_base_value: quantity.range_end_base_value,
    typed_equivalence_eligible: quantity.typed_equivalence_eligible,
  };
}

export function lexQuantitiesV1(text: string): CanonicalQuantityOccurrenceV1[] {
  return internalLexQuantities(text).map(toPublicQuantity);
}

function recomputeQuantifier(text: string): Quantifier {
  const matches: Quantifier[] = [];
  const add = (quantifier: Quantifier, expression: RegExp): void => {
    if (expression.test(text)) matches.push(quantifier);
  };
  add('not_none', /(?:并非|不是)没有(?:任何)?/u);
  add('not_all', /(?:并非|不是)(?:所有|全部)/u);
  add('none', /(?:没有任何|无任何|没有一个)/u);
  add('all', /(?:所有|全部|每个)/u);
  add('some', /(?:部分|有些|一些)/u);
  const unique = [...new Set(matches)];
  if (unique.length === 0) return 'plain';
  const scoped = unique.filter(
    (item) =>
      !(
        (item === 'none' && unique.includes('not_none')) ||
        (item === 'all' && unique.includes('not_all'))
      ),
  );
  return scoped.length === 1 ? scoped[0] : 'other';
}

function analyzePolarity(
  text: string,
  quantities: InternalQuantity[],
): { polarity: Polarity; typed_equivalence_eligible: boolean } {
  let skeleton = text;
  for (const quantity of [...quantities].reverse()) {
    skeleton =
      skeleton.slice(0, quantity.start_utf16) +
      ' '.repeat(quantity.end_utf16 - quantity.start_utf16) +
      skeleton.slice(quantity.end_utf16);
  }
  skeleton = skeleton.replace(
    /(?:并非|不是)(?:没有(?:任何)?|所有|全部)|(?:没有任何|无任何|没有一个)/gu,
    '',
  );
  const negativeTokens =
    skeleton.match(/(?:并非|不能|不得|不可以|未能|没有|不是|无|未|不)/gu) ?? [];
  return {
    polarity: negativeTokens.length % 2 === 0 ? 'affirmed' : 'negated',
    typed_equivalence_eligible: negativeTokens.length <= 1,
  };
}

export interface AnalyzedAtomicTextV1 {
  source_text_nfc: string;
  polarity: Polarity;
  quantifier: Quantifier;
  quantities: CanonicalQuantityOccurrenceV1[];
  typed_equivalence_eligible: boolean;
}

function hasForbiddenAtomControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function analyzeAtomicTextV1(text: string): AnalyzedAtomicTextV1 {
  const source = text.normalize('NFC');
  if (
    source.length === 0 ||
    hasForbiddenAtomControl(source) ||
    source.includes('```')
  ) {
    throw new TypeError('atom source contains forbidden control or fence');
  }
  const internal = internalLexQuantities(source);
  const polarity = analyzePolarity(source, internal);
  const quantifier = recomputeQuantifier(source);
  return {
    source_text_nfc: source,
    polarity: polarity.polarity,
    quantifier,
    quantities: internal.map(toPublicQuantity),
    typed_equivalence_eligible:
      polarity.typed_equivalence_eligible &&
      quantifier !== 'some' &&
      quantifier !== 'other',
  };
}

function exactAnchor(
  text: string,
  anchor: AtomicClaimProposal['subject'],
): boolean {
  return (
    anchor.start_utf16 >= 0 &&
    anchor.start_utf16 < anchor.end_utf16 &&
    anchor.end_utf16 <= text.length &&
    text.slice(anchor.start_utf16, anchor.end_utf16) ===
      anchor.surface.normalize('NFC')
  );
}

function canonicalProposalQuantity(proposal: QuantityProposal): {
  base_value: string;
  base_unit: string | null;
  range_end_base_value: string | null;
} {
  const value = parseArabicFixed(proposal.value);
  if (!value)
    throw new TypeError('proposal quantity value is not fixed decimal');
  const definition =
    proposal.unit === null && proposal.dimension === 'ratio'
      ? unit('ratio', null, 1)
      : unitFor(proposal.unit, '');
  if (definition.dimension !== proposal.dimension) {
    throw new TypeError('proposal quantity dimension/unit mismatch');
  }
  const rangeEnd =
    proposal.range_end === null ? null : parseArabicFixed(proposal.range_end);
  if (proposal.range_end !== null && !rangeEnd) {
    throw new TypeError('proposal range end is not fixed decimal');
  }
  const scaleMultiplier = 1n;
  return {
    base_value: multiply(value, definition, scaleMultiplier),
    base_unit: definition.base_unit,
    range_end_base_value: rangeEnd
      ? multiply(rangeEnd, definition, scaleMultiplier)
      : null,
  };
}

export function recomputeAtomV1(claim: AtomicClaimProposal): RecomputedAtomV1 {
  const source = claim.claim_text.normalize('NFC');
  if (
    source.length === 0 ||
    hasForbiddenAtomControl(source) ||
    source.includes('```')
  ) {
    throw new TypeError('claim source contains forbidden control or fence');
  }
  if (
    claim.span.start_utf16 !== 0 ||
    claim.span.end_utf16 !== source.length ||
    !exactAnchor(source, claim.subject) ||
    !exactAnchor(source, claim.predicate) ||
    (claim.subject.start_utf16 < claim.predicate.end_utf16 &&
      claim.subject.end_utf16 > claim.predicate.start_utf16)
  ) {
    throw new TypeError('claim anchor or span mismatch');
  }
  const lexical = internalLexQuantities(source);
  const analyzed = analyzeAtomicTextV1(source);
  const polarity = analyzed.polarity;
  const quantifier = analyzed.quantifier;
  if (polarity !== claim.polarity) {
    throw new TypeError('claim polarity mismatch');
  }
  if (quantifier !== claim.quantifier) {
    throw new TypeError('claim quantifier mismatch');
  }
  if (lexical.length !== claim.quantities.length) {
    throw new TypeError('claim quantity cardinality mismatch');
  }
  const seenIds = new Set<string>();
  const seenRanges: Array<[number, number]> = [];
  for (let index = 0; index < lexical.length; index += 1) {
    const expected = lexical[index];
    const proposed = claim.quantities[index];
    if (
      seenIds.has(proposed.quantity_id) ||
      proposed.start_utf16 < 0 ||
      proposed.start_utf16 >= proposed.end_utf16 ||
      proposed.end_utf16 > source.length ||
      seenRanges.some(
        ([start, end]) =>
          proposed.start_utf16 < end && proposed.end_utf16 > start,
      )
    ) {
      throw new TypeError('claim quantity ID, offset, or overlap mismatch');
    }
    seenIds.add(proposed.quantity_id);
    seenRanges.push([proposed.start_utf16, proposed.end_utf16]);
    const canonical = canonicalProposalQuantity(proposed);
    if (
      proposed.surface.normalize('NFC') !== expected.surface_nfc ||
      proposed.start_utf16 !== expected.start_utf16 ||
      proposed.end_utf16 !== expected.end_utf16 ||
      proposed.dimension !== expected.dimension ||
      proposed.comparator !== expected.comparator ||
      fixedToString(parseArabicFixed(proposed.value) as FixedDecimal) !==
        expected.lexical_value ||
      (proposed.unit?.normalize('NFC') ?? null) !== expected.lexical_unit ||
      (proposed.range_end === null
        ? null
        : fixedToString(
            parseArabicFixed(proposed.range_end) as FixedDecimal,
          )) !== expected.lexical_range_end ||
      canonical.base_value !== expected.base_value ||
      canonical.base_unit !== expected.base_unit ||
      canonical.range_end_base_value !== expected.range_end_base_value
    ) {
      throw new TypeError('claim quantity fields mismatch');
    }
  }
  const exactOnly = !analyzed.typed_equivalence_eligible;
  return {
    source_claim_text_nfc: source,
    subject_anchor: {
      surface_nfc: claim.subject.surface.normalize('NFC'),
      start_utf16: claim.subject.start_utf16,
      end_utf16: claim.subject.end_utf16,
    },
    predicate_anchor: {
      surface_nfc: claim.predicate.surface.normalize('NFC'),
      start_utf16: claim.predicate.start_utf16,
      end_utf16: claim.predicate.end_utf16,
    },
    polarity,
    quantifier,
    quantities: lexical.map((quantity) => ({
      ...toPublicQuantity(quantity),
      typed_equivalence_eligible:
        quantity.typed_equivalence_eligible && !exactOnly,
    })),
  };
}

export function sortEvidenceIdsV1(values: string[]): string[] {
  return directUtf16Sort([...values]);
}
