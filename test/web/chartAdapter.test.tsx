// Kiroween A2: the chart adapter turns the backend loss distribution into pixels only. Bars are
// placed by integer bucket index (equal widths) and sized by integer counts; the one decimal
// conversion is the backend's marker position (R4.4).
// Validates: Requirements 4.4; ui-guidelines 5
import { describe, expect, it } from 'vitest';
import { allocationArcs, allocationBars, exposureBars, histogramPlot } from '../../src/web/chartAdapter.ts';
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

describe('allocationArcs (fintech ring): pixel geometry only', () => {
  // A ring of radius 100 centred at 120; circumference 200π. Geometry assertions use
  // toBeCloseTo on PIXEL numbers only (never on financial values, which stay backend text).
  const RING = { radius: 100, center: 120, labelRadius: 100 };
  const C = 2 * Math.PI * RING.radius;
  const bar = (ticker: string, widthPct: number | null) => ({
    ticker,
    widthPct,
    notPlotted: widthPct === null ? ('UNAVAILABLE' as const) : null,
  });
  const dash = (s: string): [number, number] => {
    const [a, b] = s.split(' ').map(Number.parseFloat) as [number, number];
    return [a, b];
  };

  it('normal allocations: arcs in backend order, each starting where the previous one ended', () => {
    const arcs = allocationArcs([bar('A', 40.2), bar('B', 29.74), bar('C', 25.59)], RING);
    expect(arcs.map((a) => [a.ticker, a.pct])).toEqual([
      ['A', 40.2],
      ['B', 29.74],
      ['C', 25.59],
    ]);
    // Length = share of the circumference minus a 2 px gap; the dash period is the circumference.
    expect(dash(arcs[0]?.dasharray ?? '')[0]).toBeCloseTo(0.402 * C - 2, 6);
    expect(dash(arcs[0]?.dasharray ?? '')[1]).toBeCloseTo(C, 6);
    // Offsets accumulate the previous arcs (0, then -40.2 %, then -(40.2 + 29.74) %).
    expect(Number.parseFloat(arcs[0]?.dashoffset ?? '')).toBe(0);
    expect(Number.parseFloat(arcs[1]?.dashoffset ?? '')).toBeCloseTo(-0.402 * C, 6);
    expect(Number.parseFloat(arcs[2]?.dashoffset ?? '')).toBeCloseTo(-0.6994 * C, 6);
    // The first label sits at the middle of its arc, measured clockwise from 12 o'clock.
    const mid = 0.201 * 2 * Math.PI - Math.PI / 2;
    expect(arcs[0]?.labelX).toBeCloseTo(120 + 100 * Math.cos(mid), 6);
    expect(arcs[0]?.labelY).toBeCloseTo(120 + 100 * Math.sin(mid), 6);
  });

  it('a genuine zero is a zero-length arc with no gap, and does not move the next arc', () => {
    const arcs = allocationArcs([bar('A', 0), bar('B', 50)], RING);
    expect(arcs.map((a) => a.ticker)).toEqual(['A', 'B']);
    expect(dash(arcs[0]?.dasharray ?? '')[0]).toBe(0);
    expect(Number.parseFloat(arcs[1]?.dashoffset ?? '')).toBe(0);
  });

  it('a missing allocation is never drawn (no arc, no zero) and does not move the next arc', () => {
    const arcs = allocationArcs([bar('A', null), bar('B', 30)], RING);
    expect(arcs.map((a) => a.ticker)).toEqual(['B']);
    expect(Number.parseFloat(arcs[0]?.dashoffset ?? '')).toBe(0);
  });

  it('boundaries: 100 % is a full ring (label at 6 o’clock); a tiny arc gets no gap; empty input', () => {
    const [full] = allocationArcs([bar('A', 100)], RING);
    expect(dash(full?.dasharray ?? '')[0]).toBeCloseTo(C - 2, 6);
    expect(full?.labelX).toBeCloseTo(120, 6);
    expect(full?.labelY).toBeCloseTo(220, 6);
    const [tiny] = allocationArcs([bar('A', 0.5)], RING); // 0.5 % of 628 px is about 3.1 px, at most 4
    expect(dash(tiny?.dasharray ?? '')[0]).toBeCloseTo(0.005 * C, 6);
    expect(allocationArcs([], RING)).toEqual([]);
  });

  it('uses only the widths allocationBars produced from the backend text (no other value)', () => {
    const bars = allocationBars([
      { ticker: 'A', allocationPct: '40.2' as never },
      { ticker: 'B', allocationPct: null },
    ]);
    expect(allocationArcs(bars, RING).map((a) => [a.ticker, a.pct])).toEqual([['A', 40.2]]);
  });
});
