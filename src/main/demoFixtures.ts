/**
 * DEMO fixture data for the explicit demonstration mode of `start.ts`
 * (`--demo-fixtures`). Everything here is labelled DEMO by construction: the
 * fixture providers have `kind: 'DEMO'`, so every price, series, and result that
 * uses them carries `sourceKind: 'DEMO'` / `DEMO_DATA` (R25.4, R30.11, AT-FX-10).
 * It is not market data and never stands in for a real provider (OD-5, OD-13).
 *
 * Instruments (Kiroween decision H6):
 * - `DEMO-A`, `DEMO-B` in the configured base currency (no FX conversion needed).
 * - `DEMO-EU` in EUR, `DEMO-US` in USD, `DEMO-UK` in GBP: with the EUR base they
 *   exercise conversion into EUR (FX rules 1 and 9).
 * Daily adjusted closes are generated deterministically for the trading days
 * (weekends excluded, A-14) that end on the run date, from a fixed cycle of simple
 * returns, rounded to four decimals with Decimal.js. The latest quote equals the
 * last close and is dated on the last trading day.
 *
 * DEMO FX rates (used only when `fx.provider` is `FIXTURE`): two fixed, invented
 * DEMO values that cover both FxService paths for the EUR base:
 * - `EUR -> USD` "1.1": the inverse orientation, inverted by FxService into Rate(USD/EUR);
 * - `GBP -> EUR` "1.17": the direct orientation, used as Rate(GBP/EUR).
 * Their `observedAt` is the end of the last trading day, or the run time if that is
 * earlier, so they obey the selection bound (FX rule 6) and are subject to the same
 * staleness rule (FX rule 7) as any other rate. They are not ECB values.
 */
import { FixtureFxProvider } from '../fx/index.js';
import { FixtureMarketDataProvider, weekendsOnlyCalendar } from '../marketdata/index.js';
import { d, toCanonical } from '../shared/index.js';
import type { Clock } from '../shared/index.js';

export const DEMO_MARKET_DATA_NAME = 'demo-fixtures-md';
export const DEMO_FX_NAME = 'demo-fixtures-fx';

interface DemoInstrument {
  readonly ticker: string;
  /** Fixed ISO 4217 code, or `null` for the configured base currency. */
  readonly currency: string | null;
  readonly start: string;
  readonly returns: readonly string[];
}

const INSTRUMENTS: readonly DemoInstrument[] = [
  {
    ticker: 'DEMO-A',
    currency: null,
    start: '100',
    returns: ['0.012', '-0.008', '0.005', '-0.015', '0.009', '-0.003', '0.011', '-0.01'],
  },
  {
    ticker: 'DEMO-B',
    currency: null,
    start: '50',
    returns: ['-0.006', '0.004', '0.013', '-0.011', '0.002', '-0.009', '0.007', '0.006'],
  },
  {
    ticker: 'DEMO-EU',
    currency: 'EUR',
    start: '80',
    returns: ['0.004', '-0.012', '0.009', '0.003', '-0.007', '0.01', '-0.005', '0.002'],
  },
  {
    ticker: 'DEMO-US',
    currency: 'USD',
    start: '120',
    returns: ['-0.009', '0.015', '-0.004', '0.006', '-0.013', '0.008', '0.001', '-0.002'],
  },
  {
    ticker: 'DEMO-UK',
    currency: 'GBP',
    start: '40',
    returns: ['0.007', '-0.003', '-0.01', '0.012', '0.002', '-0.006', '0.004', '-0.008'],
  },
];

/** The fixed DEMO FX entries: rate is units of `to` per one `from`. */
export const DEMO_FX_RATES = [
  { from: 'EUR', to: 'USD', rate: '1.1' },
  { from: 'GBP', to: 'EUR', rate: '1.17' },
] as const;

export interface DemoFixtures {
  readonly tickers: readonly string[];
  /** Ticker -> currency of every generated instrument. */
  readonly currencies: Readonly<Record<string, string>>;
  /** Ticker -> first generated close (exact text). */
  readonly firstCloses: Readonly<Record<string, string>>;
  /** Inclusive range covering every generated observation. */
  readonly range: { readonly from: string; readonly to: string };
  readonly marketData: FixtureMarketDataProvider;
  readonly fx: FixtureFxProvider;
}

/** The `count` most recent trading days ending on or before `runDate`, ascending. */
function tradingDays(runDate: string, count: number): string[] {
  const days: string[] = [];
  const cursor = new Date(`${runDate}T00:00:00.000Z`);
  while (days.length < count) {
    const date = cursor.toISOString().slice(0, 10);
    if (weekendsOnlyCalendar.isTradingDay(date)) {
      days.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days.reverse();
}

export function createDemoFixtures(options: {
  readonly clock: Clock;
  readonly currency: string;
  /** Observations per instrument (a count). */
  readonly observations: number;
}): DemoFixtures {
  if (!Number.isSafeInteger(options.observations) || options.observations < 2) {
    throw new TypeError('observations must be an integer of at least 2.');
  }
  const now = options.clock.nowUtc().toISOString();
  const runDate = now.slice(0, 10);
  const dates = tradingDays(runDate, options.observations);
  const series: Record<string, unknown> = {};
  const quotes: Record<string, unknown> = {};
  const currencies: Record<string, string> = {};
  const firstCloses: Record<string, string> = {};
  for (const instrument of INSTRUMENTS) {
    const currency = instrument.currency ?? options.currency;
    let price = d(instrument.start);
    const observations = dates.map((date, index) => {
      if (index > 0) {
        const r = d(instrument.returns[index % instrument.returns.length] ?? '0');
        price = price.times(d('1').plus(r)).toDecimalPlaces(4);
      }
      return { date, adjustedClose: toCanonical(price) };
    });
    series[instrument.ticker] = { ticker: instrument.ticker, currency, observations };
    const last = observations.at(-1);
    quotes[instrument.ticker] = [
      { ticker: instrument.ticker, currency, asOf: last?.date, price: last?.adjustedClose },
    ];
    currencies[instrument.ticker] = currency;
    firstCloses[instrument.ticker] = observations[0]?.adjustedClose ?? instrument.start;
  }
  const from = dates[0] ?? runDate;
  const to = dates.at(-1) ?? runDate;
  // FX rule 6: never after the end of the last trading day, and never after the run time.
  const endOfLastDay = `${to}T23:59:59.999Z`;
  const observedAt = now < endOfLastDay ? now : endOfLastDay;
  return {
    tickers: INSTRUMENTS.map((i) => i.ticker),
    currencies: Object.freeze(currencies),
    firstCloses: Object.freeze(firstCloses),
    range: { from, to },
    marketData: new FixtureMarketDataProvider({
      name: DEMO_MARKET_DATA_NAME,
      clock: options.clock,
      fixtures: { series, quotes },
    }),
    fx: new FixtureFxProvider({
      name: DEMO_FX_NAME,
      rates: DEMO_FX_RATES.map((rate) => ({ ...rate, observedAt })),
    }),
  };
}
