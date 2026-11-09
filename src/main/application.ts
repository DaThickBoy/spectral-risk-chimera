/**
 * Composition root and lifecycle (application bootstrap; design: Layers and
 * dependency rule, D-7, D-16; tasks.md "Deferred work").
 *
 * `createApplication(options)` assembles the existing modules with injected
 * ports and returns an `Application` with `start()` and `stop()`:
 * - HTTP and WebSocket gateway (4.2, 15.1) with every available route, on the
 *   loopback host only (`listenApiServer`, OD-7 open).
 * - PositionsChanged (6.2) is delivered in-process to the risk scheduler (12.4).
 *   After each stored result the risk update is pushed to `/stream` and the VaR
 *   alert service (16.1, 16.2) evaluates it; a raised alert wakes the outbox
 *   dispatcher (16.3), which publishes to the `/stream` hub. No other event
 *   contract is wired: the 12.4 price trigger and the 14.3 eligibility trigger
 *   wait for their approved contracts.
 * - The sentiment emitter (13.6) pushes changed tickers to `/stream`; the REST
 *   poller (13.1) runs only with an injected provider that can poll and the
 *   configured `sentiment.rest.pollSeconds`. The WSS stream needs a vendor
 *   transport and decoder (13.8, OD-13) and is not wired.
 *
 * Lifecycle:
 * - `start()` listens first; when listening fails, everything created so far is
 *   released and the error is rethrown. Then the background loops start and the
 *   dispatcher delivers alerts left `PENDING` before the restart (R34.7).
 * - `stop()` closes the gateway (WebSocket clients included), aborts the loops,
 *   drains running recalculations, stops the dispatcher (undelivered alerts stay
 *   `PENDING`), and closes the risk worker. It is idempotent.
 * - Background failures are logged through the redacting logger and never stop
 *   the application; calculation crashes are audited by the worker client.
 */
import {
  alertRoutes,
  createApiServer,
  dashboardRoutes,
  createStreamHub,
  importRoutes,
  listenApiServer,
  portfolioRoutes,
  providerStatusRoutes,
  riskRoutes,
  streamAlertPublisher,
  streamRoutes,
} from '../api/index.js';
import type { ApiRoutes, AuthGuard, ListenOptions, StreamHub } from '../api/index.js';
import {
  createAlertDispatcher,
  createDashboardService,
  createRiskWorkerClient,
  riskUpdateEvent,
  sentimentUpdateEvents,
  varAlertInput,
} from '../app/index.js';
import type { AlertDispatcher, RiskWorkerClient } from '../app/index.js';
import { createSentimentEmitter, createSentimentPoller } from '../sentiment/index.js';
import type { SentimentEmitter, SentimentPoller } from '../sentiment/index.js';
import type { StreamEvent } from '../shared/index.js';
import { buildComponents } from './components.js';
import type { ComponentStatus, Components, CoreDependencies } from './components.js';
import { optionalValue, requireKeys } from './configValues.js';

export interface ApplicationOptions extends Omit<
  CoreDependencies,
  'compute' | 'afterCalculation' | 'afterAlert' | 'secrets'
> {
  readonly secrets?: readonly string[];
  /** Risk calculation; defaults to the compiled risk worker (R23.4). */
  readonly compute?: CoreDependencies['compute'];
  /** Worker script for the default worker client (tests); defaults to the compiled worker. */
  readonly workerUrl?: URL;
  readonly listen: ListenOptions;
  /** `/stream` limits (15.1): caller options, no configuration keys. */
  readonly stream: {
    /**
     * Exact origins (`--allowed-origin`) for the `/stream` upgrade and, through the request
     * guard (Gateway rule 9), for every state-changing HTTP request.
     */
    readonly allowedOrigins: readonly string[];
    readonly maxClients: number;
    readonly maxBufferedBytes: number;
  };
  /** Dispatcher waits (16.3): caller options, no configuration keys. */
  readonly alertDelivery: {
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
    readonly attemptTimeoutMs: number;
  };
  /** Tickers the REST poller asks for; the poller starts only when this is supplied. */
  readonly sentimentPolling?: { readonly tickers: () => readonly string[] };
  /** Type-only in version 1 (OD-7). */
  readonly authGuard?: AuthGuard;
  /**
   * The durable store behind `unitOfWork` (OD-12), closed last in `stop()` and after a failed
   * `start()`; absent when the caller owns the store's lifetime (for example in-memory tests).
   */
  readonly database?: { close(): void };
  /**
   * Read-only dashboard routes (17.1 to 17.3): the portfolios `GET /dashboard` lists and the
   * run mode it reports. Absent: an empty list and `UNSPECIFIED`.
   */
  readonly dashboard?: {
    readonly portfolioIds: readonly string[];
    readonly runMode: 'DEMO_FIXTURES' | 'UNSPECIFIED';
  };
}

export type ApplicationState = 'NEW' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED';

