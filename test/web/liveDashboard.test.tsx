// Task 17.4 in the dashboard: a sentiment event changes only its ticker's row (the other rows
// stay the same DOM nodes, and the view is not re-fetched); a stream-driven refresh replaces
// the view in place; a failed one keeps the previous view and says so; the stream and provider
// state is visible; the static replay never creates live updates.
// Validates: Requirements 23.2, 23.3, 25.1
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardViewResponseSchema } from '../../src/shared/apiContracts/index.js';
import { App } from '../../src/web/App.tsx';
import { createLiveUpdates } from '../../src/web/data/liveUpdates.js';
import type { LiveUpdateFactory, LiveUpdateHooks, StreamSocket } from '../../src/web/data/liveUpdates.js';
import type { Loaded } from '../../src/web/data/source.js';
import type { DashboardViewResponse } from '../../src/shared/apiContracts/index.js';
import { demoIndex, multiCurrencyView } from './fixtures.js';
import { memorySource, render, settle, text } from './render.js';
import type { Rendered } from './render.js';

const mounted: Rendered[] = [];
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount();
});

class FakeSocket implements StreamSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {
    this.onclose = null;
  }
}

interface Live {
  readonly factory: LiveUpdateFactory;
  readonly sockets: FakeSocket[];
  readonly created: LiveUpdateHooks[];
  tick(): Promise<void>;
  send(data: unknown): Promise<void>;
}

function fakeLive(): Live {
  const sockets: FakeSocket[] = [];
  const frames: (() => void)[] = [];
  const created: LiveUpdateHooks[] = [];
  const factory: LiveUpdateFactory = (hooks) => {
    created.push(hooks);
    return createLiveUpdates(
      {
        url: 'ws://127.0.0.1:5173/stream',
        connect: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
        scheduleFrame: (callback) => frames.push(callback),
        setTimer: () => 0,
        clearTimer: () => undefined,
      },
      hooks,
    );
  };
  const tick = async (): Promise<void> => {
    await act(async () => {
      for (const frame of frames.splice(0)) frame();
    });
    await settle();
  };
  const send = async (data: unknown): Promise<void> => {
    await act(async () => {
      sockets.at(-1)?.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    });
  };
  return { factory, sockets, created, tick, send };
}

async function show(options: {
  readonly kind: 'LIVE' | 'REPLAY';
  readonly live?: Live;
  readonly view?: () => Promise<Loaded<DashboardViewResponse>>;
}): Promise<{ rendered: Rendered; viewCalls: () => number }> {
  let calls = 0;
  const rendered = await render(
    <App
      source={memorySource({
        kind: options.kind,
        index: () => Promise.resolve({ ok: true, value: demoIndex() }),
        view: () => {
          calls += 1;
          return options.view?.() ?? Promise.resolve({ ok: true, value: multiCurrencyView() });
        },
      })}
      {...(options.live === undefined ? {} : { liveUpdates: options.live.factory })}
    />,
  );
  mounted.push(rendered);
  await settle();
  return { rendered, viewCalls: () => calls };
}

const sentiment = (ticker: string, value: string) => ({
  type: 'SentimentUpdate',
  ticker,
  index: null,
  latest: {
    value,
    observedAt: '2099-01-01T00:00:00.000Z', // newer than any view value
    receivedAt: '2099-01-01T00:00:00.000Z',
    provider: 'demo-sentiment-fixture',
    sourceKind: 'DEMO',
    status: 'CURRENT',
  },
});

