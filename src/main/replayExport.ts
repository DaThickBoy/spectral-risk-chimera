/**
 * Deterministic static-replay exporter (OD-21, approved 2026-11-09; Kiroween decision H4).
 *
 *   node dist/main/replayExport.js --ecb-fixtures <dir> --out <dir>
 *
 * Records the real application's dashboard responses for the GitHub Pages replay:
 * 1. Starts the application in-process in the explicit demo mode (`startApplication`,
 *    `--demo-fixtures`) with the committed demo configuration, a temporary SQLite file,
 *    and only deterministic inputs:
 *    - market data: the DEMO fixtures;
 *    - FX: the ECB adapter over a transport that serves exactly one recorded ECB response
 *      (`REPLAY_ECB_RESPONSE`, verified by SHA-256); any other request fails the export.
 *      No live provider is ever called.
 *    - the fixed reference clock `REPLAY_CLOCK` (2026-11-06 16:00 UTC, one hour after the
 *      ECB convention instant of the recorded 2026-11-06 rates; the DEMO market data ends on
 *      the same Friday), sequential ids, a constant random source, and the in-process risk
 *      engine.
 * 2. Captures `GET /dashboard` and `GET /dashboard/portfolios/:id` for both seeded portfolios
 *    over HTTP, byte for byte, and validates each body with the shared contracts.
 * 3. Checks the replay is what it claims: both portfolios seeded and listed, DEMO data, Base
 *    VaR CURRENT, freshness CURRENT, the market-data as-of date and every ECB quote's
 *    reference date equal to the fixed reference dates.
 * 4. Writes `manifest.json` (`DashboardReplayManifestSchema`), the view files, and the
 *    recorded ECB response (unmodified, `Source: ECB statistics.`) into a staging directory,
 *    validates the manifest, and only then replaces the output directory. Any failure leaves
 *    no partial replay. The database, logs, and paths never reach the output.
 * Identical inputs produce identical files.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EcbTransport } from '../adapters/index.js';
import { DEMO_PROFILE } from '../config/index.js';
import { riskEngine } from '../risk/index.js';
import {
  DASHBOARD_SCHEMA_VERSION,
  DashboardIndexResponseSchema,
  DashboardReplayManifestSchema,
  DashboardViewResponseSchema,
  FakeClock,
  sequentialIds,
} from '../shared/index.js';
import type { DashboardReplayManifest, DashboardViewResponse } from '../shared/index.js';
import { DEMO_PORTFOLIOS } from './demoPortfolios.js';
import { startApplication } from './start.js';

/** The fixed reference clock of the replay (OD-21). */
export const REPLAY_CLOCK = '2026-11-06T16:00:00.000Z';
export const REPLAY_MARKET_DATA_AS_OF = '2026-11-06';
export const REPLAY_FX_REFERENCE_DATE = '2026-11-06';

/** The one recorded ECB response the replay uses (test/fixtures/fx/ecb/README.md). */
export const REPLAY_ECB_RESPONSE = Object.freeze({
  file: 'exr-gbp-usd-2026-11-06.csv',
  endPeriod: '2026-11-06',
  sha256: 'be7147dd92819e669c69b7b485e2c8d3e826d82ff6bd3a1f946eb52489e5f30f',
});

export const REPLAY_CONFIG_FILE = path.join('config', 'demo', 'kiroween-2026.demo.jsonc');
const REPLAY_NOTE =
  'Recorded DEMO replay: deterministic fixture data and one recorded ECB response, captured from the ' +
  'real backend at a fixed reference time. Not live data; never used for trading.';

export class ReplayExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayExportError';
  }
}

export interface ReplayExportOptions {
  /** Directory with the recorded ECB responses. */
  readonly ecbFixturesDir: string;
  /** Output directory; replaced only after a complete, validated export. */
  readonly outDir: string;
  /** The demo configuration (default: the committed file). */
  readonly configFile?: string;
}

