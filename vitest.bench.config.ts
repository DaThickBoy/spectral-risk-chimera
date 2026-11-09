// Opt-in benchmarks (task 7.7, NFR-PERF-1): only `npm run bench:csv` runs files in test/bench/.
// They are never part of `npm test` or CI; budgets are reported, not enforced, until task 25.1.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'bench',
    include: ['test/bench/**/*.bench.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    // One worker, so the measured runs do not compete with other test files.
    fileParallelism: false,
  },
});
