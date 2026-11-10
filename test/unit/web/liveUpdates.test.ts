// Task 17.4: stream-driven dashboard updates (R23.2 at most one update per animation frame;
// R23.3 a single-ticker update does not re-fetch or re-render the dashboard; R25.1 visible
// connection state). Fake socket, frame scheduler, and timers make every step exact. The
// RiskUpdate events are genuine backend events (`riskUpdateEvent` over a stored risk view).
// Validates: Requirements 23.2, 23.3, 25.1
import { describe, expect, it } from 'vitest';
import { riskUpdateEvent } from '../../../src/app/index.js';
import { StreamEventSchema } from '../../../src/shared/index.js';
import { createLiveUpdates, newerSentiment, sentimentDisplayOf } from '../../../src/web/data/liveUpdates.js';
import type { LiveUpdates, SentimentDisplay, StreamSocket } from '../../../src/web/data/liveUpdates.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { PF, cleanSeries, riskHarness } from '../../helpers/riskService.js';

const SELECTED = 'demo-eur-usd-gbp';
const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

/** A genuine RiskUpdate (validated by the shared schema), addressed to `portfolioId`. */
async function riskEvent(portfolioId: string): Promise<string> {
  const h = riskHarness({ AAA: ['USD', '10'] }, { values: SMALL, prices: { AAA: { price: '100' } } });
  h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
  await h.service.calculate(PF);
  const view = h.service.view(PF);
  if (view === undefined) throw new Error('no risk view');
  const event = { ...riskUpdateEvent(PF, view), portfolioId };
  expect(StreamEventSchema.safeParse(event).success).toBe(true);
  return JSON.stringify(event);
}

const sentimentEvent = (ticker: string, value: string, observedAt = '2026-11-06T15:56:00.000Z'): string =>
  JSON.stringify({
    type: 'SentimentUpdate',
    ticker,
    index: null,
    latest: {
      value,
      observedAt,
      receivedAt: observedAt,
      provider: 'demo-sentiment-fixture',
      sourceKind: 'DEMO',
      status: 'CURRENT',
    },
  });

interface Harness {
  readonly live: LiveUpdates;
  readonly sockets: FakeSocket[];
  readonly frames: (() => void)[];
  readonly timers: { readonly callback: () => void; readonly ms: number; cleared: boolean }[];
  readonly refreshes: { readonly portfolioId: string; resolve: () => void }[];
  /** Runs the queued animation frames (one tick). */
  tick(): void;
}

