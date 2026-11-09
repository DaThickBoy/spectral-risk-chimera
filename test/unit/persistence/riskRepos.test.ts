// Tasks 12.3 and 12.5: risk result and snapshot repositories of the in-memory unit of work
// (design: Persistence; R13.5, R32.1, R32.4). Bodies are canonical JSON text; no float storage.
// Validates: Requirements 13.5, 32.1, 32.4, 4.3
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { RiskResultRecord, SnapshotRecord } from '../../../src/persistence/index.js';
import { ADAPTERS } from '../../helpers/persistenceAdapters.js';

// OD-12: the same contract runs against every adapter.
describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  const AT = '2026-11-08T12:00:00.000Z';
  const snapshot = (overrides: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
    id: 's-1',
    portfolioId: 'pf-1',
    hash: 'a'.repeat(64),
    createdAt: AT,
    evaluatedAt: AT,
    snapshot: '{"cash":"100"}',
    inputsCanonical: '{"cash":"100"}',
    ...overrides,
  });
  const result = (overrides: Partial<RiskResultRecord> = {}): RiskResultRecord => ({
    id: 'r-1',
    portfolioId: 'pf-1',
    calculatedAt: AT,
    status: 'OK',
    configVersionSeq: 1,
    configVersionHash: 'c'.repeat(64),
    snapshotHash: 'a'.repeat(64),
    snapshotId: 's-1',
    body: '{"kind":"CALCULATED"}',
    ...overrides,
  });

  function violation(work: () => void): string {
    try {
      work();
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe('CONSTRAINT_VIOLATION');
      return (error as Error).message;
    }
    throw new Error('expected a constraint violation');
  }

  describe('snapshots and risk results', () => {
    it('stores snapshots under a non-unique hash and results in append order', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.snapshots.insert(snapshot());
        tx.snapshots.insert(snapshot({ id: 's-2' }));
        tx.riskResults.append(result());
        tx.riskResults.append(result({ id: 'r-2', snapshotId: 's-2' }));
        tx.riskResults.append(
          result({ id: 'r-3', status: 'CONFIG_MISSING', snapshotHash: null, snapshotId: null }),
        );
      });
      expect(uow.run((tx) => tx.snapshots.listByHash('a'.repeat(64)).map((s) => s.id))).toEqual([
        's-1',
        's-2',
      ]);
      expect(uow.run((tx) => tx.riskResults.listByPortfolio('pf-1').map((r) => r.id))).toEqual([
        'r-1',
        'r-2',
        'r-3',
      ]);
      expect(uow.run((tx) => tx.riskResults.listByPortfolio('other'))).toEqual([]);
    });

    it.each([
      ['a float in the body', { body: '{"var":1.5}' }, 'canonical JSON'],
      ['a non-canonical body', { body: '{ "kind": "CALCULATED" }' }, 'canonical JSON'],
      ['a snapshot that does not exist', { snapshotId: 's-x' }, 'snapshotId'],
      ['a hash without a snapshot id', { snapshotId: null }, 'both'],
      ['a malformed configuration hash', { configVersionHash: 'xyz' }, 'configVersionHash'],
      ['a zero configuration sequence', { configVersionSeq: 0 }, 'configVersionSeq'],
    ])('rejects a result with %s', (_label, overrides, message) => {
      const uow = createUow();
      uow.run((tx) => tx.snapshots.insert(snapshot()));
      expect(violation(() => uow.run((tx) => tx.riskResults.append(result(overrides))))).toContain(message);
      expect(uow.snapshot().riskResults).toEqual([]);
    });

    it.each([
      ['a float in the snapshot', { snapshot: '{"cash":100.5}' }],
      ['a malformed hash', { hash: 'abc' }],
      ['non-JSON inputs', { inputsCanonical: 'not json' }],
    ])('rejects a snapshot with %s', (_label, overrides) => {
      const uow = createUow();
      violation(() => uow.run((tx) => tx.snapshots.insert(snapshot(overrides))));
      expect(uow.snapshot().snapshots).toEqual([]);
    });

    it('duplicate ids are rejected; a failed commit stores neither snapshot nor result', () => {
      const uow = createUow();
      uow.run((tx) => tx.snapshots.insert(snapshot()));
      violation(() => uow.run((tx) => tx.snapshots.insert(snapshot())));
      uow.failNextCommit({ atWrite: 1 });
      expect(() =>
        uow.run((tx) => {
          tx.snapshots.insert(snapshot({ id: 's-9' }));
          tx.riskResults.append(result({ snapshotId: 's-9' }));
        }),
      ).toThrow(PersistenceError);
      expect(uow.snapshot().snapshots.map((s) => s.id)).toEqual(['s-1']);
      expect(uow.snapshot().riskResults).toEqual([]);
    });
  });
});
