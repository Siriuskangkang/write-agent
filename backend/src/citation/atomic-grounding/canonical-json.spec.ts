import { canonicalJsonV1, digestCanonicalV1 } from './canonical-json.js';

describe('canonicalJsonV1', () => {
  it('NFC-normalizes strings and sorts object keys by UTF-16 code units', () => {
    expect(
      canonicalJsonV1({
        b: 'e\u0301',
        a: 'é',
      }).toString('utf8'),
    ).toBe('{"a":"é","b":"é"}');

    expect(
      canonicalJsonV1({
        '\uE000': 1,
        '😀': 2,
      }).toString('utf8'),
    ).toBe('{"😀":2,"":1}');
  });

  it('keeps UTF-16 key order for integer-like object keys', () => {
    expect(
      canonicalJsonV1({
        '2': 'second',
        '10': 'first',
        a: 'last',
      }).toString('utf8'),
    ).toBe('{"10":"first","2":"second","a":"last"}');
  });

  it('preserves array order and drops undefined object fields', () => {
    expect(
      canonicalJsonV1({
        values: ['second', 'first'],
        dropped: undefined,
      }).toString('utf8'),
    ).toBe('{"values":["second","first"]}');
  });

  it.each([
    ['array undefined', [1, undefined]],
    ['sparse array', Array(1)],
    ['positive infinity', { value: Number.POSITIVE_INFINITY }],
    ['NaN', { value: Number.NaN }],
    ['unsafe integer', { value: Number.MAX_SAFE_INTEGER + 1 }],
    ['date prototype', { value: new Date(0) }],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJsonV1(value)).toThrow();
  });

  it('rejects symbol-keyed fields instead of silently dropping them', () => {
    const value = { visible: true, [Symbol('secret')]: false };

    expect(() => canonicalJsonV1(value)).toThrow();
  });

  it('normalizes negative zero as the JSON number zero', () => {
    expect(canonicalJsonV1({ value: -0 }).toString('utf8')).toBe('{"value":0}');
  });

  it.each([
    ['isolated high surrogate value', { value: 'A\uD800B' }],
    ['isolated low surrogate value', { value: 'A\uDC00B' }],
    ['isolated high surrogate key', { ['A\uD800B']: true }],
    ['isolated low surrogate key', { ['A\uDC00B']: true }],
  ])('rejects %s before UTF-8 encoding', (_name, value) => {
    expect(() => canonicalJsonV1(value)).toThrow();
  });

  it('rejects an isolated surrogate in a digest version tag', () => {
    expect(() => digestCanonicalV1('bad\uD800tag', { valid: true })).toThrow();
  });

  it('preserves valid astral pairs with one-to-one UTF-8 bytes and a fixed digest', () => {
    const canonical = canonicalJsonV1({ value: 'A😀𐐷B' });

    expect(canonical.toString('utf8')).toBe('{"value":"A😀𐐷B"}');
    expect(canonical.byteLength).toBe(22);
    expect(digestCanonicalV1('scalar-fixture.v1', { value: 'A😀𐐷B' })).toBe(
      '1e661cb940826878d6f8d6fbfdc5cbc709b846827bfc470b4062771b57b2eb4f',
    );
  });

  it('produces exact version-tagged SHA-256 golden digests', () => {
    expect(
      digestCanonicalV1('fixture.v1', {
        b: 'e\u0301',
        a: 'é',
      }),
    ).toBe('6f85cefa75f39201a4c4a5291241c787f58bb64176e1d827b4a341f414bb51f5');
    expect(
      digestCanonicalV1('fixture.v1', {
        '\uE000': 1,
        '😀': 2,
      }),
    ).toBe('b62d5785980e8fdd1215c01b0e623af8d34ebb161b5fc51d0f3f6a0e2f81d8ac');
  });
});
