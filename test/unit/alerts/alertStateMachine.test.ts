// Task 16.2: the alert state machine, pure and through the service with persisted alert_state.
// Tests: AT-ALR-01, AT-ALR-02, AT-ALR-03, AT-ALR-04
// Validates: Requirements 34.1, 34.5, 34.6, 18.7
import { describe, expect, it } from 'vitest';
import { INITIAL_ALERT_STATE, transitionAlertState } from '../../../src/alerts/index.js';
import type { AlertSeverity } from '../../../src/alerts/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { AT, alertHarness, entry, input } from '../../helpers/alerts.js';

const COOLDOWN_MS = 900_000;
const obs = (value: string, severity: AlertSeverity | null, at = AT) => ({
  value: brandDecimalString(value),
  severity,
  resetLevel: brandDecimalString('15'),
  cooldownSeconds: 900,
  at,
});

describe('pure transitions', () => {
  it('ARMED fires on a breach; at or below the threshold nothing happens', () => {
    expect(transitionAlertState(INITIAL_ALERT_STATE, obs('15', null))).toEqual({
      action: 'NONE',
      next: INITIAL_ALERT_STATE,
    });
    expect(transitionAlertState(INITIAL_ALERT_STATE, obs('16', 'WARNING'))).toEqual({
      action: 'FIRE',
      kind: 'NEW',
      severity: 'WARNING',
      next: { phase: 'BREACHED', lastSeverity: 'WARNING', lastAlertAt: AT },
    });
  });

  it('BREACHED stays BREACHED between the reset level and the threshold (hysteresis)', () => {
    const breached = { phase: 'BREACHED' as const, lastSeverity: 'WARNING' as const, lastAlertAt: AT };
    const result = transitionAlertState(breached, {
      ...obs('14', null),
      resetLevel: brandDecimalString('12'),
    });
    expect(result).toEqual({ action: 'NONE', next: breached });
    const reset = transitionAlertState(breached, {
      ...obs('12', null),
      resetLevel: brandDecimalString('12'),
    });
    expect(reset.next.phase).toBe('REARMING');
  });

  it('rejects an invalid cooldown or timestamp', () => {
    expect(() =>
      transitionAlertState(INITIAL_ALERT_STATE, { ...obs('1', null), cooldownSeconds: -1 }),
    ).toThrow(TypeError);
    expect(() => transitionAlertState(INITIAL_ALERT_STATE, { ...obs('1', null), at: 'later' })).toThrow(
      TypeError,
    );
  });
});

