// Public API of src/config/. Other modules import from this file only.
export {
  CONFIG_KEYS,
  CONFIG_KEY_META,
  CROSS_KEY_RULES,
  ConfigSchema,
  DEMO_PROFILE,
  FEATURES,
  FEATURE_PREREQUISITES,
  FINANCIAL_KEYS,
  ValidatedConfigSchema,
  isCanonicalTimeZone,
  keyMeta,
  readPath,
} from './schema.js';
export type { AppConfig, ConfigKey, ConfigKeyClass, ConfigKeyMeta, CrossKeyRule, Feature } from './schema.js';
export { loadConfig } from './loader.js';
export type { ConfigLoadResult, DefaultApplied, KeyReport, LoadConfigOptions } from './loader.js';
export type { FeatureAvailability, KeyStatus } from './availability.js';
export { configLeafSchemas, dropNulls } from './introspection.js';
export {
  TZDB_SOURCE_FILE,
  TZDB_VERSION,
  TZDB_ZONE1970_IDENTIFIERS,
  TZDB_ZONE1970_TAB_SHA256,
} from './timeZones.js';
export { DEFAULT_TEMPLATE_PATH, nodeConfigFileSystem } from './runtimeFile.js';
export type { ConfigFileHandle, ConfigFileInfo, ConfigFileStatus, ConfigFileSystem } from './runtimeFile.js';
export { configHash, nextConfigVersion } from './configVersion.js';
export type { ConfigVersion } from './configVersion.js';
export { MAX_CONFIG_NESTING_DEPTH, parseConfigJsonc, UnsupportedNumber } from './jsonc.js';
export type { JsoncParseError, UnsupportedNumberReason } from './jsonc.js';
export { ENV_KEYS, EnvSchema, SECRET_ENV_KEYS, loadEnv } from './env.js';
export type { Env, EnvIssue, EnvKey, EnvLoadResult } from './env.js';
