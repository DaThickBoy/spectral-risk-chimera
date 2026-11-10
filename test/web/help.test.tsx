// Contextual glossary help (roadmap S4): native disclosure behaviour, keyboard and Escape
// handling, screen-reader wiring, placement next to the relevant labels, content accuracy, and
// axe-core with a panel open (colour contrast is checked separately from the design tokens).
// Validates: Requirements 35.1, 35.4, 35.6
import axe from 'axe-core';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/web/App.tsx';
import { Help } from '../../src/web/components/Help.tsx';
import { GLOSSARY } from '../../src/web/glossary.ts';
import { demoIndex, multiCurrencyView } from './fixtures.js';
import { memorySource, render } from './render.js';
import type { Rendered } from './render.js';

const mounted: Rendered[] = [];
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount();
});

async function mount(element: Parameters<typeof render>[0]): Promise<Rendered> {
  const r = await render(element);
  mounted.push(r);
  return r;
}

function button(container: HTMLElement, term: string): HTMLButtonElement {
  const el = container.querySelector(`[data-testid="help-${term}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`help-${term} button missing`);
  return el;
}

function panel(container: HTMLElement, term: string): HTMLElement | null {
  return container.querySelector(`[data-testid="help-${term}-panel"]`);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

async function press(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('Help disclosure behaviour', () => {
  it('is a native button with an accessible name, collapsed by default and with no panel', async () => {
    const { container } = await mount(<Help term="nav" />);
    const b = button(container, 'nav');
    expect(b.type).toBe('button');
    expect(b.getAttribute('aria-label')).toBe('What is NAV?');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.hasAttribute('aria-controls')).toBe(false);
    expect(panel(container, 'nav')).toBeNull();
  });

  it('toggles open and closed; aria-controls names the panel only while it exists', async () => {
    const { container } = await mount(<Help term="nav" />);
    const b = button(container, 'nav');
    await click(b);
    const p = panel(container, 'nav');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(p).not.toBeNull();
    expect(p?.getAttribute('role')).toBe('note');
    expect(b.getAttribute('aria-controls')).toBe(p?.id);
    expect(document.getElementById(b.getAttribute('aria-controls') ?? '')).toBe(p);
    await click(b);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.hasAttribute('aria-controls')).toBe(false);
    expect(panel(container, 'nav')).toBeNull();
  });

  it('Escape closes the open panel and keeps focus on the button', async () => {
    const { container } = await mount(<Help term="states" />);
    const b = button(container, 'states');
    b.focus();
    await click(b);
    expect(panel(container, 'states')).not.toBeNull();
    await press(b, 'Escape');
    expect(panel(container, 'states')).toBeNull();
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(b);
  });

  it('Escape on a closed button does nothing; other keys do not close it', async () => {
    const { container } = await mount(<Help term="nav" />);
    const b = button(container, 'nav');
    await press(b, 'Escape');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    await click(b);
    await press(b, 'a');
    expect(panel(container, 'nav')).not.toBeNull();
  });

  it("separates the general definition from this dashboard's convention", async () => {
    const { container } = await mount(<Help term="baseVar" />);
    await click(button(container, 'baseVar'));
    const text = panel(container, 'baseVar')?.textContent ?? '';
    expect(text).toContain(`In general: ${GLOSSARY.baseVar.general}`);
    expect(text).toContain(`In this dashboard: ${GLOSSARY.baseVar.app}`);
  });
});

describe('glossary content', () => {
  it('states that unavailable data is not zero', () => {
    expect(GLOSSARY.states.app).toContain('is not zero');
    expect(GLOSSARY.states.app).toContain('—');
  });

  it('explains Adjusted VaR and OD-1 without implying sentiment affects the risk engine', () => {
    const app = GLOSSARY.adjustedVar.app;
    expect(app).toContain('OD-1');
    expect(app).toContain('Sentiment does not affect any risk figure');
    expect(app).toContain('-0.60');
    expect(app).toContain('1.15');
    expect(GLOSSARY.adjustedVar.general).toContain('not a statistical estimate');
  });

  it('describes VaR as a percentile estimate, not a worst case, with the documented method', () => {
    expect(GLOSSARY.baseVar.general).toContain('not the worst possible loss');
    expect(GLOSSARY.baseVar.app).toMatch(/250 daily returns \(at least 200\)/);
    expect(GLOSSARY.baseVar.app).toContain('type 7');
    expect(GLOSSARY.confidence.app).toContain('1 trading day');
  });

  it('every entry has a term, a general definition, and an application convention', () => {
    for (const entry of Object.values(GLOSSARY)) {
      expect(entry.term.length).toBeGreaterThan(0);
      expect(entry.general.length).toBeGreaterThan(0);
      expect(entry.app.length).toBeGreaterThan(0);
    }
  });
});

describe('Help placement in the dashboard', () => {
  async function dashboard(): Promise<Rendered> {
    return mount(
      <App
        source={memorySource({
          index: () => Promise.resolve({ ok: true, value: demoIndex() }),
          view: () => Promise.resolve({ ok: true, value: multiCurrencyView() }),
        })}
      />,
    );
  }

  it('renders one trigger for every glossary term, outside headings', async () => {
    const { container } = await dashboard();
    for (const term of Object.keys(GLOSSARY)) {
      const b = button(container, term);
      expect(b.closest('h1, h2, h3')).toBeNull();
      expect(container.querySelectorAll(`[data-testid="help-${term}"]`)).toHaveLength(1);
    }
  });

  it('places triggers next to their labels', async () => {
    const { container } = await dashboard();
    const summary = container.querySelector('[data-testid="summary"]') as HTMLElement;
    for (const term of ['nav', 'baseVar', 'exposure', 'states'])
      expect(summary.contains(button(container, term))).toBe(true);
    const baseVarPanel = container.querySelector('#base-var-title')?.closest('section') as HTMLElement;
    expect(baseVarPanel.contains(button(container, 'confidence'))).toBe(true);
    expect(baseVarPanel.contains(button(container, 'rawQuantile'))).toBe(true);
    const adjusted = container.querySelector('#adjusted-var-title')?.closest('section') as HTMLElement;
    expect(adjusted.contains(button(container, 'adjustedVar'))).toBe(true);
    expect(
      container.querySelector('[data-testid="loss-badges"]')?.contains(button(container, 'lossDistribution')),
    ).toBe(true);
    expect(
      container.querySelector('[data-testid="ccy-badges"]')?.contains(button(container, 'currencyExposure')),
    ).toBe(true);
  });

  it('opening a panel leaves the metric values unchanged and visible', async () => {
    const { container } = await dashboard();
    await click(button(container, 'adjustedVar'));
    await click(button(container, 'confidence'));
    expect(container.querySelector('[data-testid="base-var-value"]')?.textContent).toBe('124.10 EUR');
    expect(container.querySelector('[data-testid="adjusted-var-value"]')?.textContent).toBe('Unavailable');
  });

  it('axe-core finds no violations with help panels open', async () => {
    const { container } = await dashboard();
    for (const term of ['nav', 'adjustedVar', 'states', 'lossDistribution'])
      await click(button(container, term));
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
