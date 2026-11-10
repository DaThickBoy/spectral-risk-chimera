// OD-21 (approved 2026-11-09): the deterministic static-replay exporter. It records the real
// backend in demo mode with deterministic fixtures and the fixed reference clock, never calls a
// live provider, writes exactly the format the dashboard replay reader accepts, refuses partial
// output, and produces identical files for identical inputs.
// Validates: Requirements 17.10, 30.14, 35.1, 25.4
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGGREGATION_NOT_APPROVED_EXPLANATION } from '../../../src/app/index.js';
import {
  DEMO_PORTFOLIOS,
  DEMO_SENTIMENT_OBSERVED_AT,
  DEMO_SENTIMENT_VALUES,
  REPLAY_CLOCK,
  REPLAY_ECB_RESPONSE,
  ReplayExportError,
  exportDashboardReplay,
  startApplication,
} from '../../../src/main/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import {
  DashboardReplayManifestSchema,
  DashboardViewResponseSchema,
  FakeClock,
  sequentialIds,
} from '../../../src/shared/index.js';
import { createReplaySource } from '../../../src/web/data/source.js';
import { csvOk, recorded } from '../../helpers/ecb.js';
import { repoPath, tempDir } from '../../helpers/repo.js';

const ECB_DIR = repoPath('test', 'fixtures', 'fx', 'ecb');

