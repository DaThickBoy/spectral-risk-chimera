// Task 9.1, AT-MD-17: the market data port, normalization, and the in-code fixture provider.
// Proves the 9.1 / 9.2 split: lexical and structural errors reject the payload, while
// observation-level defects (zero, negative, missing, non-finite, weekend, duplicate) reach the
// ProviderSeries unchanged for the 9.2 cleaner.
// Validates: Requirements 4.2, 4.6, 12.1, 12.2, 12.3, 12.6, 12.8, 26.3, 27.3
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FixtureMarketDataProvider, normalizeSeries } from '../../../src/marketdata/index.js';
import type { MarketDataFixtures, ProviderSeries } from '../../../src/marketdata/index.js';
import { FakeClock, LosslessJsonNumber } from '../../../src/shared/index.js';
import type { ProviderError, Result } from '../../../src/shared/index.js';

const NOW = '2026-11-08T09:30:00.000Z';
const RANGE = { from: '2026-11-01', to: '2026-11-30' };

const provider = (fixtures: MarketDataFixtures, name = 'fixture-md', clock = new FakeClock(NOW)) =>
  new FixtureMarketDataProvider({ name, clock, fixtures });

const series = (observations: unknown[], extra: Record<string, unknown> = {}) => ({
  series: { ACME: { ticker: 'ACME', currency: 'USD', observations, ...extra } },
});

const value = <T>(result: Result<T, ProviderError>): T => {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
};

const errorOf = <T>(result: Result<T, ProviderError>): ProviderError => {
  if (result.ok) {
    throw new Error('expected an error');
  }
  return result.error;
};

const invalidSeries = (operation: 'getDailySeries' | 'getLatestPrice' = 'getDailySeries'): ProviderError => ({
  code: 'INVALID_RESPONSE',
  message: `Provider call fixture-md ${operation} failed (INVALID_RESPONSE).`,
  provider: 'fixture-md',
  operation,
  attempts: 1,
  retryable: false,
});

/** Independent of canonicalJson: the canonical text is written out by hand. */
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('AT-MD-17: a fixture payload becomes a normalized ProviderSeries', () => {
  it('records ticker, currency, source, DEMO kind, retrieval time, received-order observations, and the content hash', async () => {
    const p = provider(
      series([
        { date: '2026-11-03', adjustedClose: '101.25' },
        { date: '2026-11-02', adjustedClose: '100.5' },
      ]),
    );
    expect(p.kind).toBe('DEMO');
    const result = value(await p.getDailySeries('ACME', RANGE));
    expect(result).toEqual({
      ticker: 'ACME',
      currency: 'USD',
      source: 'fixture-md',
      sourceKind: 'DEMO',
      retrievedAt: NOW,
      observations: [
        { date: '2026-11-03', adjustedClose: '101.25' },
        { date: '2026-11-02', adjustedClose: '100.5' },
      ],
      contentHash: sha(
        '{"currency":"USD","observations":[{"adjustedClose":"101.25","date":"2026-11-03"},{"adjustedClose":"100.5","date":"2026-11-02"}],"ticker":"ACME"}',
      ),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.observations)).toBe(true);
    expect(Object.isFrozen(result.observations[0])).toBe(true);
  });

  it('retrievedAt comes from the injected clock at each call', async () => {
    const clock = new FakeClock(NOW);
    const p = provider(series([{ date: '2026-11-02', adjustedClose: '1' }]), 'fixture-md', clock);
    clock.advance(1_500);
    expect(value(await p.getDailySeries('ACME', RANGE)).retrievedAt).toBe('2026-11-08T09:30:01.500Z');
  });

  it('the content hash excludes source and retrieval time, and depends on order and defects', async () => {
    const obs = [
      { date: '2026-11-02', adjustedClose: '1' },
      { date: '2026-11-03', adjustedClose: '2' },
    ];
    const a = value(
      await provider(series(obs), 'vendor-a', new FakeClock(NOW)).getDailySeries('ACME', RANGE),
    );
    const b = value(
      await provider(series(obs), 'vendor-b', new FakeClock('2030-01-01T00:00:00.000Z')).getDailySeries(
        'ACME',
        RANGE,
      ),
    );
    expect(a.contentHash).toBe(b.contentHash);
    const reversed = value(await provider(series([...obs].reverse())).getDailySeries('ACME', RANGE));
    expect(reversed.contentHash).not.toBe(a.contentHash);
    const withDefect = value(
      await provider(series([obs[0], { date: '2026-11-03', adjustedClose: null }])).getDailySeries(
        'ACME',
        RANGE,
      ),
    );
    expect(withDefect.contentHash).toBe(
      sha(
        '{"currency":"USD","observations":[{"adjustedClose":"1","date":"2026-11-02"},{"adjustedClose":null,"date":"2026-11-03","defect":"MISSING"}],"ticker":"ACME"}',
      ),
    );
  });
});

