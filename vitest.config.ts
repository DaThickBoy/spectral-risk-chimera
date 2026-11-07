// Vitest projects (task 1.5; R27.3, R27.10). `npm test` runs unit, property, and
// integration suites and exits non-zero on failure. Tests that need live network
// access live in test/live/ and run only through `npm run test:live`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'property',
          include: ['test/property/**/*.property.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
