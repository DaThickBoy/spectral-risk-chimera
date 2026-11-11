import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PAGES_BASE } from '../../playwright.config.js';

test('the dashboard footer opens the complete third-party notices under the Pages subpath', async ({
  page,
}) => {
  await page.goto(PAGES_BASE);
  const link = page.getByRole('contentinfo').getByRole('link', { name: 'Third-party license notices' });
  await expect(link).toBeVisible();
  await link.focus();
  const path = `${PAGES_BASE}THIRD_PARTY_NOTICES.txt`;
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === path),
    link.press('Enter'),
  ]);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/plain');
  expect(await response.body()).toEqual(
    readFileSync(new URL('../../src/web/public/THIRD_PARTY_NOTICES.txt', import.meta.url)),
  );
});