describe('task 17.4 in the dashboard (LIVE mode)', () => {
  it('a sentiment event updates only its ticker row, exactly as sent, without re-fetching the view', async () => {
    const live = fakeLive();
    const { rendered, viewCalls } = await show({ kind: 'LIVE', live });
    const row = (t: string) =>
      rendered.container.querySelector(`[data-testid="sentiment-${t}"]`) as HTMLElement;
    const otherBefore = row('DEMO-EU');
    const otherText = text(otherBefore);
    const callsBefore = viewCalls();
    await live.send(sentiment('DEMO-UK', '-0.810'));
    expect(text(row('DEMO-UK'))).not.toContain('-0.810'); // applied at the next frame only
    await live.tick();
    expect(text(row('DEMO-UK'))).toContain('DEMO-UK -0.810');
    expect(text(row('DEMO-UK'))).toContain('observed 2099-01-01 00:00 UTC');
    expect(row('DEMO-EU')).toBe(otherBefore); // the same DOM node: not re-created
    expect(text(row('DEMO-EU'))).toBe(otherText);
    expect(viewCalls()).toBe(callsBefore); // no view re-fetch for a sentiment update
  });

  it('a refresh replaces the view in place; a failed one keeps the previous view and is shown', async () => {
    const live = fakeLive();
    let next: Loaded<DashboardViewResponse> = {
      ok: true,
      value: DashboardViewResponseSchema.parse({
        ...multiCurrencyView(),
        display: { ...multiCurrencyView().display, baseVaR: '130.00' },
      }),
    };
    let first = true;
    const { rendered } = await show({
      kind: 'LIVE',
      live,
      view: () => {
        if (first) {
          first = false;
          return Promise.resolve({ ok: true, value: multiCurrencyView() });
        }
        return Promise.resolve(next);
      },
    });
    const baseVar = () => rendered.container.querySelector('[data-testid="base-var-value"]')?.textContent;
    expect(baseVar()).toBe('124.10 EUR');
    const hooks = live.created.at(-1);
    await act(async () => {
      await hooks?.refresh('demo-eur-usd-gbp');
    });
    expect(baseVar()).toBe('130.00 EUR');
    expect(rendered.container.querySelector('.state-loading')).toBeNull(); // no loading flash
    next = { ok: false, error: 'NETWORK' };
    await act(async () => {
      await hooks?.refresh('demo-eur-usd-gbp');
    });
    expect(baseVar()).toBe('130.00 EUR'); // the previous view stays
    expect(text(rendered.container.querySelector('[data-testid="live-status"]') as HTMLElement)).toContain(
      'REFRESH FAILED',
    );
  });

  it('shows the stream state, reconnecting, and providers that are not available', async () => {
    const live = fakeLive();
    const { rendered } = await show({ kind: 'LIVE', live });
    const status = () => text(rendered.container.querySelector('[data-testid="live-status"]') as HTMLElement);
    expect(status()).toContain('STREAM CONNECTING');
    await act(async () => {
      live.sockets.at(-1)?.onopen?.();
    });
    expect(status()).toContain('STREAM CONNECTED');
    await live.send({
      type: 'ProviderStatus',
      providers: [
        {
          provider: 'fx:ECB-EXR',
          state: 'UNAVAILABLE',
          circuit: 'OPEN',
          since: '2026-11-06T15:59:00.000Z',
          lastErrorCode: 'CIRCUIT_OPEN',
        },
        {
          provider: 'marketdata:demo-fixtures-md',
          state: 'AVAILABLE',
          circuit: 'CLOSED',
          since: '2026-11-06T15:59:00.000Z',
        },
      ],
    });
    expect(status()).toContain('fx:ECB-EXR UNAVAILABLE (CIRCUIT OPEN)');
    expect(status()).not.toContain('demo-fixtures-md'); // available providers are not listed
    await act(async () => {
      live.sockets.at(-1)?.onclose?.();
    });
    expect(status()).toContain('STREAM RECONNECTING attempt 1');
  });

  it('the static replay never creates live updates or shows a stream state', async () => {
    const live = fakeLive();
    const { rendered } = await show({ kind: 'REPLAY', live });
    expect(live.created).toHaveLength(0);
    expect(live.sockets).toHaveLength(0);
    expect(rendered.container.querySelector('[data-testid="live-status"]')).toBeNull();
  });
});
