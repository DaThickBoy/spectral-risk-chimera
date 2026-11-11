// Currency exposure, FX sources, and positions (task 17.3; the exposure overview is the headline
// summary, Summary.tsx). Every figure is
// backend text (money already rounded by the backend, FR-14); nothing is calculated here.
import type { ReactElement } from 'react';
import type { DashboardViewResponse } from '../../shared/apiContracts/index.js';
import { MISSING, codeLabel, percentText, utcText, withUnit } from '../format.js';
import { allocationBars } from '../chartAdapter.js';
import { ExposureChart } from './ExposureChart.tsx';
import { Help } from './Help.tsx';
import { Badge, toneOf } from './Badge.tsx';

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
      {/* Focusable so keyboard users can scroll the table on narrow screens (WCAG 2.1.1). */}
      <div className="table-wrap" role="region" aria-label="FX rates table, scrollable" tabIndex={0}>
        <table>
          <caption>Rate(X/{data.view.baseCurrency}): units of base currency per one unit of X</caption>
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col">Pair</th>
              <th scope="col" className="num">
                Rate (exact)
              </th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">Reference</th>
              <th scope="col">Published or derived</th>
              <th scope="col" className="num">
                Provider quote (as received)
              </th>
            </tr>
          </thead>
          <tbody>
            {data.fx.map((entry) => {
              const rate = entry.rate;
              const attribution = rate?.attribution;
              return (
                <tr key={entry.currency}>
                  <th scope="row">{entry.currency}</th>
                  <td>{rate?.pair ?? MISSING}</td>
                  <td className="num rate">{rate?.rate ?? MISSING}</td>
                  <td>
                    <Badge tone={toneOf(entry.status)} label={entry.status} />
                    {entry.unavailable !== null ? (
                      <span className="reason-inline">
                        {' '}
                        {codeLabel(entry.unavailable.cause ?? entry.unavailable.code)}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {rate === null ? MISSING : rate.source}
                    {rate !== null && rate.sourceKind === 'DEMO' ? <Badge tone="demo" label="DEMO" /> : null}
                  </td>
                  <td>
                    {attribution?.referenceDate ?? (rate === null ? MISSING : utcText(rate.observedAt))}
                    {rate?.conventionId !== undefined ? (
                      <span className="muted-block">{rate.conventionId}</span>
                    ) : null}
                  </td>
                  <td>
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
                      'Published reference rate'
                    )}
                  </td>
                  <td className="num rate" data-testid={`quote-${entry.currency}`}>
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
                      </>
                    )}
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

export function PositionsSection({ data }: { readonly data: View }): ReactElement {
  const currency = data.display.currency;
  const baseText = new Map(data.display.assets.map((a) => [a.ticker, a.marketValueBase]));
  const bars = new Map(allocationBars(data.view.assets).map((bar) => [bar.ticker, bar]));
  return (
    <section className="section" aria-labelledby="positions-title">
      <h2 id="positions-title">Positions and allocation</h2>
      {/* Focusable so keyboard users can scroll the table on narrow screens (WCAG 2.1.1). */}
      <div className="table-wrap" role="region" aria-label="Positions table, scrollable" tabIndex={0}>
        <table>
          <caption>
            Signed quantities, latest prices, and values in {currency}, converted at the rates listed in “FX
            rates used” (published or derived as marked there)
          </caption>
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Currency</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Price
              </th>
              <th scope="col" className="num">
                Value ({currency})
              </th>
              <th scope="col" className="num">
                Allocation
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.view.assets.map((asset) => (
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
