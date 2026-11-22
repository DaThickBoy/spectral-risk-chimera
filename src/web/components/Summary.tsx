import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { MISSING, codeLabel, confidencePct, utcText, withUnit } from '../format.js';
import { Badge, toneOf } from './Badge.tsx';
import { Help } from './Help.tsx';

export function SummarySection({ data }: { readonly data: DashboardViewResponse }): ReactElement {
  const { currency, exposure, baseVaR } = data.display;
  const { confidence, assets } = data.view;
  return (
    <section className="summary overview-summary" aria-labelledby="summary-title" data-testid="summary">
      <h2 id="summary-title">Portfolio snapshot</h2>
      <p className="overview-reference" data-testid="summary-times">
        Base currency {currency} · Market data as of {data.freshness.asOfDate ?? MISSING} · Calculated{' '}
        {utcText(data.freshness.calculatedAt)}
      </p>
      <dl className="overview-kpis" data-testid="kpi-grid">
        <div className="overview-kpi overview-kpi-nav">
          <dt>
            Net asset value <Help term="nav" />
          </dt>
          <dd className="num" data-testid="summary-nav">
            {exposure.nav ?? MISSING}
            {exposure.nav == null ? null : (
              <>
                {' '}
                <span className="kpi-unit">{currency}</span>
              </>
            )}
          </dd>
          <dd className="overview-kpi-note">Portfolio value in {currency}</dd>
        </div>
        <div className="overview-kpi overview-kpi-risk">
          <dt>
            Base VaR <Help term="baseVar" />
          </dt>
          <dd className="num" data-testid="summary-base-var">
            {baseVaR ?? MISSING}
            {baseVaR == null ? null : (
              <>
                {' '}
                <span className="kpi-unit">{currency}</span>
              </>
            )}
          </dd>
          <dd className="overview-kpi-note">
            {confidencePct(confidence)} confidence · 1 day · historical simulation
          </dd>
          {data.view.baseVaR.validity === 'CURRENT' ? null : (
            <dd>
              <Badge
                tone={toneOf(data.view.baseVaR.validity)}
                label={codeLabel(data.view.baseVaR.validity)}
              />
            </dd>
          )}
        </div>
        <div className="overview-kpi" data-testid="kpi-positions">
          <dt>Positions</dt>
          <dd className="num" data-testid="summary-positions">
            {assets.length}
          </dd>
          <dd className="overview-kpi-note" data-testid="summary-currencies">
            {data.display.currencyExposure.map((entry) => entry.currency).join(' · ') || MISSING}
          </dd>
        </div>
        <div className="overview-kpi">
          <dt>
            Gross exposure <Help term="exposure" />
          </dt>
          <dd className="num" data-testid="summary-gross">
            {exposure.gross ?? MISSING}
            {exposure.gross == null ? null : (
              <>
                {' '}
                <span className="kpi-unit">{currency}</span>
              </>
            )}
          </dd>
          <dd className="overview-kpi-note">Long and short exposure combined</dd>
        </div>
      </dl>
      <p className="overview-reference">One-day asset-price VaR · FX held fixed</p>
      <p className="badges" data-testid="summary-badges">
        <Badge tone={toneOf(data.freshness.summary)} label={codeLabel(data.freshness.summary)} />
        {data.view.exposure.status === 'OK' ? null : (
          <Badge tone={toneOf(data.view.exposure.status)} label={codeLabel(data.view.exposure.status)} />
        )}
        <Help term="states" />
      </p>
      <details className="disclosure">
        <summary>Exposure and cash breakdown</summary>
        <dl className="facts">
          {(
            [
              ['net', 'Net exposure'],
              ['long', 'Long'],
              ['short', 'Short'],
              ['cash', 'Cash'],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd className="num" data-testid={`summary-${key}`}>
                {withUnit(exposure[key], currency)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
