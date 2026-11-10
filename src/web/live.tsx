// Live-update subscriptions for components (task 17.4; R23.3). Each hook subscribes to one
// slice of `LiveUpdates` (one ticker's sentiment, the stream status, the provider list), so an
// update re-renders only the components that read it. Without live updates (static replay, or
// tests without a stream) every hook returns the "nothing live" value and subscribes to nothing.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { LiveUpdates, ProviderStatusItem, SentimentDisplay, StreamStatus } from './data/liveUpdates.js';

export const LiveContext = createContext<LiveUpdates | undefined>(undefined);

const noop = (): void => undefined;
const NO_PROVIDERS: readonly ProviderStatusItem[] = [];

export function useLiveSentiment(ticker: string): SentimentDisplay | undefined {
  const live = useContext(LiveContext);
  const subscribe = useCallback(
    (listener: () => void) => (live === undefined ? noop : live.subscribeSentiment(ticker, listener)),
    [live, ticker],
  );
  return useSyncExternalStore(subscribe, () => live?.sentiment(ticker));
}

export function useLiveStatus(): StreamStatus | undefined {
  const live = useContext(LiveContext);
  const subscribe = useCallback(
    (listener: () => void) => (live === undefined ? noop : live.subscribeStatus(listener)),
    [live],
  );
  return useSyncExternalStore(subscribe, () => live?.status());
}

export function useLiveProviders(): readonly ProviderStatusItem[] {
  const live = useContext(LiveContext);
  const subscribe = useCallback(
    (listener: () => void) => (live === undefined ? noop : live.subscribeProviders(listener)),
    [live],
  );
  return useSyncExternalStore(subscribe, () => live?.providers() ?? NO_PROVIDERS);
}
