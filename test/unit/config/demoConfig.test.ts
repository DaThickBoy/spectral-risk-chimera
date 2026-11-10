// Kiroween decision H3: the separate demo configuration, the demo profile marker, fx.provider
// (AT-FX-17), the ECB cross-key rule, and the provisional fx.ecb.* settings.
// Validates: Requirements 14.14, 30.3, 25.7
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  DEMO_PROFILE,
  FINANCIAL_KEYS,
  ValidatedConfigSchema,
  keyMeta,
  loadConfig,
} from '../../../src/config/index.js';
import { captureLogger, completeTestConfig, withKey, writeConfig } from '../../helpers/config.js';
import { repoPath, tempDir } from '../../helpers/repo.js';

const DEMO_FILE = repoPath('config', 'demo', 'kiroween-2026.demo.jsonc');
const TEMPLATE = repoPath('config', 'config.template.jsonc');
const valid = (config: unknown): boolean => ValidatedConfigSchema.safeParse(config).success;
/** DR-KW-1 H3: approved for the hackathon demo only. */
const H3_KEYS = [
  'fx.maxRateAgeSeconds',
  'marketData.maxStalenessDays',
  'marketData.maxReturnGapDays',
  'recalc.minValueChangePct',
  'import.oversellPolicy',
];
/** DR-KW-1 H9 (Kiroween A1): approved for the hackathon demo only, for display-only DEMO sentiment. */
const H9_KEYS = ['sentiment.maxAgeSeconds', 'sentiment.windowSeconds', 'sentiment.maxFutureSkewSeconds'];
const DEMO_APPROVED_KEYS = [...H3_KEYS, ...H9_KEYS];

function load(content: unknown) {
  const temp = tempDir('demo-config');
  try {
    const { logger } = captureLogger();
    return loadConfig({ srcConfigFile: writeConfig(temp.dir, 'config.json', content), logger });
  } finally {
    temp.cleanup();
  }
}

describe('the committed demo configuration (H3)', () => {
  const { logger } = captureLogger();
  const result = loadConfig({ srcConfigFile: DEMO_FILE, logger });

  it('loads without invalid or unknown keys and carries the demo profile', () => {
    expect(result.file.status).toBe('LOADED');
    expect(result.invalidKeys).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
    expect(result.values['demo']).toEqual({
      profile: DEMO_PROFILE,
      provisionalKeys: DEMO_APPROVED_KEYS,
    });
  });

  it('makes the EUR base with the ECB provider explicit (H2)', () => {
    expect(result.values['fx']).toMatchObject({
      baseCurrency: 'EUR',
      supportedCurrencies: ['EUR', 'GBP', 'USD'],
      provider: 'ECB',
    });
  });

  it('carries exactly the five H3 and three H9 approved demo values, all listed as provisional', () => {
    expect(result.values['fx']).toMatchObject({ maxRateAgeSeconds: 345_600 });
    expect(result.values['marketData']).toEqual({ maxStalenessDays: 5, maxReturnGapDays: 5 });
    expect(result.values['recalc']).toEqual({ minValueChangePct: '0.10' });
    expect(result.values['import']).toMatchObject({ oversellPolicy: 'REJECT' });
    // H9: the approved demo sentiment settings (plus the loader's documented operational reconnect
    // defaults); no REST polling setting, so no sentiment provider is ever polled.
    expect(result.values['sentiment']).toMatchObject({
      maxAgeSeconds: 900,
      windowSeconds: 300,
      maxFutureSkewSeconds: 5,
    });
    expect(result.values['sentiment']).not.toHaveProperty('rest');
    expect(result.features.baseVaR).toMatchObject({ available: true, missingKeys: [] });
    expect(result.features.import.available).toBe(true);
    // Only the approved baselines, the explicit H2/H6 decisions, and the eight demo values are filled in.
    const filled = FINANCIAL_KEYS.filter((key) => result.keys[key].status === 'VALID');
    expect(filled.sort()).toEqual(
      [
        'adjustment.bearishThreshold',
        'adjustment.multiplier',
        'alerts.var.metric',
        'fx.baseCurrency',
        'fx.provider',
        'fx.supportedCurrencies',
        'var.confidence',
        'var.horizonDays',
        'var.lookbackReturns',
        'var.minObservations',
        ...DEMO_APPROVED_KEYS,
      ].sort(),
    );
  });

  it('leaves every other unapproved value empty (no alert thresholds, filing, or time zone)', () => {
    expect(result.missingFinancialKeys).toEqual(
      expect.arrayContaining(['alerts.var.thresholdPct', 'filing.maxAgeDays', 'import.defaultTimezone']),
    );
    expect(result.missingFinancialKeys).not.toEqual(expect.arrayContaining(H9_KEYS));
    // H9: the adjustment settings are complete, so eligibility decides. DEMO sentiment is never
    // eligible (R15), so Adjusted VaR stays unavailable at run time (H7). Alerts stay disabled.
    expect(result.features.adjustedVaR).toMatchObject({ available: true, missingKeys: [] });
    expect(result.features.varAlerts.available).toBe(false);
  });

  it('the template carries none of the demo values', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    for (const key of [
      'maxRateAgeSeconds',
      'maxStalenessDays',
      'maxReturnGapDays',
      'minValueChangePct',
      'oversellPolicy',
      'maxAgeSeconds',
      'windowSeconds',
      'maxFutureSkewSeconds',
    ]) {
      expect(template).toMatch(new RegExp(`"${key}": null`));
    }
  });

  it('the template has no demo section and no fx.provider value', () => {
    const template = readFileSync(TEMPLATE, 'utf8');
    expect(template).not.toMatch(/"demo"\s*:/);
    expect(template).toMatch(/"provider": null/);
  });
});

