// Task 12.7: VaR timing benchmark (R33.3). Run with `npm run bench:var`; never part of `npm test` or
// CI. Budgets (p95 <= 250 ms for 50 instruments, <= 2,000 ms for 500 instruments; provisional) are
// reported, not enforced, until task 25.1 and the reference environment (OD-2).
//
// Timed scope: `computeRisk` (Base VaR: exposures, scenario P&L, losses, Type 7 quantile, NAV,
// percentage) on a fixed, deterministic input with 250 scenarios. The fixture has no adjustment
// settings or sentiment, so the 14.1 eligibility gate ends the adjustment
// (ADJUSTMENT_CONFIG_MISSING) and the adjusted scenario P&L of 14.2 is not timed; the
// Base-plus-Adjusted budget is reported for Base VaR and the gate only.
// Procedure: 3 warm-up and 20 measured runs per size, monotonic `performance.now()`; p95 by
// nearest rank (19th of 20 sorted). Writes an environment record to bench-results/ (gitignored).
// Tests: AT-BEN-01
// Validates: Requirements 33.3
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { computeRisk } from '../../src/risk/index.js';
import type { RiskInput } from '../../src/risk/index.js';
import { position, riskInput } from '../helpers/risk.js';

const WARM_UP = 3;
const MEASURED = 20;
const SCENARIOS = 250;
const BUDGETS_MS: Record<number, number> = { 50: 250, 500: 2000 };

/** Deterministic returns in [-0.05, 0.05] with 4 decimals (Park-Miller generator, fixed seed). */
function fixture(instruments: number): RiskInput {
  let state = 20_261_108;
  const next = (bound: number): number => {
    state = (state * 48_271) % 2_147_483_647;
    return state % bound;
  };
  const positions = Array.from({ length: instruments }, (_, i) => {
    const ticker = `T${String(i).padStart(3, '0')}`;
    const qty = `${next(2) === 0 ? '-' : ''}${1 + next(1000)}`;
    return position(ticker, qty, `${1 + next(500)}.${String(next(100)).padStart(2, '0')}`);
  });
  const returns = Object.fromEntries(
    positions.map((p) => [
      p.ticker,
      Array.from({ length: SCENARIOS }, () => {
        const v = next(1001) - 500; // -500..500 basis-point tenths
        const abs = Math.abs(v);
        return `${v < 0 ? '-' : ''}0.${String(abs).padStart(4, '0')}`;
      }),
    ]),
  );
  const input = riskInput(positions, returns);
  return { ...input, params: { ...input.params, lookbackReturns: SCENARIOS, minObservations: 200 } };
}

it('VaR timing benchmark (R33.3)', () => {
  const sizes: Record<string, unknown>[] = [];
  for (const instruments of [50, 500]) {
    const input = fixture(instruments);
    for (let i = 0; i < WARM_UP; i += 1) {
      computeRisk(input);
    }
    const durations: number[] = [];
    let status = '';
    for (let i = 0; i < MEASURED; i += 1) {
      const start = performance.now();
      status = computeRisk(input).status;
      durations.push(performance.now() - start);
    }
    expect(status).toBe('OK');
    const p95 = [...durations].sort((a, b) => a - b)[18] ?? Number.NaN; // nearest rank: 19th value
    const budget = BUDGETS_MS[instruments] ?? 0;
    sizes.push({
      instruments,
      scenarios: SCENARIOS,
      durationsMs: durations.map((ms) => ms.toFixed(3)), // timing, not a financial value
      p95Ms: p95.toFixed(3),
      budgetMs: String(budget),
      withinBudget: p95 <= budget,
    });
    process.stdout.write(
      `VaR ${instruments} instruments: p95 ${p95.toFixed(3)} ms (budget ${budget} ms, not enforced)\n`,
    );
  }
  const cpus = os.cpus();
  const record = {
    benchmark: 'var-engine',
    timedScope:
      'computeRisk (Base VaR and the adjustment eligibility gate; no adjustment settings in the fixture)',
    warmUpRuns: WARM_UP,
    measuredRuns: MEASURED,
    enforced: false,
    sizes,
    environment: {
      cpuModel: cpus[0]?.model ?? 'unknown',
      cores: os.availableParallelism(),
      ramBytes: String(os.totalmem()),
      os: `${os.type()} ${os.release()} (${os.version()})`,
      arch: os.arch(),
      node: process.version,
    },
    recordedAt: new Date().toISOString(),
  };
  mkdirSync('bench-results', { recursive: true });
  writeFileSync(
    `bench-results/var-engine-${record.recordedAt.replace(/[:.]/g, '-')}.json`,
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
  expect(sizes).toHaveLength(2);
}, 600_000);
