// Import service harness (tasks 7.5, 7.6): the real CSV parser, the in-memory unit of work,
// a fake clock, and sequential ids. Settings are TEST values (OD-6 open for production values).
import { createImportUseCase, createPortfolioService, createPositionService } from '../../src/app/index.js';
import { createImportService, createCsvParser } from '../../src/ingestion/index.js';
import type { ImportFileInput, ImportSettings, OversellPolicy } from '../../src/ingestion/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import type { Repositories, UnitOfWork } from '../../src/persistence/index.js';
import { FakeClock, brandDecimalString, createLogger, sequentialIds } from '../../src/shared/index.js';
import type { TestUnitOfWork } from './persistenceAdapters.js';
import { OPTS, bytes } from './csv.js';

export const PF = 'pf-1';
export const NOW = '2026-11-08T12:00:00.000Z';
export const TEST_SECRET_VALUE = 'test-secret-token-1234';

/**
 * Wraps the in-memory unit of work so a commit fault can target one specific `run` call:
 * `armRun(n, atWrite)` arms `failNextCommit({ atWrite })` just before the n-th (zero-based)
 * subsequent `run`. Read-only runs also count, because the in-memory fake commits them too.
 */
export class TargetedFaultUnitOfWork implements UnitOfWork {
  private remaining: number | undefined;
  private atWrite = 0;
  constructor(readonly inner: TestUnitOfWork) {}

  armRun(runsFromNow: number, atWrite: number): void {
    this.remaining = runsFromNow;
    this.atWrite = atWrite;
  }

  run<T>(work: (tx: Repositories) => T): T {
    if (this.remaining !== undefined) {
      if (this.remaining === 0) {
        this.remaining = undefined;
        this.inner.failNextCommit({ atWrite: this.atWrite });
      } else {
        this.remaining -= 1;
      }
    }
    return this.inner.run(work);
  }
}

export interface HarnessOptions {
  readonly policy?: OversellPolicy | 'MISSING';
  readonly defaultTimezone?: string;
  readonly supportedCurrencies?: readonly string[];
  readonly uow?: TestUnitOfWork;
}

export function importHarness(options: HarnessOptions = {}) {
  const inner = options.uow ?? new InMemoryUnitOfWork();
  const uow = new TargetedFaultUnitOfWork(inner);
  const policy = options.policy ?? 'REJECT';
  const settings: ImportSettings = {
    csv: OPTS,
    supportedCurrencies: options.supportedCurrencies ?? ['USD', 'EUR'],
    ...(policy === 'MISSING' ? {} : { oversellPolicy: policy }),
    ...(options.defaultTimezone === undefined ? {} : { defaultTimezone: options.defaultTimezone }),
  };
  const service = createImportService({
    unitOfWork: uow,
    parser: createCsvParser(),
    clock: new FakeClock(NOW),
    ids: sequentialIds('id'),
    settings,
    secrets: [TEST_SECRET_VALUE],
  });
  const importCsv = (text: string | Uint8Array, overrides: Partial<ImportFileInput> = {}) =>
    service.importFile({
      bytes: typeof text === 'string' ? bytes(text) : text,
      portfolioId: PF,
      source: 'CSV',
      mapping: {},
      fileName: 'trades.csv',
      ...overrides,
    });
  return { inner, uow, service, importCsv };
}

/** The import harness plus the app-layer use case, position service, and portfolio `pf-1`. */
export function useCaseHarness(options: HarnessOptions = {}) {
  const h = importHarness(options);
  const positions = createPositionService({
    unitOfWork: h.uow,
    publisher: { publish: () => undefined },
    logger: createLogger({ clock: new FakeClock(NOW), sink: () => undefined }),
  });
  const portfolios = createPortfolioService({ unitOfWork: h.uow, baseCurrency: 'USD' });
  if (
    portfolios.create({ id: PF, baseCurrency: 'USD', cash: brandDecimalString('1000') }).status !== 'CREATED'
  ) {
    throw new Error('test portfolio not created');
  }
  const useCase = createImportUseCase({ imports: h.service, positions, portfolios, unitOfWork: h.uow });
  const runCsv = (text: string) =>
    useCase.run({ portfolioId: PF, fileName: 'trades.csv', bytes: bytes(text), columns: {} });
  return { ...h, useCase, runCsv };
}
