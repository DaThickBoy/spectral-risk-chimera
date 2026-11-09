// Validates: Requirements 34.5, 34.6, 18.1, 18.7
// Property 32: Alert fires once per episode. Model-based: random metric sequences (with skipped,
// unavailable results mixed in) run through the service with persisted alert_state, compared
// with an independent reference model that decides with exact BigInt fractions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { brandDecimalString } from '../../src/shared/index.js';
import { SETTINGS, alertHarness, entry, input } from '../helpers/alerts.js';
import { compareFractions, fraction, parseDecimalText } from '../helpers/rational.js';

type Severity = 'WARNING' | 'HIGH' | 'CRITICAL';
const RANK: Record<Severity, number> = { WARNING: 1, HIGH: 2, CRITICAL: 3 };

interface Step {
  readonly pct: string;
  readonly advanceMs: number;
  readonly unavailable: boolean;
}

// Values around the threshold 15, the reset level 12, and the bands 18.75 and 22.5.
const pctArb = fc.constantFrom(
  '0',
  '11.99',
  '12',
  '12.01',
  '14.99',
  '15',
  '15.01',
  '18.74',
  '18.75',
  '22.49',
  '22.5',
  '40',
);
const stepArb: fc.Arbitrary<Step> = fc.record({
  pct: pctArb,
  advanceMs: fc.constantFrom(0, 1000, 299_999, 300_000, 600_000),
  unavailable: fc.integer({ min: 0, max: 9 }).map((n) => n < 2),
});

const COOLDOWN_MS = 300_000;
const settings = { ...SETTINGS, resetPct: '12', cooldownSeconds: 300 };
const f = parseDecimalText;
const times = (a: string, b: string) => {
  const x = f(a);
  const y = f(b);
  return fraction(x.num * y.num, x.den * y.den);
};

function referenceSeverity(pct: string): Severity | null {
  const p = f(pct);
  if (compareFractions(p, f('15')) <= 0) return null;
  if (compareFractions(p, times('1.50', '15')) >= 0) return 'CRITICAL';
  if (compareFractions(p, times('1.25', '15')) >= 0) return 'HIGH';
  return 'WARNING';
}

describe('Property 32: Alert fires once per episode', () => {
  it('the service fires exactly when the reference model does; skips never change the state', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        const h = alertHarness({ settings: { 'pf-1': settings } });
        let phase: 'ARMED' | 'BREACHED' | 'REARMING' = 'ARMED';
        let lastSeverity: Severity | null = null;
        let lastAt: number | null = null;
        let now = 0;
        let skips = 0;
        for (const step of steps) {
          h.clock.advance(step.advanceMs);
          now += step.advanceMs;
          if (step.unavailable) {
            const before = h.uow.snapshot().alertState;
            const outcome = h.service.onRiskResult(
              input('0', '99', { adjustedVaR: entry('UNAVAILABLE', 'SENTIMENT_NOT_CURRENT') }),
            );
            expect(outcome.status).toBe('SKIPPED');
            expect(h.uow.snapshot().alertState).toEqual(before);
            skips += 1;
            expect(h.audit('ALERT_SKIPPED')).toHaveLength(skips); // Property 34: every skip is audited
            continue;
          }
          const severity = referenceSeverity(step.pct);
          const cooled = lastAt === null || now - lastAt >= COOLDOWN_MS;
          const higher = severity !== null && (lastSeverity === null || RANK[severity] > RANK[lastSeverity]);
          let expectFire = false;
          if (phase === 'ARMED') {
            expectFire = severity !== null;
          } else if (phase === 'BREACHED') {
            if (severity !== null) expectFire = higher;
            else if (compareFractions(f(step.pct), f('12')) <= 0) phase = 'REARMING';
          } else if (severity !== null) {
            expectFire = higher || cooled;
          } else if (cooled) {
            phase = 'ARMED';
          }
          if (expectFire && severity !== null) {
            phase = 'BREACHED';
            lastSeverity = severity;
            lastAt = now;
          }
          const outcome = h.service.onRiskResult(input(step.pct));
          expect(outcome.status === 'FIRED').toBe(expectFire);
          if (outcome.status === 'FIRED') {
            expect(outcome.severity).toBe(severity);
          }
          if (step.pct === '15') {
            expect(outcome.status).not.toBe('FIRED'); // equality never alerts
          }
          expect(h.uow.snapshot().alertState[0]?.phase ?? 'ARMED').toBe(phase);
        }
        // Within one episode (between resets) no severity level fires twice.
        const alerts = h.uow.snapshot().alerts;
        for (let i = 1; i < alerts.length; i += 1) {
          const previous = alerts[i - 1];
          const current = alerts[i];
          if (previous === undefined || current === undefined) continue;
          const gap = Date.parse(current.createdAt) - Date.parse(previous.createdAt);
          if (RANK[current.severity] <= RANK[previous.severity]) {
            expect(gap).toBeGreaterThanOrEqual(COOLDOWN_MS); // a repeat level needs a reset and the cooldown
          }
        }
        expect(alerts.every((a) => a.observed !== brandDecimalString('15'))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });
});
