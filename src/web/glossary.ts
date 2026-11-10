/**
 * Contextual glossary (roadmap S4). Each entry separates the general financial meaning from
 * this dashboard's own conventions, as implemented and documented (design: Risk Engine,
 * dashboard view model; financial-rules). Static text only: no value is computed here.
 */
export interface GlossaryEntry {
  /** The term as named in the help button ("What is <term>?"). */
  readonly term: string;
  readonly general: string;
  readonly app: string;
}

export const GLOSSARY = {
  nav: {
    term: 'NAV',
    general: 'Net asset value: what the portfolio is worth, the market value of its positions plus cash.',
    app: 'Net exposure plus cash, in the base currency, computed by the backend from the latest prices and the FX rates listed under "FX rates used". DEMO prices here are fixtures, not market data.',
  },
  baseVar: {
    term: 'Base VaR',
    general:
      'Value at Risk: a loss level that is exceeded only rarely (for example on 5% of days at 95% confidence). It is a percentile estimate, not the worst possible loss and not a maximum drawdown.',
    app: 'Historical simulation: the latest 250 daily returns (at least 200) are applied to the current positions, giving one simulated one-day loss each. The figure is their Hyndman-Fan type 7 quantile at the stated confidence, floored at zero. FX rates are held constant across scenarios.',
  },
  confidence: {
    term: 'confidence level and horizon',
    general:
      'The confidence level is how often losses stay below VaR (95% means 19 days in 20). The horizon is the period the loss is measured over.',
    app: 'Confidence 95% and a horizon of exactly 1 trading day. Nothing is scaled to longer periods.',
  },
  rawQuantile: {
    term: 'raw quantile',
    general:
      'A quantile is the value below which a given share of observations falls. The type 7 method interpolates between the two nearest sorted observations.',
    app: 'The exact, unrounded type 7 quantile of the scenario losses. Base VaR reports it floored at zero: a negative raw quantile means no loss at that confidence.',
  },
  adjustedVar: {
    term: 'Adjusted VaR',
    general:
      'A stress variant of VaR that scales up losses under adverse conditions. It is an assumption, not a statistical estimate.',
    app: 'When available, it raises the downside of positions whose market sentiment is below the configured threshold (-0.60) by the configured multiplier (1.15). It needs REAL, CURRENT sentiment for every position. It is unavailable: no sentiment aggregation method is approved yet (open decision OD-1), and the sentiment shown is DEMO data, which is never used. Sentiment does not affect any risk figure in this dashboard.',
  },
  exposure: {
    term: 'gross, net, long, and short exposure',
    general:
      'Long exposure is the value of positions held; short exposure is the value of positions sold short. Gross adds both sizes; net is long minus short.',
    app: 'Market values of the positions in the base currency, computed by the backend. Cash is not exposure: it is added to net exposure to give NAV.',
  },
  currencyExposure: {
    term: 'currency exposure',
    general:
      'How much of the portfolio is held in each currency, which shows its sensitivity to exchange rates.',
    app: "The base-currency market value of the positions, grouped by each instrument's currency, summed by the backend. Bars run from 0 to gross exposure. FX rates are held constant in the VaR scenarios, so currency moves are not part of Base VaR.",
  },
  lossDistribution: {
    term: 'loss distribution and VaR marker',
    general: 'A histogram of simulated losses shows how often losses of each size occur.',
    app: "The same scenario losses behind Base VaR, in 20 equal-width buckets. Negative losses are gains. The dashed marker is the raw 95% quantile, and the table lists every bucket's exact edges and counts.",
  },
  states: {
    term: 'DEMO, CURRENT, STALE, and UNAVAILABLE',
    general: 'Labels for where a value comes from and whether it is fresh enough to rely on.',
    app: 'DEMO: deterministic fixture data, never market data; DEMO results never raise alerts. CURRENT: within its freshness limit. STALE: older than its limit, shown with its time for information. UNAVAILABLE: no valid value exists; it is shown as "—" and is not zero. A real zero is shown as a number, for example 0.00 EUR.',
  },
} as const satisfies Readonly<Record<string, GlossaryEntry>>;

export type GlossaryKey = keyof typeof GLOSSARY;