async function exportTo(): Promise<{ dir: string; files: Record<string, Buffer> }> {
  const temp = tempDir('replay');
  const dir = path.join(temp.dir, 'replay');
  await exportDashboardReplay({ ecbFixturesDir: ECB_DIR, outDir: dir });
  const files = Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name))]),
  );
  return { dir, files };
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('replay exporter', () => {
  it('writes the manifest, one recorded view per demo portfolio, and the recorded ECB response', async () => {
    const { files } = await exportTo();
    expect(Object.keys(files).sort()).toEqual(
      [
        'demo-eur-only.json',
        'demo-eur-usd-gbp.json',
        'ecb-exr-gbp-usd-2026-11-06.csv',
        'manifest.json',
      ].sort(),
    );
    const manifest = DashboardReplayManifestSchema.parse(
      JSON.parse(files['manifest.json']?.toString('utf8') ?? ''),
    );
    expect(manifest).toMatchObject({
      recordedAt: REPLAY_CLOCK,
      dataMode: 'DEMO',
      live: false,
      reference: { clock: REPLAY_CLOCK, marketDataAsOf: '2026-11-06', fxReferenceDate: '2026-11-06' },
      source: {
        runMode: 'DEMO_FIXTURES',
        configProfile: 'KIROWEEN_2026_DEMO',
        marketData: 'DEMO_FIXTURES',
        fx: {
          provider: 'ECB-EXR',
          recordedResponse: 'ecb-exr-gbp-usd-2026-11-06.csv',
          sha256: REPLAY_ECB_RESPONSE.sha256,
        },
      },
    });
    expect(manifest.note).toMatch(/Recorded DEMO replay/);
    expect(manifest.index.portfolios.map((p) => p.id)).toEqual(DEMO_PORTFOLIOS.map((p) => p.id));
    // Every file hash in the manifest matches the bytes written.
    for (const entry of manifest.portfolios) {
      expect(sha(files[entry.file] as Buffer), entry.file).toBe(entry.sha256);
      expect(entry.freshness).toEqual({
        summary: 'CURRENT',
        asOfDate: '2026-11-06',
        calculatedAt: REPLAY_CLOCK,
      });
    }
    // The ECB response is copied unmodified (Source: ECB statistics.).
    expect(
      files['ecb-exr-gbp-usd-2026-11-06.csv']?.equals(Buffer.from(recorded(REPLAY_ECB_RESPONSE.file))),
    ).toBe(true);
  });

  // Baseline recorded on 2026-11-09 from commit 10e172b (tree of main 2a834618) BEFORE any
  // dashboard change, identical to the replay deployed on GitHub Pages (published manifest.json
  // SHA-256 c02b939f...). Kept so the A2 change below stays provably additive.
  const PRE_A2_VIEWS: Readonly<Record<string, { sha256: string; bytes: number }>> = {
    'demo-eur-only.json': {
      sha256: '686961ba090ee2364162b815c3cbc9b77e472a7190edde00f1420915d0f2c5cb',
      bytes: 4129,
    },
    'demo-eur-usd-gbp.json': {
      sha256: 'ce733530736427e391381aae0e06d83b5576deb0c09e6a6a4ebfb9e030c87677',
      bytes: 7198,
    },
  };

  // The reviewed A2 replay (2026-11-10, dashboard schema version 1 at the time): the views with
  // `lossDistribution` and without the A1 DEMO sentiment. Manifest 2fb5bf46..., 1934 bytes.
  const PRE_A1_VIEWS: Readonly<Record<string, { sha256: string; bytes: number }>> = {
    'demo-eur-only.json': {
      sha256: '787044180689b6bd399d030850c0d3aef3c4edc2ab7f78e9db768a184f2a6fdf',
      bytes: 8486,
    },
    'demo-eur-usd-gbp.json': {
      sha256: 'a4dbccfeafef247630e121a4c6237a2c0c8a5087ef56bcd3b4bba03c7eced9e1',
      bytes: 11567,
    },
  };

  /** The demo sentiment settings that were missing before H9 (they are now set). */
  const PRE_A1_MISSING = [
    'sentiment.maxAgeSeconds',
    'sentiment.maxFutureSkewSeconds',
    'sentiment.windowSeconds',
  ];
  const PRE_A1_EXPLANATION = `${AGGREGATION_NOT_APPROVED_EXPLANATION} Unavailable: adjustment settings are missing (${PRE_A1_MISSING.join(', ')}).`;

  type Body = Record<string, unknown> & {
    schemaVersion: number;
    view: Record<string, unknown> & { assets: Record<string, unknown>[] };
    adjustedVaRAvailability: Record<string, unknown>;
  };

  /**
   * Restores exactly the fields that A1 (and the version bump) changed, to their reviewed pre-A1
   * values; every other byte is left as exported. Key order is kept (assignment to existing keys).
   */
  function asPreA1(body: Body): Body {
    body.schemaVersion = 1;
    for (const asset of body.view.assets) {
      asset['sentiment'] = {
        value: null,
        status: 'UNAVAILABLE',
        sourceKind: null,
        observedAt: null,
        basis: 'NONE',
      };
    }
    body.view['sentimentAdjustedVaR'] = {
      validity: 'UNAVAILABLE',
      value: null,
      status: 'ADJUSTMENT_CONFIG_MISSING',
      reason: { missingConfigKeys: PRE_A1_MISSING, ineligibleTickers: [], code: 'ADJUSTMENT_CONFIG_MISSING' },
      lastValid: null,
    };
    body.view['adjustmentExplanation'] = PRE_A1_EXPLANATION;
    body.adjustedVaRAvailability['explanation'] = PRE_A1_EXPLANATION;
    return body;
  }
  const parseBody = (bytes: Buffer): Body => JSON.parse(bytes.toString('utf8')) as Body;
  const digest = (body: unknown) => {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    return { sha256: sha(bytes), bytes: bytes.length };
  };

  it('golden: the export reproduces the reviewed replay byte for byte', async () => {
    // A mismatch means the recorded public demo would change. Update these values only in a
    // reviewed change that intends to alter the replay (for example an approved new field), never
    // to make this test pass.
    // Updated 2026-11-10 for Kiroween decision A1 (DR-KW-1 H9, approved) and dashboard schema
    // version 2: the views change only in the A1 fields and the version (proved by the next
    // test). Previous (A2) values: eur-only 78704418... 8486 B, eur-usd-gbp a4dbccfe... 11567 B,
    // manifest 2fb5bf46... 1934 B. manifest.json changes only through the two view hashes and its
    // schemaVersion. The ECB response is unchanged.
    const GOLDEN: Readonly<Record<string, { sha256: string; bytes: number }>> = {
      'demo-eur-only.json': {
        sha256: 'bf2ad5f650900163f07d9a5f805a77cf378c766ed4ea306122250d3f2ce30214',
        bytes: 8445,
      },
      'demo-eur-usd-gbp.json': {
        sha256: '630caac6d07f3a698b8f3d7cd94a4d87f5c54e49cb3f1ba84317f46a86ecb7bd',
        bytes: 11644,
      },
      'ecb-exr-gbp-usd-2026-11-06.csv': {
        sha256: 'be7147dd92819e669c69b7b485e2c8d3e826d82ff6bd3a1f946eb52489e5f30f',
        bytes: 306,
      },
      'manifest.json': {
        sha256: 'd24767992ccee5bf184d725bf0bc56656a60bc359dd4e304638003860c808829',
        bytes: 1934,
      },
    };
    const { files } = await exportTo();
    expect(Object.keys(files).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [name, expected] of Object.entries(GOLDEN)) {
      const bytes = files[name] as Buffer;
      expect({ sha256: sha(bytes), bytes: bytes.length }, name).toEqual(expected);
    }
  });

  it('A1 changes only the sentiment display and the Adjusted VaR reason: restoring them gives the A2 replay', async () => {
    const { files } = await exportTo();
    for (const [name, expected] of Object.entries(PRE_A1_VIEWS)) {
      expect(digest(asPreA1(parseBody(files[name] as Buffer))), name).toEqual(expected);
    }
  });

  it('A2 is additive: without A1 and lossDistribution each view is the pre-A2 baseline byte for byte', async () => {
    const { files } = await exportTo();
    for (const [name, expected] of Object.entries(PRE_A2_VIEWS)) {
      const body = asPreA1(parseBody(files[name] as Buffer));
      expect(body['lossDistribution'], name).toMatchObject({ status: 'AVAILABLE', bucketCount: 20 });
      delete body['lossDistribution'];
      expect(digest(body), name).toEqual(expected);
    }
  });

  it('A1: Base VaR, its raw quantile, and the loss distribution are those of the pre-A1 replay', async () => {
    const { files } = await exportTo();
    // Pinned from the reviewed A2 replay (78704418..., a4dbccfe...).
    const RAW: Readonly<Record<string, string>> = {
      'demo-eur-only.json': '140.1806869978253353800812193977189520388',
      'demo-eur-usd-gbp.json': '124.095376636618777169053781414066570861',
    };
    for (const [name, raw] of Object.entries(RAW)) {
      const view = DashboardViewResponseSchema.parse(JSON.parse((files[name] as Buffer).toString('utf8')));
      expect(view.view.baseVaR).toMatchObject({ validity: 'CURRENT', value: { rawQuantile: raw } });
      expect(
        view.lossDistribution.status === 'AVAILABLE' && view.lossDistribution.varMarker.rawQuantile,
      ).toBe(raw);
    }
  });

  it('A1: the public replay holds only the deterministic DEMO fixture observations, CURRENT, and no Adjusted VaR', async () => {
    const { files } = await exportTo();
    const manifest: unknown = JSON.parse((files['manifest.json'] as Buffer).toString('utf8'));
    expect(manifest).toMatchObject({ dataMode: 'DEMO', live: false, recordedAt: '2026-11-06T16:00:00.000Z' });
    const fixture = new Map(DEMO_SENTIMENT_VALUES.map((entry) => [entry.ticker, entry.value]));
    for (const name of Object.keys(PRE_A1_VIEWS)) {
      const view = DashboardViewResponseSchema.parse(JSON.parse((files[name] as Buffer).toString('utf8')));
      for (const asset of view.view.assets) {
        expect(asset.sentiment, `${name} ${asset.ticker}`).toEqual({
          value: fixture.get(asset.ticker),
          status: 'CURRENT',
          sourceKind: 'DEMO',
          observedAt: DEMO_SENTIMENT_OBSERVED_AT,
          basis: 'LATEST_OBSERVATION',
        });
        expect(asset.adjustment.triggered).toBe(false);
      }
      expect(view.view.sentimentAdjustedVaR).toMatchObject({
        value: null,
        status: 'SENTIMENT_NOT_CURRENT',
        reason: { missingConfigKeys: [] },
      });
      expect(view.view.sentimentAdjustedVaR.reason.ineligibleTickers.map((t) => t.sentimentStatus)).toEqual(
        view.view.assets.map(() => 'DEMO'),
      );
      expect(view.adjustedVaRAvailability.explanation.startsWith(AGGREGATION_NOT_APPROVED_EXPLANATION)).toBe(
        true,
      );
      expect(JSON.stringify(view.view.assets.map((a) => a.sentiment))).not.toContain('"REAL"');
    }
  });

  it('A2: the recorded distribution covers every Base VaR scenario and marks the stored raw quantile', async () => {
    const { files } = await exportTo();
    for (const name of Object.keys(PRE_A2_VIEWS)) {
      const view = DashboardViewResponseSchema.parse(JSON.parse((files[name] as Buffer).toString('utf8')));
      const dist = view.lossDistribution;
      if (dist.status !== 'AVAILABLE') throw new Error(`${name}: distribution unavailable`);
      expect(dist.bucketCount).toBe(20);
      expect(dist.buckets).toHaveLength(20);
      // The full approved lookback: 250 returns (the Base VaR observations of the demo).
      expect(dist.scenarioCount).toBe(250);
      expect(dist.buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(250);
      expect(dist.varMarker.rawQuantile).toBe(view.view.baseVaR.value?.rawQuantile);
      expect(dist.varMarker.confidence).toBe('0.95');
      expect(dist.min).toBe(dist.buckets[0]?.lower);
      expect(dist.buckets.at(-1)?.upperInclusive).toBe(true);
    }
  });

  it('is deterministic: two exports produce identical bytes', async () => {
    const first = await exportTo();
    const second = await exportTo();
    expect(Object.keys(second.files).sort()).toEqual(Object.keys(first.files).sort());
    for (const [name, bytes] of Object.entries(first.files)) {
      expect(second.files[name]?.equals(bytes), name).toBe(true);
    }
  });

  it('the recorded views equal the actual backend responses at the same reference clock', async () => {
    const { files } = await exportTo();
    const temp = tempDir('replay-live');
    const running = await startApplication({
      argv: ['--demo-fixtures', '--port', '0', '--allowed-origin', 'http://127.0.0.1'],
      env: {
        SRC_CONFIG_FILE: repoPath('config', 'demo', 'kiroween-2026.demo.jsonc'),
        SRC_DATABASE_FILE: path.join(temp.dir, 'demo.db'),
      },
      clock: new FakeClock(REPLAY_CLOCK),
      ids: sequentialIds('replay'),
      random: () => 0.5,
      sink: () => undefined,
      compute: (input) => Promise.resolve(riskEngine.compute(input)),
      fxTransport: () => Promise.resolve(csvOk(recorded(REPLAY_ECB_RESPONSE.file))),
    });
    try {
      for (const definition of DEMO_PORTFOLIOS) await running.app.components.scheduler.idle(definition.id);
      for (const definition of DEMO_PORTFOLIOS) {
        const served = await (await fetch(`${running.address}/dashboard/portfolios/${definition.id}`)).text();
        expect(files[`${definition.id}.json`]?.toString('utf8'), definition.id).toBe(served);
      }
    } finally {
      await running.stop();
      temp.cleanup();
    }
  });

  it('the export loads unchanged through the dashboard replay reader, with GET requests only', async () => {
    const { dir } = await exportTo();
    const methods: string[] = [];
    const reader = createReplaySource((url, init) => {
      methods.push(init.method);
      const file = path.join(dir, url.replace(/^\.\/replay\//, ''));
      return Promise.resolve(
        existsSync(file)
          ? {
              ok: true,
              status: 200,
              json: () => Promise.resolve(JSON.parse(readFileSync(file, 'utf8')) as unknown),
            }
          : { ok: false, status: 404, json: () => Promise.resolve({}) },
      );
    });
    const info = await reader.info();
    expect(info).toMatchObject({ ok: true, value: { kind: 'REPLAY', recordedAt: REPLAY_CLOCK } });
    const multi = await reader.view('demo-eur-usd-gbp');
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.value).toMatchObject({ dataMode: 'DEMO', runMode: 'DEMO_FIXTURES' });
      expect(multi.value.view.baseVaR.validity).toBe('CURRENT');
      expect(multi.value.adjustedVaRAvailability.reasonCode).toBe('AGGREGATION_NOT_APPROVED');
      expect(multi.value.fx.find((f) => f.currency === 'USD')?.rate?.quote).toMatchObject({
        pair: 'EURUSD',
        rate: '1.1165',
        referenceDate: '2026-11-06',
      });
    }
    expect((await reader.view('demo-eur-only')).ok).toBe(true);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });

  it('the output contains no database, log, absolute path, or credential', async () => {
    const { files } = await exportTo();
    for (const [name, bytes] of Object.entries(files)) {
      const text = bytes.toString('utf8');
      expect(name).not.toMatch(/\.(db|log|sqlite)/);
      expect(text, name).not.toMatch(
        /[A-Za-z]:\\|\/home\/|\/tmp\/|\/Users\/|SRC_DATABASE_FILE|correlationId|API_KEY/,
      );
    }
  });

  it('fails without writing anything when the recorded ECB fixture is missing or altered', async () => {
    const temp = tempDir('replay-fail');
    const out = path.join(temp.dir, 'replay');
    await expect(exportDashboardReplay({ ecbFixturesDir: temp.dir, outDir: out })).rejects.toBeInstanceOf(
      ReplayExportError,
    );
    expect(existsSync(out)).toBe(false);
    // An altered copy (one byte changed) is refused by its SHA-256.
    const altered = path.join(temp.dir, 'altered');
    cpSync(ECB_DIR, altered, { recursive: true });
    const file = path.join(altered, REPLAY_ECB_RESPONSE.file);
    writeFileSync(file, readFileSync(file, 'utf8').replace('1.1165', '1.1166'));
    await expect(exportDashboardReplay({ ecbFixturesDir: altered, outDir: out })).rejects.toThrow(/SHA-256/);
    expect(existsSync(out)).toBe(false);
  });

  it('fails and keeps the previous replay when the demo configuration cannot seed the portfolios', async () => {
    const { dir } = await exportTo();
    const before = readFileSync(path.join(dir, 'manifest.json'));
    const temp = tempDir('replay-noconfig');
    const config = path.join(temp.dir, 'empty.json');
    writeFileSync(config, '{}');
    await expect(
      exportDashboardReplay({ ecbFixturesDir: ECB_DIR, outDir: dir, configFile: config }),
    ).rejects.toBeInstanceOf(ReplayExportError);
    expect(readFileSync(path.join(dir, 'manifest.json')).equals(before)).toBe(true);
  });
});
