// Task 12.4: the recalculation scheduler and the risk worker client (design: Risk Worker and
// Scheduler). The worker client is exercised with a JavaScript protocol double; the compiled
// worker itself is started without a TypeScript loader in test/integration/build.test.ts.
// Tests: AT-DSH-07
// Validates: Requirements 16.1, 16.6, 22.6, 23.4, 33.9
import { describe, expect, it } from 'vitest';
import { RiskWorkerError, createRiskScheduler, createRiskWorkerClient } from '../../../src/app/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import { FakeClock, sequentialIds } from '../../../src/shared/index.js';
import { position, riskInput } from '../../helpers/risk.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('risk scheduler (AT-DSH-07)', () => {
  it('a burst of requests yields at most two runs per portfolio', async () => {
    const runs: string[] = [];
    const gate = deferred();
    const scheduler = createRiskScheduler({
      run: async (id, reason) => {
        runs.push(`${id}:${reason}`);
        if (runs.length === 1) {
          await gate.promise;
        }
      },
      onError: () => undefined,
    });
    for (let i = 0; i < 25; i += 1) {
      scheduler.requestRecalculation('pf-1', i === 0 ? 'MANUAL' : 'SCHEDULED');
    }
    scheduler.onPositionsChanged({ type: 'PositionsChanged', portfolioId: 'pf-1' } as never);
    gate.resolve();
    await scheduler.idle('pf-1');
    expect(runs).toEqual(['pf-1:MANUAL', 'pf-1:SCHEDULED']);
  });

  it('portfolios are independent, and a failed run does not stop the next one', async () => {
    const runs: string[] = [];
    const errors: string[] = [];
    const scheduler = createRiskScheduler({
      run: async (id) => {
        runs.push(id);
        if (runs.length === 1) {
          throw new Error('boom');
        }
      },
      onError: (id) => errors.push(id),
    });
    scheduler.requestRecalculation('pf-1', 'MANUAL');
    scheduler.requestRecalculation('pf-2', 'MANUAL');
    await Promise.all([scheduler.idle('pf-1'), scheduler.idle('pf-2')]);
    scheduler.requestRecalculation('pf-1', 'MANUAL');
    await scheduler.idle('pf-1');
    expect(runs).toEqual(['pf-1', 'pf-2', 'pf-1']);
    expect(errors).toEqual(['pf-1']);
  });

  it('PositionsChanged requests a full recalculation', async () => {
    const runs: string[] = [];
    const scheduler = createRiskScheduler({
      run: async (id, reason) => void runs.push(`${id}:${reason}`),
      onError: () => undefined,
    });
    scheduler.onPositionsChanged({ type: 'PositionsChanged', portfolioId: 'pf-9' } as never);
    await scheduler.idle('pf-9');
    expect(runs).toEqual(['pf-9:POSITIONS_CHANGED']);
  });
});

describe('risk worker client: crash and restart', () => {
  const url = new URL('../../fixtures/risk/fakeRiskWorker.mjs', import.meta.url);
  const input = (portfolioId: string) => ({
    ...riskInput([position('AAA', '1', '1')], { AAA: ['0.1', '0.2'] }),
    portfolioId,
  });

  it('a crash rejects the request, is audited, and the next request starts a new worker', async () => {
    const uow = new InMemoryUnitOfWork();
    const client = createRiskWorkerClient({
      unitOfWork: uow,
      clock: new FakeClock('2026-11-08T12:00:00.000Z'),
      ids: sequentialIds('w'),
      workerUrl: url,
    });
    try {
      await expect(client.compute(input('crash'))).rejects.toEqual(new RiskWorkerError('WORKER_CRASHED'));
      const audit = uow.snapshot().audit;
      expect(audit.map((a) => [a.category, a.type, a.details['component']])).toEqual([
        ['CALCULATION', 'CALCULATION_ERROR', 'riskWorker'],
      ]);
      expect(JSON.stringify(audit)).not.toContain('crash');
      await expect(client.compute(input('pf-1'))).rejects.toEqual(new RiskWorkerError('CALCULATION_ERROR'));
      expect(client.starts).toBe(2);
    } finally {
      await client.close();
    }
    await expect(client.compute(input('pf-1'))).rejects.toEqual(new RiskWorkerError('CLOSED'));
  });
});
