// Dashboard panels and states (tasks 17.2, 17.3; DR-KW-1 H2, H6 to H8). Tests: AT-DSH-01,
// AT-DSH-03, AT-DSH-09, AT-DSH-10, AT-DSH-12, AT-DSH-13, AT-DSH-14, AT-DSH-15, AT-ALC-11,
// AT-FX-18 (hackathon scope). Accessibility: axe-core rules that jsdom supports (colour contrast is
// checked separately from the design tokens). Layout breakpoints cannot be measured in jsdom; the
// stylesheet's responsive rules are checked as text.
// Validates: Requirements 17.10, 20.7, 30.14, 35.1, 35.4, 35.6, 35.7
import { readFileSync } from 'node:fs';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/web/App.tsx';
import { percentText } from '../../src/web/format.ts';
import { OD1_TEXT, demoIndex, fxProblemView, multiCurrencyView } from './fixtures.js';
import { memorySource, render, settle, text } from './render.js';
import type { Rendered } from './render.js';

const mounted: Rendered[] = [];
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount();
});

async function show(view = multiCurrencyView()): Promise<Rendered> {
  const r = await render(
    <App
      source={memorySource({
        index: () => Promise.resolve({ ok: true, value: demoIndex() }),
        view: () => Promise.resolve({ ok: true, value: view }),
      })}
    />,
  );
  mounted.push(r);
  return r;
}

