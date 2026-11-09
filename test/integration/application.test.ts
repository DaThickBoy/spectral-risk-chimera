// Application bootstrap: the assembled composition root over a real loopback server and a local
// `ws` client. Ports that wait on open decisions are injected: persistence (OD-12) is the
// in-memory unit of work (and SQLite files for the restart tests), and the providers (OD-5, OD-13) are REAL-kind test fakes. Settings are
// TEST values (OD-6). The risk calculation runs in-process; the compiled worker is covered by
// test/integration/build.test.ts.
// Validates: Requirements 14.14, 16.1, 17.10, 18.7, 19.1, 19.5, 25.1, 30.11, 34.7
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ListenRefusedError } from '../../src/api/index.js';
import { loadConfig, loadEnv } from '../../src/config/index.js';
import type { FxProvider } from '../../src/fx/index.js';
import type { MarketDataProvider } from '../../src/marketdata/index.js';
import { ApplicationStartError, createApplication, openApplicationDatabase } from '../../src/main/index.js';
import type { Application, ApplicationOptions } from '../../src/main/index.js';
import { InMemoryUnitOfWork, SqliteUnitOfWork } from '../../src/persistence/index.js';
import { riskEngine } from '../../src/risk/index.js';
import {
  FakeClock,
  FakeSleeper,
  StreamEventSchema,
  brandDecimalString,
  canonicalJson,
  sequentialIds,
  sha256Hex,
} from '../../src/shared/index.js';
import type { SentimentIndex, StreamEvent } from '../../src/shared/index.js';
import { capturingLogger } from '../helpers/api.js';
import { completeTestConfig, withKey, writeConfig } from '../helpers/config.js';
import { multipart } from '../helpers/multipart.js';
import { advanceBy } from '../helpers/resilience.js';
import { cleanSeries } from '../helpers/riskService.js';
import { tempDir } from '../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../helpers/persistenceAdapters.js';

const NOW = '2026-11-08T12:00:00.000Z';
const ORIGIN = 'http://127.0.0.1:5173';
const PF = 'pf-app';
const CSV = 'trade_timestamp,ticker,type,quantity,price,currency\n2026-11-02T14:30:00Z,AAA,BUY,10,90,USD\n';

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** TEST settings: a small lookback (Base VaR 80 for 10 units at 100) and alert thresholds. */
function testConfig(change: (c: Record<string, unknown>) => Record<string, unknown> = (c) => c) {
  let values = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);
  values = withKey(values, 'alerts.var.thresholdPct', '5');
  values = withKey(values, 'alerts.resetPct', '5');
  return change(values);
}

function marketData(kind: 'REAL' | 'DEMO' = 'REAL'): MarketDataProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'test-md',
    kind,
    calls,
    getDailySeries: (ticker, range) => {
      calls.push(`series:${ticker}`);
      const observations = ['100', '110', '99', '108.9']
        .map((price, i) => ({ date: `2026-11-0${3 + i}`, adjustedClose: brandDecimalString(price) }))
        .filter((o) => o.date >= range.from && o.date <= range.to);
      return Promise.resolve({
        ok: true,
        value: {
          ticker,
          currency: 'USD',
          source: 'test-md',
          sourceKind: kind,
          retrievedAt: NOW,
          observations,
          contentHash: sha256Hex(canonicalJson({ ticker, currency: 'USD', observations })),
        },
      });
    },
    getLatestPrice: (ticker) => {
      calls.push(ticker);
      return Promise.resolve({
        ok: true,
        value: {
          ticker,
          currency: 'USD',
          price: brandDecimalString('100'),
          asOf: '2026-11-06',
          source: 'test-md',
          sourceKind: kind,
          retrievedAt: NOW,
        },
      });
    },
  } as MarketDataProvider & { calls: string[] };
}

const unusedFx: FxProvider = {
  name: 'test-fx',
  kind: 'REAL',
  getRate: () => Promise.reject(new Error('no FX call expected for the base currency')),
};

interface Built {
  readonly app: Application;
  readonly uow: TestUnitOfWork;
  readonly clock: FakeClock;
  readonly sleeper: FakeSleeper;
  readonly lines: Record<string, unknown>[];
}

