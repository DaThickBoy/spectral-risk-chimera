// AT-CFG-01, AT-SEN-16, AT-SEN-26, and the configuration part of AT-SEN-15 (task 3.1).
// Validates: Requirements 14.2, 14.3, 15.1, 29.5, 28.1
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  ConfigSchema,
  configLeafSchemas,
  FINANCIAL_KEYS,
  isCanonicalTimeZone,
  keyMeta,
  TZDB_SOURCE_FILE,
  TZDB_VERSION,
  TZDB_ZONE1970_IDENTIFIERS,
  TZDB_ZONE1970_TAB_SHA256,
  ValidatedConfigSchema,
} from '../../../src/config/index.js';
import { repoPath } from '../../helpers/repo.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';

const valid = (config: unknown): boolean => ValidatedConfigSchema.safeParse(config).success;

describe('schema structure', () => {
  it('describes every leaf of ConfigSchema in CONFIG_KEY_META, and nothing else', () => {
    expect([...configLeafSchemas().keys()].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it('has 24 class F keys, none with a default', () => {
    expect(FINANCIAL_KEYS).toHaveLength(24);
    const leaves = configLeafSchemas();
    for (const key of FINANCIAL_KEYS) {
      const leaf = leaves.get(key);
      expect(leaf, key).toBeDefined();
      // A class F key never produces a value from absence (no .default()).
      const fromAbsence = leaf?.safeParse(undefined);
      expect(fromAbsence?.success === true && fromAbsence.data !== undefined, `${key} has no default`).toBe(
        false,
      );
    }
  });

  it('gives class O keys their documented defaults', () => {
    const parsed = ConfigSchema.parse(completeTestConfig());
    expect(parsed.alerts.cooldownSeconds).toBe(900);
    expect(parsed.alerts.severity).toEqual({ highRatio: '1.25', criticalRatio: '1.50' });
    expect(parsed.alerts.delivery.maxRetries).toBe(3);
    expect(parsed.import).toMatchObject({ maxFileBytes: 10_485_760, maxRows: 100_000, maxFieldLength: 256 });
    expect(parsed.sec).toEqual({
      maxRequestsPerSecond: 5,
      timeoutMs: 30_000,
      maxResponseBytes: 26_214_400,
      maxRedirects: 3,
      item1a: { minChars: 500 },
    });
    expect(parsed.nlp).toEqual({ timeoutMs: 60_000, maxRetries: 2 });
    expect(parsed.provider.maxRetries).toBe(3);
    expect(parsed.ws.maxQueueSize).toBe(1000);
    expect(parsed.api).toEqual({ rateLimitPerMinute: 60, uploadRateLimitPerMinute: 10 });
    expect(parsed.fix.delimiter).toBe('SOH');
    expect(parsed.sentiment.reconnect).toEqual({
      initialDelaySeconds: 1,
      maxDelaySeconds: 60,
      maxAttempts: 10,
      jitter: true,
    });
  });

  it('flags the provisional operational defaults (OD-6)', () => {
    const provisional = CONFIG_KEYS.filter((key) => keyMeta(key).provisional === true).sort();
    expect(provisional).toEqual([
      'alerts.cooldownSeconds',
      'alerts.severity.criticalRatio',
      'alerts.severity.highRatio',
      'sec.item1a.minChars',
    ]);
  });
});

describe('AT-CFG-01: each validation rule has a passing and a failing case', () => {
  const base = completeTestConfig();

  it('accepts the complete test configuration', () => {
    expect(valid(base)).toBe(true);
  });

  it.each([
    ['var.confidence', '0.99', '0'],
    ['var.confidence', '0.95', '1'],
    ['var.confidence', '0.5', '-0.1'],
    ['var.confidence', '0.95', '1.5'],
    ['var.confidence', '0.95', 'NaN'],
    ['var.confidence', '0.95', 0.95],
    ['var.horizonDays', 1, 2],
    ['var.lookbackReturns', 250, 1],
    ['var.minObservations', 200, 1.5],
    ['adjustment.bearishThreshold', '-1', '-1.01'],
    ['adjustment.bearishThreshold', '1', '1.5'],
    ['adjustment.multiplier', '1', '0.99'],
    ['sentiment.maxAgeSeconds', 300, 0],
    ['sentiment.maxFutureSkewSeconds', 0, -1],
    ['marketData.maxStalenessDays', 0, -1],
    ['marketData.maxReturnGapDays', 1, 0],
    ['fx.baseCurrency', 'EUR', 'usd'],
    ['fx.supportedCurrencies', ['USD'], ['USD', 'USD']],
    ['fx.supportedCurrencies', ['USD', 'JPY'], []],
    ['fx.maxRateAgeSeconds', 60, 0],
    ['filing.maxAgeDays', 1, 0],
    ['alerts.var.thresholdPct', '100', '100.01'],
    ['alerts.var.thresholdPct', '10', '0'],
    ['alerts.var.metric', 'BASE', 'MAX'],
    ['alerts.filing.threshold', '1', '1.1'],
    ['alerts.filing.criticalThreshold', '0.9', '1.2'],
    ['alerts.cooldownSeconds', 0, -5],
    ['alerts.severity.highRatio', '1.1', '1'],
    ['import.oversellPolicy', 'ALLOW_SHORT', 'ALLOW'],
    ['import.defaultTimezone', 'UTC', 'Mars/Olympus'],
    ['import.maxRows', 1, 0],
    ['recalc.minValueChangePct', '0', '-0.1'],
    ['fix.delimiter', '|', ','],
    ['sec.maxRequestsPerSecond', 10, 11],
    ['sec.maxRedirects', 1, 0],
    ['nlp.maxRetries', 0, -1],
    ['api.rateLimitPerMinute', 1, 0],
  ])('%s: %j passes, %j fails', (key, good, bad) => {
    expect(valid(withKey(base, key, good)), `${key}=${JSON.stringify(good)}`).toBe(true);
    expect(valid(withKey(base, key, bad)), `${key}=${JSON.stringify(bad)}`).toBe(false);
  });

  it('requires var.minObservations <= var.lookbackReturns', () => {
    expect(valid(withKey(withKey(base, 'var.minObservations', 250), 'var.lookbackReturns', 250))).toBe(true);
    expect(valid(withKey(withKey(base, 'var.minObservations', 251), 'var.lookbackReturns', 250))).toBe(false);
  });

  it('requires alerts.resetPct <= alerts.var.thresholdPct', () => {
    expect(valid(withKey(base, 'alerts.resetPct', '9.99'))).toBe(true);
    expect(valid(withKey(base, 'alerts.resetPct', '10.01'))).toBe(false);
  });

  it('requires alerts.filing.resetThreshold <= alerts.filing.threshold <= criticalThreshold', () => {
    expect(valid(withKey(base, 'alerts.filing.resetThreshold', '0.7'))).toBe(true);
    expect(valid(withKey(base, 'alerts.filing.resetThreshold', '0.81'))).toBe(false);
    expect(valid(withKey(base, 'alerts.filing.criticalThreshold', '0.8'))).toBe(true);
    expect(valid(withKey(base, 'alerts.filing.criticalThreshold', '0.79'))).toBe(false);
  });

  it('requires highRatio < criticalRatio', () => {
    expect(valid(withKey(base, 'alerts.severity', { highRatio: '1.2', criticalRatio: '1.3' }))).toBe(true);
    expect(valid(withKey(base, 'alerts.severity', { highRatio: '1.5', criticalRatio: '1.5' }))).toBe(false);
  });

  it('requires fx.supportedCurrencies to include fx.baseCurrency', () => {
    expect(valid(withKey(base, 'fx.supportedCurrencies', ['EUR', 'USD']))).toBe(true);
    expect(valid(withKey(base, 'fx.supportedCurrencies', ['EUR', 'GBP']))).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(valid(withKey(base, 'var.extra', 1))).toBe(false);
    expect(valid(withKey(base, 'unexpected', {}))).toBe(false);
    expect(valid(withKey(base, 'sec.userAgent', 'name contact@example.invalid'))).toBe(false);
  });

  it('rejects a missing class F key', () => {
    expect(valid(withKey(base, 'fx.baseCurrency', undefined))).toBe(false);
  });
});

describe('AT-SEN-16: adjustment threshold and multiplier ranges', () => {
  const base = completeTestConfig();
  it.each([['-1.0001'], ['1.0001'], ['-2']])('rejects threshold %s', (value) => {
    expect(valid(withKey(base, 'adjustment.bearishThreshold', value))).toBe(false);
  });
  it.each([['0.99'], ['0'], ['-1.15']])('rejects multiplier %s', (value) => {
    expect(valid(withKey(base, 'adjustment.multiplier', value))).toBe(false);
  });
  it('accepts the approved baseline -0.60 and 1.15', () => {
    expect(valid(base)).toBe(true);
  });
});

describe('AT-SEN-26: sentiment.windowSeconds must not exceed sentiment.maxAgeSeconds', () => {
  const base = completeTestConfig();
  it('accepts windowSeconds equal to maxAgeSeconds and rejects a larger one', () => {
    expect(valid(withKey(base, 'sentiment.windowSeconds', 900))).toBe(true);
    expect(valid(withKey(base, 'sentiment.windowSeconds', 901))).toBe(false);
  });
});

describe('import.defaultTimezone: IANA tzdb 2026e zone1970.tab primary identifiers plus UTC (R28.1)', () => {
  const base = completeTestConfig();
  const accepts = (zone: unknown): boolean => valid(withKey(base, 'import.defaultTimezone', zone));

  it.each([
    'America/New_York',
    'Europe/London',
    'Asia/Tokyo',
    'Australia/Sydney',
    'America/Sao_Paulo',
    'Asia/Kolkata',
    'Europe/Kyiv',
    'America/Argentina/Buenos_Aires',
    'America/Nuuk',
  ])('accepts the primary IANA identifier %s', (zone) => {
    expect(isCanonicalTimeZone(zone)).toBe(true);
    expect(accepts(zone)).toBe(true);
  });

  it.each([
    ['Europe/Berlin', 'Oslo, Stockholm, Copenhagen'],
    ['Europe/Brussels', 'Amsterdam, Luxembourg'],
    ['Asia/Riyadh', 'Kuwait, Aden'],
    ['Africa/Abidjan', 'Accra, Dakar, Reykjavik'],
  ])('accepts the shared primary identifier %s (used for %s)', (zone) => {
    expect(isCanonicalTimeZone(zone)).toBe(true);
    expect(accepts(zone)).toBe(true);
  });

  it('accepts UTC as the single identifier for Coordinated Universal Time', () => {
    expect(isCanonicalTimeZone('UTC')).toBe(true);
    expect(accepts('UTC')).toBe(true);
  });

  // backward links in tzdb 2026e. They are rejected on every runtime, including
  // those whose ICU data reports the old spelling as canonical (Node.js 24.22.1 and
  // 26.13.0 report Asia/Calcutta and Europe/Kiev from Intl.supportedValuesOf).
  it.each([
    'Asia/Calcutta',
    'Europe/Kiev',
    'US/Eastern',
    'America/Buenos_Aires',
    'America/Godthab',
    'Etc/UTC',
    'GMT',
    'Etc/GMT',
    'UCT',
    'Zulu',
    'EST',
  ])('rejects the alias or backward-compatibility link %s', (zone) => {
    expect(isCanonicalTimeZone(zone)).toBe(false);
    expect(accepts(zone)).toBe(false);
  });

  // Former zone.tab entries that are backward links to a shared primary identifier.
  it.each([
    ['Europe/Oslo', 'Europe/Berlin'],
    ['Europe/Stockholm', 'Europe/Berlin'],
    ['Europe/Amsterdam', 'Europe/Brussels'],
    ['Asia/Kuwait', 'Asia/Riyadh'],
    ['Asia/Kuala_Lumpur', 'Asia/Singapore'],
    ['Atlantic/Reykjavik', 'Africa/Abidjan'],
    ['America/Nassau', 'America/Toronto'],
  ])('rejects the city alias %s (use %s)', (alias, primary) => {
    expect(isCanonicalTimeZone(alias)).toBe(false);
    expect(accepts(alias)).toBe(false);
    expect(isCanonicalTimeZone(primary)).toBe(true);
  });

  it.each(['+05:00', '-08:00', '+0530', 'UTC+1', 'GMT-5', 'Etc/GMT+5', 'Etc/GMT-14'])(
    'rejects the offset or fixed-offset zone %s',
    (zone) => {
      expect(isCanonicalTimeZone(zone)).toBe(false);
      expect(accepts(zone)).toBe(false);
    },
  );

  it.each(['', ' ', 'Mars/Olympus', 'america/new_york', 'AMERICA/NEW_YORK', 'America/New York', 'Local'])(
    'rejects the invalid or non-canonical value %j',
    (zone) => {
      expect(isCanonicalTimeZone(zone)).toBe(false);
      expect(accepts(zone)).toBe(false);
    },
  );

  it.each([0, 5, true, ['UTC'], { zone: 'UTC' }])('rejects the non-string value %j', (zone) => {
    expect(accepts(zone)).toBe(false);
  });

  describe('the accepted set is the zone1970.tab fixture (tzdb 2026e) plus UTC, independent of the runtime', () => {
    const fixture = readFileSync(repoPath('test', 'fixtures', 'tzdata', '2026e', 'zone1970.tab'));
    const fixtureRows = fixture
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line !== '' && !line.startsWith('#'));
    const fromFixture = fixtureRows.map((line) => line.split('\t')[2] ?? '');

    it('records the release, source file, and fixture hash', () => {
      expect(TZDB_VERSION).toBe('2026e');
      expect(TZDB_SOURCE_FILE).toBe('zone1970.tab');
      expect(createHash('sha256').update(fixture).digest('hex')).toBe(TZDB_ZONE1970_TAB_SHA256);
      expect(TZDB_ZONE1970_TAB_SHA256).toBe(
        '5f23781702bf51408ff1581daa109ab3b9257fb433b1554e579d92172892c0cf',
      );
    });

    it('embeds exactly the fixture third-column identifiers, without duplicates', () => {
      expect(fromFixture).toHaveLength(312);
      expect(fromFixture.every((zone) => /^[A-Za-z]+\/[A-Za-z0-9_/+-]+$/.test(zone))).toBe(true);
      expect(new Set(TZDB_ZONE1970_IDENTIFIERS).size).toBe(TZDB_ZONE1970_IDENTIFIERS.length);
      expect([...TZDB_ZONE1970_IDENTIFIERS]).toEqual([...new Set(fromFixture)].sort());
      expect(Object.isFrozen(TZDB_ZONE1970_IDENTIFIERS)).toBe(true);
      expect(TZDB_ZONE1970_IDENTIFIERS).not.toContain('UTC');
    });

    it('accepts exactly the fixture identifiers plus UTC', () => {
      const expected = new Set([...fromFixture, 'UTC']);
      expect(expected.size).toBe(313);
      for (const zone of expected) {
        expect(isCanonicalTimeZone(zone), zone).toBe(true);
      }
      // Probe identifiers outside the set: none is accepted.
      const outside = ['Etc/UTC', 'Europe/Oslo', 'Asia/Calcutta', 'utc', 'Utc', 'UTC ', ' UTC'];
      for (const zone of outside) {
        expect(expected.has(zone), zone).toBe(false);
        expect(isCanonicalTimeZone(zone), zone).toBe(false);
      }
    });
  });

  it('every accepted identifier is usable by Intl.DateTimeFormat on this Node.js version', () => {
    // Runs on both Node.js 24.22.1 and Node.js 26 in CI: an identifier the runtime
    // cannot process fails here instead of being accepted silently.
    const unusable: string[] = [];
    for (const zone of [...TZDB_ZONE1970_IDENTIFIERS, 'UTC']) {
      try {
        const formatted = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).format(
          new Date('2026-01-15T12:00:00Z'),
        );
        if (formatted === '') unusable.push(zone);
      } catch {
        unusable.push(zone);
      }
    }
    expect(unusable).toEqual([]);
  });
});

describe('AT-SEN-15 (configuration part): the adjustment cannot be disabled', () => {
  it('rejects adjustment.enabled as an unknown key, whatever its value', () => {
    const base = completeTestConfig();
    for (const value of [false, true, 'false']) {
      const result = ValidatedConfigSchema.safeParse(withKey(base, 'adjustment.enabled', value));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    }
  });
});
