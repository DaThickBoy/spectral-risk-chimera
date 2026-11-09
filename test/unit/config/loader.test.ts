// AT-CFG-05, AT-CFG-06, and the loader part of AT-CFG-07 (task 3.2), using temporary files.
// Validates: Requirements 32.7, 14.14, 15.8, 18.2, 28.20
import { copyFileSync, linkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  DEFAULT_TEMPLATE_PATH,
  FEATURES,
  FINANCIAL_KEYS,
  MAX_CONFIG_NESTING_DEPTH,
  keyMeta,
  loadConfig,
  nextConfigVersion,
  nodeConfigFileSystem,
} from '../../../src/config/index.js';
import type { ConfigFileSystem, ConfigKey, ConfigLoadResult, Feature } from '../../../src/config/index.js';
import {
  captureLogger,
  completeTestConfig,
  UNAVAILABLE_CONFIGURATION_FEATURES,
  withKey,
  writeConfig,
} from '../../helpers/config.js';
import { tempDir } from '../../helpers/repo.js';

let dir = '';
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ dir, cleanup } = tempDir('config'));
});
afterEach(() => cleanup());

const load = (srcConfigFile: string | undefined, fileSystem?: ConfigFileSystem) => {
  const { logger, records } = captureLogger();
  const result = loadConfig({ srcConfigFile, logger, ...(fileSystem === undefined ? {} : { fileSystem }) });
  return { result, records };
};

/** Records every file the loader opens and reads, using the real file system. */
const recordingFs = (): { fs: ConfigFileSystem; opens: string[]; reads: string[]; closes: string[] } => {
  const opens: string[] = [];
  const reads: string[] = [];
  const closes: string[] = [];
  return {
    opens,
    reads,
    closes,
    fs: {
      ...nodeConfigFileSystem,
      open: (file) => {
        const handle = nodeConfigFileSystem.open(file);
        opens.push(file);
        return {
          info: () => handle.info(),
          readText: () => {
            reads.push(file);
            return handle.readText();
          },
          close: () => {
            closes.push(file);
            handle.close();
          },
        };
      },
    },
  };
};

const lookup = (values: Readonly<Record<string, unknown>>, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, segment) => {
    if (typeof acc === 'object' && acc !== null && segment in acc) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, values);

/**
 * No runtime configuration loaded: no file value is read or substituted, every
 * class F key is missing, and the complete feature map matches the expected one
 * (only `api`, which has no class F dependency, stays available).
 */
const expectUnavailableConfiguration = (result: ConfigLoadResult): void => {
  expect(result.config).toBeNull();
  expect(result.missingFinancialKeys).toEqual(FINANCIAL_KEYS);
  expect(result.unknownKeys).toEqual([]);
  expect(result.invalidKeys).toEqual([]);
  for (const key of FINANCIAL_KEYS) {
    expect(lookup(result.values, key), key).toBeUndefined();
  }
  for (const key of CONFIG_KEYS) {
    expect(['MISSING', 'DEFAULTED', 'ABSENT_OPTIONAL'], key).toContain(result.keys[key].status);
  }
  expect(result.features).toEqual(UNAVAILABLE_CONFIGURATION_FEATURES);
};

describe('complete runtime configuration', () => {
  it('loads every feature and the full AppConfig', () => {
    const file = writeConfig(dir, 'runtime.jsonc', completeTestConfig());
    const { result } = load(file);
    expect(result.file.status).toBe('LOADED');
    expect(result.config).not.toBeNull();
    expect(result.missingFinancialKeys).toEqual(['alerts.filing.criticalThreshold']);
    expect(result.invalidKeys).toEqual([]);
    for (const feature of FEATURES) {
      expect(result.features[feature].available, feature).toBe(true);
    }
    expect(result.version.seq).toBe(1);
    expect(result.version.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats null exactly like an absent key', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'adjustment.multiplier', null),
    );
    const { result } = load(file);
    expect(result.keys['adjustment.multiplier'].status).toBe('MISSING');
    expect(result.features.adjustedVaR.missingKeys).toEqual(['adjustment.multiplier']);
  });
});

