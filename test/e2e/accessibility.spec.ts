// Browser checks of the BUILT dashboard with the exported deterministic replay (Slice 3;
// ui-guidelines 3, 4, 6, 7). Prerequisite: `npm run build && npm run export:replay`.
// - axe-core (the pinned dev dependency already used by the jsdom tests) runs in Chromium with
//   every default rule, including colour contrast, which jsdom cannot evaluate.
// - A 390 px wide phone viewport has no page-level horizontal overflow and stacks the panels.
// - Keyboard: Tab reaches the skip link, the portfolio selector, and Reload, each with the visible
//   accent focus ring; the skip link moves focus to the main content.
// - prefers-reduced-motion disables the only transition.
// In-page code is passed as string expressions: the Node-side TypeScript program has no DOM
// library, and adding one would expose DOM globals to backend code.
// Full WCAG 2.2 AA conformance still needs manual testing with assistive technology.
// Validates: Requirements 35.1, 35.4
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BASE = '/spectral-risk-chimera/';
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** `--color-accent` (teal #2ec4b6, ui-guidelines §1) as computed by the browser. */
const ACCENT = 'rgb(46, 196, 182)';
const PHONE = { width: 390, height: 844 };

/**
 * Evaluates a browser-side expression and returns its JSON-serializable result. A string passed
 * to Playwright is evaluated as an expression (it is not called with arguments), so every
 * expression here selects its own elements.
 */
const inPage = <T>(page: Page, expression: string): Promise<T> => page.evaluate(expression) as Promise<T>;

interface AxeSummary {
  readonly violations: string[];
  readonly passed: string[];
}

async function runAxe(page: Page): Promise<AxeSummary> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return inPage<AxeSummary>(
    page,
    `axe.run(document).then((r) => ({
      violations: r.violations.map((v) =>
        v.id + ': ' + v.help + ' (' + v.nodes.map((n) => n.target.join(' ')).join(', ') + ')'),
      passed: r.passes.map((p) => p.id),
    }))`,
  );
}

interface Focused {
  readonly tag: string | null;
  readonly id: string | null;
  readonly text: string | null;
  readonly outlineStyle: string | null;
  readonly outlineColor: string | null;
  readonly outlineWidth: string | null;
  readonly visible: boolean;
}

const focused = (page: Page): Promise<Focused> =>
  inPage<Focused>(
    page,
    `(() => {
      const e = document.activeElement;
      const s = e === null ? null : getComputedStyle(e);
      return {
        tag: e === null ? null : e.tagName.toLowerCase(),
        id: e === null ? null : e.id,
        text: e === null ? null : (e.textContent || '').trim(),
        outlineStyle: s === null ? null : s.outlineStyle,
        outlineColor: s === null ? null : s.outlineColor,
        outlineWidth: s === null ? null : s.outlineWidth,
        visible: e !== null && e.getBoundingClientRect().left >= 0,
      };
    })()`,
  );

async function loaded(page: Page, portfolio?: string): Promise<void> {
  await page.goto(portfolio === undefined ? BASE : `${BASE}?portfolio=${portfolio}`);
  await expect(page.getByTestId('base-var-value')).not.toHaveText('');
  await expect(page.locator('.panels h2')).toHaveCount(4);
}

test.describe('accessibility in a real browser (axe-core, all default rules)', () => {
  // The page CSP (`script-src 'self'`) correctly blocks the injected axe script. Only this
  // describe bypasses CSP so the test can inject axe; the production CSP is unchanged, and the
  // other describes in this file run with it enforced.
  test.use({ bypassCSP: true });

  for (const [name, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['390 px phone', PHONE],
  ] as const) {
    for (const portfolio of ['demo-eur-usd-gbp', 'demo-eur-only']) {
      test(`${portfolio} at ${name}: no violations, including colour contrast`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await loaded(page, portfolio);
        const result = await runAxe(page);
        expect(result.violations).toEqual([]);
        // The contrast rule really evaluated the rendered page (not "inapplicable").
        expect(result.passed).toContain('color-contrast');
        expect(result.passed).toContain('page-has-heading-one');
        // Tables overflow (and so the rule applies) only on the narrow viewport.
        if (viewport.width === PHONE.width) expect(result.passed).toContain('scrollable-region-focusable');
      });
    }
  }
});

