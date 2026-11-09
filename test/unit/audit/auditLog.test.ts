// Task 5.2 and AT-AUD-05: the append-only audit log. Ingestion, validation, provider,
// and calculation errors are audited with timestamps and without sensitive data.
// Validates: Requirements 22.6, 3.3
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_CATEGORIES,
  AuditEventError,
  AuditEventSchema,
  createAuditLog,
  recordAuditEvent,
} from '../../../src/audit/index.js';
import type { AuditEvent, AuditLog } from '../../../src/audit/index.js';
import { InMemoryUnitOfWork, PersistenceError } from '../../../src/persistence/index.js';
import type { AuditCategory } from '../../../src/persistence/index.js';
import { FakeClock, REDACTED, isIsoUtcMillis, sequentialIds } from '../../../src/shared/index.js';
import { importSummary, transaction } from '../../helpers/persistence.js';

const SECRET = 'test-api-key-0000';
const CONTACT = 'Example Research ops@example.invalid';
const SECRETS = [SECRET, CONTACT];

const clock = new FakeClock('2026-11-06T10:00:00.000Z');
const ids = sequentialIds('audit');

/** An event stamped from the injected clock, as callers are expected to do. */
const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: ids.next(),
  at: clock.nowUtc().toISOString(),
  category: 'VALIDATION',
  type: 'ROW_REJECTED',
  details: {},
  ...overrides,
});

const appendAll = (uow: InMemoryUnitOfWork, events: readonly AuditEvent[]): void => {
  uow.run((tx) => {
    const log = createAuditLog(tx.audit, { secrets: SECRETS });
    for (const item of events) {
      log.append(item);
    }
  });
};

