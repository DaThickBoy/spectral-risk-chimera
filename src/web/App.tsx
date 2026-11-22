import { ReplayContext } from './components/Badge.tsx';
// Dashboard shell (tasks 17.2, 17.3): loads the portfolio list and one portfolio view through the
// injected data source (live backend or recorded replay), and shows loading, error, and data
// states. Reload is manual: there is no polling and no background retrieval.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { DashboardIndexResponse, DashboardViewResponse } from '../shared/apiContracts/index.js';
import { AllocationChart } from './components/AllocationChart.tsx';
import { LossDistributionSection } from './components/LossDistribution.tsx';
import { AdjustedVarPanel, BaseVarPanel, FilingPanel, SentimentPanel } from './components/Panels.tsx';
import { CurrencyExposureSection, FxSection, PositionsSection } from './components/Sections.tsx';
import { SummarySection } from './components/Summary.tsx';
import { TopBar } from './components/TopBar.tsx';
import { TourCard } from './components/TourCard.tsx';
import './shell.css';
import { useView, viewHref } from './router.js';
import { tourSteps, tourView } from './tour.js';
import type { TourAnchor } from './tour.js';
import type { LiveUpdateFactory, LiveUpdates } from './data/liveUpdates.js';
import type { DashboardDataSource, LoadError, SourceInfo } from './data/source.js';
import { LiveContext } from './live.tsx';

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: LoadError }
  | { readonly status: 'ready'; readonly data: DashboardViewResponse };

const ERROR_TEXT: Readonly<Record<'LIVE' | 'REPLAY', Readonly<Record<LoadError, string>>>> = {
  LIVE: {
    NETWORK:
      'The data could not be reached. Check that the local demo backend is running (npm start -- --demo-fixtures).',
    NOT_FOUND:
      'No data was found for this portfolio. In the live demo, a portfolio appears after its first calculation.',
    HTTP_ERROR: 'The local demo backend answered with an error.',
    INVALID_RESPONSE: 'The data did not match the dashboard contract and was not shown.',
  },
  REPLAY: {
    NETWORK: 'The recorded replay files could not be loaded. Check the connection and reload the page.',
    NOT_FOUND: 'The recorded replay files were not found next to this page, so nothing can be shown.',
    HTTP_ERROR: 'The recorded replay files could not be loaded (the server answered with an error).',
    INVALID_RESPONSE:
      'The recorded replay is incomplete or does not match the dashboard contract, so it was not shown.',
  },
};

/** Optional URL state (`?portfolio=<id>`): deep links, back and forward. Absent in tests. */
export interface UrlState {
  read(): string | undefined;
  write(portfolioId: string): void;
  subscribe(onChange: () => void): () => void;
}

