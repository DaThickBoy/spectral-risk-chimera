// OD-20 (approved 2026-11-09): the provider's quote behind each FX rate is stored beside the
// derived rate in nullable `fx_rates` columns (SQLite migration 2). Covers the migration from the
// previous schema with existing rows, insertion and retrieval on every adapter, rows without a
// quote, restart persistence, database-level consistency, read integrity, the recorder over real
// ECB-recorded data, and the read-back into the positions contract.
// Validates: Requirements 30.5, 30.14, 22.3, 4.3
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEcbFxProvider } from '../../src/adapters/index.js';
import { createRecordingFxService } from '../../src/app/index.js';
import type { ObservedFxRate } from '../../src/app/index.js';
import {
  FX_DERIVATION_PRECISION,
  InMemoryUnitOfWork,
  LATEST_SCHEMA_VERSION,
  PersistenceError,
} from '../../src/persistence/index.js';
import type { SqliteUnitOfWork } from '../../src/persistence/index.js';
import type { FxPublishedQuote, FxRateRecord } from '../../src/persistence/index.js';
import { MIGRATIONS } from '../../src/persistence/sqlite/schema.js';
import { FakeClock, LastValidStore, brandDecimalString, sequentialIds } from '../../src/shared/index.js';
import { recordedTransport } from '../helpers/ecb.js';
import { ADAPTERS, openSqlite, tempDir } from '../helpers/persistenceAdapters.js';
import { drive, harness } from '../helpers/resilience.js';

const DERIVED = '0.8956560680698611733094491715181370353784'; // 1 / 1.1165, 40 significant digits
const record = (overrides: Partial<FxRateRecord> = {}): FxRateRecord => ({
  id: 'fx-1',
  pair: 'USDEUR',
  rate: brandDecimalString(DERIVED),
  observedAt: '2026-11-06T15:00:00.000Z',
  observedAtBasis: 'PUBLICATION_CONVENTION',
  conventionId: 'ECB-PUB-1600-FRANKFURT-v1',
  source: 'ECB-EXR',
  sourceKind: 'REAL',
  recordedAt: '2026-11-06T16:00:00.000Z',
  published: {
    pair: 'EURUSD',
    rate: brandDecimalString('1.1165'),
    referenceDate: '2026-11-06',
    method: 'DECIMAL_INVERSE',
    precision: FX_DERIVATION_PRECISION,
  },
  ...overrides,
});

/** A copy without one optional key (exactOptionalPropertyTypes-safe). */
function without<K extends keyof FxRateRecord>(value: FxRateRecord, key: K): Omit<FxRateRecord, K> {
  const copy: Partial<FxRateRecord> = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy as Omit<FxRateRecord, K>;
}

const caught = (fn: () => unknown): PersistenceError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PersistenceError) return error;
    throw error;
  }
  throw new Error('expected a PersistenceError');
};

describe('migration 2 from the previous schema (version 1)', () => {
  it('adds the nullable quote columns; existing rows stay valid with no quote; new rows keep theirs', () => {
    const file = path.join(tempDir(), 'v1.db');
    // A database exactly as version 1 created it, with one FX row written then.
    const raw = new DatabaseSync(file);
    raw.exec(MIGRATIONS[0]?.sql ?? '');
    raw.exec('PRAGMA user_version = 1');
    raw
      .prepare(
        `INSERT INTO fx_rates (id, pair, rate, observed_at, observed_at_basis, convention_id, source, source_kind, recorded_at)
         VALUES ('fx-old', 'USDEUR', ?, '2026-11-05T15:00:00.000Z', 'PUBLICATION_CONVENTION', 'ECB-PUB-1600-FRANKFURT-v1',
                 'ECB-EXR', 'REAL', '2026-11-05T16:00:00.000Z')`,
      )
      .run('0.8909479686386315');
    raw.close();

    const uow = openSqlite(file); // migrates 1 -> 2
    const old = uow.run((tx) => tx.fxRates.listByPair('USDEUR'));
    expect(old).toEqual([
      {
        id: 'fx-old',
        pair: 'USDEUR',
        rate: '0.8909479686386315',
        observedAt: '2026-11-05T15:00:00.000Z',
        observedAtBasis: 'PUBLICATION_CONVENTION',
        conventionId: 'ECB-PUB-1600-FRANKFURT-v1',
        source: 'ECB-EXR',
        sourceKind: 'REAL',
        recordedAt: '2026-11-05T16:00:00.000Z',
      },
    ]);
    expect(old[0]).not.toHaveProperty('published');
    uow.run((tx) => tx.fxRates.append(record()));
    uow.close();

    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: LATEST_SCHEMA_VERSION });
    expect(LATEST_SCHEMA_VERSION).toBe(2);
    const columns = (
      check.prepare('PRAGMA table_info(fx_rates)').all() as { name: string; notnull: number }[]
    )
      .filter((c) => /^(published_|derivation_)/.test(c.name))
      .map((c) => [c.name, c.notnull]);
    expect(columns).toEqual([
      ['published_pair', 0],
      ['published_rate', 0],
      ['published_reference_date', 0],
      ['derivation_method', 0],
      ['derivation_precision', 0],
    ]);
    check.close();

    // Restart: both rows read back unchanged.
    const reopened = openSqlite(file);
    const rows = reopened.run((tx) => tx.fxRates.listByPair('USDEUR'));
    expect(rows.map((r) => r.id)).toEqual(['fx-old', 'fx-1']);
    expect(rows[1]).toEqual(record());
  });

  it('the table stays append-only after migration 2', () => {
    const file = path.join(tempDir(), 'append.db');
    openSqlite(file).run((tx) => tx.fxRates.append(record()));
    const raw = new DatabaseSync(file);
    expect(() => raw.exec("UPDATE fx_rates SET published_rate = '9'")).toThrow(/append-only/);
    expect(() => raw.exec('DELETE FROM fx_rates')).toThrow(/append-only/);
    raw.close();
  });
});