test.describe('390 px phone viewport', () => {
  test.use({ viewport: PHONE });

  test('no page-level horizontal overflow; the four panels stack in their required order', async ({
    page,
  }) => {
    await loaded(page);
    const overflow = await inPage<{ scrollWidth: number; innerWidth: number }>(
      page,
      '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
    );
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
    // The top bar's items stay inside its own content box. This does not depend on fonts: with
    // narrow fonts an overflowing top-bar item is hidden by the page padding, so the page-level
    // check above only fails where the fonts are wider (for example the Linux CI runner).
    const bar = await inPage<{ contentRight: number; items: { item: string; right: number }[] }>(
      page,
      `(() => {
        const bar = document.querySelector('header.topbar');
        const s = getComputedStyle(bar);
        const contentRight =
          bar.getBoundingClientRect().right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
        const items = Array.from(bar.children).map((c) => ({
          item: c.tagName.toLowerCase() + '.' + c.className,
          right: c.getBoundingClientRect().right,
        }));
        return { contentRight, items };
      })()`,
    );
    for (const item of bar.items) {
      expect(item.right, item.item).toBeLessThanOrEqual(bar.contentRight + 0.5);
    }
    await expect(page.locator('.panels h2')).toHaveText([
      'Base VaR',
      'Sentiment-Adjusted VaR',
      'Market Sentiment',
      'SEC Filing Risk',
    ]);
    const panels = page.locator('.panels > section.panel');
    const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => panels.nth(i).boundingBox()));
    for (const [i, box] of boxes.entries()) {
      expect(box, `panel ${String(i)}`).not.toBeNull();
      // One column: every panel starts at the same x and lies below the previous one.
      expect(box?.x).toBe(boxes[0]?.x);
      if (i > 0) expect(box?.y ?? 0).toBeGreaterThan(boxes[i - 1]?.y ?? 0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width);
    }
    // The key values stay readable and labelled on the phone.
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    await expect(page.getByTestId('summary-nav')).toHaveText('22375.74 EUR');
    await expect(page.getByTestId('summary-badges')).toContainText('DEMO DATA');
  });

  test('wide tables scroll inside their own container, not the page', async ({ page }) => {
    await loaded(page);
    const list = await inPage<{ overflowX: string; right: number }[]>(
      page,
      `Array.from(document.querySelectorAll('.table-wrap')).map((e) => ({
        overflowX: getComputedStyle(e).overflowX,
        right: e.getBoundingClientRect().right,
      }))`,
    );
    expect(list.length).toBeGreaterThan(0);
    for (const wrap of list) {
      expect(wrap.overflowX).toBe('auto');
      expect(wrap.right).toBeLessThanOrEqual(PHONE.width);
    }
    // Each scroll container is a named, focusable region, so keyboard users can scroll it.
    const positions = page.getByRole('region', { name: 'Positions table, scrollable' });
    await positions.focus();
    expect(await focused(page)).toMatchObject({ tag: 'div', outlineStyle: 'solid', outlineColor: ACCENT });
    const scrollLeft = `document.querySelector('.table-wrap[aria-label="Positions table, scrollable"]').scrollLeft`;
    expect(await inPage<number>(page, scrollLeft)).toBe(0);
    await page.keyboard.press('ArrowRight');
    // Keyboard scrolling is applied asynchronously by the browser.
    await expect.poll(async () => inPage<number>(page, scrollLeft)).toBeGreaterThan(0);
  });

  test('A2: the loss chart keeps readable text and scrolls inside its own focusable region', async ({
    page,
  }) => {
    await loaded(page);
    const chart = page.getByRole('region', { name: 'Loss distribution chart, scrollable' });
    await chart.focus();
    expect(await focused(page)).toMatchObject({ tag: 'div', outlineStyle: 'solid', outlineColor: ACCENT });
    const metrics = await inPage<{
      wrapRight: number;
      scrollWidth: number;
      clientWidth: number;
      fontPx: number;
    }>(
      page,
      `(() => {
        const wrap = document.querySelector('.chart-wrap');
        const svg = wrap.querySelector('svg');
        const tick = svg.querySelector('.chart-tick');
        // Rendered text size: the SVG font size times the viewBox scale.
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        return {
          wrapRight: wrap.getBoundingClientRect().right,
          scrollWidth: wrap.scrollWidth,
          clientWidth: wrap.clientWidth,
          fontPx: parseFloat(getComputedStyle(tick).fontSize) * scale,
        };
      })()`,
    );
    expect(metrics.wrapRight).toBeLessThanOrEqual(PHONE.width);
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.fontPx).toBeGreaterThanOrEqual(12);
  });
});

test.describe('keyboard', () => {
  test('Tab reaches the skip link, the portfolio selector, and Reload, each with the accent focus ring', async ({
    page,
  }) => {
    await loaded(page);
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({
      tag: 'a',
      text: 'Skip to risk panels',
      visible: true,
      outlineStyle: 'solid',
      outlineColor: ACCENT,
      outlineWidth: '2px',
    });
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({
      tag: 'select',
      id: 'portfolio-select',
      outlineStyle: 'solid',
      outlineColor: ACCENT,
    });
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({
      tag: 'button',
      text: 'Reload',
      outlineStyle: 'solid',
      outlineColor: ACCENT,
    });
  });

  test('the skip link moves keyboard focus to the main content', async ({ page }) => {
    await loaded(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    expect((await focused(page)).id).toBe('main');
  });

  test('the portfolio can be changed with the keyboard alone', async ({ page }) => {
    await loaded(page);
    await page.locator('#portfolio-select').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(/\?portfolio=demo-eur-only$/);
    await expect(page.getByTestId('base-var-value')).toHaveText('140.18 EUR');
  });
});

test.describe('reduced motion', () => {
  const transition = (page: Page): Promise<string> =>
    inPage<string>(page, `getComputedStyle(document.getElementById('portfolio-select')).transitionDuration`);

  test('without a preference the control has its short transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await loaded(page);
    expect(await transition(page)).toBe('0.15s');
  });

  test('prefers-reduced-motion: reduce disables it, and the values are unchanged', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await loaded(page);
    expect(await transition(page)).toBe('0s');
    await expect(page.getByTestId('base-var-value')).toHaveText('124.10 EUR');
    expect(await inPage<number>(page, 'document.getAnimations().length')).toBe(0);
  });
});
