// fast-check generators for import property tests (task 7.6): CSV files mixing valid, invalid,
// duplicate, and empty rows, drawn from small pools so duplicates, oversells, and currency
// conflicts occur often. Quantities are integers so the reference uses BigInt, not Decimal.js.
import fc from 'fast-check';

export const IMPORT_HEADER = 'external_id,trade_timestamp,ticker,type,quantity,price,currency';

const TIMES = ['2026-11-02T10:00:00Z', '2026-11-03T10:00:00Z', '2026-11-04T10:00:00+01:00'];
const TICKERS = ['AAA', 'BBB'];

export interface TradeLine {
  readonly externalId: string;
  readonly time: string;
  readonly ticker: string;
  readonly type: 'BUY' | 'SELL';
  readonly quantity: string;
  readonly price: string;
  readonly currency: string;
}

export const lineOf = (t: TradeLine): string =>
  [t.externalId, t.time, t.ticker, t.type, t.quantity, t.price, t.currency].join(',');

export const tradeArb = (currencies: readonly string[] = ['USD', 'USD', 'USD', 'EUR', 'GBP']) =>
  fc.record({
    externalId: fc.constantFrom('', '', '', 'x-1', 'x-2'),
    time: fc.constantFrom(...TIMES),
    ticker: fc.constantFrom(...TICKERS),
    type: fc.constantFrom('BUY' as const, 'BUY' as const, 'SELL' as const),
    quantity: fc.constantFrom('1', '2', '5', '10'),
    price: fc.constantFrom('1', '2.5', '10.25'),
    currency: fc.constantFrom(...currencies),
  });

/** A line rejected by 7.2 field validation, whatever the ledger. */
const invalidLineArb = fc
  .tuple(
    tradeArb(['USD']),
    fc.constantFrom<(t: TradeLine) => TradeLine>(
      (t) => ({ ...t, type: 'HOLD' as 'BUY' }),
      (t) => ({ ...t, ticker: 'aaa' }),
      (t) => ({ ...t, quantity: '1e2' }),
      (t) => ({ ...t, quantity: '0' }),
      (t) => ({ ...t, price: '-1' }),
      (t) => ({ ...t, time: '2026-11-02' }),
      (t) => ({ ...t, currency: 'usd' }),
    ),
  )
  .map(([t, corrupt]) => lineOf(corrupt(t)));

export const fileLineArb = fc.oneof(
  { weight: 6, arbitrary: tradeArb().map(lineOf) },
  { weight: 2, arbitrary: invalidLineArb },
  { weight: 1, arbitrary: fc.constant(',,,,,,') },
);

/** Data lines of one file (the duplicate pools make repeated lines common). */
export const fileLinesArb = fc.array(fileLineArb, { minLength: 1, maxLength: 25 });

export const fileOf = (lines: readonly string[]): string => [IMPORT_HEADER, ...lines].join('\n') + '\n';
