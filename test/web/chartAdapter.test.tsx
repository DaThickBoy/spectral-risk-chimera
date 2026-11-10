// Kiroween A2: the chart adapter turns the backend loss distribution into pixels only. Bars are
// placed by integer bucket index (equal widths) and sized by integer counts; the one decimal
// conversion is the backend's marker position (R4.4).
// Validates: Requirements 4.4; ui-guidelines 5
import { describe, expect, it } from 'vitest';
import { histogramPlot } from '../../src/web/chartAdapter.ts';
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
