/**
 * Provider status listing (task 8.3; design: Provider Resilience Layer; R25.1,
 * R25.6).
 *
 * Lists the `ResilientCall` status of every configured provider circuit key
 * (for example `marketdata:<name>`, `fx:<name>`): state, circuit, `since`, and
 * the last error code. The status is in-memory and per process (8.2). Provider
 * keys are checked at creation against the contract pattern, so no URL or other
 * unexpected text can enter a response; messages and payloads are never part
 * of it. Results are in ascending key order.
 */
import { ProviderKeySchema } from '../shared/index.js';
import type { ProviderStatusResponse, ResilientCall } from '../shared/index.js';

export interface ProviderStatusService {
  list(): ProviderStatusResponse;
}

export interface ProviderStatusDependencies {
  readonly resilientCall: ResilientCall;
  /** Circuit keys of the configured providers. */
  readonly providers: readonly string[];
}

export function createProviderStatusService(deps: ProviderStatusDependencies): ProviderStatusService {
  if (typeof (deps.resilientCall as Partial<ResilientCall> | undefined)?.status !== 'function') {
    throw new TypeError('resilientCall must be a ResilientCall.');
  }
  if (!Array.isArray(deps.providers)) {
    throw new TypeError('providers must be an array of provider keys.');
  }
  const keys = [...new Set(deps.providers)];
  for (const key of keys) {
    if (!ProviderKeySchema.safeParse(key).success) {
      throw new TypeError('every provider key must be a circuit key such as marketdata:<name>.');
    }
  }
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { resilientCall } = deps;
  return {
    list: () => ({
      providers: keys.map((key) => {
        const status = resilientCall.status(key);
        return {
          provider: key,
          state: status.state,
          circuit: status.circuit,
          since: status.since,
          ...(status.lastErrorCode === undefined ? {} : { lastErrorCode: status.lastErrorCode }),
        };
      }),
    }),
  };
}
