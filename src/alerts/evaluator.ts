/**
 * VaR alert evaluator (task 16.1; design: Alerts, evaluation rules; R18.1 to
 * R18.7, R34.2; Property 34). Pure: explicit inputs, explicit output.
 *
 * Order of checks, each ending the evaluation with a recorded skip reason:
 * 1. Settings (`parseVarAlertSettings`): missing or invalid gives
 *    `ALERT_CONFIG_MISSING` with the keys (R18.2). No default is assumed.
 * 1a. A result flagged `DEMO_DATA` is never evaluated: `DEMO_DATA` (R30.11,
 *    R25.4; design: Risk worker and scheduler).
 * 2. The figure named by `alerts.var.metric` (`ADJUSTED` selects the Adjusted
 *    VaR entry, `BASE` the Base VaR entry) must have validity `CURRENT`;
 *    otherwise `FIGURE_NOT_CURRENT` with that entry's validity and status
 *    (R18.7). With `ADJUSTED`, Base VaR is never read, so it can never be a
 *    fallback (AT-ALR-18).
 * 3. `NAV > 0`, otherwise `NAV_NOT_POSITIVE` (R18.5). A CURRENT figure with
 *    `NAV > 0` but no `percentOfNav` is inconsistent input: `FIGURE_INVALID`.
 *
 * Condition (R18.1): `percentOfNav > thresholdPct`, strictly; equality never
 * breaches. `percentOfNav` is the engine's unrounded `absolute / NAV * 100`.
 *
 * Severity (R34.2): `ratio = percentOfNav / thresholdPct`; `WARNING` for
 * `1 < ratio < highRatio`, `HIGH` for `highRatio <= ratio < criticalRatio`,
 * `CRITICAL` for `ratio >= criticalRatio`. Because `thresholdPct > 0`, the band
 * tests are done exactly as `percentOfNav >= highRatio * thresholdPct` (no
 * division rounding at a boundary). The reported `ratio` is the Decimal quotient
 * at the project precision, for display and audit only.
 *
 * A skipped evaluation never reaches the state machine (16.2): it produces no
 * alert, escalation, or re-arm. The app layer audits every skip.
 */
import type { Validity } from '../risk/index.js';
import { DecimalStringSchema, d, toCanonical } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';
import { parseVarAlertSettings } from './settings.js';
import type { VarAlertSettings, VarAlertSettingsInput, VarMetric } from './settings.js';

export type AlertSeverity = 'WARNING' | 'HIGH' | 'CRITICAL';

/** One VaR entry as the risk view exposes it (R13.7, R17.10). */
export interface VarEntryInput {
  readonly validity: Validity;
  readonly status: string;
  readonly value: {
    readonly absolute: DecimalString;
    readonly percentOfNav: DecimalString | null;
  } | null;
}

/** The stored risk view of one portfolio, plus the R15.10 triggering tickers. */
export interface VarAlertInput {
  readonly portfolioId: string;
  readonly calculatedAt: string;
  readonly nav: DecimalString | null;
  readonly confidence: DecimalString | null;
  readonly baseVaR: VarEntryInput;
  readonly adjustedVaR: VarEntryInput;
  /** Triggering instruments of the adjustment (R19.3); sorted by the caller or here. */
  readonly triggeredTickers: readonly string[];
  /** Calculation flags of the result; `DEMO_DATA` is never evaluated (R30.11, R25.4). */
  readonly flags: readonly string[];
}

export type VarSkipReason =
  'ALERT_CONFIG_MISSING' | 'DEMO_DATA' | 'FIGURE_NOT_CURRENT' | 'NAV_NOT_POSITIVE' | 'FIGURE_INVALID';

