/**
 * Configuration version (R32.7): a monotonic sequence number plus the SHA-256
 * of the canonical configuration. The sequence increases whenever the canonical
 * configuration changes and stays the same when it does not.
 */
import { canonicalJson, sha256Hex } from '../shared/index.js';

export interface ConfigVersion {
  readonly seq: number;
  /** SHA-256 (hex) of `canonicalJson` of the effective configuration values. */
  readonly hash: string;
}

export function configHash(values: unknown): string {
  return sha256Hex(canonicalJson(values));
}

export function nextConfigVersion(values: unknown, previous?: ConfigVersion): ConfigVersion {
  const hash = configHash(values);
  if (previous === undefined) {
    return { seq: 1, hash };
  }
  return previous.hash === hash ? previous : { seq: previous.seq + 1, hash };
}
