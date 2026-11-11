/**
 * Chart adapter (R4.4; ui-guidelines 5; Kiroween decision A2): the dashboard's only
 * presentation boundary from decimal text to native numbers. It turns the backend's loss
 * distribution and allocation percentages into chart geometry and nothing else.
 *
 * - Loss distribution: `toChartNumber` converts `varMarker.position` (a plotting coordinate in
 *   bucket-width units, computed by the backend) into a pixel offset. No monetary value is
 *   converted: bars are placed by their integer bucket index, because every bucket has the
 *   same width, and their heights come from integer scenario counts.
 * - Allocation (roadmap S2): `toChartNumber` converts each backend `allocationPct` into a bar
 *   width on a fixed 0–100 % axis. No allocation is computed; a missing one is not plotted.
 * - Currency exposure (roadmap S3): `toChartNumber` converts each currency's `marketValueBase`
 *   and the backend's gross exposure (the fixed axis) into a bar width. Nothing is summed,
 *   sorted, ranked, or normalized across currencies; a missing value is not plotted.
 * - The numbers returned here are geometry. They are never shown as values, sent to the API,
 *   stored, or used in a financial calculation. Every label and tooltip uses the backend's
 *   decimal and display strings.
 */
import type { LossDistribution } from '../shared/apiContracts/index.js';
import { toChartNumber } from '../shared/decimal.js';
import type { DecimalString } from '../shared/decimal.js';

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

/** One position's allocation bar (roadmap S2): a CSS width in percent of a fixed 0–100 % axis. */
export interface AllocationBar {
  readonly ticker: string;
  /** Bar width in percent of the axis, or `null` when there is nothing to plot. */
  readonly widthPct: number | null;
  /** Why no bar is drawn: no allocation from the backend, or a value outside the 0–100 % axis. */
  readonly notPlotted: 'UNAVAILABLE' | 'OUT_OF_SCALE' | null;
}

/**
 * Bars on a fixed 0–100 % axis (not scaled to the largest value), so a bar's length is the
 * allocation itself. The backend's canonical `allocationPct` text is converted for plotting only;
 * a missing value is never drawn as zero, and a value outside the axis is reported, not clamped.
 */
export function allocationBars(
  assets: readonly { readonly ticker: string; readonly allocationPct: DecimalString | null }[],
): AllocationBar[] {
  return assets.map(({ ticker, allocationPct }) => {
    if (allocationPct === null) return { ticker, widthPct: null, notPlotted: 'UNAVAILABLE' };
    const width = toChartNumber(allocationPct);
    return width < 0 || width > 100
      ? { ticker, widthPct: null, notPlotted: 'OUT_OF_SCALE' }
      : { ticker, widthPct: width, notPlotted: null };
  });
}

/** One position's arc on the allocation ring (fintech redesign). Geometry only. */
export interface AllocationArc {
  readonly ticker: string;
  /** The adapter width (percent of the fixed 0–100 % ring) this arc draws. */
  readonly pct: number;
  /** SVG stroke-dasharray / stroke-dashoffset for a circle of the given radius. */
  readonly dasharray: string;
  readonly dashoffset: string;
  /** Where the arc's number label sits (centre of the arc). */
  readonly labelX: number;
  readonly labelY: number;
}

/**
 * The allocation ring: each plotted bar becomes an arc on a fixed 0–100 % ring, in backend order,
 * starting at 12 o'clock. It uses the widths `allocationBars` already produced, so nothing new is
 * derived from a financial value; the cumulative position and the trigonometry are pixel geometry
 * only (the unfilled rest of the ring is never measured or labelled with a number). Only bars with
 * a width are drawn; the caller shows bars instead when any allocation is missing.
 */
export function allocationArcs(
  bars: readonly AllocationBar[],
  ring: { readonly radius: number; readonly center: number; readonly labelRadius: number },
): AllocationArc[] {
  const circumference = 2 * Math.PI * ring.radius; // pixel geometry, not a financial value
  const arcs: AllocationArc[] = [];
  let startPct = 0; // running pixel position on the ring, not a financial value
  for (const bar of bars) {
    if (bar.widthPct === null) continue;
    const length = (bar.widthPct / 100) * circumference;
    const gap = length > 4 ? 2 : 0; // a small visual gap between segments
    const mid = ((startPct + bar.widthPct / 2) / 100) * 2 * Math.PI - Math.PI / 2;
    arcs.push({
      ticker: bar.ticker,
      pct: bar.widthPct,
      dasharray: `${String(length - gap)} ${String(circumference)}`,
      dashoffset: String(-((startPct / 100) * circumference)),
      labelX: ring.center + ring.labelRadius * Math.cos(mid),
      labelY: ring.center + ring.labelRadius * Math.sin(mid),
    });
    startPct += bar.widthPct;
  }
  return arcs;
}

/** One currency's exposure bar (roadmap S3): a CSS width in percent of the axis. */
export interface ExposureBar {
  readonly currency: string;
  /** Bar width in percent of the axis (the bar's length is the absolute value), or `null`. */
  readonly widthPct: number | null;
  /** True for a negative backend value: drawn with the same length, in the negative style. */
  readonly negative: boolean;
  /** Why no bar is drawn: no value, no axis (gross exposure unavailable), or beyond the axis. */
  readonly notPlotted: 'UNAVAILABLE' | 'NO_AXIS' | 'OUT_OF_SCALE' | null;
}

/**
 * Currency exposure bars on a fixed axis from 0 to the backend's gross exposure. A currency's
 * absolute exposure never exceeds the gross exposure, and the currencies are never compared with
 * one another (no maximum, ranking, or normalization). Geometry only: the canonical backend
 * values are converted for plotting, a missing one is never drawn as zero, and a value beyond
 * the axis is reported, not clamped.
 */
export function exposureBars(
  entries: readonly { readonly currency: string; readonly marketValueBase: DecimalString | null }[],
  grossExposure: DecimalString | null,
): ExposureBar[] {
  const axis = grossExposure === null ? null : toChartNumber(grossExposure);
  return entries.map(({ currency, marketValueBase }) => {
    if (marketValueBase === null)
      return { currency, widthPct: null, negative: false, notPlotted: 'UNAVAILABLE' };
    const value = toChartNumber(marketValueBase);
    const negative = value < 0;
    const length = negative ? -value : value;
    if (axis === null || axis < 0) return { currency, widthPct: null, negative, notPlotted: 'NO_AXIS' };
    if (length === 0) return { currency, widthPct: 0, negative: false, notPlotted: null };
    if (axis === 0 || length > axis)
      return { currency, widthPct: null, negative, notPlotted: 'OUT_OF_SCALE' };
    return { currency, widthPct: (length / axis) * 100, negative, notPlotted: null };
  });
}
