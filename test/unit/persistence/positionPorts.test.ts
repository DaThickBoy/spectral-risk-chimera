// Task 6.2 port extensions of the in-memory unit of work: R28.18 ordering columns on
// transactions, the zero-quantity position invariant (FR-13), and PositionRepo.delete
// as part of the unit of work (R5.6).
// Validates: Requirements 5.3, 5.6, 28.18
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { PositionRecord, Repositories } from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { auditEntry, importSummary, position, quarantined, transaction } from '../../helpers/persistence.js';
import { ADAPTERS } from '../../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../../helpers/persistenceAdapters.js';

// OD-12: the same contract runs against every adapter.
describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  const dec = brandDecimalString;

  function expectViolation(uow: TestUnitOfWork, work: (tx: Repositories) => void, field: string): void {
    let caught: unknown;
    try {
      uow.run(work);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect((caught as PersistenceError).code).toBe('CONSTRAINT_VIOLATION');
    expect((caught as Error).message).toContain(field);
  }

  describe('transactions: sourceId and sourceSequence (R28.18)', () => {
    it('stores both ordering columns unchanged', () => {
      const uow = createUow();
      const record = transaction({ sourceId: `FIX:${'c'.repeat(64)}`, sourceSequence: 42 });
      uow.run((tx) => tx.transactions.insert(record));
      expect(uow.snapshot().transactions[0]).toMatchObject({ sourceId: record.sourceId, sourceSequence: 42 });
    });

    it('rejects an empty sourceId', () => {
      expectViolation(createUow(), (tx) => tx.transactions.insert(transaction({ sourceId: '' })), 'sourceId');
    });

    it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      'rejects sourceSequence %s (must be a positive safe integer)',
      (sourceSequence) => {
        const uow = createUow();
        expectViolation(
          uow,
          (tx) => tx.transactions.insert(transaction({ sourceSequence })),
          'sourceSequence',
        );
        expect(uow.snapshot().transactions).toEqual([]);
      },
    );
  });

  describe('positions: zero-quantity invariant (FR-13 rule 4)', () => {
    const flat = (overrides: Partial<PositionRecord> = {}): PositionRecord =>
      position({ signedQuantity: dec('0'), averagePrice: null, isShort: false, ...overrides });

    it('accepts a flat position with averagePrice null and isShort false', () => {
      const uow = createUow();
      uow.run((tx) => tx.positions.upsert(flat()));
      expect(uow.snapshot().positions[0]).toMatchObject({
        signedQuantity: '0',
        averagePrice: null,
        isShort: false,
      });
    });

    it('rejects averagePrice null on a non-zero position', () => {
      expectViolation(
        createUow(),
        (tx) => tx.positions.upsert(flat({ signedQuantity: dec('1') })),
        'averagePrice',
      );
    });

    it('rejects a flat position marked short', () => {
      expectViolation(createUow(), (tx) => tx.positions.upsert(flat({ isShort: true })), 'isShort');
    });

    it('rejects a non-null average price on a zero-quantity position', () => {
      expectViolation(
        createUow(),
        (tx) => tx.positions.upsert(flat({ averagePrice: dec('12.5') })),
        'averagePrice',
      );
    });
  });

  describe('PositionRepo.delete is part of the unit of work (R5.6)', () => {
    const seeded = (): TestUnitOfWork => {
      const uow = createUow();
      uow.run((tx) => {
        tx.positions.upsert(position({ ticker: 'AAA' }));
        tx.positions.upsert(position({ ticker: 'BBB' }));
      });
      return uow;
    };

    it('removes the position; reads in the same unit of work see the removal', () => {
      const uow = seeded();
      uow.run((tx) => {
        tx.positions.delete('pf-1', 'AAA');
        expect(tx.positions.get('pf-1', 'AAA')).toBeUndefined();
        expect(tx.positions.listByPortfolio('pf-1').map((p) => p.ticker)).toEqual(['BBB']);
      });
      expect(uow.snapshot().positions.map((p) => p.ticker)).toEqual(['BBB']);
      expect(uow.lastAttempt?.writes).toEqual([{ repository: 'positions', operation: 'delete' }]);
    });

    it('other units of work see the removal only after the commit', () => {
      const uow = seeded();
      expect(() =>
        uow.run((tx) => {
          tx.positions.delete('pf-1', 'AAA');
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect(uow.snapshot().positions.map((p) => p.ticker)).toEqual(['AAA', 'BBB']);
    });

    it('deleting a position that does not exist violates a constraint and rolls back the unit of work', () => {
      const uow = seeded();
      const before = uow.snapshot();
      expectViolation(
        uow,
        (tx) => {
          tx.positions.upsert(position({ ticker: 'CCC' }));
          tx.positions.delete('pf-1', 'MISSING');
        },
        'delete',
      );
      expectViolation(uow, (tx) => tx.positions.delete('pf-2', 'AAA'), 'delete');
      expect(uow.snapshot()).toEqual(before);
    });

    it.each([0, 1, 2, 3])(
      'a commit failure at write %i leaves every upsert and delete unapplied',
      (atWrite) => {
        const uow = seeded();
        const before = uow.snapshot();
        uow.failNextCommit({ atWrite });
        let caught: unknown;
        try {
          uow.run((tx) => {
            tx.positions.delete('pf-1', 'AAA');
            tx.positions.upsert(position({ ticker: 'BBB', signedQuantity: dec('11') }));
            tx.positions.upsert(position({ ticker: 'CCC' }));
          });
        } catch (error) {
          caught = error;
        }
        expect((caught as PersistenceError).code).toBe('COMMIT_FAILED');
        expect(uow.lastAttempt?.writes.map((w) => w.operation)).toEqual(['delete', 'upsert', 'upsert']);
        expect(uow.snapshot()).toEqual(before);
      },
    );

    it('the ledger still has no delete operation', () => {
      const uow = createUow();
      uow.run((tx) => {
        expect(Object.keys(tx.transactions).sort()).toEqual(['findByKey', 'insert', 'listByPortfolio']);
        expect(Object.keys(tx.positions).sort()).toEqual(['delete', 'get', 'listByPortfolio', 'upsert']);
      });
    });
  });

  describe('IsoUtc columns: canonical fixed-width UTC timestamps at the write boundary', () => {
    const INVALID: [string, string][] = [
      ['malformed', 'not a time'],
      ['date only', '2026-11-06'],
      ['offset', '2026-11-06T12:00:00.000+02:00'],
      ['no fraction', '2026-11-06T10:00:00Z'],
      ['microseconds', '2026-11-06T10:00:00.000000Z'],
      ['impossible date', '2026-02-30T10:00:00.000Z'],
      ['impossible time', '2026-11-06T24:00:00.000Z'],
    ];
    const writes: [string, (text: string) => (tx: Repositories) => void][] = [
      ['tradeTimestamp', (text) => (tx) => tx.transactions.insert(transaction({ tradeTimestamp: text }))],
      ['createdAt', (text) => (tx) => tx.transactions.insert(transaction({ createdAt: text }))],
      ['importedAt', (text) => (tx) => tx.imports.insert(importSummary({ importedAt: text }))],
      ['createdAt', (text) => (tx) => tx.quarantine.insert(quarantined({ createdAt: text }))],
      ['updatedAt', (text) => (tx) => tx.positions.upsert(position({ updatedAt: text }))],
      ['at', (text) => (tx) => tx.audit.append(auditEntry({ at: text }))],
      // Task 9.4: series_retrievals.retrieved_at (the content row is rolled back with it).
      [
        'retrievedAt',
        (text) => (tx) => {
          tx.series.insertContent({
            contentHash: 'a'.repeat(64),
            ticker: 'AAA',
            currency: 'USD',
            observations: [],
          });
          tx.series.appendRetrieval({
            contentHash: 'a'.repeat(64),
            ticker: 'AAA',
            source: 'fixture',
            sourceKind: 'REAL',
            retrievedAt: text,
          });
        },
      ],
      // Task 10.3: fx_rates.observed_at and fx_rates.recorded_at.
      ...(['observedAt', 'recordedAt'] as const).map(
        (field): [string, (text: string) => (tx: Repositories) => void] => [
          field,
          (text) => (tx) =>
            tx.fxRates.append({
              id: 'fx-1',
              pair: 'EURUSD',
              rate: brandDecimalString('1.085'),
              observedAt: '2026-11-06T15:00:00.000Z',
              observedAtBasis: 'PROVIDER',
              source: 'fixture',
              sourceKind: 'REAL',
              recordedAt: '2026-11-06T16:00:00.000Z',
              [field]: text,
            }),
        ],
      ),
      // Task 12.3: risk_results.calculated_at.
      [
        'calculatedAt',
        (text) => (tx) =>
          tx.riskResults.append({
            id: 'rr-1',
            portfolioId: 'pf-1',
            calculatedAt: text,
            status: 'CONFIG_MISSING',
            configVersionSeq: 1,
            configVersionHash: 'c'.repeat(64),
            snapshotHash: null,
            snapshotId: null,
            body: '{}',
          }),
      ],
      // Task 12.5: calc_snapshots.created_at and evaluated_at.
      ...(['createdAt', 'evaluatedAt'] as const).map(
        (field): [string, (text: string) => (tx: Repositories) => void] => [
          field,
          (text) => (tx) =>
            tx.snapshots.insert({
              id: 'snap-1',
              portfolioId: 'pf-1',
              hash: 'a'.repeat(64),
              createdAt: '2026-11-06T16:00:00.000Z',
              evaluatedAt: '2026-11-06T16:00:00.000Z',
              snapshot: '{}',
              inputsCanonical: '{}',
              [field]: text,
            }),
        ],
      ),
    ];

    it.each(INVALID)('rejects a %s value in every IsoUtc column, without echoing it', (_label, text) => {
      for (const [field, write] of writes) {
        const uow = createUow();
        let caught: unknown;
        try {
          uow.run(write(text));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(PersistenceError);
        expect((caught as PersistenceError).code).toBe('CONSTRAINT_VIOLATION');
        expect((caught as Error).message).toContain(field);
        expect((caught as Error).message).not.toContain(text);
        expect(uow.snapshot()).toEqual({
          transactions: [],
          imports: [],
          quarantine: [],
          positions: [],
          audit: [],
          seriesContent: [],
          seriesRetrievals: [],
          fxRates: [],
          portfolios: [],
          riskResults: [],
          snapshots: [],
          alertState: [],
          alerts: [],
        });
      }
    });

    it('accepts the canonical form in every IsoUtc column', () => {
      const text = '2024-02-29T23:59:59.999Z';
      for (const [, write] of writes) {
        const uow = createUow();
        expect(() => uow.run(write(text))).not.toThrow();
      }
    });
  });
});
