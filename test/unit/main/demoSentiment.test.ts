// Kiroween A1 (DR-KW-1 H9): display-only DEMO sentiment in the demo mode, with the COMMITTED demo
// configuration, at the fixed replay reference clock 2026-11-06T16:00:00.000Z. Proves:
// - the four fixture observations are recorded as DEMO and are CURRENT (300 s old <= 900 s);
// - no DEMO observation value ever enters a RiskInput: the engine sees value null, status DEMO;
// - DEMO-UK -0.72 (below the -0.60 threshold) triggers nothing; Adjusted VaR stays null with the
//   legitimate status SENTIMENT_NOT_CURRENT; the OD-1 explanation stays first (H7);
// - no alert is raised, even with VaR alert thresholds configured for the ADJUSTED metric;
// - no REAL sentiment provider, poller, or aggregator is enabled (OD-1 stays open).
// Base VaR and the loss distribution are pinned byte for byte by the replay golden tests
// (test/unit/main/replayExport.test.ts).
// Validates: Requirements 9.7, 15.2, 15.8, 30.11, 17.10, 35.6
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGGREGATION_NOT_APPROVED_EXPLANATION } from '../../../src/app/index.js';
import { loadConfig } from '../../../src/config/index.js';
import {
  DEMO_PORTFOLIOS,
  DEMO_SENTIMENT_OBSERVED_AT,
  DEMO_SENTIMENT_PROVIDER,
  DEMO_SENTIMENT_VALUES,
  DemoSentimentFixture,
  REPLAY_CLOCK,
  startApplication,
} from '../../../src/main/index.js';
import type { RunningApplication } from '../../../src/main/index.js';
import { SqliteUnitOfWork } from '../../../src/persistence/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import type { RiskInput, RiskResult } from '../../../src/risk/index.js';
import { sentimentFreshness } from '../../../src/sentiment/index.js';
import { DashboardViewResponseSchema, FakeClock, sequentialIds } from '../../../src/shared/index.js';
import { captureLogger, withKey, writeConfig } from '../../helpers/config.js';
import { recordedTransport } from '../../helpers/ecb.js';
import { repoPath, tempDir } from '../../helpers/repo.js';

const DEMO_FILE = repoPath('config', 'demo', 'kiroween-2026.demo.jsonc');
const ARGS = ['--demo-fixtures', '--port', '0', '--allowed-origin', 'http://127.0.0.1'];
const FIXTURE: Readonly<Record<string, string>> = Object.fromEntries(
  DEMO_SENTIMENT_VALUES.map((entry) => [entry.ticker, entry.value]),
);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Started {
  readonly running: RunningApplication;
  readonly dbFile: string;
  readonly inputs: RiskInput[];
  readonly results: RiskResult[];
  readonly log: () => Record<string, unknown>[];
}