describe('AT-CFG-05: a missing class F key disables only its dependent features', () => {
  const required = FINANCIAL_KEYS.filter((key) => keyMeta(key).optional !== true);

  it.each(required)('omitting %s', (key: ConfigKey) => {
    const file = writeConfig(dir, 'runtime.jsonc', withKey(completeTestConfig(), key, undefined));
    const { result, records } = load(file);
    const meta = keyMeta(key);

    expect(result.keys[key].status).toBe('MISSING');
    expect(result.missingFinancialKeys).toContain(key);
    // No value is substituted.
    expect(lookup(result.values, key)).toBeUndefined();
    expect(result.config).toBeNull();

    const prerequisiteOf = (feature: Feature): boolean =>
      feature === 'adjustedVaR' && meta.features.includes('baseVaR');
    for (const feature of FEATURES) {
      const availability = result.features[feature];
      if (meta.features.includes(feature)) {
        expect(availability.available, `${feature} disabled`).toBe(false);
        expect(availability.missingKeys).toEqual([key]);
      } else if (prerequisiteOf(feature)) {
        expect(availability.available).toBe(false);
        expect(availability.missingKeys).toEqual([]);
        expect(availability.blockedBy).toEqual(['baseVaR']);
      } else if ((meta.restricts ?? []).includes(feature)) {
        expect(availability.available, `${feature} keeps running`).toBe(true);
        expect(availability.restrictedBy).toEqual([key]);
      } else {
        expect(availability.available, `${feature} unaffected`).toBe(true);
      }
    }
    // The key is named in the start-up summary.
    const summary = records().find((record) => record['msg'] === 'config.loaded');
    expect(summary?.['missingFinancialKeys']).toContain(key);
  });

  it('a missing Base VaR key leaves Adjusted VaR configuration intact but blocked (BASE_UNAVAILABLE)', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'var.confidence', undefined),
    );
    const { result } = load(file);
    expect(result.features.baseVaR.missingKeys).toEqual(['var.confidence']);
    expect(result.features.adjustedVaR).toMatchObject({
      available: false,
      missingKeys: [],
      blockedBy: ['baseVaR'],
    });
  });

  it('a missing adjustment or sentiment key disables only Adjusted VaR and sentiment ingestion', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'sentiment.windowSeconds', undefined),
    );
    const { result } = load(file);
    expect(result.features.baseVaR.available).toBe(true);
    expect(result.features.adjustedVaR.missingKeys).toEqual(['sentiment.windowSeconds']);
    expect(result.features.import.available).toBe(true);
  });

  it('the optional alerts.filing.criticalThreshold may be absent', () => {
    const file = writeConfig(dir, 'runtime.jsonc', completeTestConfig());
    const { result } = load(file);
    expect(result.keys['alerts.filing.criticalThreshold'].status).toBe('ABSENT_OPTIONAL');
    expect(result.features.filingAlerts.available).toBe(true);
  });
});

