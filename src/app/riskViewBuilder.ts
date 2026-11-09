/**
 * Dashboard view model builder (task 17.1; design: View models (signal
 * separation); R11.6, R11.7, R17.1 to R17.4, R17.6 to R17.10, R35.2, R35.3,
 * R35.6; Property 12).
 *
 * Pure: it combines results other services already computed and recomputes
 * none of them. Inputs are the stored risk view (12.6) with its adjustment
 * detail, the positions and allocation responses (11.1, 11.4, 11.5), and the
 * sentiment state's per-ticker view (13.3).
 *
 * - Base VaR and Adjusted VaR stay two `VarView` entries with their own
 *   validity, status, reason (missing keys, ineligible tickers, reason code),
 *   and labelled last valid figure. The Base figure is never copied into the
 *   Adjusted entry (R17.10, R35.6).
 * - `varDifference` is Adjusted minus Base absolute VaR, computed with Decimal
 *   only when both figures are present; otherwise `null`.
 * - `adjustmentExplanation` states which positions triggered the adjustment,
 *   that none did, or why Adjusted VaR is unavailable.
 * - Per asset, `sentiment` and `filing` are separate objects. Sentiment shows
 *   the aggregated REAL index, or else the latest observation with its source
 *   kind (DEMO stays labelled). Filing is `UNAVAILABLE` with a `null` score
 *   for every asset until the filing pipeline (phase 7) exists; this builder
 *   has no filing input, so nothing can derive from both signals.
 * - Price fields and provenance come from the positions response unchanged;
 *   `lastValidPrice` is the display-only 11.5 value and feeds nothing.
 * - Exposure figures are `null` with `EXPOSURE_UNAVAILABLE` when valuation is
 *   incomplete; never `"0"`.
 * The output is validated with the shared `PortfolioRiskViewSchema`.
 */
import type { SentimentView } from '../sentiment/index.js';
import { PortfolioRiskViewSchema, d, toCanonical } from '../shared/index.js';
import type {
  AllocationResponse,
  AssetRiskRow,
  DecimalString,
  PortfolioRiskView,
  PositionsResponse,
  VarView,
} from '../shared/index.js';
import type { AdjustmentDetail, RiskView, VarEntry } from './riskService.js';

export interface RiskViewParts {
  readonly risk: RiskView;
  readonly adjustment: AdjustmentDetail;
  readonly positions: PositionsResponse;
  readonly allocation: AllocationResponse;
  /** The 13.3 sentiment state view of one ticker. */
  readonly sentiment: (ticker: string) => SentimentView;
  /**
   * Whether a sentiment aggregator is assembled. `NOT_APPROVED` (no aggregator: OD-1
   * has no approved formula) makes every unavailable Adjusted VaR explanation start
   * with that reason (DR-KW-1 H7). Absent: the explanation is unchanged.
   */
  readonly sentimentAggregation?: 'NOT_APPROVED' | 'INJECTED';
}

/** DR-KW-1 H7: the explicit OD-1 reason for an unavailable Adjusted VaR. */
export const AGGREGATION_NOT_APPROVED_EXPLANATION =
  'No sentiment aggregation method is approved (open decision OD-1), so no sentiment index can be current and Adjusted VaR is not calculated.';

const canonical = (text: string): DecimalString => toCanonical(d(text));

function varView(entry: VarEntry, ineligible: AdjustmentDetail['ineligible']): VarView {
  return {
    validity: entry.validity,
    value: entry.value === null ? null : { ...entry.value },
    status: entry.status,
    reason: {
      missingConfigKeys: [...entry.missingKeys],
      ineligibleTickers: ineligible.map((item) => ({
        ticker: item.ticker,
        sentimentStatus: item.sentimentStatus,
      })),
      code: entry.reason,
    },
    lastValid:
      entry.lastValid === null
        ? null
        : { value: { ...entry.lastValid.value }, calculatedAt: entry.lastValid.calculatedAt },
  };
}

function explanation(risk: RiskView, adjustment: AdjustmentDetail): string {
  const status = risk.adjustedVaR.status;
  switch (status) {
    case 'APPLIED': {
      const assets = [...adjustment.triggeredAssets]
        .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
        .map(
          (a) =>
            `${a.ticker} (${a.direction}, effective sentiment ${canonical(a.effectiveSentiment)}, multiplier ${canonical(a.multiplier)})`,
        );
      return `Downside adjustment applied to ${assets.join(', ')}: their bearish sentiment is below the threshold.`;
    }
    case 'NONE_TRIGGERED':
      return 'No position met the bearish sentiment trigger, so no downside adjustment was applied.';
    case 'ADJUSTMENT_CONFIG_MISSING':
      return `Unavailable: adjustment settings are missing (${risk.adjustedVaR.missingKeys.join(', ')}).`;
    case 'SENTIMENT_NOT_CURRENT':
      return `Unavailable: sentiment is not current for ${adjustment.ineligible
        .map((item) => `${item.ticker} (${item.sentimentStatus})`)
        .join(', ')}.`;
    case 'BASE_UNAVAILABLE':
      return `Unavailable: Base VaR is unavailable (${risk.status}).`;
    default:
      // A CalcStatus never appears as the adjusted status; keep the view truthful anyway.
      return `Unavailable: ${status}.`;
  }
}

