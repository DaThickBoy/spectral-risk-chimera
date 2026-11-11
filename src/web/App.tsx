// Dashboard shell (tasks 17.2, 17.3): loads the portfolio list and one portfolio view through the
// injected data source (live backend or recorded replay), and shows loading, error, and data
// states. Reload is manual: there is no polling and no background retrieval.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { DashboardIndexResponse, DashboardViewResponse } from '../shared/apiContracts/index.js';
import { AllocationChart } from './components/AllocationChart.tsx';
import { LossDistributionSection } from './components/LossDistribution.tsx';
import { AdjustedVarPanel, BaseVarPanel, FilingPanel, SentimentPanel } from './components/Panels.tsx';
import { CurrencyExposureSection, FxSection, PositionsSection } from './components/Sections.tsx';
import { SummarySection } from './components/Summary.tsx';
import { TopBar } from './components/TopBar.tsx';
import { TourCard } from './components/TourCard.tsx';
import { tourSteps } from './tour.js';
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
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0); // a reload counter, not a financial value

  useEffect(() => {
    let active = true;
    void (async () => {
      const [loadedInfo, loadedIndex] = await Promise.all([source.info(), source.index()]);
      if (!active) return;
      if (loadedInfo.ok) setInfo(loadedInfo.value);
      if (!loadedIndex.ok) {
        setIndexError(loadedIndex.error);
        setView({ status: 'error', error: loadedIndex.error });
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
      if (loadedIndex.value.portfolios.length === 0) {
        setView({ status: 'error', error: 'NOT_FOUND' });
      }
    })();
    return () => {
      active = false;
    };
  }, [source, generation]);

  useEffect(() => {
    if (selected === undefined) return;
    let active = true;
    setView({ status: 'loading' });
    void source.view(selected).then((loaded) => {
      if (!active) return;
      setView(loaded.ok ? { status: 'ready', data: loaded.value } : { status: 'error', error: loaded.error });
    });
    return () => {
      active = false;
    };
  }, [source, selected, generation]);

  // Task 17.4, LIVE mode only: stream-driven refreshes of the shown view. The static replay
  // never creates live updates. A refresh replaces the view in place (no loading state); a
  // failed one keeps the previous view and is shown in the top bar.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [live, setLive] = useState<LiveUpdates | undefined>(undefined);
  const [refreshError, setRefreshError] = useState<LoadError | undefined>(undefined);
  useEffect(() => {
    if (source.kind !== 'LIVE' || liveUpdates === undefined) return;
    const updates = liveUpdates({
      selected: () => selectedRef.current,
      refresh: async (portfolioId) => {
        const loaded = await source.view(portfolioId);
        if (selectedRef.current !== portfolioId) return; // the user moved on
        if (loaded.ok) {
          setRefreshError(undefined);
          setView({ status: 'ready', data: loaded.value });
        } else {
          setRefreshError(loaded.error);
        }
      },
    });
    setLive(updates);
    updates.start();
    return () => {
      updates.stop();
      setLive(undefined);
    };
  }, [source, liveUpdates]);

  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  const data = view.status === 'ready' ? view.data : undefined;

  // Guided tour (ui-guidelines §8): user-started, non-modal, one inline card above its section.
  const [tourIndex, setTourIndex] = useState<number | null>(null); // a step position, not a financial value
  const steps = data === undefined ? [] : tourSteps(data, info);
  const current = tourIndex === null ? undefined : steps[tourIndex];
  const endTour = useCallback(() => {
    setTourIndex(null);
    document.getElementById('tour-start')?.focus();
  }, []);
  const toggleTour = useCallback(() => setTourIndex((i) => (i === null ? 0 : null)), []);
  const tourAt = (anchor: TourAnchor): ReactElement | null =>
    current === undefined || tourIndex === null || current.anchor !== anchor ? null : (
      <TourCard
        step={current}
        index={tourIndex}
        count={steps.length}
        onBack={() => setTourIndex((i) => (i === null || i === 0 ? i : i - 1))}
        onNext={() => setTourIndex((i) => (i === null || i >= steps.length - 1 ? i : i + 1))}
        onEnd={endTour}
      />
    );

  return (
    <LiveContext.Provider value={live}>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to risk panels
        </a>
        <TopBar
          source={info}
          index={index}
          selected={selected}
          onSelect={setSelected}
          onReload={reload}
          data={data}
          refreshError={refreshError}
          onTour={toggleTour}
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
              {tourAt('summary')}
              <SummarySection data={data} />
              {data.dataMode === 'DEMO' ? (
                <p className="demo-banner" role="note">
                  DEMO DATA: prices and history are deterministic fixtures, not market data. Results are
                  labelled DEMO_DATA and never raise alerts.
                </p>
              ) : null}
              {/* Fintech redesign (ui-guidelines §3): KPI cards, then the main visualisations
                  (loss distribution beside allocation), then the four separate risk-dimension
                  cards, then positions, currency, and FX. Group labels are plain text, outside
                  the heading outline; each tour card stays directly above what it explains. */}
              <p className="eyebrow">Risk visualisation</p>
              {tourAt('charts')}
              <div className="viz-grid" data-testid="viz-grid">
                <LossDistributionSection data={data} />
                <section className="section viz-allocation" aria-labelledby="allocation-heading">
                  <h2 id="allocation-heading">Allocation</h2>
                  <AllocationChart data={data} />
                </section>
              </div>
              <p className="eyebrow">Risk signals</p>
              {tourAt('panels')}
              <div className="panels">
                <BaseVarPanel data={data} />
                <AdjustedVarPanel data={data} />
                <SentimentPanel data={data} />
                <FilingPanel data={data} />
              </div>
              <p className="eyebrow">Portfolio</p>
              <PositionsSection data={data} />
              <p className="eyebrow">Currency and FX</p>
              {/* Full width: at half width the exact FX rates wrap into unreadable columns. */}
              <CurrencyExposureSection data={data} />
              <FxSection data={data} />
            </>
          ) : null}
        </main>
      </div>
    </LiveContext.Provider>
  );
}
