// Allocation chart (roadmap S2): one horizontal bar per position on a fixed 0–100 % axis, in the
// backend's position order. Labels are the backend's exact allocation text (padded only, as in
// the positions table); bar widths come from the chart adapter. A missing allocation has no bar
// and says why, never a zero-length bar. The positions table below stays the exact-value table.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { allocationBars } from '../chartAdapter.js';
import { codeLabel, percentText } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';

type View = DashboardViewResponse;

/** Neutral, non-semantic segment shades (CSS tokens `--chart-seq-1` to `-6`), cycled. */
const SEQUENCE = 6;

export function AllocationChart({ data }: { readonly data: View }): ReactElement {
  const assets = data.view.assets;
  const bars = allocationBars(assets);
  const none = bars.every((bar) => bar.notPlotted === 'UNAVAILABLE');
  // Institutional redesign: when every position is plotted on the 0–100 % axis, show one
  // composition bar (the same adapter widths, side by side) with a labelled legend. Any missing
  // or off-scale allocation falls back to one bar per position, so nothing is ever drawn as zero.
  const composition = !none && bars.every((bar) => bar.notPlotted === null && bar.widthPct !== null);
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
          {/* Decorative: the legend below carries every value as text. Each segment carries the
              same position number as its legend entry, so shade is never the only cue; a
              segment too narrow for its number still has it in the legend. */}
          <span className="composition" aria-hidden="true" data-testid="allocation-composition">
            {bars.map((bar, i) => (
              <span
                key={bar.ticker}
                className={`composition-segment seq-${String((i % SEQUENCE) + 1)}`}
                style={{ width: `${String(bar.widthPct)}%` }}
                data-testid={`allocation-segment-${bar.ticker}`}
              >
                {String(i + 1)}
              </span>
            ))}
          </span>
          <ul className="composition-legend" aria-label="Allocation by position">
            {bars.map((bar, i) => {
              const asset = assets[i];
              if (asset === undefined) return null;
              return (
                <li key={bar.ticker} className="composition-item" data-testid={`allocation-${bar.ticker}`}>
                  <span className={`swatch seq-${String((i % SEQUENCE) + 1)}`} aria-hidden="true">
                    {String(i + 1)}
                  </span>
                  <span className="allocation-ticker">{bar.ticker}</span>
                  <span className="allocation-value num">{percentText(asset.allocationPct)}</span>
                </li>
              );
            })}
            {/* Described, never computed: the browser does not derive the remainder. */}
            <li className="composition-item composition-unfilled" data-testid="allocation-remainder-note">
              <span className="swatch swatch-unfilled" aria-hidden="true" />
              <span>Unfilled: not a listed position, for example cash (see Cash in the summary)</span>
            </li>
          </ul>
        </>
      ) : (
        <ul className="allocation-bars">
          {bars.map((bar, i) => {
            const asset = assets[i];
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
        </ul>
      )}
    </figure>
  );
}
