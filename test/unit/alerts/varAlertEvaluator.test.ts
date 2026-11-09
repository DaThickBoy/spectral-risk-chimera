// Task 16.1: VaR alert evaluator (design: Alerts, evaluation rules).
// Tests: AT-ALR-07, AT-ALR-08, AT-ALR-09, AT-ALR-13, AT-ALR-14, AT-ALR-15, AT-ALR-18
// Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 34.2
import { describe, expect, it } from 'vitest';
import { buildVarAlert, evaluateVarAlert, parseVarAlertSettings } from '../../../src/alerts/index.js';
import type { VarEvaluation } from '../../../src/alerts/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { AT, SETTINGS, entry, input } from '../../helpers/alerts.js';

const evaluated = (evaluation: VarEvaluation) => {
  if (evaluation.kind !== 'EVALUATED') {
    throw new Error(`expected EVALUATED, got ${evaluation.reason}`);
  }
  return evaluation;
};

describe('AT-ALR-07: strictly greater than the threshold', () => {
  it.each([
    ['15', false],
    ['15.0000000001', true],
    ['14.9999999999', false],
  ])('%s%% of NAV against 15%%: breached %s', (pct, breached) => {
    const result = evaluated(evaluateVarAlert(input(pct), SETTINGS));
    expect(result.breached).toBe(breached);
    expect(result.severity).toBe(breached ? 'WARNING' : null);
    expect(result.observedPct).toBe(pct);
  });
});

describe('AT-ALR-08: missing settings give ALERT_CONFIG_MISSING, no default assumed', () => {
  it.each([
    ['alerts.var.thresholdPct', { thresholdPct: undefined }],
    ['alerts.var.metric', { metric: undefined }],
    ['alerts.resetPct', { resetPct: undefined }],
    ['alerts.severity.highRatio', { highRatio: undefined }],
    ['alerts.severity.criticalRatio', { criticalRatio: undefined }],
    ['alerts.cooldownSeconds', { cooldownSeconds: undefined }],
  ])('without %s', (key, change) => {
    const result = evaluateVarAlert(input('90'), { ...SETTINGS, ...change });
    expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'ALERT_CONFIG_MISSING', missingKeys: [key] });
  });

  it('no settings at all lists every key and never evaluates', () => {
    const result = evaluateVarAlert(input('90'), undefined);
    expect(result.kind === 'SKIPPED' && [...result.missingKeys].sort()).toEqual([
      'alerts.cooldownSeconds',
      'alerts.resetPct',
      'alerts.severity.criticalRatio',
      'alerts.severity.highRatio',
      'alerts.var.metric',
      'alerts.var.thresholdPct',
    ]);
  });

  it.each([
    ['threshold 0', { thresholdPct: '0' }, 'alerts.var.thresholdPct'],
    ['threshold above 100', { thresholdPct: '100.01' }, 'alerts.var.thresholdPct'],
    ['threshold in exponent form', { thresholdPct: '1e1' }, 'alerts.var.thresholdPct'],
    ['reset above threshold', { resetPct: '15.01' }, 'alerts.resetPct'],
    ['unknown metric', { metric: 'MAX' }, 'alerts.var.metric'],
    ['high ratio of 1', { highRatio: '1' }, 'alerts.severity.highRatio'],
    ['ratios out of order', { highRatio: '1.5', criticalRatio: '1.5' }, 'alerts.severity.criticalRatio'],
    ['negative cooldown', { cooldownSeconds: -1 }, 'alerts.cooldownSeconds'],
    ['fractional cooldown', { cooldownSeconds: 1.5 }, 'alerts.cooldownSeconds'],
  ])('%s is invalid and not clamped', (_name, change, key) => {
    const result = evaluateVarAlert(input('90'), { ...SETTINGS, ...change });
    expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'ALERT_CONFIG_MISSING' });
    expect(result.kind === 'SKIPPED' && result.invalidKeys).toContain(key);
  });

  it('threshold exactly 100 is valid', () => {
    expect(parseVarAlertSettings({ ...SETTINGS, thresholdPct: '100' }).ok).toBe(true);
  });
});

