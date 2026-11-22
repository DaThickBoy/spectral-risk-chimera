// Currency exposure, FX sources, and positions (task 17.3; the exposure overview is the headline
// summary, Summary.tsx). Every figure is
// backend text (money already rounded by the backend, FR-14); sorting compares exact decimals.
import { useState } from 'react';
import { compareDecimalText } from '../chartAdapter.js';
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { MISSING, codeLabel, percentText, utcText, withUnit } from '../format.js';
import { allocationBars } from '../chartAdapter.js';
import { ExposureChart } from './ExposureChart.tsx';
import { Help } from './Help.tsx';
import { Badge, toneOf } from './Badge.tsx';

import './section-controls.css';

type View = DashboardViewResponse;

export function CurrencyExposureSection({ data }: { readonly data: View }): ReactElement {
  const currency = data.display.currency;
  const text = new Map(data.display.currencyExposure.map((entry) => [entry.currency, entry.marketValueBase]));
  return (
    <section className="section currency-section" aria-labelledby="ccy-title">
      <h2 id="ccy-title">Currency exposure</h2>
      <p className="badges" data-testid="ccy-badges">
        {data.dataMode === 'DEMO' ? (
          <Badge tone="demo" label="DEMO" title="Computed from DEMO fixture data" />
        ) : null}
        <Help term="currencyExposure" />
      </p>
      <ExposureChart data={data} />
      {/* Focusable so keyboard users can scroll the table on narrow screens (WCAG 2.1.1). */}
      <div className="table-wrap" role="region" aria-label="Currency exposure table, scrollable" tabIndex={0}>
        <table>
          <caption>Market value in {currency} by instrument currency</caption>
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col" className="num">
                Value ({currency})
              </th>
              <th scope="col">Status</th>
              <th scope="col">Positions</th>
            </tr>
          </thead>
          <tbody>
            {data.currencyExposure.map((entry) => (
              <tr key={entry.currency}>
                <th scope="row">{entry.currency}</th>
                <td className="num">{withUnit(text.get(entry.currency) ?? null, currency)}</td>
                <td>
                  <Badge tone={toneOf(entry.status)} label={entry.status} />
                </td>
                <td>{entry.tickers.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FxSection({ data }: { readonly data: View }): ReactElement {
  return (
    <section className="section" aria-labelledby="fx-title">
      <h2 id="fx-title">FX rates used</h2>
      <ol className="fx-pipeline" aria-label="Valuation lineage">
        <li>Trade records</li>
        <li>Ledger</li>
        <li>ECB FX</li>
        <li>Historical scenarios</li>
        <li>Base VaR</li>
      </ol>
      <ol className="fx-steps" aria-label="Base-currency valuation steps">
        <li>Signed quantity × instrument price</li>
        <li>Apply the listed rate once (1 for the base currency)</li>
        <li>Market value in {data.view.baseCurrency}</li>
      </ol>
      {/* Focusable so keyboard users can scroll the table on narrow screens (WCAG 2.1.1). */}
      <div
        className="table-wrap fx-table-wrap"
        role="region"
        aria-label="FX rates table, scrollable"
        tabIndex={0}
      >
        <table role="table">
          <caption>Rate(X/{data.view.baseCurrency}): units of base currency per one unit of X</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">
                Pair
              </th>
              <th role="columnheader" scope="col" className="num">
                Rate used
              </th>
              <th role="columnheader" scope="col">
                Status / source
              </th>
              <th role="columnheader" scope="col">
                Provenance
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {data.fx.map((entry) => {
              const rate = entry.rate;
              const attribution = rate?.attribution;
              return (
                <tr role="row" key={entry.currency}>
                  <th role="rowheader" scope="row">
                    {entry.currency} → {data.view.baseCurrency}
                    <span className="muted-block">{entry.tickers.join(', ')}</span>
                  </th>
                  <td role="cell" className="num fx-exact fx-primary-rate">
                    {rate === null || rate === undefined
                      ? MISSING
                      : rate.rate.replace(/([.][0-9]{6})[0-9]+$/, '$1…')}
                  </td>
                  <td role="cell">
                    <Badge tone={toneOf(entry.status)} label={entry.status} />
                    {entry.unavailable !== null ? (
                      <span className="reason-inline">
                        {' '}
                        {codeLabel(entry.unavailable.cause ?? entry.unavailable.code)}
                      </span>
                    ) : null}
                    {rate ? <span className="muted-block">{rate.source}</span> : null}
                    {rate ? (
                      <span className="fx-rate-kind">
                        {rate.sourceKind === 'IDENTITY'
                          ? 'Identity (base currency)'
                          : attribution?.derivation === 'DERIVED_INVERSE'
                            ? 'Derived'
                            : attribution
                              ? 'Published'
                              : 'Provided'}
                      </span>
                    ) : null}
                  </td>
                  <td role="cell">
                    <details className="fx-details">
                      <summary>
                        <span className="fx-desktop-label">{entry.currency} details</span>
                        <span className="fx-mobile-label">
                          Exact rate &amp; provenance{' '}
                          <span className="visually-hidden">
                            for {entry.currency} to {data.view.baseCurrency}
                          </span>
                        </span>
                      </summary>
                      {rate ? (
                        <>
                          <p>
                            Pair and exact rate used: {rate.pair}{' '}
                            <span className="fx-exact">{rate.rate}</span>
                          </p>
                          <p>
                            Source: {rate.source} ({rate.sourceKind})
                          </p>
                          <p>
                            Reference date:{' '}
                            {attribution?.referenceDate ?? rate.quote?.referenceDate ?? MISSING}
                          </p>
                          <p>Observed at (UTC): {utcText(rate.observedAt)}</p>
                          {rate.observedAtBasis ? (
                            <p>Timestamp basis: {codeLabel(rate.observedAtBasis)}</p>
                          ) : null}
                          {rate.conventionId ? <p>Convention: {rate.conventionId}</p> : null}
                        </>
                      ) : (
                        <p>
                          No rate used
                          {entry.unavailable?.providerCode ? ` · ${entry.unavailable.providerCode}` : ''}.
                        </p>
                      )}
                      <p>
                        {attribution === undefined ? (
                          rate?.sourceKind === 'IDENTITY' ? (
                            'Identity (base currency)'
                          ) : (
                            MISSING
                          )
                        ) : attribution.derivation === 'DERIVED_INVERSE' ? (
                          <span data-testid={`derived-${entry.currency}`}>
                            Derived: 1 / published {attribution.publishedPair.slice(0, 3)}→
                            {attribution.publishedPair.slice(3)} ({attribution.precision.significantDigits}{' '}
                            significant digits, {codeLabel(attribution.precision.rounding)})
                          </span>
                        ) : (
                          `Published reference rate · ${attribution.publishedPair.slice(0, 3)}→${attribution.publishedPair.slice(3)}`
                        )}
                      </p>
                      <p>Provider quote (as received):</p>
                      <div className="fx-exact" data-testid={`quote-${entry.currency}`}>
                        {rate?.quote === undefined || rate.quote === null ? (
                          MISSING
                        ) : (
                          <>
                            {rate.quote.pair.slice(0, 3)}→{rate.quote.pair.slice(3)} {rate.quote.rate}
                            <span className="muted-block">
                              {rate.sourceKind === 'DEMO' ? 'DEMO fixture quote' : 'Published observation'}
                              {rate.quote.referenceDate === null
                                ? ''
                                : ` · reference date ${rate.quote.referenceDate}`}
                            </span>
                            <span className="muted-block">
                              {codeLabel(rate.quote.method)} · {codeLabel(rate.quote.precision)}
                            </span>
                          </>
                        )}
                      </div>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <FxAttributionNotes data={data} />
    </section>
  );
}

function FxAttributionNotes({ data }: { readonly data: View }): ReactElement | null {
  const attributions = data.fx.flatMap((entry) =>
    entry.rate?.attribution === undefined ? [] : [entry.rate.attribution],
  );
  const first = attributions[0];
  if (first === undefined) {
    return null;
  }
  const notes = [...new Set(attributions.flatMap((a) => a.notes))];
  return (
    <div className="attribution" data-testid="fx-attribution">
      <p>
        <strong>{first.statement}</strong>
      </p>
      <ul>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

type SortKey = 'ticker' | 'signedQuantity' | 'marketValueBase' | 'allocationPct';
type SortDirection = 'ascending' | 'descending';

export function PositionsSection({ data }: { readonly data: View }): ReactElement {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'ticker',
    direction: 'ascending',
  });
  const assets = [...data.view.assets].sort((a, b) => {
    const tickerOrder = a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    const direction = sort.direction === 'ascending' ? 1 : -1;
    if (sort.key === 'ticker') return tickerOrder * direction;
    const left = a[sort.key];
    const right = b[sort.key];
    if (left === null || right === null) {
      return left === right ? tickerOrder : left === null ? 1 : -1;
    }
    return compareDecimalText(left, right) * direction || tickerOrder;
  });
  function sortHeader(key: SortKey, label: string, numeric = false): ReactElement {
    const active = sort.key === key;
    return (
      <th scope="col" className={numeric ? 'num' : undefined} aria-sort={active ? sort.direction : undefined}>
        <button
          className="holding-sort"
          type="button"
          onClick={() => {
            setSort((previous) => ({
              key,
              direction:
                previous.key === key
                  ? previous.direction === 'ascending'
                    ? 'descending'
                    : 'ascending'
                  : key === 'ticker'
                    ? 'ascending'
                    : 'descending',
            }));
          }}
        >
          {label}{' '}
          <span aria-hidden="true">{active ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}</span>
        </button>
      </th>
    );
  }
  const currency = data.display.currency;
  const baseText = new Map(data.display.assets.map((a) => [a.ticker, a.marketValueBase]));
  const bars = new Map(allocationBars(data.view.assets).map((bar) => [bar.ticker, bar]));
  return (
    <section className="section" aria-labelledby="positions-title">
      <h2 id="positions-title">Positions and allocation</h2>
      <p id="positions-valuation">
        Signed quantities, latest prices, and values in {currency}, converted at the rates listed in “FX rates
        used” (published or derived as marked there)
      </p>
      <p className="positions-scroll-hint">Scroll the table to see all columns.</p>
      {/* Focusable so keyboard users can scroll the table on narrow screens (WCAG 2.1.1). */}
      <div className="table-wrap" role="region" aria-label="Positions table, scrollable" tabIndex={0}>
        <table aria-describedby="positions-valuation">
          <caption className="visually-hidden">Positions and allocation</caption>
          <thead>
            <tr>
              {sortHeader('ticker', 'Ticker')}
              <th scope="col">Currency</th>
              {sortHeader('signedQuantity', 'Quantity', true)}
              <th scope="col" className="num">
                Price
              </th>
              {sortHeader('marketValueBase', `Value (${currency})`, true)}
              {sortHeader('allocationPct', 'Allocation', true)}
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.ticker}>
                <th scope="row">{asset.ticker}</th>
                <td>
                  <span className="currency-code">{asset.currency}</span>
                </td>
                <td className="num">{asset.signedQuantity}</td>
                <td className="num">{withUnit(asset.marketPrice, asset.currency)}</td>
                <td className="num">{withUnit(baseText.get(asset.ticker) ?? null, currency)}</td>
                <td className="num position-allocation">
                  {percentText(asset.allocationPct)}
                  <div className="allocation-track" aria-hidden="true">
                    {bars.get(asset.ticker)?.widthPct == null ? null : (
                      <span
                        className="allocation-bar"
                        style={{ width: `${String(bars.get(asset.ticker)?.widthPct)}%` }}
                      />
                    )}
                  </div>
                </td>
                <td>
                  <Badge tone={toneOf(asset.valuationStatus)} label={codeLabel(asset.valuationStatus)} />
                  {asset.priceProvenance?.sourceKind === 'DEMO' ? <Badge tone="demo" label="DEMO" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
