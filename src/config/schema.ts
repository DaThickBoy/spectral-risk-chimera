/**
 * Configuration schema (requirements: Configuration table and policy; design:
 * Config Service, Configuration model, D-15).
 *
 * - Class F (financially significant) keys have no `.default()`. A missing F key
 *   is reported by name and nothing is substituted.
 * - Class O (operational) keys declare their documented defaults; provisional
 *   defaults (OD-6) are flagged in `CONFIG_KEY_META` and reported at start.
 * - Every object is a `z.strictObject`, so unknown keys are rejected. There is
 *   no `adjustment.enabled` key: the downside adjustment cannot be disabled (R15.1).
 * - Decimal settings are decimal strings; counts and seconds are integers (R4.7).
 * - Secrets and personal data (for example the SEC User-Agent contact) are not
 *   configuration; they come from the environment (`EnvSchema`, R24.2).
 * - Fixed values (Decimal.js precision 40, ROUND_HALF_UP) are constants in
 *   `src/shared/decimal.ts`, not configuration.
 *
 * Validates: Requirements 14.2, 14.3, 15.1, 29.5.
 */
import { z } from 'zod';
import { d, DecimalStringSchema, Iso4217Code, SignedUnitDecimalString } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';
import { TZDB_ZONE1970_IDENTIFIERS } from './timeZones.js';

const decimalWhere = (holds: (value: DecimalString) => boolean, message: string) =>
  DecimalStringSchema.refine(holds, { message });

/**
 * Accepted time zone identifiers for `import.defaultTimezone` (R28.1).
 *
 * - Accepted: exactly the 312 identifiers in the TZ column of IANA tzdb release
 *   `TZDB_VERSION` (2026e), file `zone1970.tab` (see `timeZones.ts`), plus `UTC`.
 *   These are primary `Zone` names; no `backward` link is accepted except `UTC`.
 *   The set is fixed in source and does not consult the runtime, so the same
 *   values are accepted on Node.js 24.22.1 and Node.js 26.
 * - Shared identifiers: `zone1970.tab` gives one primary identifier to all places
 *   whose clocks have agreed since 1970, so some cities and countries must use a
 *   shared identifier (for example `Europe/Berlin` for Oslo and Stockholm,
 *   `Europe/Brussels` for Amsterdam, `Asia/Riyadh` for Kuwait). A city's
 *   backward-compatibility alias (`Europe/Oslo`) is rejected.
 * - `UTC` decision: the sole explicit exception. `zone1970.tab` lists only
 *   geographic zones. In tzdb, `UTC` is a `backward` link to the `Zone` `Etc/UTC`;
 *   `UTC` is accepted anyway because it is the identifier ECMA-402 treats as
 *   canonical for Coordinated Universal Time. `Etc/UTC` and the other UTC names
 *   (`GMT`, `Etc/GMT`, `UCT`, `Zulu`) are rejected, so exactly one UTC spelling
 *   is valid.
 * - Rejected: every other `backward` link (`Asia/Calcutta`, `Europe/Kiev`,
 *   `US/Eastern`, `Europe/Oslo`), `Etc/*` zones, numeric offsets (`+05:00`),
 *   wrong capitalisation (`america/new_york`), and any other string. Matching is
 *   exact; nothing is canonicalized or trimmed.
 * - Usability: a test formats with `Intl.DateTimeFormat` for every accepted
 *   identifier, so CI fails on either Node.js version that cannot use one.
 *   Some runtimes report a different spelling from `resolvedOptions().timeZone`
 *   (for example `Asia/Calcutta` for `Asia/Kolkata` with ICU 78.3); that does
 *   not change which identifiers are accepted.
 */
const ACCEPTED_TIME_ZONES: ReadonlySet<string> = new Set([...TZDB_ZONE1970_IDENTIFIERS, 'UTC']);

export function isCanonicalTimeZone(name: string): boolean {
  return ACCEPTED_TIME_ZONES.has(name);
}

