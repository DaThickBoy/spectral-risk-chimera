// Task 6.2: PositionService.rebuild against the in-memory unit of work.
// AT-POS-06 (replay order and repeated rebuilds), AT-POS-07 (currency conflict writes
// and publishes nothing), AT-POS-08 (PositionsChanged publication), and AT-POS-09
// (reconciliation, orphan removal, atomicity).
// Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 28.17, 28.18
import { describe, expect, it } from 'vitest';
import { POSITIONS_CHANGED_PUBLISH_FAILED, createPositionService } from '../../../src/app/index.js';
import type { PositionEventPublisher, PositionService } from '../../../src/app/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import type { TransactionRecord, UnitOfWork } from '../../../src/persistence/index.js';
import { positionId } from '../../../src/portfolio/index.js';
import type { PositionsChanged } from '../../../src/portfolio/index.js';
import { FakeClock, brandDecimalString, createLogger } from '../../../src/shared/index.js';
import { SOURCE_A, SOURCE_B, T0, rows, trade } from '../../helpers/ledger.js';
import { position } from '../../helpers/persistence.js';

const PF = 'pf-1';

interface Harness {
  readonly uow: InMemoryUnitOfWork;
  readonly service: PositionService;
  readonly events: PositionsChanged[];
  readonly logs: string[];
  /** Set to make the next publish throw. */
  failPublish: boolean;
  /** Committed positions seen by the publisher at publish time. */
  readonly seenAtPublish: string[][];
}

function harness(): Harness {
  const uow = new InMemoryUnitOfWork();
  const logs: string[] = [];
  const h: Harness = {
    uow,
    events: [],
    logs,
    failPublish: false,
    seenAtPublish: [],
    service: undefined as unknown as PositionService,
  };
  const publisher: PositionEventPublisher = {
    publish: (event) => {
      h.seenAtPublish.push(uow.snapshot().positions.map((p) => `${p.ticker}:${p.signedQuantity}`));
      if (h.failPublish) {
        throw new Error('event bus unavailable');
      }
      h.events.push(event);
    },
  };
  const logger = createLogger({ clock: new FakeClock(T0), sink: (line) => logs.push(line), level: 'debug' });
  return Object.assign(h, { service: createPositionService({ unitOfWork: uow, publisher, logger }) });
}

const insert = (uow: InMemoryUnitOfWork, records: readonly TransactionRecord[]): void => {
  uow.run((tx) => {
    for (const record of records) {
      tx.transactions.insert(record);
    }
  });
};

const positionsOf = (uow: InMemoryUnitOfWork) =>
  [...uow.snapshot().positions].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));

describe('AT-POS-06: replay order and repeated rebuilds', () => {
  // File A: BUY 10 @ 100, SELL 10 @ 100 (flat). File B: BUY 10 @ 120. Same timestamp.
  // Order by sourceId puts A before B: flat, then 10 @ 120. (B first would give 10 @ 110.)
  const fileA = rows(
    [
      ['BUY', '10', '100'],
      ['SELL', '10', '100'],
    ],
    { sourceId: SOURCE_A, source: 'CSV a.csv', importId: 'imp-a' },
  );
  const fileB = rows([['BUY', '10', '120']], { sourceId: SOURCE_B, source: 'CSV b.csv', importId: 'imp-b' });

  it('gives identical positions whichever file is imported first', () => {
    const first = harness();
    insert(first.uow, fileA);
    insert(first.uow, fileB);
    const second = harness();
    insert(second.uow, fileB);
    insert(second.uow, [...fileA].reverse());

    expect(first.service.rebuild(PF).status).toBe('REBUILT');
    expect(second.service.rebuild(PF).status).toBe('REBUILT');
    expect(positionsOf(first.uow)).toEqual(positionsOf(second.uow));
    expect(positionsOf(first.uow)).toEqual([
      {
        id: positionId(PF, 'AAA'),
        portfolioId: PF,
        ticker: 'AAA',
        currency: 'USD',
        signedQuantity: '10',
        averagePrice: '120',
        isShort: false,
        updatedAt: T0,
        source: 'CSV b.csv',
      },
    ]);
  });

  it('a repeated rebuild changes nothing, writes nothing, and publishes nothing', () => {
    const h = harness();
    insert(h.uow, [...fileA, ...fileB]);
    h.service.rebuild(PF);
    const before = h.uow.snapshot();
    expect(h.service.rebuild(PF)).toEqual({ status: 'REBUILT', changes: [], published: false });
    expect(h.uow.lastAttempt).toEqual({ writes: [], outcome: 'COMMITTED' });
    expect(h.uow.snapshot()).toEqual(before);
    expect(h.events).toHaveLength(1);
  });
});

