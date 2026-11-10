/**
 * Chart adapter (R4.4; ui-guidelines 5; Kiroween decision A2): the dashboard's only
 * presentation boundary from decimal text to native numbers. It turns the backend's loss
 * distribution into SVG geometry and nothing else.
 *
 * - The single `toChartNumber` call converts `varMarker.position` (a plotting coordinate in
 *   bucket-width units, computed by the backend) into a pixel offset. No monetary value is
 *   converted: bars are placed by their integer bucket index, because every bucket has the
 *   same width, and their heights come from integer scenario counts.
 * - The numbers returned here are pixels. They are never shown as values, sent to the API,
 *   stored, or used in a financial calculation. Every label and tooltip uses the backend's
 *   decimal and display strings.
 */
import type { LossDistribution } from '../shared/apiContracts/index.js';
import { toChartNumber } from '../shared/decimal.js';

export type AvailableLossDistribution = Extract<LossDistribution, { status: 'AVAILABLE' }>;

export interface ChartFrame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface HistogramBar {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HistogramPlot {
  readonly bars: readonly HistogramBar[];
  /** Pixel x of the VaR marker. */
  readonly markerX: number;
  /** The largest bucket count (the y-axis maximum; a count, not a financial value). */
  readonly maxCount: number;
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  readonly plotBottom: number;
  readonly centerX: number;
  readonly centerY: number;
  /** Text anchor that keeps the marker label inside the plot. */
  readonly markerLabelAnchor: 'start' | 'end';
}

/** Pixel gap between adjacent bars. */
const BAR_GAP = 2;

export function histogramPlot(distribution: AvailableLossDistribution, frame: ChartFrame): HistogramPlot {
  const plotLeft = frame.left;
  const plotRight = frame.width - frame.right;
  const plotTop = frame.top;
  const plotBottom = frame.height - frame.bottom;
  const slot = (plotRight - plotLeft) / distribution.bucketCount;
  let maxCount = 0;
  for (const bucket of distribution.buckets) {
    if (bucket.count > maxCount) maxCount = bucket.count;
  }
  const scale = maxCount === 0 ? 0 : (plotBottom - plotTop) / maxCount;
  const gap = slot > BAR_GAP * 2 ? BAR_GAP : 0;
  const bars = distribution.buckets.map((bucket, index) => {
    const height = bucket.count * scale;
    return {
      index,
      x: plotLeft + index * slot + gap / 2,
      y: plotBottom - height,
      width: slot - gap,
      height,
    };
  });
  const markerX = plotLeft + toChartNumber(distribution.varMarker.position) * slot;
  const centerX = (plotLeft + plotRight) / 2;
  return {
    bars,
    markerX,
    maxCount,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    centerX,
    centerY: (plotTop + plotBottom) / 2,
    markerLabelAnchor: markerX > centerX ? 'end' : 'start',
  };
}
