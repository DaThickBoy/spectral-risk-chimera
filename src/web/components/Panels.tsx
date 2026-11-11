// The four separate risk panels in the required order (R35.1): Base VaR, Sentiment-Adjusted VaR,
// Market Sentiment, SEC Filing Risk. They never share a gauge, a scale, or a combined score.
// Every figure is backend text; nothing is calculated here.
import type { ReactElement, ReactNode } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { newerSentiment } from '../data/liveUpdates.js';
import type { SentimentDisplay } from '../data/liveUpdates.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import { useLiveSentiment } from '../live.tsx';
import type { GlossaryKey } from '../glossary.js';
import { Badge, toneOf } from './Badge.tsx';
import { Help } from './Help.tsx';

type View = DashboardViewResponse;

function Panel(props: {
  readonly id: string;
  readonly title: string;
  readonly params: string;
  /** S4: contextual help next to the parameters (outside the heading, so its name stays clean). */
  readonly help?: GlossaryKey;
  /** S5: visual weight only. `primary` for the headline risk figure; `compact` for status-only panels. */
  readonly tier?: 'primary' | 'compact';
  readonly children: ReactNode;
}): ReactElement {
  const tierClass = props.tier === undefined ? '' : ` panel-${props.tier}`;
  return (
    <section
      className={`panel${tierClass}`}
      aria-labelledby={`${props.id}-title`}
      data-testid={`panel-${props.id}`}
    >
      <header className="panel-header">
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        <p className="panel-params">
          {props.params}
          {props.help === undefined ? null : <Help term={props.help} />}
        </p>
      </header>
      {props.children}
    </section>
  );
}

export function BaseVarPanel({ data }: { readonly data: View }): ReactElement {
  const base = data.view.baseVaR;
  const currency = data.display.currency;
  return (
    <Panel
      id="base-var"
      title="Base VaR"
      params={`1 day · ${confidencePct(data.view.confidence)} · asset-price VaR · FX held fixed · Historical Simulation · as of ${data.freshness.asOfDate ?? MISSING}`}
      help="confidence"
      tier="primary"
    >
      <p className="metric" data-testid="base-var-value">
        {withUnit(data.display.baseVaR, currency)}
      </p>
      <p className="badges">
        <Badge tone={toneOf(base.validity)} label={base.validity} />
        {data.dataMode === 'DEMO' ? (
          <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
        ) : null}
      </p>
      {base.value === null ? (
        <p className="reason">
          Unavailable: {codeLabel(base.reason.code ?? base.status)}
          {base.reason.missingConfigKeys.length > 0
            ? ` (missing: ${base.reason.missingConfigKeys.join(', ')})`
            : ''}
        </p>
      ) : (
        // Institutional redesign: the full-precision backend values (about 40 digits) stay exact
        // and complete, one disclosure away, on one line each in a keyboard-scrollable region,
        // instead of wrapping across the headline panel. Nothing is rounded in the browser
        // (ui-guidelines §2, §9).
        <details className="disclosure" data-testid="base-var-exact">
          <summary>Exact values (share of NAV, raw quantile)</summary>
          <p className="exact-hint" id="base-var-exact-hint">
            Full precision, unrounded. Scroll sideways in the box to read each value.
          </p>
          <div
            className="exact-values"
            role="region"
            aria-label="Exact Base VaR values, scrollable"
            aria-describedby="base-var-exact-hint"
            tabIndex={0}
          >
            <dl className="facts">
              <dt>Share of NAV (exact)</dt>
              <dd className="num">{withUnit(base.value.percentOfNav, '%')}</dd>
              <dt>
                Raw quantile loss (exact)
                <Help term="rawQuantile" />
              </dt>
              <dd className="num">{withUnit(base.value.rawQuantile, currency)}</dd>
            </dl>
          </div>
        </details>
      )}
      {base.lastValid !== null ? (
        <p className="last-valid">
          <Badge tone="warning" label="LAST VALID" /> {withUnit(data.display.baseVaRLastValid, currency)} from{' '}
          {utcText(base.lastValid.calculatedAt)}
        </p>
      ) : null}
      <p className="caption">
        A percentile-based one-day loss estimate at the stated confidence. It is not the maximum drawdown and
        not the worst possible loss.
      </p>
    </Panel>
  );
}