describe('invalid values and unknown keys', () => {
  it('an invalid value disables its features without echoing the value', () => {
    const file = writeConfig(dir, 'runtime.jsonc', withKey(completeTestConfig(), 'var.confidence', '7.25'));
    const { result, lines } = (() => {
      const { logger, lines: captured } = captureLogger();
      return { result: loadConfig({ srcConfigFile: file, logger }), lines: captured };
    })();
    expect(result.keys['var.confidence']).toMatchObject({
      status: 'INVALID',
      message: 'must be strictly between 0 and 1',
    });
    expect(result.features.baseVaR).toMatchObject({ available: false, invalidKeys: ['var.confidence'] });
    expect(result.features.import.available).toBe(true);
    expect(lines.join('\n')).not.toContain('7.25');
  });

  it('a decimal written as a JSON number or in exponent notation is invalid', () => {
    const config = withKey(
      withKey(completeTestConfig(), 'adjustment.multiplier', 0),
      'var.lookbackReturns',
      0,
    );
    const text = JSON.stringify(config)
      .replace('"multiplier":0', '"multiplier":1.15')
      .replace('"lookbackReturns":0', '"lookbackReturns":2.5e2');
    const { result } = load(writeConfig(dir, 'runtime.jsonc', text));
    expect(result.keys['adjustment.multiplier']).toMatchObject({
      status: 'INVALID',
      message: 'decimal values must be JSON strings, not JSON numbers (R4.3)',
    });
    expect(result.keys['var.lookbackReturns']).toMatchObject({
      status: 'INVALID',
      message: 'exponent notation is not accepted (R4.6)',
    });
  });

  it('a cross-key rule failure marks every involved key invalid', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'sentiment.windowSeconds', 901),
    );
    const { result } = load(file);
    expect(result.keys['sentiment.windowSeconds'].status).toBe('INVALID');
    expect(result.keys['sentiment.maxAgeSeconds'].status).toBe('INVALID');
    expect(result.features.adjustedVaR.available).toBe(false);
    expect(result.features.baseVaR.available).toBe(true);
  });

  it('adjustment.enabled is rejected as unknown and disables Adjusted VaR only', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'adjustment.enabled', false),
    );
    const { result } = load(file);
    expect(result.unknownKeys).toEqual(['adjustment.enabled']);
    expect(result.features.adjustedVaR).toMatchObject({
      available: false,
      invalidKeys: ['adjustment.enabled'],
    });
    expect(result.features.baseVaR.available).toBe(true);
    expect(result.config).toBeNull();
  });

  it('an SEC contact in configuration is rejected (it belongs in SEC_USER_AGENT)', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'sec.userAgent', 'x contact@example.invalid'),
    );
    const { result } = load(file);
    expect(result.unknownKeys).toEqual(['sec.userAgent']);
    expect(result.features.filing.available).toBe(false);
  });

  it('a group of the wrong type invalidates its keys', () => {
    const file = writeConfig(dir, 'runtime.jsonc', withKey(completeTestConfig(), 'var', 5));
    const { result } = load(file);
    expect(result.keys['var.confidence']).toMatchObject({
      status: 'INVALID',
      message: 'expected an object at var',
    });
    expect(result.features.baseVaR.available).toBe(false);
  });
});

describe('AT-CFG-06: operational defaults are applied and logged, provisional ones flagged', () => {
  it('applies documented defaults and lists provisional ones in the start-up summary', () => {
    const { result, records } = load(writeConfig(dir, 'runtime.jsonc', completeTestConfig()));
    const defaulted = result.defaultsApplied.map((entry) => entry.key);
    expect(defaulted).toEqual(
      CONFIG_KEYS.filter((key) => keyMeta(key).cls === 'O' && keyMeta(key).optional !== true),
    );
    expect(result.defaultsApplied.find((entry) => entry.key === 'alerts.cooldownSeconds')).toEqual({
      key: 'alerts.cooldownSeconds',
      value: 900,
      provisional: true,
    });
    const summary = records().find((record) => record['msg'] === 'config.loaded');
    expect(summary?.['provisionalDefaults']).toEqual([
      'fx.ecb.timeoutMs',
      'fx.ecb.maxResponseBytes',
      'fx.ecb.cacheMaxEntries',
      'alerts.cooldownSeconds',
      'alerts.severity.highRatio',
      'alerts.severity.criticalRatio',
      'sec.item1a.minChars',
    ]);
    expect(summary?.['level']).toBe('info');
  });

  it('an explicit operational value replaces the default', () => {
    const file = writeConfig(
      dir,
      'runtime.jsonc',
      withKey(completeTestConfig(), 'alerts.cooldownSeconds', 60),
    );
    const { result } = load(file);
    expect(result.keys['alerts.cooldownSeconds'].status).toBe('VALID');
    expect(result.config?.alerts.cooldownSeconds).toBe(60);
  });
});

