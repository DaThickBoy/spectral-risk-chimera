/**
 * Guided judge tour (ui-guidelines §8). Six short steps, each shown inline above the section it
 * explains. Every figure quoted here is the backend's display text, passed through the same
 * formatters the panels use; nothing is computed, rounded, or invented. Wording follows the
 * glossary (`glossary.ts`) and describes the recorded replay as a recorded DEMO replay, never as
 * a live service.
 */
import type { DashboardViewResponse } from '../shared/apiContracts/index.js';
import type { SourceInfo } from './data/source.js';
import { codeLabel, confidencePct, utcText, withUnit } from './format.js';

/** The section a step is shown above. */
export type TourAnchor = 'summary' | 'panels' | 'positions' | 'loss';

export interface TourStep {
  readonly anchor: TourAnchor;
  readonly title: string;
  readonly body: readonly string[];
}

function portfolioStep(data: DashboardViewResponse, source: SourceInfo | undefined): TourStep {
  const identity = `portfolio ${data.portfolioId} (base currency ${data.view.baseCurrency})`;
  const demo = data.dataMode === 'DEMO';
  const body =
    source?.kind === 'REPLAY'
      ? [
          `You are viewing ${identity} in a recorded ${demo ? 'DEMO ' : ''}replay: responses the real backend produced${demo ? ' from deterministic fixture data' : ''}, recorded ${utcText(source.recordedAt ?? null)}.`,
          'It is not live data, and nothing is recalculated in your browser.',
        ]
      : [
          `You are viewing ${identity} from the local backend.`,
          ...(demo ? ['Its data mode is DEMO: fixture data, not market data.'] : []),
        ];
  return { anchor: 'summary', title: 'The portfolio', body };
}

function navStep(data: DashboardViewResponse): TourStep {
  const currency = data.display.currency;
  const nav = data.display.exposure.nav;
  return {
    anchor: 'summary',
    title: 'NAV',
    body: [
      nav === null
        ? 'NAV is unavailable here. It is shown as "—", which means no valid value exists; it is not zero.'
        : `NAV is ${withUnit(nav, currency)}: net exposure plus cash, in ${currency}.`,
      'The backend calculates it from the latest prices and the FX rates listed under "FX rates used".',
    ],
  };
}

function baseVarStep(data: DashboardViewResponse): TourStep {
  const base = data.view.baseVaR;
  const confidence = confidencePct(data.view.confidence);
  return {
    anchor: 'panels',
    title: 'Base VaR',
    body: [
      base.value === null
        ? `Base VaR is unavailable: ${codeLabel(base.reason.code ?? base.status)}. No figure is shown in its place.`
        : `Base VaR is ${withUnit(data.display.baseVaR, data.display.currency)} at ${confidence} confidence over 1 trading day.`,
      'It comes from historical simulation: past daily returns are applied to the current positions, and the figure is a loss level that the simulated losses exceed only rarely.',
      'It is a percentile estimate, not the worst possible loss and not a maximum drawdown. FX rates are held constant across the scenarios.',
    ],
  };
}

const CHARTS_STEP: TourStep = {
  anchor: 'positions',
  title: 'Allocation and currency exposure',
  body: [
    "Each numbered segment of the allocation bar is a position's share as reported by the backend, on a fixed 0–100 % axis. Any unfilled part is not a listed position.",
    "Further down, the currency exposure bars run from 0 to the backend's gross exposure. An outlined bar is a negative value.",
    'The bars are a visual aid. The exact values are in the tables next to them.',
  ],
};

function lossStep(data: DashboardViewResponse): TourStep {
  return {
    anchor: 'loss',
    title: 'Loss distribution and the VaR marker',
    body: [
      'The histogram groups the same one-day scenario losses behind Base VaR into equal-width buckets. Negative losses are gains.',
      `The dashed marker is the raw ${confidencePct(data.view.confidence)} quantile, and the summary next to or below the chart states how many scenarios lost more.`,
      '"Exact values and bucket table" opens the exact raw quantile and every bucket\'s exact edges and counts.',
    ],
  };
}

function limitsStep(data: DashboardViewResponse): TourStep {
  const adjusted = data.view.sentimentAdjustedVaR;
  const decision = data.adjustedVaRAvailability.openDecision;
  return {
    anchor: 'panels',
    title: 'Unavailable and DEMO',
    body: [
      adjusted.value === null
        ? `Sentiment-Adjusted VaR is unavailable${decision === null ? '' : `: no sentiment aggregation method is approved yet (open decision ${decision})`}. DEMO sentiment is shown for information and never used in a calculation.`
        : `Sentiment-Adjusted VaR is ${withUnit(data.display.adjustedVaR, data.display.currency)}.`,
      data.filing.status === 'NOT_CONFIGURED'
        ? 'SEC filing risk is not configured in this demonstration, so no filing score exists.'
        : `SEC filing risk status: ${codeLabel(data.filing.status)}.`,
      'DEMO marks fixture data, never market data, and DEMO results never raise alerts. "—" means no valid value exists; it is never zero.',
    ],
  };
}

/** The tour for the shown view. Pure: the same view and source give the same steps. */
export function tourSteps(data: DashboardViewResponse, source: SourceInfo | undefined): readonly TourStep[] {
  return [
    portfolioStep(data, source),
    navStep(data),
    baseVarStep(data),
    CHARTS_STEP,
    lossStep(data),
    limitsStep(data),
  ];
}
