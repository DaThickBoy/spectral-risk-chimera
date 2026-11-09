// OD-12: the alert, alert-state, portfolio, and audit repository contract on every adapter
// (in-memory, SQLite memory, SQLite file). Same rules, same messages, no echoed values.
// Validates: Requirements 19.4, 22.6, 34.5, 34.6, 4.3, A-7
import { describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { AlertRecord, AlertStateRecord, Repositories } from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { ADAPTERS } from '../../helpers/persistenceAdapters.js';
import type { TestUnitOfWork } from '../../helpers/persistenceAdapters.js';

const AT = '2026-11-08T12:00:00.000Z';

const alert = (overrides: Partial<AlertRecord> = {}): AlertRecord => ({
  id: 'alert-1',
  type: 'VAR',
  source: 'var-alert-evaluator',
  portfolioId: 'pf-1',
  ticker: null,
  severity: 'WARNING',
  metric: 'BASE_VAR_PCT_NAV',
  observed: brandDecimalString('16.5'),
  threshold: brandDecimalString('15'),
  triggeredTickers: ['AAA', 'BBB'],
  createdAt: AT,
  description: 'WARNING: test alert.',
  state: 'OPEN',
  stateChangedAt: null,
  delivery: 'PENDING',
  deliveryAttempts: 0,
  lastAttemptAt: null,
  ...overrides,
});

const state = (overrides: Partial<AlertStateRecord> = {}): AlertStateRecord => ({
  type: 'VAR',
  portfolioId: 'pf-1',
  ticker: null,
  phase: 'BREACHED',
  lastSeverity: 'WARNING',
  lastAlertAt: AT,
  lastAlertId: 'alert-1',
  updatedAt: AT,
  ...overrides,
});

function expectViolation(
  uow: TestUnitOfWork,
  work: (tx: Repositories) => void,
  message: RegExp,
  secret?: string,
) {
  const before = uow.snapshot();
  let caught: unknown;
  try {
    uow.run(work);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PersistenceError);
  expect((caught as PersistenceError).code).toBe('CONSTRAINT_VIOLATION');
  expect((caught as Error).message).toMatch(message);
  if (secret !== undefined) {
    expect((caught as Error).message).not.toContain(secret);
  }
  expect(uow.snapshot()).toEqual(before);
}

describe.each(ADAPTERS)('%s', (_adapter, createUow) => {
  describe('alerts', () => {
    it('round-trips every field exactly, in insertion order, filtered by portfolio and delivery', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.alerts.insert(alert());
        tx.alerts.insert(alert({ id: 'alert-2', portfolioId: 'pf-2', ticker: 'AAA', triggeredTickers: [] }));
        tx.alerts.insert(
          alert({ id: 'alert-3', delivery: 'FAILED', deliveryAttempts: 4, lastAttemptAt: AT }),
        );
      });
      const read = uow.run((tx) => ({
        one: tx.alerts.get('alert-1'),
        pf1: tx.alerts.listByPortfolio('pf-1').map((a) => a.id),
        pending: tx.alerts.listByDelivery('PENDING').map((a) => a.id),
      }));
      expect(read.one).toEqual(alert());
      expect(Object.isFrozen(read.one)).toBe(true);
      expect(read.pf1).toEqual(['alert-1', 'alert-3']);
      expect(read.pending).toEqual(['alert-1', 'alert-2']);
    });

    it('update changes status fields only, keeps the insertion position, and is visible in the same unit', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.alerts.insert(alert());
        tx.alerts.insert(alert({ id: 'alert-2' }));
      });
      uow.run((tx) => {
        tx.alerts.update(alert({ delivery: 'DELIVERED', deliveryAttempts: 1, lastAttemptAt: AT }));
        expect(tx.alerts.get('alert-1')?.delivery).toBe('DELIVERED');
      });
      expect(uow.snapshot().alerts.map((a) => [a.id, a.delivery])).toEqual([
        ['alert-1', 'DELIVERED'],
        ['alert-2', 'PENDING'],
      ]);
    });

    it.each([
      [/alerts\.id must be unique/, (tx: Repositories) => tx.alerts.insert(alert())],
      [/alerts\.id to update does not exist/, (tx: Repositories) => tx.alerts.update(alert({ id: 'nope' }))],
      [
        /observed cannot change/,
        (tx: Repositories) => tx.alerts.update(alert({ observed: brandDecimalString('99') })),
      ],
      [
        /observed must be a canonical decimal/,
        (tx: Repositories) => tx.alerts.insert(alert({ id: 'x', observed: brandDecimalString('16.50') })),
      ],
    ])('refuses %s without changing anything', (message, work) => {
      const uow = createUow();
      uow.run((tx) => tx.alerts.insert(alert()));
      expectViolation(uow, work, message, '16.50');
    });

    it('status never moves backwards', () => {
      const uow = createUow();
      uow.run((tx) =>
        tx.alerts.insert(
          alert({
            state: 'DISMISSED',
            stateChangedAt: AT,
            delivery: 'DELIVERED',
            deliveryAttempts: 1,
            lastAttemptAt: AT,
          }),
        ),
      );
      expectViolation(
        uow,
        (tx) => tx.alerts.update(alert({ delivery: 'DELIVERED', deliveryAttempts: 1, lastAttemptAt: AT })),
        /state cannot change/,
      );
      expectViolation(
        uow,
        (tx) =>
          tx.alerts.update(
            alert({
              state: 'DISMISSED',
              stateChangedAt: AT,
              delivery: 'PENDING',
              deliveryAttempts: 1,
              lastAttemptAt: AT,
            }),
          ),
        /delivery cannot change/,
      );
    });
  });

  describe('alert state', () => {
    it('upserts per (type, portfolio, ticker) with null and non-null tickers kept apart, first-insertion order kept', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.alertState.upsert(state());
        tx.alertState.upsert(
          state({ ticker: 'AAA', phase: 'ARMED', lastSeverity: null, lastAlertAt: null, lastAlertId: null }),
        );
        tx.alertState.upsert(state({ phase: 'REARMING' }));
      });
      expect(uow.snapshot().alertState.map((s) => [s.ticker, s.phase])).toEqual([
        [null, 'REARMING'],
        ['AAA', 'ARMED'],
      ]);
      expect(uow.run((tx) => tx.alertState.get('VAR', 'pf-1', null))).toEqual(state({ phase: 'REARMING' }));
      expect(uow.run((tx) => tx.alertState.get('FILING_RISK', 'pf-1', null))).toBeUndefined();
    });

    it('refuses a partial last alert', () => {
      const uow = createUow();
      expectViolation(
        uow,
        (tx) => tx.alertState.upsert(state({ lastAlertId: null })),
        /must all be set or all be null/,
      );
    });
  });

  describe('portfolios and audit', () => {
    it('portfolio cash keeps its canonical text, including "0" and negatives; ids are unique', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.portfolios.insert({ id: 'pf-1', baseCurrency: 'USD', cash: brandDecimalString('-250.5') });
        tx.portfolios.insert({ id: 'pf-2', baseCurrency: 'USD', cash: brandDecimalString('0') });
      });
      expect(uow.run((tx) => [tx.portfolios.get('pf-1')?.cash, tx.portfolios.get('pf-2')?.cash])).toEqual([
        '-250.5',
        '0',
      ]);
      expectViolation(
        uow,
        (tx) => tx.portfolios.insert({ id: 'pf-1', baseCurrency: 'USD', cash: brandDecimalString('1') }),
        /portfolios\.id must be unique/,
      );
      expectViolation(
        uow,
        (tx) => tx.portfolios.insert({ id: 'pf-3', baseCurrency: 'USD', cash: brandDecimalString('-0') }),
        /cash must be a canonical decimal/,
      );
    });

    it('audit entries keep their details (strings and booleans) and append order', () => {
      const uow = createUow();
      uow.run((tx) => {
        tx.audit.append({
          id: 'a-2',
          at: AT,
          category: 'ALERT',
          type: 'ALERT_RAISED',
          details: { z: 'last', a: true },
        });
        tx.audit.append({
          id: 'a-1',
          at: AT,
          category: 'IMPORT',
          type: 'IMPORT_COMMITTED',
          subject: 'pf-1',
          actor: 'test',
          details: {},
        });
      });
      const list = uow.run((tx) => tx.audit.list());
      expect(list).toEqual([
        { id: 'a-2', at: AT, category: 'ALERT', type: 'ALERT_RAISED', details: { z: 'last', a: true } },
        {
          id: 'a-1',
          at: AT,
          category: 'IMPORT',
          type: 'IMPORT_COMMITTED',
          subject: 'pf-1',
          actor: 'test',
          details: {},
        },
      ]);
      expect(Object.keys(list[0]?.details ?? {})).toEqual(['z', 'a']);
      expectViolation(
        uow,
        (tx) => tx.audit.append({ id: 'a-1', at: AT, category: 'ALERT', type: 'X', details: {} }),
        /audit\.id must be unique/,
      );
    });
  });
});
