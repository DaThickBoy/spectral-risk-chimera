/**
 * Feature availability (task 3.2): which features may start, and which keys
 * disable or restrict each one. A missing or invalid key disables only the
 * features listed for it in `CONFIG_KEY_META`; an unknown key disables the
 * features of its group (every feature for an unknown top-level key).
 *
 * Availability depends only on key statuses. When no runtime configuration is
 * loaded (not configured, not found, refused template, unreadable, or parse
 * error), every key is absent: class F keys are missing, class O keys take their
 * documented defaults, and features without class F dependencies (`api`) stay
 * available (Configuration policy 6).
 */
import { CONFIG_KEYS, FEATURE_PREREQUISITES, FEATURES, keyMeta } from './schema.js';
import type { ConfigKey, Feature } from './schema.js';

export type KeyStatus = 'VALID' | 'DEFAULTED' | 'MISSING' | 'INVALID' | 'ABSENT_OPTIONAL';

export interface FeatureAvailability {
  readonly available: boolean;
  readonly missingKeys: readonly ConfigKey[];
  /** Invalid keys, including unknown keys found in this feature's groups. */
  readonly invalidKeys: readonly string[];
  /** Prerequisite features that are unavailable (for example Base VaR). */
  readonly blockedBy: readonly Feature[];
  /** Absent keys that restrict, but do not disable, the feature. */
  readonly restrictedBy: readonly ConfigKey[];
}

function featuresOfUnknownKey(unknownKey: string): readonly Feature[] {
  const parent = unknownKey.includes('.') ? unknownKey.slice(0, unknownKey.lastIndexOf('.')) : '';
  if (parent === '') {
    return FEATURES;
  }
  const set = new Set<Feature>();
  for (const key of CONFIG_KEYS) {
    if (key.startsWith(`${parent}.`)) {
      keyMeta(key).features.forEach((feature) => set.add(feature));
      (keyMeta(key).restricts ?? []).forEach((feature) => set.add(feature));
    }
  }
  return [...set];
}

interface Tally {
  missing: ConfigKey[];
  invalid: string[];
  restricted: ConfigKey[];
}

export function computeFeatureAvailability(
  statusOf: (key: ConfigKey) => KeyStatus,
  unknownKeys: readonly string[],
): Record<Feature, FeatureAvailability> {
  const tally = new Map<Feature, Tally>(
    FEATURES.map((feature) => [feature, { missing: [], invalid: [], restricted: [] }]),
  );
  for (const key of CONFIG_KEYS) {
    const meta = keyMeta(key);
    const status = statusOf(key);
    for (const feature of meta.features) {
      const entry = tally.get(feature);
      if (status === 'MISSING') entry?.missing.push(key);
      if (status === 'INVALID') entry?.invalid.push(key);
    }
    for (const feature of meta.restricts ?? []) {
      const entry = tally.get(feature);
      if (status === 'MISSING' || status === 'ABSENT_OPTIONAL') entry?.restricted.push(key);
      if (status === 'INVALID') entry?.invalid.push(key);
    }
  }
  for (const unknownKey of unknownKeys) {
    for (const feature of featuresOfUnknownKey(unknownKey)) {
      tally.get(feature)?.invalid.push(unknownKey);
    }
  }

  const ownAvailable = (feature: Feature): boolean => {
    const entry = tally.get(feature);
    return entry !== undefined && entry.missing.length === 0 && entry.invalid.length === 0;
  };
  const features = {} as Record<Feature, FeatureAvailability>;
  for (const feature of FEATURES) {
    const entry = tally.get(feature) ?? { missing: [], invalid: [], restricted: [] };
    const blockedBy = (FEATURE_PREREQUISITES[feature] ?? []).filter(
      (prerequisite) => !ownAvailable(prerequisite),
    );
    features[feature] = {
      available: ownAvailable(feature) && blockedBy.length === 0,
      missingKeys: entry.missing,
      invalidKeys: entry.invalid,
      blockedBy,
      restrictedBy: entry.restricted,
    };
  }
  return features;
}
