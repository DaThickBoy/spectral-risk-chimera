// Public API of src/fx/. fx/ imports only shared/ and config/.
export type { FxProvider, FxSourceKind, ObservedAtBasis, ProviderFxRate } from './ports.js';
export {
  CONVENTION_ID_PATTERN,
  CURRENCY_CODE_PATTERN,
  FxFixtureEntrySchema,
  ProviderFxRateSchema,
  endOfUtcDay,
  isIsoDate,
} from './normalize.js';
export {
  ECB_DERIVED_NOTE,
  ECB_INFORMATION_NOTE,
  ECB_SOURCE_NAME,
  ECB_SOURCE_STATEMENT,
  fxAttribution,
} from './attribution.js';
export type { FxAttribution, FxDerivation } from './attribution.js';
export type { FxFixtureEntry, ValidatedProviderFxRate } from './normalize.js';
export { FixtureFxProvider } from './fixtureProvider.js';
export type { FixtureFxProviderOptions } from './fixtureProvider.js';
export { FX_DERIVATION_PRECISION, FX_OPERATION, createFxService, fxCircuitKey } from './fxService.js';
export type {
  FxError,
  FxQuoteProvenance,
  FxRateUsed,
  FxService,
  FxServiceDependencies,
  FxUnavailableCause,
  QuotedFxResult,
  QuotedFxService,
  StaleFxRate,
} from './fxService.js';