describe.each(ADAPTERS)('fx_rates quote round trip and rules (%s)', (_name, make) => {
  it('stores and returns the published quote exactly; the derived rate stays separate', () => {
    const uow = make();
    uow.run((tx) => tx.fxRates.append(record()));
    const stored = uow.run((tx) =>
      tx.fxRates.findByKey('USDEUR', 'ECB-EXR', 'REAL', '2026-11-06T15:00:00.000Z'),
    );
    expect(stored).toEqual(record());
    // Unambiguous: the derived application rate and the published observation are different fields.
    expect(stored?.rate).toBe(DERIVED);
    expect(stored?.published).toEqual({
      pair: 'EURUSD',
      rate: '1.1165',
      referenceDate: '2026-11-06',
      method: 'DECIMAL_INVERSE',
      precision: 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP',
    });
  });

  it('a record without a quote and a direct quote (AS_PUBLISHED, no reference date) are both valid', () => {
    const uow = make();
    const withoutQuote = without(record(), 'published');
    uow.run((tx) => tx.fxRates.append(withoutQuote));
    const base = without(record(), 'conventionId');
    uow.run((tx) =>
      tx.fxRates.append({
        ...base,
        id: 'fx-2',
        pair: 'GBPEUR',
        rate: brandDecimalString('1.17'),
        observedAtBasis: 'PROVIDER',
        source: 'demo-fixtures-fx',
        sourceKind: 'DEMO',
        published: {
          pair: 'GBPEUR',
          rate: brandDecimalString('1.17'),
          method: 'AS_PUBLISHED',
          precision: FX_DERIVATION_PRECISION,
        },
      }),
    );
    const all = uow.snapshot().fxRates;
    expect(all[0]).not.toHaveProperty('published');
    expect(all[1]?.published).toEqual({
      pair: 'GBPEUR',
      rate: '1.17',
      method: 'AS_PUBLISHED',
      precision: FX_DERIVATION_PRECISION,
    });
    expect(all[1]?.sourceKind).toBe('DEMO'); // DEMO fixture quotes stay distinguishable from ECB ones
  });

  it.each([
    [
      'a non-canonical published rate',
      { rate: '1.11650' },
      'fxRates.published.rate must be a canonical decimal',
    ],
    ['a zero published rate', { rate: '0' }, 'fxRates.published.rate must be greater than 0'],
    ['an exponent', { rate: '1.1165e0' }, 'fxRates.published.rate must be a canonical decimal'],
    [
      'a pair that is not the inverse',
      { pair: 'EURGBP' },
      'fxRates.published.pair must be the inverse of pair for method DECIMAL_INVERSE',
    ],
    [
      'AS_PUBLISHED with the inverse pair',
      { method: 'AS_PUBLISHED' },
      'fxRates.published.pair must equal pair for method AS_PUBLISHED',
    ],
    [
      'another precision',
      { precision: 'SIGNIFICANT_DIGITS_20' },
      'fxRates.published.precision must be SIGNIFICANT_DIGITS_40_ROUND_HALF_UP',
    ],
    [
      'an invalid reference date',
      { referenceDate: '2026-11-31' },
      'fxRates.published.referenceDate must be a YYYY-MM-DD date',
    ],
  ])('rejects %s (CONSTRAINT_VIOLATION, nothing written)', (_case, change, message) => {
    const uow = make();
    const bad = record({ published: { ...record().published, ...change } as FxPublishedQuote });
    const error = caught(() => uow.run((tx) => tx.fxRates.append(bad)));
    expect(error.code).toBe('CONSTRAINT_VIOLATION');
    expect(error.message).toContain(message);
    expect(error.message).not.toContain('1.1165');
    expect(uow.snapshot().fxRates).toEqual([]);
  });
});

