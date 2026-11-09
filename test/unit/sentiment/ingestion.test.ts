// Task 13.1: sentiment observation schema, fixture provider, and REST poller (design: Sentiment).
// Tests: AT-SEN-10, AT-SEN-22, AT-SEN-23, AT-SEN-24
// Validates: Requirements 9.1, 9.3, 9.5, 9.6, 9.7, 10.7, 21.2, 21.3, 25.2, 26.3
import { describe, expect, it } from 'vitest';
import {
  FixtureSentimentProvider,
  createSentimentPoller,
  normalizeObservation,
} from '../../../src/sentiment/index.js';
import type { ObservationRejection, SentimentObservation } from '../../../src/sentiment/index.js';
import { LosslessJsonNumber } from '../../../src/shared/index.js';
import type { AttemptOutcome, ProviderError } from '../../../src/shared/index.js';
import { START, drive, harness, http, success } from '../../helpers/resilience.js';

const CONTEXT = {
  provider: 'test-sentiment',
  sourceKind: 'REAL' as const,
  receivedAt: '2026-11-07T12:00:01.000Z',
};
const MESSAGE = {
  messageId: 'm-1',
  ticker: 'AAA',
  value: '-0.6001',
  observedAt: '2026-11-07T11:59:59.5+00:00',
};

describe('normalizeObservation', () => {
  it('normalizes a valid message, keeping the exact value text (AT-SEN-23)', () => {
    expect(normalizeObservation(MESSAGE, CONTEXT)).toEqual({
      ok: true,
      value: {
        provider: 'test-sentiment',
        sourceKind: 'REAL',
        messageId: 'm-1',
        ticker: 'AAA',
        value: '-0.6001',
        observedAt: '2026-11-07T11:59:59.500Z',
        receivedAt: '2026-11-07T12:00:01.000Z',
      },
    });
  });

  it.each(['-1', '1', '0', '-1.0000', '0.250'])('accepts %s unchanged (no clamping)', (value) => {
    const result = normalizeObservation({ ...MESSAGE, value }, CONTEXT);
    expect(result.ok && result.value.value).toBe(value);
  });

  it('accepts a lossless JSON number token by its exact text', () => {
    const result = normalizeObservation({ ...MESSAGE, value: new LosslessJsonNumber('0.10') }, CONTEXT);
    expect(result.ok && result.value.value).toBe('0.10');
  });

  it.each<[string, Record<string, unknown>, ObservationRejection['reason']]>([
    ['above +1', { value: '1.0001' }, 'OUT_OF_RANGE'],
    ['below -1', { value: '-1.5' }, 'OUT_OF_RANGE'],
    ['NaN', { value: 'NaN' }, 'MALFORMED_NUMBER'],
    ['Infinity', { value: 'Infinity' }, 'MALFORMED_NUMBER'],
    ['exponent', { value: '-6e-1' }, 'MALFORMED_NUMBER'],
    ['exponent token', { value: new LosslessJsonNumber('1e-1') }, 'MALFORMED_NUMBER'],
    ['a JSON number', { value: 0.5 }, 'SCHEMA'],
    ['a lowercase ticker', { ticker: 'aaa' }, 'SCHEMA'],
    ['a sourceKind claim', { sourceKind: 'REAL' }, 'SCHEMA'],
    ['an unknown field', { extra: 1 }, 'SCHEMA'],
    ['no offset', { observedAt: '2026-11-07T11:59:59' }, 'SCHEMA'],
    ['microseconds', { observedAt: '2026-11-07T11:59:59.123456Z' }, 'INVALID_TIMESTAMP'],
  ])('rejects %s without echoing the payload (AT-SEN-10)', (_label, overrides, reason) => {
    const result = normalizeObservation({ ...MESSAGE, ...overrides }, CONTEXT);
    expect(result).toMatchObject({ ok: false, error: { code: 'SENTIMENT_INVALID', reason } });
    expect(result.ok ? '' : result.error.message).not.toContain('0.5');
  });

  it('the source kind comes from the provider only (AT-SEN-24)', () => {
    const demo = normalizeObservation(MESSAGE, { ...CONTEXT, sourceKind: 'DEMO' });
    expect(demo.ok && demo.value.sourceKind).toBe('DEMO');
  });
});

