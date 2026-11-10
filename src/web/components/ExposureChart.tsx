// Currency exposure chart (roadmap S3): one horizontal bar per instrument currency, in the
// backend's currency order, on a fixed axis from 0 to the backend's gross exposure. Labels are
// the backend's display money text in the base currency; bar widths come from the chart adapter.
// A negative value keeps its "-" sign in the label and is drawn as an outlined bar. A missing
// value has no bar and keeps its status. The currency exposure table below stays the
// exact-value table. Nothing is summed, sorted, normalized, or ranked here.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { exposureBars } from '../chartAdapter.js';
import { MISSING, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';

type View = DashboardViewResponse;

export function ExposureChart({ data }: { readonly data: View }): ReactElement {
  const currency = data.display.currency;
  const text = new Map(data.display.currencyExposure.map((entry) => [entry.currency, entry.marketValueBase]));
  const bars = exposureBars(data.currencyExposure, data.view.exposure.gross);
  const noAxis = bars.some((bar) => bar.notPlotted === 'NO_AXIS');
  return (
    <figure className="allocation" aria-labelledby="exposure-chart-title" data-testid="exposure-chart">
      <figcaption id="exposure-chart-title" className="allocation-title">
        Exposure by currency, in {currency}{' '}
        <span className="muted-inline">
          · axis 0 to gross exposure ({withUnit(data.display.exposure.gross, currency)}) · outlined bars are
          negative values
        </span>
        {data.dataMode === 'DEMO' ? (
          <>
            {' '}
            <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
          </>
        ) : null}
      </figcaption>
      {noAxis ? (
        <p className="reason" data-testid="exposure-no-axis">
          Gross exposure is unavailable, so no bar can be drawn on a consistent scale. The values are listed
          below.
        </p>
      ) : null}
      <ul className="allocation-bars">
        {bars.map((bar, i) => {
          const entry = data.currencyExposure[i];
          if (entry === undefined) return null;
          return (
            <li key={bar.currency} className="allocation-row" data-testid={`exposure-${bar.currency}`}>
              <span className="allocation-ticker">{bar.currency}</span>
              <span className="allocation-track" aria-hidden="true">
                {bar.widthPct === null ? null : (
                  <span
                    className={bar.negative ? 'allocation-bar bar-negative' : 'allocation-bar'}
                    style={{ width: `${String(bar.widthPct)}%` }}
                  />
                )}
              </span>
              <span className="allocation-value num">
                {withUnit(text.get(bar.currency) ?? null, currency)}
                {entry.status === 'OK' ? null : (
                  <>
                    {' '}
                    <Badge tone={toneOf(entry.status)} label={entry.status} />
                  </>
                )}
                {bar.notPlotted === 'OUT_OF_SCALE' ? (
                  <>
                    {' '}
                    <Badge tone="warning" label="NOT PLOTTED (BEYOND AXIS)" />
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {data.currencyExposure.length === 0 ? <p className="reason">{MISSING} No currency exposure.</p> : null}
    </figure>
  );
}
