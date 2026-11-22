// Loss distribution of the Base VaR scenarios (Kiroween decision A2; ui-guidelines 5).
// Every value is backend text: exact canonical decimals in the table and tooltips, backend
// display strings on the axis. Geometry comes from the chart adapter; nothing is calculated here.
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { histogramPlot } from '../chartAdapter.js';
import type { AvailableLossDistribution, ChartFrame } from '../chartAdapter.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';
import { Help } from './Help.tsx';

import './lossDistribution.css';

type View = DashboardViewResponse;

// Fintech redesign: a taller frame so the histogram is the dashboard's main visual.
const FRAME: ChartFrame = { width: 640, height: 360, left: 56, right: 16, top: 28, bottom: 52 };
// Narrow containers (phones, and tablets where the chart card is under 600 px): a compact frame
// exactly as wide as the chart's container, so the SVG is drawn at 1:1 and its text stays at its
// CSS size with no sideways scrolling. Same buckets, marker, tail, and labels; only the pixel
// geometry differs (the adapter places bars by integer bucket index).
const COMPACT_BELOW_PX = 600;
const COMPACT_MIN_PX = 240;
const compactFrame = (width: number): ChartFrame => ({
  width: width < COMPACT_MIN_PX ? COMPACT_MIN_PX : width, // pixel width, not a financial value
  height: 300,
  left: 40,
  right: 10,
  top: 28,
  bottom: 52,
});

/**
 * The chart container's width in CSS pixels, tracked across resizes, or null where it cannot be
 * measured (jsdom, or browsers without ResizeObserver), which keeps the wide frame.
 */
function useContainerWidth(ref: RefObject<HTMLElement | null>, mountKey: string): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver !== 'function') return undefined;
    const update = (): void => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mountKey]); // re-attach when the chart container appears or is replaced
  return width;
}

const rangeText = (bucket: AvailableLossDistribution['buckets'][number], currency: string): string =>
  `${bucket.lower} to ${bucket.upper} ${currency} (${bucket.upperInclusive ? 'upper edge included' : 'upper edge excluded'})`;

