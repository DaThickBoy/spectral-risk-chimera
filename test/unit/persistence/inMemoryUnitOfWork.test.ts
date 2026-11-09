// Task 5.1: persistence ports and the in-memory unit of work (commit, rollback,
// isolation, commit-failure injection at every write, decimal-string financial fields).
// Validates: Requirements 4.3, 28.15, 28.16
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { InMemorySnapshot, Repositories, TransactionRecord } from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { auditEntry, importSummary, position, quarantined, transaction } from '../../helpers/persistence.js';
import { ADAPTERS, committedView } from '../../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../../helpers/persistenceAdapters.js';

// OD-12: the same contract runs against every adapter.
describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  const expectPersistenceError = (fn: () => unknown, code: PersistenceError['code']): PersistenceError => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe(code);
      return error as PersistenceError;
    }
    throw new Error('expected a PersistenceError');
  };

  /** A committed base state, so rollback is checked against non-empty data. */
  const seeded = (): TestUnitOfWork => {
    const uow = createUow();
    uow.run((tx) => {
      tx.imports.insert(importSummary({ id: 'imp-0', status: 'COMMITTED' }));
      tx.transactions.insert(transaction({ id: 'tx-0', transactionKey: '0'.repeat(64), importId: 'imp-0' }));
      tx.positions.upsert(position());
      tx.audit.append(auditEntry({ id: 'audit-0' }));
    });
    return uow;
  };

  /** One import: every repository and operation kind, plus a position replaced in place. */
  const importWork = (tx: Repositories): string => {
    tx.imports.insert(importSummary());
    tx.transactions.insert(transaction({ id: 'tx-1', transactionKey: '1'.repeat(64) }));
    tx.transactions.insert(
      transaction({
        id: 'tx-2',
        transactionKey: '2'.repeat(64),
        type: 'SELL',
        quantity: brandDecimalString('4'),
      }),
    );
    tx.quarantine.insert(quarantined());
    tx.positions.upsert(
      position({ signedQuantity: brandDecimalString('16'), averagePrice: brandDecimalString('12.25') }),
    );
    tx.audit.append(auditEntry({ id: 'audit-1' }));
    return 'done';
  };

  describe('commit', () => {
    it('commits every write together and returns the work result', () => {
      const uow = seeded();
      expect(uow.run(importWork)).toBe('done');
      const state = uow.snapshot();
      expect(state.transactions.map((t) => t.id)).toEqual(['tx-0', 'tx-1', 'tx-2']);
      expect(state.imports.map((i) => i.id)).toEqual(['imp-0', 'imp-1']);
      expect(state.quarantine.map((q) => q.id)).toEqual(['q-1']);
      expect(state.positions).toHaveLength(1);
      expect(state.positions[0]?.signedQuantity).toBe('16');
      expect(state.audit.map((a) => a.id)).toEqual(['audit-0', 'audit-1']);
      expect(uow.lastAttempt?.outcome).toBe('COMMITTED');
      expect(uow.lastAttempt?.writes).toEqual([
        { repository: 'imports', operation: 'insert' },
        { repository: 'transactions', operation: 'insert' },
        { repository: 'transactions', operation: 'insert' },
        { repository: 'quarantine', operation: 'insert' },
        { repository: 'positions', operation: 'upsert' },
        { repository: 'audit', operation: 'append' },
      ]);
    });

    it('a work function with no writes commits nothing and succeeds', () => {
      const uow = seeded();
      const before = uow.snapshot();
      expect(uow.run((tx) => tx.transactions.listByPortfolio('pf-1').length)).toBe(1);
      expect(uow.snapshot()).toEqual(before);
      expect(uow.lastAttempt).toEqual({ writes: [], outcome: 'COMMITTED' });
    });
  });

  describe('isolation', () => {
    it('reads inside the transaction see its own writes; committed state does not until commit', () => {
      const uow = seeded();
      uow.run((tx) => {
        tx.transactions.insert(transaction({ id: 'tx-9', transactionKey: '9'.repeat(64) }));
        expect(tx.transactions.findByKey('pf-1', '9'.repeat(64))?.id).toBe('tx-9');
        expect(tx.transactions.listByPortfolio('pf-1').map((t) => t.id)).toEqual(['tx-0', 'tx-9']);
        const view = committedView(uow); // another reader (SQLite: a second connection)
        if (view !== undefined) {
          expect(view.transactions.map((t) => t.id)).toEqual(['tx-0']);
        }
      });
      expect(uow.snapshot().transactions.map((t) => t.id)).toEqual(['tx-0', 'tx-9']);
    });

    it('list and find queries filter by portfolio, import, and ticker', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.transactions.insert(transaction({ id: 'a', transactionKey: 'k' }));
        tx.transactions.insert(transaction({ id: 'b', portfolioId: 'pf-2', transactionKey: 'k' }));
        tx.quarantine.insert(quarantined({ id: 'q-a', importId: 'imp-a' }));
        tx.quarantine.insert(quarantined({ id: 'q-b', importId: 'imp-b' }));
        tx.positions.upsert(position({ ticker: 'BBB' }));
        tx.positions.upsert(position({ ticker: 'AAA' }));
        tx.positions.upsert(position({ portfolioId: 'pf-2', ticker: 'AAA' }));
      });
      uow.run((tx) => {
        expect(tx.transactions.findByKey('pf-2', 'k')?.id).toBe('b');
        expect(tx.transactions.findByKey('pf-3', 'k')).toBeUndefined();
        expect(tx.quarantine.listByImport('imp-b').map((q) => q.id)).toEqual(['q-b']);
        expect(tx.positions.listByPortfolio('pf-1').map((p) => p.ticker)).toEqual(['BBB', 'AAA']);
        expect(tx.positions.get('pf-2', 'AAA')?.portfolioId).toBe('pf-2');
        expect(tx.imports.get('missing')).toBeUndefined();
      });
    });

    it('separate units of work have separate state', () => {
      const a = seeded();
      const b = createUow();
      a.run(importWork);
      expect(b.snapshot().transactions).toEqual([]);
    });

    it('repositories cannot be used after their unit of work ends', () => {
      const uow = createUow();
      let captured: Repositories | undefined;
      uow.run((tx) => {
        captured = tx;
      });
      expect(() => captured?.audit.append(auditEntry({ id: 'late' }))).toThrow('outside their unit of work');
      expect(() => captured?.imports.get('imp-1')).toThrow('outside their unit of work');
      expect(uow.snapshot().audit).toEqual([]);
    });

    it('nested units of work are rejected and roll back the outer one', () => {
      const uow = seeded();
      const before = uow.snapshot();
      expect(() =>
        uow.run((tx) => {
          tx.audit.append(auditEntry({ id: 'outer' }));
          uow.run(() => undefined);
        }),
      ).toThrow('Nested units of work');
      expect(uow.snapshot()).toEqual(before);
      // The unit of work is usable again afterwards.
      uow.run((tx) => tx.audit.append(auditEntry({ id: 'after' })));
      expect(uow.snapshot().audit.map((a) => a.id)).toEqual(['audit-0', 'after']);
    });
  });

  describe('rollback', () => {
    it('a throwing work function leaves committed state unchanged and rethrows', () => {
      const uow = seeded();
      const before = uow.snapshot();
      const failure = new Error('validation failed mid-import');
      expect(() =>
        uow.run((tx) => {
          importWork(tx);
          throw failure;
        }),
      ).toThrow(failure);
      expect(uow.snapshot()).toEqual(before);
      expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');
    });

    it('asynchronous work is rejected and rolled back, so no write can land after the commit', () => {
      const uow = seeded();
      const before = uow.snapshot();
      expect(() =>
        uow.run((tx) => {
          tx.audit.append(auditEntry({ id: 'async' }));
          return Promise.resolve('late');
        }),
      ).toThrow(TypeError);
      expect(uow.snapshot()).toEqual(before);
    });
  });

  describe('asynchronous work is rejected without unhandled rejections', () => {
    const syncOnly = 'UnitOfWork.run requires synchronous work; a promise was returned.';

    /** Records unhandled rejections until disposed; always disposed in `finally`. */
    const trackUnhandledRejections = (): { reasons: unknown[]; dispose: () => void } => {
      const reasons: unknown[] = [];
      const listener = (reason: unknown): void => {
        reasons.push(reason);
      };
      process.on('unhandledRejection', listener);
      return { reasons, dispose: () => process.off('unhandledRejection', listener) };
    };

    /** Lets pending promise jobs run and Node report any unhandled rejection. */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    it('an async callback that rejects before its first await', async () => {
      const tracker = trackUnhandledRejections();
      try {
        const uow = seeded();
        const before = uow.snapshot();
        expect(() =>
          uow.run(async (tx) => {
            tx.audit.append(auditEntry({ id: 'before-reject' }));
            throw new Error('rejected before await');
          }),
        ).toThrow(new TypeError(syncOnly));
        await settle();

        expect(tracker.reasons).toEqual([]);
        expect(uow.snapshot()).toEqual(before);
        expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');

        // The unit of work is usable afterwards.
        uow.run((tx) => tx.audit.append(auditEntry({ id: 'after-reject' })));
        expect(uow.snapshot().audit.map((entry) => entry.id)).toEqual(['audit-0', 'after-reject']);
      } finally {
        tracker.dispose();
      }
    });

    it('an async callback whose repository write after await is rejected by the ownership guard', async () => {
      const tracker = trackUnhandledRejections();
      try {
        const uow = seeded();
        const before = uow.snapshot();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let guardError: unknown;
        expect(() =>
          uow.run(async (tx) => {
            tx.audit.append(auditEntry({ id: 'before-await' }));
            await gate;
            try {
              tx.audit.append(auditEntry({ id: 'after-await' }));
            } catch (error) {
              guardError = error;
              throw error; // keep the rejection path the fix must handle
            }
          }),
        ).toThrow(new TypeError(syncOnly));

        // Resume the callback after its unit of work has closed.
        release();
        await settle();

        expect(guardError).toBeInstanceOf(Error);
        expect((guardError as Error).message).toBe('Repositories were used outside their unit of work.');
        expect(tracker.reasons).toEqual([]);
        expect(uow.snapshot()).toEqual(before);

        uow.run((tx) => tx.audit.append(auditEntry({ id: 'after-guard' })));
        expect(uow.snapshot().audit.map((entry) => entry.id)).toEqual(['audit-0', 'after-guard']);
      } finally {
        tracker.dispose();
      }
    });

    it("reads a custom thenable's then once and calls it once with a rejection handler", async () => {
      const tracker = trackUnhandledRejections();
      try {
        const uow = createUow();
        let thenReads = 0;
        const calls: unknown[][] = [];
        const thenable = {
          get then() {
            thenReads += 1;
            return (...args: unknown[]) => {
              calls.push(args);
            };
          },
        };
        expect(() => uow.run(() => thenable)).toThrow(new TypeError(syncOnly));
        await settle();
        expect(thenReads).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0]).toBeUndefined();
        expect(typeof calls[0]?.[1]).toBe('function');
        expect(tracker.reasons).toEqual([]);
      } finally {
        tracker.dispose();
      }
    });

    it('a custom thenable whose then returns a rejected promise causes no unhandled rejection', async () => {
      const tracker = trackUnhandledRejections();
      try {
        const uow = seeded();
        const before = uow.snapshot();
        let thenReads = 0;
        let thenCalls = 0;
        const thenable = {
          get then() {
            thenReads += 1;
            return () => {
              thenCalls += 1;
              return Promise.reject(new Error('rejection returned by a custom then'));
            };
          },
        };
        expect(() =>
          uow.run((tx) => {
            tx.audit.append(auditEntry({ id: 'returned-rejection' }));
            return thenable;
          }),
        ).toThrow(new TypeError(syncOnly));
        await settle();

        expect(tracker.reasons).toEqual([]);
        expect(thenReads).toBe(1);
        expect(thenCalls).toBe(1);
        expect(uow.snapshot()).toEqual(before);
        expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');

        uow.run((tx) => tx.audit.append(auditEntry({ id: 'after-returned-rejection' })));
        expect(uow.snapshot().audit.map((entry) => entry.id)).toEqual([
          'audit-0',
          'after-returned-rejection',
        ]);
      } finally {
        tracker.dispose();
      }
    });

    it('a custom then that returns its own thenable is not invoked again', async () => {
      const tracker = trackUnhandledRejections();
      try {
        const uow = createUow();
        let thenCalls = 0;
        const thenable: { then: () => unknown } = {
          then: () => {
            thenCalls += 1;
            return thenable;
          },
        };
        expect(() => uow.run(() => thenable)).toThrow(new TypeError(syncOnly));
        await settle();
        expect(thenCalls).toBe(1);
        expect(tracker.reasons).toEqual([]);
      } finally {
        tracker.dispose();
      }
    });

    it('a custom thenable whose then throws still yields the TypeError and rolls back', () => {
      const uow = seeded();
      const before = uow.snapshot();
      const thenable = {
        then: () => {
          throw new Error('broken then');
        },
      };
      expect(() =>
        uow.run((tx) => {
          tx.audit.append(auditEntry({ id: 'broken' }));
          return thenable;
        }),
      ).toThrow(new TypeError(syncOnly));
      expect(uow.snapshot()).toEqual(before);
    });

    it('listeners added by these tests are removed', () => {
      const before = process.listenerCount('unhandledRejection');
      trackUnhandledRejections().dispose();
      expect(process.listenerCount('unhandledRejection')).toBe(before);
    });
  });

  describe('constraints', () => {
    it('rejects a duplicate (portfolioId, transactionKey), within the transaction and against committed data', () => {
      const uow = seeded();
      const before = uow.snapshot();
      expectPersistenceError(
        () =>
          uow.run((tx) => {
            tx.transactions.insert(transaction({ id: 'x', transactionKey: '5'.repeat(64) }));
            tx.transactions.insert(transaction({ id: 'y', transactionKey: '5'.repeat(64) }));
          }),
        'CONSTRAINT_VIOLATION',
      );
      expectPersistenceError(
        () =>
          uow.run((tx) => tx.transactions.insert(transaction({ id: 'z', transactionKey: '0'.repeat(64) }))),
        'CONSTRAINT_VIOLATION',
      );
      // The same key in another portfolio is allowed (uniqueness is per portfolio).
      uow.run((tx) =>
        tx.transactions.insert(transaction({ id: 'w', portfolioId: 'pf-2', transactionKey: '0'.repeat(64) })),
      );
      expect(uow.snapshot().transactions.map((t) => t.id)).toEqual([
        ...before.transactions.map((t) => t.id),
        'w',
      ]);
    });

    it.each([
      [
        'transactions',
        (tx: Repositories) => tx.transactions.insert(transaction({ id: 'tx-0', transactionKey: 'new' })),
      ],
      ['imports', (tx: Repositories) => tx.imports.insert(importSummary({ id: 'imp-0' }))],
      ['audit', (tx: Repositories) => tx.audit.append(auditEntry({ id: 'audit-0' }))],
      [
        'quarantine',
        (tx: Repositories) => {
          tx.quarantine.insert(quarantined({ id: 'dup' }));
          tx.quarantine.insert(quarantined({ id: 'dup' }));
        },
      ],
    ])('rejects a duplicate %s id and rolls back the whole transaction', (_name, write) => {
      const uow = seeded();
      const before = uow.snapshot();
      expectPersistenceError(
        () =>
          uow.run((tx) => {
            tx.audit.append(auditEntry({ id: 'earlier-write' }));
            write(tx);
          }),
        'CONSTRAINT_VIOLATION',
      );
      expect(uow.snapshot()).toEqual(before);
    });

    it('upsert replaces the position for the same (portfolioId, ticker)', () => {
      const uow = seeded();
      uow.run((tx) =>
        tx.positions.upsert(
          position({ id: 'pos-2', signedQuantity: brandDecimalString('-3'), isShort: true }),
        ),
      );
      const positions = uow.snapshot().positions;
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({ id: 'pos-2', signedQuantity: '-3', isShort: true });
    });
  });

  describe('decimal-string financial fields (R4.3)', () => {
    it('stores canonical decimal strings unchanged', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.transactions.insert(
          transaction({
            quantity: brandDecimalString('0.000001'),
            price: brandDecimalString('123456789.123456789'),
          }),
        );
        tx.positions.upsert(
          position({ signedQuantity: brandDecimalString('-12.5'), averagePrice: brandDecimalString('0') }),
        );
      });
      const { transactions, positions } = uow.snapshot();
      expect(transactions[0]).toMatchObject({ quantity: '0.000001', price: '123456789.123456789' });
      expect(positions[0]).toMatchObject({ signedQuantity: '-12.5', averagePrice: '0' });
    });

    it.each(['1.50', '-0', '010', '1e3', ' 1', '', 'NaN'])(
      'rejects the non-canonical or invalid value %j at write time without echoing it',
      (text) => {
        const uow = seeded();
        const before = uow.snapshot();
        const fields: [string, (tx: Repositories) => void][] = [
          [
            'quantity',
            (tx) =>
              tx.transactions.insert(transaction({ id: 'n', transactionKey: 'n', quantity: text as never })),
          ],
          [
            'price',
            (tx) =>
              tx.transactions.insert(transaction({ id: 'n', transactionKey: 'n', price: text as never })),
          ],
          ['signedQuantity', (tx) => tx.positions.upsert(position({ signedQuantity: text as never }))],
          ['averagePrice', (tx) => tx.positions.upsert(position({ averagePrice: text as never }))],
        ];
        for (const [field, write] of fields) {
          const error = expectPersistenceError(() => uow.run(write), 'CONSTRAINT_VIOLATION');
          expect(error.message).toContain(field);
          if (text !== '') {
            expect(error.message).not.toContain(`"${text}"`);
          }
        }
        expect(uow.snapshot()).toEqual(before);
      },
    );

    it('rejects native numbers for financial fields, at the type level and at run time', () => {
      const uow = createUow();
      // @ts-expect-error A JavaScript number is not a DecimalString.
      const numeric: TransactionRecord = { ...transaction(), quantity: 10 };
      // @ts-expect-error A plain string is not a DecimalString either; it must be validated first.
      const plain: TransactionRecord = { ...transaction(), price: '12.5' };
      expect(plain.price).toBe('12.5');
      expectPersistenceError(() => uow.run((tx) => tx.transactions.insert(numeric)), 'CONSTRAINT_VIOLATION');
      expectPersistenceError(
        () => uow.run((tx) => tx.positions.upsert({ ...position(), averagePrice: 12.5 as never })),
        'CONSTRAINT_VIOLATION',
      );
    });

    it('audit details accept strings and booleans only', () => {
      const uow = createUow();
      // @ts-expect-error Audit details never carry native numbers.
      const withNumber = auditEntry({ details: { amount: 1000.5 } });
      expectPersistenceError(() => uow.run((tx) => tx.audit.append(withNumber)), 'CONSTRAINT_VIOLATION');
      uow.run((tx) => tx.audit.append(auditEntry({ details: { amount: '1000.5', redacted: true } })));
      expect(uow.snapshot().audit[0]?.details).toEqual({ amount: '1000.5', redacted: true });
    });
  });

  describe('stored records are detached and immutable', () => {
    it('mutating an input after insert does not change stored state', () => {
      const uow = createUow();
      const details: Record<string, string | boolean> = { note: 'original' };
      uow.run((tx) => tx.audit.append(auditEntry({ details })));
      details['note'] = 'changed';
      expect(uow.snapshot().audit[0]?.details).toEqual({ note: 'original' });
    });

    it('returned records are frozen', () => {
      const uow = seeded();
      const [stored] = uow.snapshot().transactions;
      expect(Object.isFrozen(stored)).toBe(true);
      expect(() => {
        (stored as { quantity: string }).quantity = '999';
      }).toThrow(TypeError);
      expect(Object.isFrozen(uow.snapshot().audit[0]?.details)).toBe(true);
    });

    it('the audit repository has no update or delete operation', () => {
      const uow = createUow();
      uow.run((tx) => {
        // @ts-expect-error Append-only: no update operation exists.
        expect(tx.audit.update).toBeUndefined();
        // @ts-expect-error Append-only: no delete operation exists.
        expect(tx.audit.delete).toBeUndefined();
        expect(Object.keys(tx.audit).sort()).toEqual(['append', 'list']);
      });
    });
  });

  describe('commit-failure injection (Property 21 support)', () => {
    const writeCount = (() => {
      const probe = seeded();
      probe.run(importWork);
      return probe.lastAttempt?.writes.length ?? 0;
    })();

    it('the import work has six write positions plus the final publish step', () => {
      expect(writeCount).toBe(6);
    });

    it.each(Array.from({ length: writeCount + 1 }, (_, index) => index))(
      'a failure injected at write %i leaves every repository unchanged',
      (atWrite) => {
        const uow = seeded();
        const before: InMemorySnapshot = uow.snapshot();
        uow.failNextCommit({ atWrite });
        expectPersistenceError(() => uow.run(importWork), 'COMMIT_FAILED');
        expect(uow.snapshot()).toEqual(before);
        expect(uow.lastAttempt).toMatchObject({ outcome: 'COMMIT_FAILED' });
        expect(uow.lastAttempt?.writes).toHaveLength(writeCount);

        // The fault is one-shot: the same work then commits normally.
        expect(uow.run(importWork)).toBe('done');
        const after = uow.snapshot();
        expect(after.transactions).toHaveLength(before.transactions.length + 2);
        expect(after.imports).toHaveLength(before.imports.length + 1);
        expect(after.quarantine).toHaveLength(1);
        expect(after.audit).toHaveLength(before.audit.length + 1);
        expect(uow.lastAttempt?.outcome).toBe('COMMITTED');
      },
    );

    it('a fault beyond the last write position is not triggered and is consumed', () => {
      const uow = seeded();
      uow.failNextCommit({ atWrite: writeCount + 1 });
      expect(uow.run(importWork)).toBe('done');
      expect(uow.lastAttempt?.outcome).toBe('COMMITTED');
      uow.run((tx) => tx.audit.append(auditEntry({ id: 'next' })));
      expect(uow.lastAttempt?.outcome).toBe('COMMITTED');
    });

    it('a fault is consumed only by a commit attempt, not by a rolled-back transaction', () => {
      const uow = seeded();
      const before = uow.snapshot();
      uow.failNextCommit({ atWrite: 0 });
      expect(() =>
        uow.run(() => {
          throw new Error('rolled back before commit');
        }),
      ).toThrow('rolled back before commit');
      expectPersistenceError(() => uow.run(importWork), 'COMMIT_FAILED');
      expect(uow.snapshot()).toEqual(before);
    });

    it.each([-1, 1.5, Number.NaN])('rejects the invalid write position %s', (atWrite) => {
      expect(() => createUow().failNextCommit({ atWrite })).toThrow(RangeError);
    });
  });
});
