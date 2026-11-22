import { expect, test } from '@playwright/test';

const routes = [
  ['overview', 'Overview'],
  ['risk', 'Risk Analytics'],
  ['portfolio', 'Portfolio'],
  ['signals', 'Risk Signals'],
  ['fx', 'FX & Provenance'],
] as const;

test('workspace destinations are bookmarkable pages and preserve the chosen portfolio', async ({ page }) => {
  await page.goto('/spectral-risk-chimera/#/overview');
  const selector = page.getByRole('combobox', { name: 'Portfolio', exact: true });
  await selector.selectOption('demo-eur-only');
  await expect(page.getByTestId('summary-nav')).toContainText('14025.44');
  for (const [route, label] of routes) {
    const destination = page.getByRole('navigation').getByRole('link', { name: label, exact: true });
    await destination.click();
    await expect(page).toHaveURL(new RegExp(`#/${route}$`));
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(selector).toHaveValue('demo-eur-only');
    if (route !== 'overview') await expect(page.getByTestId('summary')).toHaveCount(0);
  }
  await page.goBack();
  await expect(page).toHaveURL(/#\/signals$/);
  await page.goForward();
  await expect(page).toHaveURL(/#\/fx$/);
  await page.reload();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'FX & Provenance' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('Risk Analytics supports pointer and keyboard bucket inspection', async ({ page }) => {
  await page.goto('/spectral-risk-chimera/#/risk');
  const select = page.getByLabel('Inspect bucket');
  await expect(select).toBeVisible();
  await page.getByTestId('loss-hit-0').filter({ visible: true }).click();
  await expect(select).toHaveValue('0');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect(select).toHaveValue('1');
  await expect(page.getByTestId('loss-bucket-value')).toContainText('scenarios');
});

test.describe('touch device (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Menu disclosure opens navigation and a tap navigates without a reload', async ({ page }) => {
    await page.goto('/spectral-risk-chimera/#/overview');
    await expect(page.getByTestId('summary-nav')).toHaveText('22375.74 EUR');
    const navigation = page.getByRole('navigation', { name: 'Dashboard views' });
    await expect(navigation).toBeHidden();
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.tap();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(navigation).toBeVisible();
    await page.evaluate("document.documentElement.dataset.navigationProbe = 'same-document'");
    await navigation.getByRole('link', { name: 'Risk Analytics', exact: true }).tap();
    await expect(page).toHaveURL(/#\/risk$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Risk Analytics' })).toBeVisible();
    // Choosing a destination closes the disclosure again.
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('html')).toHaveAttribute('data-navigation-probe', 'same-document');
  });

  test('a tap commits a bucket, including an empty one, and the exact range is announced', async ({
    page,
  }) => {
    await page.goto('/spectral-risk-chimera/#/risk');
    const select = page.getByLabel('Inspect bucket');
    await expect(select).toBeVisible();
    // Bucket 19 of the recorded fixture is empty; tapping it must still commit.
    await page.getByTestId('loss-hit-18').tap();
    await expect(select).toHaveValue('18');
    await expect(page.getByTestId('loss-bucket-value')).toContainText('Bucket 19 · 0 scenarios');
    await expect(page.locator('.loss-inspector [role="status"]')).toContainText('Bucket 19: 0 scenarios');
    // The non-empty last bucket by tap, with the exact (unrounded) edges in the announcement.
    await page.getByTestId('loss-hit-19').tap();
    await expect(select).toHaveValue('19');
    await expect(page.locator('.loss-inspector [role="status"]')).toContainText('Bucket 20: 31 scenarios');
    await expect(page.locator('.loss-inspector [role="status"]')).toContainText('EUR');
  });

  test('the guided tour runs by tap across views and ends with focus on its start control', async ({
    page,
  }) => {
    await page.goto('/spectral-risk-chimera/#/overview');
    const start = page.getByTestId('tour-start');
    await start.tap();
    const card = page.getByTestId('tour-card');
    const titles = [
      'The portfolio',
      'NAV',
      'Base VaR',
      'Allocation and currency exposure',
      'Loss distribution and the VaR marker',
      'Unavailable and DEMO',
    ];
    for (const [i, title] of titles.entries()) {
      await expect(card).toContainText(`Guided tour · step ${String(i + 1)} of 6`);
      await expect(card.getByRole('heading', { name: title })).toBeFocused();
      await expect(card).toBeInViewport({ ratio: 1 });
      await page.getByTestId('tour-next').tap();
    }
    await expect(card).toHaveCount(0);
    await expect(start).toBeFocused();
    await expect(page).toHaveURL(/#\/signals$/);
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
  });
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`Overview fits the page and shows both primary metrics at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/spectral-risk-chimera/#/overview');
    await expect(page.getByTestId('summary-nav')).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('summary-base-var')).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(
      viewport.width,
    );
  });
}

for (const [width, scale] of [
  [1024, 1],
  [1440, 1],
  [1024, 1.25],
  [1100, 1.25],
] as const) {
  test(
    'collapsed provenance stays contained at ' + String(width) + ' at text scale ' + String(scale),
    async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/spectral-risk-chimera/#/overview');
      await page.addStyleTag({ content: 'html { font-size: ' + String(scale * 100) + '%; }' });
      const summary = page.locator('.workspace-provenance summary');
      await expect(summary).toContainText('Not live');
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      for (const open of [false, true]) {
        if (open) {
          await summary.focus();
          await page.keyboard.press('Enter');
          await expect(summary).toBeFocused();
          await expect(summary).toHaveCSS('outline-style', 'solid');
          await expect(page.locator('.replay-note')).toBeVisible();
        }
        expect(
          await page.evaluate(
            '(() => { const e = document.querySelector(".workspace-provenance"); return e.scrollWidth <= e.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()',
          ),
        ).toBe(true);
      }
    },
  );
}

test('activating the current mobile view returns focus to Menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/spectral-risk-chimera/#/overview');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Overview', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page).toHaveURL(/overview$/);
});
