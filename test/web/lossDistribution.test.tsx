// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { LossDistributionSection } from '../../src/web/components/LossDistribution.tsx';
import { multiCurrencyView } from './fixtures.js';
import { render } from './render.js';

const lookup = <T extends Element>(container: HTMLElement, selector: string): T => {
  const result = container.querySelector<T>(selector);
  if (result === null) throw new Error(`Missing ${selector}`);
  return result;
};

describe('loss bucket inspector', () => {
  it('previews pointer hover, restores the selected bucket on exit, and commits on activation', async () => {
    const fixture = multiCurrencyView();
    const dist = fixture.lossDistribution;
    if (dist.status !== 'AVAILABLE') throw new Error('fixture must be available');
    const edge = dist.buckets.at(-1);
    if (edge === undefined) throw new Error('fixture must have buckets');
    const rendered = await render(<LossDistributionSection data={fixture} />);
    try {
      const { container } = rendered;
      const index = dist.buckets.length - 1;
      const hit = lookup(container, `[data-testid="loss-hit-${String(index)}"]`);
      const value = lookup(container, '[data-testid="loss-bucket-value"]');
      const select = lookup<HTMLSelectElement>(container, '.loss-inspector select');
      const status = lookup(container, '.loss-inspector [role="status"]');
      expect(select.selectedIndex).toBe(dist.varMarker.bucketIndex);
      act(() => hit.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
      expect(value.textContent).toContain(`Approx. ${edge.lower} to ${edge.upper} ${dist.currency}`);
      expect(select.selectedIndex).toBe(dist.varMarker.bucketIndex);
      act(() => hit.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })));
      expect(value.textContent).toContain(`Bucket ${String(dist.varMarker.bucketIndex + 1)}`);
      act(() => hit.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(select.selectedIndex).toBe(index);
      expect(status.textContent).toContain(`${String(edge.count)} scenarios; ${edge.lower} to ${edge.upper}`);
    } finally {
      rendered.unmount();
    }
  });

  it('uses a native bucket control in compact mode and keeps the exact table', async () => {
    const fixture = multiCurrencyView();
    const rendered = await render(<LossDistributionSection data={fixture} compact />);
    try {
      const { container } = rendered;
      const select = lookup<HTMLSelectElement>(container, '.loss-inspector select');
      const status = lookup(container, '.loss-inspector [role="status"]');
      act(() => {
        select.selectedIndex = 0;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(status.textContent).toContain('Bucket 1:');
      expect(status.textContent).toContain('upper edge excluded');
      expect(container.querySelector('[data-testid="loss-side"]')).toBeNull();
      expect(container.querySelector('[data-testid="loss-table-details"]')).not.toBeNull();
      expect(lookup(container, '[data-testid="loss-chart"]').getAttribute('viewBox')).toBe('0 0 640 230');
    } finally {
      rendered.unmount();
    }
  });
});
