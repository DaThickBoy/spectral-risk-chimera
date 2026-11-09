// Task 17.5 (OD-21): browser tests of the BUILT dashboard with the exported deterministic replay,
// served under the GitHub Pages subpath. Prerequisite: `npm run build && npm run export:replay`.
// Stale and unavailable states use a test-only variant of the recorded view (served by request
// interception, clearly not part of the replay); every other value is the recorded replay.
// Validates: Requirements 17.10, 30.14, 35.1, 35.4, 35.6
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = '/spectral-risk-chimera/';

interface Watch {
  readonly consoleErrors: string[];
  readonly failed: string[];
  readonly requests: { readonly method: string; readonly url: string }[];
}

function watch(page: Page): Watch {
  const w: Watch = { consoleErrors: [], failed: [], requests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') w.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => w.consoleErrors.push(error.message));
  page.on('requestfailed', (request) => w.failed.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) w.failed.push(`${String(response.status())} ${response.url()}`);
  });
  page.on('request', (request) => w.requests.push({ method: request.method(), url: request.url() }));
  return w;
}

/** Same origin, under the Pages base, GET only, and never a backend route. */
function expectStaticOnly(w: Watch, origin: string): void {
  for (const r of w.requests) {
    expect(r.method, r.url).toBe('GET');
    expect(r.url.startsWith(`${origin}${BASE}`), r.url).toBe(true);
    expect(r.url, r.url).not.toMatch(/\/dashboard(\/|$)|\/portfolios\/|\/imports|\/stream/);
  }
}

function expectClean(w: Watch): void {
  expect(w.consoleErrors).toEqual([]);
  expect(w.failed).toEqual([]);
}

/** The fields of a recorded view that the test-only variant changes. */
interface RecordedView {
  fx: Record<string, unknown>[];
  view: { baseVaR: unknown };
  display: { baseVaR: string | null };
  freshness: Record<string, unknown>;
}

const panel = (page: Page, title: string) =>
  page.locator('section.panel', { has: page.getByRole('heading', { name: title }) });

test.describe('recorded replay under the GitHub Pages subpath', () => {
  test('loads the multi-currency EUR portfolio with its recorded values and labels', async ({
    page,
    baseURL,
  }) => {
    const w = watch(page);
    await page.goto(BASE);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');

    const bar = page.locator('header.topbar');
    await expect(bar).toContainText('RECORDED REPLAY');
    await expect(bar).toContainText('recorded 2026-11-06 16:00 UTC');
    await expect(bar).toContainText('DEMO DATA');
    await expect(bar).toContainText('DEMO FIXTURES');
    await expect(bar).toContainText('22375.74 EUR');
    await expect(bar).toContainText('CURRENT');
    await expect(page.locator('.replay-note')).toContainText('Recorded DEMO replay');
    await expect(page.locator('.demo-banner')).toContainText('DEMO DATA');

    await expect(page.locator('.panels h2')).toHaveText([
      'Base VaR',
      'Sentiment-Adjusted VaR',
      'Market Sentiment',
      'SEC Filing Risk',
    ]);
    await expect(panel(page, 'Base VaR')).toContainText(
      '1 day · 95% · Historical Simulation · as of 2026-11-06',
    );

    const adjusted = panel(page, 'Sentiment-Adjusted VaR');
    await expect(adjusted.getByTestId('adjusted-var-value')).toHaveText('Unavailable');
    await expect(adjusted).toContainText('No sentiment aggregation method is approved (open decision OD-1)');
    await expect(adjusted).toContainText('AGGREGATION NOT APPROVED · OD-1');
    await expect(adjusted).not.toContainText('124.10');

    await expect(panel(page, 'SEC Filing Risk')).toContainText('NOT CONFIGURED');

    const positions = page.locator('section', {
      has: page.getByRole('heading', { name: 'Positions and allocation' }),
    });
    await expect(positions).toContainText('8994.29 EUR');
    await expect(positions).toContainText('6655.13 EUR');
    await expect(positions).toContainText('5726.32 EUR');
    await expect(positions).toContainText('40.20%');

    // ECB: published observation versus derived inverse rate (OD-20).
    await expect(page.getByTestId('derived-USD')).toHaveText(
      'Derived: 1 / published EUR→USD (40 significant digits, ROUND HALF UP)',
    );
    await expect(page.getByTestId('quote-USD')).toContainText('EUR→USD 1.1165');
    await expect(page.getByTestId('quote-USD')).toContainText(
      'Published observation · reference date 2026-11-06',
    );
    await expect(page.getByTestId('quote-GBP')).toContainText('EUR→GBP 0.83415');
    await expect(page.getByTestId('fx-attribution')).toContainText('Source: ECB statistics.');
    await expect(page.getByTestId('fx-attribution')).toContainText('information purposes only');
    await expect(
      page.locator('section', { has: page.getByRole('heading', { name: 'FX rates used' }) }),
    ).toContainText('0.8956560680698611733094491715181370353784');

    expectStaticOnly(w, new URL(baseURL ?? '').origin);
    expectClean(w);
  });

  test('the EUR-only fallback, back and forward, and refresh keep the portfolio in the URL', async ({
    page,
  }) => {
    const w = watch(page);
    await page.goto(BASE);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    await page.locator('#portfolio-select').selectOption('demo-eur-only');
    await expect(page).toHaveURL(/\?portfolio=demo-eur-only$/);
    await expect(page.getByTestId('base-var-value')).toHaveText('140.18 EUR');
    await expect(page.locator('header.topbar')).toContainText('14025.44 EUR');
    // Only the identity rate: nothing depends on the ECB.
    const fx = page.locator('section', { has: page.getByRole('heading', { name: 'FX rates used' }) });
    await expect(fx.locator('tbody tr')).toHaveCount(1);
    await expect(fx).toContainText('Identity (base currency)');

    await page.reload();
    await expect(page.getByTestId('base-var-value')).toHaveText('140.18 EUR');
    await page.goBack();
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    await page.goForward();
    await expect(page.getByTestId('base-var-value')).toHaveText('140.18 EUR');
    expectClean(w);
  });

  test('direct navigation: a deep link, and the subpath without its trailing slash', async ({ page }) => {
    const w = watch(page);
    await page.goto(`${BASE}?portfolio=demo-eur-only`);
    await expect(page.getByTestId('base-var-value')).toHaveText('140.18 EUR');
    const response = await page.goto(BASE.slice(0, -1));
    expect(response?.url()).toMatch(/\/spectral-risk-chimera\/$/);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    // Unknown portfolio in the URL: the first listed portfolio is shown instead of nothing.
    await page.goto(`${BASE}?portfolio=no-such-portfolio`);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    expect(w.consoleErrors).toEqual([]);
  });

  test('every asset of the build loads (no missing script, style, or replay file)', async ({
    page,
    request,
  }) => {
    const html = await (await request.get(BASE)).text();
    const assets = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of [
      ...assets,
      'replay/manifest.json',
      'replay/demo-eur-usd-gbp.json',
      'replay/demo-eur-only.json',
    ]) {
      const response = await request.get(`${BASE}${asset}`);
      expect(response.status(), asset).toBe(200);
    }
    // The static server has no write route.
    expect((await request.post(`${BASE}replay/manifest.json`)).status()).toBe(405);
    await page.goto(BASE);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
  });
});

