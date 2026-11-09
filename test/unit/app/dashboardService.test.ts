// Dashboard read model (tasks 17.1 to 17.3; DR-KW-1): currency exposure (a Decimal sum of the
// positions' base values), the per-currency FX summary, and FR-14 money display text.
// Validates: Requirements 20.6, 30.14, 35.1
import { describe, expect, it } from 'vitest';
import { currencyExposure, fxSummary } from '../../../src/app/index.js';
import { currencyMinorUnits, formatMoneyDisplay } from '../../../src/shared/index.js';
import type { DecimalString, PositionItemDto } from '../../../src/shared/index.js';

const item = (
  ticker: string,
  currency: string,
  marketValueBase: string | null,
  fx: Partial<PositionItemDto> = {},
) =>
  ({
    ticker,
    currency,
    marketValueBase,
    fxRate: null,
    fxUnavailable: null,
    ...fx,
  }) as unknown as PositionItemDto;

const identity = {
  pair: 'EUREUR',
  rate: '1',
  observedAt: null,
  source: 'BASE_CURRENCY',
  sourceKind: 'IDENTITY',
  status: 'CURRENT',
};
const ecbUsd = {
  pair: 'USDEUR',
  rate: '0.8956560680698611733094491715181370353784',
  observedAt: '2026-11-06T15:00:00.000Z',
  observedAtBasis: 'PUBLICATION_CONVENTION',
  conventionId: 'ECB-PUB-1600-FRANKFURT-v1',
  source: 'ECB-EXR',
  sourceKind: 'REAL',
  status: 'CURRENT',
};

describe('currencyExposure', () => {
  it('known answer: sums base values per currency exactly, sorted by currency', () => {
    expect(
      currencyExposure([
        item('B', 'USD', '100.1'),
        item('A', 'EUR', '8000'),
        item('C', 'USD', '0.2'),
        item('D', 'GBP', '-50.25'),
      ]),
    ).toEqual([
      { currency: 'EUR', status: 'OK', marketValueBase: '8000', tickers: ['A'] },
      { currency: 'GBP', status: 'OK', marketValueBase: '-50.25', tickers: ['D'] },
      // 100.1 + 0.2 = 100.3 exactly (no binary floating point)
      { currency: 'USD', status: 'OK', marketValueBase: '100.3', tickers: ['B', 'C'] },
    ]);
  });

  it('one missing base value makes the whole currency UNAVAILABLE with null, never a partial sum or zero', () => {
    expect(
      currencyExposure([item('B', 'USD', '100'), item('C', 'USD', null), item('A', 'EUR', '1')]),
    ).toEqual([
      { currency: 'EUR', status: 'OK', marketValueBase: '1', tickers: ['A'] },
      { currency: 'USD', status: 'UNAVAILABLE', marketValueBase: null, tickers: ['B', 'C'] },
    ]);
  });

  it('no positions: no currencies', () => {
    expect(currencyExposure([])).toEqual([]);
  });
});

describe('fxSummary', () => {
  it('one entry per currency with the rate used, or why none was used; price-unavailable rows are skipped', () => {
    const summary = fxSummary([
      item('A', 'EUR', '1', { fxRate: identity as never }),
      item('B', 'USD', '2', { fxRate: ecbUsd as never }),
      item('C', 'USD', '3', { fxRate: ecbUsd as never }),
      item('D', 'GBP', null, { fxUnavailable: { code: 'FX_STALE', currency: 'GBP' } }),
      item('E', 'JPY', null),
    ]);
    expect(summary.map((entry) => [entry.currency, entry.status, entry.tickers])).toEqual([
      ['EUR', 'IDENTITY', ['A']],
      ['GBP', 'STALE', ['D']],
      ['USD', 'CURRENT', ['B', 'C']],
    ]);
    expect(summary[2]?.rate).toEqual(ecbUsd);
  });
});

describe('FR-14 money display (backend only)', () => {
  it.each([
    ['1000', 2, '1000.00'],
    ['8956.565', 2, '8956.57'], // ROUND_HALF_UP
    ['8956.564999', 2, '8956.56'],
    ['-0.005', 2, '-0.01'],
    ['0.8956560680698611733094491715181370353784', 2, '0.90'],
    ['1234.5', 0, '1235'],
  ] as const)('%s at %i decimals -> %s', (value, units, text) => {
    expect(formatMoneyDisplay(value as DecimalString, units)).toBe(text);
  });

  it('minor units come from ISO 4217 data', () => {
    expect(['EUR', 'USD', 'GBP', 'JPY'].map(currencyMinorUnits)).toEqual([2, 2, 2, 0]);
    expect(() => currencyMinorUnits('eur')).toThrow(TypeError);
  });
});
