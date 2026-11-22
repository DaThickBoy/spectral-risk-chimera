// Use the backend percentages as labels. Geometry comes from the chart adapter.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { allocationArcs, allocationBars, compareDecimalText, longOnlyWithinNav } from '../chartAdapter.js';
import { codeLabel, percentText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';

type View = DashboardViewResponse;

/** Categorical chart shades (CSS tokens `--chart-seq-1` to `-6`: blue, green, violet), cycled. */
const SEQUENCE = 6;
/** Ring geometry in SVG units (viewBox 0 0 220 220). */
const RING = { center: 110, radius: 84, labelRadius: 84 } as const;

export function AllocationChart({ data }: { readonly data: View }): ReactElement {
  const assets = data.view.assets;
  const values = new Map(data.display.assets.map((asset) => [asset.ticker, asset.marketValueBase]));
  const ranked = [...assets].sort((a, b) => {
    const left = a.allocationPct;
    const right = b.allocationPct;
    const tickerOrder = a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    if (left === null || right === null) {
      return left === right ? tickerOrder : left === null ? 1 : -1;
    }
    return compareDecimalText(right, left) || tickerOrder;
  });
  const bars = allocationBars(assets);
  const none = bars.every((bar) => bar.notPlotted === 'UNAVAILABLE');
  const { cash, gross, nav } = data.view.exposure;
  // The track may represent cash only for an eligible long-only allocation. Prefer ranked bars
  // when slices cannot be individually labelled, exceed the palette, or are unavailable.
  const composition =
    !none &&
    longOnlyWithinNav({ cash, gross, nav }, assets) &&
    bars.length <= SEQUENCE &&
    bars.every((bar) => bar.notPlotted === null && bar.widthPct !== null && bar.widthPct >= 6);
  // Arc geometry from the same adapter widths (pixels only); empty when bars are shown instead.
  const arcs = composition ? allocationArcs(bars, RING) : [];
  return (
    <figure className="allocation" aria-labelledby="allocation-title" data-testid="allocation-chart">
      <figcaption id="allocation-title" className="allocation-title">
        Allocation by position{' '}
        <span className="muted-inline">· % as reported by the backend · axis 0–100 %</span>
        {data.dataMode === 'DEMO' ? (
          <>
            {' '}
            <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
          </>
        ) : null}
      </figcaption>
      {none ? (
        <p className="reason" data-testid="allocation-unavailable">
          No allocation is available for this portfolio, so nothing is plotted. Each position&apos;s status is
          in the table below.
        </p>
      ) : composition ? (
        <>
          {/* Decorative ring: the legend below carries every value as text. Each arc carries the
              same position number as its legend entry, so colour is never the only cue. The
              empty track is the unfilled part, described in words in the legend. */}
          <svg
            className="donut"
            viewBox={`0 0 ${String(RING.center * 2)} ${String(RING.center * 2)}`}
            aria-hidden="true"
            focusable="false"
            data-testid="allocation-composition"
          >
            <circle className="donut-track" cx={RING.center} cy={RING.center} r={RING.radius} />
            {arcs.map((arc, i) => (
              <circle
                key={arc.ticker}
                className={`donut-arc seq-${String((i % SEQUENCE) + 1)}`}
                cx={RING.center}
                cy={RING.center}
                r={RING.radius}
                strokeDasharray={arc.dasharray}
                strokeDashoffset={arc.dashoffset}
                transform={`rotate(-90 ${String(RING.center)} ${String(RING.center)})`}
                data-testid={`allocation-segment-${arc.ticker}`}
                data-pct={String(arc.pct)}
              />
            ))}
            {arcs.map((arc, i) =>
              arc.pct < 6 ? null : (
                <text
                  key={arc.ticker}
                  className="donut-label"
                  x={arc.labelX}
                  y={arc.labelY}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {String(i + 1)}
                </text>
              ),
            )}
            <text className="donut-center" x={RING.center} y={RING.center - 6} textAnchor="middle">
              {String(arcs.length)}
            </text>
            <text className="donut-center-label" x={RING.center} y={RING.center + 16} textAnchor="middle">
              {arcs.length === 1 ? 'position' : 'positions'}
            </text>
          </svg>
          <ul className="composition-legend" aria-label="Allocation by position">
            {bars.map((bar, i) => {
              const asset = assets[i];
              if (asset === undefined) return null;
              return (
                <li key={bar.ticker} className="composition-item" data-testid={`allocation-${bar.ticker}`}>
                  <span className={`swatch seq-${String((i % SEQUENCE) + 1)}`} aria-hidden="true">
                    {String(i + 1)}
                  </span>
                  <span className="allocation-ticker holding-identity">
                    {bar.ticker}
                    <span className="muted-block">{asset.currency}</span>
                  </span>
                  <span className="allocation-value num holding-values">
                    {percentText(asset.allocationPct)}
                    <span className="muted-block">
                      {withUnit(values.get(asset.ticker) ?? null, data.display.currency)}
                    </span>
                  </span>
                </li>
              );
            })}
            {/* Described, never computed: the browser does not derive the remainder. */}
            <li className="composition-item composition-unfilled" data-testid="allocation-remainder-note">
              <span className="swatch swatch-unfilled" aria-hidden="true" />
              <span>
                Cash balance: {withUnit(data.display.exposure.cash, data.display.currency)} (shown by the
                uncoloured track for eligible allocations)
              </span>
            </li>
          </ul>
        </>
      ) : (
        <ol className="allocation-bars" aria-label="Positions ordered by allocation, largest first">
          {allocationBars(ranked).map((bar, i) => {
            const asset = ranked[i];
            if (asset === undefined) return null;
            return (
              <li key={bar.ticker} className="allocation-row" data-testid={`allocation-${bar.ticker}`}>
                <span className="allocation-ticker">{bar.ticker}</span>
                <span className="allocation-track" aria-hidden="true">
                  {bar.widthPct === null ? null : (
                    <span className="allocation-bar" style={{ width: `${String(bar.widthPct)}%` }} />
                  )}
                </span>
                <span className="allocation-value num">
                  {percentText(asset.allocationPct)}
                  {bar.notPlotted === null ? null : (
                    <>
                      {' '}
                      <Badge
                        tone={bar.notPlotted === 'UNAVAILABLE' ? toneOf(asset.valuationStatus) : 'warning'}
                        label={
                          bar.notPlotted === 'UNAVAILABLE'
                            ? codeLabel(asset.valuationStatus)
                            : 'NOT PLOTTED (OUTSIDE 0–100 %)'
                        }
                      />
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {none || composition ? null : (
        <p className="caption allocation-cash-note">
          Cash balance: {withUnit(data.display.exposure.cash, data.display.currency)} (not plotted; the bars
          show each position&apos;s allocation of NAV).
        </p>
      )}
    </figure>
  );
}
