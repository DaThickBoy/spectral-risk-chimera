// Task 9.6 (the parts specified without OD-13): provider history through the shared
// ResilientCall, re-validation, the 9.2 cleaner, and the 9.4 store, with provenance kept.
// No refresh, expiry, or fetch-through on read is tested here because none is specified.
// Validates: Requirements 12.1, 12.5, 12.6, 22.3, 25.2, 25.8
import { describe, expect, it } from 'vitest';
import { createSeriesRetrievalService, createSeriesStore } from '../../../src/app/index.js';
import type { SeriesRetrievalService } from '../../../src/app/index.js';
import {
  FixtureMarketDataProvider,
  createSeriesCleaner,
  weekendsOnlyCalendar,
} from '../../../src/marketdata/index.js';
import type { MarketDataProvider, ProviderSeries } from '../../../src/marketdata/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import { appError, canonicalJson, sha256Hex } from '../../../src/shared/index.js';
import type { ProviderError, ProviderErrorCode, Result } from '../../../src/shared/index.js';
import { START, drive, harness } from '../../helpers/resilience.js';
import type { Harness } from '../../helpers/resilience.js';

const RANGE = { from: '2026-11-02', to: '2026-11-06' };
// Mon 2 to Fri 6 November 2026, plus a Saturday, a missing value, NaN, and a non-positive price.
const PAYLOAD = {
  ticker: 'AAA',
  currency: 'USD',
  observations: [
    { date: '2026-11-03', adjustedClose: '100' },
    { date: '2026-11-04', adjustedClose: '110' },
    { date: '2026-11-05', adjustedClose: '99' },
    { date: '2026-11-06', adjustedClose: '108.9' },
    { date: '2026-11-02', adjustedClose: null },
    { date: '2026-11-02', adjustedClose: 'NaN' },
    { date: '2026-11-04', adjustedClose: '110.0' },
    { date: '2026-11-05', adjustedClose: '0' },
  ],
};

function fixture(h: Harness, payload: unknown = PAYLOAD): FixtureMarketDataProvider {
  return new FixtureMarketDataProvider({
    name: 'fixture-md',
    clock: h.clock,
    fixtures: { series: { AAA: payload } },
  });
}

/** The fixture's series relabelled as a REAL provider (the hash excludes provenance). */
function realProvider(
  h: Harness,
  edit: (s: ProviderSeries) => unknown = (s) => s,
): MarketDataProvider & { calls: number } {
  const inner = fixture(h);
  const provider = {
    name: 'fixture-md',
    kind: 'REAL' as const,
    calls: 0,
    getLatestPrice: () => Promise.reject(new Error('not used')),
    getDailySeries: async (ticker: string, range: { from: string; to: string }) => {
      provider.calls += 1;
      const result = await inner.getDailySeries(ticker, range);
      return (
        result.ok ? { ok: true, value: edit({ ...result.value, sourceKind: 'REAL' }) } : result
      ) as Result<ProviderSeries, ProviderError>;
    },
  };
  return provider;
}

