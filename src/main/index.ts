// Public API of src/main/ (application bootstrap). Nothing in src/ imports this module.
export { ApplicationStartError, createApplication } from './application.js';
export type {
  Application,
  ApplicationOptions,
  ApplicationStartErrorCode,
  ApplicationState,
} from './application.js';
export { openApplicationDatabase } from './database.js';
export type { DatabaseOptions } from './database.js';
export type { ComponentStatus, Components } from './components.js';
export { createDemoFixtures, DEMO_FX_NAME, DEMO_FX_RATES, DEMO_MARKET_DATA_NAME } from './demoFixtures.js';
export {
  DEMO_PORTFOLIOS,
  DEMO_SEED_SOURCE,
  DEMO_SEED_TRADE_TIMESTAMP,
  seedDemoPortfolios,
} from './demoPortfolios.js';
export type {
  DemoPortfolioDefinition,
  DemoSeedDependencies,
  DemoSeedOutcome,
  DemoSeedReason,
} from './demoPortfolios.js';
export type { DemoFixtures } from './demoFixtures.js';
export {
  parseStartArguments,
  PROVISIONAL_OPERATIONAL_VALUES,
  startApplication,
  StartRefusedError,
} from './start.js';
export type { RunningApplication, StartArguments, StartOptions, StartRefusal } from './start.js';
export {
  REPLAY_CLOCK,
  REPLAY_CONFIG_FILE,
  REPLAY_ECB_RESPONSE,
  REPLAY_FX_REFERENCE_DATE,
  REPLAY_MARKET_DATA_AS_OF,
  ReplayExportError,
  exportDashboardReplay,
} from './replayExport.js';
export type { ReplayExportOptions, ReplayExportResult } from './replayExport.js';
