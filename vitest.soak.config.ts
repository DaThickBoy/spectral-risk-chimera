// Scheduled soak runs (task 25.2): only `npm run soak` runs files in test/soak/. They are never part
// of `npm test`; CI runs them on a schedule (.github/workflows/soak.yml).
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'soak',
    include: ['test/soak/**/*.soak.test.ts'],
    environment: 'node',
    testTimeout: 900_000,
    fileParallelism: false,
  },
});
