/**
 * Executable entry point: `node dist/main/start.js [options]`.
 *
 * Start-up, in order (any refusal exits before the next step):
 * 1. Command-line options are parsed strictly; an unknown or malformed option
 *    is refused (exit code 2).
 * 2. The environment (`loadEnv`) and the runtime configuration (`loadConfig`,
 *    `SRC_CONFIG_FILE`) are loaded through the redacting logger. Missing or
 *    invalid settings disable only their features (Configuration policy).
 * 3. Providers. No real market data or FX provider exists (OD-5, OD-13), so the
 *    only way to start is the explicit demonstration mode `--demo-fixtures`:
 *    DEMO fixture providers, every result labelled DEMO / `DEMO_DATA`.
 *    Without it the process refuses to start (`PROVIDERS_NOT_CONFIGURED`). This
 *    is not the production mode of R30.11, which stays open (OD-19).
 * 4. The database (`SRC_DATABASE_FILE`, OD-12) is opened in every mode; there is
 *    no in-memory fallback. An absent or invalid path is refused.
 * 5. The application is assembled (`createApplication`) and started on
 *    `127.0.0.1` with the given `--port` (OD-7: loopback only). Risk
 *    calculations run in the compiled worker.
 * 6. Demo mode only: the fixture history of the demo instruments is retrieved
 *    into the series store through the 9.6 retrieval service, so Base VaR can be
 *    calculated. This is fixture seeding, not the undecided 9.6 trigger. Then the
 *    deterministic EUR demo portfolios are seeded through the ordinary use cases
 *    (H6, `demoPortfolios.ts`).
 *
 * Demo configuration (Kiroween decision H3): a configuration that carries
 * `demo.profile` is refused outside `--demo-fixtures`
 * (`DEMO_CONFIG_OUTSIDE_DEMO_MODE`), so its provisional values can never drive a
 * non-demo start. In demo mode its `demo.provisionalKeys` and their status are
 * logged (`start.demo_config`, `start.ready`).
 *
 * FX provider in demo mode (`fx.provider`): `ECB` uses the ECB adapter (task 10.2,
 * REAL kind, approved for the hackathon demo only, H2) over the TLS-verified
 * transport; `FIXTURE` (or an absent setting, which already disables Base VaR)
 * uses the DEMO fixture rates. Market data stays the DEMO fixtures in every case.
 *
 * Shutdown: `SIGINT`, `SIGTERM`, or the IPC message `{ "type": "shutdown" }`
 * stop the application gracefully (HTTP and WebSocket closed, loops aborted,
 * recalculations drained, dispatcher stopped, worker and database closed) and
 * exit with code 0. A failure during start-up releases what was opened and
 * exits with 1 (2 for refused configuration).
 *
 * Operational values without configuration keys (busy timeout, stream limits,
 * alert delivery waits, sentiment history) are the provisional constants below
 * and are logged at start (OD-6 covers their approval).
 */
import { pathToFileURL } from 'node:url';
import { createEcbFxProvider, httpsGet } from '../adapters/index.js';
import type { EcbTransport } from '../adapters/index.js';
import type { ConfigKey, ConfigLoadResult } from '../config/index.js';
import { CONFIG_KEYS, loadConfig, loadEnv, readPath } from '../config/index.js';
import type { FxProvider } from '../fx/index.js';
import type { RiskInput, RiskResult } from '../risk/index.js';
import { createLogger, randomIds, systemClock, systemSleeper } from '../shared/index.js';
import type { Clock, IdGenerator, Logger, Sleeper } from '../shared/index.js';
import { ApplicationStartError, createApplication } from './application.js';
import type { Application } from './application.js';
import { openApplicationDatabase } from './database.js';
import { createDemoFixtures } from './demoFixtures.js';
import type { DemoFixtures } from './demoFixtures.js';
import { DEMO_PORTFOLIOS, seedDemoPortfolios } from './demoPortfolios.js';
import { DemoSentimentFixture } from './demoSentiment.js';

/** Provisional operational values (no configuration keys; OD-6). */
export const PROVISIONAL_OPERATIONAL_VALUES = Object.freeze({
  databaseBusyTimeoutMs: 5000,
  streamMaxClients: 16,
  streamMaxBufferedBytes: 1_048_576,
  alertInitialBackoffMs: 1000,
  alertMaxBackoffMs: 30_000,
  alertAttemptTimeoutMs: 10_000,
  sentimentHistoryLimit: 1000,
});

/** Demo history length when the configuration gives no lookback (a count). */
const DEMO_DEFAULT_OBSERVATIONS = 260;