describe('AT-ALR-09: NAV <= 0 gives NAV_NOT_POSITIVE and no alert', () => {
  it.each([['0'], ['-5']])('NAV %s', (nav) => {
    const result = evaluateVarAlert(
      input('90', '90', {
        nav: brandDecimalString(nav),
        adjustedVaR: {
          validity: 'CURRENT',
          status: 'APPLIED',
          value: { absolute: brandDecimalString('5'), percentOfNav: null },
        },
      }),
      SETTINGS,
    );
    expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'NAV_NOT_POSITIVE' });
  });

  it('a missing NAV is not treated as zero or as positive', () => {
    expect(evaluateVarAlert(input('90', '90', { nav: null }), SETTINGS)).toMatchObject({
      kind: 'SKIPPED',
      reason: 'NAV_NOT_POSITIVE',
    });
  });

  it('a CURRENT figure without percentOfNav and NAV > 0 is FIGURE_INVALID', () => {
    const result = evaluateVarAlert(
      input('90', '90', {
        adjustedVaR: {
          validity: 'CURRENT',
          status: 'APPLIED',
          value: { absolute: brandDecimalString('5'), percentOfNav: null },
        },
      }),
      SETTINGS,
    );
    expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'FIGURE_INVALID' });
  });
});

describe('AT-ALR-13: no evaluation from STALE, LAST_VALID, or UNAVAILABLE figures', () => {
  it.each([
    ['STALE', 'OK'],
    ['LAST_VALID', 'OK'],
    ['UNAVAILABLE', 'INSUFFICIENT_DATA'],
    ['UNAVAILABLE', 'FX_UNAVAILABLE'],
    ['UNAVAILABLE', 'FX_STALE'],
    ['UNAVAILABLE', 'DATA_CONFLICT'],
    ['UNAVAILABLE', 'NO_POSITIONS'],
    ['UNAVAILABLE', 'INVALID_INPUT'],
    ['UNAVAILABLE', 'CONFIG_MISSING'],
  ] as const)('Base metric, %s %s: skipped with the reason recorded', (validity, status) => {
    const result = evaluateVarAlert(input('90', '90', { baseVaR: entry(validity, status, '90') }), {
      ...SETTINGS,
      metric: 'BASE',
    });
    expect(result).toEqual({
      kind: 'SKIPPED',
      portfolioId: 'pf-1',
      reason: 'FIGURE_NOT_CURRENT',
      metric: 'BASE',
      validity,
      figureStatus: status,
      missingKeys: [],
      invalidKeys: [],
    });
  });
});

describe('R30.11: a DEMO_DATA result is never evaluated', () => {
  it.each(['ADJUSTED', 'BASE'])(
    'metric %s: CURRENT figures far above the threshold are skipped as DEMO_DATA',
    (metric) => {
      const result = evaluateVarAlert(input('95', '95', { flags: ['DEMO_DATA'] }), { ...SETTINGS, metric });
      expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'DEMO_DATA', metric });
    },
  );
});

describe('AT-ALR-18: ADJUSTED metric never falls back to Base VaR', () => {
  it.each(['ADJUSTMENT_CONFIG_MISSING', 'SENTIMENT_NOT_CURRENT', 'BASE_UNAVAILABLE'])(
    'Adjusted UNAVAILABLE (%s) with Base far above the threshold: skipped with the adjusted status',
    (status) => {
      const result = evaluateVarAlert(
        input('0', '95', { adjustedVaR: entry('UNAVAILABLE', status) }),
        SETTINGS,
      );
      expect(result).toMatchObject({
        kind: 'SKIPPED',
        reason: 'FIGURE_NOT_CURRENT',
        metric: 'ADJUSTED',
        validity: 'UNAVAILABLE',
        figureStatus: status,
      });
    },
  );

  it('with ADJUSTED the Base entry is never read', () => {
    const base = new Proxy(entry('CURRENT', 'OK', '95'), {
      get: () => {
        throw new Error('Base VaR was read');
      },
    });
    const result = evaluated(evaluateVarAlert(input('16', '95', { baseVaR: base }), SETTINGS));
    expect(result.observedPct).toBe('16');
  });

  it('with BASE the Adjusted figure is ignored', () => {
    const result = evaluated(
      evaluateVarAlert(input('95', '10', { adjustedVaR: entry('UNAVAILABLE', 'SENTIMENT_NOT_CURRENT') }), {
        ...SETTINGS,
        metric: 'BASE',
      }),
    );
    expect(result).toMatchObject({
      metric: 'BASE',
      observedPct: '10',
      breached: false,
      triggeredTickers: [],
    });
  });
});