describe('AT-POS-08: PositionsChanged publication', () => {
  it('publishes once, after the commit, with sorted unique tickers of the changes', () => {
    const h = harness();
    insert(h.uow, [
      trade('BUY', '1', '1', { ticker: 'ZZZ' }),
      trade('BUY', '2', '1', { ticker: 'AAA', sourceSequence: 2 }),
      trade('BUY', '3', '1', { ticker: 'MMM', sourceSequence: 3 }),
      trade('BUY', '4', '1', { ticker: 'AAA', sourceSequence: 4 }),
    ]);
    const result = h.service.rebuild(PF);
    expect(result).toMatchObject({ status: 'REBUILT', published: true });
    expect(h.events).toEqual([{ type: 'PositionsChanged', portfolioId: PF, tickers: ['AAA', 'MMM', 'ZZZ'] }]);
    // The publisher already sees the committed positions.
    expect(h.seenAtPublish).toEqual([['AAA:6', 'MMM:3', 'ZZZ:1']]);
    if (result.status === 'REBUILT') {
      expect(result.changes.map((c) => [c.ticker, c.before, c.after?.signedQuantity])).toEqual([
        ['AAA', null, '6'],
        ['MMM', null, '3'],
        ['ZZZ', null, '1'],
      ]);
    }
  });

  it('publishes only the tickers that changed', () => {
    const h = harness();
    insert(h.uow, [trade('BUY', '1', '1', { ticker: 'AAA' }), trade('BUY', '1', '1', { ticker: 'BBB' })]);
    h.service.rebuild(PF);
    insert(h.uow, [trade('BUY', '1', '3', { ticker: 'BBB', sourceSequence: 2 })]);
    const result = h.service.rebuild(PF);
    expect(h.events.at(-1)).toEqual({ type: 'PositionsChanged', portfolioId: PF, tickers: ['BBB'] });
    expect(result.status === 'REBUILT' && result.changes[0]?.after?.averagePrice).toBe('2');
    expect(h.uow.lastAttempt?.writes).toEqual([{ repository: 'positions', operation: 'upsert' }]);
  });

  it.each([0, 1, 2])(
    'a commit failure at write %i publishes nothing and leaves positions unchanged',
    (atWrite) => {
      const h = harness();
      insert(h.uow, [trade('BUY', '1', '1', { ticker: 'AAA' }), trade('BUY', '1', '1', { ticker: 'BBB' })]);
      const before = h.uow.snapshot();
      h.uow.failNextCommit({ atWrite });
      expect(h.service.rebuild(PF)).toEqual({ status: 'COMMIT_FAILED', code: 'COMMIT_FAILED' });
      expect(h.events).toEqual([]);
      expect(h.seenAtPublish).toEqual([]);
      expect(h.uow.snapshot()).toEqual(before);
    },
  );

  it('a publication failure keeps the committed positions, is logged, and is reported', () => {
    const h = harness();
    insert(h.uow, [trade('BUY', '5', '2')]);
    h.failPublish = true;
    const result = h.service.rebuild(PF);
    expect(result.status).toBe('REBUILT_PUBLISH_FAILED');
    expect(result.status === 'REBUILT_PUBLISH_FAILED' && result.changes.map((c) => c.ticker)).toEqual([
      'AAA',
    ]);
    expect(h.uow.snapshot().positions.map((p) => p.signedQuantity)).toEqual(['5']);
    expect(h.events).toEqual([]);
    const logged = h.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      level: 'error',
      code: POSITIONS_CHANGED_PUBLISH_FAILED,
      portfolioId: PF,
    });
    // No retry: a later rebuild on the unchanged ledger has nothing to publish.
    h.failPublish = false;
    expect(h.service.rebuild(PF)).toEqual({ status: 'REBUILT', changes: [], published: false });
    expect(h.events).toEqual([]);
  });

  it('an empty ledger with no positions publishes nothing', () => {
    const h = harness();
    expect(h.service.rebuild(PF)).toEqual({ status: 'REBUILT', changes: [], published: false });
    expect(h.events).toEqual([]);
  });
});

