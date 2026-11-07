/**
 * Configuration loader (requirements: Configuration policy 1 to 6; design:
 * Config Service; R32.7).
 *
 * - Reads only the JSONC file named by `SRC_CONFIG_FILE`. It never opens or merges
 *   `config/config.template.jsonc` and refuses any path that resolves to it
 *   (see `runtimeFile.ts`).
 * - `null` is treated exactly like an absent key.
 * - Keys are validated one by one, then cross-key rules are applied, so each
 *   missing or invalid key disables only the features that depend on it
 *   (see `availability.ts`). Missing class F keys are reported by name; no value
 *   is ever substituted.
 * - Class O keys take their documented defaults; provisional defaults are
 *   listed in the start-up summary.
 * - When no runtime configuration is loaded, the file status says why
 *   (`NOT_CONFIGURED`, `NOT_FOUND`, `TEMPLATE_REFUSED`, `UNREADABLE`,
 *   `PARSE_ERROR`), no value is read from any file, every class F key is reported
 *   missing, and features that need no class F key keep running.
 * - Configuration problems (missing, unreadable, malformed, too deeply nested,
 *   or invalid content) are returned in the result and logged; they never throw.
 *   Programmer errors are not caught.
 */
import type { Logger } from '../shared/index.js';
import { computeFeatureAvailability } from './availability.js';
import type { FeatureAvailability, KeyStatus } from './availability.js';
import { nextConfigVersion } from './configVersion.js';
import type { ConfigVersion } from './configVersion.js';
import { configLeafSchemas, inspectStructure, rootShape, setPath } from './introspection.js';
import { UnsupportedNumber } from './jsonc.js';
import { DEFAULT_TEMPLATE_PATH, nodeConfigFileSystem, readRuntimeFile } from './runtimeFile.js';
import type { ConfigFileStatus, ConfigFileSystem } from './runtimeFile.js';
import {
  CONFIG_KEYS,
  CROSS_KEY_RULES,
  FEATURES,
  FINANCIAL_KEYS,
  keyMeta,
  readPath,
  ValidatedConfigSchema,
} from './schema.js';
import type { AppConfig, ConfigKey, ConfigKeyClass, Feature } from './schema.js';

export interface KeyReport {
  readonly key: ConfigKey;
  readonly cls: ConfigKeyClass;
  readonly status: KeyStatus;
  readonly provisional: boolean;
  /** Validation message; never contains the configured value. */
  readonly message?: string;
}

export interface DefaultApplied {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly provisional: boolean;
}

export interface ConfigLoadResult {
  readonly file: { readonly status: ConfigFileStatus; readonly path?: string; readonly message?: string };
  /** The complete configuration, or `null` when any key is missing or invalid. */
  readonly config: AppConfig | null;
  /** Valid and defaulted values, nested like `AppConfig`. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly keys: Readonly<Record<ConfigKey, KeyReport>>;
  readonly unknownKeys: readonly string[];
  /** Every class F key that is absent, required or optional. */
  readonly missingFinancialKeys: readonly ConfigKey[];
  readonly invalidKeys: readonly string[];
  readonly features: Readonly<Record<Feature, FeatureAvailability>>;
  readonly defaultsApplied: readonly DefaultApplied[];
  readonly version: ConfigVersion;
}

export interface LoadConfigOptions {
  /** Value of `SRC_CONFIG_FILE`. */
  readonly srcConfigFile: string | undefined;
  readonly logger: Logger;
  readonly templatePath?: string;
  readonly previousVersion?: ConfigVersion;
  readonly fileSystem?: ConfigFileSystem;
}

function unsupportedNumberMessage(value: UnsupportedNumber): string {
  switch (value.reason) {
    case 'EXPONENT':
      return 'exponent notation is not accepted (R4.6)';
    case 'NON_INTEGER':
      return 'decimal values must be JSON strings, not JSON numbers (R4.3)';
    case 'UNSAFE_INTEGER':
      return 'integer is outside the safe integer range';
  }
}

interface KeyValidation {
  readonly reports: Map<ConfigKey, KeyReport>;
  readonly validValues: Map<ConfigKey, unknown>;
  readonly defaultsApplied: DefaultApplied[];
}

