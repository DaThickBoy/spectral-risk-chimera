// Configuration for the AT-CFG-03 sample tests only.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['*.sample.ts'], environment: 'node' },
});