describe('AT-POS-07: a currency conflict writes nothing and publishes nothing', () => {
  it('returns PROJECTION_FAILED; existing positions, including unaffected tickers, stay as they were', () => {
    const h = harness();
    insert(h.uow, [trade('BUY', '1', '1', { ticker: 'AAA' })]);
    h.service.rebuild(PF);
    const before = h.uow.snapshot();
    insert(h.uow, [
      trade('BUY', '1', '1', { ticker: 'BBB', currency: 'USD', sourceSequence: 2 }),
      trade('BUY', '1', '1', { ticker: 'BBB', currency: 'EUR', sourceSequence: 3 }),
      trade('BUY', '9', '9', { ticker: 'AAA', sourceSequence: 4 }),
    ]);
    const result = h.service.rebuild(PF);
    expect(result.status).toBe('PROJECTION_FAILED');
    expect(
      result.status === 'PROJECTION_FAILED' &&
        result.error.code === 'POSITION_CURRENCY_CONFLICT' &&
        result.error.conflicts,
    ).toEqual([{ ticker: 'BBB', currencies: ['EUR', 'USD'] }]);
    expect(h.uow.lastAttempt?.writes).toEqual([]);
    expect(h.uow.snapshot().positions).toEqual(before.positions);
    expect(h.events).toHaveLength(1);
  });
});