function failing(code: ProviderErrorCode, httpStatus?: number): Result<ProviderSeries, ProviderError> {
  return {
    ok: false,
    error: {
      ...appError(code, 'Provider call fixture-md getDailySeries failed.'),
      provider: 'fixture-md',
      operation: 'getDailySeries',
      attempts: 1,
      retryable: false,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
}

function setup(provider: (h: Harness) => MarketDataProvider, retry: { maxRetries?: number } = {}) {
  const h = harness({ maxRetries: retry.maxRetries ?? 0 }, { failureThreshold: 2 });
  const uow = new InMemoryUnitOfWork();
  const store = createSeriesStore({ unitOfWork: uow });
  const marketData = provider(h);
  const service: SeriesRetrievalService = createSeriesRetrievalService({
    marketData,
    resilientCall: h.rc,
    cleaner: createSeriesCleaner(weekendsOnlyCalendar),
    store,
  });
  const retrieve = (ticker = 'AAA', range = RANGE) => drive(h.sleeper, service.retrieve(ticker, range));
  return { h, uow, store, marketData, service, retrieve };
}

describe('provider history into the series store', () => {
  it('DEMO fixture: cleaned, stored with its provenance, labelled DEMO, discards counted', async () => {
    const s = setup((h) => fixture(h));
    const result = await s.retrieve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      ticker: 'AAA',
      observations: 4,
      contentInserted: true,
      retrievalAppended: true,
      retrieval: { source: 'fixture-md', sourceKind: 'DEMO', retrievedAt: START, label: 'DEMO' },
      discarded: {
        missing: 1,
        nonFinite: 1,
        nonPositive: 1,
        nonTradingDate: 0,
        duplicateCollapsed: 1,
        conflicting: 0,
      },
    });
    const latest = s.store.latestFor('AAA', 'DEMO');
    expect(latest.ok && latest.value.series.observations).toEqual([
      { date: '2026-11-03', adjustedClose: '100' },
      { date: '2026-11-04', adjustedClose: '110' }, // first-received text kept (no canonicalization)
      { date: '2026-11-05', adjustedClose: '99' },
      { date: '2026-11-06', adjustedClose: '108.9' },
    ]);
    expect(latest.ok && latest.value.series.contentHash).toBe(result.value.contentHash);
    expect(s.store.latestFor('AAA', 'REAL')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('a weekend observation is discarded by the weekends-only calendar, never stored', async () => {
    const s = setup((h) =>
      fixture(h, {
        ...PAYLOAD,
        observations: [...PAYLOAD.observations, { date: '2026-11-07', adjustedClose: '1' }],
      }),
    );
    const result = await s.retrieve('AAA', { from: '2026-11-02', to: '2026-11-07' });
    expect(result.ok && result.value.discarded.nonTradingDate).toBe(1);
    expect(result.ok && result.value.observations).toBe(4);
  });

  it('identical content is stored once; a later retrieval adds provenance under the same hash', async () => {
    const s = setup((h) => realProvider(h));
    const first = await s.retrieve();
    const again = await s.retrieve();
    expect(again).toMatchObject({ ok: true, value: { contentInserted: false, retrievalAppended: false } });
    s.h.clock.advance(60_000);
    const later = await s.retrieve();
    expect(later).toMatchObject({
      ok: true,
      value: {
        contentInserted: false,
        retrievalAppended: true,
        retrieval: { label: 'CACHED', sourceKind: 'REAL' },
      },
    });
    expect(first.ok && later.ok && later.value.contentHash === first.value.contentHash).toBe(true);
    expect(s.uow.snapshot().seriesContent).toHaveLength(1);
    expect(s.uow.snapshot().seriesRetrievals.map((r) => r.retrievedAt)).toEqual([
      START,
      '2026-11-07T12:01:00.000Z',
    ]);
  });

  it('conflicting duplicates: SERIES_CONFLICT and nothing is written', async () => {
    const s = setup((h) =>
      fixture(h, {
        ...PAYLOAD,
        observations: [...PAYLOAD.observations, { date: '2026-11-03', adjustedClose: '101' }],
      }),
    );
    expect(await s.retrieve()).toMatchObject({
      ok: false,
      error: { code: 'SERIES_CONFLICT', ticker: 'AAA', conflictDates: ['2026-11-03'] },
    });
    expect(s.uow.snapshot().seriesContent).toEqual([]);
    expect(s.uow.snapshot().seriesRetrievals).toEqual([]);
  });

  it('a commit failure is STORE_FAILED and leaves the store unchanged', async () => {
    const s = setup((h) => realProvider(h));
    s.uow.failNextCommit({ atWrite: 0 });
    expect(await s.retrieve()).toMatchObject({
      ok: false,
      error: { code: 'STORE_FAILED', persistenceCode: 'COMMIT_FAILED' },
    });
    expect(s.uow.snapshot().seriesContent).toEqual([]);
  });
});

describe('provider failures go through the shared ResilientCall', () => {
  it('no data (404) is PROVIDER_ERROR HTTP_CLIENT_ERROR, not retried, and nothing is stored', async () => {
    const s = setup((h) => fixture(h), { maxRetries: 3 });
    expect(await s.retrieve('BBB')).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ERROR', providerCode: 'HTTP_CLIENT_ERROR' },
    });
    expect(s.uow.snapshot().seriesRetrievals).toEqual([]);
  });

  it('a network failure is retried; the retry succeeds and is stored', async () => {
    const s = setup(
      (h) => {
        const real = realProvider(h);
        let calls = 0;
        return {
          ...real,
          getDailySeries: (ticker, range) => {
            calls += 1;
            return calls === 1
              ? Promise.resolve(failing('NETWORK_ERROR'))
              : real.getDailySeries(ticker, range);
          },
        };
      },
      { maxRetries: 1 },
    );
    expect(await s.retrieve()).toMatchObject({ ok: true, value: { observations: 4 } });
  });

  it('uses the market data circuit key: repeated failures open the circuit shared with valuation', async () => {
    const s = setup((h) => ({
      ...realProvider(h),
      getDailySeries: () => Promise.resolve(failing('HTTP_SERVER_ERROR', 503)),
    }));
    await s.retrieve();
    await s.retrieve();
    expect(s.h.rc.status('marketdata:fixture-md')).toMatchObject({
      circuit: 'OPEN',
      lastErrorCode: 'HTTP_SERVER_ERROR',
    });
    expect(await s.retrieve()).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ERROR', providerCode: 'CIRCUIT_OPEN' },
    });
  });

  it('an exception inside the provider is UNEXPECTED_ERROR, not a crash', async () => {
    const s = setup((h) => ({
      ...realProvider(h),
      getDailySeries: () => {
        throw new Error('boom');
      },
    }));
    expect(await s.retrieve()).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ERROR', providerCode: 'UNEXPECTED_ERROR' },
    });
  });
});