export type ApplicationStartErrorCode =
  | 'ALREADY_STARTED'
  | 'GATEWAY_CONFIG_MISSING'
  | 'DATABASE_CONFIG_MISSING'
  | 'DATABASE_CONFIG_INVALID'
  | 'DATABASE_UNAVAILABLE';

const START_MESSAGES: Readonly<Record<ApplicationStartErrorCode, (keys: string) => string>> = {
  ALREADY_STARTED: () => 'The application was already started.',
  GATEWAY_CONFIG_MISSING: (keys) => `The gateway cannot start without: ${keys}.`,
  DATABASE_CONFIG_MISSING: (keys) => `The database is not configured: ${keys} is not set.`,
  DATABASE_CONFIG_INVALID: (keys) => `The database is not configured: ${keys} is not a valid file path.`,
  DATABASE_UNAVAILABLE: () => 'The database could not be opened.',
};

export class ApplicationStartError extends Error {
  constructor(
    readonly code: ApplicationStartErrorCode,
    readonly keys: readonly string[] = [],
    /** For DATABASE_UNAVAILABLE: the persistence error code (never the driver message). */
    readonly persistenceCode?: string,
  ) {
    super(START_MESSAGES[code](keys.join(', ')));
    this.name = 'ApplicationStartError';
  }
}

export interface Application {
  start(): Promise<string>;
  stop(): Promise<void>;
  readonly state: ApplicationState;
  readonly components: Components;
  readonly hub: StreamHub;
  readonly dispatcher: AlertDispatcher | undefined;
  readonly emitter: SentimentEmitter | undefined;
  readonly poller: SentimentPoller | undefined;
  /** Every component with its availability and the keys it is missing. */
  readonly status: Readonly<Record<string, ComponentStatus>>;
}

const GATEWAY_KEYS = [
  'api.rateLimitPerMinute',
  'api.uploadRateLimitPerMinute',
  'import.maxFileBytes',
] as const;

