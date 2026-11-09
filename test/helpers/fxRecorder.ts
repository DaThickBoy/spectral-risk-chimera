// Test harness for task 10.3 (recording FxService). Settings are TEST values (OD-6 open).
import { createRecordingFxService } from '../../src/app/index.js';
import type { ObservedFxRate } from '../../src/app/index.js';
import type { FxProvider, FxService } from '../../src/fx/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import type { UnitOfWork } from '../../src/persistence/index.js';
import { FakeClock, LastValidStore, sequentialIds } from '../../src/shared/index.js';
import type { IdGenerator } from '../../src/shared/index.js';
import { AS_OF, AT, BASE, MAX_AGE_SECONDS, SUPPORTED } from './fx.js';
import { drive, harness } from './resilience.js';
import type { Harness } from './resilience.js';

/** Wall-clock time used for `recordedAt` in recorder tests. */
export const RECORDED_AT = '2026-11-06T16:00:05.000Z';

export interface RecorderSetup {
  readonly h: Harness;
  readonly uow: InMemoryUnitOfWork;
  readonly lastValid: LastValidStore<string, ObservedFxRate>;
  readonly clock: FakeClock;
  readonly service: FxService;
  readonly rate: (currency: string, asOf?: string, at?: string) => ReturnType<FxService['rateToBase']>;
}

export function recorderSetup(
  provider: FxProvider,
  options: {
    unitOfWork?: UnitOfWork;
    uow?: InMemoryUnitOfWork;
    lastValid?: LastValidStore<string, ObservedFxRate>;
    ids?: IdGenerator;
    maxRetries?: number;
    failureThreshold?: number;
  } = {},
): RecorderSetup {
  const h = harness(
    { maxRetries: options.maxRetries ?? 0 },
    options.failureThreshold === undefined ? {} : { failureThreshold: options.failureThreshold },
  );
  const uow = options.uow ?? new InMemoryUnitOfWork();
  const lastValid = options.lastValid ?? new LastValidStore<string, ObservedFxRate>();
  const clock = new FakeClock(RECORDED_AT);
  const service = createRecordingFxService({
    fx: {
      provider,
      resilientCall: h.rc,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    },
    unitOfWork: options.unitOfWork ?? uow,
    lastValid,
    clock,
    ids: options.ids ?? sequentialIds('fx'),
  });
  return {
    h,
    uow,
    lastValid,
    clock,
    service,
    rate: (currency, asOf = AS_OF, at = AT) => drive(h.sleeper, service.rateToBase(currency, asOf, at)),
  };
}
