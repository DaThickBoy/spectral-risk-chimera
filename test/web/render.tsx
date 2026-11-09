// Minimal React rendering helpers for jsdom component tests (no extra testing library).
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { DashboardIndexResponse, DashboardViewResponse } from '../../src/shared/apiContracts/index.js';
import type { DashboardDataSource, Loaded, SourceInfo } from '../../src/web/data/source.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  readonly container: HTMLElement;
  readonly root: Root;
  unmount(): void;
}

/** Lets pending promises and effects settle inside act(). */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function render(element: ReactElement): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** An in-memory source; each call can be answered, delayed, or failed by the test. */
export function memorySource(options: {
  readonly kind?: 'LIVE' | 'REPLAY';
  readonly info?: SourceInfo;
  readonly index: () => Promise<Loaded<DashboardIndexResponse>>;
  readonly view: (id: string) => Promise<Loaded<DashboardViewResponse>>;
}): DashboardDataSource & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    kind: options.kind ?? 'LIVE',
    calls,
    info: () => Promise.resolve({ ok: true, value: options.info ?? { kind: options.kind ?? 'LIVE' } }),
    index: () => {
      calls.push('index');
      return options.index();
    },
    view: (id) => {
      calls.push(`view:${id}`);
      return options.view(id);
    },
  };
}

export const text = (container: HTMLElement): string => container.textContent ?? '';
