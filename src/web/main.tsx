// Dashboard entry (task 17.2). The data source is chosen at build time with
// VITE_DASHBOARD_SOURCE: "replay" (default; recorded responses next to the build, H4) or
// "live" (the local demo backend's read-only routes, proxied in development). Nothing secret
// is compiled in, and no request other than GET is ever made.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { UrlState } from './App.tsx';
import { createLiveSource, createReplaySource } from './data/source.js';
import type { Fetch } from './data/source.js';
import './styles.css';

const browserFetch: Fetch = (url, init) => window.fetch(url, { ...init, credentials: 'omit' });

/** `?portfolio=<id>` in the address bar: deep links and back/forward, on the current path. */
const browserUrl: UrlState = {
  read: () => new URLSearchParams(window.location.search).get('portfolio') ?? undefined,
  write: (portfolioId) => {
    const next = new URL(window.location.href);
    if (next.searchParams.get('portfolio') === portfolioId) return;
    next.searchParams.set('portfolio', portfolioId);
    window.history.pushState(null, '', next);
  },
  subscribe: (onChange) => {
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  },
};
const source =
  import.meta.env['VITE_DASHBOARD_SOURCE'] === 'live'
    ? createLiveSource(browserFetch)
    : createReplaySource(browserFetch, './replay');

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App source={source} url={browserUrl} />
    </StrictMode>,
  );
}
