/**
 * VaR alert service (tasks 16.1 to 16.3; design: Alerts, Alert state machine,
 * Risk alert event flow; R18, R19.4, R19.5, R34.1, R34.5, R34.6; Properties 32
 * and 34).
 *
 * `onRiskResult(input)` runs in one unit of work:
 * - Evaluates with the portfolio's explicit settings (`settings(portfolioId)`,
 *   R18.3; no production defaults, OD-6 open).
 * - A skipped evaluation writes only the audit entry `ALERT` / `ALERT_SKIPPED`
 *   with its reason, metric, validity, figure status, and the missing or invalid
 *   keys. The alert state is not read or written, so a skip never fires,
 *   escalates, or re-arms (R18.7).
 * - Otherwise the persisted `alert_state` of the key `(VAR, portfolioId)` is
 *   advanced by the 16.2 state machine and stored when it changed. A fired
 *   alert is inserted with `delivery = PENDING` (the outbox) and audited as
 *   `ALERT_RAISED`; a suppressed one is audited as `ALERT_SUPPRESSED`.
 * - After the commit, and only then, `onAlertsRaised` is told (the 16.3
 *   dispatcher). Its failure is logged and never reaches the caller.
 * A persistence failure gives `COMMIT_FAILED`; it never throws into the risk
 * calculation that called this service (R19.5).
 *
 * `list(portfolioId)` returns alert history; `dismiss(id)` marks an open alert
 * `DISMISSED` without deleting it (R19.4) and audits `ALERT_DISMISSED`.
 */
import {
  INITIAL_ALERT_STATE,
  buildVarAlert,
  evaluateVarAlert,
  transitionAlertState,
} from '../alerts/index.js';
import type {
  AlertSeverity,
  AlertState,
  VarAlertInput,
  VarAlertSettingsInput,
  VarSkipReason,
} from '../alerts/index.js';
import { createAuditLog } from '../audit/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type { AlertRecord, AlertStateRecord, UnitOfWork } from '../persistence/ports.js';
import type { Clock, IdGenerator, Logger } from '../shared/index.js';
import type { RiskView } from './riskService.js';

export interface VarAlertServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Explicit per-portfolio settings; `undefined` means none configured (ALERT_CONFIG_MISSING). */
  readonly settings: (portfolioId: string) => VarAlertSettingsInput | undefined;
  /** Post-commit notification of newly raised alerts (16.3 dispatcher). */
  readonly onAlertsRaised?: (alertIds: readonly string[]) => void;
}

export type VarAlertOutcome =
  | { readonly status: 'SKIPPED'; readonly reason: VarSkipReason }
  | {
      readonly status: 'FIRED';
      readonly alertId: string;
      readonly severity: AlertSeverity;
      readonly kind: 'NEW' | 'ESCALATION';
    }
  | { readonly status: 'SUPPRESSED'; readonly cause: 'BREACH_CONTINUES' | 'COOLDOWN' }
  | { readonly status: 'NO_ALERT' }
  | { readonly status: 'COMMIT_FAILED' };

export type DismissOutcome =
  | { readonly status: 'DISMISSED'; readonly alert: AlertRecord }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NOT_OPEN'; readonly alert: AlertRecord }
  | { readonly status: 'COMMIT_FAILED' };

export interface VarAlertService {
  onRiskResult(input: VarAlertInput): VarAlertOutcome;
  list(portfolioId: string): readonly AlertRecord[];
  dismiss(alertId: string): DismissOutcome;
}

/** The evaluator input from a stored risk view and the R15.10 triggering tickers. */
export function varAlertInput(view: RiskView, triggeredTickers: readonly string[]): VarAlertInput {
  return {
    portfolioId: view.portfolioId,
    calculatedAt: view.calculatedAt,
    nav: view.nav,
    confidence: view.confidence,
    baseVaR: view.baseVaR,
    adjustedVaR: view.adjustedVaR,
    triggeredTickers,
    flags: view.flags,
  };
}

const toState = (record: AlertStateRecord | undefined): AlertState =>
  record === undefined
    ? INITIAL_ALERT_STATE
    : { phase: record.phase, lastSeverity: record.lastSeverity, lastAlertAt: record.lastAlertAt };

