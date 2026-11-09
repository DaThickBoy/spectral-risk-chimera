// Public API of src/marketdata/. marketdata/ imports only shared/ and config/.
export type {
  DateRange,
  MarketDataProvider,
  NonFiniteMarker,
  ProviderObservation,
  ProviderQuote,
  ProviderSeries,
} from './ports.js';
export {
  QuotePayloadSchema,
  SeriesPayloadSchema,
  assertDateRange,
  assertTicker,
  normalizeQuote,
  normalizeSeries,
} from './normalize.js';
export type { NormalizeContext, NormalizeError, NormalizeFailureReason } from './normalize.js';
export { FixtureMarketDataProvider } from './fixtureProvider.js';
export { utcWeekday, weekendsOnlyCalendar } from './calendar.js';
export type { TradingCalendar } from './calendar.js';
export { createSeriesCleaner } from './seriesCleaner.js';
export { createReturnsBuilder } from './returnsBuilder.js';
export type { MarketDataError, ReturnMatrix, ReturnsBuilder, ReturnsOptions } from './returnsBuilder.js';
export type {
  CleanResult,
  DiscardCounts,
  PriceObservation,
  PriceSeries,
  SeriesCleaner,
} from './seriesCleaner.js';
export type { FixtureMarketDataProviderOptions, MarketDataFixtures } from './fixtureProvider.js';
