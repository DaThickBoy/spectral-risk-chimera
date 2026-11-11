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
    // S1: NAV, as-of, calculation time, and freshness moved to the headline summary.
    expect(bar).not.toContain('22375.74 EUR');
    const summary = text(container.querySelector('[data-testid="summary"]') as HTMLElement);
    expect(summary).toContain('market data as of 2026-11-06 · calculated 2026-11-06 16:00 UTC');
    expect(summary).toContain('CURRENT');
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

  it('DEMO data is labelled on the headline summary and the currency exposure', async () => {
    const { container } = await show();
    expect(text(container.querySelector('[data-testid="summary-badges"]') as HTMLElement)).toContain(
      'DEMO DATA',
    );
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

  it('S1 summary: NAV and Base VaR (1 day, 95%) first, then exposure and cash, as backend text', async () => {
    const { container } = await show();
    const value = (id: string) => container.querySelector(`[data-testid="summary-${id}"]`)?.textContent;
    expect(value('nav')).toBe('22375.74 EUR');
    expect(value('base-var')).toBe('124.10 EUR');
    expect(value('gross')).toBe('21375.74 EUR');
    expect(value('net')).toBe('21375.74 EUR');
    expect(value('long')).toBe('21375.74 EUR');
    expect(value('short')).toBe('0.00 EUR'); // a genuine zero from the backend, not a placeholder
    expect(value('cash')).toBe('1000.00 EUR');
    const summary = container.querySelector('[data-testid="summary"]') as HTMLElement;
    expect(text(summary)).toContain('Base VaR · 1 day · 95%');
    expect(text(summary)).toContain('CURRENT');
    expect(text(summary)).not.toMatch(/%\s*of NAV|% NAV/); // no VaR share of NAV in the headline
    // The summary comes directly after the top bar, before the risk panels.
    const main = container.querySelector('main') as HTMLElement;
    expect(main.querySelector('section')?.getAttribute('data-testid')).toBe('summary');
  });

  it('S1 summary: unavailable figures are "—" with their badges; cash stays the backend value', async () => {
    const { container } = await show(fxProblemView());
    const value = (id: string) => container.querySelector(`[data-testid="summary-${id}"]`)?.textContent;
    for (const id of ['nav', 'base-var', 'gross', 'net', 'long', 'short'])
      expect(value(id), id).toBe('\u2014');
    expect(value('cash')).toBe('1000.00 EUR');
    const badges = text(container.querySelector('[data-testid="summary-badges"]') as HTMLElement);
    expect(badges).toContain('FX UNAVAILABLE');
    expect(badges).toContain('EXPOSURE UNAVAILABLE');
    expect(text(container.querySelector('[data-testid="summary"]') as HTMLElement)).toContain('UNAVAILABLE');
  });

  it('S1 summary: stale inputs and a stale Base VaR are labelled STALE, with the value kept', async () => {
    const base = multiCurrencyView();
    const stale = DashboardViewResponseSchema.parse({
      ...base,
      view: { ...base.view, baseVaR: { ...base.view.baseVaR, validity: 'STALE' } },
      freshness: { ...base.freshness, summary: 'STALE_INPUTS' },
    });
    const { container } = await show(stale);
    const summary = text(container.querySelector('[data-testid="summary"]') as HTMLElement);
    expect(summary).toContain('STALE INPUTS');
    // The badge's decorative (aria-hidden) icon glyph sits between the label and its text.
    expect(summary).toMatch(/Base VaR · 1 day · 95%\s?.?STALE/);
    expect(container.querySelector('[data-testid="summary-base-var"]')?.textContent).toBe('124.10 EUR');
  });

  describe('S2 allocation chart', () => {
    const row = (container: HTMLElement, ticker: string) =>
      container.querySelector(`[data-testid="allocation-${ticker}"]`) as HTMLElement;
    const width = (container: HTMLElement, ticker: string) =>
      (row(container, ticker).querySelector('.allocation-bar') as HTMLElement | null)?.style.width;

    it('every position plotted: one composition bar plus a legend with the exact backend percentages', async () => {
      const { container } = await show();
      const chart = container.querySelector('[data-testid="allocation-chart"]') as HTMLElement;
      expect(text(chart)).toContain('Allocation by position');
      expect(text(chart)).toContain('DEMO');
      // Legend rows: position number, ticker, and the exact backend percentage as text.
      expect(text(row(container, 'DEMO-EU'))).toBe('1DEMO-EU40.20%');
      expect(text(row(container, 'DEMO-UK'))).toBe('2DEMO-UK29.74%');
      // Segments use the same adapter widths, in backend order; the bar is decorative, and each
      // segment carries its legend number so shade is never the only cue.
      // Fintech redesign: the ring's arcs use the same adapter widths, in backend order; the
      // ring is decorative and each arc carries its legend number.
      const composition = container.querySelector('[data-testid="allocation-composition"]') as Element;
      expect(composition.getAttribute('aria-hidden')).toBe('true');
      const segments = [...composition.querySelectorAll('.donut-arc')].map((s) => [
        s.getAttribute('data-testid'),
        s.getAttribute('data-pct'),
      ]);
      expect(segments).toEqual([
        ['allocation-segment-DEMO-EU', '40.2'],
        ['allocation-segment-DEMO-UK', '29.74'],
        ['allocation-segment-DEMO-US', '25.59'],
      ]);
      expect([...composition.querySelectorAll('.donut-label')].map((s) => s.textContent)).toEqual([
        '1',
        '2',
        '3',
      ]);
      expect(composition.querySelector('.donut-center')?.textContent).toBe('3'); // count of rows
      // Each legend swatch matches its segment's shade class and number.
      expect(row(container, 'DEMO-EU').querySelector('.swatch')?.className).toBe('swatch seq-1');
      expect(row(container, 'DEMO-EU').querySelector('.swatch')?.textContent).toBe('1');
      expect(chart.querySelector('.composition-legend')?.getAttribute('aria-label')).toBe(
        'Allocation by position',
      );
      expect(chart.querySelector('.allocation-bars')).toBeNull(); // no repeated per-position bars
      // The unfilled remainder is explained in words, with no browser-computed figure.
      const note = text(chart.querySelector('[data-testid="allocation-remainder-note"]') as HTMLElement);
      expect(note).toBe('Unfilled: not a listed position, for example cash (see Cash in the summary)');
      expect(note).not.toMatch(/\d+\.\d+\s*%/);
      // The positions table states the same values.
      const table = text(
        container
          .querySelector('#positions-title')
          ?.closest('section')
          ?.querySelector('table') as HTMLElement,
      );
      for (const pct of ['40.20%', '29.74%', '25.59%']) expect(table).toContain(pct);
    });

    it('a zero allocation is a real 0.00% with a zero-length bar; a missing one has no bar and its status', async () => {
      const base = multiCurrencyView();
      const [eu, uk, us] = base.view.assets;
      if (eu === undefined || uk === undefined || us === undefined) throw new Error('fixture');
      const mixed = DashboardViewResponseSchema.parse({
        ...base,
        view: {
          ...base.view,
          assets: [
            { ...eu, allocationPct: '0' },
            { ...uk, allocationPct: null, valuationStatus: 'FX_STALE' },
            us,
          ],
        },
      });
      const { container } = await show(mixed);
      expect(text(row(container, 'DEMO-EU'))).toBe('DEMO-EU0.00%');
      expect(width(container, 'DEMO-EU')).toBe('0%');
      expect(text(row(container, 'DEMO-UK'))).toMatch(/^DEMO-UK\u2014 .?FX STALE$/);
      expect(width(container, 'DEMO-UK')).toBeUndefined(); // never drawn as zero
      expect(width(container, 'DEMO-US')).toBe('25.59%');
    });

    it('with no allocation at all, nothing is plotted and the reason is stated', async () => {
      const { container } = await show(fxProblemView());
      expect(container.querySelector('[data-testid="allocation-unavailable"]')?.textContent).toContain(
        'No allocation is available for this portfolio',
      );
      expect(container.querySelector('.allocation-bar')).toBeNull();
    });
  });

  describe('S3 currency exposure chart', () => {
    const row = (container: HTMLElement, ccy: string) =>
      container.querySelector(`[data-testid="exposure-${ccy}"]`) as HTMLElement;
    const bar = (container: HTMLElement, ccy: string) =>
      row(container, ccy).querySelector('.allocation-bar') as HTMLElement | null;

    it('one bar per currency in backend order, labelled with the backend display text in EUR', async () => {
      const { container } = await show();
      const chart = container.querySelector('[data-testid="exposure-chart"]') as HTMLElement;
      expect(text(chart)).toContain('Exposure by currency, in EUR');
      expect(text(chart)).toContain('axis 0 to gross exposure (21375.74 EUR)');
      expect(text(chart)).toContain('DEMO');
      const order = [...chart.querySelectorAll('[data-testid^="exposure-"]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((id) => id !== 'exposure-chart');
      expect(order).toEqual(['exposure-EUR', 'exposure-GBP', 'exposure-USD']); // as sent by the backend
      expect(text(row(container, 'EUR'))).toBe('EUR8994.29 EUR');
      expect(text(row(container, 'GBP'))).toBe('GBP6655.13 EUR');
      // Bar length is the value over the backend's gross exposure (geometry only).
      expect(Number.parseFloat(bar(container, 'EUR')?.style.width ?? '')).toBeCloseTo(42.08, 1);
      expect(bar(container, 'EUR')?.classList.contains('bar-negative')).toBe(false);
    });

    it('zero is a real 0.00 EUR with a zero-length bar; a negative value is an outlined bar with its sign', async () => {
      const base = multiCurrencyView();
      const variant = DashboardViewResponseSchema.parse({
        ...base,
        currencyExposure: [
          { ...base.currencyExposure[0], marketValueBase: '0' },
          { ...base.currencyExposure[1], marketValueBase: '-500' },
          base.currencyExposure[2],
        ],
        display: {
          ...base.display,
          currencyExposure: [
            { currency: 'EUR', marketValueBase: '0.00' },
            { currency: 'GBP', marketValueBase: '-500.00' },
            { currency: 'USD', marketValueBase: '5726.32' },
          ],
        },
      });
      const { container } = await show(variant);
      expect(text(row(container, 'EUR'))).toBe('EUR0.00 EUR');
      expect(bar(container, 'EUR')?.style.width).toBe('0%');
      expect(text(row(container, 'GBP'))).toBe('GBP-500.00 EUR');
      expect(bar(container, 'GBP')?.classList.contains('bar-negative')).toBe(true);
      expect(Number.parseFloat(bar(container, 'GBP')?.style.width ?? '')).toBeGreaterThan(0);
    });

    it('unavailable values have no bar and keep their status; without gross exposure nothing is plotted', async () => {
      const { container } = await show(fxProblemView());
      expect(text(row(container, 'GBP'))).toMatch(/^GBP\u2014 .?UNAVAILABLE$/);
      expect(text(row(container, 'USD'))).toMatch(/^USD\u2014 .?UNAVAILABLE$/);
      expect(text(row(container, 'EUR'))).toBe('EUR8994.29 EUR'); // the value stays visible
      expect(container.querySelector('[data-testid="exposure-chart"] .allocation-bar')).toBeNull();
      expect(container.querySelector('[data-testid="exposure-no-axis"]')?.textContent).toContain(
        'Gross exposure is unavailable',
      );
    });
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
    const summary = text(container.querySelector('[data-testid="summary"]') as HTMLElement);
    // S4: the NAV help trigger ("?") sits between the label and the value.
    expect(summary).toMatch(/NAV\??\u2014/);
    expect(summary).toContain('EXPOSURE UNAVAILABLE');
    expect(summary).toContain('FX UNAVAILABLE');
    expect(summary).not.toMatch(/NAV\??0/);
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

  it('fintech order: the main visual beside allocation, before the risk signals and the tables', async () => {
    const { container } = await show();
    const titles = [...container.querySelectorAll('main h2')].map((h) => h.id);
    const grid = container.querySelector('[data-testid="viz-grid"]') as HTMLElement;
    expect([...grid.querySelectorAll('h2')].map((h) => h.id)).toEqual(['loss-title', 'allocation-heading']);
    expect(titles.indexOf('allocation-heading')).toBe(titles.indexOf('loss-title') + 1);
    expect(titles.indexOf('base-var-title')).toBeGreaterThan(titles.indexOf('allocation-heading'));
    expect(titles.indexOf('positions-title')).toBeGreaterThan(titles.indexOf('filing-title'));
    // The loss distribution is the one navy chart surface.
    expect(section(container).classList.contains('theme-dark')).toBe(true);
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
    // Plot 56..624 px, 4 slots of 142 px; heights from counts 3/2/2/3 over 240 px (frame 320 tall).
    expect(bars.map((b) => b.getAttribute('height'))).toEqual(['240', '160', '160', '240']);
    // Tail emphasis by the backend's integer bucket index: the marker's bucket (index 3) and beyond.
    expect(bars.map((b) => b.getAttribute('class'))).toEqual([
      'chart-bar',
      'chart-bar',
      'chart-bar',
      'chart-bar chart-bar-tail',
    ]);
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
    expect(summary).toContain('in 4 buckets of 2.25 EUR.');
    expect(summary).toContain('VaR 95% marker at 6.55 EUR.'); // backend display text
    expect(summary).toContain('Scenarios with a larger loss than the marker: 1.');
    // The exact, unrounded values sit in the disclosure, in a focusable scroll region.
    const exact = container.querySelector('[data-testid="loss-exact"]') as HTMLElement;
    expect(exact.closest('details')?.getAttribute('data-testid')).toBe('loss-table-details');
    expect(exact.getAttribute('role')).toBe('region');
    expect(exact.getAttribute('tabindex')).toBe('0');
    expect(text(exact)).toBe(
      'VaR 95% marker: raw quantile (exact, unrounded)6.55 EURBucket width (exact)2.25 EUR',
    );
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
    for (const surface of [
      'color-bg',
      'color-panel',
      'color-panel-navy',
      'color-raised',
      'color-row-hover',
    ]) {
      for (const fg of [
        'color-text',
        'color-text-secondary',
        'color-warning',
        'color-accent',
        'color-info',
        'color-critical',
      ]) {
        expect(contrast(token(fg), token(surface)), `${fg} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // Non-text graphic (WCAG 1.4.11, 3:1): red is used only as the error-state border.
      expect(
        contrast(token('color-negative'), token(surface)),
        `color-negative on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
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

describe('S5 final polish', () => {
  const panelEl = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="panel-${id}"]`) as HTMLElement;

  it('Adjusted VaR: concise visible status with OD-1; engine status and full reason in a closed native disclosure', async () => {
    const { container } = await show();
    const panel = panelEl(container, 'adjusted-var');
    const visible = panel.querySelector('.badges') as HTMLElement;
    expect(text(visible)).toContain('UNAVAILABLE');
    expect(text(visible)).toContain('AGGREGATION NOT APPROVED · OD-1');
    const details = panel.querySelector('[data-testid="adjusted-var-details"]');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Why it is unavailable');
    expect(details?.querySelector('[data-testid="adjusted-var-reason"]')?.textContent).toContain(OD1_TEXT);
    expect(text(details as HTMLElement)).toContain('ADJUSTMENT CONFIG MISSING'); // the engine status
    expect(panel.className).toContain('panel-compact');
  });

  it('SEC filing: one compact status row with "—" and NOT CONFIGURED; no score and no controls', async () => {
    const { container } = await show();
    const panel = panelEl(container, 'filing');
    const status = panel.querySelector('[data-testid="filing-status"]') as HTMLElement;
    expect(status.querySelector('.metric')?.textContent).toBe('\u2014');
    expect(text(status)).toContain('NOT CONFIGURED');
    expect(panel.querySelectorAll('button, input, select, a, details')).toHaveLength(0);
    expect(text(panel)).not.toMatch(/\b0(\.\d+)?\b(?! \(low\))/);
    expect(panel.className).toContain('panel-compact');
  });

  it('Base VaR is the one primary panel; the four panels stay separate and in order', async () => {
    const { container } = await show();
    expect(
      [...container.querySelectorAll('.panel-primary')].map((p) => p.getAttribute('data-testid')),
    ).toEqual(['panel-base-var']);
    expect(container.querySelectorAll('.panels > section.panel')).toHaveLength(4);
  });

  it('sections follow positions, loss distribution, currency exposure, then FX rates, each full width', async () => {
    const { container } = await show();
    const order = [...container.querySelectorAll('main section h2')].map((h) => h.id);
    expect(order.slice(order.indexOf('positions-title'))).toEqual([
      'positions-title',
      'ccy-title',
      'fx-title',
    ]);
    // Visual review: at half width the exact FX rates wrapped into unreadable columns.
    for (const id of ['ccy-title', 'fx-title']) {
      expect(container.querySelector(`#${id}`)?.closest('section')?.parentElement?.tagName).toBe('MAIN');
    }
  });

  it('heading hierarchy: one h1, every section and panel titled by an h2, no skipped levels', async () => {
    const { container } = await show();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('h3, h4, h5, h6')).toHaveLength(0);
    for (const section of container.querySelectorAll('main section')) {
      const id = section.getAttribute('aria-labelledby') ?? '';
      expect(container.querySelector(`#${id}`)?.tagName).toBe('H2');
    }
  });

  it('the stylesheet keeps hierarchy in tokens and collapses the paired row on narrow screens', () => {
    expect(css).toMatch(/--size-metric-secondary: 20px/);
    expect(css).toMatch(/\.panel-primary \{[^}]*var\(--color-raised\)[^}]*var\(--color-border-strong\)/);
    expect(css).toMatch(/@media \(max-width: 760px\) \{\s*\.panels,\s*\.sections,/);
  });

  it('the loss chart is capped so its text does not scale up on wide screens (visual review)', () => {
    expect(css).toMatch(/--chart-max-width: 800px/);
    expect(css).toMatch(
      /\.loss-chart \{[^}]*min-width: var\(--chart-min-width\);[^}]*max-width: var\(--chart-max-width\)/,
    );
  });
});

describe('public-site review fixes', () => {
  it('the exact bucket table is behind a closed native disclosure; the summary and chart stay visible', async () => {
    const { container } = await show();
    const loss = container.querySelector('[data-testid="loss-distribution"]') as HTMLElement;
    const details = loss.querySelector('[data-testid="loss-table-details"]');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Exact values and bucket table (4 buckets)');
    expect(details?.querySelector('[data-testid="loss-table"]')).not.toBeNull();
    // Outside the disclosure: the chart (with its description) and the text summary.
    expect(details?.contains(loss.querySelector('[data-testid="loss-chart"]'))).toBe(false);
    expect(details?.contains(loss.querySelector('[data-testid="loss-summary"]'))).toBe(false);
  });

  it('axe-core finds no violations with the bucket table and the Adjusted VaR details open', async () => {
    const { container } = await show();
    for (const id of ['loss-table-details', 'adjusted-var-details']) {
      (container.querySelector(`[data-testid="${id}"]`) as HTMLDetailsElement).open = true;
    }
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it('an open summary help panel takes its own row below the label instead of displacing the figures', () => {
    expect(css).toMatch(/\.summary-figure dt \.help \{\s*display: contents;/);
    expect(css).toMatch(/\.summary-figure dt \.help-panel \{\s*flex-basis: 100%;/);
    expect(css).toMatch(/\.summary-figure:has\(\.help-panel\) \{\s*flex: 1 1 100%;/);
    expect(css).toMatch(/\.summary-figure:has\(\.help-panel\) dt \{\s*display: block;/);
    expect(css).toMatch(/\.summary-figure dd \{\s*text-align: left;/);
  });
});

describe('institutional redesign (presentation only)', () => {
  it('Base VaR exact values: complete and unrounded, behind a closed disclosure in a focusable region', async () => {
    const { container } = await show();
    const panel = container.querySelector('[data-testid="panel-base-var"]') as HTMLElement;
    const details = panel.querySelector('[data-testid="base-var-exact"]') as HTMLDetailsElement;
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Exact values (share of NAV, raw quantile)');
    const region = details.querySelector('.exact-values') as HTMLElement;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe('Exact Base VaR values, scrollable');
    // A visible hint describes the scroll, and the region is described by it.
    expect(region.getAttribute('aria-describedby')).toBe('base-var-exact-hint');
    expect(details.querySelector('#base-var-exact-hint')?.textContent).toContain('Scroll sideways');
    // The exact backend text, character for character: nothing is rounded or truncated.
    expect(text(region)).toContain('0.5545977964722801352876283961402434634723 %');
    // The headline figure stays the backend display text, outside the disclosure.
    expect(details.contains(panel.querySelector('[data-testid="base-var-value"]'))).toBe(false);
    expect(panel.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('124.10 EUR');
  });

  it('group labels are plain text between the groups, never headings', async () => {
    const { container } = await show();
    const labels = [...container.querySelectorAll('main > .eyebrow')].map((e) => [e.tagName, e.textContent]);
    expect(labels).toEqual([
      ['P', 'Risk visualisation'],
      ['P', 'Risk signals'],
      ['P', 'Portfolio'],
      ['P', 'Currency and FX'],
    ]);
    // Each label sits directly before its group.
    const next = (label: string) =>
      [...container.querySelectorAll('main > .eyebrow')].find((e) => e.textContent === label)
        ?.nextElementSibling;
    expect(next('Risk visualisation')?.getAttribute('data-testid')).toBe('viz-grid');
    expect(next('Risk signals')?.classList.contains('panels')).toBe(true);
    expect(next('Portfolio')?.getAttribute('aria-labelledby')).toBe('positions-title');
    expect(next('Currency and FX')?.getAttribute('aria-labelledby')).toBe('ccy-title');
  });

  it('allocation shades: dark position numbers reach 4.5:1 on every shade; shades reach 3:1 on panels', () => {
    const hex = (name: string): string => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css);
      if (m?.[1] === undefined) throw new Error(`token ${name} missing`);
      return m[1];
    };
    // WCAG relative luminance; colour arithmetic only (not financial values).
    const lum = (h: string): number =>
      [1, 3, 5]
        .map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (let i = 1; i <= 6; i += 1) {
      const shade = hex(`chart-seq-${String(i)}`);
      expect(ratio(hex('chart-seq-ink'), shade), `ink on seq-${String(i)}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(shade, hex('color-panel')), `seq-${String(i)} on panel`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the stylesheet keeps exact rates on one line and layers surfaces with tokens only', () => {
    expect(css).toMatch(/\.rate \{[^}]*white-space: nowrap;/);
    expect(css).not.toMatch(/\.rate \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.exact-values \.facts dd \{[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.section,\s*\.panel:not\(\.panel-primary\) \{[^}]*var\(--color-border-subtle\)/);
    expect(css).toMatch(/\.summary-primary \+ \.summary-figure:not\(\.summary-primary\) \{[^}]*border-left/);
    // Teal stays interaction-only: no accent in the redesign block's data or surface rules.
    const block = css.slice(
      css.indexOf('Institutional redesign.'),
      css.indexOf('Fintech redesign (ui-guidelines'),
    );
    expect(block).not.toMatch(/--color-accent/);
  });
});

describe('loss distribution layout (final refinement)', () => {
  it('reading order is chart, then summary, then the disclosure; no value is duplicated', async () => {
    const { container } = await show();
    const layout = container.querySelector('[data-testid="loss-layout"]') as HTMLElement;
    expect([...layout.children].map((c) => c.getAttribute('data-testid'))).toEqual([
      'loss-main',
      'loss-side',
      'loss-table-details',
    ]);
    const main = layout.querySelector('[data-testid="loss-main"]') as HTMLElement;
    expect(main.querySelector('[data-testid="loss-chart"]')).not.toBeNull();
    expect(main.querySelector('.legend')).not.toBeNull();
    const side = layout.querySelector('[data-testid="loss-side"]') as HTMLElement;
    expect(side.querySelector('[data-testid="loss-summary"]')).not.toBeNull();
    // The concise marker text appears once, from the backend display field.
    expect(text(layout).split('VaR 95% marker at 6.55 EUR').length - 1).toBe(1);
  });

  it('the loss disclosure has the same visible scroll hint and description as the Base VaR one', async () => {
    const { container } = await show();
    const details = container.querySelector('[data-testid="loss-table-details"]') as HTMLDetailsElement;
    const hint = details.querySelector('#loss-exact-hint') as HTMLElement;
    expect(hint.className).toBe('exact-hint');
    expect(hint.textContent).toBe(
      'Full precision, unrounded. Scroll sideways in the boxes to read each value and the bucket table.',
    );
    const region = details.querySelector('[data-testid="loss-exact"]') as HTMLElement;
    expect(region.getAttribute('aria-describedby')).toBe('loss-exact-hint');
    // The hint describes one region only, so it is not announced twice.
    expect(container.querySelectorAll('[aria-describedby="loss-exact-hint"]')).toHaveLength(1);
  });

  it('the stylesheet: the loss card is one column; the visualisation grid is 2:1 and collapses at 1100 px', () => {
    expect(css).toMatch(/\.loss-layout \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).not.toMatch(/minmax\(600px, 800px\) minmax\(16rem, 1fr\)/);
    expect(css).toMatch(
      /\.viz-grid \{\s*display: grid;\s*grid-template-columns: minmax\(0, 2fr\) minmax\(300px, 1fr\);/,
    );
    expect(css).toMatch(
      /@media \(max-width: 1100px\) \{\s*\.viz-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });

  it('light theme with a navy scope: text tokens reach 4.5:1 on every navy surface too', () => {
    const scope = css.slice(css.indexOf('.theme-dark {'), css.indexOf('}', css.indexOf('.theme-dark {')));
    const hex = (name: string): string => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(scope);
      if (m?.[1] === undefined) throw new Error(`dark token ${name} missing`);
      return m[1];
    };
    // WCAG relative luminance; colour arithmetic only (not financial values).
    const lum = (h: string): number =>
      [1, 3, 5]
        .map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const ratio = (a: string, b: string): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const surface of ['color-panel', 'color-raised', 'color-row-hover']) {
      for (const fg of [
        'color-text',
        'color-text-secondary',
        'color-warning',
        'color-accent',
        'color-info',
        'color-critical',
      ]) {
        expect(ratio(hex(fg), hex(surface)), `${fg} on dark ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      // Chart marks (graphics, 3:1): the bars, the orange tail and marker.
      for (const mark of ['chart-bar', 'chart-tail']) {
        expect(ratio(hex(mark), hex(surface)), `${mark} on dark ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('sidebar navigation (fintech refinement)', () => {
  it('a labelled nav in the sidebar links to section headings that exist on the page', async () => {
    const { container } = await show();
    const nav = container.querySelector('header.topbar nav.sidebar-nav') as HTMLElement;
    expect(nav.getAttribute('aria-label')).toBe('Dashboard sections');
    const links = [...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Overview', '#summary-title'],
      ['Loss distribution', '#loss-title'],
      ['Allocation', '#allocation-heading'],
      ['Risk signals', '#base-var-title'],
      ['Positions', '#positions-title'],
      ['Currency and FX', '#ccy-title'],
    ]);
    for (const [, href] of links) {
      expect(container.querySelector(String(href))?.tagName, String(href)).toBe('H2');
    }
    // The nav precedes the page controls in the DOM (identity and navigation, then controls).
    const select = container.querySelector('#portfolio-select') as HTMLElement;
    expect(nav.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the stylesheet hides the section links on phones, where the sidebar is a compact header', () => {
    expect(css).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.sidebar-nav \{\s*display: none;/);
  });
});