describe('AT-AUD-05: errors are audited with timestamps and without sensitive data', () => {
  it('records ingestion, validation, provider, and calculation errors with their timestamps', () => {
    const uow = new InMemoryUnitOfWork();
    const events: AuditEvent[] = [];
    const add = (category: AuditCategory, type: string, details: Record<string, string | boolean>) => {
      events.push(event({ category, type, details }));
      clock.advance(1_000);
    };
    add('IMPORT', 'FILE_REJECTED', { reason: 'INVALID_ENCODING', fileSha256: 'c'.repeat(64) });
    add('VALIDATION', 'ROW_REJECTED', { source: 'trades.csv', row: '7', reason: 'MALFORMED_NUMBER' });
    add('PROVIDER', 'PROVIDER_FAILED', {
      provider: 'fixture-market-data',
      operation: 'getSeries',
      code: 'TIMEOUT',
    });
    add('CALCULATION', 'CALCULATION_FAILED', { portfolioId: 'pf-1', status: 'INSUFFICIENT_DATA' });
    appendAll(uow, events);

    const stored = uow.snapshot().audit;
    expect(stored.map((entry) => [entry.category, entry.type, entry.at])).toEqual([
      ['IMPORT', 'FILE_REJECTED', '2026-11-06T10:00:00.000Z'],
      ['VALIDATION', 'ROW_REJECTED', '2026-11-06T10:00:01.000Z'],
      ['PROVIDER', 'PROVIDER_FAILED', '2026-11-06T10:00:02.000Z'],
      ['CALCULATION', 'CALCULATION_FAILED', '2026-11-06T10:00:03.000Z'],
    ]);
    expect(stored.map((entry) => entry.details)).toEqual(events.map((item) => item.details));
  });

  it('records a rejected record with source, record identifier, timestamp, and reason (R3.3)', () => {
    const uow = new InMemoryUnitOfWork();
    const rejected = event({
      category: 'VALIDATION',
      type: 'ROW_REJECTED',
      subject: 'imp-1',
      details: {
        source: 'trades.csv',
        recordId: 'row 12',
        reason: 'OVERSELL',
        message: 'SELL exceeds the long quantity',
      },
    });
    appendAll(uow, [rejected]);
    expect(uow.snapshot().audit).toEqual([rejected]);
  });

  it('removes credentials, authorization headers, sensitive keys, the SEC contact, and FIX Account values', () => {
    const uow = new InMemoryUnitOfWork();
    const sensitive = event({
      category: 'PROVIDER',
      type: 'PROVIDER_FAILED',
      subject: `call with ${SECRET}`,
      actor: CONTACT,
      details: {
        message: `upstream echoed ${SECRET} for ${CONTACT}`,
        request: 'GET https://example.invalid/prices?symbol=AAA&apikey=abc123def',
        header: 'Authorization: Bearer tok-abcdef123456',
        authorization: 'Bearer tok-abcdef123456',
        apiKey: SECRET,
        account: 'ACCT-778899',
        fix: '8=FIX.4.4|35=8|1=ACCT-778899|55=AAA|',
        retried: true,
      },
    });
    appendAll(uow, [sensitive]);

    const [stored] = uow.snapshot().audit;
    const text = JSON.stringify(stored);
    for (const leaked of [
      SECRET,
      CONTACT,
      'ops@example.invalid',
      'tok-abcdef123456',
      'abc123def',
      'ACCT-778899',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(stored?.details).toMatchObject({
      authorization: REDACTED,
      apiKey: REDACTED,
      account: REDACTED,
      header: `authorization: ${REDACTED}`,
      fix: `8=FIX.4.4|35=8|1=${REDACTED}|55=AAA|`,
      retried: true,
    });
    expect(stored?.subject).toBe(`call with ${REDACTED}`);
    expect(stored?.actor).toBe(REDACTED);
    // The caller's event object is not modified.
    expect(sensitive.details['apiKey']).toBe(SECRET);
  });
});

describe('append-only', () => {
  it('the audit log exposes append and nothing else', () => {
    const uow = new InMemoryUnitOfWork();
    uow.run((tx) => {
      const log: AuditLog = createAuditLog(tx.audit);
      expect(Object.keys(log)).toEqual(['append']);
      // @ts-expect-error No update operation exists.
      expect(log.update).toBeUndefined();
      // @ts-expect-error No delete operation exists.
      expect(log.delete).toBeUndefined();
      // @ts-expect-error The audit log has no read API either.
      expect(log.list).toBeUndefined();
    });
  });

  it('an existing entry cannot be overwritten by appending the same id', () => {
    const uow = new InMemoryUnitOfWork();
    const original = event({ id: 'fixed-id', details: { note: 'original' } });
    appendAll(uow, [original]);
    expect(() => appendAll(uow, [{ ...original, details: { note: 'replacement' } }])).toThrow(
      PersistenceError,
    );
    expect(uow.snapshot().audit).toEqual([original]);
  });

  it('stored entries cannot be modified', () => {
    const uow = new InMemoryUnitOfWork();
    appendAll(uow, [event({ details: { note: 'original' } })]);
    const [stored] = uow.snapshot().audit;
    expect(() => {
      (stored as { type: string }).type = 'TAMPERED';
    }).toThrow(TypeError);
    expect(() => {
      (stored?.details as Record<string, string>)['note'] = 'tampered';
    }).toThrow(TypeError);
    expect(uow.snapshot().audit[0]?.details).toEqual({ note: 'original' });
  });
});

describe('validation', () => {
  it('uses exactly the design categories', () => {
    expect([...AUDIT_CATEGORIES]).toEqual([
      'IMPORT',
      'VALIDATION',
      'PROVIDER',
      'CALCULATION',
      'ALERT',
      'CONFIG',
      'SECURITY',
    ]);
    for (const category of AUDIT_CATEGORIES) {
      const uow = new InMemoryUnitOfWork();
      appendAll(uow, [event({ category })]);
      expect(uow.snapshot().audit[0]?.category).toBe(category);
    }
  });

  it.each([
    ['an unknown category', { category: 'OTHER' }, 'category'],
    ['a missing timestamp', { at: undefined }, 'at'],
    ['a timestamp with an offset', { at: '2026-11-06T12:00:00.000+02:00' }, 'at'],
    ['a timestamp without milliseconds', { at: '2026-11-06T10:00:00Z' }, 'at'],
    ['a date only', { at: '2026-11-06' }, 'at'],
    ['an empty id', { id: '' }, 'id'],
    ['an empty type', { type: '' }, 'type'],
    ['a numeric detail', { details: { amount: 1000.5 } }, 'details.amount'],
    ['a nested detail', { details: { nested: { a: 'b' } } }, 'details.nested'],
    ['an unknown field', { extra: 'x' }, '(event)'],
  ])('rejects %s without writing or echoing values', (_label, overrides, field) => {
    const uow = new InMemoryUnitOfWork();
    const invalid = { ...event(), ...overrides } as unknown as AuditEvent;
    let caught: unknown;
    try {
      appendAll(uow, [invalid]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuditEventError);
    expect((caught as AuditEventError).fields).toContain(field);
    expect((caught as Error).message).not.toContain('1000.5');
    expect((caught as Error).message).not.toContain('+02:00');
    expect(uow.snapshot().audit).toEqual([]);
  });
});

describe('transaction semantics', () => {
  it('audit entries commit together with the other writes of the unit of work', () => {
    const uow = new InMemoryUnitOfWork();
    uow.run((tx) => {
      tx.imports.insert(importSummary());
      tx.transactions.insert(transaction());
      createAuditLog(tx.audit).append(event({ category: 'IMPORT', type: 'IMPORT_COMMITTED' }));
    });
    const state = uow.snapshot();
    expect(state.audit.map((entry) => entry.type)).toEqual(['IMPORT_COMMITTED']);
    expect(state.imports).toHaveLength(1);
  });

  it('audit entries roll back with the transaction when the work throws', () => {
    const uow = new InMemoryUnitOfWork();
    expect(() =>
      uow.run((tx) => {
        createAuditLog(tx.audit).append(event({ type: 'ROW_REJECTED' }));
        tx.transactions.insert(transaction());
        throw new Error('import aborted');
      }),
    ).toThrow('import aborted');
    expect(uow.snapshot().audit).toEqual([]);
    expect(uow.snapshot().transactions).toEqual([]);
  });

  it('an invalid audit event aborts and rolls back its transaction', () => {
    const uow = new InMemoryUnitOfWork();
    expect(() =>
      uow.run((tx) => {
        tx.transactions.insert(transaction());
        createAuditLog(tx.audit).append({ ...event(), category: 'BOGUS' } as unknown as AuditEvent);
      }),
    ).toThrow(AuditEventError);
    expect(uow.snapshot().transactions).toEqual([]);
  });

  it.each([0, 1, 2, 3])(
    'a commit failure at write %i leaves audit and every other repository unchanged',
    (atWrite) => {
      const uow = new InMemoryUnitOfWork();
      appendAll(uow, [event({ id: 'existing' })]);
      const before = uow.snapshot();
      uow.failNextCommit({ atWrite });
      expect(() =>
        uow.run((tx) => {
          const log = createAuditLog(tx.audit);
          log.append(event({ type: 'ROW_REJECTED' }));
          tx.imports.insert(importSummary());
          log.append(event({ category: 'IMPORT', type: 'IMPORT_COMMITTED' }));
        }),
      ).toThrow(PersistenceError);
      expect(uow.lastAttempt?.writes).toHaveLength(3);
      expect(uow.snapshot()).toEqual(before);
    },
  );

  it('recordAuditEvent persists a failure record after the import transaction rolled back', () => {
    const uow = new InMemoryUnitOfWork();
    uow.failNextCommit({ atWrite: 1 });
    expect(() =>
      uow.run((tx) => {
        tx.imports.insert(importSummary());
        createAuditLog(tx.audit).append(event({ category: 'IMPORT', type: 'IMPORT_COMMITTED' }));
      }),
    ).toThrow(PersistenceError);

    recordAuditEvent(
      uow,
      event({
        category: 'IMPORT',
        type: 'IMPORT_FAILED',
        subject: 'imp-1',
        details: { reason: 'IMPORT_COMMIT_FAILED' },
      }),
      {
        secrets: SECRETS,
      },
    );
    const state = uow.snapshot();
    expect(state.imports).toEqual([]);
    expect(state.audit.map((entry) => entry.type)).toEqual(['IMPORT_FAILED']);
  });

  it('recordAuditEvent validates before opening a unit of work', () => {
    const uow = new InMemoryUnitOfWork();
    expect(() => recordAuditEvent(uow, { ...event(), at: 'not a time' })).toThrow(AuditEventError);
    expect(uow.lastAttempt).toBeUndefined();
    expect(uow.snapshot().audit).toEqual([]);
  });

  it('the audit log cannot be used after its unit of work ends', () => {
    const uow = new InMemoryUnitOfWork();
    let log: AuditLog | undefined;
    uow.run((tx) => {
      log = createAuditLog(tx.audit);
    });
    expect(() => log?.append(event())).toThrow('outside their unit of work');
    expect(uow.snapshot().audit).toEqual([]);
  });
});

describe('detail keys that collide after redaction', () => {
  // Original keys and values that must never appear in an error.
  const LEAKS = [SECRET, CONTACT, 'ops@example.invalid', 'tok-aaaa1111', 'dXNlcjpwYXNz', 'first', 'second'];

  const expectCollision = (run: () => void): AuditEventError => {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuditEventError);
    const error = caught as AuditEventError;
    expect(error.reason).toBe('REDACTED_KEY_COLLISION');
    expect(error.fields).toEqual(['details']);
    const disclosed = [error.message, error.stack ?? '', JSON.stringify(error), error.fields.join(',')].join(
      '\n',
    );
    for (const leaked of LEAKS) {
      expect(disclosed).not.toContain(leaked);
    }
    return error;
  };

  it.each([
    ['two different configured secrets as keys', { [SECRET]: 'first', [CONTACT]: 'second' }],
    [
      'two keys that differ only in the configured secret they contain',
      { [`note ${SECRET}`]: 'first', [`note ${CONTACT}`]: 'second' },
    ],
    ['a configured secret and the literal redaction marker', { [SECRET]: 'first', [REDACTED]: 'second' }],
  ])('rejects %s and writes nothing', (_label, details) => {
    const uow = new InMemoryUnitOfWork();
    expectCollision(() => appendAll(uow, [event({ details })]));
    expect(uow.snapshot().audit).toEqual([]);
    expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');
    expect(uow.lastAttempt?.writes).toHaveLength(0);
  });

  it.each([
    [
      'two authorization-header keys',
      { 'Authorization: Bearer tok-aaaa1111': 'first', 'authorization: Basic dXNlcjpwYXNz': 'second' },
    ],
    [
      'two sensitive keys that contain different configured secrets',
      { [`apiKey-${SECRET}`]: 'first', [`apiKey-${CONTACT}`]: 'second' },
    ],
  ])('rejects a collision between sensitive keys (%s) and writes nothing', (_label, details) => {
    const uow = new InMemoryUnitOfWork();
    expectCollision(() => appendAll(uow, [event({ details })]));
    expect(uow.snapshot().audit).toEqual([]);
  });

  it('recordAuditEvent rejects a collision before opening a unit of work', () => {
    const uow = new InMemoryUnitOfWork();
    expectCollision(() =>
      recordAuditEvent(uow, event({ details: { [SECRET]: 'first', [CONTACT]: 'second' } }), {
        secrets: SECRETS,
      }),
    );
    expect(uow.lastAttempt).toBeUndefined();
    expect(uow.snapshot().audit).toEqual([]);
  });

  it('a collision inside a larger unit of work rolls back every write of that unit of work', () => {
    const uow = new InMemoryUnitOfWork();
    appendAll(uow, [event({ id: 'existing' })]);
    const before = uow.snapshot();
    expectCollision(() =>
      uow.run((tx) => {
        const log = createAuditLog(tx.audit, { secrets: SECRETS });
        tx.imports.insert(importSummary());
        tx.transactions.insert(transaction());
        log.append(event({ type: 'ROW_REJECTED', details: { reason: 'OVERSELL' } }));
        log.append(event({ details: { [SECRET]: 'first', [CONTACT]: 'second' } }));
      }),
    );
    expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');
    expect(uow.snapshot()).toEqual(before);
  });

  it('keeps distinct keys that stay distinct after redaction, with every value', () => {
    // CONTACT is used because SECRET contains "api-key", which also makes the
    // key itself sensitive (its value would be redacted, hiding what is tested).
    const uow = new InMemoryUnitOfWork();
    appendAll(uow, [
      event({
        details: {
          [`${CONTACT}A`]: 'first',
          [`${CONTACT}B`]: 'second',
          reason: 'OVERSELL',
          source: 'trades.csv',
          password: 'hunter2-not-real',
          retried: false,
        },
      }),
    ]);
    const [stored] = uow.snapshot().audit;
    expect(stored?.details).toEqual({
      [`${REDACTED}A`]: 'first',
      [`${REDACTED}B`]: 'second',
      reason: 'OVERSELL',
      source: 'trades.csv',
      password: REDACTED,
      retried: false,
    });
    expect(JSON.stringify(stored)).not.toContain(CONTACT);
  });

  it('accepts ordinary keys unchanged when no secrets are configured', () => {
    const uow = new InMemoryUnitOfWork();
    const details = { [`${CONTACT}A`]: 'first', [`${CONTACT}B`]: 'second', reason: 'OVERSELL' };
    uow.run((tx) => {
      createAuditLog(tx.audit).append(event({ details }));
    });
    expect(uow.snapshot().audit[0]?.details).toEqual(details);
  });
});

describe('audit timestamps follow the persisted IsoUtc contract (isIsoUtcMillis)', () => {
  const SAMPLES = [
    // accepted
    '2026-11-06T10:00:00.000Z',
    '2024-02-29T23:59:59.999Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
    // rejected
    '+02026-11-06T10:00:00.000Z', // five-digit (expanded) year
    '-000001-01-01T00:00:00.000Z',
    '20260-11-06T10:00:00.000Z',
    '2026-02-30T10:00:00.000Z',
    '2026-02-29T10:00:00.000Z',
    '2026-11-06T24:00:00.000Z',
    '2026-12-31T23:59:60.000Z',
    '2026-11-06T10:00:00.000z',
    '2026-11-06t10:00:00.000Z',
    '2026-11-06T10:00:00.000000Z',
    '2026-11-06T10:00:00.00Z',
    '2026-11-06T10:00:00Z',
    '2026-11-06T10:00:00.000+00:00',
    ' 2026-11-06T10:00:00.000Z',
    '2026-11-06',
  ];

  it.each(SAMPLES)('AuditEventSchema accepts %j exactly when isIsoUtcMillis does', (at) => {
    expect(AuditEventSchema.safeParse(event({ at })).success).toBe(isIsoUtcMillis(at));
  });

  // Explicit boolean return: an inferred type predicate would narrow the items to never.
  it.each(SAMPLES.filter((at: string): boolean => !isIsoUtcMillis(at)))(
    'rejects %j with AuditEventError on field at, writing nothing and opening no unit of work',
    (at) => {
      const uow = new InMemoryUnitOfWork();
      let caught: unknown;
      try {
        recordAuditEvent(uow, event({ at }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AuditEventError);
      expect((caught as AuditEventError).fields).toEqual(['at']);
      expect((caught as Error).message).not.toContain(at.trim());
      expect(uow.lastAttempt).toBeUndefined();
      expect(uow.snapshot().audit).toEqual([]);
    },
  );

  it('every timestamp the audit log accepts is also accepted by the persistence write boundary', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('0000-01-01T00:00:00.000Z'),
          max: new Date('9999-12-31T23:59:59.999Z'),
          noInvalidDate: true,
        }),
        (date) => {
          const at = date.toISOString();
          expect(AuditEventSchema.safeParse(event({ at })).success).toBe(true);
          const uow = new InMemoryUnitOfWork();
          recordAuditEvent(uow, event({ at }));
          expect(uow.snapshot().audit[0]?.at).toBe(at);
        },
      ),
    );
  });

  it('a timestamp outside 0000-9999 serializes with an expanded year and is rejected by both', () => {
    const at = new Date('+010000-01-01T00:00:00.000Z').toISOString();
    expect(at.startsWith('+')).toBe(true);
    expect(isIsoUtcMillis(at)).toBe(false);
    expect(AuditEventSchema.safeParse(event({ at })).success).toBe(false);
  });
});
