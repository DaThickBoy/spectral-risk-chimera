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
  lossDistribution: unknown;
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
    // S1: NAV and freshness are in the headline summary, directly below the top bar.
    const summary = page.getByTestId('summary');
    await expect(summary).toContainText('22375.74 EUR');
    await expect(summary).toContainText('CURRENT');
    await expect(page.getByTestId('summary-base-var')).toHaveText('124.10 EUR');
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
    // Every risk panel header states its time (ui-guidelines 3); NAV and overview carry DEMO.
    await expect(panel(page, 'Sentiment-Adjusted VaR')).toContainText('1 day · 95% · as of 2026-11-06');
    await expect(panel(page, 'Market Sentiment')).toContainText('as of 2026-11-06 16:00 UTC');
    await expect(panel(page, 'SEC Filing Risk')).toContainText('as of \u2014 (not configured)');
    await expect(page.getByTestId('summary-nav')).toHaveText('22375.74 EUR');
    await expect(page.getByTestId('summary-badges')).toContainText('DEMO DATA');

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

  test('A2: the loss distribution shows 20 buckets of the recorded Base VaR scenarios and the VaR marker', async ({
    page,
  }) => {
    for (const [portfolio, varText, raw] of [
      ['demo-eur-usd-gbp', '124.10', '124.095376636618777169053781414066570861'],
      ['demo-eur-only', '140.18', '140.1806869978253353800812193977189520388'],
    ] as const) {
      await page.goto(`${BASE}?portfolio=${portfolio}`);
      const loss = page.getByTestId('loss-distribution');
      await expect(loss.getByRole('heading', { level: 2 })).toHaveText(
        'Loss distribution · Base VaR scenarios · 1 day · 95% · Historical Simulation · as of 2026-11-06 16:00 UTC',
      );
      await expect(page.getByTestId('loss-badges')).toContainText('DEMO');
      await expect(
        page.getByRole('img', { name: 'Base VaR scenario losses, 20 buckets, EUR' }),
      ).toBeVisible();
      await expect(page.locator('[data-testid^="loss-bar-"]')).toHaveCount(20);
      await expect(loss.locator('svg')).toContainText(`VaR 95% · ${varText} EUR`);
      const rows = page.getByTestId('loss-table').locator('tbody tr');
      await expect(rows).toHaveCount(20);
      // The marker bucket names the exact, unrounded raw quantile (the Base VaR panel shows it too).
      await expect(rows.nth(19)).toContainText(`VaR 95% at ${raw}`);
      await expect(panel(page, 'Base VaR')).toContainText(raw);
      await expect(page.getByTestId('loss-summary')).toContainText(
        '250 daily scenarios from returns ending 2025-11-24 to 2026-11-06 (UTC dates), in 20 buckets',
      );
      await expect(page.getByTestId('loss-summary')).toContainText(
        'Scenarios with a larger loss than the marker: 13.',
      );
    }
  });

  test('A1: DEMO sentiment is shown exactly, CURRENT and DEMO, as the latest observation; Adjusted VaR stays unavailable', async ({
    page,
  }) => {
    for (const [portfolio, rows] of [
      [
        'demo-eur-usd-gbp',
        [
          ['DEMO-EU', '-0.35'],
          ['DEMO-UK', '-0.72'],
          ['DEMO-US', '0.42'],
        ],
      ],
      [
        'demo-eur-only',
        [
          ['DEMO-A', '0.15'],
          ['DEMO-EU', '-0.35'],
        ],
      ],
    ] as const) {
      await page.goto(`${BASE}?portfolio=${portfolio}`);
      const sentiment = panel(page, 'Market Sentiment');
      await expect(sentiment).toContainText('-1 (bearish) to +1 (bullish)');
      await expect(sentiment).toContainText('Scale: -1 bearish to +1 bullish');
      await expect(sentiment).not.toContainText(/confidence/i);
      for (const [ticker, value] of rows) {
        const row = page.getByTestId(`sentiment-${ticker}`);
        await expect(row).toContainText(`${ticker} ${value}`);
        await expect(row).toContainText('CURRENT');
        await expect(row).toContainText('DEMO');
        await expect(row).toContainText(
          'latest observation, not an aggregated index · observed 2026-11-06 15:55 UTC',
        );
      }
      const adjusted = panel(page, 'Sentiment-Adjusted VaR');
      await expect(page.getByTestId('adjusted-var-value')).toHaveText('Unavailable');
      await expect(adjusted).toContainText('SENTIMENT NOT CURRENT');
      await expect(adjusted).toContainText('AGGREGATION NOT APPROVED · OD-1');
      await expect(page.getByTestId('adjusted-var-reason')).toContainText(
        'No sentiment aggregation method is approved (open decision OD-1)',
      );
      await expect(page.getByTestId('adjusted-var-reason')).toContainText('(DEMO)');
    }
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
    await expect(page.getByTestId('summary-nav')).toHaveText('14025.44 EUR');
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

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`guided tour on the recorded replay at ${String(viewport.width)} px: keyboard, six steps, no overflow`, async ({
      page,
    }) => {
      const w = watch(page);
      await page.setViewportSize(viewport);
      await page.goto(BASE);
      await expect(page.getByTestId('summary-nav')).toHaveText('22375.74 EUR');
      await expect(page.getByTestId('tour-card')).toHaveCount(0); // never starts by itself
      await page.getByTestId('tour-start').focus();
      await page.keyboard.press('Enter');
      const card = page.getByTestId('tour-card');
      await expect(card).toContainText('Guided tour · step 1 of 6');
      await expect(card).toContainText('recorded DEMO replay');
      await expect(card).toContainText('recorded 2026-11-06 16:00 UTC');
      await expect(card.getByRole('heading', { name: 'The portfolio' })).toBeFocused();
      for (const title of [
        'NAV',
        'Base VaR',
        'Allocation and currency exposure',
        'Loss distribution and the VaR marker',
        'Unavailable and DEMO',
      ]) {
        await page.getByTestId('tour-next').click();
        await expect(card.getByRole('heading', { name: title })).toBeFocused();
        await expect(card).toBeInViewport();
        const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
        expect(overflow, title).toBeLessThanOrEqual(0);
      }
      await expect(card).toContainText('open decision OD-1');
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(page.getByTestId('tour-start')).toBeFocused();
      await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
      expectClean(w);
    });
  }

  // Judge review P1: step 4 opened with its heading at the bottom edge, so focus did not scroll
  // and its explanation and controls stayed below the fold. Every step must open fully visible.
  for (const portfolio of ['demo-eur-usd-gbp', 'demo-eur-only']) {
    test(`guided tour at 1440 px (${portfolio}): each step's explanation and controls are visible without scrolling`, async ({
      page,
    }) => {
      const w = watch(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${BASE}?portfolio=${portfolio}`);
      await expect(page.getByTestId('summary')).toBeVisible();
      await page.getByTestId('tour-start').click();
      const card = page.getByTestId('tour-card');
      for (let step = 1; step <= 6; step += 1) {
        await expect(card).toContainText(`Guided tour · step ${String(step)} of 6`);
        // The whole card (explanation and all three controls) is inside the viewport.
        await expect(card, `step ${String(step)} card`).toBeInViewport({ ratio: 1 });
        for (const name of ['Back', step === 6 ? 'Finish' : 'Next', 'End tour']) {
          await expect(card.getByRole('button', { name }), `step ${String(step)} ${name}`).toBeInViewport({
            ratio: 1,
          });
        }
        await expect(card.getByRole('heading', { level: 2 })).toBeFocused();
        if (step === 4) {
          for (const line of await card.locator('.tour-line').all()) {
            await expect(line, 'step 4 explanation').toBeInViewport({ ratio: 1 });
          }
          await expect(card).toContainText('fixed 0–100 % axis');
        }
        if (step < 6) await page.getByTestId('tour-next').click();
      }
      await page.getByTestId('tour-next').click(); // Finish
      await expect(card).toHaveCount(0);
      await expect(page.getByTestId('tour-start')).toBeFocused();
      expectClean(w);
    });
  }

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    test(`headline figures at ${String(viewport.width)} px: NAV primary, Base VaR separated and secondary`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(BASE);
      await expect(page.getByTestId('summary-nav')).toHaveText('22375.74 EUR');
      await expect(page.getByTestId('summary-base-var')).toHaveText('124.10 EUR');
      const m = (await page.evaluate(`(() => {
        const nav = document.querySelector('[data-testid="summary-nav"]');
        const bv = document.querySelector('[data-testid="summary-base-var"]');
        const fig = bv.closest('.summary-figure');
        const text = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
        return {
          navPx: parseFloat(getComputedStyle(nav).fontSize),
          varPx: parseFloat(getComputedStyle(bv).fontSize),
          gap: text(bv).left - text(nav).right,
          sameRow: Math.abs(text(bv).top - text(nav).top) < 20,
          divider: getComputedStyle(fig).borderLeftStyle,
        };
      })()`)) as { navPx: number; varPx: number; gap: number; sameRow: boolean; divider: string };
      expect(m.varPx).toBeLessThan(m.navPx); // NAV primary, Base VaR secondary
      if (viewport.width === 1440) {
        expect(m.sameRow).toBe(true);
        expect(m.divider).toBe('solid');
        expect(m.gap).toBeGreaterThanOrEqual(40); // was about 23 px before the review fix
      } else {
        expect(m.sameRow).toBe(false); // stacked on the phone
        expect(m.divider).toBe('none');
      }
    });
  }
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
    // As the backend reports it when Base VaR is unavailable (A2): a reason, never zero bars.
    variant.lossDistribution = {
      status: 'UNAVAILABLE',
      reason: 'BASE_VAR_UNAVAILABLE',
      explanation: 'Base VaR is unavailable (FX_UNAVAILABLE), so no scenario loss distribution is shown.',
    };
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
    await expect(page.getByTestId('summary-badges')).toContainText('FX UNAVAILABLE');
    const fx = page.locator('section', { has: page.getByRole('heading', { name: 'FX rates used' }) });
    await expect(fx).toContainText('STALE');
    await expect(fx).toContainText('PROVIDER ERROR');
    const loss = page.getByTestId('loss-distribution');
    await expect(loss).toContainText('Unavailable (BASE VAR UNAVAILABLE)');
    await expect(loss.locator('svg')).toHaveCount(0);
    await expect(loss.locator('table')).toHaveCount(0);
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
