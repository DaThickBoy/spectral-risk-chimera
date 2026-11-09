// Task 7.5: the app-layer import use case (design: Import pipeline, D-16).
// Positions are rebuilt only after the import committed; the fake unit of work fails the commit.
// Tests: AT-POS-04, AT-CSV-10, AT-CSV-11
// Validates: Requirements 5.4, 5.5, 28.17, 28.20, 28.21
import { describe, expect, it } from 'vitest';
import {
  createImportUseCase,
  createPortfolioService,
  createPositionService,
} from '../../../src/app/index.js';
import type { PositionsChanged } from '../../../src/portfolio/index.js';
import { FakeClock, brandDecimalString, createLogger } from '../../../src/shared/index.js';
import { bytes } from '../../helpers/csv.js';
import { csv } from '../../helpers/importRows.js';
import { NOW, PF, importHarness } from '../../helpers/importService.js';
import type { HarnessOptions } from '../../helpers/importService.js';

function setup(options: HarnessOptions = {}) {
  const h = importHarness(options);
  const events: PositionsChanged[] = [];
  const positions = createPositionService({
    unitOfWork: h.uow,
    publisher: { publish: (event) => events.push(event) },
    logger: createLogger({ clock: new FakeClock(NOW), sink: () => undefined }),
  });
  const portfolios = createPortfolioService({ unitOfWork: h.uow, baseCurrency: 'USD' });
  expect(portfolios.create({ id: PF, baseCurrency: 'USD', cash: brandDecimalString('1000') }).status).toBe(
    'CREATED',
  );
  const useCase = createImportUseCase({ imports: h.service, positions, portfolios, unitOfWork: h.uow });
  const run = (text: string, columns = {}) =>
    useCase.run({ portfolioId: PF, fileName: 'trades.csv', bytes: bytes(text), columns });
  return { ...h, events, useCase, run };
}

const BUY = '2026-11-02T14:30:00Z,AAA,BUY,10,12.5,USD';
const SELL_15 = '2026-11-03T14:30:00Z,AAA,SELL,15,13,USD';

describe('import use case', () => {
  it('rebuilds positions after a successful commit', async () => {
    const s = setup();
    const result = await s.run(csv(BUY));
    expect(result).toMatchObject({ status: 'DONE', positions: 'REBUILT', summary: { status: 'COMMITTED' } });
    expect(s.inner.snapshot().positions.map((p) => [p.ticker, p.signedQuantity, p.averagePrice])).toEqual([
      ['AAA', '10', '12.5'],
    ]);
    expect(s.events).toHaveLength(1);
  });

  it('a failed commit leaves positions unchanged and publishes nothing (AT-POS-04)', async () => {
    const s = setup();
    await s.run(csv(BUY));
    const before = s.inner.snapshot().positions;
    s.events.length = 0;
    // Runs from now: 0 portfolio lookup, 1 ledger read, 2 import commit.
    s.uow.armRun(2, 0);
    const result = await s.run(csv('2026-11-04T14:30:00Z,AAA,BUY,5,20,USD'));
    expect(result).toEqual({
      status: 'DONE',
      summary: expect.objectContaining({ status: 'FAILED', persisted: false }),
    });
    expect(s.inner.snapshot().positions).toEqual(before);
    expect(s.inner.snapshot().transactions).toHaveLength(1);
    expect(s.events).toEqual([]);
  });

  it('REJECT never produces a short position (AT-CSV-10)', async () => {
    const s = setup({ policy: 'REJECT' });
    const result = await s.run(csv(BUY, SELL_15));
    expect(result).toMatchObject({ summary: { accepted: 1, rejected: 1 } });
    expect(s.inner.snapshot().positions.map((p) => [p.signedQuantity, p.isShort])).toEqual([['10', false]]);
  });

  it('ALLOW_SHORT produces a negative position flagged short (AT-CSV-11)', async () => {
    const s = setup({ policy: 'ALLOW_SHORT' });
    await s.run(csv(BUY, SELL_15));
    // 10 - 15 = -5; the remainder opens short at the crossing price 13 (FR-13).
    expect(s.inner.snapshot().positions.map((p) => [p.signedQuantity, p.isShort, p.averagePrice])).toEqual([
      ['-5', true, '13'],
    ]);
  });

  it('a refused import (policy missing) does not rebuild positions', async () => {
    const s = setup({ policy: 'MISSING' });
    const result = await s.run(csv(BUY));
    expect(result).toEqual({ status: 'DONE', summary: expect.objectContaining({ status: 'FAILED' }) });
    expect(s.inner.snapshot().positions).toEqual([]);
  });

  it('an unknown portfolio and an invalid mapping are reported without importing', async () => {
    const s = setup();
    expect(
      await s.useCase.run({ portfolioId: 'pf-x', fileName: 'f.csv', bytes: bytes(csv(BUY)), columns: {} }),
    ).toEqual({ status: 'PORTFOLIO_NOT_FOUND' });
    expect(await s.run(csv(BUY), { ticker: 'Same', currency: 'Same' })).toEqual({
      status: 'MAPPING_INVALID',
    });
    expect(s.inner.snapshot().imports).toEqual([]);
  });

  it('reads the stored summary and the rejections in row order', async () => {
    const s = setup();
    const result = await s.run(csv('x,AAA,BUY,1,1,USD', BUY, '2026-11-02T14:30:00Z,AAA,BUY,0,1,USD'));
    if (result.status !== 'DONE') {
      throw new Error('expected DONE');
    }
    const id = result.summary.importId;
    expect(s.useCase.summary(id)?.status).toBe('COMMITTED_WITH_REJECTIONS');
    expect(s.useCase.rejections(id)?.map((r) => [r.sequence, r.reasonCode])).toEqual([
      [1, 'INVALID_DATE'],
      [3, 'MALFORMED_NUMBER'],
    ]);
    expect(s.useCase.summary('missing')).toBeUndefined();
    expect(s.useCase.rejections('missing')).toBeUndefined();
  });
});
