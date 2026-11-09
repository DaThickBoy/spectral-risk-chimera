/**
 * Alert state machine (task 16.2; design: Alert state machine; R34.5, R34.6;
 * Property 32). Pure: the caller loads and stores the state (`alert_state`, one
 * row per key `(type, portfolioId, ticker?)`), so a restart continues from the
 * persisted phase and never re-fires an open breach.
 *
 * Transitions on one evaluated metric value (`breached` means strictly above
 * the threshold; `severity` its band):
 * - ARMED:     breached -> fire (NEW), BREACHED at that level.
 * - BREACHED:  breached with a higher severity than the last alert -> fire
 *              (ESCALATION); breached otherwise -> suppressed; at or below the
 *              reset level -> REARMING; between reset and threshold -> unchanged.
 * - REARMING:  breached with a higher severity than the last alert -> fire
 *              (ESCALATION, bypasses the cooldown); breached after the cooldown
 *              -> fire (NEW); breached within the cooldown -> suppressed;
 *              not breached after the cooldown -> ARMED; otherwise unchanged.
 * The cooldown is `cooldownSeconds` since the last fired alert for the key.
 * Times are UTC millisecond timestamps; the elapsed time is an integer number
 * of milliseconds, not a financial value.
 *
 * Skipped evaluations (16.1) are never passed here, so an unavailable figure
 * never fires, escalates, or re-arms (R18.7).
 */
import { d } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';
import type { AlertSeverity } from './evaluator.js';

export type AlertPhase = 'ARMED' | 'BREACHED' | 'REARMING';

export interface AlertState {
  readonly phase: AlertPhase;
  /** Severity of the last fired alert; `null` before the first alert. */
  readonly lastSeverity: AlertSeverity | null;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ` of the last fired alert; `null` before the first alert. */
  readonly lastAlertAt: string | null;
}

export const INITIAL_ALERT_STATE: AlertState = { phase: 'ARMED', lastSeverity: null, lastAlertAt: null };

export interface MetricObservation {
  /** The metric value (VaR: percent of NAV). */
  readonly value: DecimalString;
  /** `null` at or below the threshold. */
  readonly severity: AlertSeverity | null;
  /** The reset level (`alerts.resetPct`). */
  readonly resetLevel: DecimalString;
  readonly cooldownSeconds: number;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`: when this evaluation happens. */
  readonly at: string;
}

export type AlertTransition =
  | {
      readonly action: 'FIRE';
      readonly kind: 'NEW' | 'ESCALATION';
      readonly severity: AlertSeverity;
      readonly next: AlertState;
    }
  | {
      readonly action: 'SUPPRESS';
      readonly cause: 'BREACH_CONTINUES' | 'COOLDOWN';
      readonly next: AlertState;
    }
  | { readonly action: 'NONE'; readonly next: AlertState };

const RANK: Readonly<Record<AlertSeverity, number>> = { WARNING: 1, HIGH: 2, CRITICAL: 3 };

const higher = (severity: AlertSeverity, than: AlertSeverity | null): boolean =>
  than === null || RANK[severity] > RANK[than];

function cooldownElapsed(state: AlertState, observation: MetricObservation): boolean {
  if (state.lastAlertAt === null) {
    return true;
  }
  const elapsedMs = Date.parse(observation.at) - Date.parse(state.lastAlertAt); // time, not a financial value
  return elapsedMs >= observation.cooldownSeconds * 1000;
}

export function transitionAlertState(state: AlertState, observation: MetricObservation): AlertTransition {
  if (!Number.isSafeInteger(observation.cooldownSeconds) || observation.cooldownSeconds < 0) {
    throw new TypeError('cooldownSeconds must be a non-negative integer.');
  }
  if (Number.isNaN(Date.parse(observation.at))) {
    throw new TypeError('at must be a timestamp.');
  }
  const { severity } = observation;
  const fire = (kind: 'NEW' | 'ESCALATION', level: AlertSeverity): AlertTransition => ({
    action: 'FIRE',
    kind,
    severity: level,
    next: { phase: 'BREACHED', lastSeverity: level, lastAlertAt: observation.at },
  });

  switch (state.phase) {
    case 'ARMED':
      return severity === null ? { action: 'NONE', next: state } : fire('NEW', severity);
    case 'BREACHED':
      if (severity !== null) {
        return higher(severity, state.lastSeverity)
          ? fire('ESCALATION', severity)
          : { action: 'SUPPRESS', cause: 'BREACH_CONTINUES', next: state };
      }
      if (d(observation.value).lessThanOrEqualTo(d(observation.resetLevel))) {
        return { action: 'NONE', next: { ...state, phase: 'REARMING' } };
      }
      return { action: 'NONE', next: state };
    case 'REARMING':
      if (severity !== null) {
        if (higher(severity, state.lastSeverity)) {
          return fire('ESCALATION', severity);
        }
        return cooldownElapsed(state, observation)
          ? fire('NEW', severity)
          : { action: 'SUPPRESS', cause: 'COOLDOWN', next: state };
      }
      return cooldownElapsed(state, observation)
        ? { action: 'NONE', next: { ...state, phase: 'ARMED' } }
        : { action: 'NONE', next: state };
  }
}