export function createApplication(options: ApplicationOptions): Application {
  const { logger, config } = options;
  const hub = createStreamHub({
    logger,
    maxClients: options.stream.maxClients,
    maxBufferedBytes: options.stream.maxBufferedBytes,
  });
  const publish = (event: StreamEvent): void => {
    const result = hub.publish(event);
    if (!result.ok) {
      logger.error('stream.publish_refused', { type: event.type, code: result.code });
    }
  };

  const worker: RiskWorkerClient | undefined =
    options.compute === undefined
      ? createRiskWorkerClient({
          unitOfWork: options.unitOfWork,
          clock: options.clock,
          ids: options.ids,
          ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
        })
      : undefined;
  const compute = options.compute ?? ((input) => (worker as RiskWorkerClient).compute(input));

  const late: { components?: Components; dispatcher?: AlertDispatcher } = {};
  const components = buildComponents({
    ...options,
    secrets: options.secrets ?? [],
    compute,
    afterCalculation: (portfolioId) => {
      const { risk, alerts } = late.components ?? {};
      const view = risk?.view(portfolioId);
      if (risk === undefined || alerts === undefined || view === undefined) {
        return;
      }
      try {
        publish(riskUpdateEvent(portfolioId, view));
      } catch (error) {
        logger.error('stream.risk_update_failed', { portfolioId, errorName: (error as Error).name });
      }
      const triggered =
        risk.adjustmentDetail(portfolioId)?.triggeredAssets.map((asset) => asset.ticker) ?? [];
      alerts.onRiskResult(varAlertInput(view, triggered));
    },
    afterAlert: () => late.dispatcher?.kick(),
  });
  late.components = components;
  const status: Record<string, ComponentStatus> = { ...components.status };

  const deliveryKeys = requireKeys(config, ['alerts.delivery.maxRetries'] as const);
  const dispatcher = deliveryKeys.ok
    ? createAlertDispatcher({
        unitOfWork: options.unitOfWork,
        clock: options.clock,
        sleeper: options.sleeper,
        ids: options.ids,
        logger,
        publishers: [streamAlertPublisher(hub)],
        maxRetries: deliveryKeys.get('alerts.delivery.maxRetries') as number,
        ...options.alertDelivery,
      })
    : undefined;
  if (dispatcher !== undefined) {
    late.dispatcher = dispatcher;
  }
  status['alertDelivery'] = {
    available: dispatcher !== undefined,
    missingKeys: deliveryKeys.ok ? [] : deliveryKeys.missingKeys,
  };

  const { sentiment, resilientCall } = components;
  const emitter =
    sentiment === undefined
      ? undefined
      : createSentimentEmitter({
          clock: options.clock,
          sleeper: options.sleeper,
          state: sentiment,
          emit: (updates) => sentimentUpdateEvents(updates).forEach(publish),
          onError: (error) =>
            logger.error('sentiment.emit_failed', {
              errorName: error instanceof Error ? error.name : 'unknown',
            }),
        });

  const provider = options.providers.sentiment;
  const pollSeconds = optionalValue(config, 'sentiment.rest.pollSeconds');
  const poller =
    sentiment !== undefined &&
    resilientCall !== undefined &&
    provider?.fetchLatest !== undefined &&
    typeof pollSeconds === 'number' &&
    options.sentimentPolling !== undefined
      ? createSentimentPoller({
          provider,
          resilientCall,
          clock: options.clock,
          sleeper: options.sleeper,
          pollSeconds,
          tickers: options.sentimentPolling.tickers,
          sink: (observation) => void sentiment.record(observation),
          onRejected: components.onSentimentRejected,
          onProviderError: (error) =>
            logger.warn('sentiment.provider_error', { provider: error.provider, code: error.code }),
        })
      : undefined;
  status['sentimentPolling'] = {
    available: poller !== undefined,
    missingKeys: typeof pollSeconds === 'number' ? [] : ['sentiment.rest.pollSeconds'],
  };

  let state: ApplicationState = 'NEW';
  let server: ReturnType<typeof createApiServer> | undefined;
  let loops: AbortController | undefined;
  let running: Promise<unknown>[] = [];

  const routes = (): ApiRoutes[] => {
    const list: ApiRoutes[] = [
      riskRoutes({ risk: components.risk }),
      alertRoutes({ alerts: components.alerts }),
      streamRoutes({ hub, logger, allowedOrigins: options.stream.allowedOrigins }),
    ];
    if (components.providerStatus !== undefined) {
      list.push(providerStatusRoutes({ providerStatus: components.providerStatus }));
    }
    if (components.portfolios !== undefined) {
      list.push(
        portfolioRoutes({
          portfolios: components.portfolios,
          ...(components.queries === undefined ? {} : { queries: components.queries }),
        }),
      );
    }
    if (components.imports !== undefined) {
      list.push(importRoutes({ imports: components.imports, ids: options.ids }));
    }
    if (components.portfolios !== undefined && components.queries !== undefined) {
      list.push(
        dashboardRoutes({
          dashboard: createDashboardService({
            risk: components.risk,
            queries: components.queries,
            portfolios: components.portfolios,
            sentiment: components.sentiment,
            // OD-1 is open: only tests inject an aggregator (the contract double).
            sentimentAggregation: options.sentimentAggregator === undefined ? 'NOT_APPROVED' : 'INJECTED',
            clock: options.clock,
            portfolioIds: options.dashboard?.portfolioIds ?? [],
            runMode: options.dashboard?.runMode ?? 'UNSPECIFIED',
          }),
        }),
      );
    }
    return list;
  };

  const release = async (): Promise<void> => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    loops?.abort();
    await Promise.allSettled(running);
    running = [];
    await Promise.all([...components.requested].map((id) => components.scheduler.idle(id)));
    await dispatcher?.stop();
    await worker?.close();
    // Last: nothing above writes any more. Every later unit of work fails with COMMIT_FAILED.
    options.database?.close();
  };

  const background = (name: string, task: (signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) => {
    running.push(
      task(signal).catch((error: unknown) =>
        logger.error('app.background_failed', {
          task: name,
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      ),
    );
  };

  return {
    get state() {
      return state;
    },
    components,
    hub,
    dispatcher,
    emitter,
    poller,
    status,
    start: async () => {
      if (state !== 'NEW') {
        throw new ApplicationStartError('ALREADY_STARTED');
      }
      const gateway = requireKeys(config, GATEWAY_KEYS);
      if (!gateway.ok) {
        throw new ApplicationStartError('GATEWAY_CONFIG_MISSING', gateway.missingKeys);
      }
      state = 'STARTING';
      try {
        server = createApiServer({
          logger,
          clock: options.clock,
          rateLimits: {
            perMinute: gateway.get('api.rateLimitPerMinute') as number,
            uploadPerMinute: gateway.get('api.uploadRateLimitPerMinute') as number,
          },
          uploads: { maxFileBytes: gateway.get('import.maxFileBytes') as number },
          routes: routes(),
          // Gateway rule 9: Host must name the bound loopback socket; writes need an allowed Origin.
          requestGuard: { allowedOrigins: options.stream.allowedOrigins },
          ...(options.authGuard === undefined ? {} : { authGuard: options.authGuard }),
        });
        const address = await listenApiServer(server, options.listen);
        loops = new AbortController();
        if (emitter !== undefined) {
          background('sentimentEmitter', (signal) => emitter.run(signal), loops.signal);
        }
        if (poller !== undefined) {
          background('sentimentPoller', (signal) => poller.run(signal), loops.signal);
        }
        dispatcher?.kick();
        state = 'RUNNING';
        logger.info('app.started', { address, components: status });
        return address;
      } catch (error) {
        logger.error('app.start_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
        await release();
        state = 'STOPPED';
        throw error;
      }
    },
    stop: async () => {
      if (state === 'STOPPED' || state === 'STOPPING') {
        return;
      }
      state = 'STOPPING';
      await release();
      state = 'STOPPED';
      logger.info('app.stopped');
    },
  };
}
