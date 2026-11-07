// Opt-in live tests (R27.3): only `npm run test:live` runs files in test/live/.
// They are never part of `npm test` or CI.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'live',
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
