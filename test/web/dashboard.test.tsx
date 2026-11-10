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
import { DashboardViewResponseSchema } from '../../src/shared/apiContracts/index.js';
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

describe('panel times, provenance labels, and DEMO badges (ui-guidelines 3 and 4)', () => {
  const panelText = (container: HTMLElement, id: string): string =>
    text(container.querySelector(`#${id}-title`)?.closest('section') as HTMLElement);

  it('every risk panel header states its parameters and its time', async () => {
    const { container } = await show();
    expect(panelText(container, 'base-var')).toContain(
      '1 day · 95% · Historical Simulation · as of 2026-11-06',
    );
    expect(panelText(container, 'adjusted-var')).toContain('1 day · 95% · as of 2026-11-06');
    expect(panelText(container, 'sentiment')).toContain(
      'Sentiment index, -1 (bearish) to +1 (bullish) · as of 2026-11-06 16:00 UTC',
    );
    expect(panelText(container, 'filing')).toContain(
      'Filing risk score, 0 (low) to 1 (high) · as of \u2014 (not configured)',
    );
  });

  it('a sentiment value without an observation shows "—" and no basis or observation time', async () => {
    const { container } = await show();
    const row = text(container.querySelector('[data-testid="sentiment-DEMO-EU"]') as HTMLElement);
    // textContent includes the badge's decorative (aria-hidden) icon glyph.
    expect(row).toMatch(/^DEMO-EU \u2014 .?UNAVAILABLE$/);
    expect(row).not.toMatch(/observed|observation|index/);
  });

  it('a DEMO latest observation is labelled DEMO, "not an aggregated index", with its observation time', async () => {
    const base = multiCurrencyView();
    const variant = DashboardViewResponseSchema.parse({
      ...base,
      view: {
        ...base.view,
        assets: base.view.assets.map((asset) =>
          asset.ticker === 'DEMO-UK'
            ? {
                ...asset,
                sentiment: {
                  value: '-0.72',
                  status: 'CURRENT',
                  sourceKind: 'DEMO',
                  observedAt: '2026-11-06T15:55:00.000Z',
                  basis: 'LATEST_OBSERVATION',
                },
              }
            : asset,
        ),
      },
    });
    const { container } = await show(variant);
    const row = text(container.querySelector('[data-testid="sentiment-DEMO-UK"]') as HTMLElement);
    expect(row).toContain('DEMO-UK -0.72');
    expect(row).toContain('CURRENT');
    expect(row).toContain('DEMO');
    expect(row).toContain('latest observation, not an aggregated index · observed 2026-11-06 15:55 UTC');
    // The value is displayed only: Adjusted VaR stays unavailable with its reason (H7).
    const adjusted = container.querySelector('#adjusted-var-title')?.closest('section') as HTMLElement;
    expect(adjusted.querySelector('[data-testid="adjusted-var-value"]')?.textContent).toBe('Unavailable');
  });

  it('DEMO data is labelled on the NAV, the overview, and the currency exposure', async () => {
    const { container } = await show();
    // textContent includes the badge's decorative (aria-hidden) icon glyph.
    expect(text(container.querySelector('[data-testid="topbar-nav"]') as HTMLElement)).toMatch(
      /^22375\.74 EUR .?DEMO$/,
    );
    expect(text(container.querySelector('[data-testid="overview-badges"]') as HTMLElement)).toContain('DEMO');
    expect(text(container.querySelector('[data-testid="ccy-badges"]') as HTMLElement)).toContain('DEMO');
  });

  it('positions name the FX rates they were converted at', async () => {
    const { container } = await show();
    const caption = container.querySelector('#positions-title')?.closest('section')?.querySelector('caption');
    expect(caption?.textContent).toMatch(/converted at the rates listed in “FX rates used”/);
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

describe('A2 loss distribution (ui-guidelines 5)', () => {
  const section = (container: HTMLElement): HTMLElement =>
    container.querySelector('[data-testid="loss-distribution"]') as HTMLElement;

  it('sits after the positions and before the FX rates', async () => {
    const { container } = await show();
    const titles = [...container.querySelectorAll('main h2')].map((h) => h.id);
    expect(titles.indexOf('loss-title')).toBe(titles.indexOf('positions-title') + 1);
    expect(titles.indexOf('fx-title')).toBe(titles.indexOf('loss-title') + 1);
  });

  it('states the metric, parameters, calculation time, validity, and DEMO label', async () => {
    const { container } = await show();
    const heading = text(container.querySelector('#loss-title') as HTMLElement);
    expect(heading).toBe(
      'Loss distribution · Base VaR scenarios · 1 day · 95% · Historical Simulation · as of 2026-11-06 16:00 UTC',
    );
    const badges = text(container.querySelector('[data-testid="loss-badges"]') as HTMLElement);
    expect(badges).toMatch(/CURRENT/);
    expect(badges).toMatch(/DEMO/);
  });

  it('chart: accessible name and description, axis labels with units, legend, and the labelled VaR marker', async () => {
    const { container } = await show();
    const svg = container.querySelector('[data-testid="loss-chart"]') as SVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-labelledby')).toBe('loss-chart-title loss-chart-desc');
    expect(svg.querySelector('#loss-chart-title')?.textContent).toBe(
      'Base VaR scenario losses, 4 buckets, EUR',
    );
    expect(svg.querySelector('#loss-chart-desc')?.textContent).toContain(
      'The VaR marker at 95% is 6.55 EUR. Scenarios with a larger loss: 1.',
    );
    const svgText = svg.textContent;
    expect(svgText).toContain('Loss (EUR); negative values are gains');
    expect(svgText).toContain('Scenarios (count)');
    expect(svgText).toContain('-2.00 EUR');
    expect(svgText).toContain('7.00 EUR');
    expect(svgText).toContain('VaR 95% · 6.55 EUR');
    const legend = text(section(container).querySelector('.legend') as HTMLElement);
    expect(legend).toContain('Scenario losses per bucket');
    expect(legend).toContain('VaR 95% (raw quantile)');
  });

  it('bars and tooltips use the exact backend strings; the marker sits at the backend position', async () => {
    const { container } = await show();
    const bars = [...container.querySelectorAll('[data-testid^="loss-bar-"]')];
    expect(bars.map((b) => b.querySelector('title')?.textContent)).toEqual([
      '-2 to 0.25 EUR (upper edge excluded): 3 scenarios',
      '0.25 to 2.5 EUR (upper edge excluded): 2 scenarios',
      '2.5 to 4.75 EUR (upper edge excluded): 2 scenarios',
      '4.75 to 7 EUR (upper edge included): 3 scenarios',
    ]);
    // Plot 56..624 px, 4 slots of 142 px; heights from counts 3/2/2/3 over 180 px.
    expect(bars.map((b) => b.getAttribute('height'))).toEqual(['180', '120', '120', '180']);
    const marker = container.querySelector('[data-testid="loss-var-marker"]') as SVGElement;
    expect(marker.getAttribute('x1')).toBe('595.6'); // 56 + 3.8 * 142
    expect(marker.querySelector('title')?.textContent).toBe('VaR 95%: raw quantile 6.55 EUR');
  });

  it('the table lists every bucket with exact canonical edges, counts, and the marker bucket', async () => {
    const { container } = await show();
    const rows = [...container.querySelectorAll('[data-testid="loss-table"] tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['1', '-2', '0.25', 'excluded', '3', ''],
      ['2', '0.25', '2.5', 'excluded', '2', ''],
      ['3', '2.5', '4.75', 'excluded', '2', ''],
      ['4', '4.75', '7', 'included', '3', 'VaR 95% at 6.55'],
    ]);
    const summary = text(container.querySelector('[data-testid="loss-summary"]') as HTMLElement);
    expect(summary).toContain('10 daily scenarios from returns ending 2026-10-23 to 2026-11-06 (UTC dates)');
    expect(summary).toContain('in 4 buckets of 2.25 EUR (exact 2.25)');
    expect(summary).toContain('marker: 6.55 EUR (raw quantile, unrounded)');
    expect(summary).toContain('Scenarios with a larger loss than the marker: 1.');
  });

  it('unavailable: the reason and explanation only; no chart, no table, no zero bars', async () => {
    const { container } = await show(fxProblemView());
    const s = section(container);
    expect(text(s)).toContain(
      'Unavailable (BASE VAR UNAVAILABLE): Base VaR is unavailable (FX_UNAVAILABLE), so no scenario loss distribution is shown.',
    );
    expect(text(s.querySelector('[data-testid="loss-badges"]') as HTMLElement)).toMatch(/UNAVAILABLE/);
    expect(s.querySelector('svg')).toBeNull();
    expect(s.querySelector('table')).toBeNull();
    expect(text(s)).not.toMatch(/\b0 scenarios|: 0\b/);
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
