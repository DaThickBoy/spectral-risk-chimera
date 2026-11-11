// Guided judge tour (ui-guidelines §8): user-started and non-modal; each step is an inline card
// directly above its section; Back, Next/Finish, End tour, and Escape; focus moves to each step
// and returns to the start control; text quotes backend display strings only and never
// describes the replay as live. Axe-core runs with the tour open (colour contrast is checked
// from the design tokens in dashboard.test.tsx).
// Validates: Requirements 17.10, 35.1, 35.4, 35.6
import axe from 'axe-core';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/web/App.tsx';
import { tourSteps } from '../../src/web/tour.ts';
import type { DashboardViewResponse } from '../../src/shared/apiContracts/index.js';
import { demoIndex, fxProblemView, multiCurrencyView } from './fixtures.js';
import { memorySource, render } from './render.js';
import type { Rendered } from './render.js';

const RECORDED = '2026-11-06T16:00:00.000Z';
const mounted: Rendered[] = [];
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount();
});

async function show(view: DashboardViewResponse = multiCurrencyView(), kind: 'LIVE' | 'REPLAY' = 'REPLAY') {
  const r = await render(
    <App
      source={memorySource({
        kind,
        info: kind === 'REPLAY' ? { kind, recordedAt: RECORDED } : { kind },
        index: () => Promise.resolve({ ok: true, value: demoIndex() }),
        view: () => Promise.resolve({ ok: true, value: view }),
      })}
    />,
  );
  mounted.push(r);
  return r;
}