function poller(responses: readonly AttemptOutcome<unknown>[], kind: 'REAL' | 'DEMO' = 'REAL') {
  const h = harness({ maxRetries: 1 });
  const provider = new FixtureSentimentProvider({ name: 'test-sentiment', kind, responses });
  const accepted: SentimentObservation[] = [];
  const rejected: ObservationRejection[] = [];
  const errors: ProviderError[] = [];
  const p = createSentimentPoller({
    provider,
    resilientCall: h.rc,
    clock: h.clock,
    sleeper: h.sleeper,
    pollSeconds: 60,
    tickers: () => ['AAA', 'BBB'],
    sink: (o) => accepted.push(o),
    onRejected: (r) => rejected.push(r),
    onProviderError: (e) => errors.push(e),
  });
  return { h, provider, p, accepted, rejected, errors };
}

describe('REST poller', () => {
  it('retrieves through the provider interface, validates, and normalizes (AT-SEN-22)', async () => {
    const s = poller([success([MESSAGE, { ...MESSAGE, messageId: 'm-2', ticker: 'BBB', value: '0.3' }])]);
    expect(await drive(s.h.sleeper, s.p.pollOnce())).toEqual({ accepted: 2, rejected: 0 });
    expect(s.provider.calls).toEqual([['AAA', 'BBB']]);
    expect(s.accepted.map((o) => [o.ticker, o.value, o.receivedAt])).toEqual([
      ['AAA', '-0.6001', START],
      ['BBB', '0.3', START],
    ]);
  });

  it('an invalid message is reported and skipped; the others are delivered (R9.5, R10.7)', async () => {
    const s = poller([success([{ ...MESSAGE, value: '2' }, MESSAGE, 'garbage'])]);
    expect(await drive(s.h.sleeper, s.p.pollOnce())).toEqual({ accepted: 1, rejected: 2 });
    expect(s.rejected.map((r) => r.reason)).toEqual(['OUT_OF_RANGE', 'SCHEMA']);
  });

  it('a payload that is not a list is INVALID_RESPONSE through the resilience layer', async () => {
    const s = poller([success({ not: 'a list' })]);
    const outcome = await drive(s.h.sleeper, s.p.pollOnce());
    expect(outcome).toMatchObject({
      code: 'INVALID_RESPONSE',
      provider: 'test-sentiment',
      operation: 'fetchLatest',
    });
    expect(s.accepted).toEqual([]);
  });

  it('retries a 503 and then succeeds (R25.2)', async () => {
    const s = poller([http(503), success([MESSAGE])]);
    expect(await drive(s.h.sleeper, s.p.pollOnce())).toEqual({ accepted: 1, rejected: 0 });
    expect(s.provider.calls).toHaveLength(2);
  });

  it('a demo provider can never produce REAL observations (AT-SEN-24)', async () => {
    const s = poller([success([MESSAGE])], 'DEMO');
    await drive(s.h.sleeper, s.p.pollOnce());
    expect(s.accepted.map((o) => o.sourceKind)).toEqual(['DEMO']);
  });

  it('run polls every pollSeconds and reports provider errors without stopping', async () => {
    const s = poller([http(404), success([MESSAGE])]);
    const controller = new AbortController();
    const running = s.p.run(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 3; i += 1) {
      s.h.sleeper.advance(60_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    await running;
    expect(s.errors.map((e) => e.code)).toEqual(['HTTP_CLIENT_ERROR']);
    expect(s.accepted.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid settings and a provider without REST support', () => {
    const h = harness();
    const base = {
      resilientCall: h.rc,
      clock: h.clock,
      sleeper: h.sleeper,
      tickers: () => [],
      sink: () => undefined,
      onRejected: () => undefined,
      onProviderError: () => undefined,
    };
    expect(() =>
      createSentimentPoller({ ...base, provider: { name: 'x', kind: 'REAL' }, pollSeconds: 5 }),
    ).toThrow(TypeError);
    expect(() =>
      createSentimentPoller({
        ...base,
        provider: new FixtureSentimentProvider({ name: 'x', kind: 'REAL', responses: [success([])] }),
        pollSeconds: 0,
      }),
    ).toThrow(TypeError);
  });
});
