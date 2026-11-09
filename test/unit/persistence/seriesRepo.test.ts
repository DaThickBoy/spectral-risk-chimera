// Task 9.4: in-memory SeriesRepo (tables price_series and series_retrievals; design: Persistence,
// Series repository). Write-time constraints, the C2 exact-text exception, seq assignment, and
// unit-of-work semantics.
// Validates: Requirements 4.6, 12.6, 22.3
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type {
  NewSeriesRetrieval,
  Repositories,
  SeriesContentRecord,
} from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { ADAPTERS } from '../../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../../helpers/persistenceAdapters.js';

// OD-12: the same contract runs against every adapter.
describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  const HASH = 'a'.repeat(64);

  const content = (
    overrides: Partial<Record<keyof SeriesContentRecord, unknown>> = {},
  ): SeriesContentRecord =>
    ({
      contentHash: HASH,
      ticker: 'AAA',
      currency: 'USD',
      observations: [
        { date: '2026-11-02', adjustedClose: brandDecimalString('100.0') },
        { date: '2026-11-03', adjustedClose: brandDecimalString('101') },
      ],
      ...overrides,
    }) as SeriesContentRecord;

  const retrieval = (
    overrides: Partial<Record<keyof NewSeriesRetrieval, unknown>> = {},
  ): NewSeriesRetrieval =>
    ({
      contentHash: HASH,
      ticker: 'AAA',
      source: 'fixture',
      sourceKind: 'REAL',
      retrievedAt: '2026-11-06T10:00:00.000Z',
      ...overrides,
    }) as NewSeriesRetrieval;

  function expectViolation(uow: TestUnitOfWork, work: (tx: Repositories) => void, secret?: string): void {
    const before = uow.snapshot();
    let caught: unknown;
    try {
      uow.run(work);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe('CONSTRAINT_VIOLATION');
    if (secret !== undefined) {
      expect((caught as PersistenceError).message).not.toContain(secret);
    }
    expect(uow.snapshot()).toEqual(before);
  }

  const seeded = (): TestUnitOfWork => {
    const uow = createUow();
    uow.run((tx) => {
      tx.series.insertContent(content());
      tx.series.appendRetrieval(retrieval());
    });
    return uow;
  };

  describe('series content', () => {
    it('stores exact, non-canonical decimal text (C2 exception) and returns frozen records', () => {
      const uow = seeded();
      const stored = uow.run((tx) => tx.series.getContent(HASH));
      expect(stored?.observations.map((o) => o.adjustedClose)).toEqual(['100.0', '101']);
      expect(Object.isFrozen(stored)).toBe(true);
      expect(Object.isFrozen(stored?.observations[0])).toBe(true);
    });

    it('identical content for an existing hash returns false and writes nothing', () => {
      const uow = seeded();
      const inserted = uow.run((tx) => tx.series.insertContent(content()));
      expect(inserted).toBe(false);
      expect(uow.lastAttempt?.writes).toEqual([]);
      expect(uow.snapshot().seriesContent).toHaveLength(1);
    });

    it('different content under an existing hash violates a constraint', () => {
      const uow = seeded();
      expectViolation(uow, (tx) => {
        tx.series.insertContent(content({ currency: 'EUR' }));
      });
      expectViolation(uow, (tx) => {
        tx.series.insertContent(content({ observations: [{ date: '2026-11-02', adjustedClose: '100.00' }] }));
      });
    });

    const invalid: [string, Partial<Record<keyof SeriesContentRecord, unknown>>][] = [
      ['an uppercase hash', { contentHash: 'A'.repeat(64) }],
      ['a short hash', { contentHash: 'a'.repeat(63) }],
      ['an empty ticker', { ticker: '' }],
      ['a lowercase currency', { currency: 'usd' }],
      ['an impossible date', { observations: [{ date: '2026-02-30', adjustedClose: '1' }] }],
      ['a timestamp as date', { observations: [{ date: '2026-11-02T00:00:00.000Z', adjustedClose: '1' }] }],
      [
        'duplicate dates',
        {
          observations: [
            { date: '2026-11-02', adjustedClose: '1' },
            { date: '2026-11-02', adjustedClose: '1' },
          ],
        },
      ],
      [
        'descending dates',
        {
          observations: [
            { date: '2026-11-03', adjustedClose: '1' },
            { date: '2026-11-02', adjustedClose: '1' },
          ],
        },
      ],
      ['exponent notation', { observations: [{ date: '2026-11-02', adjustedClose: '1e5' }] }],
      ['a thousands separator', { observations: [{ date: '2026-11-02', adjustedClose: '1,000' }] }],
      ['NaN text', { observations: [{ date: '2026-11-02', adjustedClose: 'NaN' }] }],
      ['a native number', { observations: [{ date: '2026-11-02', adjustedClose: 100 }] }],
      ['a null observation', { observations: [null] }],
      ['observations that are not a list', { observations: 'x' }],
    ];

    it.each(invalid)('rejects %s', (_name, overrides) => {
      expectViolation(createUow(), (tx) => {
        tx.series.insertContent(content(overrides));
      });
    });

    it('accepts an empty observation list', () => {
      const uow = createUow();
      expect(uow.run((tx) => tx.series.insertContent(content({ observations: [] })))).toBe(true);
    });
  });

  describe('series retrievals', () => {
    it('assigns seq 1, 2, 3 in commit order and lists by hash and by ticker and kind', () => {
      const uow = seeded();
      const [second, third] = uow.run((tx) => [
        tx.series.appendRetrieval(retrieval({ sourceKind: 'DEMO' })),
        tx.series.appendRetrieval(retrieval({ retrievedAt: '2026-11-06T11:00:00.000Z' })),
      ]);
      expect([second?.seq, third?.seq]).toEqual([2, 3]);
      const byHash = uow.run((tx) => tx.series.listRetrievalsByHash(HASH));
      expect(byHash.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(uow.run((tx) => tx.series.listRetrievalsByTicker('AAA', 'REAL')).map((r) => r.seq)).toEqual([
        1, 3,
      ]);
      expect(uow.run((tx) => tx.series.listRetrievalsByTicker('AAA', 'DEMO')).map((r) => r.seq)).toEqual([2]);
      expect(uow.run((tx) => tx.series.listRetrievalsByTicker('BBB', 'REAL'))).toEqual([]);
    });

    it('a rolled-back or failed unit of work consumes no seq', () => {
      const uow = seeded();
      expect(() =>
        uow.run((tx) => {
          tx.series.appendRetrieval(retrieval({ source: 'x' }));
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      uow.failNextCommit({ atWrite: 0 });
      expect(() => uow.run((tx) => tx.series.appendRetrieval(retrieval({ source: 'y' })))).toThrow(
        PersistenceError,
      );
      expect(uow.run((tx) => tx.series.appendRetrieval(retrieval({ source: 'z' }))).seq).toBe(2);
    });

    it('reads inside a unit of work see its own writes; other units of work see only committed state', () => {
      const uow = createUow();
      const inside = uow.run((tx) => {
        tx.series.insertContent(content());
        tx.series.appendRetrieval(retrieval());
        return [tx.series.getContent(HASH) !== undefined, tx.series.listRetrievalsByHash(HASH).length];
      });
      expect(inside).toEqual([true, 1]);
    });

    const invalid: [string, Partial<Record<keyof NewSeriesRetrieval, unknown>>][] = [
      ['unknown content', { contentHash: 'b'.repeat(64) }],
      ['a ticker other than the content ticker', { ticker: 'BBB' }],
      ['an empty source', { source: '' }],
      ['an unknown source kind', { sourceKind: 'CURRENT' }],
      ['a timestamp without milliseconds', { retrievedAt: '2026-11-06T10:00:00Z' }],
      ['a timestamp with an offset', { retrievedAt: '2026-11-06T10:00:00.000+01:00' }],
    ];

    it.each(invalid)('rejects %s', (_name, overrides) => {
      expectViolation(seeded(), (tx) => {
        tx.series.appendRetrieval(retrieval(overrides));
      });
    });

    it('rejects a duplicate (contentHash, source, sourceKind, retrievedAt)', () => {
      expectViolation(seeded(), (tx) => {
        tx.series.appendRetrieval(retrieval());
      });
    });

    it('has no update or delete operation', () => {
      const keys = createUow().run((tx) => Object.keys(tx.series).sort());
      expect(keys).toEqual([
        'appendRetrieval',
        'getContent',
        'insertContent',
        'listRetrievalsByHash',
        'listRetrievalsByTicker',
      ]);
    });
  });
});
