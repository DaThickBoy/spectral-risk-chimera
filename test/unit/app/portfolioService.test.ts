// Task 6.1: portfolio creation with explicit cash and the portfolios repository (design: Allocation
// and cash; A-7, FR-10, R30.1).
// Tests: AT-ALC-10
// Validates: Requirements 4.3, 20.1, 30.1
import { describe, expect, it } from 'vitest';
import { createPortfolioService } from '../../../src/app/index.js';
import { InMemoryUnitOfWork, PersistenceError } from '../../../src/persistence/index.js';
import type { PortfolioRecord, UnitOfWork } from '../../../src/persistence/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import type { DecimalString } from '../../../src/shared/index.js';

const cash = (text: string): DecimalString => brandDecimalString(text);

describe('createPortfolioService', () => {
  it('creates with canonical cash; "0" and negative values are valid', () => {
    const uow = new InMemoryUnitOfWork();
    const service = createPortfolioService({ unitOfWork: uow, baseCurrency: 'USD' });
    expect(service.create({ id: 'a', baseCurrency: 'USD', cash: cash('0.000') })).toEqual({
      status: 'CREATED',
      portfolio: { id: 'a', baseCurrency: 'USD', cash: '0' },
    });
    expect(service.create({ id: 'b', baseCurrency: 'USD', cash: cash('-12.50') })).toMatchObject({
      portfolio: { cash: '-12.5' },
    });
    expect(service.get('b')).toEqual({ id: 'b', baseCurrency: 'USD', cash: '-12.5' });
    expect(service.get('none')).toBeUndefined();
  });

  it('an existing id is PORTFOLIO_EXISTS and writes nothing', () => {
    const uow = new InMemoryUnitOfWork();
    const service = createPortfolioService({ unitOfWork: uow, baseCurrency: 'USD' });
    service.create({ id: 'a', baseCurrency: 'USD', cash: cash('1') });
    expect(service.create({ id: 'a', baseCurrency: 'USD', cash: cash('2') })).toEqual({
      status: 'PORTFOLIO_EXISTS',
    });
    expect(uow.snapshot().portfolios).toEqual([{ id: 'a', baseCurrency: 'USD', cash: '1' }]);
  });

  it('a base currency other than fx.baseCurrency is BASE_CURRENCY_NOT_SUPPORTED', () => {
    const service = createPortfolioService({ unitOfWork: new InMemoryUnitOfWork(), baseCurrency: 'USD' });
    expect(service.create({ id: 'a', baseCurrency: 'EUR', cash: cash('0') })).toEqual({
      status: 'BASE_CURRENCY_NOT_SUPPORTED',
      baseCurrency: 'USD',
    });
  });

  it('a commit failure is COMMIT_FAILED; other exceptions propagate', () => {
    const uow = new InMemoryUnitOfWork();
    const service = createPortfolioService({ unitOfWork: uow, baseCurrency: 'USD' });
    uow.failNextCommit({ atWrite: 0 });
    expect(service.create({ id: 'a', baseCurrency: 'USD', cash: cash('0') })).toEqual({
      status: 'COMMIT_FAILED',
      code: 'COMMIT_FAILED',
    });
    const throwing: UnitOfWork = {
      run: () => {
        throw new Error('bug');
      },
    };
    expect(() =>
      createPortfolioService({ unitOfWork: throwing, baseCurrency: 'USD' }).create({
        id: 'a',
        baseCurrency: 'USD',
        cash: cash('0'),
      }),
    ).toThrow('bug');
  });

  it('missing or invalid cash is a programmer error, never a default', () => {
    const service = createPortfolioService({ unitOfWork: new InMemoryUnitOfWork(), baseCurrency: 'USD' });
    for (const bad of [undefined, '', '1e3', 5]) {
      expect(() =>
        service.create({ id: 'a', baseCurrency: 'USD', cash: bad as unknown as DecimalString }),
      ).toThrow(TypeError);
    }
    expect(() =>
      createPortfolioService({ unitOfWork: new InMemoryUnitOfWork(), baseCurrency: 'XXZ' }),
    ).toThrow(TypeError);
  });
});

describe('portfolios repository constraints (in-memory unit of work)', () => {
  const bad: [string, PortfolioRecord][] = [
    ['an empty id', { id: '', baseCurrency: 'USD', cash: cash('0') }],
    ['an invalid currency', { id: 'a', baseCurrency: 'usd', cash: cash('0') }],
    ['non-canonical cash', { id: 'a', baseCurrency: 'USD', cash: '1.50' as DecimalString }],
    ['missing cash', { id: 'a', baseCurrency: 'USD' } as unknown as PortfolioRecord],
  ];
  it.each(bad)('%s violates a constraint and writes nothing', (_name, record) => {
    const uow = new InMemoryUnitOfWork();
    expect(() => uow.run((tx) => tx.portfolios.insert(record))).toThrow(PersistenceError);
    expect(uow.snapshot().portfolios).toEqual([]);
  });

  it('a duplicate id violates a constraint', () => {
    const uow = new InMemoryUnitOfWork();
    uow.run((tx) => tx.portfolios.insert({ id: 'a', baseCurrency: 'USD', cash: cash('0') }));
    expect(() =>
      uow.run((tx) => tx.portfolios.insert({ id: 'a', baseCurrency: 'USD', cash: cash('1') })),
    ).toThrow(PersistenceError);
  });
});