function build(
  values: Record<string, unknown>,
  overrides: Partial<ApplicationOptions> & {
    uow?: TestUnitOfWork;
    kind?: 'REAL' | 'DEMO';
    seedHistory?: boolean;
  } = {},
): Built {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'src-app-'));
  dirs.push(dir);
  const { logger, lines } = capturingLogger();
  const config = loadConfig({ srcConfigFile: writeConfig(dir, 'config.json', values), logger });
  const uow = overrides.uow ?? new InMemoryUnitOfWork();
  const clock = new FakeClock(NOW);
  const sleeper = new FakeSleeper(clock);
  const app = createApplication({
    config,
    unitOfWork: uow,
    clock,
    sleeper,
    random: () => 0.5,
    ids: sequentialIds('id'),
    logger,
    providers: { marketData: marketData(overrides.kind), fx: unusedFx },
    sentimentHistoryLimit: 100,
    compute: (input) => Promise.resolve(riskEngine.compute(input)),
    listen: { host: '127.0.0.1', port: 0 },
    stream: { allowedOrigins: [ORIGIN], maxClients: 4, maxBufferedBytes: 1_048_576 },
    alertDelivery: { initialBackoffMs: 100, maxBackoffMs: 400, attemptTimeoutMs: 1000 },
    ...overrides,
  });
  cleanups.push(() => app.stop());
  if (overrides.seedHistory !== false) {
    app.components.seriesStore.put(
      cleanSeries('AAA', ['100', '110', '99', '108.9'], {
        start: '2026-11-03',
        sourceKind: overrides.kind ?? 'REAL',
      }),
    );
  }
  return { app, uow, clock, sleeper, lines };
}