describe('AT-ALR-14: severity bands at the boundaries', () => {
  // threshold 15: highRatio 1.25 -> 18.75, criticalRatio 1.50 -> 22.5 (hand-calculated).
  it.each([
    ['15.0001', 'WARNING'],
    ['18.7499', 'WARNING'],
    ['18.75', 'HIGH'],
    ['22.4999', 'HIGH'],
    ['22.5', 'CRITICAL'],
    ['100', 'CRITICAL'],
  ])('%s%% of NAV is %s', (pct, severity) => {
    expect(evaluated(evaluateVarAlert(input(pct), SETTINGS)).severity).toBe(severity);
  });

  it('a threshold whose quotient does not terminate still bands exactly (7%: 1.25 x 7 = 8.75)', () => {
    const settings = { ...SETTINGS, thresholdPct: '7', resetPct: '7' };
    expect(evaluated(evaluateVarAlert(input('8.75'), settings)).severity).toBe('HIGH');
    expect(evaluated(evaluateVarAlert(input('8.7499999999'), settings)).severity).toBe('WARNING');
    expect(evaluated(evaluateVarAlert(input('10'), settings)).ratio).toBe(
      '1.428571428571428571428571428571428571429',
    );
  });
});

describe('AT-ALR-15: thresholds per portfolio are applied independently', () => {
  it('the same figure breaches one portfolio threshold and not the other', () => {
    const perPortfolio: Record<string, typeof SETTINGS> = {
      'pf-a': { ...SETTINGS, thresholdPct: '10', resetPct: '10' },
      'pf-b': { ...SETTINGS, thresholdPct: '20', resetPct: '20' },
    };
    const a = evaluated(evaluateVarAlert(input('12', '12', { portfolioId: 'pf-a' }), perPortfolio['pf-a']));
    const b = evaluated(evaluateVarAlert(input('12', '12', { portfolioId: 'pf-b' }), perPortfolio['pf-b']));
    expect([a.breached, a.severity, a.settings.thresholdPct]).toEqual([true, 'WARNING', '10']);
    expect([b.breached, b.severity, b.settings.thresholdPct]).toEqual([false, null, '20']);
  });
});

describe('alert content (R18.6, R19.2, R19.3)', () => {
  it('carries the required fields; describes VaR as a percentile estimate, never a drawdown', () => {
    const result = evaluated(evaluateVarAlert(input('16.5'), SETTINGS));
    const alert = buildVarAlert(result, { severity: 'WARNING', kind: 'NEW' }, 'alert-1', AT);
    expect(alert).toEqual({
      id: 'alert-1',
      type: 'VAR',
      source: 'var-alert-evaluator',
      portfolioId: 'pf-1',
      ticker: null,
      severity: 'WARNING',
      metric: 'ADJUSTED_VAR_PCT_NAV',
      observed: '16.5',
      threshold: '15',
      triggeredTickers: ['AAA', 'BBB'],
      createdAt: AT,
      description:
        'WARNING: Sentiment-Adjusted VaR (1 day, 95% confidence) is 16.5% of NAV, above the 15% threshold. ' +
        'VaR is a percentile-based loss estimate, not a maximum loss or drawdown.',
    });
    expect(alert.description.toLowerCase()).not.toMatch(/maximum drawdown|worst/);
  });
});
