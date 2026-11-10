// Loss distribution of the Base VaR scenarios (Kiroween decision A2; ui-guidelines 5).
// Every value is backend text: exact canonical decimals in the table and tooltips, backend
// display strings on the axis. Geometry comes from the chart adapter; nothing is calculated here.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { histogramPlot } from '../chartAdapter.js';
import type { AvailableLossDistribution, ChartFrame } from '../chartAdapter.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';
import { Help } from './Help.tsx';

type View = DashboardViewResponse;

const FRAME: ChartFrame = { width: 640, height: 260, left: 56, right: 16, top: 28, bottom: 52 };
/** Pixel x of the rotated y-axis label. */
const AXIS_LABEL_X = 14;

const rangeText = (bucket: AvailableLossDistribution['buckets'][number], currency: string): string =>
  `${bucket.lower} to ${bucket.upper} ${currency} (${bucket.upperInclusive ? 'upper edge included' : 'upper edge excluded'})`;

function Chart({ dist }: { readonly dist: AvailableLossDistribution }): ReactElement {
  const plot = histogramPlot(dist, FRAME);
  const currency = dist.currency;
  const confidence = confidencePct(dist.confidence);
  const marker = `VaR ${confidence} · ${dist.varMarker.rawQuantileDisplay} ${currency}`;
  const first = dist.buckets[0];
  const last = dist.buckets.at(-1);
  return (
    <svg
      className="loss-chart"
      viewBox={`0 0 ${String(FRAME.width)} ${String(FRAME.height)}`}
      role="img"
      aria-labelledby="loss-chart-title loss-chart-desc"
      data-testid="loss-chart"
    >
      <title id="loss-chart-title">
        Base VaR scenario losses, {String(dist.bucketCount)} buckets, {currency}
      </title>
      <desc id="loss-chart-desc">
        {`${String(dist.scenarioCount)} daily scenarios. The VaR marker at ${confidence} is ${dist.varMarker.rawQuantile} ${currency}. Scenarios with a larger loss: ${String(dist.varMarker.scenariosAbove)}. The table below lists every bucket.`}
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
      <text className="chart-axis-label" x={plot.centerX} y={FRAME.height} dy={-8} textAnchor="middle">
        Loss ({currency}); negative values are gains
      </text>
      <text
        className="chart-axis-label"
        x={AXIS_LABEL_X}
        y={plot.centerY}
        textAnchor="middle"
        transform={`rotate(-90 ${String(AXIS_LABEL_X)} ${String(plot.centerY)})`}
      >
        Scenarios (count)
      </text>
      {/* Bars: one per bucket; empty buckets are real zero counts. */}
      {plot.bars.map((bar) => {
        const bucket = dist.buckets[bar.index];
        return bucket === undefined ? null : (
          <rect
            key={bar.index}
            className="chart-bar"
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
    </svg>
  );
}

export function LossDistributionSection({ data }: { readonly data: View }): ReactElement {
  const dist = data.lossDistribution;
  const base = data.view.baseVaR;
  const params =
    dist.status === 'AVAILABLE'
      ? `Base VaR scenarios · 1 day · ${confidencePct(dist.confidence)} · Historical Simulation · as of ${utcText(dist.calculatedAt)}`
      : `Base VaR scenarios · 1 day · ${confidencePct(data.view.confidence)} · Historical Simulation`;
  return (
    <section className="section" aria-labelledby="loss-title" data-testid="loss-distribution">
      <h2 id="loss-title">
        Loss distribution <span className="muted-inline">· {params}</span>
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
        // Layout only: on wide screens the chart and its supporting text sit side by side; the
        // DOM order (chart first) is the reading and mobile order. No value changes here.
        <div className="loss-layout" data-testid="loss-layout">
          <div className="loss-main" data-testid="loss-main">
            <div className="legend" aria-hidden="true">
              <span className="legend-item">
                <span className="legend-swatch legend-bar" /> Scenario losses per bucket
              </span>
              <span className="legend-item">
                <span className="legend-swatch legend-marker" /> VaR {confidencePct(dist.confidence)} (raw
                quantile)
              </span>
            </div>
            {/* Focusable so keyboard users can scroll the chart on narrow screens (WCAG 2.1.1). */}
            <div
              className="chart-wrap"
              role="region"
              aria-label="Loss distribution chart, scrollable"
              tabIndex={0}
            >
              <Chart dist={dist} />
            </div>
          </div>
          <div className="loss-side" data-testid="loss-side">
            <p className="loss-side-label">Summary</p>
            <p className="caption" data-testid="loss-summary">
              {/* Concise: backend display text only. The exact, unrounded values are in the
                disclosure below (institutional refinement; nothing is rounded here). */}
              {String(dist.scenarioCount)} daily scenarios from returns ending {dist.scenarioWindow.firstDate}{' '}
              to {dist.scenarioWindow.lastDate} (UTC dates), in {String(dist.bucketCount)} buckets of{' '}
              {withUnit(dist.widthDisplay, dist.currency)}. VaR {confidencePct(dist.confidence)} marker at{' '}
              {withUnit(dist.varMarker.rawQuantileDisplay, dist.currency)}. Scenarios with a larger loss than
              the marker: {String(dist.varMarker.scenariosAbove)}. Not a forecast and not the worst possible
              loss.
            </p>
          </div>
          {/* Progressive disclosure (ui-guidelines §3): the summary above and the chart's own
              description stay visible; the exact bucket table is one native disclosure away.
              Closed, it sits in the side column under the summary; opened, it spans the card. */}
          <details className="disclosure loss-details" data-testid="loss-table-details">
            <summary>Exact values and bucket table ({String(dist.bucketCount)} buckets)</summary>
            <p className="exact-hint" id="loss-exact-hint">
              Full precision, unrounded. Scroll sideways in the boxes to read each value and the bucket table.
            </p>
            <div
              className="exact-values"
              role="region"
              aria-label="Exact loss distribution values, scrollable"
              aria-describedby="loss-exact-hint"
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
