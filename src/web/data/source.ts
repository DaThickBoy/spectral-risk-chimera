/**
 * Dashboard data sources (tasks 17.2, 17.3; DR-KW-1 H4). The dashboard reads data only
 * through `DashboardDataSource`, so the same build renders either
 * - `LIVE`: the read-only backend routes `GET /dashboard` and
 *   `GET /dashboard/portfolios/:id` (local demo; the backend stays on loopback), or
 * - `REPLAY`: recorded responses of exactly those routes, stored as static files next
 *   to the build (`manifest.json` plus one file per portfolio) for GitHub Pages.
 *
 * Both issue GET requests only and have no write method. Every body is validated with
 * the shared API contracts before use; an invalid body is `INVALID_RESPONSE`, never
 * repaired. No financial value is computed here. No credential is sent or stored.
 * DOM-free (only `fetch`), so a Node test can drive it with recorded backend bodies.
 */
import {
  DashboardIndexResponseSchema,
  DashboardReplayManifestSchema,
  DashboardViewResponseSchema,
} from '../../shared/apiContracts/index.js';
import type {
  DashboardIndexResponse,
  DashboardReplayManifest,
  DashboardViewResponse,
} from '../../shared/apiContracts/index.js';

export type LoadError = 'NETWORK' | 'NOT_FOUND' | 'HTTP_ERROR' | 'INVALID_RESPONSE';

export type Loaded<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: LoadError };

export interface SourceInfo {
  readonly kind: 'LIVE' | 'REPLAY';
  /** Replay only: when the responses were recorded, and the replay note. */
  readonly recordedAt?: string;
  readonly note?: string;
}

export interface DashboardDataSource {
  readonly kind: 'LIVE' | 'REPLAY';
  info(): Promise<Loaded<SourceInfo>>;
  index(): Promise<Loaded<DashboardIndexResponse>>;
  view(portfolioId: string): Promise<Loaded<DashboardViewResponse>>;
}

export type Fetch = (
  url: string,
  init: { readonly method: 'GET'; readonly headers: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

const PORTFOLIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function getJson(fetchFn: Fetch, url: string): Promise<Loaded<unknown>> {
  let response: Awaited<ReturnType<Fetch>>;
  try {
    response = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
  if (response.status === 404) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  if (!response.ok) {
    return { ok: false, error: 'HTTP_ERROR' };
  }
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, error: 'INVALID_RESPONSE' };
  }
}

function validated<T>(
  loaded: Loaded<unknown>,
  parse: (value: unknown) => { success: boolean; data?: T },
): Loaded<T> {
  if (!loaded.ok) {
    return loaded;
  }
  const parsed = parse(loaded.value);
  return parsed.success && parsed.data !== undefined
    ? { ok: true, value: parsed.data }
    : { ok: false, error: 'INVALID_RESPONSE' };
}

const trimSlash = (base: string): string => base.replace(/\/+$/, '');

/** The read-only backend routes (local demo). */
export function createLiveSource(fetchFn: Fetch, baseUrl = ''): DashboardDataSource {
  const base = trimSlash(baseUrl);
  return {
    kind: 'LIVE',
    info: () => Promise.resolve({ ok: true, value: { kind: 'LIVE' } }),
    index: async () =>
      validated(await getJson(fetchFn, `${base}/dashboard`), (v) =>
        DashboardIndexResponseSchema.safeParse(v),
      ),
    view: async (portfolioId) => {
      if (!PORTFOLIO_ID.test(portfolioId)) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      return validated(await getJson(fetchFn, `${base}/dashboard/portfolios/${portfolioId}`), (v) =>
        DashboardViewResponseSchema.safeParse(v),
      );
    },
  };
}

/** Recorded responses (static replay): `manifest.json` and the files it names. */
export function createReplaySource(fetchFn: Fetch, baseUrl = './replay'): DashboardDataSource {
  const base = trimSlash(baseUrl);
  let manifest: Promise<Loaded<DashboardReplayManifest>> | undefined;
  const loadManifest = (): Promise<Loaded<DashboardReplayManifest>> => {
    manifest ??= getJson(fetchFn, `${base}/manifest.json`).then((loaded) =>
      validated(loaded, (v) => DashboardReplayManifestSchema.safeParse(v)),
    );
    return manifest;
  };
  return {
    kind: 'REPLAY',
    info: async () => {
      const loaded = await loadManifest();
      return loaded.ok
        ? {
            ok: true,
            value: { kind: 'REPLAY', recordedAt: loaded.value.recordedAt, note: loaded.value.note },
          }
        : loaded;
    },
    index: async () => {
      const loaded = await loadManifest();
      return loaded.ok ? { ok: true, value: loaded.value.index } : loaded;
    },
    view: async (portfolioId) => {
      const loaded = await loadManifest();
      if (!loaded.ok) {
        return loaded;
      }
      const file = loaded.value.views[portfolioId];
      if (file === undefined) {
        return { ok: false, error: 'NOT_FOUND' };
      }
      const view = validated(await getJson(fetchFn, `${base}/${file}`), (v) =>
        DashboardViewResponseSchema.safeParse(v),
      );
      // A recorded file must belong to the portfolio it is listed for.
      return view.ok && view.value.portfolioId !== portfolioId
        ? { ok: false, error: 'INVALID_RESPONSE' }
        : view;
    },
  };
}
