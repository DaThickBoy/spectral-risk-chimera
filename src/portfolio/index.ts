// Public API of src/portfolio/ (pure domain code; imports only shared/ and config/).
// Other modules import from this file only.
export { compareLedgerOrder, compareOrdinal } from './ledger.js';
export type { LedgerEntry } from './ledger.js';
export { positionId, samePosition } from './position.js';
export type { Position } from './position.js';
export { LedgerInvariantError, positionProjector, replayPositions } from './positionProjector.js';
export type {
  CurrencyConflict,
  CurrencyConflictError,
  LedgerDataError,
  LedgerField,
  LedgerViolation,
  PositionProjector,
  ProjectionError,
} from './positionProjector.js';
export { positionsChangedEvent, reconcilePositions } from './events.js';
export type { PositionChange, PositionsChanged } from './events.js';
export { computeExposure, exposureMeasures } from './exposure.js';
export type { ExposureLine, ExposureMeasures, ExposureResult } from './exposure.js';
export { allocate, allocationCalculator, withAllocation } from './allocation.js';
export type {
  AllocationCalculator,
  AllocationInput,
  AllocationLine,
  AllocationResult,
  IneligibleReason,
} from './allocation.js';
export { toPositionView, toValuedPositionView } from './positionView.js';
export type { PositionView, ValuationInput, ValuationStatus } from './positionView.js';