describe('observation-level defects survive intact for task 9.2', () => {
  it.each([
    ['zero', '0'],
    ['negative zero', '-0'],
    ['zero with fraction digits', '0.000'],
    ['a negative decimal', '-3.5'],
    ['trailing fractional zeros (not canonicalized)', '101.2500'],
    ['a long fraction', '0.0000000000000000000000000000000000000001'],
  ])('%s is kept exactly as text', async (_label, text) => {
    const result = value(
      await provider(series([{ date: '2026-11-02', adjustedClose: text }])).getDailySeries('ACME', RANGE),
    );
    expect(result.observations).toEqual([{ date: '2026-11-02', adjustedClose: text }]);
  });

  it('a LosslessJsonNumber is kept as its exact token text', async () => {
    const result = value(
      await provider(
        series([
          { date: '2026-11-02', adjustedClose: new LosslessJsonNumber('101.250') },
          { date: '2026-11-03', adjustedClose: new LosslessJsonNumber('-0') },
        ]),
      ).getDailySeries('ACME', RANGE),
    );
    expect(result.observations).toEqual([
      { date: '2026-11-02', adjustedClose: '101.250' },
      { date: '2026-11-03', adjustedClose: '-0' },
    ]);
  });

  it('a null or absent adjusted close is MISSING, never zero or filled', async () => {
    const result = value(
      await provider(
        series([{ date: '2026-11-02', adjustedClose: null }, { date: '2026-11-03' }]),
      ).getDailySeries('ACME', RANGE),
    );
    expect(result.observations).toEqual([
      { date: '2026-11-02', adjustedClose: null, defect: 'MISSING' },
      { date: '2026-11-03', adjustedClose: null, defect: 'MISSING' },
    ]);
  });

  it.each(['NaN', 'Infinity', '-Infinity'] as const)(
    '%s is a NOT_FINITE marker, not a number',
    async (marker) => {
      const result = value(
        await provider(series([{ date: '2026-11-02', adjustedClose: marker }])).getDailySeries('ACME', RANGE),
      );
      expect(result.observations).toEqual([
        { date: '2026-11-02', adjustedClose: null, defect: 'NOT_FINITE', nonFinite: marker },
      ]);
      expect(typeof result.observations[0]?.adjustedClose).not.toBe('number');
    },
  );

  it('weekend dates and duplicate dates (identical or conflicting) are kept in received order', async () => {
    const obs = [
      { date: '2026-11-07', adjustedClose: '10' }, // Saturday
      { date: '2026-11-08', adjustedClose: '11' }, // Sunday
      { date: '2026-11-09', adjustedClose: '12' },
      { date: '2026-11-09', adjustedClose: '12' },
      { date: '2026-11-09', adjustedClose: '13' },
    ];
    const result = value(await provider(series(obs)).getDailySeries('ACME', RANGE));
    expect(result.observations).toEqual(obs);
  });

  it('a mixed series keeps every defect alongside valid values', async () => {
    const result = value(
      await provider(
        series([
          { date: '2026-11-02', adjustedClose: '100' },
          { date: '2026-11-03', adjustedClose: '0' },
          { date: '2026-11-04', adjustedClose: null },
          { date: '2026-11-05', adjustedClose: 'NaN' },
          { date: '2026-11-06', adjustedClose: '-1' },
          { date: '2026-11-07', adjustedClose: 'Infinity' },
        ]),
      ).getDailySeries('ACME', RANGE),
    );
    expect(result.observations.map((o) => ('defect' in o ? o.defect : o.adjustedClose))).toEqual([
      '100',
      '0',
      'MISSING',
      'NOT_FINITE',
      '-1',
      'NOT_FINITE',
    ]);
  });
});