describe('panels and data mode (AT-DSH-01, AT-DSH-15)', () => {
  it('shows the four risk panels separately and in the required order', async () => {
    const { container } = await show();
    const headings = [...container.querySelectorAll('.panels h2')].map((h) => h.textContent);
    expect(headings).toEqual(['Base VaR', 'Sentiment-Adjusted VaR', 'Market Sentiment', 'SEC Filing Risk']);
  });

  it('Base VaR: backend display text with its unit, parameters, DEMO label, and percentile wording', async () => {
    const { container } = await show();
    expect(container.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('124.10 EUR');
    const panel = text(container.querySelector('#base-var-title')?.closest('section') as HTMLElement);
    expect(panel).toMatch(/1 day · 95% · Historical Simulation · as of 2026-11-06/);
    expect(panel).toMatch(/DEMO/);
    expect(panel).toMatch(/percentile-based one-day loss estimate/);
    expect(panel).toMatch(/not the maximum drawdown/);
    expect(panel).toMatch(/0\.5545977964722801352876283961402434634723 %/); // exact, not re-rounded
  });

  it('Adjusted VaR: "Unavailable" with the OD-1 reason, never the Base figure (H7)', async () => {
    const { container } = await show();
    const panel = container.querySelector('#adjusted-var-title')?.closest('section') as HTMLElement;
    expect(panel.querySelector('[data-testid="adjusted-var-value"]')?.textContent).toBe('Unavailable');
    expect(text(panel)).toContain(OD1_TEXT);
    expect(text(panel)).toContain('AGGREGATION NOT APPROVED · OD-1');
    expect(text(panel)).not.toMatch(/124/);
    expect(text(panel)).not.toMatch(/\b0(\.00)? EUR/);
  });

  it('SEC filing risk is NOT CONFIGURED with no score; scale captions are separate (AT-DSH-12)', async () => {
    const { container } = await show();
    const filing = text(container.querySelector('#filing-title')?.closest('section') as HTMLElement);
    expect(filing).toContain('NOT CONFIGURED');
    expect(filing).toContain('0 (low) to 1 (high)');
    const sentiment = text(container.querySelector('#sentiment-title')?.closest('section') as HTMLElement);
    expect(sentiment).toContain('-1 (bearish) to +1 (bullish)');
  });

  it('the top bar shows data mode, run mode, NAV, as-of, calculation time, and freshness', async () => {
    const { container } = await show();
    const bar = text(container.querySelector('.topbar') as HTMLElement);
    expect(bar).toContain('DEMO DATA');
    expect(bar).toContain('DEMO FIXTURES');
    expect(bar).toContain('22375.74 EUR');
    expect(bar).toContain('2026-11-06');
    expect(bar).toContain('2026-11-06 16:00 UTC');
    expect(bar).toContain('CURRENT');
    expect(text(container)).toContain('DEMO DATA: prices and history are deterministic fixtures');
  });
});

describe('FX attribution and exposure (AT-FX-18, AT-ALC-11, AT-DSH-13)', () => {
  it('ECB rates are labelled derived inverses with the statement and both notes; exact rates are shown', async () => {
    const { container } = await show();
    expect(container.querySelector('[data-testid="derived-USD"]')?.textContent).toBe(
      'Derived: 1 / published EUR→USD (40 significant digits, ROUND HALF UP)',
    );
    const notes = text(container.querySelector('[data-testid="fx-attribution"]') as HTMLElement);
    expect(notes).toContain('Source: ECB statistics.');
    expect(notes).toContain('not identical to the published reference rate');
    expect(notes).toContain('information purposes only');
    expect(text(container)).toContain('0.8956560680698611733094491715181370353784');
    expect(text(container)).toContain('ECB-PUB-1600-FRANKFURT-v1');
    expect(text(container)).toContain('Identity (base currency)');
  });

  it('OD-20: the published ECB observation is shown separately from the derived rate', async () => {
    const { container } = await show();
    const usd = container.querySelector('[data-testid="quote-USD"]')?.textContent ?? '';
    expect(usd).toContain('EUR→USD 1.1165');
    expect(usd).toContain('Published observation · reference date 2026-11-06');
    expect(usd).not.toContain('0.8956');
    expect(container.querySelector('[data-testid="quote-EUR"]')?.textContent).toBe('\u2014');
  });

  it('allocation is padded to two decimals, never re-rounded; money uses the backend display text', async () => {
    const { container } = await show();
    const positions = text(container.querySelector('#positions-title')?.closest('section') as HTMLElement);
    expect(positions).toContain('40.20%');
    expect(positions).toContain('29.74%');
    expect(positions).toContain('6655.13 EUR');
    expect(positions).not.toContain('6655.133968');
    const ccy = text(container.querySelector('#ccy-title')?.closest('section') as HTMLElement);
    expect(ccy).toContain('5726.32 EUR');
  });

  it('percentText pads only', () => {
    expect(percentText('33.3')).toBe('33.30%');
    expect(percentText('100')).toBe('100.00%');
    expect(percentText('12.345')).toBe('12.345%');
    expect(percentText(null)).toBe('\u2014');
  });
});

describe('stale and unavailable data (AT-DSH-09, AT-DSH-10)', () => {
  it('stale and unavailable FX show their badges; missing values are "—", never zero', async () => {
    const { container } = await show(fxProblemView());
    const fx = text(container.querySelector('#fx-title')?.closest('section') as HTMLElement);
    expect(fx).toContain('STALE');
    expect(fx).toContain('UNAVAILABLE');
    expect(fx).toContain('PROVIDER ERROR');
    expect(container.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('\u2014');
    const overview = text(container.querySelector('#overview-title')?.closest('section') as HTMLElement);
    expect(overview).toContain('NAV\u2014');
    expect(overview).toContain('EXPOSURE UNAVAILABLE');
    expect(overview).not.toMatch(/NAV0/);
    expect(text(container.querySelector('.topbar') as HTMLElement)).toContain('FX UNAVAILABLE');
    expect(text(container.querySelector('#base-var-title')?.closest('section') as HTMLElement)).toContain(
      'Unavailable: FX UNAVAILABLE',
    );
  });
});

describe('loading and error states', () => {
  it('shows a static loading state, then the data', async () => {
    let resolveView: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      resolveView = resolve;
    });
    const r = await render(
      <App
        source={memorySource({
          index: () => Promise.resolve({ ok: true, value: demoIndex() }),
          view: () => pending as never,
        })}
      />,
    );
    mounted.push(r);
    expect(r.container.querySelector('[role="status"]')?.textContent).toBe('Loading portfolio data…');
    expect(r.container.querySelector('main')?.getAttribute('aria-busy')).toBe('true');
    resolveView({ ok: true, value: multiCurrencyView() });
    await settle();
    expect(r.container.querySelector('[role="status"]')).toBeNull();
    expect(r.container.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('124.10 EUR');
  });

  it('an unreachable source shows an alert, and "Try again" reloads', async () => {
    let attempt = 0;
    const source = memorySource({
      index: () => {
        attempt += 1;
        return Promise.resolve(
          attempt === 1 ? { ok: false, error: 'NETWORK' } : { ok: true, value: demoIndex() },
        );
      },
      view: () => Promise.resolve({ ok: true, value: multiCurrencyView() }),
    });
    const r = await render(<App source={source} />);
    mounted.push(r);
    expect(r.container.querySelector('[role="alert"]')?.textContent).toContain('could not be reached');
    const retry = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    retry?.click();
    await settle();
    expect(source.calls.filter((c) => c === 'index')).toHaveLength(2);
    expect(r.container.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('124.10 EUR');
  });

  it('a view that fails validation is not shown', async () => {
    const r = await render(
      <App
        source={memorySource({
          index: () => Promise.resolve({ ok: true, value: demoIndex() }),
          view: () => Promise.resolve({ ok: false, error: 'INVALID_RESPONSE' }),
        })}
      />,
    );
    mounted.push(r);
    expect(r.container.querySelector('[role="alert"]')?.textContent).toContain(
      'did not match the dashboard contract',
    );
    expect(r.container.querySelector('.panels')).toBeNull();
  });

  it('selecting another portfolio loads its view', async () => {
    const source = memorySource({
      index: () => Promise.resolve({ ok: true, value: demoIndex() }),
      view: () => Promise.resolve({ ok: true, value: multiCurrencyView() }),
    });
    const r = await render(<App source={source} />);
    mounted.push(r);
    const select = r.container.querySelector('#portfolio-select') as HTMLSelectElement;
    select.value = 'demo-eur-only';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(source.calls).toContain('view:demo-eur-only');
  });
});

const css = readFileSync('src/web/styles.css', 'utf8');

describe('accessibility and layout', () => {
  it.each([
    ['current data', multiCurrencyView],
    ['FX problems', fxProblemView],
  ])('axe-core finds no violations (%s)', async (_name, build) => {
    const { container } = await show(build());
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('design-token text colours meet WCAG 2.2 AA contrast on every surface (4.5:1)', () => {
    const token = (name: string): string => {
      const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
      if (match?.[1] === undefined) throw new Error(`missing token ${name}`);
      return match[1];
    };
    // WCAG relative luminance; colour arithmetic only (not financial values).
    const luminance = (hex: string): number => {
      const channel = (i: number): number => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const surface of ['color-bg', 'color-panel', 'color-raised']) {
      for (const fg of [
        'color-text',
        'color-text-secondary',
        'color-warning',
        'color-accent',
        'color-critical',
      ]) {
        expect(contrast(token(fg), token(surface)), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the stylesheet collapses panels to two and one column, and honours reduced motion', () => {
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.panels[\s\S]*?repeat\(2/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).not.toMatch(/@keyframes|animation:/);
  });

  it('every table has a caption and column headers', async () => {
    const { container } = await show();
    for (const table of container.querySelectorAll('table')) {
      expect(table.querySelector('caption')?.textContent?.length).toBeGreaterThan(0);
      expect(table.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
    }
  });
});
