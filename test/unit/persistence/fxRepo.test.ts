// Task 10.3: in-memory FxRepo (table fx_rates; design: Persistence, FX repository). Write-time
// constraints, append-only semantics, and unit-of-work atomicity.
// Validates: Requirements 4.3, 22.3, 30.5, 30.13
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { FxRateRecord, Repositories } from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { ADAPTERS } from '../../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../../helpers/persistenceAdapters.js';

// OD-12: the same contract runs against every adapter.
describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  const record = (overrides: Partial<Record<keyof FxRateRecord, unknown>> = {}): FxRateRecord =>
    ({
      id: 'fx-1',
      pair: 'EURUSD',
      rate: brandDecimalString('1.085'),
      observedAt: '2026-11-06T15:00:00.000Z',
      observedAtBasis: 'PROVIDER',
      source: 'fixture',
      sourceKind: 'REAL',
      recordedAt: '2026-11-06T16:00:00.000Z',
      ...overrides,
    }) as FxRateRecord;

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

  describe('FxRepo', () => {
    it('appends frozen copies, finds by key, and lists by pair in append order', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.fxRates.append(record());
        tx.fxRates.append(record({ id: 'fx-2', observedAt: '2026-11-06T15:30:00.000Z' }));
        tx.fxRates.append(record({ id: 'fx-3', pair: 'GBPUSD' }));
      });
      const found = uow.run((tx) =>
        tx.fxRates.findByKey('EURUSD', 'fixture', 'REAL', '2026-11-06T15:00:00.000Z'),
      );
      expect(found?.id).toBe('fx-1');
      expect(Object.isFrozen(found)).toBe(true);
      expect(uow.run((tx) => tx.fxRates.listByPair('EURUSD')).map((r) => r.id)).toEqual(['fx-1', 'fx-2']);
      expect(
        uow.run((tx) => tx.fxRates.findByKey('EURUSD', 'fixture', 'DEMO', '2026-11-06T15:00:00.000Z')),
      ).toBeUndefined();
      expect(uow.snapshot().fxRates.map((r) => r.id)).toEqual(['fx-1', 'fx-2', 'fx-3']);
    });

    it('accepts PUBLICATION_CONVENTION with a conventionId', () => {
      const uow = createUow();
      uow.run((tx) =>
        tx.fxRates.append(
          record({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: 'ECB-PUB-1600-FRANKFURT-v1' }),
        ),
      );
      expect(uow.snapshot().fxRates[0]?.conventionId).toBe('ECB-PUB-1600-FRANKFURT-v1');
    });

    it('a duplicate id or key violates a constraint', () => {
      const uow = createUow();
      uow.run((tx) => tx.fxRates.append(record()));
      expectViolation(uow, (tx) => tx.fxRates.append(record({ observedAt: '2026-11-06T15:30:00.000Z' })));
      expectViolation(uow, (tx) => tx.fxRates.append(record({ id: 'fx-2' })));
    });

    const invalid: [string, Partial<Record<keyof FxRateRecord, unknown>>][] = [
      ['an empty id', { id: '' }],
      ['a pair that is not two codes', { pair: 'EUR' }],
      ['a lowercase pair', { pair: 'eurusd' }],
      ['a non-canonical rate', { rate: '1.0850' }],
      ['a zero rate', { rate: '0' }],
      ['a negative rate', { rate: '-1.08' }],
      ['an exponent rate', { rate: '1e0' }],
      ['a native number rate', { rate: 1.085 }],
      ['observedAt without milliseconds', { observedAt: '2026-11-06T15:00:00Z' }],
      ['recordedAt with an offset', { recordedAt: '2026-11-06T16:00:00.000+01:00' }],
      ['PROVIDER with a conventionId', { conventionId: 'X' }],
      ['PUBLICATION_CONVENTION without a conventionId', { observedAtBasis: 'PUBLICATION_CONVENTION' }],
      ['an unknown basis', { observedAtBasis: 'MEASURED' }],
      ['an empty source', { source: '' }],
      ['an unknown source kind', { sourceKind: 'IDENTITY' }],
    ];

    it.each(invalid)('rejects %s without echoing it', (_name, overrides) => {
      const [field, value] = Object.entries(overrides)[0] ?? [];
      // Messages may name allowed enum values (PROVIDER, REAL, ...); data values are never echoed.
      const isData = field !== 'observedAtBasis' && field !== 'sourceKind';
      expectViolation(
        createUow(),
        (tx) => tx.fxRates.append(record(overrides)),
        isData && typeof value === 'string' && value.length > 1 ? value : undefined,
      );
    });

    it('a failed commit leaves no record (atomic with the rest of the unit of work)', () => {
      const uow = createUow();
      uow.failNextCommit({ atWrite: 1 });
      expect(() =>
        uow.run((tx) => {
          tx.fxRates.append(record());
          tx.fxRates.append(record({ id: 'fx-2', observedAt: '2026-11-06T15:30:00.000Z' }));
        }),
      ).toThrow(PersistenceError);
      expect(uow.snapshot().fxRates).toEqual([]);
      uow.run((tx) => tx.fxRates.append(record()));
      expect(uow.snapshot().fxRates).toHaveLength(1);
    });

    it('a unit of work that throws rolls its FX writes back', () => {
      const uow = createUow();
      expect(() =>
        uow.run((tx) => {
          tx.fxRates.append(record());
          throw new Error('rollback');
        }),
      ).toThrow('rollback');
      expect(uow.snapshot().fxRates).toEqual([]);
    });
  });
});