test.describe('states', () => {
  test('stale and unavailable FX (test-only variant of the recorded view)', async ({ page }) => {
    const recorded = JSON.parse(
      readFileSync('dist/web/replay/demo-eur-usd-gbp.json', 'utf8'),
    ) as RecordedView;
    const variant = structuredClone(recorded);
    variant.fx = variant.fx.map((entry: Record<string, unknown>) =>
      entry['currency'] === 'GBP'
        ? { ...entry, status: 'STALE', rate: null, unavailable: { code: 'FX_STALE', currency: 'GBP' } }
        : entry['currency'] === 'USD'
          ? {
              ...entry,
              status: 'UNAVAILABLE',
              rate: null,
              unavailable: {
                code: 'FX_UNAVAILABLE',
                currency: 'USD',
                cause: 'PROVIDER_ERROR',
                providerCode: 'HTTP_SERVER_ERROR',
              },
            }
          : entry,
    );
    variant.view.baseVaR = {
      validity: 'UNAVAILABLE',
      value: null,
      status: 'FX_UNAVAILABLE',
      reason: { missingConfigKeys: [], ineligibleTickers: [], code: 'FX_UNAVAILABLE' },
      lastValid: null,
    };
    variant.display.baseVaR = null;
    variant.freshness = {
      ...variant.freshness,
      fxStatuses: ['IDENTITY', 'STALE', 'UNAVAILABLE'],
      summary: 'FX_UNAVAILABLE',
    };
    await page.route('**/replay/demo-eur-usd-gbp.json', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(variant) }),
    );
    await page.goto(BASE);
    await expect(page.getByTestId('base-var-value')).toHaveText('\u2014');
    await expect(panel(page, 'Base VaR')).toContainText('Unavailable: FX UNAVAILABLE');
    await expect(page.locator('header.topbar')).toContainText('FX UNAVAILABLE');
    const fx = page.locator('section', { has: page.getByRole('heading', { name: 'FX rates used' }) });
    await expect(fx).toContainText('STALE');
    await expect(fx).toContainText('PROVIDER ERROR');
  });

  test('loading state while the replay manifest is delayed', async ({ page }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/replay/manifest.json', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto(BASE);
    await expect(page.getByRole('status')).toHaveText('Loading portfolio data…');
    release();
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
  });

  test('a missing replay is explained, not shown as data', async ({ page }) => {
    await page.route('**/replay/manifest.json', (route) => route.fulfill({ status: 404, body: 'Not found' }));
    await page.goto(BASE);
    await expect(page.getByRole('alert')).toContainText(
      'The recorded replay files were not found next to this page',
    );
    await expect(page.locator('.panels')).toHaveCount(0);
  });

  test('an invalid replay (claims to be live) is refused and explained', async ({ page }) => {
    const manifest = JSON.parse(readFileSync('dist/web/replay/manifest.json', 'utf8')) as Record<
      string,
      unknown
    >;
    await page.route('**/replay/manifest.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...manifest, live: true }),
      }),
    );
    await page.goto(BASE);
    await expect(page.getByRole('alert')).toContainText(
      'The recorded replay is incomplete or does not match',
    );
    await expect(page.locator('.panels')).toHaveCount(0);
  });
});
