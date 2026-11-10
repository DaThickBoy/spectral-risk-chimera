// Public API of src/risk/. Other modules import from this file only.
// risk/ never imports sec/ or nlp/ (R11.5).
export { QUANTILE_METHOD, sortAscending, type7Quantile } from './quantile.js';
export type { QuantileError, QuantileErrorCode } from './quantile.js';
export { computeRisk, exposureOf, positionPnl, riskEngine, scenarioLosses } from './engine.js';
export { adjustScenarios, evaluateEligibility } from './adjustment.js';
export { LOSS_HISTOGRAM_BUCKETS, lossHistogram } from './histogram.js';
export type {
  LossBucket,
  LossHistogram,
  LossHistogramError,
  LossHistogramErrorCode,
  LossHistogramParams,
} from './histogram.js';
export type { AdjustedScenario, Eligibility } from './adjustment.js';
export type { RiskEngine } from './engine.js';
export { ALGORITHM_VERSION, CALC_FLAG_ORDER } from './types.js';
export type {
  AdjustedStatus,
  AdjustmentOutcome,
  CalcFlag,
  CalcStatus,
  EngineStatus,
  IneligibleSentimentStatus,
  RiskInput,
  RiskParams,
  RiskPosition,
  RiskResult,
  SentimentForRisk,
  TriggeredAsset,
  VarFigure,
} from './types.js';
export { deriveValidity } from './validity.js';
export { RISK_WORKER_URL } from './workerUrl.js';
export type { Validities, Validity, ValidityInput } from './validity.js';
