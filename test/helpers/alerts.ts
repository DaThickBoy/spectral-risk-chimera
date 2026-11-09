// Test helpers for the VaR alert evaluator, state machine, and service (tasks 16.1 to 16.3).
// Thresholds are TEST values supplied explicitly (OD-6 open; no production defaults).
import type { VarAlertInput, VarAlertSettingsInput, VarEntryInput } from '../../src/alerts/index.js';
import { createVarAlertService } from '../../src/app/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import type { Validity } from '../../src/risk/index.js';
import { FakeClock, brandDecimalString, sequentialIds } from '../../src/shared/index.js';
import { capturingLogger } from './api.js';

export const AT = '2026-11-08T12:00:00.000Z';

export const SETTINGS: VarAlertSettingsInput = {
  thresholdPct: '15',
  metric: 'ADJUSTED',
  resetPct: '15',
  highRatio: '1.25',
  criticalRatio: '1.50',
  cooldownSeconds: 900,
};

export function entry(validity: Validity, status: string, percentOfNav: string | null = null): VarEntryInput {
  return {
    validity,
    status,
    value:
      validity === 'UNAVAILABLE' || percentOfNav === null
        ? null
        : { absolute: brandDecimalString('1'), percentOfNav: brandDecimalString(percentOfNav) },
  };
}

/** A result with both figures CURRENT at the given percentages of NAV. */
export function input(
  adjustedPct: string,
  basePct = adjustedPct,
  overrides: Partial<VarAlertInput> = {},
): VarAlertInput {
  return {
    portfolioId: 'pf-1',
    calculatedAt: AT,
    nav: brandDecimalString('1000'),
    confidence: brandDecimalString('0.95'),
    baseVaR: entry('CURRENT', 'OK', basePct),
    adjustedVaR: entry('CURRENT', 'APPLIED', adjustedPct),
    triggeredTickers: ['BBB', 'AAA'],
    flags: [],
    ...overrides,
  };
}

/** The VaR alert service over an in-memory unit of work; settings per portfolio (TEST values). */
export function alertHarness(
  options: {
    settings?: Record<string, VarAlertSettingsInput | undefined>;
    uow?: InMemoryUnitOfWork;
    clock?: FakeClock;
    onAlertsRaised?: (ids: readonly string[]) => void;
    idPrefix?: string;
  } = {},
) {
  const uow = options.uow ?? new InMemoryUnitOfWork();
  const clock = options.clock ?? new FakeClock(AT);
  const captured = capturingLogger();
  const settings = options.settings ?? { 'pf-1': SETTINGS };
  const service = createVarAlertService({
    unitOfWork: uow,
    clock,
    ids: sequentialIds(options.idPrefix ?? 'alert'), // a restarted harness on the same uow needs another prefix
    logger: captured.logger,
    settings: (portfolioId) => settings[portfolioId],
    ...(options.onAlertsRaised === undefined ? {} : { onAlertsRaised: options.onAlertsRaised }),
  });
  const audit = (type: string) => uow.snapshot().audit.filter((entry) => entry.type === type);
  return { uow, clock, service, audit, ...captured };
}
