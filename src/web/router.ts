import { useCallback, useEffect, useState } from 'react';

export const VIEWS = [
  { id: 'overview', label: 'Overview', icon: '▦' },
  { id: 'risk', label: 'Risk Analytics', icon: '∿' },
  { id: 'portfolio', label: 'Portfolio', icon: '▤' },
  { id: 'signals', label: 'Risk Signals', icon: '◇' },
  { id: 'fx', label: 'FX & Provenance', icon: '↔' },
] as const;

export type ViewId = (typeof VIEWS)[number]['id'];

export function viewHref(id: ViewId): `#/${ViewId}` {
  return `#/${id}`;
}

export function parseView(hash: string): ViewId {
  return VIEWS.find(({ id }) => viewHref(id) === hash)?.id ?? 'overview';
}

/** Hash navigation keeps static hosting paths and portfolio query parameters intact. */
export function useView(): readonly [ViewId, (id: ViewId) => void] {
  const [view, setView] = useState(() => parseView(window.location.hash));
  useEffect(() => {
    const sync = () => setView(parseView(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const navigate = useCallback((id: ViewId) => {
    window.location.hash = viewHref(id);
    setView(id);
  }, []);
  return [view, navigate];
}
