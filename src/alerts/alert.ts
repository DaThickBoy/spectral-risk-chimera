/**
 * Alert records (tasks 16.2 and 16.3; design: Alerts; R19.2, R19.3, R34.1,
 * R18.6, R14.13).
 *
 * `buildVarAlert` turns a fired transition into the alert content: identifier,
 * type `VAR`, source, portfolio, severity, metric name, observed value and
 * threshold (Canonical Decimal Strings, percent of NAV), timestamp, the
 * triggering tickers of the adjustment where applicable, and a description.
 * The description calls VaR a percentile-based loss estimate and never a
 * drawdown or a maximum loss (R14.13, R18.6).
 */
import { d, toCanonical } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';
import type { AlertSeverity, VarEvaluation } from './evaluator.js';

export type AlertType = 'VAR' | 'FILING_RISK';

/** Alert content; delivery and dismissal state are kept by the app layer. */
export interface AlertContent {
  readonly id: string;
  readonly type: AlertType;
  readonly source: string;
  readonly portfolioId: string;
  /** `null` for portfolio-level alerts (VaR). */
  readonly ticker: string | null;
  readonly severity: AlertSeverity;
  readonly metric: string;
  readonly observed: DecimalString;
  readonly threshold: DecimalString;
  readonly triggeredTickers: readonly string[];
  readonly createdAt: string;
  readonly description: string;
}

/** Source of VaR alerts: the evaluator of task 16.1. */
export const VAR_ALERT_SOURCE = 'var-alert-evaluator';

const METRIC_NAME = { ADJUSTED: 'ADJUSTED_VAR_PCT_NAV', BASE: 'BASE_VAR_PCT_NAV' } as const;
const METRIC_LABEL = { ADJUSTED: 'Sentiment-Adjusted VaR', BASE: 'Base VaR' } as const;

function confidenceLabel(confidence: DecimalString | null): string {
  return confidence === null ? '' : `, ${toCanonical(d(confidence).times(100))}% confidence`;
}

export function buildVarAlert(
  evaluation: Extract<VarEvaluation, { kind: 'EVALUATED' }>,
  fired: { readonly severity: AlertSeverity; readonly kind: 'NEW' | 'ESCALATION' },
  id: string,
  createdAt: string,
): AlertContent {
  const label = METRIC_LABEL[evaluation.metric];
  const escalation = fired.kind === 'ESCALATION' ? ' (escalated)' : '';
  return {
    id,
    type: 'VAR',
    source: VAR_ALERT_SOURCE,
    portfolioId: evaluation.portfolioId,
    ticker: null,
    severity: fired.severity,
    metric: METRIC_NAME[evaluation.metric],
    observed: evaluation.observedPct,
    threshold: evaluation.settings.thresholdPct,
    triggeredTickers: evaluation.triggeredTickers,
    createdAt,
    description:
      `${fired.severity}${escalation}: ${label} (1 day${confidenceLabel(evaluation.confidence)}) is ` +
      `${evaluation.observedPct}% of NAV, above the ${evaluation.settings.thresholdPct}% threshold. ` +
      'VaR is a percentile-based loss estimate, not a maximum loss or drawdown.',
  };
}