describe('database-level consistency and read integrity (SQLite)', () => {
  const RAW_INSERT = `INSERT INTO fx_rates (id, pair, rate, observed_at, observed_at_basis, convention_id, source,
    source_kind, recorded_at, published_pair, published_rate, published_reference_date, derivation_method,
    derivation_precision) VALUES ('x', 'USDEUR', '0.9', '2026-11-06T15:00:00.000Z', 'PROVIDER', NULL, 's', 'REAL',
    '2026-11-06T16:00:00.000Z', ?, ?, NULL, ?, ?)`;

  it.each([
    ['a partial quote', ['EURUSD', null, 'DECIMAL_INVERSE', FX_DERIVATION_PRECISION]],
    ['an inconsistent pair', ['EURGBP', '1.1', 'DECIMAL_INVERSE', FX_DERIVATION_PRECISION]],
    ['an unknown method', ['EURUSD', '1.1', 'TRIANGULATED', FX_DERIVATION_PRECISION]],
  ])('direct SQL cannot insert %s', (_name, values) => {
    const file = path.join(tempDir(), 'raw.db');
    openSqlite(file).close();
    const raw = new DatabaseSync(file);
    expect(() => raw.prepare(RAW_INSERT).run(...(values as (string | null)[]))).toThrow();
    raw.close();
  });

  it('a stored partial quote (trigger bypassed) is INTEGRITY_ERROR on read, never a half record', () => {
    const file = path.join(tempDir(), 'damaged.db');
    openSqlite(file).close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER fx_rates_published_consistent');
    raw.prepare(RAW_INSERT).run('EURUSD', null, 'DECIMAL_INVERSE', FX_DERIVATION_PRECISION);
    raw.close();
    const uow = openSqlite(file);
    const error = caught(() => uow.run((tx) => tx.fxRates.listByPair('USDEUR')));
    expect(error.code).toBe('INTEGRITY_ERROR');
  });
});

describe('recorder over recorded ECB data: published and derived values both persisted', () => {
  function recorder(uow: SqliteUnitOfWork | InMemoryUnitOfWork) {
    const h = harness({ maxRetries: 0 }, {});
    const service = createRecordingFxService({
      fx: {
        provider: createEcbFxProvider({
          transport: recordedTransport().transport,
          supportedCurrencies: ['GBP', 'USD'],
          maxResponseBytes: 1_048_576,
          cacheMaxEntries: 8,
        }),
        resilientCall: h.rc,
        baseCurrency: 'EUR',
        supportedCurrencies: ['EUR', 'GBP', 'USD'],
        maxRateAgeSeconds: 345_600,
      },
      unitOfWork: uow,
      lastValid: new LastValidStore<string, ObservedFxRate>(),
      clock: new FakeClock('2026-11-06T16:00:00.000Z'),
      ids: sequentialIds('fx'),
    });
    return (currency: string, at = '2026-11-06T16:00:00.000Z') =>
      drive(h.sleeper, service.rateToBase(currency, '2026-11-06', at));
  }

  it('records the ECB observation EUR->USD 1.1165 (reference date 2026-11-06) beside Rate(USD/EUR); survives a restart', async () => {
    const file = path.join(tempDir(), 'ecb.db');
    const uow = openSqlite(file);
    const rate = recorder(uow);
    const result = await rate('USD');
    expect(result.ok && result.value.rate).toBe(DERIVED);
    // The calculation type is unchanged: no quote field reaches FxRateUsed (snapshots unchanged).
    expect(result.ok && result.value).not.toHaveProperty('published');
    uow.close();
    const reopened = openSqlite(file);
    expect(reopened.snapshot().fxRates).toEqual([
      expect.objectContaining({
        pair: 'USDEUR',
        rate: DERIVED,
        source: 'ECB-EXR',
        published: {
          pair: 'EURUSD',
          rate: '1.1165',
          referenceDate: '2026-11-06',
          method: 'DECIMAL_INVERSE',
          precision: FX_DERIVATION_PRECISION,
        },
      }),
    ]);
  });

  it('an identical re-receipt writes nothing; a pre-migration row without a quote is not rewritten or conflicting', async () => {
    const uow = new InMemoryUnitOfWork();
    const old = without(record({ id: 'fx-old' }), 'published');
    uow.run((tx) => tx.fxRates.append(old)); // as written before migration 2
    const rate = recorder(uow);
    const first = await rate('USD');
    expect(first.ok).toBe(true);
    expect(uow.snapshot().fxRates).toHaveLength(1);
    expect(uow.snapshot().fxRates[0]).not.toHaveProperty('published');
    const second = await rate('USD', '2026-11-06T16:00:00.001Z');
    expect(second.ok).toBe(true);
    expect(uow.snapshot().fxRates).toHaveLength(1);
  });

  it('a stored quote that differs from the received one is RATE_CONFLICT (the rate is not used)', async () => {
    const uow = new InMemoryUnitOfWork();
    uow.run((tx) =>
      tx.fxRates.append(
        record({ published: { ...record().published, referenceDate: '2026-11-05' } as FxPublishedQuote }),
      ),
    );
    const result = await recorder(uow)('USD');
    expect(result).toMatchObject({ ok: false, error: { code: 'FX_UNAVAILABLE', cause: 'RATE_CONFLICT' } });
  });
});