/** The only accepted demonstration profile (Kiroween decision H3). */
export const DEMO_PROFILE = 'KIROWEEN_2026_DEMO';

const uniqueCurrencies = z
  .array(Iso4217Code)
  .min(1)
  .refine((codes) => new Set(codes).size === codes.length, { message: 'currencies must be unique' });

export const ConfigSchema = z.strictObject({
  var: z.strictObject({
    confidence: decimalWhere(
      (v) => d(v).greaterThan(0) && d(v).lessThan(1),
      'must be strictly between 0 and 1',
    ),
    horizonDays: z.literal(1),
    lookbackReturns: z.int().min(2),
    minObservations: z.int().min(2),
  }),
  adjustment: z.strictObject({
    bearishThreshold: SignedUnitDecimalString,
    multiplier: decimalWhere((v) => d(v).greaterThanOrEqualTo(1), 'must be at least 1'),
  }),
  sentiment: z.strictObject({
    maxAgeSeconds: z.int().positive(),
    windowSeconds: z.int().positive(),
    maxFutureSkewSeconds: z.int().nonnegative(),
    reconnect: z
      .strictObject({
        initialDelaySeconds: z.int().positive().default(1),
        maxDelaySeconds: z.int().positive().default(60),
        maxAttempts: z.int().positive().default(10),
        jitter: z.boolean().default(true),
      })
      .prefault({}),
    rest: z.strictObject({ pollSeconds: z.int().positive().optional() }).prefault({}),
  }),
  marketData: z.strictObject({
    maxStalenessDays: z.int().nonnegative(),
    maxReturnGapDays: z.int().min(1),
  }),
  fx: z.strictObject({
    baseCurrency: Iso4217Code,
    supportedCurrencies: uniqueCurrencies,
    maxRateAgeSeconds: z.int().positive(),
    // R30.3: selected explicitly, no default. `ECB` requires the EUR base (ECB_REQUIRES_EUR_BASE).
    provider: z.enum(['FIXTURE', 'ECB']),
    // Operational settings of the ECB adapter (task 10.2); provisional defaults (OD-6).
    ecb: z
      .strictObject({
        timeoutMs: z.int().positive().default(10_000),
        maxResponseBytes: z.int().positive().default(1_048_576),
        cacheMaxEntries: z.int().min(1).default(64),
      })
      .prefault({}),
  }),
  filing: z.strictObject({
    maxAgeDays: z.int().positive(),
  }),
  alerts: z.strictObject({
    var: z.strictObject({
      thresholdPct: decimalWhere(
        (v) => d(v).greaterThan(0) && d(v).lessThanOrEqualTo(100),
        'must be greater than 0 and at most 100',
      ),
      metric: z.enum(['ADJUSTED', 'BASE']),
    }),
    resetPct: DecimalStringSchema,
    filing: z.strictObject({
      threshold: decimalWhere(
        (v) => d(v).greaterThanOrEqualTo(0) && d(v).lessThanOrEqualTo(1),
        'must be between 0 and 1',
      ),
      resetThreshold: decimalWhere(
        (v) => d(v).greaterThanOrEqualTo(0) && d(v).lessThanOrEqualTo(1),
        'must be between 0 and 1',
      ),
      criticalThreshold: decimalWhere(
        (v) => d(v).greaterThanOrEqualTo(0) && d(v).lessThanOrEqualTo(1),
        'must be between 0 and 1',
      ).optional(),
    }),
    cooldownSeconds: z.int().nonnegative().default(900),
    severity: z
      .strictObject({
        highRatio: decimalWhere((v) => d(v).greaterThan(1), 'must be greater than 1').default(
          '1.25' as DecimalString,
        ),
        criticalRatio: decimalWhere((v) => d(v).greaterThan(1), 'must be greater than 1').default(
          '1.50' as DecimalString,
        ),
      })
      .prefault({}),
    delivery: z.strictObject({ maxRetries: z.int().nonnegative().default(3) }).prefault({}),
  }),
  import: z.strictObject({
    maxFileBytes: z
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    maxRows: z.int().positive().default(100_000),
    maxFieldLength: z.int().positive().default(256),
    oversellPolicy: z.enum(['REJECT', 'ALLOW_SHORT']),
    defaultTimezone: z.string().refine(isCanonicalTimeZone, {
      message: 'must be a primary IANA time zone identifier from zone1970.tab (tzdb 2026e) or UTC',
    }),
  }),
  recalc: z.strictObject({
    minValueChangePct: decimalWhere((v) => d(v).greaterThanOrEqualTo(0), 'must be at least 0'),
  }),
  fix: z.strictObject({ delimiter: z.enum(['SOH', '|']).default('SOH') }).prefault({}),
  sec: z
    .strictObject({
      maxRequestsPerSecond: z.int().min(1).max(10).default(5),
      timeoutMs: z.int().positive().default(30_000),
      maxResponseBytes: z
        .int()
        .positive()
        .default(25 * 1024 * 1024),
      maxRedirects: z.int().positive().default(3),
      item1a: z.strictObject({ minChars: z.int().positive().default(500) }).prefault({}),
    })
    .prefault({}),
  nlp: z
    .strictObject({
      timeoutMs: z.int().positive().default(60_000),
      maxRetries: z.int().nonnegative().default(2),
      maxInputChars: z.int().positive().optional(),
    })
    .prefault({}),
  provider: z
    .strictObject({
      maxRetries: z.int().nonnegative().default(3),
      timeoutMs: z.int().positive().default(10_000),
      backoff: z
        .strictObject({
          baseMs: z.int().positive().default(250),
          maxMs: z.int().positive().default(10_000),
        })
        .prefault({}),
      circuit: z
        .strictObject({
          failureThreshold: z.int().positive().default(5),
          openMs: z.int().positive().default(60_000),
        })
        .prefault({}),
      retryAfter: z.strictObject({ maxMs: z.int().positive().default(600_000) }).prefault({}),
    })
    .prefault({}),
  ws: z.strictObject({ maxQueueSize: z.int().positive().default(1000) }).prefault({}),
  api: z
    .strictObject({
      rateLimitPerMinute: z.int().positive().default(60),
      uploadRateLimitPerMinute: z.int().positive().default(10),
    })
    .prefault({}),
  /**
   * Demonstration profile marker (Kiroween decision H3). Present only in a separate
   * demo configuration file, never in the template. A configuration that carries it
   * starts only in the explicit demo mode (`--demo-fixtures`); `provisionalKeys`
   * names the settings whose values in that file are provisional demo choices, not
   * approved values, and is reported at start. It supplies no value of its own.
   */
  demo: z
    .strictObject({
      profile: z.literal(DEMO_PROFILE).optional(),
      provisionalKeys: z
        .array(z.string().min(1))
        .refine((keys) => new Set(keys).size === keys.length, { message: 'keys must be unique' })
        .optional(),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Features whose availability depends on configuration (task 3.2). */
export const FEATURES = [
  'baseVaR',
  'adjustedVaR',
  'sentimentIngestion',
  'varAlerts',
  'filingAlerts',
  'import',
  'filing',
  'api',
] as const;
export type Feature = (typeof FEATURES)[number];

export type ConfigKeyClass = 'F' | 'O';

export interface ConfigKeyMeta {
  readonly cls: ConfigKeyClass;
  /** Features that cannot start when this key is missing or invalid. */
  readonly features: readonly Feature[];
  /** Optional key: absence is allowed and disables nothing. */
  readonly optional?: true;
  /** Operational default pending approval (OD-6). */
  readonly provisional?: true;
  /** Features that keep running but are restricted when this key is absent. */
  readonly restricts?: readonly Feature[];
}

const PROVIDERS: readonly Feature[] = ['baseVaR', 'sentimentIngestion', 'filing'];

/**
 * Class, dependent features, and provisional status for every configuration key.
 * Feature mapping follows R14.14 (Base VaR), R15.1/R15.8 (Adjusted VaR), R9/R10
 * (sentiment), R18/R34 (alerts, VaR and filing kept separate per R34.1), R28.20
 * (import), and R31 (filing).
 */
export const CONFIG_KEY_META = {
  'var.confidence': { cls: 'F', features: ['baseVaR'] },
  'var.horizonDays': { cls: 'F', features: ['baseVaR'] },
  'var.lookbackReturns': { cls: 'F', features: ['baseVaR'] },
  'var.minObservations': { cls: 'F', features: ['baseVaR'] },
  'adjustment.bearishThreshold': { cls: 'F', features: ['adjustedVaR'] },
  'adjustment.multiplier': { cls: 'F', features: ['adjustedVaR'] },
  'sentiment.maxAgeSeconds': { cls: 'F', features: ['adjustedVaR', 'sentimentIngestion'] },
  'sentiment.windowSeconds': { cls: 'F', features: ['adjustedVaR', 'sentimentIngestion'] },
  'sentiment.maxFutureSkewSeconds': { cls: 'F', features: ['adjustedVaR', 'sentimentIngestion'] },
  'sentiment.reconnect.initialDelaySeconds': { cls: 'O', features: ['sentimentIngestion'] },
  'sentiment.reconnect.maxDelaySeconds': { cls: 'O', features: ['sentimentIngestion'] },
  'sentiment.reconnect.maxAttempts': { cls: 'O', features: ['sentimentIngestion'] },
  'sentiment.reconnect.jitter': { cls: 'O', features: ['sentimentIngestion'] },
  'sentiment.rest.pollSeconds': { cls: 'O', features: ['sentimentIngestion'], optional: true },
  'marketData.maxStalenessDays': { cls: 'F', features: ['baseVaR'] },
  'marketData.maxReturnGapDays': { cls: 'F', features: ['baseVaR'] },
  'fx.baseCurrency': { cls: 'F', features: ['baseVaR'] },
  'fx.supportedCurrencies': { cls: 'F', features: ['baseVaR'] },
  'fx.maxRateAgeSeconds': { cls: 'F', features: ['baseVaR'] },
  'fx.provider': { cls: 'F', features: ['baseVaR'] },
  'fx.ecb.timeoutMs': { cls: 'O', features: ['baseVaR'], provisional: true },
  'fx.ecb.maxResponseBytes': { cls: 'O', features: ['baseVaR'], provisional: true },
  'fx.ecb.cacheMaxEntries': { cls: 'O', features: ['baseVaR'], provisional: true },
  'filing.maxAgeDays': { cls: 'F', features: ['filing', 'filingAlerts'] },
  'alerts.var.thresholdPct': { cls: 'F', features: ['varAlerts'] },
  'alerts.var.metric': { cls: 'F', features: ['varAlerts'] },
  'alerts.resetPct': { cls: 'F', features: ['varAlerts'] },
  'alerts.filing.threshold': { cls: 'F', features: ['filingAlerts'] },
  'alerts.filing.resetThreshold': { cls: 'F', features: ['filingAlerts'] },
  'alerts.filing.criticalThreshold': { cls: 'F', features: ['filingAlerts'], optional: true },
  'alerts.cooldownSeconds': { cls: 'O', features: ['varAlerts', 'filingAlerts'], provisional: true },
  'alerts.severity.highRatio': { cls: 'O', features: ['varAlerts'], provisional: true },
  'alerts.severity.criticalRatio': { cls: 'O', features: ['varAlerts'], provisional: true },
  'alerts.delivery.maxRetries': { cls: 'O', features: ['varAlerts', 'filingAlerts'] },
  'import.maxFileBytes': { cls: 'O', features: ['import'] },
  'import.maxRows': { cls: 'O', features: ['import'] },
  'import.maxFieldLength': { cls: 'O', features: ['import'] },
  'import.oversellPolicy': { cls: 'F', features: ['import'] },
  'import.defaultTimezone': { cls: 'F', features: [], restricts: ['import'] },
  'recalc.minValueChangePct': { cls: 'F', features: ['baseVaR'] },
  'fix.delimiter': { cls: 'O', features: ['import'] },
  'sec.maxRequestsPerSecond': { cls: 'O', features: ['filing'] },
  'sec.timeoutMs': { cls: 'O', features: ['filing'] },
  'sec.maxResponseBytes': { cls: 'O', features: ['filing'] },
  'sec.maxRedirects': { cls: 'O', features: ['filing'] },
  'sec.item1a.minChars': { cls: 'O', features: ['filing'], provisional: true },
  'nlp.timeoutMs': { cls: 'O', features: ['filing'] },
  'nlp.maxRetries': { cls: 'O', features: ['filing'] },
  'nlp.maxInputChars': { cls: 'O', features: ['filing'], optional: true },
  'provider.maxRetries': { cls: 'O', features: PROVIDERS },
  'provider.timeoutMs': { cls: 'O', features: PROVIDERS },
  'provider.backoff.baseMs': { cls: 'O', features: PROVIDERS },
  'provider.backoff.maxMs': { cls: 'O', features: PROVIDERS },
  'provider.circuit.failureThreshold': { cls: 'O', features: PROVIDERS },
  'provider.circuit.openMs': { cls: 'O', features: PROVIDERS },
  'provider.retryAfter.maxMs': { cls: 'O', features: PROVIDERS },
  'ws.maxQueueSize': { cls: 'O', features: ['sentimentIngestion'] },
  'api.rateLimitPerMinute': { cls: 'O', features: ['api'] },
  'api.uploadRateLimitPerMinute': { cls: 'O', features: ['api'] },
  'demo.profile': { cls: 'O', features: [], optional: true },
  'demo.provisionalKeys': { cls: 'O', features: [], optional: true },
} as const satisfies Record<string, ConfigKeyMeta>;

export type ConfigKey = keyof typeof CONFIG_KEY_META;

export const CONFIG_KEYS = Object.keys(CONFIG_KEY_META) as ConfigKey[];

export function keyMeta(key: ConfigKey): ConfigKeyMeta {
  return CONFIG_KEY_META[key];
}

/** Class F keys, in table order (the template must contain exactly these). */
export const FINANCIAL_KEYS: readonly ConfigKey[] = CONFIG_KEYS.filter((key) => keyMeta(key).cls === 'F');

/** Features that require another feature to be available (R13.7: `BASE_UNAVAILABLE`). */
export const FEATURE_PREREQUISITES: Readonly<Partial<Record<Feature, readonly Feature[]>>> = {
  adjustedVaR: ['baseVaR'],
};

/** A validation rule spanning several keys. Skipped when any of its keys is absent. */
export interface CrossKeyRule {
  readonly id: string;
  readonly keys: readonly ConfigKey[];
  readonly message: string;
  readonly holds: (value: (key: ConfigKey) => unknown) => boolean;
}

const dec = (value: unknown): ReturnType<typeof d> => d(value as DecimalString);
const int = (value: unknown): number => value as number;

export const CROSS_KEY_RULES: readonly CrossKeyRule[] = [
  {
    id: 'MIN_OBSERVATIONS_WITHIN_LOOKBACK',
    keys: ['var.minObservations', 'var.lookbackReturns'],
    message: 'var.minObservations must not exceed var.lookbackReturns',
    holds: (v) => int(v('var.minObservations')) <= int(v('var.lookbackReturns')),
  },
  {
    id: 'WINDOW_WITHIN_MAX_AGE',
    keys: ['sentiment.windowSeconds', 'sentiment.maxAgeSeconds'],
    message: 'sentiment.windowSeconds must not exceed sentiment.maxAgeSeconds',
    holds: (v) => int(v('sentiment.windowSeconds')) <= int(v('sentiment.maxAgeSeconds')),
  },
  {
    id: 'VAR_RESET_AT_OR_BELOW_THRESHOLD',
    keys: ['alerts.resetPct', 'alerts.var.thresholdPct'],
    message: 'alerts.resetPct must not exceed alerts.var.thresholdPct',
    holds: (v) => dec(v('alerts.resetPct')).lessThanOrEqualTo(dec(v('alerts.var.thresholdPct'))),
  },
  {
    id: 'FILING_RESET_AT_OR_BELOW_THRESHOLD',
    keys: ['alerts.filing.resetThreshold', 'alerts.filing.threshold'],
    message: 'alerts.filing.resetThreshold must not exceed alerts.filing.threshold',
    holds: (v) => dec(v('alerts.filing.resetThreshold')).lessThanOrEqualTo(dec(v('alerts.filing.threshold'))),
  },
  {
    id: 'FILING_CRITICAL_AT_OR_ABOVE_THRESHOLD',
    keys: ['alerts.filing.criticalThreshold', 'alerts.filing.threshold'],
    message: 'alerts.filing.criticalThreshold must not be below alerts.filing.threshold',
    holds: (v) =>
      dec(v('alerts.filing.criticalThreshold')).greaterThanOrEqualTo(dec(v('alerts.filing.threshold'))),
  },
  {
    id: 'SEVERITY_RATIOS_ORDERED',
    keys: ['alerts.severity.highRatio', 'alerts.severity.criticalRatio'],
    message: 'alerts.severity.highRatio must be less than alerts.severity.criticalRatio',
    holds: (v) => dec(v('alerts.severity.highRatio')).lessThan(dec(v('alerts.severity.criticalRatio'))),
  },
  {
    id: 'BACKOFF_MAX_AT_LEAST_BASE',
    keys: ['provider.backoff.baseMs', 'provider.backoff.maxMs'],
    message: 'provider.backoff.baseMs must not exceed provider.backoff.maxMs',
    holds: (v) => int(v('provider.backoff.baseMs')) <= int(v('provider.backoff.maxMs')),
  },
  {
    id: 'BASE_CURRENCY_SUPPORTED',
    keys: ['fx.baseCurrency', 'fx.supportedCurrencies'],
    message: 'fx.supportedCurrencies must include fx.baseCurrency',
    holds: (v) => (v('fx.supportedCurrencies') as readonly string[]).includes(v('fx.baseCurrency') as string),
  },
  {
    // R30.3 / OD-5: the ECB publishes only euro reference rates; no triangulation exists.
    id: 'ECB_REQUIRES_EUR_BASE',
    keys: ['fx.provider', 'fx.baseCurrency'],
    message: 'fx.provider ECB requires fx.baseCurrency EUR',
    holds: (v) => v('fx.provider') !== 'ECB' || v('fx.baseCurrency') === 'EUR',
  },
  {
    // H3: a demo file may only mark existing, non-demo settings as provisional.
    id: 'DEMO_PROVISIONAL_KEYS_KNOWN',
    keys: ['demo.provisionalKeys'],
    message: 'demo.provisionalKeys must name configuration keys outside demo.*',
    holds: (v) =>
      (v('demo.provisionalKeys') as readonly string[]).every(
        (key) => (CONFIG_KEYS as readonly string[]).includes(key) && !key.startsWith('demo.'),
      ),
  },
];

/** Reads a dotted path from a nested object; `undefined` when any segment is absent. */
export function readPath(root: unknown, key: string): unknown {
  let current: unknown = root;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = Object.prototype.hasOwnProperty.call(current, segment)
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }
  return current;
}

/** Full-config check used by `ValidatedConfigSchema`: applies every cross-key rule. */
export const ValidatedConfigSchema = ConfigSchema.superRefine((config, ctx) => {
  for (const rule of CROSS_KEY_RULES) {
    const values = rule.keys.map((key) => readPath(config, key));
    if (values.some((value) => value === undefined)) {
      continue;
    }
    if (!rule.holds((key) => readPath(config, key))) {
      ctx.addIssue({ code: 'custom', path: rule.keys[0]?.split('.') ?? [], message: rule.message });
    }
  }
});