describe('AT-POS-09: reconciliation against the complete replay', () => {
  const orphan = position({
    id: positionId(PF, 'OLD'),
    ticker: 'OLD',
    signedQuantity: brandDecimalString('7'),
    averagePrice: brandDecimalString('3'),
  });

  it('removes a persisted position with no ledger transaction and reports it with after: null', () => {
    const h = harness();
    h.uow.run((tx) => tx.positions.upsert(orphan));
    insert(h.uow, [trade('BUY', '1', '1', { ticker: 'AAA' })]);
    const result = h.service.rebuild(PF);
    expect(result.status).toBe('REBUILT');
    if (result.status !== 'REBUILT') {
      return;
    }
    expect(result.changes.map((c) => [c.ticker, c.before?.ticker ?? null, c.after?.ticker ?? null])).toEqual([
      ['AAA', null, 'AAA'],
      ['OLD', 'OLD', null],
    ]);
    expect(h.uow.snapshot().positions.map((p) => p.ticker)).toEqual(['AAA']);
    expect(h.events).toEqual([{ type: 'PositionsChanged', portfolioId: PF, tickers: ['AAA', 'OLD'] }]);
  });

  it('keeps a zero-quantity position produced by the ledger history', () => {
    const h = harness();
    insert(
      h.uow,
      rows([
        ['BUY', '10', '100'],
        ['SELL', '10', '110'],
      ]),
    );
    h.service.rebuild(PF);
    expect(h.uow.snapshot().positions).toMatchObject([
      { ticker: 'AAA', signedQuantity: '0', averagePrice: null, isShort: false },
    ]);
    expect(h.service.rebuild(PF)).toEqual({ status: 'REBUILT', changes: [], published: false });
    expect(h.uow.snapshot().positions).toHaveLength(1);
  });

  it('leaves positions of other portfolios untouched', () => {
    const h = harness();
    const other = position({ portfolioId: 'pf-2', ticker: 'XYZ' });
    h.uow.run((tx) => tx.positions.upsert(other));
    insert(h.uow, [trade('BUY', '1', '1')]);
    h.service.rebuild(PF);
    expect(h.uow.snapshot().positions.map((p) => [p.portfolioId, p.ticker])).toEqual([
      ['pf-2', 'XYZ'],
      [PF, 'AAA'],
    ]);
  });

  it.each([0, 1, 2, 3])(
    'a commit failure at write %i leaves every insertion, update, and removal unapplied',
    (atWrite) => {
      const h = harness();
      h.uow.run((tx) => tx.positions.upsert(orphan));
      insert(h.uow, [trade('BUY', '1', '1', { ticker: 'AAA' })]);
      h.service.rebuild(PF); // AAA inserted, OLD removed
      h.uow.run((tx) => tx.positions.upsert(orphan)); // a new orphan
      insert(h.uow, [
        trade('BUY', '1', '3', { ticker: 'AAA', sourceSequence: 2 }), // AAA changes
        trade('BUY', '1', '1', { ticker: 'BBB', sourceSequence: 3 }), // BBB is new
      ]);
      const before = h.uow.snapshot();
      const eventsBefore = h.events.length;
      h.uow.failNextCommit({ atWrite });
      expect(h.service.rebuild(PF)).toEqual({ status: 'COMMIT_FAILED', code: 'COMMIT_FAILED' });
      expect(h.uow.lastAttempt?.writes.map((w) => w.operation)).toEqual(['upsert', 'upsert', 'delete']);
      expect(h.uow.snapshot()).toEqual(before);
      expect(h.events).toHaveLength(eventsBefore);

      // Without a fault, the same rebuild applies all three changes together.
      const result = h.service.rebuild(PF);
      expect(result.status).toBe('REBUILT');
      expect(positionsOf(h.uow).map((p) => [p.ticker, p.signedQuantity, p.averagePrice])).toEqual([
        ['AAA', '2', '2'],
        ['BBB', '1', '1'],
      ]);
      expect(h.events.at(-1)?.tickers).toEqual(['AAA', 'BBB', 'OLD']);
    },
  );
});

