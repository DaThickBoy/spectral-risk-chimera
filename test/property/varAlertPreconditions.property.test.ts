// Validates: Requirements 18.1, 18.2, 18.5, 18.7, 34.2
// Property 34: Alert preconditions (evaluator part; the "never advances the state machine and
// each skip is audited" part runs in test/property/alertStateMachine.property.test.ts).
// The reference decides with exact BigInt fractions, not Decimal.js.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateVarAlert } from '../../src/alerts/index.js';
import type { VarAlertInput, VarAlertSettingsInput, VarEntryInput } from '../../src/alerts/index.js';
import type { Validity } from '../../src/risk/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import { AT } from '../helpers/alerts.js';
import { compareFractions, fraction, parseDecimalText } from '../helpers/rational.js';
import type { Fraction } from '../helpers/rational.js';

const VALIDITIES: readonly Validity[] = ['CURRENT', 'STALE', 'LAST_VALID', 'UNAVAILABLE'];
const pctArb = fc
  .tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`);

const entryArb: fc.Arbitrary<VarEntryInput> = fc
  .tuple(
    fc.constantFrom(...VALIDITIES),
    fc.constantFrom('OK', 'APPLIED', 'SENTIMENT_NOT_CURRENT', 'FX_STALE'),
    pctArb,
  )
  .map(([validity, status, pct]) => ({
    validity,
    status,
    value:
      validity === 'UNAVAILABLE'
        ? null
        : { absolute: brandDecimalString('1'), percentOfNav: brandDecimalString(pct) },
  }));

const settingsArb: fc.Arbitrary<VarAlertSettingsInput> = fc
  .record({
    threshold: fc.integer({ min: 1, max: 10_000 }), // hundredths of a percent: 0.01 to 100
    resetBelow: fc.integer({ min: 0, max: 500 }),
    high: fc.integer({ min: 101, max: 199 }),
    criticalExtra: fc.integer({ min: 1, max: 100 }),
    metric: fc.constantFrom('ADJUSTED', 'BASE'),
    drop: fc.option(
      fc.constantFrom('thresholdPct', 'metric', 'resetPct') as fc.Arbitrary<
        'thresholdPct' | 'metric' | 'resetPct'
      >,
      {
        nil: undefined,
        freq: 5,
      },
    ),
  })
  .map(({ threshold, resetBelow, high, criticalExtra, metric, drop }) => {
    const hundredths = (n: number): string => `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
    const settings: VarAlertSettingsInput = {
      thresholdPct: hundredths(threshold),
      resetPct: hundredths(Math.max(0, threshold - resetBelow)),
      metric,
      highRatio: hundredths(high),
      criticalRatio: hundredths(high + criticalExtra),
      cooldownSeconds: 900,
    };
    return drop === undefined ? settings : { ...settings, [drop]: undefined };
  });

const inputArb: fc.Arbitrary<VarAlertInput> = fc
  .record({
    base: entryArb,
    adjusted: entryArb,
    nav: fc.constantFrom('1000', '0', '-10', null),
    demo: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  })
  .map(({ base, adjusted, nav, demo }) => ({
    portfolioId: 'pf-1',
    calculatedAt: AT,
    nav: nav === null ? null : brandDecimalString(nav),
    confidence: brandDecimalString('0.95'),
    baseVaR: base,
    adjustedVaR: adjusted,
    triggeredTickers: [],
    flags: demo ? ['DEMO_DATA', 'REDUCED_LOOKBACK'] : [],
  }));

const f = (text: string | undefined): Fraction => parseDecimalText(text ?? '0');
const times = (a: Fraction, b: Fraction): Fraction => fraction(a.num * b.num, a.den * b.den);

describe('Property 34: Alert preconditions', () => {
  it('evaluates only with complete settings, a CURRENT selected figure, and NAV > 0; bands match the exact reference', () => {
    fc.assert(
      fc.property(inputArb, settingsArb, (input, settings) => {
        const result = evaluateVarAlert(input, settings);
        const complete =
          settings.thresholdPct !== undefined &&
          settings.metric !== undefined &&
          settings.resetPct !== undefined;
        if (!complete) {
          expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'ALERT_CONFIG_MISSING' });
          return;
        }
        if (input.flags.includes('DEMO_DATA')) {
          expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'DEMO_DATA' });
          return;
        }
        const selected = settings.metric === 'ADJUSTED' ? input.adjustedVaR : input.baseVaR;
        if (selected.validity !== 'CURRENT') {
          expect(result).toMatchObject({
            kind: 'SKIPPED',
            reason: 'FIGURE_NOT_CURRENT',
            validity: selected.validity,
            figureStatus: selected.status,
          });
          return;
        }
        if (input.nav === null || compareFractions(f(input.nav), fraction(0n, 1n)) <= 0) {
          expect(result).toMatchObject({ kind: 'SKIPPED', reason: 'NAV_NOT_POSITIVE' });
          return;
        }
        expect(result.kind).toBe('EVALUATED');
        if (result.kind !== 'EVALUATED') return;
        const observed = f(selected.value?.percentOfNav ?? undefined);
        const threshold = f(settings.thresholdPct);
        expect(result.observedPct).toBe(selected.value?.percentOfNav);
        let expected: string | null = null;
        if (compareFractions(observed, threshold) > 0) {
          expected = 'WARNING';
          if (compareFractions(observed, times(f(settings.highRatio), threshold)) >= 0) expected = 'HIGH';
          if (compareFractions(observed, times(f(settings.criticalRatio), threshold)) >= 0)
            expected = 'CRITICAL';
        }
        expect(result.severity).toBe(expected);
        expect(result.breached).toBe(expected !== null);
      }),
      { numRuns: 2000 },
    );
  });

  it('with ADJUSTED, the Base entry never changes the outcome (no fallback)', () => {
    fc.assert(
      fc.property(inputArb, entryArb, settingsArb, (input, otherBase, settings) => {
        const adjusted = { ...settings, metric: 'ADJUSTED' };
        expect(evaluateVarAlert({ ...input, baseVaR: otherBase }, adjusted)).toEqual(
          evaluateVarAlert(input, adjusted),
        );
      }),
      { numRuns: 1000 },
    );
  });
});
