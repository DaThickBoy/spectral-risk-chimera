// Top bar (ui-guidelines 3): identity, portfolio selection, data mode, data source, and run mode,
// always visible. NAV, exposure, as-of time, and freshness are the headline summary below it
// (Summary.tsx). Kiroween identity is a small static mark and a label only.
import type { ReactElement } from 'react';
import type { DashboardIndexResponse, DashboardViewResponse } from '../../shared/apiContracts/index.js';
import type { StreamState } from '../data/liveUpdates.js';
import type { LoadError, SourceInfo } from '../data/source.js';
import { MISSING, codeLabel, utcText } from '../format.js';
import { useLiveProviders, useLiveStatus } from '../live.tsx';
import { Badge, toneOf } from './Badge.tsx';
import type { BadgeTone } from './Badge.tsx';

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

/** Sidebar links: each targets an existing section heading's id. */
const SECTIONS: readonly (readonly [string, string])[] = [
  ['#summary-title', 'Overview'],
  ['#loss-title', 'Loss distribution'],
  ['#allocation-heading', 'Allocation'],
  ['#base-var-title', 'Risk signals'],
  ['#positions-title', 'Positions'],
  ['#ccy-title', 'Currency and FX'],
];

const STREAM_BADGE: Readonly<Record<StreamState, { tone: BadgeTone; label: string }>> = {
  CONNECTING: { tone: 'neutral', label: 'STREAM CONNECTING' },
  CONNECTED: { tone: 'current', label: 'STREAM CONNECTED' },
  RECONNECTING: { tone: 'warning', label: 'STREAM RECONNECTING' },
  DISCONNECTED: { tone: 'unavailable', label: 'STREAM DISCONNECTED' },
};

/** LIVE mode: the update stream's state, a failed refresh, and providers that are not available. */
function LiveStatus(props: { readonly refreshError: LoadError | undefined }): ReactElement | null {
  const status = useLiveStatus();
  const providers = useLiveProviders().filter((p) => p.state !== 'AVAILABLE');
  if (status === undefined) return null;
  const badge = STREAM_BADGE[status.state];
  return (
    <span className="live-status" role="status" data-testid="live-status">
      <Badge tone={badge.tone} label={badge.label} />
      {status.state === 'RECONNECTING' ? ` attempt ${String(status.attempt)}` : null}
      {props.refreshError === undefined ? null : (
        <>
          {' '}
          <Badge
            tone="warning"
            label="REFRESH FAILED"
            title={`The last automatic refresh failed (${codeLabel(props.refreshError)}); the previous view is shown.`}
          />
        </>
      )}
      {providers.map((p) => (
        <span key={p.provider} className="muted-inline" data-testid="live-provider">
          {' '}
          · {p.provider} {codeLabel(p.state)}
          {p.lastErrorCode === undefined ? '' : ` (${codeLabel(p.lastErrorCode)})`}
        </span>
      ))}
    </span>
  );
}

export function TopBar(props: {
  readonly source: SourceInfo | undefined;
  readonly index: DashboardIndexResponse | undefined;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onReload: () => void;
  readonly data: DashboardViewResponse | undefined;
  /** LIVE mode: why the last automatic view refresh failed (the previous view stays shown). */
  readonly refreshError?: LoadError | undefined;
  /** Starts the guided tour, or ends it when it is running. */
  readonly onTour: () => void;
  readonly tourActive: boolean;
}): ReactElement {
  const { data } = props;
  // Fintech redesign: the navy sidebar (header.topbar) carries identity and every provenance
  // item; the light page header carries the title and controls. DOM order is unchanged:
  // identity first, then the controls, so the keyboard order stays skip link, selector, Reload.
  const controls = (
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
      {/* Guided tour (ui-guidelines §8): optional, user-started; pressed while running. */}
      <button
        type="button"
        id="tour-start"
        onClick={props.onTour}
        aria-pressed={props.tourActive}
        disabled={data === undefined}
        data-testid="tour-start"
      >
        Guided tour
      </button>
    </div>
  );
  return (
    <>
      <header className="topbar theme-dark">
        <div className="brand">
          <ChimeraMark />
          <div>
            <h1 className="brand-name">Spectral Risk Chimera</h1>
            <p className="brand-tag">Kiroween 2026 · Frankenstein build · monitoring only, no trading</p>
          </div>
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
                <>
                  Live local backend <LiveStatus refreshError={props.refreshError} />
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{data === undefined ? MISSING : codeLabel(data.runMode)}</dd>
          </div>
        </dl>
        {props.source?.note !== undefined ? <p className="replay-note">{props.source.note}</p> : null}
        {/* In-page links to the dashboard's existing section headings (only once they exist).
            Hidden on narrow screens, where the sidebar is a compact header. */}
        {data === undefined ? null : (
          <nav className="sidebar-nav" aria-label="Dashboard sections">
            <ul>
              {SECTIONS.map(([href, label]) => (
                <li key={href}>
                  <a href={href}>{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>
      <div className="page-header" role="region" aria-label="Portfolio overview and controls">
        <div>
          <p className="page-title">Portfolio overview</p>
          <p className="page-subtitle">
            {data === undefined
              ? 'Loading portfolio data'
              : `${data.portfolioId} · base currency ${data.view.baseCurrency}`}
          </p>
        </div>
        {controls}
      </div>
    </>
  );
}