describe('AT-CFG-07 (loader part): the template is never a runtime source', () => {
  /** Refused: the template content is never read, and every opened handle is closed. */
  const expectRefused = (srcConfigFile: string, expectOpened: boolean): void => {
    const recorder = recordingFs();
    const { result } = load(srcConfigFile, recorder.fs);
    expect(result.file.status).toBe('TEMPLATE_REFUSED');
    expect(result.file.message).toContain('configuration template');
    expect(recorder.reads).toEqual([]);
    expect(recorder.opens).toHaveLength(expectOpened ? 1 : 0);
    expect(recorder.closes).toEqual(recorder.opens);
    expectUnavailableConfiguration(result);
  };

  it('refuses the template path without opening it', () => {
    expectRefused(DEFAULT_TEMPLATE_PATH, false);
  });

  it('refuses relative and non-normalized paths to the template without opening them', () => {
    expectRefused(path.relative(process.cwd(), DEFAULT_TEMPLATE_PATH), false);
    expectRefused(
      path.join(path.dirname(DEFAULT_TEMPLATE_PATH), '..', 'config', '.', 'config.template.jsonc'),
      false,
    );
  });

  it.runIf(process.platform === 'win32')('refuses a case variant of the template path on Windows', () => {
    expectRefused(DEFAULT_TEMPLATE_PATH.toUpperCase(), false);
  });

  it('refuses a hard link to the template by the identity of the opened file', (context) => {
    const link = path.join(dir, 'hardlink.jsonc');
    try {
      linkSync(DEFAULT_TEMPLATE_PATH, link);
    } catch {
      context.skip('hard links to the template are not possible from the temporary directory');
    }
    expectRefused(link, true);
  });

  it('refuses a symbolic link to the template by the identity of the opened file', (context) => {
    const link = path.join(dir, 'symlink.jsonc');
    try {
      symlinkSync(DEFAULT_TEMPLATE_PATH, link);
    } catch {
      // Windows without Developer Mode or administrator rights cannot create symbolic links.
      context.skip('symbolic links are not permitted in this environment');
    }
    expectRefused(link, true);
  });

  it('accepts a copy of the template as a separate runtime file and finds its placeholders missing', () => {
    const copy = path.join(dir, 'copy.jsonc');
    copyFileSync(DEFAULT_TEMPLATE_PATH, copy);
    const { result } = load(copy);
    expect(result.file.status).toBe('LOADED');
    expect(result.features.baseVaR.available).toBe(false);
    expect(result.keys['var.confidence'].status).toBe('VALID');
    expect(result.keys['fx.baseCurrency'].status).toBe('MISSING');
  });

  it('with no runtime file, reports every class F key missing and keeps unrelated features available', () => {
    for (const srcConfigFile of [undefined, path.join(dir, 'does-not-exist.jsonc')]) {
      const { result } = load(srcConfigFile);
      expect(['NOT_CONFIGURED', 'NOT_FOUND']).toContain(result.file.status);
      expectUnavailableConfiguration(result);
    }
  });
});