/** Starts the demo mode at the replay clock; every RiskInput and RiskResult is captured. */
async function startDemo(configFile = DEMO_FILE): Promise<Started> {
  const temp = tempDir('demo-sentiment');
  cleanups.push(temp.cleanup);
  const dbFile = path.join(temp.dir, 'demo.db');
  const inputs: RiskInput[] = [];
  const results: RiskResult[] = [];
  const lines: string[] = [];
  const running = await startApplication({
    argv: ARGS,
    env: { SRC_CONFIG_FILE: configFile, SRC_DATABASE_FILE: dbFile },
    clock: new FakeClock(REPLAY_CLOCK),
    ids: sequentialIds('id'),
    random: () => 0.5,
    sink: (line) => lines.push(line),
    compute: (input) => {
      inputs.push(structuredClone(input));
      const result = riskEngine.compute(input);
      results.push(result);
      return Promise.resolve(result);
    },
    fxTransport: recordedTransport().transport,
  });
  cleanups.push(() => running.stop());
  for (const definition of DEMO_PORTFOLIOS) {
    await running.app.components.scheduler.idle(definition.id);
  }
  return {
    running,
    dbFile,
    inputs,
    results,
    log: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const getJson = async (address: string, route: string): Promise<unknown> =>
  (await fetch(`${address}${route}`)).json();

describe('the DEMO sentiment fixture (H9)', () => {
  it('is the approved DEMO provider with the four approved observations, never polled', () => {
    const fixture = new DemoSentimentFixture();
    expect(fixture.name).toBe('demo-sentiment-fixture');
    expect(fixture.kind).toBe('DEMO');
    expect('fetchLatest' in fixture).toBe(false);
    expect(fixture.observations()).toEqual(
      [
        ['DEMO-A', '0.15'],
        ['DEMO-EU', '-0.35'],
        ['DEMO-UK', '-0.72'],
        ['DEMO-US', '0.42'],
      ].map(([ticker, value]) => ({
        provider: 'demo-sentiment-fixture',
        sourceKind: 'DEMO',
        ticker,
        value,
        observedAt: '2026-11-06T15:55:00.000Z',
        receivedAt: '2026-11-06T15:55:00.000Z',
      })),
    );
  });

  it('every observation is CURRENT at the fixed replay reference time (300 s old, limit 900 s)', () => {
    expect(REPLAY_CLOCK).toBe('2026-11-06T16:00:00.000Z');
    expect(Date.parse(REPLAY_CLOCK) - Date.parse(DEMO_SENTIMENT_OBSERVED_AT)).toBe(300_000);
    expect(sentimentFreshness(DEMO_SENTIMENT_OBSERVED_AT, REPLAY_CLOCK, 900)).toBe('CURRENT');
    // The limit is inclusive: exactly 900 s is CURRENT, one millisecond more is STALE.
    expect(sentimentFreshness('2026-11-06T15:45:00.000Z', REPLAY_CLOCK, 900)).toBe('CURRENT');
    expect(sentimentFreshness('2026-11-06T15:44:59.999Z', REPLAY_CLOCK, 900)).toBe('STALE');
  });
});

describe('demo mode with the committed configuration at the replay clock (A1 invariants)', () => {
  it('records the four observations as DEMO, CURRENT, with exact values (display)', async () => {
    const s = await startDemo();
    const recorded = s.log().filter((r) => r['msg'] === 'start.demo_sentiment');
    expect(recorded.map((r) => [r['ticker'], r['outcome'], r['kind']])).toEqual([
      ['DEMO-A', 'ACCEPTED', 'DEMO'],
      ['DEMO-EU', 'ACCEPTED', 'DEMO'],
      ['DEMO-UK', 'ACCEPTED', 'DEMO'],
      ['DEMO-US', 'ACCEPTED', 'DEMO'],
    ]);
    const state = s.running.app.components.sentiment;
    expect(state?.tickers()).toEqual(['DEMO-A', 'DEMO-EU', 'DEMO-UK', 'DEMO-US']);
    for (const [ticker, value] of Object.entries(FIXTURE)) {
      expect(state?.view(ticker)).toMatchObject({
        index: null,
        latest: { value, status: 'CURRENT', sourceKind: 'DEMO', provider: DEMO_SENTIMENT_PROVIDER },
      });
    }
  });

  it('DEMO values never enter a RiskInput; DEMO-UK -0.72 triggers nothing; Adjusted VaR is null', async () => {
    const s = await startDemo();
    expect(s.inputs.length).toBeGreaterThanOrEqual(2);
    for (const input of s.inputs) {
      expect(input.adjustmentConfigMissing).toEqual([]);
      expect(input.params.adjustment).toEqual({ threshold: '-0.60', multiplier: '1.15' });
      for (const position of input.positions) {
        const entry = input.sentiment.find((e) => e.ticker === position.ticker);
        // The state withholds DEMO values from the engine: value null, source kind DEMO.
        expect(entry).toMatchObject({ value: null, sourceKind: 'DEMO', source: DEMO_SENTIMENT_PROVIDER });
      }
      expect(JSON.stringify(input.sentiment)).not.toMatch(/-0\.72|0\.42|-0\.35|0\.15/);
    }
    for (const result of s.results) {
      expect(result.status).toBe('OK');
      expect(result.baseVaR).not.toBeNull();
      expect(result.sentimentAdjustedVaR).toBeNull();
      expect(result.triggeredAssets).toEqual([]);
      expect(result.adjustmentOutcome.status).toBe('SENTIMENT_NOT_CURRENT');
      expect(result.adjustmentOutcome.missingConfigKeys).toEqual([]);
      expect(result.adjustmentOutcome.ineligible.every((i) => i.sentimentStatus === 'DEMO')).toBe(true);
    }
    const multi = s.results.find((r) => r.portfolioId === 'demo-eur-usd-gbp');
    expect(multi?.adjustmentOutcome.ineligible).toEqual([
      { ticker: 'DEMO-EU', sentimentStatus: 'DEMO' },
      { ticker: 'DEMO-UK', sentimentStatus: 'DEMO' },
      { ticker: 'DEMO-US', sentimentStatus: 'DEMO' },
    ]);
  });

  it('the dashboard shows the DEMO observations, SENTIMENT_NOT_CURRENT, and the OD-1 explanation first', async () => {
    const s = await startDemo();
    const body = DashboardViewResponseSchema.parse(
      await getJson(s.running.address, '/dashboard/portfolios/demo-eur-usd-gbp'),
    );
    expect(body.view.assets.map((a) => [a.ticker, a.sentiment])).toEqual(
      ['DEMO-EU', 'DEMO-UK', 'DEMO-US'].map((ticker) => [
        ticker,
        {
          value: FIXTURE[ticker],
          status: 'CURRENT',
          sourceKind: 'DEMO',
          observedAt: DEMO_SENTIMENT_OBSERVED_AT,
          basis: 'LATEST_OBSERVATION',
        },
      ]),
    );
    expect(body.view.assets.every((a) => !a.adjustment.triggered)).toBe(true);
    expect(body.view.sentimentAdjustedVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'SENTIMENT_NOT_CURRENT',
    });
    expect(body.display.adjustedVaR).toBeNull();
    expect(body.view.varDifference).toBeNull();
    expect(body.adjustedVaRAvailability).toMatchObject({
      aggregation: 'NOT_APPROVED',
      reasonCode: 'AGGREGATION_NOT_APPROVED',
      openDecision: 'OD-1',
    });
    expect(body.view.adjustmentExplanation).toBe(
      `${AGGREGATION_NOT_APPROVED_EXPLANATION} Unavailable: sentiment is not current for DEMO-EU (DEMO), DEMO-UK (DEMO), DEMO-US (DEMO).`,
    );
  });

  it('no REAL sentiment provider, poller, or aggregator is enabled', async () => {
    const s = await startDemo();
    expect(s.running.app.poller).toBeUndefined();
    expect(s.running.app.status['sentimentPolling']?.available).toBe(false);
    const providers = JSON.stringify(await getJson(s.running.address, '/providers/status'));
    expect(providers).not.toMatch(/sentiment:/);
    const state = s.running.app.components.sentiment;
    for (const ticker of state?.tickers() ?? []) {
      const view = state?.view(ticker);
      expect(view?.index).toBeNull(); // no aggregator (OD-1)
      expect(view?.latest).toMatchObject({ sourceKind: 'DEMO', provider: DEMO_SENTIMENT_PROVIDER });
    }
  });

  it('no alert is raised, even with VaR alert thresholds configured for the ADJUSTED metric', async () => {
    // TEST thresholds (not approved values): every portfolio's Base VaR exceeds 0.01 % of NAV.
    const { logger } = captureLogger();
    let values = loadConfig({ srcConfigFile: DEMO_FILE, logger }).values;
    values = withKey(withKey(values, 'alerts.var.thresholdPct', '0.01'), 'alerts.resetPct', '0.01');
    expect(values['alerts']).toMatchObject({ var: { metric: 'ADJUSTED' } });
    const temp = tempDir('demo-sentiment-alerts');
    cleanups.push(temp.cleanup);
    const file = writeConfig(temp.dir, 'config.json', values);
    // Not vacuous: VaR alert evaluation is configured and available in this run.
    expect(loadConfig({ srcConfigFile: file, logger }).features.varAlerts).toMatchObject({ available: true });
    const s = await startDemo(file);
    expect(s.results.every((r) => r.sentimentAdjustedVaR === null)).toBe(true);
    await s.running.stop();
    const db = SqliteUnitOfWork.open(s.dbFile, { busyTimeoutMs: 500 });
    try {
      expect(db.snapshot().alerts).toEqual([]);
    } finally {
      db.close();
    }
  });
});
