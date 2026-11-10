// Top bar (ui-guidelines 3): portfolio, base currency, NAV, data as-of time, data mode, source,
// and FX freshness, always visible. Kiroween identity is a small static mark and a label only.
import type { ReactElement } from 'react';
import type { DashboardIndexResponse, DashboardViewResponse } from '../../shared/apiContracts/index.js';
import type { SourceInfo } from '../data/source.js';
import { MISSING, codeLabel, utcText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';

function ChimeraMark(): ReactElement {
  // A static, single-colour mark: three joined heads of the chimera. Decorative only.
  return (
    <svg className="mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M4 14c0-4 3-7 8-7s8 3 8 7v5l-2-1.5L16 19l-2-1.5L12 19l-2-1.5L8 19l-2-1.5L4 19z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="12.5" r="1" fill="currentColor" />
      <circle cx="14.5" cy="12.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function TopBar(props: {
  readonly source: SourceInfo | undefined;
  readonly index: DashboardIndexResponse | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onReload: () => void;
  readonly data: DashboardViewResponse | undefined;
}): ReactElement {
  const { data } = props;
  return (
    <header className="topbar">
      <div className="brand">
        <ChimeraMark />
        <div>
          <h1 className="brand-name">Spectral Risk Chimera</h1>
          <p className="brand-tag">Kiroween 2026 · Frankenstein build · monitoring only, no trading</p>
        </div>
      </div>
      <div className="topbar-controls">
        <label htmlFor="portfolio-select">Portfolio</label>
        <select
          id="portfolio-select"
          value={props.selected ?? ''}
          onChange={(event) => props.onSelect(event.currentTarget.value)}
          disabled={props.index === undefined || props.index.portfolios.length === 0}
        >
          {(props.index?.portfolios ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.id} ({p.baseCurrency})
            </option>
          ))}
        </select>
        <button type="button" onClick={props.onReload}>
          Reload
        </button>
      </div>
      <dl className="topbar-facts" aria-label="Data status">
        <div>
          <dt>Data</dt>
          <dd>
            {data === undefined ? (
              MISSING
            ) : (
              <Badge tone={toneOf(data.dataMode)} label={data.dataMode === 'DEMO' ? 'DEMO DATA' : 'REAL'} />
            )}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {props.source === undefined ? (
              MISSING
            ) : props.source.kind === 'REPLAY' ? (
              <>
                <Badge tone="info" label="RECORDED REPLAY" title="Recorded responses, not live data" />{' '}
                recorded {utcText(props.source.recordedAt ?? null)}
              </>
            ) : (
              'Live local backend'
            )}
          </dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{data === undefined ? MISSING : codeLabel(data.runMode)}</dd>
        </div>
        <div>
          <dt>NAV</dt>
          <dd className="num" data-testid="topbar-nav">
            {data === undefined ? MISSING : withUnit(data.display.exposure.nav, data.display.currency)}
            {data?.dataMode === 'DEMO' ? (
              <>
                {' '}
                <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Market data as of</dt>
          <dd>{data?.freshness.asOfDate ?? MISSING}</dd>
        </div>
        <div>
          <dt>Calculated</dt>
          <dd>{data === undefined ? MISSING : utcText(data.freshness.calculatedAt)}</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>
            {data === undefined ? (
              MISSING
            ) : (
              <Badge tone={toneOf(data.freshness.summary)} label={codeLabel(data.freshness.summary)} />
            )}
          </dd>
        </div>
      </dl>
      {props.source?.note !== undefined ? <p className="replay-note">{props.source.note}</p> : null}
    </header>
  );
}