export type StartRefusal =
  | 'USAGE'
  | 'DEMO_CONFIG_OUTSIDE_DEMO_MODE'
  | 'PROVIDERS_NOT_CONFIGURED'
  | 'FX_PROVIDER_CONFIG_INVALID'
  | 'DATABASE_CONFIG_MISSING'
  | 'DATABASE_CONFIG_INVALID'
  | 'DATABASE_UNAVAILABLE'
  | 'GATEWAY_CONFIG_MISSING';

export class StartRefusedError extends Error {
  constructor(
    readonly reason: StartRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'StartRefusedError';
  }
}

export interface StartArguments {
  readonly demoFixtures: boolean;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
}

const USAGE =
  'Usage: node dist/main/start.js --demo-fixtures --port <0-65535> --allowed-origin <http(s)://host[:port]> [--allowed-origin ...]';

/** Strict option parsing; every option is explicit (no host option: the host is always 127.0.0.1). */
export function parseStartArguments(argv: readonly string[]): StartArguments {
  let demoFixtures = false;
  let port: number | undefined;
  const allowedOrigins: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    const value = argv[i + 1];
    switch (option) {
      case '--demo-fixtures':
        demoFixtures = true;
        break;
      case '--port':
        if (value === undefined || !/^\d{1,5}$/.test(value) || Number.parseInt(value, 10) > 65_535) {
          throw new StartRefusedError('USAGE', `--port must be an integer from 0 to 65535. ${USAGE}`);
        }
        port = Number.parseInt(value, 10); // a TCP port, not a financial value
        i += 1;
        break;
      case '--allowed-origin':
        if (value === undefined || value.startsWith('--')) {
          throw new StartRefusedError('USAGE', `--allowed-origin needs a value. ${USAGE}`);
        }
        allowedOrigins.push(value);
        i += 1;
        break;
      default:
        throw new StartRefusedError('USAGE', `Unknown option. ${USAGE}`);
    }
  }
  if (port === undefined) {
    throw new StartRefusedError('USAGE', `--port is required. ${USAGE}`);
  }
  if (allowedOrigins.length === 0) {
    throw new StartRefusedError('USAGE', `At least one --allowed-origin is required. ${USAGE}`);
  }
  return { demoFixtures, port, allowedOrigins };
}

export interface StartOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly sleeper?: Sleeper;
  readonly ids?: IdGenerator;
  readonly random?: () => number;
  readonly sink?: (line: string) => void;
  /** Test seam: an in-process calculation instead of the compiled worker. */
  readonly compute?: (input: RiskInput) => Promise<RiskResult>;
  /** Test seam: the ECB transport (recorded responses); `httpsGet` otherwise. */
  readonly fxTransport?: EcbTransport;
}

/** Provisional demo settings and their load status (H3), for the start-up log. */
interface DemoConfigReport {
  readonly profile: string;
  readonly provisionalKeys: readonly { readonly key: string; readonly status: string }[];
}

function demoConfigReport(config: ConfigLoadResult): DemoConfigReport | undefined {
  const profile = readPath(config.values, 'demo.profile');
  if (typeof profile !== 'string') {
    return undefined;
  }
  const keys = readPath(config.values, 'demo.provisionalKeys');
  const listed = Array.isArray(keys) ? (keys as string[]) : [];
  return {
    profile,
    provisionalKeys: listed.map((key) => ({
      key,
      status: (CONFIG_KEYS as readonly string[]).includes(key)
        ? config.keys[key as ConfigKey].status
        : 'UNKNOWN',
    })),
  };
}

interface FxSelection {
  readonly provider: FxProvider;
  readonly setting: 'ECB' | 'FIXTURE' | 'NOT_CONFIGURED';
}

/** `fx.provider` in demo mode: ECB adapter (H2), DEMO fixture rates, or (absent) the unused fixture. */
function selectFxProvider(
  config: ConfigLoadResult,
  fixtures: DemoFixtures,
  transport: EcbTransport,
): FxSelection {
  const setting = readPath(config.values, 'fx.provider');
  if (setting !== 'ECB') {
    // Absent fx.provider already makes valuation and Base VaR unavailable; nothing uses this object.
    return { provider: fixtures.fx, setting: setting === 'FIXTURE' ? 'FIXTURE' : 'NOT_CONFIGURED' };
  }
  const supported = readPath(config.values, 'fx.supportedCurrencies');
  const maxResponseBytes = readPath(config.values, 'fx.ecb.maxResponseBytes');
  const cacheMaxEntries = readPath(config.values, 'fx.ecb.cacheMaxEntries');
  if (typeof maxResponseBytes !== 'number' || typeof cacheMaxEntries !== 'number') {
    // Never substitute the DEMO fixture rates for a configured ECB provider.
    throw new StartRefusedError(
      'FX_PROVIDER_CONFIG_INVALID',
      'fx.provider is ECB but fx.ecb.maxResponseBytes or fx.ecb.cacheMaxEntries is invalid.',
    );
  }
  return {
    setting: 'ECB',
    provider: createEcbFxProvider({
      transport,
      supportedCurrencies: Array.isArray(supported)
        ? (supported as string[]).filter((code) => code !== 'EUR')
        : [],
      maxResponseBytes,
      cacheMaxEntries,
    }),
  };
}

