/**
 * Chronological processing, currency consistency, and the oversell policy (task
 * 7.4; design: Normalizer and Deduper; R28.18, R28.20, R28.21, R28.22,
 * AT-CSV-10, AT-CSV-11, AT-CSV-19).
 *
 * Candidates (7.3) are merged with the committed ledger, per ticker, in the
 * R28.18 order `(tradeTimestamp, sourceId, sourceSequence, transactionKey)`
 * using `compareLedgerOrder` from `portfolio/`, and decided one by one in that
 * order:
 *
 * 1. **Currency (R28.22).** The instrument's established currency is the
 *    currency of its ledger transactions, or, without any, of its first
 *    accepted candidate in R28.18 order. A candidate in another currency is
 *    `CURRENCY_MISMATCH`.
 * 2. **Oversell under `REJECT` (R28.20).** A SELL is accepted only if the net
 *    quantity stays non-negative at its point in time and at every later point.
 *    "Later points" means the committed ledger entries after it (a back-dated
 *    SELL may not make a later committed SELL oversold); later candidates are
 *    checked when their turn comes. Otherwise it is `OVERSELL`. A rejected
 *    candidate does not change the running quantity. By induction no position
 *    becomes negative because of the import.
 * 3. **`ALLOW_SHORT` (R28.21).** Every SELL is accepted; the 6.2 replay marks a
 *    negative position short.
 *
 * The policy must be supplied; the caller refuses the import when it is not
 * configured (R28.20). Decimal.js only; quantities are Canonical Decimal Strings.
 *
 * Pure. Validates: Requirements 28.18, 28.20, 28.21, 28.22.
 */
import { compareLedgerOrder } from '../portfolio/index.js';
import type { LedgerEntry } from '../portfolio/index.js';
import { d } from '../shared/index.js';
import type { Decimal } from '../shared/index.js';
import type { Candidate } from './normalize.js';

export type OversellPolicy = 'REJECT' | 'ALLOW_SHORT';

export type ChronologyRejection = {
  readonly candidate: Candidate;
  readonly reason: 'CURRENCY_MISMATCH' | 'OVERSELL';
};

export interface ChronologyResult {
  /** Accepted candidates in R28.18 order. */
  readonly accepted: readonly Candidate[];
  /** In R28.18 order. */
  readonly rejected: readonly ChronologyRejection[];
}

const entryOf = (candidate: Candidate): LedgerEntry => ({
  transactionKey: candidate.transactionKey,
  sourceId: candidate.sourceId,
  sourceSequence: candidate.sourceSequence,
  source: '',
  tradeTimestamp: candidate.row.tradeTimestamp,
  ticker: candidate.row.ticker,
  type: candidate.row.type,
  quantity: candidate.row.quantity,
  price: candidate.row.price,
  currency: candidate.row.currency,
});

type Item = { readonly entry: LedgerEntry; readonly candidate?: Candidate };

const signedDelta = (entry: LedgerEntry): Decimal =>
  entry.type === 'BUY' ? d(entry.quantity) : d(entry.quantity).negated();

export function applyChronology(
  candidates: readonly Candidate[],
  ledger: readonly LedgerEntry[],
  policy: OversellPolicy,
): ChronologyResult {
  if (policy !== 'REJECT' && policy !== 'ALLOW_SHORT') {
    throw new TypeError('policy must be REJECT or ALLOW_SHORT.');
  }
  const byTicker = new Map<string, Item[]>();
  const add = (ticker: string, item: Item): void => {
    const list = byTicker.get(ticker);
    if (list === undefined) {
      byTicker.set(ticker, [item]);
    } else {
      list.push(item);
    }
  };
  for (const entry of ledger) {
    add(entry.ticker, { entry });
  }
  for (const candidate of candidates) {
    add(candidate.row.ticker, { entry: entryOf(candidate), candidate });
  }

  const accepted: Candidate[] = [];
  const rejected: ChronologyRejection[] = [];
  for (const items of byTicker.values()) {
    items.sort((a, b) => compareLedgerOrder(a.entry, b.entry));
    // Suffix minimum of the committed ledger's cumulative change after each index:
    // laterLedgerMin[i] = min(0, min over j > i of the sum of ledger deltas in (i, j]).
    // Recurrence from the right: M(i) = min(0, delta(i+1) + M(i+1)) for a ledger item at i+1,
    // and M(i) = M(i+1) for a candidate at i+1 (candidates are checked in their own turn).
    const laterLedgerMin: Decimal[] = new Array<Decimal>(items.length);
    const zero = d('0');
    let suffixMin = zero;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      laterLedgerMin[i] = suffixMin;
      const item = items[i];
      if (item !== undefined && item.candidate === undefined) {
        const shifted = suffixMin.plus(signedDelta(item.entry));
        suffixMin = shifted.lessThan(zero) ? shifted : zero;
      }
    }
    const ledgerCurrency = items.find((item) => item.candidate === undefined)?.entry.currency;
    let established = ledgerCurrency;
    let quantity = d('0');
    for (const [index, item] of items.entries()) {
      const { candidate, entry } = item;
      if (candidate === undefined) {
        quantity = quantity.plus(signedDelta(entry));
        continue;
      }
      if (established !== undefined && entry.currency !== established) {
        rejected.push({ candidate, reason: 'CURRENCY_MISMATCH' });
        continue;
      }
      if (policy === 'REJECT' && entry.type === 'SELL') {
        const after = quantity.minus(d(entry.quantity));
        const worstLater = after.plus(laterLedgerMin[index] ?? d('0'));
        if (after.lessThan(0) || worstLater.lessThan(0)) {
          rejected.push({ candidate, reason: 'OVERSELL' });
          continue;
        }
      }
      established ??= entry.currency;
      quantity = quantity.plus(signedDelta(entry));
      accepted.push(candidate);
    }
  }
  const order = (a: Candidate, b: Candidate): number => compareLedgerOrder(entryOf(a), entryOf(b));
  accepted.sort(order);
  rejected.sort((a, b) => order(a.candidate, b.candidate));
  return { accepted, rejected };
}
