import { expect, test } from '@playwright/test';

for (const width of [320, 390, 768, 1440, 1920]) {
  test.describe(`FX provenance at ${width}px`, () => {
    test.use({
      viewport: { width, height: width <= 390 ? 844 : width === 1440 ? 900 : width === 768 ? 1024 : 1080 },
      hasTouch: width === 390,
    });
    test('keeps rates and exact provenance inspectable', async ({ page }) => {
      await page.goto('/spectral-risk-chimera/#/fx');
      const table = page.getByRole('table');
      const mobile = width <= 600;
      await table.getByRole('rowheader', { name: /GBP/ }).scrollIntoViewIfNeeded();
      await expect(table.getByRole('rowheader', { name: /GBP/ })).toBeInViewport();
      await expect(table.getByText('1.198825…')).toBeInViewport();
      for (const currency of ['GBP', 'USD']) {
        const control = table
          .locator('summary')
          .filter({ hasText: mobile ? `for ${currency} to EUR` : `${currency} details` });
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
        if (width === 390) await control.tap();
        else {
          await control.focus();
          await page.keyboard.press('Enter');
          await expect(control).toBeFocused();
        }
        await expect(table.getByTestId(`quote-${currency}`)).toBeVisible();
        const exact = control.locator('..').locator('p .fx-exact').first();
        await expect(exact).toHaveText(/^\d+\.\d{30,}$/);
        if (mobile) {
          const fits = (selector: string) =>
            control
              .locator('..')
              .locator(selector)
              .first()
              .evaluate((element) => {
                const cell = element.closest('td');
                return cell !== null && cell.scrollWidth <= cell.clientWidth;
              });
          expect(await fits('.fx-exact')).toBe(true);
        }
        if (currency === 'USD') await expect(exact).toHaveText('0.8956560680698611733094491715181370353784');
      }
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      const wrap = table.locator('..');
      expect(await wrap.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await expect(table.getByRole('row').last()).toHaveCSS('display', mobile ? 'grid' : 'table-row');
    });
  });
}