describe('re-validation of the provider result (as for quotes, Valuation rule 4a)', () => {
  const rehash = (s: ProviderSeries): ProviderSeries => ({
    ...s,
    contentHash: sha256Hex(
      canonicalJson({ ticker: s.ticker, currency: s.currency, observations: s.observations }),
    ),
  });
  it.each([
    ['SCHEMA', (s: ProviderSeries) => ({ ...s, observations: [{ date: '2026-11-03', adjustedClose: 100 }] })],
    ['SCHEMA', (s: ProviderSeries) => ({ ...s, extra: true })],
    [
      'SCHEMA',
      (s: ProviderSeries) =>
        rehash({ ...s, observations: [{ date: '2026-11-03', adjustedClose: '1e2' }] } as never),
    ],
    ['TICKER_MISMATCH', (s: ProviderSeries) => rehash({ ...s, ticker: 'aaa' })],
    [
      'OUT_OF_RANGE',
      (s: ProviderSeries) =>
        rehash({
          ...s,
          observations: [...s.observations, { date: '2026-11-09', adjustedClose: '1' } as never],
        }),
    ],
    ['PROVENANCE_MISMATCH', (s: ProviderSeries) => ({ ...s, source: 'other-md' })],
    ['PROVENANCE_MISMATCH', (s: ProviderSeries) => ({ ...s, sourceKind: 'DEMO' })],
    ['HASH_MISMATCH', (s: ProviderSeries) => ({ ...s, observations: s.observations.slice(1) })],
  ] as const)('%s is INVALID_RESPONSE, not retried, and nothing is stored', async (reason, edit) => {
    const s = setup((h) => realProvider(h, edit), { maxRetries: 3 });
    expect(await s.retrieve()).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE', reason } });
    expect((s.marketData as unknown as { calls: number }).calls).toBe(1);
    expect(s.uow.snapshot().seriesRetrievals).toEqual([]);
  });

  it('an invalid ticker or range is a programmer error and calls nothing', async () => {
    const s = setup((h) => realProvider(h));
    await expect(s.service.retrieve('', RANGE)).rejects.toThrow(TypeError);
    await expect(s.service.retrieve('AAA', { from: '2026-11-06', to: '2026-11-02' })).rejects.toThrow(
      TypeError,
    );
    expect((s.marketData as unknown as { calls: number }).calls).toBe(0);
  });
});
