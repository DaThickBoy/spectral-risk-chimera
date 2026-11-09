// Test helpers for tasks 11.2 and 11.3: position views with a given valuation.
import { toPositionView } from '../../src/portfolio/index.js';
import type { PositionView, ValuationStatus } from '../../src/portfolio/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import type { DecimalString } from '../../src/shared/index.js';
import { pos } from './valuation.js';

export const ds = (text: string): DecimalString => brandDecimalString(text);

/** A VALUED view whose signed base value is `base` (quantity sign follows the value). */
export function valued(ticker: string, base: string, quantity?: string): PositionView {
  const qty = quantity ?? (base.startsWith('-') ? '-1' : base === '0' ? '0' : '1');
  return {
    ...toPositionView(pos(ticker, 'USD', qty)),
    marketPrice: ds('1'),
    marketValueInstrument: ds(base),
    marketValueBase: ds(base),
    valuationStatus: 'VALUED',
  };
}

/** A view whose base value is unavailable with `status`. */
export function unvalued(ticker: string, status: ValuationStatus, quantity = '5'): PositionView {
  return { ...toPositionView(pos(ticker, 'USD', quantity)), valuationStatus: status };
}

/** Allocation input line. */
export const line = (ticker: string, valueBase: string): { ticker: string; valueBase: DecimalString } => ({
  ticker,
  valueBase: ds(valueBase),
});
