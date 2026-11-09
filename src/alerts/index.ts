// Public API of src/alerts/ (tasks 16.1, 16.2): VaR alert settings, evaluation, state machine,
// and alert content. Pure; persistence, audit, and delivery live in app/ (16.3).
export { VAR_ALERT_KEYS, parseVarAlertSettings } from './settings.js';
export type {
  VarAlertSettings,
  VarAlertSettingsInput,
  VarAlertSettingsResult,
  VarMetric,
} from './settings.js';
export { evaluateVarAlert, varSeverity } from './evaluator.js';
export type {
  AlertSeverity,
  VarAlertInput,
  VarEntryInput,
  VarEvaluation,
  VarSkipReason,
} from './evaluator.js';
export { INITIAL_ALERT_STATE, transitionAlertState } from './stateMachine.js';
export type { AlertPhase, AlertState, AlertTransition, MetricObservation } from './stateMachine.js';
export { VAR_ALERT_SOURCE, buildVarAlert } from './alert.js';
export type { AlertContent, AlertType } from './alert.js';
