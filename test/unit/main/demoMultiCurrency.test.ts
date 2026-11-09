// Kiroween decisions H2 to H8 in the demo mode of src/main/start.ts, against a temporary SQLite
// file, the DEMO market-data fixtures, and recorded ECB responses (no network):
// - the demo configuration refuses any non-demo start (H3, H5);
// - the seeded EUR/USD/GBP portfolio converts into EUR through ECB-derived inverse rates (H2, H6),
//   and through the DEMO fixture rates (one inverse, one direct) with fx.provider FIXTURE;
// - the EUR-only portfolio stays available when FX is unavailable or stale;
// - every result is DEMO_DATA and never alerts (R30.11); Adjusted VaR stays unavailable (H7);
// - no filing score is produced (H8).
// Settings are TEST values; fx.maxRateAgeSeconds in particular is not an approved value (OD-6).
// Validates: Requirements 30.3, 30.4, 30.8, 30.11, 30.14, 15.8, 25.4
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EcbTransport } from '../../../src/adapters/index.js';
import { DEMO_PROFILE } from '../../../src/config/index.js';
import { DEMO_PORTFOLIOS, startApplication, StartRefusedError } from '../../../src/main/index.js';
import type { RunningApplication } from '../../../src/main/index.js';
import { SqliteUnitOfWork } from '../../../src/persistence/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import { AGGREGATION_NOT_APPROVED_EXPLANATION } from '../../../src/app/index.js';
import {
  DashboardIndexResponseSchema,
  DashboardViewResponseSchema,
  FakeClock,
  brandDecimalString,
  sequentialIds,
} from '../../../src/shared/index.js';
import type { SentimentIndex } from '../../../src/shared/index.js';
import { completeTestConfig, withKey, writeConfig } from '../../helpers/config.js';
import { csvOk, recordedTransport, recordingTransport } from '../../helpers/ecb.js';
import { repoPath, tempDir } from '../../helpers/repo.js';

const ORIGIN = 'http://127.0.0.1:5173';
const DEMO_ARGS = ['--demo-fixtures', '--port', '0', '--allowed-origin', ORIGIN];
const FRIDAY_AFTER_PUBLICATION = '2026-11-06T16:00:00.000Z';
const MULTI = 'demo-eur-usd-gbp';
const EUR_ONLY = 'demo-eur-only';
/** TEST value only (H3: the demo threshold is not approved). */
const TEST_MAX_RATE_AGE = 86_400;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Complete TEST settings with the EUR base (H2) and a small lookback. */
function eurConfig(provider: 'ECB' | 'FIXTURE' = 'ECB'): Record<string, unknown> {
  let values = withKey(completeTestConfig(), 'fx', {
    baseCurrency: 'EUR',
    supportedCurrencies: ['EUR', 'GBP', 'USD'],
    maxRateAgeSeconds: TEST_MAX_RATE_AGE,
    provider,
  });
  values = withKey(withKey(values, 'var.lookbackReturns', 30), 'var.minObservations', 20);
  // A threshold every demo portfolio exceeds: an alert could only be suppressed by the DEMO rule.
  values = withKey(withKey(values, 'alerts.var.metric', 'BASE'), 'alerts.var.thresholdPct', '0.01');
  return withKey(values, 'alerts.resetPct', '0.01');
}

interface Started {
  readonly running: RunningApplication;
  readonly dbFile: string;
  readonly log: () => Record<string, unknown>[];
}

