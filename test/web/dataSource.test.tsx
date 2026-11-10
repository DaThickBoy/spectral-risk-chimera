// Dashboard data sources (DR-KW-1 H4): the live read-only routes and the recorded replay use one
// interface, GET only, validated with the shared contracts; invalid or misplaced data is rejected.
// Validates: Requirements 17.10, 29.4
import { describe, expect, it } from 'vitest';
import { createLiveSource, createReplaySource } from '../../src/web/data/source.ts';
import type { Fetch } from '../../src/web/data/source.ts';
import { demoIndex, multiCurrencyView } from './fixtures.js';

interface Call {
  readonly url: string;
  readonly method: string;
}

function fakeFetch(files: Record<string, unknown>, calls: Call[]): Fetch {
  return (url, init) => {
    calls.push({ url, method: init.method });
    if (!(url in files)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const body = files[url];
    if (body instanceof Error) {
      return Promise.reject(body);
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(body)) });
  };
}

const SHA = 'a'.repeat(64);
const manifest = (views: Record<string, string> = { 'demo-eur-usd-gbp': 'demo-eur-usd-gbp.json' }) => ({
  schemaVersion: 2,
  kind: 'DASHBOARD_REPLAY',
  recordedAt: '2026-11-06T16:00:02.000Z',
  note: 'Recorded DEMO responses.',
  dataMode: 'DEMO',
  live: false,
  reference: {
    clock: '2026-11-06T16:00:02.000Z',
    marketDataAsOf: '2026-11-06',
    fxReferenceDate: '2026-11-06',
  },
  source: {
    runMode: 'DEMO_FIXTURES',
    configProfile: 'KIROWEEN_2026_DEMO',
    marketData: 'DEMO_FIXTURES',
    fx: {
      provider: 'ECB-EXR',
      recordedResponse: 'ecb-exr-gbp-usd-2026-11-06.csv',
      sha256: SHA,
      statement: 'Source: ECB statistics.',
    },
  },
  index: { ...demoIndex(), portfolios: Object.keys(views).map((id) => ({ id, baseCurrency: 'EUR' })) },
  views,
  portfolios: Object.entries(views).map(([id, file]) => ({
    id,
    file,
    sha256: SHA,
    dataMode: 'DEMO',
    freshness: { summary: 'CURRENT', asOfDate: '2026-11-06', calculatedAt: '2026-11-06T16:00:00.000Z' },
  })),
});

