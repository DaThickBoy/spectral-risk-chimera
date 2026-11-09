/**
 * VaR alert settings (task 16.1; R18.1, R18.2, R18.3, R34.2, R34.6; design:
 * Alerts, Configuration).
 *
 * Settings are explicit inputs supplied per portfolio by the caller (R18.3). No
 * value is defaulted here: `alerts.var.thresholdPct`, `alerts.var.metric` and
 * `alerts.resetPct` are financially significant (OD-6 open for production
 * values), and the operational `alerts.severity.*` ratios and
 * `alerts.cooldownSeconds` are passed in as the loader resolved them. A missing
 * or invalid setting yields `ALERT_CONFIG_MISSING` with the key names; nothing
 * is clamped or substituted.
 *
 * Rules (same as the configuration schema):
 * - `thresholdPct` in (0, 100]; `resetPct` a decimal not above `thresholdPct`;
 * - `highRatio` and `criticalRatio` above 1, with `highRatio < criticalRatio`;
 * - `cooldownSeconds` a non-negative integer (a count, not a financial value).
 */
import { DecimalStringSchema, d } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';

export type VarMetric = 'ADJUSTED' | 'BASE';

/** Raw per-portfolio settings, as supplied. `undefined` means not configured. */
export interface VarAlertSettingsInput {
  readonly thresholdPct?: string | undefined;
  readonly metric?: string | undefined;
  readonly resetPct?: string | undefined;
  readonly highRatio?: string | undefined;
  readonly criticalRatio?: string | undefined;
  readonly cooldownSeconds?: number | undefined;
}

export interface VarAlertSettings {
  readonly thresholdPct: DecimalString;
  readonly metric: VarMetric;
  readonly resetPct: DecimalString;
  readonly highRatio: DecimalString;
  readonly criticalRatio: DecimalString;
  readonly cooldownSeconds: number;
}

export const VAR_ALERT_KEYS = {
  thresholdPct: 'alerts.var.thresholdPct',
  metric: 'alerts.var.metric',
  resetPct: 'alerts.resetPct',
  highRatio: 'alerts.severity.highRatio',
  criticalRatio: 'alerts.severity.criticalRatio',
  cooldownSeconds: 'alerts.cooldownSeconds',
} as const;

export type VarAlertSettingsResult =
  | { readonly ok: true; readonly value: VarAlertSettings }
  | {
      readonly ok: false;
      readonly missingKeys: readonly string[];
      readonly invalidKeys: readonly string[];
    };

const decimal = (value: string): DecimalString | undefined => {
  const parsed = DecimalStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export function parseVarAlertSettings(input: VarAlertSettingsInput | undefined): VarAlertSettingsResult {
  const raw = input ?? {};
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];
  const decimals: Partial<
    Record<'thresholdPct' | 'resetPct' | 'highRatio' | 'criticalRatio', DecimalString>
  > = {};

  for (const field of ['thresholdPct', 'resetPct', 'highRatio', 'criticalRatio'] as const) {
    const value = raw[field];
    if (value === undefined) {
      missingKeys.push(VAR_ALERT_KEYS[field]);
      continue;
    }
    const parsed = typeof value === 'string' ? decimal(value) : undefined;
    if (parsed === undefined) {
      invalidKeys.push(VAR_ALERT_KEYS[field]);
      continue;
    }
    decimals[field] = parsed;
  }

  let metric: VarMetric | undefined;
  if (raw.metric === undefined) {
    missingKeys.push(VAR_ALERT_KEYS.metric);
  } else if (raw.metric === 'ADJUSTED' || raw.metric === 'BASE') {
    metric = raw.metric;
  } else {
    invalidKeys.push(VAR_ALERT_KEYS.metric);
  }

  const cooldown = raw.cooldownSeconds;
  if (cooldown === undefined) {
    missingKeys.push(VAR_ALERT_KEYS.cooldownSeconds);
  } else if (!Number.isSafeInteger(cooldown) || cooldown < 0) {
    invalidKeys.push(VAR_ALERT_KEYS.cooldownSeconds);
  }

  const { thresholdPct, resetPct, highRatio, criticalRatio } = decimals;
  if (
    thresholdPct !== undefined &&
    !(d(thresholdPct).greaterThan(0) && d(thresholdPct).lessThanOrEqualTo(100))
  ) {
    invalidKeys.push(VAR_ALERT_KEYS.thresholdPct);
  }
  if (thresholdPct !== undefined && resetPct !== undefined && d(resetPct).greaterThan(d(thresholdPct))) {
    invalidKeys.push(VAR_ALERT_KEYS.resetPct);
  }
  if (highRatio !== undefined && !d(highRatio).greaterThan(1)) {
    invalidKeys.push(VAR_ALERT_KEYS.highRatio);
  }
  if (criticalRatio !== undefined && !d(criticalRatio).greaterThan(1)) {
    invalidKeys.push(VAR_ALERT_KEYS.criticalRatio);
  }
  if (highRatio !== undefined && criticalRatio !== undefined && !d(highRatio).lessThan(d(criticalRatio))) {
    invalidKeys.push(VAR_ALERT_KEYS.criticalRatio);
  }

  if (
    missingKeys.length > 0 ||
    invalidKeys.length > 0 ||
    thresholdPct === undefined ||
    resetPct === undefined ||
    highRatio === undefined ||
    criticalRatio === undefined ||
    metric === undefined ||
    cooldown === undefined
  ) {
    return { ok: false, missingKeys, invalidKeys: [...new Set(invalidKeys)] };
  }
  return {
    ok: true,
    value: { thresholdPct, metric, resetPct, highRatio, criticalRatio, cooldownSeconds: cooldown },
  };
}