/** Validates each key on its own, then applies the cross-key rules. */
function validateKeys(raw: Record<string, unknown>, badGroups: readonly string[]): KeyValidation {
  const leaves = configLeafSchemas();
  const reports = new Map<ConfigKey, KeyReport>();
  const validValues = new Map<ConfigKey, unknown>();
  const defaultsApplied: DefaultApplied[] = [];

  for (const key of CONFIG_KEYS) {
    const meta = keyMeta(key);
    const provisional = meta.provisional === true;
    const report = (status: KeyStatus, message?: string): void => {
      const base = { key, cls: meta.cls, status, provisional };
      reports.set(key, message === undefined ? base : { ...base, message });
    };
    const leaf = leaves.get(key);
    const badGroup = badGroups.find((group) => key.startsWith(`${group}.`));
    if (leaf === undefined) {
      report('INVALID', 'key is not defined by the schema');
      continue;
    }
    if (badGroup !== undefined) {
      report('INVALID', `expected an object at ${badGroup}`);
      continue;
    }
    const value = readPath(raw, key);
    if (value === undefined) {
      if (meta.cls === 'F' && meta.optional !== true) {
        report('MISSING');
        continue;
      }
      const parsed = leaf.safeParse(undefined);
      if (parsed.success && parsed.data !== undefined) {
        report('DEFAULTED');
        validValues.set(key, parsed.data);
        defaultsApplied.push({ key, value: parsed.data, provisional });
      } else {
        report('ABSENT_OPTIONAL');
      }
      continue;
    }
    if (value instanceof UnsupportedNumber) {
      report('INVALID', unsupportedNumberMessage(value));
      continue;
    }
    const parsed = leaf.safeParse(value);
    if (parsed.success) {
      report('VALID');
      validValues.set(key, parsed.data);
    } else {
      report('INVALID', parsed.error.issues[0]?.message ?? 'invalid value');
    }
  }

  for (const rule of CROSS_KEY_RULES) {
    if (!rule.keys.every((key) => validValues.has(key)) || rule.holds((key) => validValues.get(key))) {
      continue;
    }
    for (const key of rule.keys) {
      const previous = reports.get(key);
      if (previous !== undefined) {
        reports.set(key, { ...previous, status: 'INVALID', message: rule.message });
      }
      validValues.delete(key);
    }
  }
  return { reports, validValues, defaultsApplied };
}

export function loadConfig(options: LoadConfigOptions): ConfigLoadResult {
  const file = readRuntimeFile(
    options.srcConfigFile,
    options.templatePath ?? DEFAULT_TEMPLATE_PATH,
    options.fileSystem ?? nodeConfigFileSystem,
  );
  const raw = file.raw;

  const unknownKeys: string[] = [];
  const badGroups: string[] = [];
  inspectStructure(raw, rootShape(), '', unknownKeys, badGroups);

  const { reports, validValues, defaultsApplied } = validateKeys(raw, badGroups);
  const values: Record<string, unknown> = {};
  for (const [key, value] of validValues) {
    setPath(values, key, value);
  }

  const statusOf = (key: ConfigKey): KeyStatus => reports.get(key)?.status ?? 'MISSING';
  const features = computeFeatureAvailability(statusOf, unknownKeys);

  const missingFinancialKeys = FINANCIAL_KEYS.filter((key) => {
    const status = statusOf(key);
    return status === 'MISSING' || status === 'ABSENT_OPTIONAL';
  });
  const invalidKeys = [...CONFIG_KEYS.filter((key) => statusOf(key) === 'INVALID'), ...unknownKeys];

  let config: AppConfig | null = null;
  if (
    file.status === 'LOADED' &&
    invalidKeys.length === 0 &&
    CONFIG_KEYS.every((key) => statusOf(key) !== 'MISSING')
  ) {
    const full = ValidatedConfigSchema.safeParse(raw);
    config = full.success ? full.data : null;
  }

  const result: ConfigLoadResult = {
    file: {
      status: file.status,
      ...(file.path === undefined ? {} : { path: file.path }),
      ...(file.message === undefined ? {} : { message: file.message }),
    },
    config,
    values,
    keys: Object.fromEntries(reports) as Record<ConfigKey, KeyReport>,
    unknownKeys,
    missingFinancialKeys,
    invalidKeys,
    features,
    defaultsApplied: defaultsApplied.filter((entry) => validValues.has(entry.key)),
    version: nextConfigVersion(values, options.previousVersion),
  };

  logSummary(options.logger, result);
  return result;
}

function logSummary(logger: Logger, result: ConfigLoadResult): void {
  if (result.file.status !== 'LOADED') {
    // Status and diagnostic only; the message never contains configuration values.
    logger.warn('config.file_unavailable', { file: result.file });
  }
  const disabled = FEATURES.filter((feature) => !result.features[feature].available);
  logger.info('config.loaded', {
    file: result.file,
    configVersion: result.version,
    availableFeatures: FEATURES.filter((feature) => result.features[feature].available),
    disabledFeatures: disabled,
    missingFinancialKeys: result.missingFinancialKeys,
    invalidKeys: result.invalidKeys.map((key) => ({
      key,
      message: CONFIG_KEYS.includes(key as ConfigKey) ? result.keys[key as ConfigKey].message : 'unknown key',
    })),
    operationalDefaults: result.defaultsApplied.map((entry) => ({
      key: entry.key,
      value: entry.value,
      provisional: entry.provisional,
    })),
    provisionalDefaults: result.defaultsApplied
      .filter((entry) => entry.provisional)
      .map((entry) => entry.key),
  });
  for (const feature of disabled) {
    const availability = result.features[feature];
    logger.warn('config.feature_disabled', {
      feature,
      missingKeys: availability.missingKeys,
      invalidKeys: availability.invalidKeys,
      blockedBy: availability.blockedBy,
    });
  }
}