export function createVarAlertService(deps: VarAlertServiceDependencies): VarAlertService {
  const now = (): string => deps.clock.nowUtc().toISOString();

  const notify = (alertIds: readonly string[]): void => {
    if (alertIds.length === 0 || deps.onAlertsRaised === undefined) {
      return;
    }
    try {
      deps.onAlertsRaised(alertIds);
    } catch (error) {
      deps.logger.error('alert.notify_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  const onRiskResult = (input: VarAlertInput): VarAlertOutcome => {
    const evaluation = evaluateVarAlert(input, deps.settings(input.portfolioId));
    const at = now();
    let outcome: VarAlertOutcome;
    try {
      outcome = deps.unitOfWork.run((tx): VarAlertOutcome => {
        const audit = createAuditLog(tx.audit);
        if (evaluation.kind === 'SKIPPED') {
          audit.append({
            id: deps.ids.next(),
            at,
            category: 'ALERT',
            type: 'ALERT_SKIPPED',
            subject: input.portfolioId,
            details: {
              alertType: 'VAR',
              reason: evaluation.reason,
              metric: evaluation.metric ?? 'NONE',
              validity: evaluation.validity ?? 'NONE',
              figureStatus: evaluation.figureStatus ?? 'NONE',
              missingKeys: evaluation.missingKeys.join(','),
              invalidKeys: evaluation.invalidKeys.join(','),
            },
          });
          return { status: 'SKIPPED', reason: evaluation.reason };
        }
        const stored = tx.alertState.get('VAR', input.portfolioId, null);
        const transition = transitionAlertState(toState(stored), {
          value: evaluation.observedPct,
          severity: evaluation.severity,
          resetLevel: evaluation.settings.resetPct,
          cooldownSeconds: evaluation.settings.cooldownSeconds,
          at,
        });
        let alertId: string | null = stored?.lastAlertId ?? null;
        let result: VarAlertOutcome = { status: 'NO_ALERT' };
        if (transition.action === 'FIRE') {
          alertId = deps.ids.next();
          result = { status: 'FIRED', alertId, severity: transition.severity, kind: transition.kind };
          const content = buildVarAlert(evaluation, transition, alertId, at);
          tx.alerts.insert({
            ...content,
            triggeredTickers: [...content.triggeredTickers],
            state: 'OPEN',
            stateChangedAt: null,
            delivery: 'PENDING',
            deliveryAttempts: 0,
            lastAttemptAt: null,
          });
          audit.append({
            id: deps.ids.next(),
            at,
            category: 'ALERT',
            type: 'ALERT_RAISED',
            subject: input.portfolioId,
            details: { alertType: 'VAR', alertId, severity: transition.severity, kind: transition.kind },
          });
        } else if (transition.action === 'SUPPRESS') {
          result = { status: 'SUPPRESSED', cause: transition.cause };
          audit.append({
            id: deps.ids.next(),
            at,
            category: 'ALERT',
            type: 'ALERT_SUPPRESSED',
            subject: input.portfolioId,
            details: {
              alertType: 'VAR',
              cause: transition.cause,
              severity: evaluation.severity ?? 'NONE',
              observedPct: evaluation.observedPct,
            },
          });
        }
        const next = transition.next;
        const changed =
          stored === undefined ||
          stored.phase !== next.phase ||
          stored.lastSeverity !== next.lastSeverity ||
          stored.lastAlertAt !== next.lastAlertAt;
        if (changed) {
          tx.alertState.upsert({
            type: 'VAR',
            portfolioId: input.portfolioId,
            ticker: null,
            phase: next.phase,
            lastSeverity: next.lastSeverity,
            lastAlertAt: next.lastAlertAt,
            lastAlertId: next.lastAlertAt === null ? null : alertId,
            updatedAt: at,
          });
        }
        return result;
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        deps.logger.error('alert.commit_failed', { portfolioId: input.portfolioId, code: error.code });
        return { status: 'COMMIT_FAILED' };
      }
      throw error;
    }
    if (outcome.status === 'FIRED') {
      notify([outcome.alertId]);
    }
    return outcome;
  };

  const dismiss = (alertId: string): DismissOutcome => {
    const at = now();
    try {
      return deps.unitOfWork.run((tx): DismissOutcome => {
        const existing = tx.alerts.get(alertId);
        if (existing === undefined) {
          return { status: 'NOT_FOUND' };
        }
        if (existing.state !== 'OPEN') {
          return { status: 'NOT_OPEN', alert: existing };
        }
        const dismissed: AlertRecord = { ...existing, state: 'DISMISSED', stateChangedAt: at };
        tx.alerts.update(dismissed);
        createAuditLog(tx.audit).append({
          id: deps.ids.next(),
          at,
          category: 'ALERT',
          type: 'ALERT_DISMISSED',
          subject: existing.portfolioId,
          details: { alertType: existing.type, alertId },
        });
        return { status: 'DISMISSED', alert: dismissed };
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        return { status: 'COMMIT_FAILED' };
      }
      throw error;
    }
  };

  return {
    onRiskResult,
    dismiss,
    list: (portfolioId) => deps.unitOfWork.run((tx) => tx.alerts.listByPortfolio(portfolioId)),
  };
}