describe('lexical and structural errors reject the whole payload (INVALID_RESPONSE)', () => {
  const rejects = async (fixtures: MarketDataFixtures, ticker = 'ACME') => {
    expect(errorOf(await provider(fixtures).getDailySeries(ticker, RANGE))).toEqual(invalidSeries());
  };

  it.each([
    ['exponent notation', '1e-5'],
    ['upper-case exponent', '2E3'],
    ['exponent with a fraction', '1.5e2'],
    ['a plus sign', '+1.5'],
    ['a leading dot', '.5'],
    ['a trailing dot', '1.'],
    ['a leading zero', '01.5'],
    ['a thousands separator', '1,000.5'],
    ['leading whitespace', ' 1.5'],
    ['trailing whitespace', '1.5 '],
    ['an empty string', ''],
    ['lower-case nan', 'nan'],
    ['a short infinity', 'inf'],
    ['a signed infinity', '+Infinity'],
    ['an infinity with whitespace', 'Infinity '],
    ['a currency symbol', '$1.50'],
  ])('a price with %s (%j)', async (_label, text) => {
    await rejects(series([{ date: '2026-11-02', adjustedClose: text }]));
  });

  it.each([
    ['a JavaScript number', 101.25],
    ['a JavaScript integer', 101],
    ['NaN as a number', Number.NaN],
    ['Infinity as a number', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['an object', { value: '1' }],
    ['an array', ['1']],
    ['a bigint', 101n],
  ])('a price given as %s', async (_label, raw) => {
    await rejects(series([{ date: '2026-11-02', adjustedClose: raw }]));
  });

  it.each(['1e-5', '2E3', '1.0e10'])('an exponent LosslessJsonNumber token %s', async (token) => {
    await rejects(series([{ date: '2026-11-02', adjustedClose: new LosslessJsonNumber(token) }]));
  });

  it.each([
    ['a timestamp', '2026-11-02T00:00:00.000Z'],
    ['a date with a time', '2026-11-02 00:00'],
    ['an impossible date', '2026-02-30'],
    ['a compact date', '20261102'],
    ['an unpadded date', '2026-11-2'],
    ['a number', 20261102],
    ['an empty string', ''],
  ])('a date given as %s', async (_label, date) => {
    await rejects(series([{ date, adjustedClose: '1' }]));
  });

  it('a missing date', async () => {
    await rejects(series([{ adjustedClose: '1' }]));
  });

  it.each([
    ['another ticker', 'EVIL'],
    ['different case', 'acme'],
    ['leading whitespace', ' ACME'],
    ['trailing whitespace', 'ACME '],
    ['an empty ticker', ''],
    ['a number', 42],
  ])('a payload ticker that is %s', async (_label, ticker) => {
    await rejects({ series: { ACME: { ticker, currency: 'USD', observations: [] } } });
  });

  it.each([
    ['lower case', 'usd'],
    ['two letters', 'US'],
    ['unknown code', 'XQZ'],
    ['a number', 840],
  ])('a currency in %s', async (_label, currency) => {
    await rejects({ series: { ACME: { ticker: 'ACME', currency, observations: [] } } });
  });

  it.each([
    ['an unknown top-level field', series([], { sourceKind: 'REAL' })],
    ['an unknown observation field', series([{ date: '2026-11-02', adjustedClose: '1', close: '1' }])],
    ['missing observations', { series: { ACME: { ticker: 'ACME', currency: 'USD' } } }],
    [
      'observations that are not an array',
      { series: { ACME: { ticker: 'ACME', currency: 'USD', observations: {} } } },
    ],
    ['a null payload', { series: { ACME: null } }],
    ['an array payload', { series: { ACME: [] } }],
    ['a string payload', { series: { ACME: 'ACME,USD' } }],
  ])('%s', async (_label, fixtures) => {
    await rejects(fixtures as MarketDataFixtures);
  });

  it('an invalid observation outside the requested range still rejects the payload', async () => {
    await rejects(
      series([
        { date: '2026-10-01', adjustedClose: '1e3' },
        { date: '2026-11-02', adjustedClose: '1' },
      ]),
    );
  });

  it('error messages never contain the ticker or payload content', async () => {
    const error = errorOf(
      await provider(series([{ date: '2026-11-02', adjustedClose: 'SECRET-VALUE' }])).getDailySeries(
        'ACME',
        RANGE,
      ),
    );
    expect(JSON.stringify(error)).not.toContain('SECRET-VALUE');
    expect(error.message).not.toContain('ACME');
  });
});

describe('DateRange and ticker arguments', () => {
  const obs = [
    { date: '2026-10-31', adjustedClose: '1' },
    { date: '2026-11-01', adjustedClose: '2' },
    { date: '2026-11-15', adjustedClose: '3' },
    { date: '2026-11-30', adjustedClose: '4' },
    { date: '2026-12-01', adjustedClose: '5' },
  ];

  it('returns observations within the inclusive range, in received order', async () => {
    const result = value(await provider(series(obs)).getDailySeries('ACME', RANGE));
    expect(result.observations.map((o) => o.date)).toEqual(['2026-11-01', '2026-11-15', '2026-11-30']);
  });

  it('a single-day range is valid', async () => {
    const result = value(
      await provider(series(obs)).getDailySeries('ACME', { from: '2026-11-15', to: '2026-11-15' }),
    );
    expect(result.observations).toEqual([{ date: '2026-11-15', adjustedClose: '3' }]);
  });

  it('no observations in range is a success with an empty list', async () => {
    const result = value(
      await provider(series(obs)).getDailySeries('ACME', { from: '2027-01-01', to: '2027-01-31' }),
    );
    expect(result.observations).toEqual([]);
    expect(result.contentHash).toBe(sha('{"currency":"USD","observations":[],"ticker":"ACME"}'));
  });

  /** A fixtures table that counts every lookup. */
  const countingFixtures = () => {
    let lookups = 0;
    const table = new Proxy(
      { ACME: { ticker: 'ACME', currency: 'USD', observations: [] } },
      {
        getOwnPropertyDescriptor: (target, key) => {
          lookups += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get: (target, key, receiver) => {
          lookups += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    return { fixtures: { series: table, quotes: table }, lookups: () => lookups };
  };

  it.each([
    ['from after to', { from: '2026-11-30', to: '2026-11-01' }],
    ['an impossible date', { from: '2026-02-30', to: '2026-03-01' }],
    ['a timestamp', { from: '2026-11-01T00:00:00Z', to: '2026-11-30' }],
    ['a missing bound', { from: '2026-11-01' }],
    ['null', null],
    ['a string', '2026-11-01..2026-11-30'],
  ])('an invalid range (%s) throws TypeError before any lookup', (_label, range) => {
    const { fixtures, lookups } = countingFixtures();
    expect(() => provider(fixtures).getDailySeries('ACME', range as never)).toThrow(TypeError);
    expect(lookups()).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['a number', 42],
    ['undefined', undefined],
  ])('an invalid requested ticker (%s) throws TypeError before any lookup', (_label, ticker) => {
    const { fixtures, lookups } = countingFixtures();
    const p = provider(fixtures);
    expect(() => p.getDailySeries(ticker as never, RANGE)).toThrow(TypeError);
    expect(() => p.getLatestPrice(ticker as never)).toThrow(TypeError);
    expect(lookups()).toBe(0);
  });
});

describe('missing fixture data is HTTP_CLIENT_ERROR 404', () => {
  const notFound = (operation: 'getDailySeries' | 'getLatestPrice'): ProviderError => ({
    code: 'HTTP_CLIENT_ERROR',
    message: `Provider call fixture-md ${operation} failed (HTTP_CLIENT_ERROR).`,
    provider: 'fixture-md',
    operation,
    attempts: 1,
    retryable: false,
    httpStatus: 404,
  });

  it.each(['OTHER', '__proto__', 'toString', 'constructor', 'hasOwnProperty'])(
    'ticker %s with no fixture data (prototype keys never resolve)',
    async (ticker) => {
      const p = provider(series([{ date: '2026-11-02', adjustedClose: '1' }]));
      expect(errorOf(await p.getDailySeries(ticker, RANGE))).toEqual(notFound('getDailySeries'));
      expect(errorOf(await p.getLatestPrice(ticker))).toEqual(notFound('getLatestPrice'));
    },
  );

  it('no series or quote tables at all', async () => {
    const p = provider({});
    expect(errorOf(await p.getDailySeries('ACME', RANGE))).toEqual(notFound('getDailySeries'));
    expect(errorOf(await p.getLatestPrice('ACME'))).toEqual(notFound('getLatestPrice'));
  });

  it('an empty quote list', async () => {
    expect(errorOf(await provider({ quotes: { ACME: [] } }).getLatestPrice('ACME'))).toEqual(
      notFound('getLatestPrice'),
    );
  });
});

describe('getLatestPrice: strict quotes; asOf is the exchange date; ambiguity is rejected', () => {
  const quote = (asOf: string, price: unknown, extra: Record<string, unknown> = {}) => ({
    ticker: 'ACME',
    currency: 'USD',
    asOf,
    price,
    ...extra,
  });
  const quotes = (...items: unknown[]): MarketDataFixtures => ({ quotes: { ACME: items } });

  it('returns the quote with the latest asOf, whatever the order', async () => {
    const result = value(
      await provider(
        quotes(quote('2026-11-05', '10.5'), quote('2026-11-06', '11.25'), quote('2026-11-04', '9')),
      ).getLatestPrice('ACME'),
    );
    expect(result).toEqual({
      ticker: 'ACME',
      currency: 'USD',
      price: '11.25',
      asOf: '2026-11-06',
      source: 'fixture-md',
      sourceKind: 'DEMO',
      retrievedAt: NOW,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('keeps the price text exactly, including a LosslessJsonNumber token', async () => {
    expect(value(await provider(quotes(quote('2026-11-06', '5.10'))).getLatestPrice('ACME')).price).toBe(
      '5.10',
    );
    expect(
      value(
        await provider(quotes(quote('2026-11-06', new LosslessJsonNumber('5.100')))).getLatestPrice('ACME'),
      ).price,
    ).toBe('5.100');
  });

  it('equally latest quotes are ambiguous, even with the same price', async () => {
    for (const second of ['12', '11.25']) {
      const p = provider(
        quotes(quote('2026-11-06', '11.25'), quote('2026-11-06', second), quote('2026-11-05', '1')),
      );
      expect(errorOf(await p.getLatestPrice('ACME'))).toEqual(invalidSeries('getLatestPrice'));
    }
  });

  it('ties on an earlier date do not matter when a single latest quote exists', async () => {
    const p = provider(quotes(quote('2026-11-05', '1'), quote('2026-11-05', '2'), quote('2026-11-06', '3')));
    expect(value(await p.getLatestPrice('ACME')).price).toBe('3');
  });

  it('quotes that disagree on currency are rejected rather than chosen between', async () => {
    const p = provider(quotes(quote('2026-11-05', '1'), quote('2026-11-06', '2', { currency: 'EUR' })));
    expect(errorOf(await p.getLatestPrice('ACME'))).toEqual(invalidSeries('getLatestPrice'));
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1.5'],
    ['negative zero', '-0'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['null', null],
    ['exponent notation', '1e2'],
    ['an exponent token', new LosslessJsonNumber('1e2')],
    ['a JavaScript number', 11.25],
    ['malformed text', '11,25'],
  ])('a %s price is rejected (no defect markers for quotes)', async (_label, price) => {
    const p = provider(quotes(quote('2026-11-06', price)));
    expect(errorOf(await p.getLatestPrice('ACME'))).toEqual(invalidSeries('getLatestPrice'));
  });

  it.each([
    ['a timestamp asOf', quote('2026-11-06T16:00:00Z', '1')],
    ['an impossible asOf', quote('2026-02-30', '1')],
    ['another ticker', { ...quote('2026-11-06', '1'), ticker: 'EVIL' }],
    ['a lower-case ticker', { ...quote('2026-11-06', '1'), ticker: 'acme' }],
    ['an invalid currency', { ...quote('2026-11-06', '1'), currency: 'usd' }],
    ['an unknown field', quote('2026-11-06', '1', { mode: 'REAL' })],
    ['a missing price', { ticker: 'ACME', currency: 'USD', asOf: '2026-11-06' }],
  ])('%s is rejected', async (_label, item) => {
    expect(errorOf(await provider(quotes(item)).getLatestPrice('ACME'))).toEqual(
      invalidSeries('getLatestPrice'),
    );
  });

  it('one invalid quote rejects the whole set instead of being skipped', async () => {
    const p = provider(quotes(quote('2026-11-06', '1'), quote('2026-11-05', '1e2')));
    expect(errorOf(await p.getLatestPrice('ACME'))).toEqual(invalidSeries('getLatestPrice'));
  });

  it('a quote table entry that is not an array is rejected', async () => {
    expect(
      errorOf(await provider({ quotes: { ACME: quote('2026-11-06', '1') } }).getLatestPrice('ACME')),
    ).toEqual(invalidSeries('getLatestPrice'));
  });
});

describe('construction and the DEMO label', () => {
  it('requires a non-empty name', () => {
    for (const name of ['', 42, undefined]) {
      expect(
        () => new FixtureMarketDataProvider({ name: name as never, clock: new FakeClock(NOW), fixtures: {} }),
      ).toThrow(TypeError);
    }
  });

  it('fixture results are always DEMO; a payload cannot claim REAL', async () => {
    const p = provider(series([{ date: '2026-11-02', adjustedClose: '1' }]));
    expect(value(await p.getDailySeries('ACME', RANGE)).sourceKind).toBe('DEMO');
    expect(
      errorOf(await provider(series([], { sourceKind: 'REAL' })).getDailySeries('ACME', RANGE)).code,
    ).toBe('INVALID_RESPONSE');
  });
});

describe('normalizeSeries (reused by the real adapter in 9.6)', () => {
  const context = { ticker: 'ACME', source: 'vendor', sourceKind: 'REAL' as const, retrievedAt: NOW };

  it('reports the reason without payload content', () => {
    const schema = normalizeSeries(
      { ticker: 'ACME', currency: 'USD', observations: [{ date: 'x' }] },
      RANGE,
      context,
    );
    expect(!schema.ok && schema.error).toEqual({
      code: 'INVALID_RESPONSE',
      message: 'Market data payload rejected (SCHEMA).',
      reason: 'SCHEMA',
    });
    const mismatch = normalizeSeries({ ticker: 'EVIL', currency: 'USD', observations: [] }, RANGE, context);
    expect(!mismatch.ok && mismatch.error.reason).toBe('TICKER_MISMATCH');
  });

  it('keeps the caller-supplied sourceKind (REAL for a real adapter)', () => {
    const result = normalizeSeries({ ticker: 'ACME', currency: 'USD', observations: [] }, RANGE, context);
    expect(result.ok && result.value.sourceKind).toBe('REAL');
  });
});

describe('properties: valid decimal text survives exactly; exponent text never does', () => {
  const digits = (min: number, max: number) =>
    fc.string({
      unit: fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
      minLength: min,
      maxLength: max,
    });
  const decimalText = fc
    .tuple(
      fc.boolean(),
      fc.oneof(
        fc.constant('0'),
        fc.tuple(fc.constantFrom('1', '2', '9'), digits(0, 6)).map(([a, b]) => a + b),
      ),
      fc.option(digits(1, 8), { nil: undefined }),
    )
    .map(
      ([negative, whole, fraction]) =>
        `${negative ? '-' : ''}${whole}${fraction === undefined ? '' : `.${fraction}`}`,
    );

  it('any decimal text of any sign is preserved exactly, as a string or a LosslessJsonNumber', async () => {
    await fc.assert(
      fc.asyncProperty(decimalText, fc.boolean(), async (text, asToken) => {
        const raw = asToken ? new LosslessJsonNumber(text) : text;
        const result = await provider(series([{ date: '2026-11-02', adjustedClose: raw }])).getDailySeries(
          'ACME',
          RANGE,
        );
        expect(result.ok && result.value.observations).toEqual([{ date: '2026-11-02', adjustedClose: text }]);
      }),
      { numRuns: 300 },
    );
  });

  it('any exponent form is rejected, as a string or a LosslessJsonNumber', async () => {
    const exponent = fc
      .tuple(decimalText, fc.constantFrom('e', 'E'), fc.constantFrom('', '+', '-'), digits(1, 3))
      .map(([base, e, sign, power]) => `${base}${e}${sign}${power}`);
    await fc.assert(
      fc.asyncProperty(exponent, fc.boolean(), async (text, asToken) => {
        const raw = asToken ? new LosslessJsonNumber(text) : text;
        const result = await provider(series([{ date: '2026-11-02', adjustedClose: raw }])).getDailySeries(
          'ACME',
          RANGE,
        );
        expect(!result.ok && result.error.code).toBe('INVALID_RESPONSE');
      }),
      { numRuns: 300 },
    );
  });

  it('observations within the range come back in received order, one for one, defects included', async () => {
    const cell = fc.oneof(decimalText, fc.constant(null), fc.constantFrom('NaN', 'Infinity', '-Infinity'));
    const observation = fc.tuple(fc.integer({ min: 1, max: 30 }), cell).map(([day, close]) => ({
      date: `2026-11-${String(day).padStart(2, '0')}`,
      adjustedClose: close,
    }));
    await fc.assert(
      fc.asyncProperty(
        fc.array(observation, { maxLength: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        async (obs, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const range = {
            from: `2026-11-${String(lo).padStart(2, '0')}`,
            to: `2026-11-${String(hi).padStart(2, '0')}`,
          };
          const result: ProviderSeries = value(await provider(series(obs)).getDailySeries('ACME', range));
          const expected = obs.filter((o) => o.date >= range.from && o.date <= range.to);
          expect(result.observations.map((o) => o.date)).toEqual(expected.map((o) => o.date));
          result.observations.forEach((o, i) => {
            const source = expected[i]?.adjustedClose;
            if (source === null) {
              expect(o).toMatchObject({ adjustedClose: null, defect: 'MISSING' });
            } else if (source === 'NaN' || source === 'Infinity' || source === '-Infinity') {
              expect(o).toMatchObject({ adjustedClose: null, defect: 'NOT_FINITE', nonFinite: source });
            } else {
              expect(o.adjustedClose).toBe(source);
            }
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});
