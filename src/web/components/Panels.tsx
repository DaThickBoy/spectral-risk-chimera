// The four separate risk panels in the required order (R35.1): Base VaR, Sentiment-Adjusted VaR,
// Market Sentiment, SEC Filing Risk. They never share a gauge, a scale, or a combined score.
// Every figure is backend text; nothing is calculated here.
import type { ReactElement, ReactNode } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';

type View = DashboardViewResponse;

function Panel(props: {
  readonly id: string;
  readonly title: string;
  readonly params: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby={`${props.id}-title`}>
      <header className="panel-header">
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        <p className="panel-params">{props.params}</p>
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
      params={`1 day · ${confidencePct(data.view.confidence)} · Historical Simulation · as of ${data.freshness.asOfDate ?? MISSING}`}
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
        <dl className="facts">
          <dt>Share of NAV (exact)</dt>
          <dd className="num">{withUnit(base.value.percentOfNav, '%')}</dd>
          <dt>Raw quantile loss (exact)</dt>
          <dd className="num">{withUnit(base.value.rawQuantile, currency)}</dd>
        </dl>
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
            <Badge tone="neutral" label={codeLabel(adjusted.status)} />
          </p>
          <p className="reason" data-testid="adjusted-var-reason">
            {availability.explanation}
          </p>
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

export function SentimentPanel({ data }: { readonly data: View }): ReactElement {
  return (
    <Panel
      id="sentiment"
      title="Market Sentiment"
      params={`Sentiment index, -1 (bearish) to +1 (bullish) · as of ${utcText(data.generatedAt)}`}
    >
      <ul className="plain-list">
        {data.view.assets.map((asset) => {
          const basis = SENTIMENT_BASIS[asset.sentiment.basis];
          return (
            <li key={asset.ticker} data-testid={`sentiment-${asset.ticker}`}>
              <span className="ticker">{asset.ticker}</span>{' '}
              <span className="num">{asset.sentiment.value ?? MISSING}</span>{' '}
              <Badge tone={toneOf(asset.sentiment.status)} label={asset.sentiment.status} />
              {asset.sentiment.sourceKind === 'DEMO' ? <Badge tone="demo" label="DEMO" /> : null}
              {basis === undefined ? null : (
                <span className="muted-block">
                  {basis} · observed {utcText(asset.sentiment.observedAt)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="caption">
        Scale: -1 bearish to +1 bullish. Shown separately from filing risk; never combined.
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
    >
      <p className="metric metric-unavailable">{MISSING}</p>
      <p className="badges">
        <Badge tone="unavailable" label={codeLabel(data.filing.status)} />
      </p>
      <p className="reason">{data.filing.explanation}</p>
      <p className="caption">Scale: 0 low to 1 high. Never combined with market sentiment.</p>
    </Panel>
  );
}