describe('review corrections: projection failures, publisher, and logger robustness', () => {
  /** A unit of work whose ledger reads return corrupted data, as a damaged durable store could. */
  const corruptingUnitOfWork = (
    inner: InMemoryUnitOfWork,
    corrupt: (ledger: readonly TransactionRecord[]) => readonly TransactionRecord[],
  ): UnitOfWork => ({
    run: (work) =>
      inner.run((tx) =>
        work({
          ...tx,
          transactions: {
            ...tx.transactions,
            listByPortfolio: (portfolioId) => corrupt(tx.transactions.listByPortfolio(portfolioId)),
          },
        }),
      ),
  });

  const silentLogger = () => createLogger({ clock: new FakeClock(T0), sink: () => undefined });

  it('invalid ledger data gives PROJECTION_FAILED (LEDGER_DATA_INVALID): no writes, no event', () => {
    const inner = new InMemoryUnitOfWork();
    insert(inner, [trade('BUY', '1', '1', { ticker: 'AAA' })]);
    inner.run((tx) => tx.positions.upsert(position({ ticker: 'OLD' })));
    const before = inner.snapshot();
    const events: PositionsChanged[] = [];
    const service = createPositionService({
      unitOfWork: corruptingUnitOfWork(inner, (ledger) =>
        ledger.map((record) => ({ ...record, quantity: '1e3' }) as unknown as TransactionRecord),
      ),
      publisher: { publish: (event) => events.push(event) },
      logger: silentLogger(),
    });
    const result = service.rebuild(PF);
    expect(result.status).toBe('PROJECTION_FAILED');
    expect(result.status === 'PROJECTION_FAILED' && result.error.code).toBe('LEDGER_DATA_INVALID');
    expect(inner.lastAttempt).toEqual({ writes: [], outcome: 'COMMITTED' });
    expect(inner.snapshot()).toEqual(before);
    expect(events).toEqual([]);
  });

  it('a programmer error in the projection propagates, rolls back, and publishes nothing', () => {
    const h = harness();
    insert(h.uow, [trade('BUY', '1', '1')]);
    const before = h.uow.snapshot();
    const events: PositionsChanged[] = [];
    const service = createPositionService({
      unitOfWork: h.uow,
      publisher: { publish: (event) => events.push(event) },
      logger: silentLogger(),
      projector: {
        replay: () => {
          throw new TypeError('bug in projector');
        },
      },
    });
    expect(() => service.rebuild(PF)).toThrow(TypeError);
    expect(h.uow.lastAttempt?.outcome).toBe('ROLLED_BACK');
    expect(h.uow.snapshot()).toEqual(before);
    expect(events).toEqual([]);
  });

  describe('a publisher that returns a promise breaks the synchronous contract', () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    // Node.js reports unhandled rejections before the next macrotask; one setImmediate turn is a
    // deterministic check (no arbitrary delay).
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    const run = async (publish: PositionEventPublisher['publish']) => {
      const uow = new InMemoryUnitOfWork();
      insert(uow, [trade('BUY', '3', '2')]);
      const logs: string[] = [];
      const service = createPositionService({
        unitOfWork: uow,
        publisher: { publish },
        logger: createLogger({ clock: new FakeClock(T0), sink: (line) => logs.push(line) }),
      });
      process.on('unhandledRejection', onUnhandled);
      try {
        const result = service.rebuild(PF);
        await flush();
        return { result, uow, logs };
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    };

    it('an async publisher that rejects: reported as failed, no unhandled rejection, positions kept', async () => {
      unhandled.length = 0;
      // An async implementation is assignable to the void-returning port type.
      const { result, uow, logs } = await run(async () => {
        throw new Error('bus rejected');
      });
      expect(result.status).toBe('REBUILT_PUBLISH_FAILED');
      expect(unhandled).toEqual([]);
      expect(uow.snapshot().positions.map((p) => p.signedQuantity)).toEqual(['3']);
      expect(logs.map((line) => (JSON.parse(line) as { code?: string }).code)).toEqual([
        POSITIONS_CHANGED_PUBLISH_FAILED,
      ]);
    });

    it('an async publisher that resolves is still not reported as published', async () => {
      unhandled.length = 0;
      const { result } = await run(async () => undefined);
      expect(result.status).toBe('REBUILT_PUBLISH_FAILED');
      expect(unhandled).toEqual([]);
    });

    it('a custom thenable whose then returns a rejecting promise causes no unhandled rejection', async () => {
      unhandled.length = 0;
      const thenable = {
        then: () => Promise.reject(new Error('then rejected')),
      };
      const { result } = await run(() => thenable as unknown as undefined);
      expect(result.status).toBe('REBUILT_PUBLISH_FAILED');
      expect(unhandled).toEqual([]);
    });
  });

  it('a throwing logger does not escape rebuild after the commit; the result is still returned', () => {
    const uow = new InMemoryUnitOfWork();
    insert(uow, [trade('BUY', '4', '2')]);
    const service = createPositionService({
      unitOfWork: uow,
      publisher: {
        publish: () => {
          throw new Error('bus down');
        },
      },
      logger: createLogger({
        clock: new FakeClock(T0),
        sink: () => {
          throw new Error('log sink down');
        },
      }),
    });
    let result: ReturnType<PositionService['rebuild']> | undefined;
    expect(() => {
      result = service.rebuild(PF);
    }).not.toThrow();
    expect(result?.status).toBe('REBUILT_PUBLISH_FAILED');
    expect(uow.snapshot().positions.map((p) => p.signedQuantity)).toEqual(['4']);
  });
});