async function client(
  address: string,
): Promise<{ ws: WebSocket; messages: StreamEvent[]; closed: Promise<number> }> {
  const ws = new WebSocket(`${address.replace(/^http/, 'ws')}/stream`, { origin: ORIGIN });
  const messages: StreamEvent[] = [];
  ws.on('message', (data) => messages.push(StreamEventSchema.parse(JSON.parse(String(data)))));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  cleanups.push(async () => ws.terminate());
  return { ws, messages, closed };
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function createPortfolioAndImport(address: string): Promise<void> {
  // State-changing requests carry an allowed Origin (Gateway rule 9).
  const created = await fetch(`${address}/portfolios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ id: PF, base_currency: 'USD', cash: '0' }),
  });
  expect(created.status).toBe(201);
  const { headers, payload } = multipart([{ name: 'file', filename: 'trades.csv', content: CSV }]);
  const imported = await fetch(`${address}/portfolios/${PF}/imports`, {
    method: 'POST',
    headers: { ...headers, origin: ORIGIN },
    body: payload,
  });
  expect(imported.status).toBe(201);
  expect(await imported.json()).toMatchObject({ accepted: 1, positions: 'REBUILT' });
}

describe('assembled application: import to risk, stream, and alert', () => {
  it('an import recalculates risk, pushes RiskUpdate, raises and delivers one alert (metric BASE)', async () => {
    const b = build(testConfig((c) => withKey(c, 'alerts.var.metric', 'BASE')));
    const address = await b.app.start();
    expect(b.app.state).toBe('RUNNING');
    const ws = await client(address);
    await until(() => b.app.hub.clientCount === 1);

    await createPortfolioAndImport(address);
    await until(() => ws.messages.some((m) => m.type === 'AlertRaised'));

    const risk = ws.messages.find((m) => m.type === 'RiskUpdate');
    expect(risk).toMatchObject({
      type: 'RiskUpdate',
      portfolioId: PF,
      risk: {
        baseVaR: { validity: 'CURRENT', value: { absolute: '80', percentOfNav: '8' } },
        adjustedVaR: { validity: 'UNAVAILABLE', value: null }, // no aggregator (OD-1)
      },
    });
    const alert = ws.messages.find((m) => m.type === 'AlertRaised');
    expect(alert).toMatchObject({
      alertType: 'VAR',
      portfolioId: PF,
      severity: 'CRITICAL', // 8 / 5 = 1.6 >= 1.50 (TEST ratios)
      metric: 'BASE_VAR_PCT_NAV',
      observedValue: '8',
      threshold: '5',
    });
    expect(ws.messages.filter((m) => m.type === 'AlertRaised')).toHaveLength(1);

    const riskRoute = await (await fetch(`${address}/portfolios/${PF}/risk`)).json();
    expect(riskRoute).toMatchObject({ baseVaR: { value: { absolute: '80' } } });
    const history = (await (await fetch(`${address}/alerts?portfolioId=${PF}`)).json()) as {
      alerts: { delivery: string }[];
    };
    await until(() => b.uow.snapshot().alerts[0]?.delivery === 'DELIVERED');
    expect(history.alerts).toHaveLength(1);
    const providers = await (await fetch(`${address}/providers/status`)).json();
    expect(providers).toMatchObject({
      providers: [
        { provider: 'fx:test-fx', state: 'AVAILABLE' },
        { provider: 'marketdata:test-md', state: 'AVAILABLE' },
      ],
    });
    expect(b.uow.snapshot().audit.map((a) => a.type)).toContain('ALERT_RAISED');
  });

  it('history retrieved from the provider (9.6) is what Base VaR consumes, with its provenance', async () => {
    const b = build(testConfig(), { seedHistory: false });
    expect(b.app.status['seriesRetrieval']).toEqual({ available: true, missingKeys: [] });
    const address = await b.app.start();
    const retrieval = b.app.components.seriesRetrieval;
    if (retrieval === undefined) throw new Error('series retrieval not assembled');
    const retrieved = await retrieval.retrieve('AAA', { from: '2026-11-02', to: '2026-11-06' });
    expect(retrieved).toMatchObject({
      ok: true,
      value: {
        observations: 4,
        retrieval: { source: 'test-md', sourceKind: 'REAL', label: 'CACHED', retrievedAt: NOW },
      },
    });
    await createPortfolioAndImport(address);
    await b.app.components.scheduler.idle(PF);
    const view = b.app.components.risk.view(PF);
    expect(view).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT', value: { absolute: '80' } } });
    expect(retrieved.ok && view?.seriesHashes).toEqual({
      AAA: retrieved.ok ? retrieved.value.contentHash : '',
    });
  });

  it('without stored history, Base VaR is INSUFFICIENT_DATA (HISTORY_UNAVAILABLE), never zero', async () => {
    const b = build(testConfig(), { seedHistory: false });
    const address = await b.app.start();
    await createPortfolioAndImport(address);
    await b.app.components.scheduler.idle(PF);
    expect(b.app.components.risk.view(PF)).toMatchObject({
      status: 'INSUFFICIENT_DATA',
      baseVaR: { validity: 'UNAVAILABLE', value: null, reason: 'HISTORY_UNAVAILABLE' },
    });
  });

  it('metric ADJUSTED without an aggregator: Adjusted VaR unavailable, no alert, the skip audited', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    await createPortfolioAndImport(address);
    await until(() => b.uow.snapshot().audit.some((a) => a.type === 'ALERT_SKIPPED'));
    expect(b.uow.snapshot().alerts).toEqual([]);
    expect(b.uow.snapshot().audit.find((a) => a.type === 'ALERT_SKIPPED')?.details).toMatchObject({
      reason: 'FIGURE_NOT_CURRENT',
      metric: 'ADJUSTED',
      figureStatus: 'SENTIMENT_NOT_CURRENT',
    });
    expect(b.app.status['sentimentAggregator']).toEqual({ available: false, missingKeys: [] });
  });

  it('a DEMO-data result is stored and shown but never evaluated for VaR alerts (R30.11)', async () => {
    const b = build(
      testConfig((c) => withKey(c, 'alerts.var.metric', 'BASE')),
      { kind: 'DEMO' },
    );
    const address = await b.app.start();
    await createPortfolioAndImport(address);
    await until(() => b.uow.snapshot().audit.some((a) => a.type === 'ALERT_SKIPPED'));
    expect(b.uow.snapshot().audit.find((a) => a.type === 'ALERT_SKIPPED')?.details).toMatchObject({
      reason: 'DEMO_DATA',
    });
    expect(b.uow.snapshot().alerts).toEqual([]);
    const riskRoute = (await (await fetch(`${address}/portfolios/${PF}/risk`)).json()) as { flags: string[] };
    expect(riskRoute.flags).toContain('DEMO_DATA');
  });
});

describe('sentiment emitter to /stream', () => {
  it('an accepted observation is pushed on the next 3,000 ms tick', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    const ws = await client(address);
    await until(() => b.app.hub.clientCount === 1);
    b.app.components.sentiment?.record({
      provider: 'test-sentiment',
      sourceKind: 'REAL',
      ticker: 'AAA',
      value: brandDecimalString('-0.7') as SentimentIndex,
      observedAt: NOW,
      receivedAt: NOW,
    });
    await advanceBy({ clock: b.clock, sleeper: b.sleeper }, 3000);
    await until(() => ws.messages.some((m) => m.type === 'SentimentUpdate'));
    expect(ws.messages.find((m) => m.type === 'SentimentUpdate')).toMatchObject({
      ticker: 'AAA',
      index: null, // no aggregator (OD-1)
      latest: { value: '-0.7', provider: 'test-sentiment', sourceKind: 'REAL' },
    });
  });
});

describe('configuration gating (architecture section 6)', () => {
  it('missing FX settings disable valuation and portfolios only; the gateway and risk routes still run', async () => {
    const b = build(
      testConfig((c) =>
        withKey(withKey(c, 'fx.baseCurrency', undefined), 'fx.supportedCurrencies', undefined),
      ),
    );
    expect(b.app.status['valuation']).toEqual({
      available: false,
      missingKeys: ['fx.baseCurrency', 'fx.supportedCurrencies'],
    });
    expect(b.app.status['portfolios']).toEqual({ available: false, missingKeys: ['fx.baseCurrency'] });
    expect(b.app.status['imports']?.available).toBe(false);
    const address = await b.app.start();
    const created = await fetch(`${address}/portfolios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ id: PF, base_currency: 'USD', cash: '0' }),
    });
    expect(created.status).toBe(404);
    expect((await fetch(`${address}/portfolios/${PF}/risk`)).status).toBe(404);
    expect((await fetch(`${address}/providers/status`)).status).toBe(200);
  });

  it('a recalculation under missing Base VaR settings stores CONFIG_MISSING with the keys (R14.14)', async () => {
    const b = build(testConfig((c) => withKey(c, 'var.confidence', undefined)));
    await b.app.start();
    b.app.components.portfolios?.create({ id: PF, baseCurrency: 'USD', cash: brandDecimalString('0') });
    b.app.components.scheduler.requestRecalculation(PF, 'MANUAL');
    await b.app.components.scheduler.idle(PF);
    expect(b.app.components.risk.view(PF)).toMatchObject({
      status: 'CONFIG_MISSING',
      baseVaR: { validity: 'UNAVAILABLE', value: null, missingKeys: ['var.confidence'] },
    });
  });
});

