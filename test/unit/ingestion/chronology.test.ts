// Task 7.4: chronological processing, currency consistency, and the oversell policy
// (design: Normalizer and Deduper). Quantities are hand-calculated.
// Tests: AT-CSV-10, AT-CSV-11, AT-CSV-19, AT-CSV-20
// Validates: Requirements 28.18, 28.20, 28.21, 28.22
import { describe, expect, it } from 'vitest';
import { applyChronology } from '../../../src/ingestion/index.js';
import type { Candidate, OversellPolicy } from '../../../src/ingestion/index.js';
import { candidate } from '../../helpers/importRows.js';
import { trade } from '../../helpers/ledger.js';

const T0 = '2026-11-02T10:00:00.000Z';
const T1 = '2026-11-03T10:00:00.000Z';
const T2 = '2026-11-04T10:00:00.000Z';

const seqs = (list: readonly Candidate[]) => list.map((c) => c.sourceSequence);
const rejections = (result: ReturnType<typeof applyChronology>) =>
  result.rejected.map((r) => [r.candidate.sourceSequence, r.reason]);

describe('applyChronology: order (AT-CSV-19)', () => {
  it('a same-file SELL listed before its BUY is accepted because the BUY is earlier in time', () => {
    const sell = candidate('SELL', '5', { sequence: 1, tradeTimestamp: T1 });
    const buy = candidate('BUY', '10', { sequence: 2, tradeTimestamp: T0 });
    const result = applyChronology([sell, buy], [], 'REJECT');
    expect(seqs(result.accepted)).toEqual([2, 1]); // R28.18 order
    expect(result.rejected).toEqual([]);
  });

  it('same timestamp: row order decides, so SELL before BUY in the file is an oversell', () => {
    const sell = candidate('SELL', '5', { sequence: 1, tradeTimestamp: T0 });
    const buy = candidate('BUY', '10', { sequence: 2, tradeTimestamp: T0 });
    expect(rejections(applyChronology([sell, buy], [], 'REJECT'))).toEqual([[1, 'OVERSELL']]);
  });
});

describe('applyChronology: REJECT (AT-CSV-10)', () => {
  const ledger = [trade('BUY', '10', '1', { tradeTimestamp: T0 })];

  it('a SELL of exactly the available quantity is accepted; one unit more is OVERSELL', () => {
    expect(
      applyChronology([candidate('SELL', '10', { tradeTimestamp: T1 })], ledger, 'REJECT').rejected,
    ).toEqual([]);
    expect(
      rejections(applyChronology([candidate('SELL', '10.0001', { tradeTimestamp: T1 })], ledger, 'REJECT')),
    ).toEqual([[1, 'OVERSELL']]);
  });

  it('a SELL with no holding is OVERSELL', () => {
    expect(rejections(applyChronology([candidate('SELL', '1')], [], 'REJECT'))).toEqual([[1, 'OVERSELL']]);
  });

  it('a rejected SELL does not change the running quantity', () => {
    const big = candidate('SELL', '20', { sequence: 1, tradeTimestamp: T1 });
    const small = candidate('SELL', '6', { sequence: 2, tradeTimestamp: T1 });
    const after = candidate('SELL', '5', { sequence: 3, tradeTimestamp: T2 });
    const result = applyChronology([big, small, after], ledger, 'REJECT');
    expect(seqs(result.accepted)).toEqual([2]); // 10 - 6 = 4 left, so 5 is an oversell
    expect(rejections(result)).toEqual([
      [1, 'OVERSELL'],
      [3, 'OVERSELL'],
    ]);
  });

  it('a back-dated SELL that would make a later committed SELL oversold is OVERSELL', () => {
    const history = [
      trade('BUY', '10', '1', { tradeTimestamp: T0 }),
      trade('SELL', '10', '1', { tradeTimestamp: T2 }),
    ];
    expect(
      rejections(applyChronology([candidate('SELL', '1', { tradeTimestamp: T1 })], history, 'REJECT')),
    ).toEqual([[1, 'OVERSELL']]);
  });

  it('a back-dated SELL covered by a later committed BUY before any later SELL is still checked at its own time', () => {
    const history = [trade('BUY', '10', '1', { tradeTimestamp: T2 })];
    expect(
      rejections(applyChronology([candidate('SELL', '1', { tradeTimestamp: T1 })], history, 'REJECT')),
    ).toEqual([[1, 'OVERSELL']]);
  });

  it('tickers are independent', () => {
    const result = applyChronology(
      [
        candidate('SELL', '5', { ticker: 'BBB', tradeTimestamp: T1 }),
        candidate('SELL', '5', { tradeTimestamp: T1, sequence: 2 }),
      ],
      ledger,
      'REJECT',
    );
    expect(rejections(result)).toEqual([[1, 'OVERSELL']]);
    expect(seqs(result.accepted)).toEqual([2]);
  });
});

describe('applyChronology: ALLOW_SHORT (AT-CSV-11)', () => {
  it('accepts a SELL beyond the holding', () => {
    const ledger = [trade('BUY', '10', '1', { tradeTimestamp: T0 })];
    const result = applyChronology([candidate('SELL', '15', { tradeTimestamp: T1 })], ledger, 'ALLOW_SHORT');
    expect(seqs(result.accepted)).toEqual([1]);
    expect(result.rejected).toEqual([]);
  });
});

describe('applyChronology: currency consistency (AT-CSV-20)', () => {
  it('a candidate in another currency than the ledger is CURRENCY_MISMATCH', () => {
    const ledger = [trade('BUY', '10', '1', { tradeTimestamp: T0, currency: 'USD' })];
    expect(
      rejections(
        applyChronology([candidate('BUY', '1', { currency: 'EUR', tradeTimestamp: T1 })], ledger, 'REJECT'),
      ),
    ).toEqual([[1, 'CURRENCY_MISMATCH']]);
  });

  it('without a ledger the first accepted candidate in R28.18 order establishes the currency', () => {
    const later = candidate('BUY', '1', { sequence: 1, currency: 'USD', tradeTimestamp: T1 });
    const earlier = candidate('BUY', '1', { sequence: 2, currency: 'EUR', tradeTimestamp: T0 });
    const result = applyChronology([later, earlier], [], 'REJECT');
    expect(seqs(result.accepted)).toEqual([2]);
    expect(rejections(result)).toEqual([[1, 'CURRENCY_MISMATCH']]);
  });

  it('a rejected (oversold) candidate does not establish the currency', () => {
    const sell = candidate('SELL', '1', { sequence: 1, currency: 'EUR', tradeTimestamp: T0 });
    const buy = candidate('BUY', '1', { sequence: 2, currency: 'USD', tradeTimestamp: T1 });
    const result = applyChronology([sell, buy], [], 'REJECT');
    expect(rejections(result)).toEqual([[1, 'OVERSELL']]);
    expect(seqs(result.accepted)).toEqual([2]);
  });
});

it('an unknown policy is a programmer error', () => {
  expect(() => applyChronology([], [], 'MAYBE' as OversellPolicy)).toThrow(TypeError);
});
