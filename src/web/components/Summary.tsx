// Headline figures (roadmap S1; ui-guidelines 3): what the portfolio is worth, its one-day
// Base VaR, and its exposure, with provenance and freshness beside them. Every figure is the
// backend's display text (FR-14 money rounding done by the backend); a missing value is the
// em dash with a status badge, never "0". Nothing is calculated here.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import type { GlossaryKey } from '../glossary.js';
import { Badge, toneOf } from './Badge.tsx';
import { Help } from './Help.tsx';

type View = DashboardViewResponse;

function Figure(props: {
  readonly label: string;
  readonly value: string | null;
  readonly currency: string;
  readonly testId: string;
  readonly primary?: boolean;
  readonly help?: GlossaryKey;
}): ReactElement {
  return (
    <div className={props.primary === true ? 'summary-figure summary-primary' : 'summary-figure'}>
      <dt>
        {props.label}
        {props.help === undefined ? null : <Help term={props.help} />}
      </dt>
      <dd className="num" data-testid={props.testId}>
        {withUnit(props.value, props.currency)}
      </dd>
    </div>
  );
}

export function SummarySection({ data }: { readonly data: View }): ReactElement {
  const money = data.display.exposure;
  const currency = data.display.currency;
  const base = data.view.baseVaR;
  const adjusted = data.view.sentimentAdjustedVaR;
  const availability = data.adjustedVaRAvailability;
  // Instrument currencies exactly as the backend lists them (codes only, in backend order).
  const currencies = data.display.currencyExposure.map((entry) => entry.currency);
  return (
    <section className="summary" aria-labelledby="summary-title" data-testid="summary">
      <h2 id="summary-title">
        Portfolio summary{' '}
        <span className="muted-inline">
          · {data.portfolioId} · base currency {data.view.baseCurrency}
        </span>
      </h2>
      <p className="badges" data-testid="summary-badges">
        {data.dataMode === 'DEMO' ? (
          <Badge tone="demo" label="DEMO DATA" title="Computed from DEMO fixture data" />
        ) : (
          <Badge tone="current" label="REAL" />
        )}
        <Badge tone={toneOf(data.freshness.summary)} label={codeLabel(data.freshness.summary)} />
        {data.view.exposure.status === 'OK' ? null : (
          <Badge tone={toneOf(data.view.exposure.status)} label={codeLabel(data.view.exposure.status)} />
        )}
        <span className="muted-inline" data-testid="summary-times">
          market data as of {data.freshness.asOfDate ?? MISSING} · calculated{' '}
          {utcText(data.freshness.calculatedAt)}
        </span>
        <Help term="states" />
      </p>
      {/* Fintech redesign: four KPI cards. Every value is backend display text or a count of
          backend rows; an unavailable figure is "Unavailable" or "—" with its reason. */}
      <dl className="summary-figures kpi-grid" data-testid="kpi-grid">
        <Figure label="NAV" value={money.nav} currency={currency} testId="summary-nav" primary help="nav" />
        <div className="summary-figure summary-primary kpi-var">
          <dt>
            Base VaR · 1 day · {confidencePct(data.view.confidence)}{' '}
            <Badge tone={toneOf(base.validity)} label={codeLabel(base.validity)} />
            <Help term="baseVar" />
            <span className="muted-block">One-day asset-price VaR · FX held fixed</span>
          </dt>
          <dd className="num" data-testid="summary-base-var">
            {withUnit(data.display.baseVaR, currency)}
          </dd>
        </div>
        <div className="summary-figure kpi-card" data-testid="kpi-adjusted">
          <dt>Adjusted VaR · 1 day · {confidencePct(data.view.confidence)}</dt>
          <dd className="num" data-testid="summary-adjusted-var">
            {adjusted.value === null ? 'Unavailable' : withUnit(data.display.adjustedVaR, currency)}
          </dd>
          {adjusted.value === null && availability.reasonCode !== null ? (
            <dd className="kpi-note">
              <Badge
                tone="info"
                label={`${codeLabel(availability.reasonCode)}${availability.openDecision === null ? '' : ` · ${availability.openDecision}`}`}
              />
            </dd>
          ) : null}
        </div>
        <div className="summary-figure kpi-card" data-testid="kpi-positions">
          <dt>Positions</dt>
          {/* A count of the backend's position rows (an integer, not a financial value). */}
          <dd className="num" data-testid="summary-positions">
            {String(data.view.assets.length)}
          </dd>
          <dd className="kpi-note" data-testid="summary-currencies">
            {currencies.length === 0 ? MISSING : currencies.join(' · ')}
          </dd>
        </div>
      </dl>
      <dl className="summary-figures exposure-strip" data-testid="exposure-strip">
        <Figure
          label="Gross exposure"
          value={money.gross}
          currency={currency}
          testId="summary-gross"
          help="exposure"
        />
        <Figure label="Net exposure" value={money.net} currency={currency} testId="summary-net" />
        <Figure label="Long" value={money.long} currency={currency} testId="summary-long" />
        <Figure label="Short" value={money.short} currency={currency} testId="summary-short" />
        <Figure label="Cash" value={money.cash} currency={currency} testId="summary-cash" />
      </dl>
    </section>
  );
}