export interface ReplayExportResult {
  readonly manifest: DashboardReplayManifest;
  /** Output file name -> exact bytes written. */
  readonly files: Readonly<Record<string, Buffer>>;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function fail(message: string): never {
  throw new ReplayExportError(message);
}

/** Serves the one recorded ECB response; every other request fails the export. */
function recordedEcbTransport(body: Buffer, unexpected: string[]): EcbTransport {
  return (url) => {
    const endPeriod = new URL(url).searchParams.get('endPeriod');
    if (endPeriod !== REPLAY_ECB_RESPONSE.endPeriod) {
      unexpected.push(url);
      return Promise.resolve({ ok: false, failure: 'HTTP', status: 404 });
    }
    return Promise.resolve({
      ok: true,
      value: { status: 200, headers: { 'content-type': 'text/csv' }, body: new Uint8Array(body) },
    });
  };
}

async function getText(address: string, route: string): Promise<string> {
  const response = await fetch(`${address}${route}`, { method: 'GET' });
  if (response.status !== 200) {
    fail(`GET ${route} answered HTTP ${String(response.status)}.`);
  }
  return response.text();
}

function checkView(view: DashboardViewResponse, id: string): void {
  if (view.portfolioId !== id) fail(`The view for ${id} names another portfolio.`);
  if (view.dataMode !== 'DEMO' || !view.view.calculation.flags.includes('DEMO_DATA')) {
    fail(`The view for ${id} is not labelled DEMO data.`);
  }
  if (view.runMode !== 'DEMO_FIXTURES') fail(`The view for ${id} was not recorded in demo mode.`);
  if (view.view.baseVaR.validity !== 'CURRENT' || view.view.baseVaR.value === null) {
    fail(`Base VaR for ${id} is not CURRENT (${view.view.baseVaR.status}).`);
  }
  if (view.freshness.summary !== 'CURRENT')
    fail(`The inputs for ${id} are not current (${view.freshness.summary}).`);
  if (view.freshness.asOfDate !== REPLAY_MARKET_DATA_AS_OF) {
    fail(`The market data as-of date for ${id} does not match the reference date.`);
  }
  for (const fx of view.fx) {
    if (fx.status === 'IDENTITY') continue;
    if (fx.status !== 'CURRENT' || fx.rate?.source !== 'ECB-EXR')
      fail(`The ${fx.currency} rate for ${id} is not a current ECB rate.`);
    if (fx.rate.quote?.referenceDate !== REPLAY_FX_REFERENCE_DATE) {
      fail(`The ${fx.currency} ECB observation for ${id} has no stored quote for the reference date.`);
    }
  }
}

/** Records the replay; throws `ReplayExportError` (and writes nothing) on any problem. */
export async function exportDashboardReplay(options: ReplayExportOptions): Promise<ReplayExportResult> {
  const ecbBytes = (() => {
    try {
      return readFileSync(path.join(options.ecbFixturesDir, REPLAY_ECB_RESPONSE.file));
    } catch {
      return fail(`The recorded ECB response ${REPLAY_ECB_RESPONSE.file} is missing.`);
    }
  })();
  if (sha256(ecbBytes) !== REPLAY_ECB_RESPONSE.sha256) {
    fail(`The recorded ECB response ${REPLAY_ECB_RESPONSE.file} does not match its recorded SHA-256.`);
  }

  const work = mkdtempSync(path.join(tmpdir(), 'src-replay-'));
  const unexpected: string[] = [];
  const log: Record<string, unknown>[] = [];
  let running: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    running = await startApplication({
      argv: ['--demo-fixtures', '--port', '0', '--allowed-origin', 'http://127.0.0.1'],
      env: {
        SRC_CONFIG_FILE: options.configFile ?? REPLAY_CONFIG_FILE,
        SRC_DATABASE_FILE: path.join(work, 'replay.db'),
      },
      clock: new FakeClock(REPLAY_CLOCK),
      ids: sequentialIds('replay'),
      random: () => 0.5,
      sink: (line) => log.push(JSON.parse(line) as Record<string, unknown>),
      compute: (input) => Promise.resolve(riskEngine.compute(input)),
      fxTransport: recordedEcbTransport(ecbBytes, unexpected),
    });
    const ready = log.find((r) => r['msg'] === 'start.ready');
    if (ready?.['demoProfile'] !== DEMO_PROFILE)
      fail('The replay must be recorded with the demo configuration.');
    for (const definition of DEMO_PORTFOLIOS) {
      const seed = log.find((r) => r['msg'] === 'start.demo_portfolio' && r['portfolioId'] === definition.id);
      if (seed?.['seeded'] !== true) fail(`The demo portfolio ${definition.id} was not seeded.`);
      await running.app.components.scheduler.idle(definition.id);
    }

    const address = running.address;
    const indexText = await getText(address, '/dashboard');
    const index = DashboardIndexResponseSchema.parse(JSON.parse(indexText) as unknown);
    const expectedIds = DEMO_PORTFOLIOS.map((p) => p.id);
    if (index.portfolios.map((p) => p.id).join() !== expectedIds.join()) {
      fail('The dashboard index does not list exactly the demo portfolios.');
    }
    const files: Record<string, Buffer> = {};
    const portfolios: DashboardReplayManifest['portfolios'] = [];
    const views: Record<string, string> = {};
    for (const id of expectedIds) {
      const text = await getText(address, `/dashboard/portfolios/${id}`);
      const parsed = DashboardViewResponseSchema.safeParse(JSON.parse(text) as unknown);
      if (!parsed.success) fail(`The dashboard response for ${id} does not match the contract.`);
      checkView(parsed.data, id);
      const file = `${id}.json`;
      const bytes = Buffer.from(text, 'utf8');
      files[file] = bytes;
      views[id] = file;
      portfolios.push({
        id,
        file,
        sha256: sha256(bytes),
        dataMode: parsed.data.dataMode,
        freshness: {
          summary: parsed.data.freshness.summary,
          asOfDate: parsed.data.freshness.asOfDate,
          calculatedAt: parsed.data.freshness.calculatedAt,
        },
      });
    }
    if (unexpected.length > 0) fail('The application requested an ECB response that was not recorded.');

    const ecbFile = `ecb-${REPLAY_ECB_RESPONSE.file}`;
    files[ecbFile] = ecbBytes;
    const manifest = DashboardReplayManifestSchema.parse({
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      kind: 'DASHBOARD_REPLAY',
      recordedAt: REPLAY_CLOCK,
      note: REPLAY_NOTE,
      dataMode: 'DEMO',
      live: false,
      reference: {
        clock: REPLAY_CLOCK,
        marketDataAsOf: REPLAY_MARKET_DATA_AS_OF,
        fxReferenceDate: REPLAY_FX_REFERENCE_DATE,
      },
      source: {
        runMode: 'DEMO_FIXTURES',
        configProfile: DEMO_PROFILE,
        marketData: 'DEMO_FIXTURES',
        fx: {
          provider: 'ECB-EXR',
          recordedResponse: ecbFile,
          sha256: REPLAY_ECB_RESPONSE.sha256,
          statement: 'Source: ECB statistics.',
        },
      },
      index,
      views,
      portfolios,
    });
    files['manifest.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await running.stop();
    running = undefined;
    // Stage next to the output (same file system), then replace it in one rename: never a
    // partial replay.
    const out = path.resolve(options.outDir);
    const staging = `${out}.staging`;
    rmSync(staging, { recursive: true, force: true });
    try {
      mkdirSync(staging, { recursive: true });
      for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(path.join(staging, name), bytes);
      }
      rmSync(out, { recursive: true, force: true });
      renameSync(staging, out);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return { manifest, files };
  } finally {
    if (running !== undefined) await running.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

/** CLI: `--ecb-fixtures <dir> --out <dir>`; exit 0 on success, 1 on any failure. */
export async function main(argv: readonly string[]): Promise<number> {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ecbFixturesDir = value('--ecb-fixtures');
  const outDir = value('--out');
  if (ecbFixturesDir === undefined || outDir === undefined) {
    process.stderr.write('Usage: node dist/main/replayExport.js --ecb-fixtures <dir> --out <dir>\n');
    return 2;
  }
  try {
    const result = await exportDashboardReplay({ ecbFixturesDir, outDir });
    process.stdout.write(
      `Replay exported: ${String(Object.keys(result.files).length)} files, recorded at ${result.manifest.recordedAt}.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `Replay export failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
