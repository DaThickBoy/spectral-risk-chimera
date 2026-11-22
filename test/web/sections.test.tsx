import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { DashboardViewResponseSchema } from '../../src/shared/apiContracts/index.js';
import { AllocationChart } from '../../src/web/components/AllocationChart.tsx';
import { FxSection, PositionsSection } from '../../src/web/components/Sections.tsx';
import { multiCurrencyView } from './fixtures.js';
import { render } from './render.js';

const scenario = () => {
  const base = multiCurrencyView();
  const [eu, uk, us] = base.view.assets;
  if (!eu || !uk || !us) throw new Error('Missing test asset');
  return DashboardViewResponseSchema.parse({
    ...base,
    view: {
      ...base.view,
      assets: [
        { ...eu, marketValueBase: '2.000000000000000000001', allocationPct: '3' },
        { ...us, marketValueBase: null, allocationPct: null, valuationStatus: 'FX_STALE' },
        { ...uk, marketValueBase: '2.000000000000000000002', allocationPct: '40' },
      ],
    },
    display: {
      ...base.display,
      assets: base.display.assets.map(({ ticker }) => ({
        ticker,
        marketValueBase: ticker === us.ticker ? null : '2.00',
      })),
    },
  });
};

describe('Holdings and FX', () => {
  it('sorts exact signed values rather than identical display text and keeps null last', async () => {
    const { container, unmount } = await render(<PositionsSection data={scenario()} />);
    try {
      const order = () => Array.from(container.querySelectorAll('tbody th'), (cell) => cell.textContent);
      const button = Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes('Value'),
      );
      expect(button).toBeDefined();
      act(() => button?.click());
      expect(order()).toEqual(['DEMO-UK', 'DEMO-EU', 'DEMO-US']);
      expect(button?.parentElement?.getAttribute('aria-sort')).toBe('descending');
      act(() => button?.click());
      expect(order()).toEqual(['DEMO-EU', 'DEMO-UK', 'DEMO-US']);
      expect(button?.parentElement?.getAttribute('aria-sort')).toBe('ascending');
    } finally {
      unmount();
    }
  });

  it('ranks the fallback and does not plot unavailable allocation as zero', async () => {
    const { container, unmount } = await render(<AllocationChart data={scenario()} />);
    try {
      const rows = container.querySelectorAll('.allocation-row');
      expect(Array.from(rows, (row) => row.getAttribute('data-testid'))).toEqual([
        'allocation-DEMO-UK',
        'allocation-DEMO-EU',
        'allocation-DEMO-US',
      ]);
      expect(rows[2]?.querySelector('.allocation-bar')).toBeNull();
      expect(container.querySelector('[data-testid="allocation-remainder-note"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('separates the exact rate used from the exact original quote in a native disclosure', async () => {
    const { container, unmount } = await render(<FxSection data={multiCurrencyView()} />);
    try {
      const quote = container.querySelector('[data-testid="quote-USD"]');
      const details = quote?.closest('details');
      expect(details?.open).toBe(false);
      expect(details?.querySelector('.fx-desktop-label')?.textContent).toBe('USD details');
      expect(details?.closest('tr')?.querySelector('td.fx-exact')?.textContent).toBe('0.895656…');
      expect(details?.querySelector('.fx-exact')?.textContent).toBe(
        '0.8956560680698611733094491715181370353784',
      );
      expect(quote?.textContent).toContain('EUR→USD 1.1165');
      expect(details?.textContent).toContain('ECB-PUB-1600-FRANKFURT-v1');
    } finally {
      unmount();
    }
  });
});
