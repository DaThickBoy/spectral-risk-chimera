// Task 6.2: pure ledger replay. AT-POS-01, AT-POS-02, AT-POS-03, AT-POS-05, AT-POS-07,
// and the R28.18 ordering rule. Expected values are hand-calculated (FR-13).
// Validates: Requirements 5.2, 5.3, 5.6, 5.7, 28.18, 28.19, 28.21
import { describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../../../src/persistence/index.js';
import {
  LedgerInvariantError,
  compareLedgerOrder,
  positionId,
  replayPositions,
  toPositionView,
} from '../../../src/portfolio/index.js';
import type { Position } from '../../../src/portfolio/index.js';
import type { ExhaustiveKeys } from '../../../src/portfolio/position.js';
import { samePosition } from '../../../src/portfolio/index.js';
import { brandDecimalString, canonicalJson, isDecimalText, sha256Hex } from '../../../src/shared/index.js';
import { SOURCE_A, SOURCE_B, T0, T1, rows, trade } from '../../helpers/ledger.js';
import type { Row } from '../../helpers/ledger.js';

const PF = 'pf-1';

/** Replays `entries` and returns the single position of ticker AAA. */
function single(entries: readonly TransactionRecord[]): Position {
  const result = replayPositions(PF, entries);
  if (!result.ok) {
    throw new Error(`unexpected ${result.error.code}`);
  }
  expect(result.value).toHaveLength(1);
  const [position] = result.value;
  if (position === undefined) {
    throw new Error('no position');
  }
  return position;
}

const after = (entries: readonly Row[]): Position => single(rows(entries));
const state = (p: Position): [string, string | null, boolean] => [
  p.signedQuantity,
  p.averagePrice,
  p.isShort,
];

describe('AT-POS-01: average price after a sequence of BUYs', () => {
  it('matches the hand-calculated weighted average', () => {
    // 10 @ 100 -> avg 100; +30 @ 120 -> (1000 + 3600) / 40 = 115;
    // +60 @ 90 -> (40 * 115 + 5400) / 100 = (4600 + 5400) / 100 = 100.
    expect(state(after([['BUY', '10', '100']]))).toEqual(['10', '100', false]);
    expect(
      state(
        after([
          ['BUY', '10', '100'],
          ['BUY', '30', '120'],
        ]),
      ),
    ).toEqual(['40', '115', false]);
    expect(
      state(
        after([
          ['BUY', '10', '100'],
          ['BUY', '30', '120'],
          ['BUY', '60', '90'],
        ]),
      ),
    ).toEqual(['100', '100', false]);
  });

  it('keeps exact decimals: 0.1 + 0.2 shares at fractional prices', () => {
    // (0.1 * 10.05 + 0.2 * 10.35) / 0.3 = (1.005 + 2.07) / 0.3 = 3.075 / 0.3 = 10.25.
    expect(
      state(
        after([
          ['BUY', '0.1', '10.05'],
          ['BUY', '0.2', '10.35'],
        ]),
      ),
    ).toEqual(['0.3', '10.25', false]);
  });

  it('holds a non-terminating quotient to 40 significant digits, ROUND_HALF_UP (FR-13 rule 6)', () => {
    // (1 * 1 + 2 * 2) / 3 = 5/3 = 1.666...; 40 significant digits: "1." + 38 sixes + "7".
    const p = after([
      ['BUY', '1', '1'],
      ['BUY', '2', '2'],
    ]);
    expect(p.averagePrice).toBe(`1.${'6'.repeat(38)}7`);
  });
});

describe('AT-POS-02: a SELL leaves the average unchanged; zero quantity resets it', () => {
  it('a reducing SELL does not change the average price', () => {
    // 10 @ 100, 10 @ 110 -> 20 @ 105; SELL 5 @ 200 -> 15 @ 105 (sale price ignored).
    expect(
      state(
        after([
          ['BUY', '10', '100'],
          ['BUY', '10', '110'],
          ['SELL', '5', '200'],
        ]),
      ),
    ).toEqual(['15', '105', false]);
  });

  it('reaching zero resets the average to null and keeps the position, not short', () => {
    const flat = after([
      ['BUY', '10', '100'],
      ['BUY', '10', '110'],
      ['SELL', '20', '90'],
    ]);
    expect(state(flat)).toEqual(['0', null, false]);
  });

  it('after a reset the next BUY opens at its own price', () => {
    // Flat, then BUY 4 @ 50 -> avg 50 (the old 105 no longer counts).
    expect(
      state(
        after([
          ['BUY', '10', '100'],
          ['BUY', '10', '110'],
          ['SELL', '20', '90'],
          ['BUY', '4', '50'],
        ]),
      ),
    ).toEqual(['4', '50', false]);
  });
});

describe('AT-POS-05: reversals and short positions', () => {
  it('a SELL crossing zero closes the long and opens the remainder short at the SELL price', () => {
    // Long 10 @ 100, SELL 15 @ 120 -> close 10, open 5 short @ 120.
    expect(
      state(
        after([
          ['BUY', '10', '100'],
          ['SELL', '15', '120'],
        ]),
      ),
    ).toEqual(['-5', '120', true]);
  });

  it('a SELL on a flat position opens a short at the SELL price', () => {
    expect(state(after([['SELL', '3', '80']]))).toEqual(['-3', '80', true]);
  });

  it('a SELL on a short increases it with the weighted average on the absolute quantity', () => {
    // -5 @ 120, SELL 5 @ 100 -> (5 * 120 + 5 * 100) / 10 = 110, qty -10.
    expect(
      state(
        after([
          ['SELL', '5', '120'],
          ['SELL', '5', '100'],
        ]),
      ),
    ).toEqual(['-10', '110', true]);
  });

  it('a BUY reducing a short leaves the average unchanged; covering it fully resets', () => {
    const base: Row[] = [
      ['SELL', '5', '120'],
      ['SELL', '5', '100'],
    ];
    expect(state(after([...base, ['BUY', '4', '80']]))).toEqual(['-6', '110', true]);
    expect(state(after([...base, ['BUY', '4', '80'], ['BUY', '6', '130']]))).toEqual(['0', null, false]);
  });

  it('a BUY crossing zero closes the short and opens the remainder long at the BUY price', () => {
    // -10 @ 110, BUY 14 @ 90 -> close 10, open 4 long @ 90.
    expect(
      state(
        after([
          ['SELL', '5', '120'],
          ['SELL', '5', '100'],
          ['BUY', '14', '90'],
        ]),
      ),
    ).toEqual(['4', '90', false]);
  });
});

describe('AT-POS-03: position fields, canonical strings, one netted position per instrument', () => {
  it('exposes every R5.2 field; valuation fields are null with status NOT_VALUED', () => {
    const view = toPositionView(
      after([
        ['BUY', '10.5', '2'],
        ['BUY', '9.5', '3'],
        ['SELL', '0.5', '9'],
      ]),
    );
    expect(Object.keys(view).sort()).toEqual(
      [
        'id',
        'portfolioId',
        'ticker',
        'currency',
        'signedQuantity',
        'averagePrice',
        'isShort',
        'marketPrice',
        'marketValueInstrument',
        'marketValueBase',
        'allocationPct',
        'valuationStatus',
        'source',
        'updatedAt',
      ].sort(),
    );
    // (10.5 * 2 + 9.5 * 3) / 20 = (21 + 28.5) / 20 = 2.475; qty 20 - 0.5 = 19.5.
    expect(view).toMatchObject({
      portfolioId: PF,
      ticker: 'AAA',
      currency: 'USD',
      signedQuantity: '19.5',
      averagePrice: '2.475',
      isShort: false,
      marketPrice: null,
      marketValueInstrument: null,
      marketValueBase: null,
      allocationPct: null,
      valuationStatus: 'NOT_VALUED',
    });
    for (const text of [view.signedQuantity, view.averagePrice ?? '']) {
      expect(isDecimalText(text)).toBe(true);
    }
  });

  it('outputs Canonical Decimal Strings (no trailing zeros, no negative zero)', () => {
    // (1.5 * 2 + 0.5 * 4) / 2 = 2.5; SELL 1.5 -> 0.5.
    const p = after([
      ['BUY', '1.5', '2'],
      ['BUY', '0.5', '4'],
      ['SELL', '1.5', '7'],
    ]);
    expect(state(p)).toEqual(['0.5', '2.5', false]);
    expect(
      state(
        after([
          ['SELL', '2', '5'],
          ['BUY', '2', '5'],
        ]),
      ),
    ).toEqual(['0', null, false]);
  });

  it('nets long and short activity into one position per ticker, sorted by ticker', () => {
    const result = replayPositions(PF, [
      ...rows(
        [
          ['BUY', '5', '10'],
          ['SELL', '8', '12'],
        ],
        { ticker: 'ZZZ' },
      ),
      ...rows([['BUY', '1', '1']], { ticker: 'AAA', sourceId: SOURCE_B }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((p) => [p.ticker, p.signedQuantity, p.averagePrice, p.isShort])).toEqual([
      ['AAA', '1', '1', false],
      ['ZZZ', '-3', '12', true],
    ]);
  });

  it('derives id, updatedAt, and source from the inputs (R5.6)', () => {
    const entries = [
      trade('BUY', '1', '1', { tradeTimestamp: T0, source: 'CSV first.csv', sourceSequence: 1 }),
      trade('BUY', '1', '3', { tradeTimestamp: T1, source: 'CSV second.csv', sourceId: SOURCE_B }),
    ];
    const p = single(entries);
    expect(p.id).toBe(sha256Hex(canonicalJson(['POS', PF, 'AAA'])));
    expect(p.id).toBe(positionId(PF, 'AAA'));
    expect(p.id).toMatch(/^[0-9a-f]{64}$/);
    expect(positionId(PF, 'BBB')).not.toBe(p.id);
    expect(positionId('pf-2', 'AAA')).not.toBe(p.id);
    expect(p.updatedAt).toBe(T1);
    expect(p.source).toBe('CSV second.csv');
    expect(p.averagePrice).toBe('2');
  });

  it('an empty ledger gives no positions', () => {
    expect(replayPositions(PF, [])).toEqual({ ok: true, value: [] });
  });
});

describe('R28.18 ordering: (tradeTimestamp, sourceId, sourceSequence, transactionKey)', () => {
  const base = trade('BUY', '1', '1');
  const cases: [string, Partial<TransactionRecord>, Partial<TransactionRecord>][] = [
    [
      'tradeTimestamp',
      { tradeTimestamp: T0, sourceId: SOURCE_B },
      { tradeTimestamp: T1, sourceId: SOURCE_A },
    ],
    ['sourceId', { sourceId: SOURCE_A, sourceSequence: 9 }, { sourceId: SOURCE_B, sourceSequence: 1 }],
    [
      'sourceSequence',
      { sourceSequence: 2, transactionKey: 'z' },
      { sourceSequence: 10, transactionKey: 'a' },
    ],
    ['transactionKey', { transactionKey: 'k-a' }, { transactionKey: 'k-b' }],
  ];
  it.each(cases)('orders by %s', (_field, first, second) => {
    const a = { ...base, ...first };
    const b = { ...base, ...second };
    expect(compareLedgerOrder(a, b)).toBeLessThan(0);
    expect(compareLedgerOrder(b, a)).toBeGreaterThan(0);
    expect(compareLedgerOrder(a, a)).toBe(0);
  });

  it('compares sourceSequence numerically, not as text (2 before 10)', () => {
    const a = { ...base, sourceSequence: 2 };
    const b = { ...base, sourceSequence: 10 };
    expect(compareLedgerOrder(a, b)).toBeLessThan(0);
  });

  it('compares strings by ordinal code unit order, not by locale ("Z" before "a")', () => {
    expect(
      compareLedgerOrder({ ...base, transactionKey: 'Z' }, { ...base, transactionKey: 'a' }),
    ).toBeLessThan(0);
  });

  it('replays in ledger order whatever the input order', () => {
    // Order: BUY 10 @ 100, BUY 10 @ 120 (avg 110), SELL 20 (flat), BUY 1 @ 7.
    const ordered = [
      trade('BUY', '10', '100', { sourceSequence: 1 }),
      trade('BUY', '10', '120', { sourceSequence: 2 }),
      trade('SELL', '20', '50', { sourceSequence: 3 }),
      trade('BUY', '1', '7', { sourceSequence: 4 }),
    ];
    const reversed = [...ordered].reverse();
    expect(single(reversed)).toEqual(single(ordered));
    expect(state(single(reversed))).toEqual(['1', '7', false]);
  });
});

describe('AT-POS-07: mixed currencies give POSITION_CURRENCY_CONFLICT', () => {
  it('reports every conflicting ticker with sorted currencies and returns no positions', () => {
    const result = replayPositions(PF, [
      trade('BUY', '1', '1', { ticker: 'BBB', currency: 'USD' }),
      trade('BUY', '1', '1', { ticker: 'BBB', currency: 'EUR' }),
      trade('BUY', '1', '1', { ticker: 'AAA', currency: 'USD' }),
      trade('BUY', '1', '1', { ticker: 'AAA', currency: 'JPY' }),
      trade('BUY', '1', '1', { ticker: 'AAA', currency: 'CHF' }),
      trade('BUY', '1', '1', { ticker: 'CCC', currency: 'USD' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('POSITION_CURRENCY_CONFLICT');
    if (result.error.code !== 'POSITION_CURRENCY_CONFLICT') {
      return;
    }
    expect(result.error.conflicts).toEqual([
      { ticker: 'AAA', currencies: ['CHF', 'JPY', 'USD'] },
      { ticker: 'BBB', currencies: ['EUR', 'USD'] },
    ]);
    expect('value' in result).toBe(false);
  });

  it('a single currency per ticker becomes the position currency', () => {
    expect(single([trade('BUY', '1', '1', { currency: 'EUR' })]).currency).toBe('EUR');
  });
});

describe('reconciliation field list is exhaustive at compile time', () => {
  it('rejects an incomplete Position field list as a type error', () => {
    // @ts-expect-error An incomplete field list resolves to never.
    const incomplete: ExhaustiveKeys<Position, readonly ['id', 'ticker']> = ['id', 'ticker'] as const;
    const completeList = [
      'id',
      'portfolioId',
      'ticker',
      'currency',
      'signedQuantity',
      'averagePrice',
      'isShort',
      'updatedAt',
      'source',
    ] as const;
    const complete: ExhaustiveKeys<Position, typeof completeList> = completeList;
    expect(incomplete).toHaveLength(2);
    expect(complete).toHaveLength(9);
  });

  it('samePosition detects a difference in every field', () => {
    const base = after([['BUY', '2', '3']]);
    const variants: Position[] = [
      { ...base, id: 'other' },
      { ...base, portfolioId: 'pf-2' },
      { ...base, ticker: 'BBB' },
      { ...base, currency: 'EUR' },
      { ...base, signedQuantity: brandDecimalString('3') },
      { ...base, averagePrice: null },
      { ...base, isShort: true },
      { ...base, updatedAt: T1 },
      { ...base, source: 'other' },
    ];
    expect(samePosition(base, { ...base })).toBe(true);
    for (const variant of variants) {
      expect(samePosition(base, variant)).toBe(false);
    }
  });
});

describe('ledger invariants (financial-rules 9): LEDGER_DATA_INVALID', () => {
  const corrupt = (overrides: Record<string, unknown>): TransactionRecord =>
    ({ ...trade('BUY', '1', '1'), ...overrides }) as unknown as TransactionRecord;

  it.each([
    // LedgerInvariantError cases
    ['quantity', { quantity: '0' }],
    ['quantity', { quantity: '-1' }],
    ['price', { price: '0' }],
    ['sourceSequence', { sourceSequence: 0 }],
    ['sourceSequence', { sourceSequence: 1.5 }],
    ['type', { type: 'TRANSFER' }],
    ['tradeTimestamp', { tradeTimestamp: '2026-11-02T14:30:00Z' }],
    ['tradeTimestamp', { tradeTimestamp: '2026-11-02T16:30:00.000+02:00' }],
    ['tradeTimestamp', { tradeTimestamp: '2026-02-30T00:00:00.000Z' }],
    // DecimalInputError cases (malformed text or a non-string value)
    ['quantity', { quantity: '1e5' }],
    ['quantity', { quantity: '' }],
    ['quantity', { quantity: 10 }],
    ['price', { price: ' 1' }],
    ['price', { price: 'NaN' }],
  ])('returns a %s violation instead of throwing or producing a number (%j)', (field, overrides) => {
    const entry = corrupt(overrides);
    const result = replayPositions(PF, [trade('BUY', '5', '5'), entry]);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'LEDGER_DATA_INVALID',
        message: 'Ledger entries violate an invariant.',
        violations: [{ transactionKey: entry.transactionKey, field }],
      },
    });
    // The message names no value.
    expect(JSON.stringify(result)).not.toContain('TRANSFER');
  });

  it('lists every violating entry, sorted by transaction key, and returns no positions', () => {
    const result = replayPositions(PF, [
      corrupt({ transactionKey: 'k-b', price: '-2' }),
      trade('BUY', '1', '1', { transactionKey: 'k-ok' }),
      corrupt({ transactionKey: 'k-a', quantity: 'x' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'LEDGER_DATA_INVALID') {
      throw new Error('expected LEDGER_DATA_INVALID');
    }
    expect(result.error.violations).toEqual([
      { transactionKey: 'k-a', field: 'quantity' },
      { transactionKey: 'k-b', field: 'price' },
    ]);
  });

  it('is reported before a currency conflict', () => {
    const result = replayPositions(PF, [
      trade('BUY', '1', '1', { currency: 'USD' }),
      trade('BUY', '1', '1', { currency: 'EUR' }),
      corrupt({ quantity: '0' }),
    ]);
    expect(!result.ok && result.error.code).toBe('LEDGER_DATA_INVALID');
  });

  it('does not map other exceptions: a programmer error propagates', () => {
    const broken = {
      ...trade('BUY', '1', '1'),
      get type(): 'BUY' {
        throw new TypeError('broken getter');
      },
    } as TransactionRecord;
    expect(() => replayPositions(PF, [broken])).toThrow(TypeError);
    expect(() => replayPositions(PF, [broken])).not.toThrow(LedgerInvariantError);
  });

  it('LedgerInvariantError carries the field and keeps a DecimalInputError as its cause', () => {
    const error = new LedgerInvariantError('quantity', { cause: new Error('inner') });
    expect(error.field).toBe('quantity');
    expect(error.cause).toBeInstanceOf(Error);
  });
});