export function AdjustedVarPanel({ data }: { readonly data: View }): ReactElement {
  const adjusted = data.view.sentimentAdjustedVaR;
  const availability = data.adjustedVaRAvailability;
  return (
    <Panel
      id="adjusted-var"
      title="Sentiment-Adjusted VaR"
      params={`1 day · ${confidencePct(data.view.confidence)} · as of ${data.freshness.asOfDate ?? MISSING}`}
      help="adjustedVar"
      {...(adjusted.value === null ? { tier: 'compact' as const } : {})}
    >
      {adjusted.value === null ? (
        <>
          <p className="metric metric-unavailable" data-testid="adjusted-var-value">
            Unavailable
          </p>
          <p className="badges">
            <Badge tone="unavailable" label="UNAVAILABLE" />
            {availability.reasonCode !== null ? (
              <Badge
                tone="info"
                label={`${codeLabel(availability.reasonCode)} · ${availability.openDecision ?? ''}`}
              />
            ) : null}
          </p>
          {/* S5: the concise status stays visible; the engine status and full reason are one
              native disclosure away (keyboard: Tab to the summary, Enter or Space toggles). */}
          <details className="disclosure" data-testid="adjusted-var-details">
            <summary>Why it is unavailable</summary>
            <p className="badges">
              <Badge tone="neutral" label={codeLabel(adjusted.status)} />
            </p>
            <p className="reason" data-testid="adjusted-var-reason">
              {availability.explanation}
            </p>
          </details>
        </>
      ) : (
        <>
          <p className="metric" data-testid="adjusted-var-value">
            {withUnit(data.display.adjustedVaR, data.display.currency)}
          </p>
          <p className="badges">
            <Badge tone={toneOf(adjusted.validity)} label={adjusted.validity} />
          </p>
          <p className="reason">{data.view.adjustmentExplanation}</p>
        </>
      )}
    </Panel>
  );
}

/** What a displayed sentiment value is, from the backend `basis` (text only). */
const SENTIMENT_BASIS: Readonly<Record<string, string>> = {
  INDEX: 'aggregated index',
  LATEST_OBSERVATION: 'latest observation, not an aggregated index',
};

/**
 * One ticker's sentiment. In LIVE mode it subscribes to that ticker only (task 17.4), and shows
 * the newer of the view's value and the streamed one, exactly as the backend sent it.
 */
function SentimentRow(props: { readonly ticker: string; readonly fromView: SentimentDisplay }): ReactElement {
  const sentiment = newerSentiment(props.fromView, useLiveSentiment(props.ticker));
  const basis = SENTIMENT_BASIS[sentiment.basis];
  return (
    <li data-testid={`sentiment-${props.ticker}`}>
      <span className="ticker">{props.ticker}</span> <span className="num">{sentiment.value ?? MISSING}</span>{' '}
      <Badge tone={toneOf(sentiment.status)} label={sentiment.status} />
      {sentiment.sourceKind === 'DEMO' ? <Badge tone="demo" label="DEMO OBSERVATION" /> : null}
      {basis === undefined ? null : (
        <span className="muted-block">
          {basis} · observed {utcText(sentiment.observedAt)}
        </span>
      )}
    </li>
  );
}

export function SentimentPanel({ data }: { readonly data: View }): ReactElement {
  return (
    <Panel
      id="sentiment"
      title="Market Sentiment"
      params={`Sentiment, -1 (bearish) to +1 (bullish) · as of ${utcText(data.generatedAt)}`}
    >
      <ul className="plain-list">
        {data.view.assets.map((asset) => (
          <SentimentRow key={asset.ticker} ticker={asset.ticker} fromView={asset.sentiment} />
        ))}
      </ul>
      <p className="caption">
        Scale: -1 bearish to +1 bullish. Demo observations are synthetic and do not influence risk
        calculations. Shown separately from filing risk; never combined.
      </p>
    </Panel>
  );
}

export function FilingPanel({ data }: { readonly data: View }): ReactElement {
  return (
    <Panel
      id="filing"
      title="SEC Filing Risk"
      params={`Filing risk score, 0 (low) to 1 (high) · as of ${MISSING} (not configured)`}
      tier="compact"
    >
      {/* S5: one compact status row. No score, no controls, nothing that suggests the feature runs. */}
      <p className="status-row" data-testid="filing-status">
        <span className="metric metric-unavailable">{MISSING}</span>
        <Badge tone="unavailable" label={codeLabel(data.filing.status)} />
      </p>
      <p className="caption">{data.filing.explanation} Never combined with market sentiment.</p>
    </Panel>
  );
}
