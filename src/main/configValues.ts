/**
 * Reading loaded configuration values for the composition root. The loader has
 * already validated every present value (`ConfigLoadResult.values` holds valid
 * and defaulted values only), so a key is either present with its schema type or
 * absent. Nothing here substitutes a value: an absent key is reported by name and
 * the component that needs it is not built (architecture.md section 6).
 */
import { readPath } from '../config/index.js';
import type { ConfigLoadResult } from '../config/index.js';

export type ConfigValues = Pick<ConfigLoadResult, 'values'>;

export type Required<K extends string> =
  | { readonly ok: true; readonly get: (key: K) => unknown }
  | { readonly ok: false; readonly missingKeys: readonly K[] };

/** All `keys`, or the sorted list of the absent ones. */
export function requireKeys<K extends string>(config: ConfigValues, keys: readonly K[]): Required<K> {
  const missingKeys = keys.filter((key) => readPath(config.values, key) === undefined).sort();
  if (missingKeys.length > 0) {
    return { ok: false, missingKeys };
  }
  return { ok: true, get: (key) => readPath(config.values, key) };
}

/** A present value, or `undefined`; the caller decides what absence means. */
export function optionalValue(config: ConfigValues, key: string): unknown {
  return readPath(config.values, key);
}
