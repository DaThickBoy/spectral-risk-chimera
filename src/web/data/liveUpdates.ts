/**
 * Live dashboard updates (task 17.4; R23.2, R23.3, R25.1). LIVE mode only: the static replay
 * never creates this. It reads the read-only `WS /stream` gateway (task 15.1), validates every
 * message with the shared `StreamEventSchema`, and never computes a financial value.
 *
 * - `RiskUpdate` for the selected portfolio marks the view dirty. At most one dashboard-view
 *   re-fetch (`refresh`) is started per animation frame, and at most one is in flight. An event
 *   that arrives while a re-fetch is in flight sets the dirty flag again, so another re-fetch
 *   follows it: no update is lost, and none is duplicated.
 * - `SentimentUpdate` changes only its ticker. The latest event per ticker in a frame is
 *   applied, and only that ticker's subscribers are notified (no view re-fetch, no full
 *   re-render). The display mapping mirrors the backend view model (`sentimentOf`): an index
 *   is shown as `INDEX` (always REAL), otherwise the latest observation with its source kind.
 *   Values are the exact strings sent by the backend.
 * - `ProviderStatus` replaces the shown provider list. `AlertRaised` is not shown here.
 * - Connection state is visible (`CONNECTING`, `CONNECTED`, `RECONNECTING`, `DISCONNECTED`).
 *   After a drop, reconnects follow a fixed delay list. A successful reconnect re-fetches the
 *   view, because events may have been missed while disconnected.
 * - An invalid message (not JSON, or not a valid event) is dropped and counted, never repaired.
 *
 * DOM-free: the socket, the frame scheduler, and the timers are injected, so tests are exact.
 */
import { StreamEventSchema } from '../../shared/apiContracts/index.js';
import type { StreamEvent } from '../../shared/apiContracts/index.js';

type SentimentEvent = Extract<StreamEvent, { type: 'SentimentUpdate' }>;
type ProviderEvent = Extract<StreamEvent, { type: 'ProviderStatus' }>;
export type ProviderStatusItem = ProviderEvent['providers'][number];

/** A ticker's sentiment as the view model shows it (`AssetRiskRow['sentiment']`). */
export interface SentimentDisplay {
  readonly value: string | null;
  readonly status: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
  readonly sourceKind: 'REAL' | 'DEMO' | null;
  readonly observedAt: string | null;
  readonly basis: 'INDEX' | 'LATEST_OBSERVATION' | 'NONE';
}

export type StreamState = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export interface StreamStatus {
  readonly state: StreamState;
  /** Reconnect attempts since the last successful connection (a count). */
  readonly attempt: number;
  /** Messages dropped because they were not valid stream events (a count). */
  readonly invalidMessages: number;
}

/** The subset of the browser `WebSocket` that is used. */
export interface StreamSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface LiveUpdateHooks {
  /** The portfolio currently shown, or undefined. */
  readonly selected: () => string | undefined;
  /** Re-fetches and applies the dashboard view of this portfolio. Must not reject. */
  readonly refresh: (portfolioId: string) => Promise<void>;
}

export interface LiveUpdateDependencies {
  readonly url: string;
  readonly connect: (url: string) => StreamSocket;
  /** One callback at the next animation frame (`requestAnimationFrame` in the browser). */
  readonly scheduleFrame: (callback: () => void) => void;
  readonly setTimer: (callback: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Milliseconds before reconnect attempt 1, 2, ...; the last value repeats. */
  readonly reconnectDelaysMs?: readonly number[];
}

export interface LiveUpdates {
  start(): void;
  stop(): void;
  status(): StreamStatus;
  subscribeStatus(listener: () => void): () => void;
  sentiment(ticker: string): SentimentDisplay | undefined;
  subscribeSentiment(ticker: string, listener: () => void): () => void;
  providers(): readonly ProviderStatusItem[];
  subscribeProviders(listener: () => void): () => void;
}

export type LiveUpdateFactory = (hooks: LiveUpdateHooks) => LiveUpdates;

export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000];

/** Mirrors the backend view model's sentiment mapping (`sentimentOf`, riskViewBuilder.ts). */
export function sentimentDisplayOf(event: SentimentEvent): SentimentDisplay {
  if (event.index !== null) {
    return {
      value: event.index.value,
      status: event.index.status,
      sourceKind: 'REAL',
      observedAt: event.index.observedAt,
      basis: 'INDEX',
    };
  }
  if (event.latest !== null) {
    return {
      value: event.latest.value,
      status: event.latest.status,
      sourceKind: event.latest.sourceKind,
      observedAt: event.latest.observedAt,
      basis: 'LATEST_OBSERVATION',
    };
  }
  return { value: null, status: 'UNAVAILABLE', sourceKind: null, observedAt: null, basis: 'NONE' };
}

/**
 * The newer of the view's sentiment and the live one, by observation time (fixed-format UTC
 * timestamps compare as text; not a financial value). Without a live value, the view's.
 */