async function start(
  values: Record<string, unknown>,
  opts: { now?: string; transport?: EcbTransport } = {},
): Promise<Started> {
  const temp = tempDir('demo-fx');
  cleanups.push(temp.cleanup);
  const dbFile = path.join(temp.dir, 'demo.db');
  const lines: string[] = [];
  const running = await startApplication({
    argv: DEMO_ARGS,
    env: { SRC_CONFIG_FILE: writeConfig(temp.dir, 'config.json', values), SRC_DATABASE_FILE: dbFile },
    clock: new FakeClock(opts.now ?? FRIDAY_AFTER_PUBLICATION),
    ids: sequentialIds('id'),
    random: () => 0.5,
    sink: (line) => lines.push(line),
    compute: (input) => Promise.resolve(riskEngine.compute(input)),
    fxTransport: opts.transport ?? recordedTransport().transport,
  });
  cleanups.push(() => running.stop());
  for (const definition of DEMO_PORTFOLIOS) {
    await running.app.components.scheduler.idle(definition.id);
  }
  return { running, dbFile, log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** Starts with the COMMITTED demo configuration (approved demo values, lookback 250). */
async function startCommitted(
  now: string,
  transport: EcbTransport = recordedTransport().transport,
): Promise<Started> {
  const temp = tempDir('demo-committed');
  cleanups.push(temp.cleanup);
  const dbFile = path.join(temp.dir, 'demo.db');
  const lines: string[] = [];
  const running = await startApplication({
    argv: DEMO_ARGS,
    env: {
      SRC_CONFIG_FILE: repoPath('config', 'demo', 'kiroween-2026.demo.jsonc'),
      SRC_DATABASE_FILE: dbFile,
    },
    clock: new FakeClock(now),
    ids: sequentialIds('id'),
    random: () => 0.5,
    sink: (line) => lines.push(line),
    compute: (input) => Promise.resolve(riskEngine.compute(input)),
    fxTransport: transport,
  });
  cleanups.push(() => running.stop());
  for (const definition of DEMO_PORTFOLIOS) {
    await running.app.components.scheduler.idle(definition.id);
  }
  return { running, dbFile, log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/**
 * A SYNTHETIC response in the exact ECB format (not a recorded ECB response): the rows the ECB
 * would return for `endPeriod` on the morning of the given day, used for future closures that
 * cannot be recorded yet. Values are invented test values.
 */
function syntheticTransport(endPeriod: string, rows: readonly [string, string, string][]): EcbTransport {
  const body =
    [
      'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE',
      ...rows.map(
        ([currency, date, value]) => `EXR.D.${currency}.EUR.SP00.A,D,${currency},EUR,SP00,A,${date},${value}`,
      ),
    ].join('\r\n') + '\r\n';
  return recordingTransport((url) =>
    new URL(url).searchParams.get('endPeriod') === endPeriod
      ? csvOk(body)
      : { ok: false, failure: 'HTTP', status: 404 },
  ).transport;
}

const getJson = async (address: string, route: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${address}${route}`)).json()) as Record<string, unknown>;

type FxDto = Record<string, unknown> | null;
const positionsOf = async (address: string, id: string) =>
  (await getJson(address, `/portfolios/${id}/positions`))['positions'] as {
    ticker: string;
    valuationStatus: string;
    fxRate: FxDto;
    fxUnavailable: FxDto;
  }[];

describe('H3/H5: the demo configuration never starts outside the demo mode', () => {
  it('a demo profile without --demo-fixtures is refused before the database is opened', async () => {
    const temp = tempDir('demo-guard');
    cleanups.push(temp.cleanup);
    const dbFile = path.join(temp.dir, 'demo.db');
    const error = await startApplication({
      argv: ['--port', '0', '--allowed-origin', ORIGIN],
      env: {
        SRC_CONFIG_FILE: repoPath('config', 'demo', 'kiroween-2026.demo.jsonc'),
        SRC_DATABASE_FILE: dbFile,
      },
      sink: () => undefined,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StartRefusedError);
    expect(error).toMatchObject({ reason: 'DEMO_CONFIG_OUTSIDE_DEMO_MODE' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(dbFile)).toBe(false);
  });

  it('in demo mode the provisional keys and their status are logged', async () => {
    const values = withKey(eurConfig(), 'demo', {
      profile: DEMO_PROFILE,
      provisionalKeys: ['fx.maxRateAgeSeconds'],
    });
    const s = await start(values);
    const config = s.log().find((r) => r['msg'] === 'start.demo_config');
    expect(config).toMatchObject({
      level: 'warn',
      profile: DEMO_PROFILE,
      provisionalKeys: [{ key: 'fx.maxRateAgeSeconds', status: 'VALID' }],
    });
    expect(s.log().find((r) => r['msg'] === 'start.ready')).toMatchObject({
      demoProfile: DEMO_PROFILE,
      provisionalKeys: [{ key: 'fx.maxRateAgeSeconds', status: 'VALID' }],
      fxProvider: 'ECB',
    });
  });

  it('the committed demo configuration starts in demo mode and reports its five approved demo values', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    expect(s.log().find((r) => r['msg'] === 'start.demo_config')).toMatchObject({
      provisionalKeys: [
        { key: 'fx.maxRateAgeSeconds', status: 'VALID' },
        { key: 'marketData.maxStalenessDays', status: 'VALID' },
        { key: 'marketData.maxReturnGapDays', status: 'VALID' },
        { key: 'recalc.minValueChangePct', status: 'VALID' },
        { key: 'import.oversellPolicy', status: 'VALID' },
      ],
    });
    expect(
      s
        .log()
        .filter((r) => r['msg'] === 'start.demo_portfolio')
        .map((r) => r['reason']),
    ).toEqual(['SEEDED', 'SEEDED']);
  });

  it('fx.provider ECB with an invalid fx.ecb setting is refused (no DEMO rate substitution)', async () => {
    const temp = tempDir('demo-ecb-invalid');
    cleanups.push(temp.cleanup);
    const values = withKey(eurConfig(), 'fx.ecb.cacheMaxEntries', 0);
    const error = await startApplication({
      argv: DEMO_ARGS,
      env: {
        SRC_CONFIG_FILE: writeConfig(temp.dir, 'config.json', values),
        SRC_DATABASE_FILE: path.join(temp.dir, 'demo.db'),
      },
      sink: () => undefined,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: 'FX_PROVIDER_CONFIG_INVALID' });
  });
});

describe('H6 with the ECB adapter (H2): seeded EUR/USD/GBP portfolio', () => {
  it('seeds both portfolios through the ordinary use cases', async () => {
    const s = await start(eurConfig());
    expect(s.log().filter((r) => r['msg'] === 'start.demo_portfolio')).toEqual([
      expect.objectContaining({ portfolioId: MULTI, seeded: true, reason: 'SEEDED', accepted: 3 }),
      expect.objectContaining({ portfolioId: EUR_ONLY, seeded: true, reason: 'SEEDED', accepted: 2 }),
    ]);
    expect(s.log().find((r) => r['msg'] === 'start.fx_provider')).toMatchObject({
      setting: 'ECB',
      provider: 'ECB-EXR',
      kind: 'REAL',
    });
  });

  it('USD and GBP are converted with ECB-derived inverse rates, attributed as derived', async () => {
    const s = await start(eurConfig());
    const positions = await positionsOf(s.running.address, MULTI);
    const byTicker = Object.fromEntries(positions.map((p) => [p.ticker, p]));
    expect(byTicker['DEMO-EU']?.fxRate).toMatchObject({ pair: 'EUREUR', sourceKind: 'IDENTITY', rate: '1' });
    expect(byTicker['DEMO-EU']?.fxRate).not.toHaveProperty('attribution');
    for (const [ticker, currency, published] of [
      ['DEMO-US', 'USD', 'EURUSD'],
      ['DEMO-UK', 'GBP', 'EURGBP'],
    ] as const) {
      expect(byTicker[ticker]?.valuationStatus).toBe('VALUED');
      expect(byTicker[ticker]?.fxRate).toMatchObject({
        pair: `${currency}EUR`,
        source: 'ECB-EXR',
        sourceKind: 'REAL',
        status: 'CURRENT',
        observedAt: '2026-11-06T15:00:00.000Z',
        observedAtBasis: 'PUBLICATION_CONVENTION',
        conventionId: 'ECB-PUB-1600-FRANKFURT-v1',
        attribution: {
          statement: 'Source: ECB statistics.',
          derivation: 'DERIVED_INVERSE',
          publishedPair: published,
        },
      });
    }
  });

  it('Base VaR is calculated, labelled DEMO_DATA, and never alerts; Adjusted VaR stays unavailable', async () => {
    const s = await start(eurConfig());
    for (const id of [MULTI, EUR_ONLY]) {
      const risk = await getJson(s.running.address, `/portfolios/${id}/risk`);
      expect(risk).toMatchObject({
        status: 'OK',
        currency: 'EUR',
        baseVaR: { validity: 'CURRENT' },
        adjustedVaR: { validity: 'UNAVAILABLE', value: null },
      });
      expect(risk['flags']).toContain('DEMO_DATA');
      expect((risk['adjustedVaR'] as { status: string }).status).not.toBe('APPLIED');
      expect(risk).not.toHaveProperty('filing'); // H8: no filing score anywhere in the risk contract
    }
    await s.running.stop();
    const db = SqliteUnitOfWork.open(s.dbFile, { busyTimeoutMs: 500 });
    try {
      const snapshot = db.snapshot();
      expect(snapshot.alerts).toEqual([]);
      const skips = snapshot.audit.filter((a) => a.type === 'ALERT_SKIPPED');
      expect(skips.length).toBeGreaterThanOrEqual(2);
      expect(skips.every((a) => (a.details as { reason?: string }).reason === 'DEMO_DATA')).toBe(true);
      // The ECB rates used were recorded with their provenance (10.3), as derived X -> EUR pairs.
      expect(
        snapshot.fxRates.map((r) => [r.pair, r.source, r.sourceKind, r.observedAtBasis, r.conventionId]),
      ).toEqual(
        expect.arrayContaining([
          ['GBPEUR', 'ECB-EXR', 'REAL', 'PUBLICATION_CONVENTION', 'ECB-PUB-1600-FRANKFURT-v1'],
          ['USDEUR', 'ECB-EXR', 'REAL', 'PUBLICATION_CONVENTION', 'ECB-PUB-1600-FRANKFURT-v1'],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('H7: a DEMO sentiment observation never produces an Adjusted VaR', async () => {
    const s = await start(eurConfig());
    const sentiment = s.running.app.components.sentiment;
    expect(sentiment).toBeDefined();
    sentiment?.record({
      provider: 'demo-sentiment',
      sourceKind: 'DEMO',
      ticker: 'DEMO-US',
      value: brandDecimalString('-0.9') as SentimentIndex,
      observedAt: FRIDAY_AFTER_PUBLICATION,
      receivedAt: FRIDAY_AFTER_PUBLICATION,
    });
    s.running.app.components.scheduler.requestRecalculation(MULTI, 'MANUAL');
    await s.running.app.components.scheduler.idle(MULTI);
    const risk = await getJson(s.running.address, `/portfolios/${MULTI}/risk`);
    expect(risk).toMatchObject({
      adjustedVaR: { validity: 'UNAVAILABLE', value: null, status: 'SENTIMENT_NOT_CURRENT' },
    });
    expect((risk['baseVaR'] as { value: unknown }).value).not.toBeNull();
  });

  it('re-seeding an existing database leaves the portfolios untouched', async () => {
    const temp = tempDir('demo-reseed');
    cleanups.push(temp.cleanup);
    const dbFile = path.join(temp.dir, 'demo.db');
    const configFile = writeConfig(temp.dir, 'config.json', eurConfig());
    const run = async () => {
      const lines: string[] = [];
      const running = await startApplication({
        argv: DEMO_ARGS,
        env: { SRC_CONFIG_FILE: configFile, SRC_DATABASE_FILE: dbFile },
        clock: new FakeClock(FRIDAY_AFTER_PUBLICATION),
        sink: (line) => lines.push(line),
        compute: (input) => Promise.resolve(riskEngine.compute(input)),
        fxTransport: recordedTransport().transport,
      });
      for (const d of DEMO_PORTFOLIOS) await running.app.components.scheduler.idle(d.id);
      await running.stop();
      return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    };
    await run();
    const second = await run();
    expect(second.filter((r) => r['msg'] === 'start.demo_portfolio').map((r) => r['reason'])).toEqual([
      'ALREADY_PRESENT',
      'ALREADY_PRESENT',
    ]);
    const db = SqliteUnitOfWork.open(dbFile, { busyTimeoutMs: 500 });
    try {
      expect(db.snapshot().transactions).toHaveLength(5);
    } finally {
      db.close();
    }
  });
});

describe('EUR-only fallback: FX unavailable or stale never hides the EUR portfolio', () => {
  it('ECB unavailable (HTTP 504): the multi-currency portfolio is not calculated, the EUR one is', async () => {
    const t = recordingTransport(() => ({ ok: false, failure: 'HTTP', status: 504 }));
    const s = await start(eurConfig(), { transport: t.transport });
    const positions = await positionsOf(s.running.address, MULTI);
    expect(positions.find((p) => p.ticker === 'DEMO-US')).toMatchObject({
      valuationStatus: 'FX_UNAVAILABLE',
      fxRate: null,
      fxUnavailable: { code: 'FX_UNAVAILABLE', currency: 'USD' },
    });
    const multi = await getJson(s.running.address, `/portfolios/${MULTI}/risk`);
    expect(multi).toMatchObject({ baseVaR: { validity: 'UNAVAILABLE', value: null } });
    expect(multi['status']).not.toBe('OK');
    const eurOnly = await getJson(s.running.address, `/portfolios/${EUR_ONLY}/risk`);
    expect(eurOnly).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
    expect(eurOnly['flags']).toContain('DEMO_DATA');
  });

  it('weekend: Sunday 16:00Z with a 86,400 s TEST threshold makes the Friday ECB rate stale (FX_STALE)', async () => {
    const s = await start(eurConfig(), { now: '2026-11-08T16:00:00.000Z' });
    const positions = await positionsOf(s.running.address, MULTI);
    expect(positions.find((p) => p.ticker === 'DEMO-UK')).toMatchObject({
      valuationStatus: 'FX_STALE',
      fxRate: null,
      fxUnavailable: { code: 'FX_STALE', currency: 'GBP' },
    });
    expect(await getJson(s.running.address, `/portfolios/${MULTI}/risk`)).toMatchObject({
      baseVaR: { validity: 'UNAVAILABLE', value: null },
    });
    expect(await getJson(s.running.address, `/portfolios/${EUR_ONLY}/risk`)).toMatchObject({
      status: 'OK',
      baseVaR: { validity: 'CURRENT' },
    });
  });
});

describe('fx.provider FIXTURE with the EUR base: DEMO rates on both FxService paths', () => {
  it('USD uses the inverse DEMO quote and GBP the direct one; no ECB attribution; no request', async () => {
    const t = recordedTransport();
    const s = await start(eurConfig('FIXTURE'), { transport: t.transport });
    expect(t.calls).toHaveLength(0);
    const positions = await positionsOf(s.running.address, MULTI);
    const usd = positions.find((p) => p.ticker === 'DEMO-US')?.fxRate;
    const gbp = positions.find((p) => p.ticker === 'DEMO-UK')?.fxRate;
    // 1 / 1.1 = 0.90909... (40 significant digits, ROUND_HALF_UP); 1.17 is used as published.
    expect(usd).toMatchObject({
      pair: 'USDEUR',
      rate: '0.9090909090909090909090909090909090909091',
      sourceKind: 'DEMO',
      status: 'DEMO',
    });
    expect(gbp).toMatchObject({ pair: 'GBPEUR', rate: '1.17', sourceKind: 'DEMO', status: 'DEMO' });
    expect(usd).not.toHaveProperty('attribution');
    expect(gbp).not.toHaveProperty('attribution');
    const risk = await getJson(s.running.address, `/portfolios/${MULTI}/risk`);
    expect(risk).toMatchObject({ status: 'OK' });
    expect(risk['flags']).toContain('DEMO_DATA');
  });
});

describe('committed demo configuration (DR-KW-1 H3 values): valuation, Base VaR, and freshness', () => {
  const multiRisk = async (s: Started) => getJson(s.running.address, `/portfolios/${MULTI}/risk`);
  const eurRisk = async (s: Started) => getJson(s.running.address, `/portfolios/${EUR_ONLY}/risk`);

  it('Friday after publication: EUR-base valuation and Base VaR for both seeded portfolios, DEMO_DATA, no alert', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    const positions = await positionsOf(s.running.address, MULTI);
    expect(positions.map((p) => [p.ticker, p.valuationStatus])).toEqual([
      ['DEMO-EU', 'VALUED'],
      ['DEMO-UK', 'VALUED'],
      ['DEMO-US', 'VALUED'],
    ]);
    for (const risk of [await multiRisk(s), await eurRisk(s)]) {
      expect(risk).toMatchObject({
        status: 'OK',
        currency: 'EUR',
        lookbackReturns: 250,
        completeness: 'COMPLETE',
        baseVaR: { validity: 'CURRENT' },
        // Demo sentiment settings are empty: Adjusted VaR is unavailable, never a copy of Base VaR.
        adjustedVaR: { validity: 'UNAVAILABLE', value: null, status: 'ADJUSTMENT_CONFIG_MISSING' },
      });
      expect(risk['flags']).toContain('DEMO_DATA');
    }
    await s.running.stop();
    const db = SqliteUnitOfWork.open(s.dbFile, { busyTimeoutMs: 500 });
    try {
      // Alert settings are not configured in the demo file, and DEMO results never alert anyway.
      expect(db.snapshot().alerts).toEqual([]);
    } finally {
      db.close();
    }
  });

  // Monday's query (endPeriod 2026-11-09) was not recorded; its rows are the recorded Thursday and
  // Friday values in a synthetic response, as the ECB answers before Monday's publication.
  const mondayMorning = syntheticTransport('2026-11-09', [
    ['GBP', '2026-11-05', '0.83393'],
    ['GBP', '2026-11-06', '0.83415'],
    ['USD', '2026-11-05', '1.1224'],
    ['USD', '2026-11-06', '1.1165'],
  ]);
  it.each([
    ['Saturday', '2026-11-07T12:00:00.000Z', undefined],
    ['Sunday evening', '2026-11-08T23:00:00.000Z', undefined],
    ['Monday before publication', '2026-11-09T14:59:59.999Z', mondayMorning],
  ])('weekend: %s still uses the Friday rate as CURRENT (age < 96 h)', async (_name, now, transport) => {
    const s = await startCommitted(now, transport);
    const positions = await positionsOf(s.running.address, MULTI);
    expect(positions.find((p) => p.ticker === 'DEMO-US')).toMatchObject({
      valuationStatus: 'VALUED',
      fxRate: { observedAt: '2026-11-06T15:00:00.000Z', status: 'CURRENT' },
    });
    expect(await multiRisk(s)).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
  });

  it('Christmas 2026 (synthetic ECB-format rows): Monday 28 December before 15:00Z uses 24 December as CURRENT', async () => {
    const transport = syntheticTransport('2026-12-28', [
      ['GBP', '2026-12-23', '0.85'],
      ['GBP', '2026-12-24', '0.851'],
      ['USD', '2026-12-23', '1.12'],
      ['USD', '2026-12-24', '1.121'],
    ]);
    const s = await startCommitted('2026-12-28T14:59:59.999Z', transport);
    const positions = await positionsOf(s.running.address, MULTI);
    expect(positions.find((p) => p.ticker === 'DEMO-UK')).toMatchObject({
      valuationStatus: 'VALUED',
      fxRate: { observedAt: '2026-12-24T15:00:00.000Z', status: 'CURRENT' },
    });
  });

  it('New Year 2027 (synthetic ECB-format rows): Monday 4 January before 15:00Z uses 31 December as CURRENT', async () => {
    const transport = syntheticTransport('2027-01-04', [
      ['GBP', '2026-12-30', '0.85'],
      ['GBP', '2026-12-31', '0.852'],
      ['USD', '2026-12-30', '1.12'],
      ['USD', '2026-12-31', '1.122'],
    ]);
    const s = await startCommitted('2027-01-04T14:59:59.999Z', transport);
    expect(await multiRisk(s)).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
  });

  it('a rate exactly four days old is CURRENT; one millisecond older is FX_STALE (strict comparison kept)', async () => {
    const rows: [string, string, string][] = [
      ['GBP', '2026-12-23', '0.85'],
      ['GBP', '2026-12-24', '0.851'],
      ['USD', '2026-12-23', '1.12'],
      ['USD', '2026-12-24', '1.121'],
    ];
    // 24 December 15:00Z + 345,600 s = 28 December 15:00Z; the 28 December row is not published here.
    const atLimit = await startCommitted('2026-12-28T15:00:00.000Z', syntheticTransport('2026-12-28', rows));
    expect(
      (await positionsOf(atLimit.running.address, MULTI)).find((p) => p.ticker === 'DEMO-US'),
    ).toMatchObject({
      valuationStatus: 'VALUED',
    });
    const beyond = await startCommitted('2026-12-28T15:00:00.001Z', syntheticTransport('2026-12-28', rows));
    expect(
      (await positionsOf(beyond.running.address, MULTI)).find((p) => p.ticker === 'DEMO-US'),
    ).toMatchObject({
      valuationStatus: 'FX_STALE',
      fxRate: null,
    });
  });

  it('known limitation, Easter (recorded): Tuesday 7 April 2026 before 14:00Z the 2 April rate is stale (120 h > 96 h); EUR-only stays OK', async () => {
    const s = await startCommitted('2026-04-07T13:59:59.999Z');
    expect((await positionsOf(s.running.address, MULTI)).find((p) => p.ticker === 'DEMO-US')).toMatchObject({
      valuationStatus: 'FX_STALE',
      fxUnavailable: { code: 'FX_STALE', currency: 'USD' },
    });
    expect(await multiRisk(s)).toMatchObject({ baseVaR: { validity: 'UNAVAILABLE', value: null } });
    expect(await eurRisk(s)).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
  });

  it('ECB data missing for the date (HTTP 404): the multi-currency portfolio is unavailable, EUR-only stays OK', async () => {
    const s = await startCommitted('2026-11-06T16:00:00.000Z', syntheticTransport('1999-01-01', []));
    expect((await positionsOf(s.running.address, MULTI)).find((p) => p.ticker === 'DEMO-UK')).toMatchObject({
      valuationStatus: 'FX_UNAVAILABLE',
    });
    expect(await eurRisk(s)).toMatchObject({ status: 'OK' });
  });
});

describe('read-only dashboard routes (17.1 to 17.3) on the committed demo configuration', () => {
  const VIEW = (id: string) => `/dashboard/portfolios/${id}`;

  it('GET /dashboard lists both seeded portfolios in DEMO_FIXTURES mode', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    const index = DashboardIndexResponseSchema.parse(await getJson(s.running.address, '/dashboard'));
    expect(index).toMatchObject({
      runMode: 'DEMO_FIXTURES',
      portfolios: [
        { id: MULTI, baseCurrency: 'EUR' },
        { id: EUR_ONLY, baseCurrency: 'EUR' },
      ],
    });
  });

  it('the multi-currency view: DEMO data mode, ECB attribution per currency, currency exposure, and FR-14 display', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    const body = DashboardViewResponseSchema.parse(await getJson(s.running.address, VIEW(MULTI)));
    expect(body).toMatchObject({ runMode: 'DEMO_FIXTURES', dataMode: 'DEMO', portfolioId: MULTI });
    expect(body.view.baseVaR).toMatchObject({ validity: 'CURRENT' });
    expect(body.view.calculation.flags).toContain('DEMO_DATA');
    expect(body.fx.map((f) => [f.currency, f.status])).toEqual([
      ['EUR', 'IDENTITY'],
      ['GBP', 'CURRENT'],
      ['USD', 'CURRENT'],
    ]);
    // OD-20: the stored published observation, read back from fx_rates, beside the derived rate.
    expect(body.fx.find((f) => f.currency === 'USD')?.rate?.quote).toEqual({
      pair: 'EURUSD',
      rate: '1.1165',
      referenceDate: '2026-11-06',
      method: 'DECIMAL_INVERSE',
      precision: 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP',
    });
    expect(body.fx.find((f) => f.currency === 'USD')?.rate?.rate).toBe(
      '0.8956560680698611733094491715181370353784',
    );
    expect(body.fx.find((f) => f.currency === 'USD')?.rate?.attribution).toMatchObject({
      derivation: 'DERIVED_INVERSE',
      publishedPair: 'EURUSD',
      referenceDate: '2026-11-06',
      method: 'DECIMAL_INVERSE',
      precision: { significantDigits: 40, rounding: 'ROUND_HALF_UP' },
    });
    expect(body.currencyExposure.map((c) => [c.currency, c.status])).toEqual([
      ['EUR', 'OK'],
      ['GBP', 'OK'],
      ['USD', 'OK'],
    ]);
    // Every money display text has exactly the base currency's two minor units.
    expect(body.display).toMatchObject({ currency: 'EUR', minorUnits: 2 });
    for (const text of [
      body.display.exposure.nav,
      body.display.exposure.cash,
      body.display.baseVaR,
      ...body.display.currencyExposure.map((c) => c.marketValueBase),
    ]) {
      expect(text).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(body.display.exposure.cash).toBe('1000.00');
    expect(body.display.adjustedVaR).toBeNull();
  });

  it('H7: Adjusted VaR unavailability names OD-1 explicitly and is distinguishable from Base VaR', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    const body = DashboardViewResponseSchema.parse(await getJson(s.running.address, VIEW(MULTI)));
    expect(body.adjustedVaRAvailability).toEqual({
      aggregation: 'NOT_APPROVED',
      reasonCode: 'AGGREGATION_NOT_APPROVED',
      openDecision: 'OD-1',
      explanation: body.view.adjustmentExplanation,
    });
    expect(body.view.adjustmentExplanation.startsWith(AGGREGATION_NOT_APPROVED_EXPLANATION)).toBe(true);
    expect(body.view.sentimentAdjustedVaR).toMatchObject({ validity: 'UNAVAILABLE', value: null });
    expect(body.view.baseVaR.value).not.toBeNull();
    expect(body.filing.status).toBe('NOT_CONFIGURED');
    expect(body.view.assets.every((a) => a.filing.score === null)).toBe(true);
  });

  it('EUR-only fallback when the ECB is unavailable: currency exposure and FX show UNAVAILABLE, never zero', async () => {
    const t = recordingTransport(() => ({ ok: false, failure: 'HTTP', status: 504 }));
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION, t.transport);
    const multi = DashboardViewResponseSchema.parse(await getJson(s.running.address, VIEW(MULTI)));
    expect(multi.fx.find((f) => f.currency === 'USD')).toMatchObject({ status: 'UNAVAILABLE', rate: null });
    expect(multi.currencyExposure.find((c) => c.currency === 'USD')).toMatchObject({
      status: 'UNAVAILABLE',
      marketValueBase: null,
    });
    expect(multi.view.baseVaR).toMatchObject({ validity: 'UNAVAILABLE', value: null });
    expect(multi.display.baseVaR).toBeNull();
    expect(multi.display.exposure.nav).toBeNull();
    const eur = DashboardViewResponseSchema.parse(await getJson(s.running.address, VIEW(EUR_ONLY)));
    expect(eur.view.baseVaR).toMatchObject({ validity: 'CURRENT' });
    expect(eur.fx.map((f) => f.status)).toEqual(['IDENTITY']);
  });

  it('write-route isolation: the dashboard paths accept GET only; unknown portfolios are 404', async () => {
    const s = await startCommitted(FRIDAY_AFTER_PUBLICATION);
    for (const route of ['/dashboard', VIEW(MULTI)]) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        // Without an allowed Origin the request guard refuses first (Gateway rule 9) ...
        const refused = await fetch(`${s.running.address}${route}`, { method });
        expect(refused.status, `${method} ${route} without Origin`).toBe(403);
        // ... and with one, the dashboard still has no write route.
        const response = await fetch(`${s.running.address}${route}`, { method, headers: { origin: ORIGIN } });
        expect(response.status, `${method} ${route}`).toBe(404);
      }
    }
    expect((await fetch(`${s.running.address}${VIEW('no-such-portfolio')}`)).status).toBe(404);
    // A GET changes nothing: the ledger has exactly the five seeded transactions.
    await getJson(s.running.address, VIEW(MULTI));
    await s.running.stop();
    const db = SqliteUnitOfWork.open(s.dbFile, { busyTimeoutMs: 500 });
    try {
      expect(db.snapshot().transactions).toHaveLength(5);
    } finally {
      db.close();
    }
  });
});
