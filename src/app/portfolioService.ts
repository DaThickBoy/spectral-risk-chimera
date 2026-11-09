/**
 * Portfolio creation with explicit cash (task 6.1; design: Allocation and cash;
 * A-7, FR-10, R20.1, R30.1, AT-ALC-10).
 *
 * - Cash is required and is never defaulted or replaced by zero. "0" and negative
 *   values are valid; it is stored as a Canonical Decimal String (R4.3).
 * - The portfolio base currency is the configured `fx.baseCurrency` (R30.1): a
 *   request naming another currency is `BASE_CURRENCY_NOT_SUPPORTED`, because
 *   valuation converts only into the configured base.
 * - A portfolio is created at most once: an existing id is `PORTFOLIO_EXISTS`
 *   and nothing is written.
 * - Only a `PersistenceError` becomes `COMMIT_FAILED`; any other exception
 *   propagates (a programmer error).
 */
import type { PortfolioRecord, UnitOfWork } from '../persistence/ports.js';
import { PersistenceError } from '../persistence/ports.js';
import { d, isDecimalText, isKnownCurrency, toCanonical } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';

export interface PortfolioCreateInput {
  readonly id: string;
  readonly baseCurrency: string;
  /** Decimal text; canonicalized before storage. */
  readonly cash: DecimalString;
}

export type PortfolioCreateResult =
  | { readonly status: 'CREATED'; readonly portfolio: PortfolioRecord }
  | { readonly status: 'PORTFOLIO_EXISTS' }
  | { readonly status: 'BASE_CURRENCY_NOT_SUPPORTED'; readonly baseCurrency: string }
  | { readonly status: 'COMMIT_FAILED'; readonly code: PersistenceError['code'] };

export interface PortfolioService {
  create(input: PortfolioCreateInput): PortfolioCreateResult;
  get(id: string): PortfolioRecord | undefined;
}

export interface PortfolioServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  /** `fx.baseCurrency`; financially significant, never defaulted. */
  readonly baseCurrency: string;
}

export function createPortfolioService(deps: PortfolioServiceDependencies): PortfolioService {
  if (typeof (deps.unitOfWork as Partial<UnitOfWork> | undefined)?.run !== 'function') {
    throw new TypeError('unitOfWork must be a UnitOfWork.');
  }
  if (typeof deps.baseCurrency !== 'string' || !isKnownCurrency(deps.baseCurrency)) {
    throw new TypeError('baseCurrency must be an ISO 4217 code.');
  }
  const { unitOfWork, baseCurrency } = deps;
  return {
    create: (input) => {
      if (typeof input.id !== 'string' || input.id.length === 0) {
        throw new TypeError('id must be a non-empty string.');
      }
      if (typeof input.cash !== 'string' || !isDecimalText(input.cash)) {
        throw new TypeError('cash must be decimal text.'); // never defaulted (A-7)
      }
      if (input.baseCurrency !== baseCurrency) {
        return Object.freeze({ status: 'BASE_CURRENCY_NOT_SUPPORTED', baseCurrency });
      }
      const record: PortfolioRecord = Object.freeze({
        id: input.id,
        baseCurrency,
        cash: toCanonical(d(input.cash)),
      });
      try {
        return unitOfWork.run((tx): PortfolioCreateResult => {
          if (tx.portfolios.get(record.id) !== undefined) {
            return Object.freeze({ status: 'PORTFOLIO_EXISTS' });
          }
          tx.portfolios.insert(record);
          return Object.freeze({ status: 'CREATED', portfolio: record });
        });
      } catch (error) {
        if (error instanceof PersistenceError) {
          return Object.freeze({ status: 'COMMIT_FAILED', code: error.code });
        }
        throw error;
      }
    },
    get: (id) => unitOfWork.run((tx) => tx.portfolios.get(id)),
  };
}