export type VarEvaluation =
  | {
      readonly kind: 'SKIPPED';
      readonly portfolioId: string;
      readonly reason: VarSkipReason;
      readonly metric: VarMetric | null;
      readonly validity: Validity | null;
      readonly figureStatus: string | null;
      readonly missingKeys: readonly string[];
      readonly invalidKeys: readonly string[];
    }
  | {
      readonly kind: 'EVALUATED';
      readonly portfolioId: string;
      readonly calculatedAt: string;
      readonly metric: VarMetric;
      readonly settings: VarAlertSettings;
      readonly confidence: DecimalString | null;
      readonly absolute: DecimalString;
      readonly observedPct: DecimalString;
      readonly ratio: DecimalString;
      readonly breached: boolean;
      /** `null` when not breached. */
      readonly severity: AlertSeverity | null;
      readonly triggeredTickers: readonly string[];
    };

const isDecimal = (value: unknown): value is DecimalString => DecimalStringSchema.safeParse(value).success;

/** The severity band of `observedPct` against the threshold, or `null` at or below it. */
export function varSeverity(observedPct: DecimalString, settings: VarAlertSettings): AlertSeverity | null {
  const observed = d(observedPct);
  const threshold = d(settings.thresholdPct);
  if (!observed.greaterThan(threshold)) {
    return null;
  }
  if (observed.greaterThanOrEqualTo(d(settings.criticalRatio).times(threshold))) {
    return 'CRITICAL';
  }
  if (observed.greaterThanOrEqualTo(d(settings.highRatio).times(threshold))) {
    return 'HIGH';
  }
  return 'WARNING';
}

export function evaluateVarAlert(
  input: VarAlertInput,
  settingsInput: VarAlertSettingsInput | undefined,
): VarEvaluation {
  const skip = (
    reason: VarSkipReason,
    extra: Partial<
      Pick<
        Extract<VarEvaluation, { kind: 'SKIPPED' }>,
        'metric' | 'validity' | 'figureStatus' | 'missingKeys' | 'invalidKeys'
      >
    >,
  ): VarEvaluation => ({
    kind: 'SKIPPED',
    portfolioId: input.portfolioId,
    reason,
    metric: extra.metric ?? null,
    validity: extra.validity ?? null,
    figureStatus: extra.figureStatus ?? null,
    missingKeys: extra.missingKeys ?? [],
    invalidKeys: extra.invalidKeys ?? [],
  });

  const parsed = parseVarAlertSettings(settingsInput);
  if (!parsed.ok) {
    return skip('ALERT_CONFIG_MISSING', { missingKeys: parsed.missingKeys, invalidKeys: parsed.invalidKeys });
  }
  const settings = parsed.value;
  const metric = settings.metric;
  // Design (Risk worker and scheduler): a result calculated with any DEMO input is never
  // evaluated for VaR alerts, whatever its validity (R30.11, R25.4).
  if (input.flags.includes('DEMO_DATA')) {
    return skip('DEMO_DATA', { metric });
  }
  // Only the selected entry is read; with ADJUSTED, Base VaR is never consulted.
  const entry = metric === 'ADJUSTED' ? input.adjustedVaR : input.baseVaR;
  if (entry.validity !== 'CURRENT' || entry.value === null) {
    return skip('FIGURE_NOT_CURRENT', { metric, validity: entry.validity, figureStatus: entry.status });
  }
  if (input.nav === null || !isDecimal(input.nav) || !d(input.nav).greaterThan(0)) {
    return skip('NAV_NOT_POSITIVE', { metric, validity: entry.validity, figureStatus: entry.status });
  }
  const { absolute, percentOfNav } = entry.value;
  if (percentOfNav === null || !isDecimal(percentOfNav) || !isDecimal(absolute)) {
    return skip('FIGURE_INVALID', { metric, validity: entry.validity, figureStatus: entry.status });
  }
  const severity = varSeverity(percentOfNav, settings);
  return {
    kind: 'EVALUATED',
    portfolioId: input.portfolioId,
    calculatedAt: input.calculatedAt,
    metric,
    settings,
    confidence: input.confidence,
    absolute,
    observedPct: percentOfNav,
    ratio: toCanonical(d(percentOfNav).dividedBy(d(settings.thresholdPct))), // threshold > 0 (validated)
    breached: severity !== null,
    severity,
    triggeredTickers: metric === 'ADJUSTED' ? [...input.triggeredTickers].sort() : [],
  };
}