/** One raw request with exactly the given headers (node:http, so any Host can be sent). */
function rawRequest(
  address: string,
  method: string,
  route: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: Number(url.port), method, path: route, headers, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('request guard on the assembled application (Gateway rule 9; not authentication, OD-7)', () => {
  const EVIL = 'https://evil.example';
  const createPortfolio = (address: string, headers: Record<string, string>) =>
    fetch(`${address}/portfolios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ id: PF, base_currency: 'USD', cash: '0' }),
    });

  it('portfolio creation: refused without or with a foreign Origin, accepted with the allowed one', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    for (const headers of [{}, { origin: EVIL }, { origin: 'null' }, { origin: `${ORIGIN}/` }]) {
      const refused = await createPortfolio(address, headers);
      expect(refused.status, JSON.stringify(headers)).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('ORIGIN_FORBIDDEN');
    }
    expect(b.uow.snapshot().portfolios).toEqual([]);
    expect((await createPortfolio(address, { origin: ORIGIN })).status).toBe(201);
    expect(b.uow.snapshot().portfolios.map((p) => p.id)).toEqual([PF]);
  });

  it('CSV import: a cross-site multipart upload is refused and stores nothing', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    expect((await createPortfolio(address, { origin: ORIGIN })).status).toBe(201);
    const upload = (headers: Record<string, string>) => {
      const { headers: form, payload } = multipart([{ name: 'file', filename: 'trades.csv', content: CSV }]);
      return fetch(`${address}/portfolios/${PF}/imports`, {
        method: 'POST',
        headers: { ...form, ...headers },
        body: payload,
      });
    };
    for (const headers of [{}, { origin: EVIL }, { origin: 'null' }]) {
      expect((await upload(headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect(b.uow.snapshot().transactions).toEqual([]);
    expect(b.uow.snapshot().imports).toEqual([]);
    const imported = await upload({ origin: ORIGIN });
    expect(imported.status).toBe(201);
    expect(b.uow.snapshot().transactions).toHaveLength(1);
  });

  it('alert dismissal: refused without the allowed Origin, unchanged behaviour with it', async () => {
    const b = build(testConfig((c) => withKey(c, 'alerts.var.metric', 'BASE')));
    const address = await b.app.start();
    await createPortfolioAndImport(address);
    await until(() => b.uow.snapshot().alerts.length === 1);
    const id = b.uow.snapshot().alerts[0]?.id ?? '';
    const dismiss = (headers: Record<string, string>) =>
      fetch(`${address}/alerts/${id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
    for (const headers of [{}, { origin: EVIL }, { origin: 'null' }]) {
      expect((await dismiss(headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect(b.uow.snapshot().alerts[0]?.state).toBe('OPEN');
    const dismissed = await dismiss({ origin: ORIGIN });
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ id, state: 'DISMISSED' });
    expect((await dismiss({ origin: ORIGIN })).status).toBe(409); // ALERT_NOT_OPEN, as before
  });

  it('Host: the bound 127.0.0.1 and localhost ports are accepted; foreign names and ports are 421', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    const port = new URL(address).port;
    expect(await rawRequest(address, 'GET', '/providers/status', { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawRequest(address, 'GET', '/providers/status', { host: `localhost:${port}` })).toBe(200);
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `[::1]:${port}`]) {
      expect(await rawRequest(address, 'GET', '/providers/status', { host }), host).toBe(421);
    }
    // A rebinding page has a foreign Host, so even an allowed-looking Origin cannot write.
    expect(
      await rawRequest(address, 'POST', '/alerts/x/dismiss', {
        host: `evil.example:${port}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      }),
    ).toBe(421);
  });

  it('read-only requests and the /stream upgrade keep working with the allowed origin', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    expect((await fetch(`${address}/providers/status`)).status).toBe(200);
    expect((await fetch(`${address}/alerts?portfolioId=${PF}`)).status).toBe(200);
    await client(address);
    await until(() => b.app.hub.clientCount === 1);
  });
});

describe('lifecycle', () => {
  it('start twice is refused; stop closes WebSocket clients and the port, and is idempotent', async () => {
    const b = build(testConfig());
    const address = await b.app.start();
    await expect(b.app.start()).rejects.toEqual(new ApplicationStartError('ALREADY_STARTED'));
    const ws = await client(address);
    await b.app.stop();
    expect(b.app.state).toBe('STOPPED');
    expect(await ws.closed).toBeGreaterThan(0);
    await expect(fetch(`${address}/alerts?portfolioId=${PF}`)).rejects.toThrow();
    await b.app.stop();
    expect(b.lines.filter((l) => l.msg === 'app.stopped')).toHaveLength(1);
  });

  it('a refused listen releases everything and leaves the application STOPPED', async () => {
    const b = build(testConfig(), { listen: { host: '0.0.0.0', port: 0 } });
    await expect(b.app.start()).rejects.toBeInstanceOf(ListenRefusedError);
    expect(b.app.state).toBe('STOPPED');
    expect(b.lines.some((l) => l.msg === 'app.start_failed')).toBe(true);
  });

  it('a restart delivers alerts left PENDING in the outbox (R34.7)', async () => {
    const uow = new InMemoryUnitOfWork();
    // The alert a stopped (or crashed) instance left undelivered in the outbox.
    uow.run((tx) =>
      tx.alerts.insert({
        id: 'alert-pending',
        type: 'VAR',
        source: 'var-alert-evaluator',
        portfolioId: PF,
        ticker: null,
        severity: 'WARNING',
        metric: 'BASE_VAR_PCT_NAV',
        observed: brandDecimalString('6'),
        threshold: brandDecimalString('5'),
        triggeredTickers: [],
        createdAt: NOW,
        description: 'WARNING: test alert left pending by a restart.',
        state: 'OPEN',
        stateChangedAt: null,
        delivery: 'PENDING',
        deliveryAttempts: 0,
        lastAttemptAt: null,
      }),
    );
    const restarted = build(testConfig(), { uow });
    await restarted.app.start();
    await until(() => uow.snapshot().alerts.find((a) => a.id === 'alert-pending')?.delivery === 'DELIVERED');
    expect(uow.snapshot().alerts[0]?.deliveryAttempts).toBe(1);
  });
});

describe('durable persistence (OD-12): restart on the same SQLite file', () => {
  it('portfolios, risk results, alerts, alert state, and pending delivery survive a restart', async () => {
    const file = path.join(tempDir(), 'app.db');
    const config = testConfig((c) => withKey(c, 'alerts.var.metric', 'BASE'));

    // First instance: the dispatcher is stopped, so the raised alert stays PENDING in the outbox.
    const firstDb = SqliteUnitOfWork.open(file, { busyTimeoutMs: 2000 });
    const first = build(config, { uow: firstDb, database: firstDb });
    const firstAddress = await first.app.start();
    await first.app.dispatcher?.stop();
    await createPortfolioAndImport(firstAddress);
    await first.app.components.scheduler.idle(PF);
    expect(firstDb.snapshot().alerts.map((a) => [a.severity, a.delivery])).toEqual([['CRITICAL', 'PENDING']]);
    await first.app.stop();
    expect(firstDb.isOpen).toBe(false); // closed by stop()

    // Second instance on the same file: nothing is re-seeded.
    const secondDb = SqliteUnitOfWork.open(file, { busyTimeoutMs: 2000 });
    const second = build(config, { uow: secondDb, database: secondDb, seedHistory: false });
    const address = await second.app.start();
    await until(() => secondDb.snapshot().alerts[0]?.delivery === 'DELIVERED');
    expect(secondDb.snapshot().alerts[0]).toMatchObject({ delivery: 'DELIVERED', deliveryAttempts: 1 });
    const risk = (await (await fetch(`${address}/portfolios/${PF}/risk`)).json()) as {
      baseVaR: { value: { absolute: string } };
    };
    expect(risk.baseVaR.value.absolute).toBe('80');
    const positions = (await (await fetch(`${address}/portfolios/${PF}/positions`)).json()) as {
      positions: { ticker: string; signedQuantity: string }[];
    };
    expect(positions.positions.map((p) => [p.ticker, p.signedQuantity])).toEqual([['AAA', '10']]);
    expect(secondDb.snapshot().alertState).toEqual([
      expect.objectContaining({ phase: 'BREACHED', lastSeverity: 'CRITICAL' }),
    ]);
    // The persisted state keeps the open breach: a new calculation does not fire again.
    second.app.components.scheduler.requestRecalculation(PF, 'MANUAL');
    await second.app.components.scheduler.idle(PF);
    expect(secondDb.snapshot().alerts).toHaveLength(1);
    expect(secondDb.snapshot().audit.filter((a) => a.type === 'ALERT_SUPPRESSED')).toHaveLength(1);
    expect(secondDb.snapshot().riskResults).toHaveLength(2);
    await second.app.stop();
    expect(secondDb.isOpen).toBe(false);
  });
});

describe('database bootstrap (SRC_DATABASE_FILE)', () => {
  const open = (value: string | undefined) =>
    openApplicationDatabase(loadEnv({ SRC_DATABASE_FILE: value }), { busyTimeoutMs: 500 });
  const startError = (fn: () => unknown): ApplicationStartError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationStartError);
      return error as ApplicationStartError;
    }
    throw new Error('expected an ApplicationStartError');
  };

  it('refuses to start without the variable; there is no in-memory fallback', () => {
    expect(startError(() => open(undefined))).toMatchObject({
      code: 'DATABASE_CONFIG_MISSING',
      keys: ['SRC_DATABASE_FILE'],
    });
  });

  it.each([':memory:', 'file:app.db?mode=memory', 'a\u0001b.db'])('refuses %j as invalid', (value) => {
    expect(startError(() => open(value))).toMatchObject({ code: 'DATABASE_CONFIG_INVALID' });
  });

  it('refuses a path whose directory does not exist', () => {
    expect(startError(() => open(path.join(tempDir(), 'missing-dir', 'app.db')))).toMatchObject({
      code: 'DATABASE_CONFIG_INVALID',
    });
  });

  it('refuses a file that is not a database, without its content in the error', () => {
    const file = path.join(tempDir(), 'not-a-db.db');
    writeFileSync(file, 'cash 987.65 '.repeat(500));
    const error = startError(() => open(file));
    expect(error).toMatchObject({ code: 'DATABASE_UNAVAILABLE', persistenceCode: 'INTEGRITY_ERROR' });
    expect(error.message).not.toContain('987.65');
  });

  it('opens a valid path in WAL mode', () => {
    const db = open(path.join(tempDir(), 'ok.db'));
    try {
      expect(db.isOpen).toBe(true);
    } finally {
      db.close();
    }
  });
});
