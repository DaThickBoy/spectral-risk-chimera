// Kiroween A2: the chart adapter turns the backend loss distribution into pixels only. Bars are
// placed by integer bucket index (equal widths) and sized by integer counts; the one decimal
// conversion is the backend's marker position (R4.4).
// Validates: Requirements 4.4; ui-guidelines 5
import { describe, expect, it } from 'vitest';
import { allocationBars, exposureBars, histogramPlot } from '../../src/web/chartAdapter.ts';
import type { AvailableLossDistribution } from '../../src/web/chartAdapter.ts';
import { multiCurrencyView } from './fixtures.js';

const FRAME = { width: 640, height: 260, left: 56, right: 16, top: 28, bottom: 52 };

function fixture(): AvailableLossDistribution {
  const dist = multiCurrencyView().lossDistribution;
  if (dist.status !== 'AVAILABLE') throw new Error('fixture must be available');
  return dist;
}

describe('histogramPlot', () => {
  it('places equal-width bars by index and scales heights by count', () => {
    const plot = histogramPlot(fixture(), FRAME);
    // Plot 56..624 (568 px), 4 slots of 142 px, 2 px gap; 180 px tall; max count 3.
    expect(plot.maxCount).toBe(3);
    expect(plot.bars).toEqual([
      { index: 0, x: 57, y: 28, width: 140, height: 180 },
      { index: 1, x: 199, y: 88, width: 140, height: 120 },
      { index: 2, x: 341, y: 88, width: 140, height: 120 },
      { index: 3, x: 483, y: 28, width: 140, height: 180 },
    ]);
  });

  it('puts the marker at the backend position in bucket-width units and anchors its label inside', () => {
    const plot = histogramPlot(fixture(), FRAME);
    expect(plot.markerX).toBeCloseTo(595.6, 9); // pixels, not a financial value: 56 + 3.8 * 142
    expect(plot.markerLabelAnchor).toBe('end');
    const atStart = '0' as AvailableLossDistribution['varMarker']['position'];
    const left = histogramPlot(
      { ...fixture(), varMarker: { ...fixture().varMarker, position: atStart } },
      FRAME,
    );
    expect(left.markerX).toBe(56);
    expect(left.markerLabelAnchor).toBe('start');
  });
});

describe('allocationBars (S2)', () => {
  const asset = (ticker: string, allocationPct: string | null) => ({
    ticker,
    allocationPct: allocationPct as never,
  });

  it('plots backend percentages on a fixed 0–100 % axis; a genuine zero is a zero-length bar', () => {
    expect(allocationBars([asset('A', '40.2'), asset('B', '0'), asset('C', '100')])).toEqual([
      { ticker: 'A', widthPct: 40.2, notPlotted: null },
      { ticker: 'B', widthPct: 0, notPlotted: null },
      { ticker: 'C', widthPct: 100, notPlotted: null },
    ]);
  });

  it('a missing allocation is UNAVAILABLE and a value outside the axis is OUT_OF_SCALE: never drawn', () => {
    expect(allocationBars([asset('A', null), asset('B', '-1.5'), asset('C', '100.01')])).toEqual([
      { ticker: 'A', widthPct: null, notPlotted: 'UNAVAILABLE' },
      { ticker: 'B', widthPct: null, notPlotted: 'OUT_OF_SCALE' },
      { ticker: 'C', widthPct: null, notPlotted: 'OUT_OF_SCALE' },
    ]);
  });
});

describe('exposureBars (S3)', () => {
  const entry = (currency: string, marketValueBase: string | null) => ({
    currency,
    marketValueBase: marketValueBase as never,
  });
  const gross = '200' as never;

  it('plots each value against the fixed gross-exposure axis; zero is a zero-length bar', () => {
    expect(exposureBars([entry('EUR', '50'), entry('USD', '0'), entry('GBP', '200')], gross)).toEqual([
      { currency: 'EUR', widthPct: 25, negative: false, notPlotted: null },
      { currency: 'USD', widthPct: 0, negative: false, notPlotted: null },
      { currency: 'GBP', widthPct: 100, negative: false, notPlotted: null },
    ]);
  });

  it('a negative value has the length of its absolute value and is flagged negative', () => {
    expect(exposureBars([entry('USD', '-50')], gross)).toEqual([
      { currency: 'USD', widthPct: 25, negative: true, notPlotted: null },
    ]);
  });

  it('missing value, missing axis, and a value beyond the axis are never drawn', () => {
    expect(exposureBars([entry('EUR', null), entry('USD', '250')], gross)).toEqual([
      { currency: 'EUR', widthPct: null, negative: false, notPlotted: 'UNAVAILABLE' },
      { currency: 'USD', widthPct: null, negative: false, notPlotted: 'OUT_OF_SCALE' },
    ]);
    expect(exposureBars([entry('EUR', '50')], null)).toEqual([
      { currency: 'EUR', widthPct: null, negative: false, notPlotted: 'NO_AXIS' },
    ]);
  });
});