export interface RunningApplication {
  readonly mode: 'DEMO_FIXTURES';
  readonly address: string;
  readonly app: Application;
  readonly logger: Logger;
  stop(): Promise<void>;
}

function demoObservations(config: ConfigLoadResult): number {
  const lookback = readPath(config.values, 'var.lookbackReturns');
  // One more observation than returns; a small margin for discarded gap returns.
  return typeof lookback === 'number' ? lookback + 6 : DEMO_DEFAULT_OBSERVATIONS;
}

const refusalOf = (error: ApplicationStartError): StartRefusal | undefined => {
  switch (error.code) {
    case 'DATABASE_CONFIG_MISSING':
    case 'DATABASE_CONFIG_INVALID':
    case 'DATABASE_UNAVAILABLE':
    case 'GATEWAY_CONFIG_MISSING':
      return error.code;
    case 'ALREADY_STARTED':
      return undefined;
  }
};

/** Steps 1 to 6; resolves when the application listens. */
export async function startApplication(options: StartOptions): Promise<RunningApplication> {
  const args = parseStartArguments(options.argv);
  const clock = options.clock ?? systemClock;
  const env = loadEnv(options.env);
  const logger = createLogger({
    clock,
    secrets: env.secrets,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  if (env.invalid.length > 0) {
    logger.warn('env.invalid', { keys: env.invalid.map((issue) => issue.key) });
  }
  const config = loadConfig({ srcConfigFile: env.env.SRC_CONFIG_FILE, logger });
  const demoConfig = demoConfigReport(config);

  if (demoConfig !== undefined && !args.demoFixtures) {
    throw new StartRefusedError(
      'DEMO_CONFIG_OUTSIDE_DEMO_MODE',
      'The configuration is a demonstration profile (demo.profile); it starts only with --demo-fixtures.',
    );
  }
  if (!args.demoFixtures) {
    throw new StartRefusedError(
      'PROVIDERS_NOT_CONFIGURED',
      'No market data or FX provider is configured (OD-5, OD-13 open); only --demo-fixtures can start.',
    );
  }
  logger.warn('start.demo_mode', {
    mode: 'DEMO_FIXTURES',
    note: 'DEMO fixture providers: every price, series, and result is labelled DEMO. Not for real use.',
  });
  if (demoConfig !== undefined) {
    logger.warn('start.demo_config', {
      profile: demoConfig.profile,
      provisionalKeys: demoConfig.provisionalKeys,
      note: 'Provisional demo settings: not approved values (OD-6).',
    });
  }

  const baseCurrency = readPath(config.values, 'fx.baseCurrency');
  const fixtures = createDemoFixtures({
    clock,
    // Without fx.baseCurrency valuation is unavailable anyway; the label keeps the fixtures valid.
    currency: typeof baseCurrency === 'string' ? baseCurrency : 'USD',
    observations: demoObservations(config),
  });
  const fxSelection = selectFxProvider(config, fixtures, options.fxTransport ?? httpsGet);
  logger.info('start.fx_provider', {
    setting: fxSelection.setting,
    provider: fxSelection.provider.name,
    kind: fxSelection.provider.kind,
    ...(fxSelection.setting === 'ECB'
      ? { note: 'ECB reference rates: approved for the hackathon demo only (H2); not production approval.' }
      : {}),
  });

  let database;
  try {
    database = openApplicationDatabase(env, {
      busyTimeoutMs: PROVISIONAL_OPERATIONAL_VALUES.databaseBusyTimeoutMs,
    });
  } catch (error) {
    if (error instanceof ApplicationStartError) {
      throw new StartRefusedError(refusalOf(error) ?? 'DATABASE_UNAVAILABLE', error.message);
    }
    throw error;
  }

  let app: Application;
  try {
    app = createApplication({
      config,
      secrets: env.secrets,
      unitOfWork: database,
      database,
      clock,
      sleeper: options.sleeper ?? systemSleeper,
      random: options.random ?? Math.random,
      ids: options.ids ?? randomIds,
      logger,
      providers: { marketData: fixtures.marketData, fx: fxSelection.provider },
      sentimentHistoryLimit: PROVISIONAL_OPERATIONAL_VALUES.sentimentHistoryLimit,
      ...(options.compute === undefined ? {} : { compute: options.compute }),
      listen: { host: '127.0.0.1', port: args.port },
      dashboard: { portfolioIds: DEMO_PORTFOLIOS.map((p) => p.id), runMode: 'DEMO_FIXTURES' },
      stream: {
        allowedOrigins: args.allowedOrigins,
        maxClients: PROVISIONAL_OPERATIONAL_VALUES.streamMaxClients,
        maxBufferedBytes: PROVISIONAL_OPERATIONAL_VALUES.streamMaxBufferedBytes,
      },
      alertDelivery: {
        initialBackoffMs: PROVISIONAL_OPERATIONAL_VALUES.alertInitialBackoffMs,
        maxBackoffMs: PROVISIONAL_OPERATIONAL_VALUES.alertMaxBackoffMs,
        attemptTimeoutMs: PROVISIONAL_OPERATIONAL_VALUES.alertAttemptTimeoutMs,
      },
    });
  } catch (error) {
    database.close();
    throw error;
  }

  let address: string;
  try {
    address = await app.start(); // releases everything, the database included, if it fails
  } catch (error) {
    if (error instanceof ApplicationStartError && refusalOf(error) !== undefined) {
      database.close();
      throw new StartRefusedError(refusalOf(error) ?? 'GATEWAY_CONFIG_MISSING', error.message);
    }
    throw error;
  }

  // Step 6 (demo only): fixture history into the series store.
  const retrieval = app.components.seriesRetrieval;
  for (const ticker of fixtures.tickers) {
    const result = retrieval === undefined ? undefined : await retrieval.retrieve(ticker, fixtures.range);
    logger.info('start.demo_history', {
      ticker,
      stored: result?.ok === true,
      ...(result !== undefined && !result.ok ? { code: result.error.code } : {}),
    });
  }

  // H9 (demo only, Kiroween A1): fixed DEMO sentiment observations for display, recorded before
  // the portfolios are seeded so the first calculation sees them (and rejects them as DEMO).
  const demoSentiment = new DemoSentimentFixture();
  for (const observation of demoSentiment.observations()) {
    const outcome = app.components.sentiment?.record(observation);
    logger.info('start.demo_sentiment', {
      provider: demoSentiment.name,
      kind: demoSentiment.kind,
      ticker: observation.ticker,
      outcome: outcome ?? 'SENTIMENT_NOT_CONFIGURED',
    });
  }

  // H6 (demo only): deterministic EUR demo portfolios through the ordinary use cases.
  const seeds = await seedDemoPortfolios({
    portfolios: app.components.portfolios,
    imports: app.components.imports,
    baseCurrency: readPath(config.values, 'fx.baseCurrency'),
    supportedCurrencies: readPath(config.values, 'fx.supportedCurrencies'),
    fixtures,
    importAvailable: config.features.import.available,
  });
  for (const seed of seeds) {
    logger.info('start.demo_portfolio', { ...seed });
  }

  logger.info('start.ready', {
    mode: 'DEMO_FIXTURES',
    address,
    fxProvider: fxSelection.setting,
    demoPortfolios: seeds
      .filter((seed) => seed.seeded || seed.reason === 'ALREADY_PRESENT')
      .map((s) => s.portfolioId),
    ...(demoConfig === undefined
      ? {}
      : { demoProfile: demoConfig.profile, provisionalKeys: demoConfig.provisionalKeys }),
    provisionalOperationalValues: PROVISIONAL_OPERATIONAL_VALUES,
  });
  return { mode: 'DEMO_FIXTURES', address, app, logger, stop: () => app.stop() };
}

/** Process wiring: exit codes 0 (graceful stop), 1 (failure), 2 (refused configuration or usage). */
export async function main(): Promise<void> {
  let running: RunningApplication | undefined;
  const fallback = createLogger({ clock: systemClock });
  try {
    running = await startApplication({ argv: process.argv.slice(2), env: process.env });
  } catch (error) {
    if (error instanceof StartRefusedError) {
      fallback.error('start.refused', { reason: error.reason, message: error.message });
      process.exitCode = 2;
    } else {
      fallback.error('start.failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      process.exitCode = 1;
    }
    return;
  }
  const app = running;
  let stopping = false;
  const shutdown = (trigger: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    app.logger.info('start.shutdown', { trigger });
    app.stop().then(
      () => {
        process.exitCode = 0;
        process.disconnect?.();
      },
      (error: unknown) => {
        app.logger.error('start.shutdown_failed', {
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        process.exitCode = 1;
        process.disconnect?.();
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('message', (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'shutdown'
    ) {
      shutdown('IPC');
    }
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