describe('demo profile marker', () => {
  it('demo.* keys are operational, optional, and drive no feature', () => {
    for (const key of ['demo.profile', 'demo.provisionalKeys'] as const) {
      expect(keyMeta(key)).toEqual({ cls: 'O', features: [], optional: true });
    }
    expect(FINANCIAL_KEYS.some((key) => key.startsWith('demo.'))).toBe(false);
  });

  it('accepts the profile with known provisional keys, and its absence', () => {
    expect(valid(completeTestConfig())).toBe(true);
    expect(
      valid(
        withKey(completeTestConfig(), 'demo', {
          profile: DEMO_PROFILE,
          provisionalKeys: ['fx.maxRateAgeSeconds'],
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['another profile', { profile: 'PRODUCTION' }],
    ['an unknown provisional key', { profile: DEMO_PROFILE, provisionalKeys: ['fx.maxAge'] }],
    ['a demo key as provisional', { profile: DEMO_PROFILE, provisionalKeys: ['demo.profile'] }],
    [
      'duplicate provisional keys',
      { profile: DEMO_PROFILE, provisionalKeys: ['fx.provider', 'fx.provider'] },
    ],
    ['an unknown demo field', { profile: DEMO_PROFILE, defaults: {} }],
  ])('rejects %s', (_name, demo) => {
    const config = withKey(completeTestConfig(), 'demo', demo);
    expect(valid(config)).toBe(false);
    expect(load(config).invalidKeys.length).toBeGreaterThan(0);
  });

  it('every provisional key names a real configuration key', () => {
    expect(CONFIG_KEYS).toContain('fx.maxRateAgeSeconds');
  });
});

describe('AT-FX-17: fx.provider', () => {
  it('a missing fx.provider gives CONFIG_MISSING for Base VaR (reported by key)', () => {
    const result = load(withKey(completeTestConfig(), 'fx.provider', undefined));
    expect(result.keys['fx.provider'].status).toBe('MISSING');
    expect(result.features.baseVaR).toMatchObject({ available: false, missingKeys: ['fx.provider'] });
  });

  it('accepts FIXTURE and ECB (with the EUR base) and nothing else', () => {
    expect(valid(withKey(completeTestConfig(), 'fx.provider', 'FIXTURE'))).toBe(true);
    const eur = withKey(
      withKey(withKey(completeTestConfig(), 'fx.baseCurrency', 'EUR'), 'fx.supportedCurrencies', [
        'EUR',
        'USD',
      ]),
      'fx.provider',
      'ECB',
    );
    expect(valid(eur)).toBe(true);
    expect(valid(withKey(completeTestConfig(), 'fx.provider', 'ecb'))).toBe(false);
    expect(valid(withKey(completeTestConfig(), 'fx.provider', 'OPENEXCHANGE'))).toBe(false);
  });

  it('ECB with a base other than EUR is invalid configuration (ECB_REQUIRES_EUR_BASE)', () => {
    const config = withKey(completeTestConfig(), 'fx.provider', 'ECB'); // base USD
    expect(valid(config)).toBe(false);
    const result = load(config);
    expect(result.keys['fx.provider']).toMatchObject({
      status: 'INVALID',
      message: 'fx.provider ECB requires fx.baseCurrency EUR',
    });
    expect(result.features.baseVaR.available).toBe(false);
  });
});

describe('fx.ecb.* operational settings (provisional, OD-6)', () => {
  it('take their documented provisional defaults', () => {
    const result = load(completeTestConfig());
    expect(result.values['fx']).toMatchObject({
      ecb: { timeoutMs: 10_000, maxResponseBytes: 1_048_576, cacheMaxEntries: 64 },
    });
    for (const key of ['fx.ecb.timeoutMs', 'fx.ecb.maxResponseBytes', 'fx.ecb.cacheMaxEntries'] as const) {
      expect(result.defaultsApplied).toContainEqual(expect.objectContaining({ key, provisional: true }));
    }
  });

  it.each([
    ['fx.ecb.timeoutMs', 5000, 0],
    ['fx.ecb.maxResponseBytes', 1, 1.5],
    ['fx.ecb.cacheMaxEntries', 1, 0],
  ] as const)('%s accepts %j and rejects %j', (key, good, bad) => {
    expect(valid(withKey(completeTestConfig(), key, good))).toBe(true);
    expect(valid(withKey(completeTestConfig(), key, bad))).toBe(false);
  });
});