class FakeSocket implements StreamSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  send(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** `null`: no portfolio is shown. */
function harness(selected: string | null = SELECTED): Harness {
  const sockets: FakeSocket[] = [];
  const frames: (() => void)[] = [];
  const timers: Harness['timers'] = [];
  const refreshes: Harness['refreshes'] = [];
  const live = createLiveUpdates(
    {
      url: 'ws://127.0.0.1:5173/stream',
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleFrame: (callback) => frames.push(callback),
      setTimer: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    {
      selected: () => selected ?? undefined,
      refresh: (portfolioId) =>
        new Promise<void>((resolve) => {
          refreshes.push({ portfolioId, resolve });
        }),
    },
  );
  return {
    live,
    sockets,
    frames,
    timers,
    refreshes,
    tick: () => {
      for (const frame of frames.splice(0)) frame();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function connected(h: Harness): FakeSocket {
  h.live.start();
  const socket = h.sockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  socket.onopen?.();
  return socket;
}

describe('RiskUpdate: at most one view re-fetch per frame, none lost while one is in flight', () => {
  it('a burst in one frame starts exactly one re-fetch, and only at the frame', async () => {
    const h = harness();
    const socket = connected(h);
    const event = await riskEvent(SELECTED);
    for (let i = 0; i < 5; i += 1) socket.send(event);
    expect(h.refreshes).toHaveLength(0);
    expect(h.frames).toHaveLength(1); // one frame scheduled for the whole burst
    h.tick();
    expect(h.refreshes.map((r) => r.portfolioId)).toEqual([SELECTED]);
  });

  it('events during an in-flight re-fetch cause exactly one follow-up re-fetch after it', async () => {
    const h = harness();
    const socket = connected(h);
    const event = await riskEvent(SELECTED);
    socket.send(event);
    h.tick();
    expect(h.refreshes).toHaveLength(1);
    // Three more while the first is in flight: no second concurrent re-fetch.
    for (let i = 0; i < 3; i += 1) {
      socket.send(event);
      h.tick();
    }
    expect(h.refreshes).toHaveLength(1);
    h.refreshes[0]?.resolve();
    await settle();
    h.tick();
    expect(h.refreshes).toHaveLength(2); // the pending changes are not lost
    h.refreshes[1]?.resolve();
    await settle();
    h.tick();
    expect(h.refreshes).toHaveLength(2); // and not duplicated
  });

  it('a RiskUpdate for another portfolio, or with no portfolio shown, re-fetches nothing', async () => {
    const h = harness();
    connected(h).send(await riskEvent('demo-eur-only'));
    h.tick();
    expect(h.refreshes).toHaveLength(0);
    const none = harness(null);
    connected(none).send(await riskEvent(SELECTED));
    none.tick();
    expect(none.refreshes).toHaveLength(0);
  });
});

describe('SentimentUpdate: only the affected ticker, with the exact backend value', () => {
  it('notifies only that ticker, once per frame, with the latest event of the frame', () => {
    const h = harness();
    const socket = connected(h);
    const notified: string[] = [];
    h.live.subscribeSentiment('DEMO-UK', () => notified.push('DEMO-UK'));
    h.live.subscribeSentiment('DEMO-EU', () => notified.push('DEMO-EU'));
    socket.send(sentimentEvent('DEMO-UK', '-0.70'));
    socket.send(sentimentEvent('DEMO-UK', '-0.810'));
    expect(notified).toEqual([]); // applied at the frame, not per message
    h.tick();
    expect(notified).toEqual(['DEMO-UK']);
    expect(h.live.sentiment('DEMO-UK')).toEqual({
      value: '-0.810', // exactly as sent: not re-formatted, not re-rounded
      status: 'CURRENT',
      sourceKind: 'DEMO',
      observedAt: '2026-11-06T15:56:00.000Z',
      basis: 'LATEST_OBSERVATION',
    });
    expect(h.live.sentiment('DEMO-EU')).toBeUndefined();
    expect(h.refreshes).toHaveLength(0); // no view re-fetch for a sentiment update
  });

  it('maps an index as INDEX (REAL) and no data as UNAVAILABLE, like the backend view model', () => {
    const index = {
      value: '0.25',
      observedAt: '2026-11-06T15:58:00.000Z',
      source: 'p',
      status: 'STALE',
      aggregatorVersion: 'v1',
    } as const;
    expect(sentimentDisplayOf({ type: 'SentimentUpdate', ticker: 'X', index, latest: null })).toEqual({
      value: '0.25',
      status: 'STALE',
      sourceKind: 'REAL',
      observedAt: '2026-11-06T15:58:00.000Z',
      basis: 'INDEX',
    });
    expect(sentimentDisplayOf({ type: 'SentimentUpdate', ticker: 'X', index: null, latest: null })).toEqual({
      value: null,
      status: 'UNAVAILABLE',
      sourceKind: null,
      observedAt: null,
      basis: 'NONE',
    });
  });

  it('shows the newer of the view value and the streamed value, by observation time', () => {
    const at = (observedAt: string | null): SentimentDisplay => ({
      value: '0.1',
      status: 'CURRENT',
      sourceKind: 'DEMO',
      observedAt,
      basis: 'LATEST_OBSERVATION',
    });
    const view = at('2026-11-06T15:55:00.000Z');
    expect(newerSentiment(view, undefined)).toBe(view);
    expect(newerSentiment(view, at('2026-11-06T15:56:00.000Z')).observedAt).toBe('2026-11-06T15:56:00.000Z');
    expect(newerSentiment(view, at('2026-11-06T15:54:00.000Z'))).toBe(view); // an older event never replaces
  });
});

describe('invalid messages, connection state, reconnect, and stop', () => {
  it('drops and counts invalid messages; nothing is applied or re-fetched', () => {
    const h = harness();
    const socket = connected(h);
    socket.send('not json');
    socket.send(
      JSON.stringify({ type: 'SentimentUpdate', ticker: 'DEMO-UK', index: null, latest: { value: -0.7 } }),
    );
    socket.send(JSON.stringify({ type: 'Unknown' }));
    socket.send(new Uint8Array([1, 2]));
    h.tick();
    expect(h.live.status().invalidMessages).toBe(4);
    expect(h.live.sentiment('DEMO-UK')).toBeUndefined();
    expect(h.refreshes).toHaveLength(0);
  });

  it('shows CONNECTING, CONNECTED, then RECONNECTING with the attempt after a drop', () => {
    const h = harness();
    const states: string[] = [];
    h.live.subscribeStatus(() => states.push(`${h.live.status().state}:${String(h.live.status().attempt)}`));
    const socket = connected(h);
    socket.onclose?.();
    expect(states).toEqual(['CONNECTING:0', 'CONNECTED:0', 'RECONNECTING:1']);
    expect(h.timers.map((t) => t.ms)).toEqual([1000]);
    h.timers[0]?.callback();
    h.sockets.at(-1)?.onclose?.();
    expect(h.live.status()).toMatchObject({ state: 'RECONNECTING', attempt: 2 });
    expect(h.timers.map((t) => t.ms)).toEqual([1000, 2000]);
  });

  it('a successful reconnect re-fetches the view once (events may have been missed)', () => {
    const h = harness();
    connected(h).onclose?.();
    h.timers[0]?.callback();
    h.sockets.at(-1)?.onopen?.();
    expect(h.live.status()).toMatchObject({ state: 'CONNECTED', attempt: 0 });
    h.tick();
    expect(h.refreshes.map((r) => r.portfolioId)).toEqual([SELECTED]);
  });

  it('provider status events replace the provider list', () => {
    const h = harness();
    const socket = connected(h);
    const providers = [
      {
        provider: 'fx:ECB-EXR',
        state: 'UNAVAILABLE',
        circuit: 'OPEN',
        since: '2026-11-06T15:59:00.000Z',
        lastErrorCode: 'CIRCUIT_OPEN',
      },
    ];
    socket.send(JSON.stringify({ type: 'ProviderStatus', providers }));
    expect(h.live.providers()).toEqual(providers);
  });

  it('stop closes the socket, cancels the reconnect timer, and ignores late events', async () => {
    const h = harness();
    const socket = connected(h);
    socket.onclose?.();
    h.live.stop();
    expect(h.timers[0]?.cleared).toBe(true);
    expect(h.live.status().state).toBe('DISCONNECTED');
    const second = harness();
    const open = connected(second);
    second.live.stop();
    expect(open.closed).toBe(true);
    open.send(await riskEvent(SELECTED)); // a late event from a closed socket
    second.tick();
    expect(second.refreshes).toHaveLength(0);
  });
});