/** Prefixes the OD-1 reason to every unavailable Adjusted VaR when no aggregator is approved. */
function withAggregationReason(
  text: string,
  risk: RiskView,
  aggregation: RiskViewParts['sentimentAggregation'],
): string {
  const status = risk.adjustedVaR.status;
  if (aggregation !== 'NOT_APPROVED' || status === 'APPLIED' || status === 'NONE_TRIGGERED') {
    return text;
  }
  return `${AGGREGATION_NOT_APPROVED_EXPLANATION} ${text}`;
}

function sentimentOf(view: SentimentView): AssetRiskRow['sentiment'] {
  if (view.index !== null) {
    return {
      value: canonical(view.index.value),
      status: view.index.status,
      sourceKind: 'REAL',
      observedAt: view.index.observedAt,
      basis: 'INDEX',
    };
  }
  if (view.latest !== null) {
    return {
      value: canonical(view.latest.value),
      status: view.latest.status,
      sourceKind: view.latest.sourceKind,
      observedAt: view.latest.observedAt,
      basis: 'LATEST_OBSERVATION',
    };
  }
  return { value: null, status: 'UNAVAILABLE', sourceKind: null, observedAt: null, basis: 'NONE' };
}

const FILING_UNAVAILABLE: AssetRiskRow['filing'] = {
  score: null,
  status: 'UNAVAILABLE',
  filingDate: null,
  sourceKind: null,
};

export function buildPortfolioRiskView(parts: RiskViewParts): PortfolioRiskView {
  const { risk, adjustment, positions, allocation } = parts;
  const triggered = new Map(adjustment.triggeredAssets.map((asset) => [asset.ticker, asset]));
  const exposure =
    allocation.exposure.status === 'OK'
      ? {
          status: 'OK' as const,
          nav: allocation.exposure.measures.nav,
          long: allocation.exposure.measures.long,
          short: allocation.exposure.measures.short,
          gross: allocation.exposure.measures.gross,
          net: allocation.exposure.measures.net,
          cash: allocation.exposure.measures.cash,
        }
      : {
          status: 'EXPOSURE_UNAVAILABLE' as const,
          nav: null,
          long: null,
          short: null,
          gross: null,
          net: null,
          cash: allocation.exposure.cash,
        };
  const base = risk.baseVaR.value;
  const adjusted = risk.adjustedVaR.value;
  const assets: AssetRiskRow[] = positions.positions.map((position) => {
    const trigger = triggered.get(position.ticker);
    return {
      ticker: position.ticker,
      currency: position.currency,
      signedQuantity: position.signedQuantity,
      marketPrice: position.marketPrice,
      priceProvenance: position.priceProvenance === null ? null : { ...position.priceProvenance },
      lastValidPrice: position.lastValid === undefined ? null : { ...position.lastValid },
      marketValueBase: position.marketValueBase,
      valuationStatus: position.valuationStatus,
      allocationPct: position.allocationPct,
      sentiment: sentimentOf(parts.sentiment(position.ticker)),
      filing: { ...FILING_UNAVAILABLE },
      adjustment:
        trigger === undefined
          ? { triggered: false, effectiveSentiment: null, direction: null, multiplier: null }
          : {
              triggered: true,
              effectiveSentiment: canonical(trigger.effectiveSentiment),
              direction: trigger.direction,
              multiplier: canonical(trigger.multiplier),
            },
      riskContribution: null,
    };
  });
  return PortfolioRiskViewSchema.parse({
    portfolioId: risk.portfolioId,
    baseCurrency: positions.baseCurrency,
    exposure,
    confidence: risk.confidence === null ? null : canonical(risk.confidence),
    horizonDays: 1,
    baseVaR: varView(risk.baseVaR, []),
    sentimentAdjustedVaR: varView(risk.adjustedVaR, adjustment.ineligible),
    varDifference:
      base !== null && adjusted !== null ? toCanonical(d(adjusted.absolute).minus(d(base.absolute))) : null,
    adjustmentExplanation: withAggregationReason(
      explanation(risk, adjustment),
      risk,
      parts.sentimentAggregation,
    ),
    assets,
    calculation: {
      status: risk.status,
      flags: [...risk.flags],
      missingConfigKeys: [...risk.baseVaR.missingKeys],
      asOfDate: risk.asOfDate,
      calculatedAt: risk.calculatedAt,
    },
  });
}