export function newerSentiment(
  fromView: SentimentDisplay,
  live: SentimentDisplay | undefined,
): SentimentDisplay {
  if (live === undefined) return fromView;
  if (fromView.observedAt === null) return live;
  if (live.observedAt === null) return fromView;
  return live.observedAt >= fromView.observedAt ? live : fromView;
}

function parseEvent(data: unknown): StreamEvent | undefined {
  if (typeof data !== 'string') return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(data); // our own gateway's contract; validated below, never repaired
  } catch {
    return undefined;
  }
  const parsed = StreamEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function createLiveUpdates(deps: LiveUpdateDependencies, hooks: LiveUpdateHooks): LiveUpdates {
  const delays = deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  let status: StreamStatus = { state: 'DISCONNECTED', attempt: 0, invalidMessages: 0 };
  let socket: StreamSocket | undefined;
  let timer: unknown;
  let running = false;
  let everConnected = false;

  const statusListeners = new Set<() => void>();
  const providerListeners = new Set<() => void>();
  const sentimentListeners = new Map<string, Set<() => void>>();
  const sentiments = new Map<string, SentimentDisplay>();
  let providers: readonly ProviderStatusItem[] = [];

  // Frame coalescing and the dirty/in-flight re-fetch.
  let frameQueued = false;
  let dirty = false;
  let inFlight = false;
  const pendingSentiment = new Map<string, SentimentDisplay>();

  const setStatus = (next: Partial<StreamStatus>): void => {
    status = { ...status, ...next };
    for (const listener of statusListeners) listener();
  };

  const queueFrame = (): void => {
    if (frameQueued || !running) return;
    frameQueued = true;
    deps.scheduleFrame(flush);
  };

  function flush(): void {
    frameQueued = false;
    if (!running) return;
    for (const [ticker, display] of pendingSentiment) {
      sentiments.set(ticker, display);
      for (const listener of sentimentListeners.get(ticker) ?? []) listener();
    }
    pendingSentiment.clear();
    if (dirty && !inFlight) {
      const portfolioId = hooks.selected();
      dirty = false;
      if (portfolioId === undefined) return;
      inFlight = true;
      void hooks.refresh(portfolioId).finally(() => {
        inFlight = false;
        if (dirty) queueFrame();
      });
    }
  }

  const requestRefresh = (): void => {
    dirty = true;
    queueFrame();
  };

  const handle = (event: StreamEvent): void => {
    switch (event.type) {
      case 'RiskUpdate':
        if (event.portfolioId === hooks.selected()) requestRefresh();
        return;
      case 'SentimentUpdate':
        pendingSentiment.set(event.ticker, sentimentDisplayOf(event));
        queueFrame();
        return;
      case 'ProviderStatus':
        providers = event.providers;
        for (const listener of providerListeners) listener();
        return;
      case 'AlertRaised':
        return; // alerts are not part of this view
      default: {
        const never: never = event;
        return never;
      }
    }
  };

  const scheduleReconnect = (): void => {
    const attempt = status.attempt + 1;
    const delay = delays[attempt - 1] ?? delays[delays.length - 1] ?? 30000;
    setStatus({ state: 'RECONNECTING', attempt });
    timer = deps.setTimer(() => {
      timer = undefined;
      open();
    }, delay);
  };

  function open(): void {
    if (!running) return;
    if (status.state !== 'RECONNECTING') setStatus({ state: 'CONNECTING' });
    let current: StreamSocket;
    try {
      current = deps.connect(deps.url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      const reconnected = everConnected;
      everConnected = true;
      setStatus({ state: 'CONNECTED', attempt: 0 });
      // Events may have been missed while disconnected: re-fetch the shown view once.
      if (reconnected) requestRefresh();
    };
    current.onmessage = (message) => {
      if (socket !== current) return;
      const event = parseEvent(message.data);
      if (event === undefined) {
        setStatus({ invalidMessages: status.invalidMessages + 1 });
        return;
      }
      handle(event);
    };
    current.onerror = () => undefined; // a close event always follows
    current.onclose = () => {
      if (socket !== current) return;
      socket = undefined;
      if (running) scheduleReconnect();
    };
  }

  const subscribe = (set: Set<() => void>, listener: () => void): (() => void) => {
    set.add(listener);
    return () => set.delete(listener);
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      open();
    },
    stop: () => {
      running = false;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
      const current = socket;
      socket = undefined;
      current?.close();
      pendingSentiment.clear();
      dirty = false;
      setStatus({ state: 'DISCONNECTED', attempt: 0 });
    },
    status: () => status,
    subscribeStatus: (listener) => subscribe(statusListeners, listener),
    sentiment: (ticker) => sentiments.get(ticker),
    subscribeSentiment: (ticker, listener) => {
      let set = sentimentListeners.get(ticker);
      if (set === undefined) {
        set = new Set();
        sentimentListeners.set(ticker, set);
      }
      return subscribe(set, listener);
    },
    providers: () => providers,
    subscribeProviders: (listener) => subscribe(providerListeners, listener),
  };
}
