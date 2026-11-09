/**
 * Bearish sentiment downside adjustment (tasks 14.1 and 14.2; design: Risk
 * Engine, Adjusted VaR gate; FR-6, FR-8, FR-9; R15.1 to R15.12).
 *
 * Eligibility gate (14.1, R15.2, R15.8), per position with non-zero net
 * quantity, in this order:
 * - no sentiment entry for the ticker: `ABSENT`;
 * - a non-null value that is not decimal text in [-1, +1]: `INVALID`;
 * - source kind `DEMO`: `DEMO` (demo data is never eligible, FR-8);
 * - status `UNAVAILABLE` or no value: `UNAVAILABLE`;
 * - status `STALE`: `STALE`;
 * - otherwise (`CURRENT`, `REAL`, valid): eligible.
 * Entries for tickers without a position are ignored; two entries for one ticker
 * are an invalid input (checked by the engine).
 *
 * Adjustment (14.2), only when every position is eligible:
 * - `EffectiveSentiment` is the raw value for a long position and its negation
 *   for a short position (FR-9).
 * - A position triggers if and only if `EffectiveSentiment < threshold`
 *   (strictly; -0.60 does not trigger at -0.60, -0.6001 does; R15.4).
 * - A triggered position's negative scenario P&L values are multiplied by the
 *   multiplier; its non-negative values and every non-triggered position are
 *   unchanged (FR-6, R15.5, R15.6). The portfolio losses are recomputed from the
 *   adjusted position P&L; the portfolio VaR is never multiplied (R15.7).
 * The multiplier is a configurable downside stress assumption, not a
 * statistical estimate of volatility change (R15.11). FilingRiskScore has no
 * input here (R15.14, R11.5). Decimal.js only; nothing is rounded.
 */
import { d, isDecimalText, toCanonical } from '../shared/index.js';
import type { Decimal } from '../shared/index.js';
import type { IneligibleSentimentStatus, RiskInput, TriggeredAsset } from './types.js';

export type Eligibility =
  | { readonly ok: true; readonly values: ReadonlyMap<string, Decimal> }
  | {
      readonly ok: false;
      readonly ineligible: readonly {
        readonly ticker: string;
        readonly sentimentStatus: IneligibleSentimentStatus;
      }[];
    };

const inUnitRange = (text: string): boolean =>
  isDecimalText(text) && d(text).greaterThanOrEqualTo(-1) && d(text).lessThanOrEqualTo(1);

export function evaluateEligibility(input: RiskInput): Eligibility {
  const byTicker = new Map(input.sentiment.map((entry) => [entry.ticker, entry]));
  const ineligible: { ticker: string; sentimentStatus: IneligibleSentimentStatus }[] = [];
  const values = new Map<string, Decimal>();
  for (const position of input.positions) {
    const entry = byTicker.get(position.ticker);
    let status: IneligibleSentimentStatus | undefined;
    if (entry === undefined) {
      status = 'ABSENT';
    } else if (entry.value !== null && (typeof entry.value !== 'string' || !inUnitRange(entry.value))) {
      status = 'INVALID';
    } else if (entry.sourceKind !== 'REAL') {
      status = 'DEMO';
    } else if (entry.status === 'UNAVAILABLE' || entry.value === null) {
      status = 'UNAVAILABLE';
    } else if (entry.status !== 'CURRENT') {
      status = 'STALE';
    }
    if (status === undefined && entry !== undefined && entry.value !== null) {
      values.set(position.ticker, d(entry.value));
    } else {
      ineligible.push({ ticker: position.ticker, sentimentStatus: status ?? 'UNAVAILABLE' });
    }
  }
  return ineligible.length > 0 ? { ok: false, ineligible } : { ok: true, values };
}

export interface AdjustedScenario {
  readonly losses: Decimal[];
  readonly triggered: TriggeredAsset[];
}

/** FR-6 on the position P&L matrix; `pnl[k]` is aligned with `input.positions[k]`. */
export function adjustScenarios(
  input: RiskInput,
  pnl: readonly (readonly Decimal[])[],
  values: ReadonlyMap<string, Decimal>,
  threshold: Decimal,
  multiplier: Decimal,
): AdjustedScenario {
  const triggered: TriggeredAsset[] = [];
  const adjusted = input.positions.map((position, k) => {
    const raw = values.get(position.ticker);
    const row = pnl[k];
    if (raw === undefined || row === undefined) {
      throw new TypeError('adjustScenarios: eligibility does not match the positions.');
    }
    const long = d(position.signedQuantity).greaterThan(0);
    const effective = long ? raw : raw.negated();
    if (!effective.lessThan(threshold)) {
      return row;
    }
    triggered.push({
      ticker: position.ticker,
      direction: long ? 'LONG' : 'SHORT',
      rawSentiment: toCanonical(raw),
      effectiveSentiment: toCanonical(effective),
      multiplier: toCanonical(multiplier),
    });
    return row.map((value) => (value.lessThan(0) ? value.times(multiplier) : value));
  });
  const n = pnl[0]?.length ?? 0; // scenario count, not a financial value
  const losses: Decimal[] = [];
  for (let i = 0; i < n; i += 1) {
    let total = d('0');
    for (const row of adjusted) {
      const value = row[i];
      if (value === undefined) {
        throw new TypeError('adjustScenarios: ragged P&L matrix.');
      }
      total = total.plus(value);
    }
    losses.push(total.negated());
  }
  triggered.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  return { losses, triggered };
}