describe('each unavailable-file status: distinct status, no values read, independent features kept', () => {
  const expectStatus = (
    srcConfigFile: string | undefined,
    status: string,
    message: string,
    fs?: ConfigFileSystem,
  ) => {
    const { result, records } = load(srcConfigFile, fs);
    expect(result.file.status).toBe(status);
    expect(result.file.message).toContain(message);
    expectUnavailableConfiguration(result);
    const warning = records().find((record) => record['msg'] === 'config.file_unavailable');
    expect(warning).toMatchObject({ level: 'warn', file: { status } });
    return result;
  };

  it('NOT_CONFIGURED', () => {
    expectStatus(undefined, 'NOT_CONFIGURED', 'SRC_CONFIG_FILE is not set');
  });

  it('NOT_FOUND', () => {
    expectStatus(path.join(dir, 'missing', 'runtime.jsonc'), 'NOT_FOUND', 'not found');
  });

  it('TEMPLATE_REFUSED', () => {
    expectStatus(DEFAULT_TEMPLATE_PATH, 'TEMPLATE_REFUSED', 'configuration template');
  });

  it('UNREADABLE: the path is a directory', () => {
    expectStatus(dir, 'UNREADABLE', 'runtime configuration');
  });

  it('UNREADABLE: permission denied when opening', () => {
    const denied: ConfigFileSystem = {
      ...nodeConfigFileSystem,
      open: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    expectStatus(path.join(dir, 'runtime.jsonc'), 'UNREADABLE', 'EACCES', denied);
  });

  it('PARSE_ERROR: malformed JSONC', () => {
    expectStatus(writeConfig(dir, 'broken.jsonc', '{"var": {'), 'PARSE_ERROR', 'line 1');
  });

  it('PARSE_ERROR: top-level value is not an object', () => {
    expectStatus(writeConfig(dir, 'array.jsonc', '[]'), 'PARSE_ERROR', 'top-level value must be an object');
  });

  it('PARSE_ERROR: nesting deeper than the limit, in objects and in arrays, returns and logs without throwing', () => {
    const deepObject = `${'{"a":'.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}1${'}'.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}`;
    const deepArrays = `{"var": ${'['.repeat(200_000)}${']'.repeat(200_000)}}`;
    for (const [name, text] of [
      ['deep-object.jsonc', deepObject],
      ['deep-arrays.jsonc', deepArrays],
    ] as const) {
      const result = expectStatus(writeConfig(dir, name, text), 'PARSE_ERROR', 'nesting deeper than');
      expect(result.config).toBeNull();
    }
  });
});

describe('import.defaultTimezone in a loaded configuration', () => {
  it('explicit null behaves exactly like omission: import stays available but restricted', () => {
    const omitted = load(
      writeConfig(dir, 'omitted.jsonc', withKey(completeTestConfig(), 'import.defaultTimezone', undefined)),
    ).result;
    const nulled = load(
      writeConfig(dir, 'null.jsonc', withKey(completeTestConfig(), 'import.defaultTimezone', null)),
    ).result;
    const restricted = {
      available: true,
      missingKeys: [],
      invalidKeys: [],
      blockedBy: [],
      restrictedBy: ['import.defaultTimezone'],
    };
    expect(nulled.features.import).toEqual(restricted);
    expect(omitted.features.import).toEqual(restricted);
    expect(nulled.features).toEqual(omitted.features);
    expect(nulled.keys['import.defaultTimezone']).toEqual(omitted.keys['import.defaultTimezone']);
    expect(nulled.keys['import.defaultTimezone'].status).toBe('MISSING');
    expect(nulled.missingFinancialKeys).toEqual(omitted.missingFinancialKeys);
    expect(nulled.missingFinancialKeys).toContain('import.defaultTimezone');
  });

  it('an invalid timezone disables import and reports the invalid key', () => {
    for (const value of ['Mars/Olympus', 'US/Eastern', '+05:00']) {
      const { result, records } = load(
        writeConfig(dir, 'invalid-tz.jsonc', withKey(completeTestConfig(), 'import.defaultTimezone', value)),
      );
      expect(result.keys['import.defaultTimezone']).toMatchObject({ status: 'INVALID' });
      expect(result.features.import).toEqual({
        available: false,
        missingKeys: [],
        invalidKeys: ['import.defaultTimezone'],
        blockedBy: [],
        restrictedBy: [],
      });
      expect(result.invalidKeys).toEqual(['import.defaultTimezone']);
      for (const feature of FEATURES.filter((name) => name !== 'import')) {
        expect(result.features[feature].available, feature).toBe(true);
      }
      const warning = records().find(
        (record) => record['msg'] === 'config.feature_disabled' && record['feature'] === 'import',
      );
      expect(warning?.['invalidKeys']).toEqual(['import.defaultTimezone']);
    }
  });
});

describe('ConfigVersion (R32.7)', () => {
  it('keeps the sequence for identical configuration and increments it on change', () => {
    const file = writeConfig(dir, 'runtime.jsonc', completeTestConfig());
    const { logger } = captureLogger();
    const first = loadConfig({ srcConfigFile: file, logger });
    const same = loadConfig({ srcConfigFile: file, logger, previousVersion: first.version });
    expect(same.version).toEqual(first.version);

    const changed = writeConfig(
      dir,
      'changed.jsonc',
      withKey(completeTestConfig(), 'var.confidence', '0.99'),
    );
    const next = loadConfig({ srcConfigFile: changed, logger, previousVersion: first.version });
    expect(next.version.seq).toBe(first.version.seq + 1);
    expect(next.version.hash).not.toBe(first.version.hash);
  });

  it('hashes key-order-independent canonical JSON', () => {
    expect(nextConfigVersion({ a: '1', b: 2 }).hash).toBe(nextConfigVersion({ b: 2, a: '1' }).hash);
  });
});