const el = (c: HTMLElement, id: string): HTMLElement => {
  const found = c.querySelector(`[data-testid="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`${id} missing`);
  return found;
};
const click = async (target: HTMLElement): Promise<void> => {
  await act(async () => {
    target.click();
  });
};
const card = (c: HTMLElement): HTMLElement | null => c.querySelector('[data-testid="tour-card"]');

describe('guided tour behaviour', () => {
  it('never starts by itself; the start control is a toggle button', async () => {
    const { container } = await show();
    const start = el(container, 'tour-start');
    expect(start.textContent).toBe('Guided tour');
    expect(start.getAttribute('aria-pressed')).toBe('false');
    expect(card(container)).toBeNull();
  });

  it('walks six steps, each inline directly above its section, with focus on the step heading', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    expect(el(container, 'tour-start').getAttribute('aria-pressed')).toBe('true');
    // The section each step sits directly above, in order.
    // Fintech layout: steps 1-3 above the KPI cards, 4-5 above the visualisation grid, 6 above
    // the risk-signal cards (every step moves down the page).
    const expected = ['summary', 'summary', 'summary', 'charts', 'charts', 'panels'];
    const titles: string[] = [];
    for (const [i, anchor] of expected.entries()) {
      const c = card(container) as HTMLElement;
      expect(c.querySelector('.tour-progress')?.textContent).toBe(`Guided tour · step ${String(i + 1)} of 6`);
      const heading = c.querySelector('h2') as HTMLElement;
      // The step position is part of the heading (where focus lands), visually hidden.
      const hidden = heading.querySelector('.visually-hidden')?.textContent ?? '';
      expect(hidden).toBe(`Guided tour, step ${String(i + 1)} of 6: `);
      titles.push((heading.textContent ?? '').slice(hidden.length));
      expect(document.activeElement).toBe(heading);
      const next = c.nextElementSibling as HTMLElement;
      const target =
        anchor === 'summary'
          ? next.getAttribute('data-testid') === 'summary'
          : anchor === 'panels'
            ? next.classList.contains('panels')
            : next.getAttribute('data-testid') === 'viz-grid';
      expect(target, `step ${String(i + 1)} sits above ${anchor}`).toBe(true);
      expect(container.querySelectorAll('[data-testid="tour-card"]')).toHaveLength(1);
      if (i < expected.length - 1) await click(el(container, 'tour-next'));
    }
    expect(titles).toEqual([
      'The portfolio',
      'NAV',
      'Base VaR',
      'Allocation and currency exposure',
      'Loss distribution and the VaR marker',
      'Unavailable and DEMO',
    ]);
    expect(el(container, 'tour-next').textContent).toBe('Finish');
    await click(el(container, 'tour-next'));
    expect(card(container)).toBeNull();
    expect(document.activeElement).toBe(el(container, 'tour-start'));
    expect(el(container, 'tour-start').getAttribute('aria-pressed')).toBe('false');
  });

  it('Back is disabled on the first step and returns to the previous step', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    const back = () =>
      [...(card(container) as HTMLElement).querySelectorAll('button')][0] as HTMLButtonElement;
    expect(back().textContent).toBe('Back');
    expect(back().disabled).toBe(true);
    await click(el(container, 'tour-next'));
    expect(card(container)?.querySelector('h2')?.textContent).toBe('Guided tour, step 2 of 6: NAV');
    await click(back());
    expect(card(container)?.querySelector('h2')?.textContent).toBe('Guided tour, step 1 of 6: The portfolio');
    expect(document.activeElement).toBe(card(container)?.querySelector('h2'));
  });

  it('Escape and End tour both end it and return focus to the start control', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    await act(async () => {
      (card(container) as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(card(container)).toBeNull();
    expect(document.activeElement).toBe(el(container, 'tour-start'));
    await click(el(container, 'tour-start'));
    await click(el(container, 'tour-end'));
    expect(card(container)).toBeNull();
    expect(document.activeElement).toBe(el(container, 'tour-start'));
  });

  it('opening the tour leaves every figure unchanged and visible', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    expect(el(container, 'summary-nav').textContent).toBe('22375.74 EUR');
    expect(el(container, 'base-var-value').textContent).toBe('124.10 EUR');
    expect(el(container, 'adjusted-var-value').textContent).toBe('Unavailable');
  });

  it('axe-core finds no violations with the tour open (step 3 shares its topic with the Base VaR panel)', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    await click(el(container, 'tour-next'));
    await click(el(container, 'tour-next'));
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('accessibility review regression: the region is named by the heading, uniquely, and progress is not read twice', async () => {
    const { container } = await show();
    await click(el(container, 'tour-start'));
    for (let i = 0; i < 6; i += 1) {
      const c = card(container) as HTMLElement;
      const heading = c.querySelector('h2') as HTMLElement;
      // The region's name is the heading text, which includes the step position.
      expect(c.getAttribute('aria-labelledby')).toBe(heading.id);
      const name = heading.textContent ?? '';
      expect(name.startsWith(`Guided tour, step ${String(i + 1)} of 6: `)).toBe(true);
      // No other labelled section or heading on the page has the same name.
      const names = [...container.querySelectorAll('h1, h2')].map((h) => h.textContent);
      expect(names.filter((n) => n === name)).toHaveLength(1);
      expect(c.querySelector('.tour-progress')?.getAttribute('aria-hidden')).toBe('true');
      if (i < 5) await click(el(container, 'tour-next'));
    }
  });
});

describe('guided tour content (backend text only, honest provenance)', () => {
  const replay = { kind: 'REPLAY' as const, recordedAt: RECORDED };
  const all = (view: DashboardViewResponse, source = replay as Parameters<typeof tourSteps>[1]) =>
    tourSteps(view, source)
      .flatMap((s) => s.body)
      .join('\n');

  it('quotes the exact backend display values and parameters', () => {
    const view = multiCurrencyView();
    const text = all(view);
    expect(text).toContain(`portfolio ${view.portfolioId} (base currency EUR)`);
    expect(text).toContain('NAV is 22375.74 EUR: net exposure plus cash, in EUR.');
    expect(text).toContain('Base VaR is 124.10 EUR at 95% confidence over 1 trading day.');
    expect(text).toContain('The dashed orange marker is the raw 95% quantile');
    expect(text).toContain('not the worst possible loss and not a maximum drawdown');
  });

  it('describes the replay as a recorded DEMO replay, never as live', () => {
    const text = all(multiCurrencyView());
    expect(text).toContain('in a recorded DEMO replay');
    expect(text).toContain('recorded 2026-11-06 16:00 UTC');
    expect(text).toContain('It is not live data, and nothing is recalculated in your browser.');
    expect(text).not.toMatch(/\blive (service|production|feed|market)/i);
  });

  it('LIVE source: no replay wording; DEMO data mode still stated', () => {
    const text = all(multiCurrencyView(), { kind: 'LIVE' });
    expect(text).not.toMatch(/replay|recorded/);
    expect(text).toContain('from the local backend');
    expect(text).toContain('Its data mode is DEMO: fixture data, not market data.');
  });

  it('explains OD-1, the filing state, DEMO, and that "—" is not zero', () => {
    const text = all(multiCurrencyView());
    expect(text).toContain(
      'Sentiment-Adjusted VaR is unavailable: no sentiment aggregation method is approved yet (open decision OD-1).',
    );
    expect(text).toContain('DEMO sentiment is shown for information and never used in a calculation.');
    expect(text).toContain('SEC filing risk is not configured in this demonstration');
    expect(text).toContain('"—" means no valid value exists; it is never zero.');
  });

  it('unavailable figures are explained, never replaced by a number', () => {
    const view = fxProblemView();
    const steps = tourSteps(view, replay);
    const baseVar = steps[2]?.body.join(' ') ?? '';
    expect(baseVar).toMatch(/^Base VaR is unavailable: FX UNAVAILABLE\./);
    expect(baseVar).not.toMatch(/\d+\.\d+ EUR/);
  });
});
