// Task 9.4: content-addressed series store and caching (design: Series store and caching).
// Tests: AT-MD-18 (cached series labelled with retrieval time and status, never current),
// AT-AUD-03 market-data part (source, observation timestamp, real or demo status retained).
// Validates: Requirements 12.6, 12.7, 22.3, 25.3, 25.4
import { describe, expect, it } from 'vitest';
import { createSeriesStore } from '../../../src/app/index.js';
import type { CachedRetrieval, SeriesStore, SeriesStoreError } from '../../../src/app/index.js';
import { createReturnsBuilder } from '../../../src/marketdata/index.js';
import type { CleanResult } from '../../../src/marketdata/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import type { SeriesContentRecord, UnitOfWork } from '../../../src/persistence/index.js';
import type { Result } from '../../../src/shared/index.js';
import { WEEKDAYS, cleaned, referenceContentHash, tamperingUnitOfWork } from '../../helpers/seriesStore.js';

const setup = (): { uow: InMemoryUnitOfWork; store: SeriesStore } => {
  const uow = new InMemoryUnitOfWork();
  return { uow, store: createSeriesStore({ unitOfWork: uow }) };
};

function value<T>(result: Result<T, SeriesStoreError>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf<T>(result: Result<T, SeriesStoreError>): SeriesStoreError {
  if (result.ok) {
    throw new Error('expected an error');
  }
  return result.error;
}

/** Every label a caller can observe, from every read path. */
function allLabels(store: SeriesStore, hash: string, ticker: string): string[] {
  const labels = value(store.getByHash(hash)).retrievals.map((r) => r.label as string);
  for (const kind of ['REAL', 'DEMO'] as const) {
    const latest = store.latestFor(ticker, kind);
    if (latest.ok) {
      labels.push(latest.value.retrieval.label);
    }
  }
  return labels;
}

const withConflict = (): CleanResult =>
  cleaned({
    prices: [
      ['2026-11-02', '100'],
      ['2026-11-03', '101'],
      ['2026-11-03', '102'],
    ],
  });

describe('AT-MD-18: cached series are labelled per retrieval and never CURRENT', () => {
  it('labels a REAL retrieval CACHED on put, getByHash, and latestFor, with its retrieval time', () => {
    const { store } = setup();
    const input = cleaned({ sourceKind: 'REAL', retrievedAt: '2026-11-06T10:00:00.000Z' });
    const put = value(store.put(input));
    const expected: CachedRetrieval = {
      seq: 1,
      source: 'fixture',
      sourceKind: 'REAL',
      retrievedAt: '2026-11-06T10:00:00.000Z',
      label: 'CACHED',
    };
    expect(put.retrieval).toEqual(expected);
    expect(value(store.getByHash(put.contentHash)).retrievals).toEqual([expected]);
    expect(value(store.latestFor('AAA', 'REAL')).retrieval).toEqual(expected);
    expect(allLabels(store, put.contentHash, 'AAA')).not.toContain('CURRENT');
  });

  it('labels a DEMO retrieval DEMO, never CACHED or CURRENT', () => {
    const { store } = setup();
    const put = value(store.put(cleaned({ sourceKind: 'DEMO', source: 'demo-fixture' })));
    expect(put.retrieval.label).toBe('DEMO');
    expect(value(store.getByHash(put.contentHash)).retrievals.map((r) => r.label)).toEqual(['DEMO']);
    expect(value(store.latestFor('AAA', 'DEMO')).retrieval.label).toBe('DEMO');
    expect(allLabels(store, put.contentHash, 'AAA')).toEqual(['DEMO', 'DEMO']);
  });

  it('keeps each retrieval label when one content has REAL and DEMO provenance', () => {
    const { uow, store } = setup();
    const real = value(store.put(cleaned({ sourceKind: 'REAL', source: 'vendor' })));
    const demo = value(store.put(cleaned({ sourceKind: 'DEMO', source: 'demo-fixture' })));
    expect(demo.contentHash).toBe(real.contentHash);
    expect(demo.contentInserted).toBe(false);
    expect(demo.retrievalAppended).toBe(true);
    expect(uow.snapshot().seriesContent).toHaveLength(1);

    const byHash = value(store.getByHash(real.contentHash));
    expect(byHash.retrievals.map((r) => [r.seq, r.sourceKind, r.source, r.label])).toEqual([
      [1, 'REAL', 'vendor', 'CACHED'],
      [2, 'DEMO', 'demo-fixture', 'DEMO'],
    ]);
    // The content itself carries no label.
    expect(Object.keys(byHash.series).sort()).toEqual(['contentHash', 'currency', 'observations', 'ticker']);
    expect(value(store.latestFor('AAA', 'REAL')).retrieval).toMatchObject({
      sourceKind: 'REAL',
      label: 'CACHED',
    });
    expect(value(store.latestFor('AAA', 'DEMO')).retrieval).toMatchObject({
      sourceKind: 'DEMO',
      label: 'DEMO',
    });
  });

  it('labels do not depend on how old the retrieval is (no expiry, no age-based STALE)', () => {
    const { store } = setup();
    const put = value(store.put(cleaned({ retrievedAt: '1990-01-01T00:00:00.000Z' })));
    expect(value(store.getByHash(put.contentHash)).retrievals[0]?.label).toBe('CACHED');
    expect(value(store.latestFor('AAA', 'REAL')).retrieval.retrievedAt).toBe('1990-01-01T00:00:00.000Z');
  });
});

describe('AT-AUD-03 (market data): provenance and content round trip', () => {
  it('retains source, source kind, retrieval time, observation dates, and exact price text', () => {
    const { store } = setup();
    const input = cleaned({
      ticker: 'BBB',
      currency: 'EUR',
      source: 'vendor-x',
      sourceKind: 'REAL',
      retrievedAt: '2026-11-07T08:30:00.125Z',
      prices: [
        ['2026-11-04', '99.50'],
        ['2026-11-02', '100.0'],
        ['2026-11-03', '0.000100'],
      ],
    });
    const put = value(store.put(input));
    const read = value(store.getByHash(put.contentHash));
    expect(read.series).toEqual({
      contentHash: input.series.contentHash,
      ticker: 'BBB',
      currency: 'EUR',
      observations: [
        { date: '2026-11-02', adjustedClose: '100.0' },
        { date: '2026-11-03', adjustedClose: '0.000100' },
        { date: '2026-11-04', adjustedClose: '99.50' },
      ],
    });
    expect(read.retrievals).toEqual([
      {
        seq: 1,
        source: 'vendor-x',
        sourceKind: 'REAL',
        retrievedAt: '2026-11-07T08:30:00.125Z',
        label: 'CACHED',
      },
    ]);
  });

  it('keeps the 9.2 content hash, which an independent hash reproduces from the stored text', () => {
    const { store } = setup();
    const input = cleaned();
    const put = value(store.put(input));
    expect(put.contentHash).toBe(input.series.contentHash);
    const { series } = value(store.getByHash(put.contentHash));
    expect(referenceContentHash(series.ticker, series.currency, series.observations)).toBe(put.contentHash);
  });

  it('is compatible with ReturnMatrix.seriesHashes: every hash resolves to its stored series', () => {
    const { store } = setup();
    const prices = WEEKDAYS.map((date, i) => [date, `${100 + i}.0`] as const);
    const inputs = [cleaned({ ticker: 'AAA', prices }), cleaned({ ticker: 'BBB', prices })];
    for (const input of inputs) {
      value(store.put(input));
    }
    const matrix = createReturnsBuilder().build(inputs, {
      lookbackReturns: 5,
      minObservations: 2,
      maxReturnGapDays: 5,
    });
    if (!matrix.ok) {
      throw new Error('expected a return matrix');
    }
    for (const input of inputs) {
      const hash = matrix.value.seriesHashes[input.series.ticker];
      expect(hash).toBe(input.series.contentHash);
      expect(value(store.getByHash(hash ?? '')).series.observations).toEqual(input.series.observations);
    }
  });
});

describe('put', () => {
  it('is idempotent for identical content and identical provenance', () => {
    const { uow, store } = setup();
    const first = value(store.put(cleaned()));
    const before = uow.snapshot();
    const second = value(store.put(cleaned()));
    expect(first).toMatchObject({ contentInserted: true, retrievalAppended: true });
    expect(second).toEqual({ ...first, contentInserted: false, retrievalAppended: false });
    expect(uow.snapshot()).toEqual(before);
    expect(uow.lastAttempt?.writes).toEqual([]);
  });

  it('appends a new retrieval for a re-fetch of unchanged content', () => {
    const { uow, store } = setup();
    value(store.put(cleaned({ retrievedAt: '2026-11-06T10:00:00.000Z' })));
    const again = value(store.put(cleaned({ retrievedAt: '2026-11-06T11:00:00.000Z' })));
    expect(again).toMatchObject({ contentInserted: false, retrievalAppended: true });
    expect(again.retrieval.seq).toBe(2);
    expect(uow.snapshot().seriesContent).toHaveLength(1);
    expect(uow.snapshot().seriesRetrievals).toHaveLength(2);
  });

  it('refuses a conflicting series with SERIES_CONFLICT and writes nothing', () => {
    const { uow, store } = setup();
    const error = errorOf(store.put(withConflict()));
    expect(error).toMatchObject({ code: 'SERIES_CONFLICT', ticker: 'AAA', conflictDates: ['2026-11-03'] });
    expect(uow.snapshot().seriesContent).toEqual([]);
    expect(uow.snapshot().seriesRetrievals).toEqual([]);
    expect(uow.lastAttempt).toBeUndefined();
  });

  it('throws TypeError when the content hash does not match the content, writing nothing', () => {
    const { uow, store } = setup();
    const input = cleaned();
    const tampered = { ...input, series: { ...input.series, contentHash: 'a'.repeat(64) } };
    expect(() => store.put(tampered)).toThrow(TypeError);
    const changedText = {
      ...input,
      series: {
        ...input.series,
        observations: input.series.observations.map((o, i) =>
          i === 0 ? { ...o, adjustedClose: '100.00' } : o,
        ),
      },
    } as unknown as CleanResult;
    expect(() => store.put(changedText)).toThrow(TypeError);
    expect(uow.lastAttempt).toBeUndefined();
  });

  it('throws TypeError for input that is not a CleanResult', () => {
    const { store } = setup();
    expect(() => store.put(cleaned().series as unknown as CleanResult)).toThrow(TypeError);
    expect(() => store.put(null as unknown as CleanResult)).toThrow(TypeError);
    expect(() => store.put({ ...cleaned(), conflict: 'no' } as unknown as CleanResult)).toThrow(TypeError);
  });

  it('maps a failed commit to STORE_FAILED and leaves earlier data unchanged (no seq consumed)', () => {
    const { uow, store } = setup();
    const kept = value(store.put(cleaned({ ticker: 'AAA' })));
    const before = uow.snapshot();
    for (const atWrite of [0, 1, 2]) {
      uow.failNextCommit({ atWrite });
      const error = errorOf(store.put(cleaned({ ticker: 'BBB' })));
      expect(error).toMatchObject({ code: 'STORE_FAILED', persistenceCode: 'COMMIT_FAILED' });
      expect(uow.snapshot()).toEqual(before);
    }
    expect(value(store.latestFor('AAA', 'REAL')).series.contentHash).toBe(kept.contentHash);
    expect(errorOf(store.latestFor('BBB', 'REAL')).code).toBe('NOT_FOUND');
    expect(value(store.put(cleaned({ ticker: 'BBB' }))).retrieval.seq).toBe(2);
  });

  it('maps a write-time constraint to STORE_FAILED (CONSTRAINT_VIOLATION) without echoing the value', () => {
    const { uow, store } = setup();
    const badCurrency = cleaned({ currency: 'usd' });
    const error = errorOf(store.put(badCurrency));
    expect(error).toMatchObject({ code: 'STORE_FAILED', persistenceCode: 'CONSTRAINT_VIOLATION' });
    expect(error.message).not.toContain('usd');
    const badTime = errorOf(store.put(cleaned({ retrievedAt: '2026-11-06T10:00:00Z' })));
    expect(badTime).toMatchObject({ code: 'STORE_FAILED', persistenceCode: 'CONSTRAINT_VIOLATION' });
    expect(uow.snapshot().seriesContent).toEqual([]);
  });

  it('does not modify its input and returns frozen results', () => {
    const { store } = setup();
    const input = cleaned();
    const json = JSON.stringify(input);
    const put = value(store.put(input));
    expect(JSON.stringify(input)).toBe(json);
    expect(Object.isFrozen(put)).toBe(true);
    expect(Object.isFrozen(put.retrieval)).toBe(true);
    const read = value(store.getByHash(put.contentHash));
    expect(Object.isFrozen(read.series.observations)).toBe(true);
    expect(Object.isFrozen(read.series.observations[0])).toBe(true);
    expect(Object.isFrozen(read.retrievals)).toBe(true);
  });
});

describe('latestFor', () => {
  it('selects the latest retrievedAt, not the first or the last seq', () => {
    const { store } = setup();
    value(store.put(cleaned({ retrievedAt: '2026-11-06T10:00:00.000Z', prices: [['2026-11-02', '1']] })));
    const newest = value(
      store.put(cleaned({ retrievedAt: '2026-11-06T12:00:00.000Z', prices: [['2026-11-03', '2']] })),
    );
    value(store.put(cleaned({ retrievedAt: '2026-11-06T09:00:00.000Z', prices: [['2026-11-04', '3']] })));
    const latest = value(store.latestFor('AAA', 'REAL'));
    expect(latest.retrieval).toMatchObject({ seq: 2, retrievedAt: '2026-11-06T12:00:00.000Z' });
    expect(latest.series.contentHash).toBe(newest.contentHash);
  });

  it('breaks a retrievedAt tie with the higher seq', () => {
    const { store } = setup();
    const at = '2026-11-06T12:00:00.000Z';
    value(store.put(cleaned({ retrievedAt: at, source: 'a', prices: [['2026-11-02', '1']] })));
    const second = value(store.put(cleaned({ retrievedAt: at, source: 'b', prices: [['2026-11-02', '2']] })));
    const latest = value(store.latestFor('AAA', 'REAL'));
    expect(latest.retrieval).toMatchObject({ seq: 2, source: 'b' });
    expect(latest.series.contentHash).toBe(second.contentHash);
  });

  it('never falls back to another source kind or ticker', () => {
    const { store } = setup();
    value(store.put(cleaned({ sourceKind: 'DEMO', retrievedAt: '2026-11-07T00:00:00.000Z' })));
    expect(errorOf(store.latestFor('AAA', 'REAL')).code).toBe('NOT_FOUND');
    expect(errorOf(store.latestFor('ZZZ', 'DEMO')).code).toBe('NOT_FOUND');
    value(store.put(cleaned({ sourceKind: 'REAL', retrievedAt: '2026-11-01T00:00:00.000Z' })));
    // A newer DEMO retrieval never hides the REAL one, and vice versa.
    expect(value(store.latestFor('AAA', 'REAL')).retrieval.sourceKind).toBe('REAL');
    expect(value(store.latestFor('AAA', 'DEMO')).retrieval.sourceKind).toBe('DEMO');
  });

  it('throws TypeError for an invalid ticker or source kind', () => {
    const { store } = setup();
    expect(() => store.latestFor('', 'REAL')).toThrow(TypeError);
    expect(() => store.latestFor('AAA', 'CURRENT' as unknown as 'REAL')).toThrow(TypeError);
  });
});

describe('getByHash', () => {
  it('returns NOT_FOUND for an unknown hash and TypeError for a non-string', () => {
    const { store } = setup();
    expect(errorOf(store.getByHash('f'.repeat(64))).code).toBe('NOT_FOUND');
    expect(errorOf(store.getByHash('not-a-hash')).code).toBe('NOT_FOUND');
    expect(() => store.getByHash(1 as unknown as string)).toThrow(TypeError);
  });
});

describe('integrity on read: SERIES_INTEGRITY_ERROR and no data', () => {
  const seeded = (): { uow: InMemoryUnitOfWork; hash: string } => {
    const uow = new InMemoryUnitOfWork();
    const hash = value(createSeriesStore({ unitOfWork: uow }).put(cleaned())).contentHash;
    return { uow, hash };
  };
  const reading = (uow: UnitOfWork): SeriesStore => createSeriesStore({ unitOfWork: uow });
  const content = (change: (r: SeriesContentRecord) => unknown) => (r: SeriesContentRecord | undefined) =>
    r === undefined ? undefined : change(r);

  const contentCases: [string, (r: SeriesContentRecord) => unknown][] = [
    [
      'a changed price',
      (r) => ({
        ...r,
        observations: [{ ...r.observations[0], adjustedClose: '100.00' }, ...r.observations.slice(1)],
      }),
    ],
    [
      'an exponent price',
      (r) => ({
        ...r,
        observations: [{ ...r.observations[0], adjustedClose: '1e2' }, ...r.observations.slice(1)],
      }),
    ],
    ['an unknown field', (r) => ({ ...r, extra: 'x' })],
    [
      'an invalid date',
      (r) => ({
        ...r,
        observations: [{ ...r.observations[0], date: '2026-02-30' }, ...r.observations.slice(1)],
      }),
    ],
    ['dates out of order', (r) => ({ ...r, observations: [...r.observations].reverse() })],
    ['a different ticker', (r) => ({ ...r, ticker: 'ZZZ' })],
    ['a stored hash that differs from the key', (r) => ({ ...r, contentHash: 'b'.repeat(64) })],
    ['a non-object', () => 'garbage'],
  ];

  it.each(contentCases)('content with %s', (_name, change) => {
    const { uow, hash } = seeded();
    const store = reading(tamperingUnitOfWork(uow, { content: content(change) }));
    expect(errorOf(store.getByHash(hash)).code).toBe('SERIES_INTEGRITY_ERROR');
    expect(errorOf(store.latestFor('AAA', 'REAL')).code).toBe('SERIES_INTEGRITY_ERROR');
  });

  const retrievalCases: [string, (rs: readonly Record<string, unknown>[]) => readonly unknown[]][] = [
    ['a CURRENT source kind', (rs) => rs.map((r) => ({ ...r, sourceKind: 'CURRENT' }))],
    ['an unknown field', (rs) => rs.map((r) => ({ ...r, label: 'CURRENT' }))],
    ['a non-canonical timestamp', (rs) => rs.map((r) => ({ ...r, retrievedAt: '2026-11-06T10:00:00Z' }))],
    ['a wrong ticker', (rs) => rs.map((r) => ({ ...r, ticker: 'ZZZ' }))],
    ['a wrong content hash', (rs) => rs.map((r) => ({ ...r, contentHash: 'c'.repeat(64) }))],
    ['an empty source', (rs) => rs.map((r) => ({ ...r, source: '' }))],
    ['a non-positive seq', (rs) => rs.map((r) => ({ ...r, seq: 0 }))],
    ['duplicate seq', (rs) => [...rs, ...rs]],
  ];

  it.each(retrievalCases)('retrievals with %s', (_name, change) => {
    const { uow, hash } = seeded();
    const store = reading(
      tamperingUnitOfWork(uow, { retrievals: (rs) => change(rs as unknown as Record<string, unknown>[]) }),
    );
    expect(errorOf(store.getByHash(hash)).code).toBe('SERIES_INTEGRITY_ERROR');
  });

  it('content without any retrieval, and retrievals without content', () => {
    const { uow, hash } = seeded();
    expect(errorOf(reading(tamperingUnitOfWork(uow, { retrievals: () => [] })).getByHash(hash)).code).toBe(
      'SERIES_INTEGRITY_ERROR',
    );
    const orphan = reading(tamperingUnitOfWork(uow, { content: () => undefined }));
    expect(errorOf(orphan.getByHash(hash)).code).toBe('SERIES_INTEGRITY_ERROR');
    expect(errorOf(orphan.latestFor('AAA', 'REAL')).code).toBe('SERIES_INTEGRITY_ERROR');
  });

  it('untampered reads through the same wrapper succeed (the wrapper itself is neutral)', () => {
    const { uow, hash } = seeded();
    const store = reading(tamperingUnitOfWork(uow, {}));
    expect(value(store.getByHash(hash)).series.contentHash).toBe(hash);
    expect(value(store.latestFor('AAA', 'REAL')).series.contentHash).toBe(hash);
  });
});