describe('replay source', () => {
  it('reads the manifest and the recorded view, with GET only', async () => {
    const calls: Call[] = [];
    const source = createReplaySource(
      fakeFetch(
        { './replay/manifest.json': manifest(), './replay/demo-eur-usd-gbp.json': multiCurrencyView() },
        calls,
      ),
    );
    expect(await source.info()).toEqual({
      ok: true,
      value: { kind: 'REPLAY', recordedAt: '2026-11-06T16:00:02.000Z', note: 'Recorded DEMO responses.' },
    });
    expect((await source.index()).ok).toBe(true);
    const view = await source.view('demo-eur-usd-gbp');
    expect(view.ok && view.value.portfolioId).toBe('demo-eur-usd-gbp');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('manifest.json'))).toHaveLength(1); // cached
  });

  it('schema version 2: a version-1 manifest, or a version-1 view without lossDistribution, is refused', async () => {
    const oldManifest = createReplaySource(
      fakeFetch(
        {
          './replay/manifest.json': { ...manifest(), schemaVersion: 1 },
          './replay/demo-eur-usd-gbp.json': multiCurrencyView(),
        },
        [],
      ),
    );
    expect(await oldManifest.info()).toEqual({ ok: false, error: 'INVALID_RESPONSE' });

    const v1Body: Record<string, unknown> = { ...multiCurrencyView(), schemaVersion: 1 };
    delete v1Body['lossDistribution'];
    for (const body of [
      v1Body,
      { ...v1Body, schemaVersion: 2 },
      { ...multiCurrencyView(), schemaVersion: 1 },
    ]) {
      const oldView = createReplaySource(
        fakeFetch({ './replay/manifest.json': manifest(), './replay/demo-eur-usd-gbp.json': body }, []),
      );
      expect(await oldView.view('demo-eur-usd-gbp')).toEqual({ ok: false, error: 'INVALID_RESPONSE' });
    }
  });

  it('a portfolio missing from the manifest is NOT_FOUND without a request', async () => {
    const calls: Call[] = [];
    const source = createReplaySource(fakeFetch({ './replay/manifest.json': manifest() }, calls));
    expect(await source.view('demo-eur-only')).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(calls.map((c) => c.url)).toEqual(['./replay/manifest.json']);
  });

  it('a recorded file for another portfolio, an invalid body, or an invalid manifest is INVALID_RESPONSE', async () => {
    const swapped = createReplaySource(
      fakeFetch(
        {
          './replay/manifest.json': manifest({ 'demo-eur-only': 'demo-eur-usd-gbp.json' }),
          './replay/demo-eur-usd-gbp.json': multiCurrencyView(),
        },
        [],
      ),
    );
    expect(await swapped.view('demo-eur-only')).toEqual({ ok: false, error: 'INVALID_RESPONSE' });

    const numeric = { ...multiCurrencyView(), display: { ...multiCurrencyView().display, baseVaR: 124.1 } };
    const badBody = createReplaySource(
      fakeFetch({ './replay/manifest.json': manifest(), './replay/demo-eur-usd-gbp.json': numeric }, []),
    );
    expect(await badBody.view('demo-eur-usd-gbp')).toEqual({ ok: false, error: 'INVALID_RESPONSE' });

    for (const file of ['../secret.json', 'sub/dir.json', 'view.txt']) {
      const bad = createReplaySource(
        fakeFetch({ './replay/manifest.json': manifest({ 'demo-eur-usd-gbp': file }) }, []),
      );
      expect(await bad.index(), file).toEqual({ ok: false, error: 'INVALID_RESPONSE' });
    }
  });

  it.each([
    ['a live replay', { live: true }],
    ['REAL data', { dataMode: 'REAL' }],
    [
      'a clock different from recordedAt',
      { reference: { ...manifest().reference, clock: '2026-11-06T16:00:00.000Z' } },
    ],
    ['a portfolio listed without its view', { views: {} }],
    ['an index portfolio without a manifest entry', { portfolios: [] }],
    ['an unknown field', { extra: true }],
  ])('an incomplete or inconsistent manifest (%s) is INVALID_RESPONSE', async (_name, change) => {
    const bad = createReplaySource(fakeFetch({ './replay/manifest.json': { ...manifest(), ...change } }, []));
    expect(await bad.index()).toEqual({ ok: false, error: 'INVALID_RESPONSE' });
  });

  it('missing replay files are NOT_FOUND; a network failure is NETWORK', async () => {
    expect(await createReplaySource(fakeFetch({}, [])).index()).toEqual({ ok: false, error: 'NOT_FOUND' });
    const down = createReplaySource(fakeFetch({ './replay/manifest.json': new Error('offline') }, []));
    expect(await down.index()).toEqual({ ok: false, error: 'NETWORK' });
  });
});

describe('live source', () => {
  it('calls only the read-only dashboard routes, with GET', async () => {
    const calls: Call[] = [];
    const source = createLiveSource(
      fakeFetch(
        { '/dashboard': demoIndex(), '/dashboard/portfolios/demo-eur-usd-gbp': multiCurrencyView() },
        calls,
      ),
    );
    expect((await source.index()).ok).toBe(true);
    expect((await source.view('demo-eur-usd-gbp')).ok).toBe(true);
    expect(calls).toEqual([
      { url: '/dashboard', method: 'GET' },
      { url: '/dashboard/portfolios/demo-eur-usd-gbp', method: 'GET' },
    ]);
  });

  it('rejects an unsafe portfolio id without a request, and maps HTTP errors', async () => {
    const calls: Call[] = [];
    const source = createLiveSource(
      fakeFetch({ '/dashboard': { not: 'an index' } }, calls),
      'http://127.0.0.1:8080/',
    );
    expect(await source.view('../portfolios')).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(calls).toEqual([]);
    expect(await source.index()).toEqual({ ok: false, error: 'NOT_FOUND' }); // base URL applied: no such file
    const invalid = createLiveSource(fakeFetch({ '/dashboard': { not: 'an index' } }, []));
    expect(await invalid.index()).toEqual({ ok: false, error: 'INVALID_RESPONSE' });
    const failing: Fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    expect(await createLiveSource(failing).index()).toEqual({ ok: false, error: 'HTTP_ERROR' });
  });
});
