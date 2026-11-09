// Playwright end-to-end tests (task 17.5; OD-21). They run the BUILT dashboard with the exported
// deterministic replay (`npm run build && npm run export:replay`), served under the GitHub Pages
// repository subpath by scripts/serve-pages.mjs. No backend, no live provider, no network
// access beyond 127.0.0.1. Chromium only, to keep the browser stack small.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
export const PAGES_BASE = '/spectral-risk-chimera/';

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/serve-pages.mjs --root dist/web --base ${PAGES_BASE} --port ${String(PORT)}`,
    url: `http://127.0.0.1:${String(PORT)}${PAGES_BASE}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