export function App({
  source,
  url,
  liveUpdates,
}: {
  readonly source: DashboardDataSource;
  readonly url?: UrlState;
  /** LIVE mode only (task 17.4): creates the stream-driven updates. Ignored for the replay. */
  readonly liveUpdates?: LiveUpdateFactory;
}): ReactElement {
  const [route, navigate] = useView();
  const [collapsed, setCollapsed] = useState(false);
  const [info, setInfo] = useState<SourceInfo | undefined>(undefined);
  const [index, setIndex] = useState<DashboardIndexResponse | undefined>(undefined);
  const [indexError, setIndexError] = useState<LoadError | undefined>(undefined);
  const [selected, setSelectedState] = useState<string | undefined>(() => url?.read());

  const setSelected = useCallback(
    (id: string) => {
      setSelectedState(id);
      url?.write(id);
    },
    [url],
  );

  // Back and forward restore the portfolio named in the URL; without one, the first listed.
  const indexRef = useRef<DashboardIndexResponse | undefined>(undefined);
  indexRef.current = index;
  useEffect(
    () =>
      url?.subscribe(() => {
        const named = url.read();
        const listed = indexRef.current?.portfolios ?? [];
        setSelectedState(named !== undefined && listed.some((p) => p.id === named) ? named : listed[0]?.id);
      }),
    [url],
  );
  const [generation, setGeneration] = useState(0); // a reload counter, not a financial value
  const request = useMemo(() => ({ source, selected, generation }), [source, selected, generation]);
  const requestRef = useRef(request);
  requestRef.current = request;
  const [result, setResult] = useState<{ request: typeof request; view: ViewState }>();
  const view: ViewState =
    indexError !== undefined
      ? { status: 'error', error: indexError }
      : index?.portfolios.length === 0
        ? { status: 'error', error: 'NOT_FOUND' }
        : result?.request === request
          ? result.view
          : { status: 'loading' };
  const foreground = useRef<typeof request | undefined>(undefined);
  const pending = useRef<{ request: typeof request; refresh: () => Promise<void> } | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [loadedInfo, loadedIndex] = await Promise.all([source.info(), source.index()]);
      if (!active) return;
      if (loadedInfo.ok) setInfo(loadedInfo.value);
      if (!loadedIndex.ok) {
        setIndexError(loadedIndex.error);
        return;
      }
      setIndexError(undefined);
      setIndex(loadedIndex.value);
      // A portfolio named in the URL is kept only if the index lists it.
      setSelectedState((current) =>
        current !== undefined && loadedIndex.value.portfolios.some((p) => p.id === current)
          ? current
          : loadedIndex.value.portfolios[0]?.id,
      );
    })();
    return () => {
      active = false;
    };
  }, [source, generation]);

  useEffect(() => {
    if (request.selected === undefined) return;
    let active = true;
    foreground.current = request;
    void request.source.view(request.selected).then((loaded) => {
      if (!active || requestRef.current !== request) return;
      foreground.current = undefined;
      setResult({
        request,
        view: loaded.ok ? { status: 'ready', data: loaded.value } : { status: 'error', error: loaded.error },
      });
      if (pending.current?.request === request) {
        const { refresh } = pending.current;
        pending.current = undefined;
        void refresh();
      }
    });
    return () => {
      active = false;
      if (foreground.current === request) foreground.current = undefined;
      if (pending.current?.request === request) pending.current = undefined;
    };
  }, [request]);

  // Task 17.4, LIVE mode only: stream-driven refreshes of the shown view. The static replay
  // never creates live updates. A refresh replaces the view in place (no loading state); a
  // failed one keeps the previous view and is shown in the top bar.
  const [live, setLive] = useState<LiveUpdates | undefined>(undefined);
  const [refreshFailure, setRefreshFailure] = useState<{ request: typeof request; error: LoadError }>();
  const refreshError = refreshFailure?.request === request ? refreshFailure.error : undefined;
  useEffect(() => {
    if (source.kind !== 'LIVE' || liveUpdates === undefined) return;
    let active = true;
    let sequence = 0;
    const updates = liveUpdates({
      selected: () => requestRef.current.selected,
      refresh: async function refreshPortfolio(portfolioId) {
        const target = requestRef.current;
        if (!active || target.source !== source || target.selected !== portfolioId) return;
        if (foreground.current === target) {
          pending.current = { request: target, refresh: () => refreshPortfolio(portfolioId) };
          return;
        }
        const refresh = ++sequence;
        const loaded = await source.view(portfolioId);
        if (!active || refresh !== sequence || requestRef.current !== target) return;
        if (loaded.ok) {
          setRefreshFailure(undefined);
          setResult({ request: target, view: { status: 'ready', data: loaded.value } });
        } else {
          setRefreshFailure({ request: target, error: loaded.error });
        }
      },
    });
    setLive(updates);
    updates.start();
    return () => {
      active = false;
      updates.stop();
      setLive(undefined);
    };
  }, [source, liveUpdates]);

  const reload = useCallback(() => {
    setIndexError(undefined);
    setGeneration((n) => n + 1);
  }, []);
  const data = view.status === 'ready' ? view.data : undefined;

  // Guided tour (ui-guidelines §8): user-started, non-modal, one inline card above its section.
  const [tourIndex, setTourIndex] = useState<number | null>(null); // a step position, not a financial value
  const steps = data === undefined ? [] : tourSteps(data, info);
  const current = tourIndex === null ? undefined : steps[tourIndex];
  const endTour = useCallback(() => {
    setTourIndex(null);
    document.getElementById('tour-start')?.focus();
  }, []);
  const goToStep = (index: number) => {
    const step = steps[index];
    if (step === undefined) return;
    setTourIndex(index);
    navigate(tourView(step.anchor));
  };
  const previousRoute = useRef(route);
  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    if (current !== undefined && tourView(current.anchor) === route) return;
    setTourIndex(null);
    document.getElementById(`view-${route}-title`)?.focus();
  }, [route, current]);
  const tourAt = (anchor: TourAnchor): ReactElement | null =>
    current === undefined ||
    tourIndex === null ||
    current.anchor !== anchor ||
    tourView(anchor) !== route ? null : (
      <TourCard
        step={current}
        index={tourIndex}
        count={steps.length}
        onBack={() => goToStep(tourIndex - 1)}
        onNext={() => goToStep(tourIndex + 1)}
        onEnd={endTour}
      />
    );

  const dashboard = (
    <LiveContext.Provider value={live}>
      <div className="app workspace" data-sidebar-collapsed={collapsed}>
        <a
          className="skip-link"
          href="#main"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('main')?.focus();
          }}
        >
          Skip to risk panels
        </a>
        <TopBar
          view={route}
          collapsed={collapsed}
          onCollapse={() => setCollapsed((value) => !value)}
          source={info}
          index={index}
          selected={selected}
          onSelect={setSelected}
          onReload={reload}
          data={data}
          refreshError={refreshError}
          onTour={current === undefined ? () => goToStep(0) : endTour}
          tourActive={current !== undefined}
        />
        {/* tabIndex -1: the skip link moves keyboard focus here, not only the scroll position. */}
        <main id="main" tabIndex={-1} aria-busy={view.status === 'loading'}>
          {view.status === 'loading' ? (
            <div className="state state-loading" role="status">
              Loading portfolio data…
            </div>
          ) : null}
          {view.status === 'error' ? (
            <div className="state state-error" role="alert">
              <p>
                <strong>
                  {indexError === undefined ? 'Portfolio data unavailable' : 'Dashboard data unavailable'}
                </strong>
              </p>
              <p>{ERROR_TEXT[source.kind][view.error]}</p>
              <button type="button" onClick={reload}>
                Try again
              </button>
            </div>
          ) : null}
          {data !== undefined ? (
            <>
              {route === 'overview' ? (
                <>
                  {tourAt('summary')}
                  <SummarySection data={data} />
                </>
              ) : null}
              {data.dataMode === 'DEMO' ? (
                <p className="demo-banner" role="note">
                  DEMO DATA: prices and history are deterministic fixtures, not market data. Results are
                  labelled DEMO_DATA and never raise alerts.
                </p>
              ) : null}
              {route === 'overview' ? (
                <div className="viz-grid" data-testid="viz-grid">
                  <div className="workspace-preview">
                    <LossDistributionSection data={data} compact />
                    <a href={viewHref('risk')}>Open Risk Analytics</a>
                  </div>
                  <div className="workspace-preview">
                    <section className="section viz-allocation" aria-labelledby="allocation-heading">
                      <h2 id="allocation-heading">Allocation</h2>
                      <AllocationChart data={data} />
                    </section>
                    <a href={viewHref('portfolio')}>Open Portfolio</a>
                  </div>
                </div>
              ) : null}
              {route === 'risk' ? (
                <>
                  {tourAt('charts')}
                  <LossDistributionSection data={data} />
                </>
              ) : null}
              {route === 'portfolio' ? (
                <>
                  {tourAt('allocation')}
                  <section className="section viz-allocation" aria-labelledby="allocation-heading">
                    <h2 id="allocation-heading">Allocation</h2>
                    <AllocationChart data={data} />
                  </section>
                  <PositionsSection data={data} />
                  <CurrencyExposureSection data={data} />
                </>
              ) : null}
              {route === 'signals' ? (
                <>
                  {tourAt('panels')}
                  <div className="panels">
                    <BaseVarPanel data={data} />
                    <AdjustedVarPanel data={data} />
                    <SentimentPanel data={data} />
                    <FilingPanel data={data} />
                  </div>
                </>
              ) : null}
              {route === 'fx' ? <FxSection data={data} /> : null}
            </>
          ) : null}
        </main>
      </div>
    </LiveContext.Provider>
  );
  return <ReplayContext value={source.kind === 'REPLAY'}>{dashboard}</ReplayContext>;
}