function Chart(props: {
  readonly dist: AvailableLossDistribution;
  readonly containerWidth: number | null;
  readonly overview: boolean;
}): ReactElement {
  const { dist, containerWidth, overview } = props;
  const id = useId();
  const [selected, setSelected] = useState(dist.varMarker.bucketIndex);
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered ?? selected;
  const inspected = dist.buckets[active];
  const committed = dist.buckets[selected];
  const compact = containerWidth !== null && containerWidth < COMPACT_BELOW_PX;
  const baseFrame = compact ? compactFrame(containerWidth) : FRAME;
  const frame = overview ? { ...baseFrame, height: 230 } : baseFrame;
  const axisLabelX = compact ? 12 : 14; // pixel x of the rotated y-axis label
  const plot = histogramPlot(dist, frame);
  const currency = dist.currency;
  const confidence = confidencePct(dist.confidence);
  const marker = `VaR ${confidence} · ${dist.varMarker.rawQuantileDisplay} ${currency}`;
  const first = dist.buckets[0];
  const last = dist.buckets.at(-1);
  const slotWidth = (plot.plotRight - plot.plotLeft) / dist.bucketCount;
  return (
    <>
      <svg
        onPointerLeave={() => setHovered(null)}
        onPointerCancel={() => setHovered(null)}
        className={compact ? 'loss-chart loss-chart-compact' : 'loss-chart'}
        viewBox={`0 0 ${String(frame.width)} ${String(frame.height)}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        data-testid="loss-chart"
      >
        <title id={`${id}-title`}>
          Base VaR scenario losses, {String(dist.bucketCount)} buckets, {currency}
        </title>
        <desc id={`${id}-desc`}>
          {`${String(dist.scenarioCount)} scenarios. The VaR marker at ${confidence} is ${dist.varMarker.rawQuantile} ${currency}. Scenarios with a larger loss: ${String(dist.varMarker.scenariosAbove)}. ${overview ? 'Open Risk Analytics for the exact bucket table.' : 'The table below lists every bucket.'}`}
        </desc>
        {/* Gridline at the maximum count (existing plot geometry; no value is computed). */}
        <line
          className="chart-grid"
          x1={plot.plotLeft}
          x2={plot.plotRight}
          y1={plot.plotTop}
          y2={plot.plotTop}
          aria-hidden="true"
        />
        {/* Axes */}
        <line
          className="chart-axis"
          x1={plot.plotLeft}
          x2={plot.plotRight}
          y1={plot.plotBottom}
          y2={plot.plotBottom}
        />
        <line
          className="chart-axis"
          x1={plot.plotLeft}
          x2={plot.plotLeft}
          y1={plot.plotTop}
          y2={plot.plotBottom}
        />
        <text className="chart-tick" x={plot.plotLeft} dx={-6} y={plot.plotBottom} textAnchor="end">
          0
        </text>
        <text className="chart-tick" x={plot.plotLeft} dx={-6} y={plot.plotTop} dy={4} textAnchor="end">
          {String(plot.maxCount)}
        </text>
        <text className="chart-tick" x={plot.plotLeft} y={plot.plotBottom} dy={18} textAnchor="start">
          {first === undefined ? MISSING : `${first.lowerDisplay} ${currency}`}
        </text>
        <text className="chart-tick" x={plot.plotRight} y={plot.plotBottom} dy={18} textAnchor="end">
          {last === undefined ? MISSING : `${last.upperDisplay} ${currency}`}
        </text>
        <text className="chart-axis-label" x={plot.centerX} y={frame.height} dy={-8} textAnchor="middle">
          Loss ({currency}); negative values are gains
        </text>
        <text
          className="chart-axis-label"
          x={axisLabelX}
          y={plot.centerY}
          textAnchor="middle"
          transform={`rotate(-90 ${String(axisLabelX)} ${String(plot.centerY)})`}
        >
          Scenarios (count)
        </text>
        <rect
          className="loss-active-slot"
          x={plot.plotLeft + active * slotWidth}
          y={plot.plotTop}
          width={slotWidth}
          height={plot.plotBottom - plot.plotTop}
          aria-hidden="true"
        />
        {/* Bars: one per bucket; empty buckets are real zero counts. */}
        {plot.bars.map((bar) => {
          const bucket = dist.buckets[bar.index];
          return bucket === undefined ? null : (
            <rect
              key={bar.index}
              // Tail emphasis by the backend's integer bucket index (no money comparison): the
              // bucket holding the VaR marker and every bucket beyond it.
              className={bar.index >= dist.varMarker.bucketIndex ? 'chart-bar chart-bar-tail' : 'chart-bar'}
              rx={2}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              data-testid={`loss-bar-${String(bar.index)}`}
            >
              <title>{`${rangeText(bucket, currency)}: ${String(bucket.count)} scenarios`}</title>
            </rect>
          );
        })}
        {/* VaR marker at the raw Type 7 quantile, labelled with its confidence. */}
        <line
          className="chart-marker"
          x1={plot.markerX}
          x2={plot.markerX}
          y1={plot.plotTop}
          y2={plot.plotBottom}
          data-testid="loss-var-marker"
        >
          <title>{`VaR ${confidence}: raw quantile ${dist.varMarker.rawQuantile} ${currency}`}</title>
        </line>
        <text
          className="chart-marker-label"
          x={plot.markerX}
          y={plot.plotTop}
          dx={plot.markerLabelAnchor === 'end' ? -4 : 4}
          dy={-8}
          textAnchor={plot.markerLabelAnchor}
        >
          {marker}
        </text>
        {plot.bars.map(({ index }) => (
          <rect
            key={index}
            className="loss-bucket-hit"
            aria-hidden="true"
            data-testid={`loss-hit-${String(index)}`}
            x={plot.plotLeft + index * slotWidth}
            y={plot.plotTop}
            width={slotWidth}
            height={plot.plotBottom - plot.plotTop}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') setHovered(index);
            }}
            onPointerLeave={() => setHovered(null)}
            onClick={() => {
              setHovered(null);
              setSelected(index);
            }}
          />
        ))}
      </svg>
      <div className="loss-inspector" data-testid="loss-inspector">
        <label className="loss-inspector-control">
          Inspect bucket
          <select
            value={selected}
            onChange={(event) => {
              setHovered(null);
              setSelected(event.currentTarget.selectedIndex);
            }}
          >
            {dist.buckets.map((_, index) => (
              <option key={index} value={index}>
                {String(index + 1)} of {String(dist.bucketCount)}
              </option>
            ))}
          </select>
        </label>
        <div className="loss-inspector-value" aria-hidden="true" data-testid="loss-bucket-value">
          {inspected === undefined ? null : (
            <>
              <strong>
                Bucket {String(active + 1)} · {String(inspected.count)} scenarios
              </strong>
              <span>
                Approx. {inspected.lower.replace(/([.][0-9]{2})[0-9]+$/, '$1')} to{' '}
                {inspected.upper.replace(/([.][0-9]{2})[0-9]+$/, '$1')} {currency}
              </span>
            </>
          )}
        </div>
        <details className="loss-bucket-exact">
          <summary>Exact selected range</summary>
          <p>{committed === undefined ? null : rangeText(committed, currency)}</p>
        </details>
        <span className="loss-inspector-announcement" role="status">
          {committed === undefined
            ? null
            : `Bucket ${String(selected + 1)}: ${String(committed.count)} scenarios; ${rangeText(committed, currency)}`}
        </span>
      </div>
    </>
  );
}

export function LossDistributionSection({
  data,
  compact = false,
}: {
  readonly data: View;
  readonly compact?: boolean;
}): ReactElement {
  const id = useId();
  const titleId = compact ? `${id}-title` : 'loss-title';
  const dist = data.lossDistribution;
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartWidth = useContainerWidth(wrapRef, `${data.portfolioId}:${dist.status}`);
  const base = data.view.baseVaR;
  const params =
    dist.status === 'AVAILABLE'
      ? `Base VaR scenarios · 1 day · ${confidencePct(dist.confidence)} · Historical Simulation · as of ${utcText(dist.calculatedAt)}`
      : `Base VaR scenarios · 1 day · ${confidencePct(data.view.confidence)} · Historical Simulation`;
  return (
    <section
      className={`section chart-surface theme-dark loss-distribution ${compact ? 'loss-overview' : 'loss-analytics'}`}
      aria-labelledby={titleId}
      data-testid="loss-distribution"
    >
      <h2 id={titleId}>
        Loss distribution <span className="muted-inline">· {compact ? 'Base VaR scenarios' : params}</span>
      </h2>
      <p className="badges" data-testid="loss-badges">
        {dist.status === 'AVAILABLE' ? (
          <Badge tone={toneOf(base.validity)} label={base.validity} />
        ) : (
          <Badge tone="unavailable" label="UNAVAILABLE" />
        )}
        {data.dataMode === 'DEMO' ? (
          <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
        ) : null}
        <Help term="lossDistribution" />
      </p>
      {dist.status === 'UNAVAILABLE' ? (
        <p className="reason" data-testid="loss-unavailable">
          Unavailable ({codeLabel(dist.reason)}): {dist.explanation}
        </p>
      ) : (
        // Layout only: chart first, then the summary and disclosure (the DOM order is the reading
        // order on every screen size). No value changes here.
        <div className="loss-layout" data-testid="loss-layout">
          <div className="loss-main" data-testid="loss-main">
            <div className="legend" aria-hidden="true">
              <span className="legend-item">
                <span className="legend-swatch legend-bar" /> Scenario losses per bucket
              </span>
              <span className="legend-item">
                <span className="legend-swatch legend-tail" /> Bucket containing the VaR marker and buckets
                beyond it
              </span>
              <span className="legend-item">
                <span className="legend-swatch legend-marker" /> VaR {confidencePct(dist.confidence)} (raw
                quantile)
              </span>
            </div>
            {/* Measured container for the chart frame; the chart fits its width, so it no longer
                scrolls. The focusable region and its label are kept unchanged (tests rely on them). */}
            <div
              ref={wrapRef}
              className="chart-wrap"
              role="region"
              aria-label="Loss distribution chart, scrollable"
              tabIndex={0}
            >
              <Chart
                key={`${data.portfolioId}:${dist.calculatedAt}`}
                dist={dist}
                containerWidth={chartWidth}
                overview={compact}
              />
            </div>
          </div>
          {compact ? (
            <p className="caption loss-overview-note" data-testid="loss-summary">
              <strong className="scenario-fraction">
                {String(dist.varMarker.scenariosAbove)} of {String(dist.scenarioCount)} scenarios exceeded the
                VaR marker.
              </strong>{' '}
              VaR {confidencePct(dist.confidence)} marker at{' '}
              {withUnit(dist.varMarker.rawQuantileDisplay, dist.currency)}. The orange bucket containing the
              marker may include scenarios at or below it.
            </p>
          ) : (
            <div className="loss-side" data-testid="loss-side">
              <p className="loss-side-label">Scenario analysis</p>
              <p className="caption" data-testid="loss-summary">
                {/* Concise: backend display text only. The exact, unrounded values are in the
                disclosure below (institutional refinement; nothing is rounded here). */}
                <strong className="scenario-fraction">
                  {String(dist.varMarker.scenariosAbove)} of {String(dist.scenarioCount)} scenarios exceeded
                  the VaR marker.
                </strong>
                {String(dist.scenarioCount)} scenarios from returns ending {dist.scenarioWindow.firstDate} to{' '}
                {dist.scenarioWindow.lastDate} (UTC dates), in {String(dist.bucketCount)} buckets of{' '}
                {withUnit(dist.widthDisplay, dist.currency)}. VaR {confidencePct(dist.confidence)} marker at{' '}
                {withUnit(dist.varMarker.rawQuantileDisplay, dist.currency)}. The orange bucket containing the
                marker may include scenarios at or below it. Not a forecast and not the worst possible loss.
              </p>
            </div>
          )}
          {/* Progressive disclosure (ui-guidelines §3): the summary above and the chart's own
              description stay visible; the exact bucket table is one native disclosure away.
              Closed, it sits in the side column under the summary; opened, it spans the card. */}
          <details className="disclosure loss-details" data-testid="loss-table-details">
            <summary>Exact values and bucket table ({String(dist.bucketCount)} buckets)</summary>
            <p className="exact-hint" id={`${id}-exact-hint`}>
              Full precision, unrounded. Scroll sideways in the boxes to read each value and the bucket table.
            </p>
            <div
              className="exact-values"
              role="region"
              aria-label="Exact loss distribution values, scrollable"
              aria-describedby={`${id}-exact-hint`}
              tabIndex={0}
              data-testid="loss-exact"
            >
              <dl className="facts">
                <dt>VaR {confidencePct(dist.confidence)} marker: raw quantile (exact, unrounded)</dt>
                <dd className="num">{withUnit(dist.varMarker.rawQuantile, dist.currency)}</dd>
                <dt>Bucket width (exact)</dt>
                <dd className="num">{withUnit(dist.width, dist.currency)}</dd>
              </dl>
            </div>
            <div
              className="table-wrap"
              role="region"
              aria-label="Loss distribution table, scrollable"
              tabIndex={0}
            >
              <table data-testid="loss-table">
                <caption>
                  Every bucket with exact edges in {dist.currency}; lower edges are included, upper edges are
                  excluded except in the last bucket
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      Bucket
                    </th>
                    <th scope="col" className="num">
                      Lower ({dist.currency})
                    </th>
                    <th scope="col" className="num">
                      Upper ({dist.currency})
                    </th>
                    <th scope="col">Upper edge</th>
                    <th scope="col" className="num">
                      Scenarios (count)
                    </th>
                    <th scope="col">VaR marker</th>
                  </tr>
                </thead>
                <tbody>
                  {dist.buckets.map((bucket, index) => (
                    <tr key={bucket.lower}>
                      <th scope="row" className="num">
                        {String(index + 1)}
                      </th>
                      <td className="num">{bucket.lower}</td>
                      <td className="num">{bucket.upper}</td>
                      <td>{bucket.upperInclusive ? 'included' : 'excluded'}</td>
                      <td className="num">{String(bucket.count)}</td>
                      <td>
                        {index === dist.varMarker.bucketIndex
                          ? `VaR ${confidencePct(dist.confidence)} at ${dist.varMarker.rawQuantile}`
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