describe('through the service (persisted alert_state)', () => {
  it('AT-ALR-02: a crossing fires exactly once while the breach continues', () => {
    const h = alertHarness();
    expect(h.service.onRiskResult(input('16'))).toMatchObject({
      status: 'FIRED',
      severity: 'WARNING',
      kind: 'NEW',
    });
    for (const pct of ['16.5', '17', '18.7']) {
      h.clock.advance(60_000);
      expect(h.service.onRiskResult(input(pct))).toEqual({ status: 'SUPPRESSED', cause: 'BREACH_CONTINUES' });
    }
    expect(h.uow.snapshot().alerts).toHaveLength(1);
    expect(h.audit('ALERT_SUPPRESSED')).toHaveLength(3);
  });

  it('AT-ALR-01: within the cooldown a reset and re-cross is suppressed', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16'));
    h.clock.advance(60_000);
    expect(h.service.onRiskResult(input('15'))).toEqual({ status: 'NO_ALERT' }); // reset: at or below 15
    h.clock.advance(60_000);
    expect(h.service.onRiskResult(input('16'))).toEqual({ status: 'SUPPRESSED', cause: 'COOLDOWN' });
    expect(h.uow.snapshot().alerts).toHaveLength(1);
    expect(h.uow.snapshot().alertState).toEqual([expect.objectContaining({ phase: 'REARMING' })]);
  });

  it('AT-ALR-03: reset then re-cross fires again once the cooldown has elapsed', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16'));
    h.service.onRiskResult(input('14'));
    h.clock.advance(COOLDOWN_MS - 1);
    expect(h.service.onRiskResult(input('16'))).toEqual({ status: 'SUPPRESSED', cause: 'COOLDOWN' });
    h.clock.advance(1);
    expect(h.service.onRiskResult(input('16'))).toMatchObject({ status: 'FIRED', kind: 'NEW' });
    expect(h.uow.snapshot().alerts).toHaveLength(2);
  });

  it('AT-ALR-03: after reset, cooldown elapsed and no breach re-arms (ARMED)', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16'));
    h.service.onRiskResult(input('14'));
    h.clock.advance(COOLDOWN_MS);
    h.service.onRiskResult(input('10'));
    expect(h.uow.snapshot().alertState).toEqual([expect.objectContaining({ phase: 'ARMED' })]);
  });

  it('AT-ALR-04: escalation fires a new alert while BREACHED and bypasses the cooldown while REARMING', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16')); // WARNING
    h.clock.advance(1000);
    expect(h.service.onRiskResult(input('19'))).toMatchObject({
      status: 'FIRED',
      severity: 'HIGH',
      kind: 'ESCALATION',
    });
    h.clock.advance(1000);
    expect(h.service.onRiskResult(input('17'))).toEqual({ status: 'SUPPRESSED', cause: 'BREACH_CONTINUES' }); // lower
    h.service.onRiskResult(input('10')); // reset -> REARMING
    h.clock.advance(1000);
    expect(h.service.onRiskResult(input('19'))).toEqual({ status: 'SUPPRESSED', cause: 'COOLDOWN' }); // HIGH again
    expect(h.service.onRiskResult(input('23'))).toMatchObject({
      status: 'FIRED',
      severity: 'CRITICAL',
      kind: 'ESCALATION',
    });
    expect(h.uow.snapshot().alerts.map((a) => a.severity)).toEqual(['WARNING', 'HIGH', 'CRITICAL']);
  });

  it('a restart does not re-fire an open breach (state is read from alert_state)', () => {
    const first = alertHarness();
    first.service.onRiskResult(input('16'));
    const restarted = alertHarness({ uow: first.uow, clock: first.clock, idPrefix: 'after-restart' });
    first.clock.advance(COOLDOWN_MS * 10);
    expect(restarted.service.onRiskResult(input('17'))).toEqual({
      status: 'SUPPRESSED',
      cause: 'BREACH_CONTINUES',
    });
    expect(first.uow.snapshot().alerts).toHaveLength(1);
  });

  it('R18.7: skipped evaluations never advance the state (no fire, escalation, or re-arm) and are audited', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16'));
    h.service.onRiskResult(input('10')); // REARMING
    const state = h.uow.snapshot().alertState;
    h.clock.advance(COOLDOWN_MS * 2);
    const unavailable = input('0', '95', { adjustedVaR: entry('UNAVAILABLE', 'SENTIMENT_NOT_CURRENT') });
    expect(h.service.onRiskResult(unavailable)).toEqual({ status: 'SKIPPED', reason: 'FIGURE_NOT_CURRENT' });
    expect(h.uow.snapshot().alertState).toEqual(state); // still REARMING, not ARMED
    expect(h.audit('ALERT_SKIPPED')).toEqual([
      expect.objectContaining({
        category: 'ALERT',
        subject: 'pf-1',
        details: {
          alertType: 'VAR',
          reason: 'FIGURE_NOT_CURRENT',
          metric: 'ADJUSTED',
          validity: 'UNAVAILABLE',
          figureStatus: 'SENTIMENT_NOT_CURRENT',
          missingKeys: '',
          invalidKeys: '',
        },
      }),
    ]);
  });

  it('VAR state is kept per portfolio key', () => {
    const h = alertHarness({
      settings: {
        'pf-1': {
          thresholdPct: '15',
          metric: 'BASE',
          resetPct: '15',
          highRatio: '1.25',
          criticalRatio: '1.50',
          cooldownSeconds: 900,
        },
        'pf-2': {
          thresholdPct: '15',
          metric: 'BASE',
          resetPct: '15',
          highRatio: '1.25',
          criticalRatio: '1.50',
          cooldownSeconds: 900,
        },
      },
    });
    expect(h.service.onRiskResult(input('16'))).toMatchObject({ status: 'FIRED' });
    expect(h.service.onRiskResult(input('16', '16', { portfolioId: 'pf-2' }))).toMatchObject({
      status: 'FIRED',
    });
    expect(h.uow.snapshot().alertState.map((s) => [s.type, s.portfolioId, s.ticker])).toEqual([
      ['VAR', 'pf-1', null],
      ['VAR', 'pf-2', null],
    ]);
  });

  it('a commit failure gives COMMIT_FAILED, never throws, and changes nothing', () => {
    const h = alertHarness();
    h.uow.failNextCommit({ atWrite: 0 });
    expect(h.service.onRiskResult(input('16'))).toEqual({ status: 'COMMIT_FAILED' });
    expect(h.uow.snapshot().alerts).toEqual([]);
    expect(h.uow.snapshot().alertState).toEqual([]);
    expect(h.service.onRiskResult(input('16'))).toMatchObject({ status: 'FIRED' }); // the breach is not lost
  });
});
