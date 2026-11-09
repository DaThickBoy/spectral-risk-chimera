// Task 19.2: the guard's DNS deadline classification. A resolver TIMEOUT or the caller's deadline
// is SEC_DNS_TIMEOUT (no security event, never DNS_FAILED); genuine DNS failures within the
// deadline stay DNS_FAILED with their event; after the deadline only a genuine address-policy
// rejection is still recorded.
// Validates: Requirements 29.9, 29.14, 33.6
import { describe, expect, it } from 'vitest';
import { createSecUrlGuard } from '../../../src/sec/index.js';
import type {
  DnsFamilyAnswer,
  DnsQueryContext,
  SecAllowedHost,
  ValidatedSecUrl,
} from '../../../src/sec/index.js';
import { FakeClock } from '../../../src/shared/index.js';
import {
  ERROR,
  NOW,
  NO_DATA,
  fakeResolver,
  guardWith,
  records,
  recordingSink,
} from '../../helpers/secGuard.js';

const TIMEOUT: DnsFamilyAnswer = { status: 'TIMEOUT' };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function validated(url: string): ValidatedSecUrl {
  const result = guardWith().guard.validate(url);
  if (!result.ok) {
    throw new Error('fixture must validate');
  }
  return result.value;
}

const context = (controller = new AbortController(), timeoutMs = 5_000): DnsQueryContext => ({
  signal: controller.signal,
  timeoutMs,
});

describe('resolver TIMEOUT answers', () => {
  it.each([
    ['A TIMEOUT + AAAA records', TIMEOUT, records('2001:4860:4860::8888')],
    ['A records + AAAA TIMEOUT', records('8.8.8.8'), TIMEOUT],
    ['A TIMEOUT + AAAA TIMEOUT', TIMEOUT, TIMEOUT],
    ['A TIMEOUT + AAAA NO_DATA (not DNS_EMPTY)', TIMEOUT, NO_DATA],
  ] as const)('%s is SEC_DNS_TIMEOUT with no security event', async (_label, v4, v6) => {
    for (const withContext of [false, true]) {
      const { guard, sink } = guardWith(fakeResolver(v4, v6));
      const url = validated('https://www.sec.gov/');
      const result = await (withContext ? guard.resolveAndCheck(url, context()) : guard.resolveAndCheck(url));
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'SEC_DNS_TIMEOUT',
          message: 'SEC DNS resolution timed out.',
          reason: 'DNS_TIMEOUT',
          stage: 'RESOLVE',
        },
      });
      expect(sink.events).toEqual([]);
    }
  });

  it.each([
    ['A ERROR + AAAA TIMEOUT', ERROR, TIMEOUT, 'DNS_FAILED'],
    ['A TIMEOUT + AAAA malformed', TIMEOUT, records('not-an-address'), 'DNS_FAILED'],
    ['A TIMEOUT + AAAA empty list', TIMEOUT, records(), 'DNS_FAILED'],
    ['A prohibited + AAAA TIMEOUT', records('10.0.0.1'), TIMEOUT, 'ADDRESS_PROHIBITED'],
  ] as const)('%s is a genuine rejection (%s) with its event', async (_label, v4, v6, reason) => {
    const { guard, sink } = guardWith(fakeResolver(v4, v6));
    const result = await guard.resolveAndCheck(validated('https://www.sec.gov/'), context());
    expect(!result.ok && result.error).toMatchObject({
      code: 'SEC_URL_REJECTED',
      reason,
      securityEvent: 'RECORDED',
    });
    expect(sink.events.map((event) => event.reason)).toEqual([reason]);
  });
});

/** A resolver whose answers the test releases by hand, recording the contexts it received. */
function deferredResolver() {
  const pending: { family: 4 | 6; context?: DnsQueryContext; answer: (a: DnsFamilyAnswer) => void }[] = [];
  return {
    pending,
    resolver: {
      resolve: (_hostname: SecAllowedHost, family: 4 | 6, ctx?: DnsQueryContext) =>
        new Promise<DnsFamilyAnswer>((answer) => {
          pending.push({ family, ...(ctx === undefined ? {} : { context: ctx }), answer });
        }),
    },
  };
}

describe('the caller deadline', () => {
  const setup = () => {
    const { pending, resolver } = deferredResolver();
    const sink = recordingSink();
    const guard = createSecUrlGuard({ resolver, sink, clock: new FakeClock(NOW) });
    return { pending, sink, guard };
  };

  it('passes the same context to both lookups', async () => {
    const { pending, guard } = setup();
    const ctx = context(new AbortController(), 1_234);
    const result = guard.resolveAndCheck(validated('https://www.sec.gov/'), ctx);
    await flush();
    expect(pending.map((p) => [p.family, p.context])).toEqual([
      [4, ctx],
      [6, ctx],
    ]);
    pending[0]?.answer(records('8.8.8.8'));
    pending[1]?.answer(NO_DATA);
    expect((await result).ok).toBe(true);
  });

  it('an already aborted signal is SEC_DNS_TIMEOUT with no lookup and no event', async () => {
    const { pending, sink, guard } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await guard.resolveAndCheck(validated('https://www.sec.gov/'), context(controller));
    expect(!result.ok && result.error.code).toBe('SEC_DNS_TIMEOUT');
    expect(pending).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  it('aborting before the answers returns SEC_DNS_TIMEOUT at once', async () => {
    const { pending, sink, guard } = setup();
    const controller = new AbortController();
    const result = guard.resolveAndCheck(validated('https://www.sec.gov/'), context(controller));
    await flush();
    pending[0]?.answer(records('8.8.8.8'));
    controller.abort();
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'SEC_DNS_TIMEOUT', reason: 'DNS_TIMEOUT' },
    });
    expect(sink.events).toEqual([]);
  });

  it.each([
    ['ERROR (DNS_FAILED)', ERROR, records('2001:4860:4860::8888')],
    ['a malformed answer (DNS_FAILED)', records('8.8.8.8'), records()],
    ['no records (DNS_EMPTY)', NO_DATA, NO_DATA],
    ['TIMEOUT', TIMEOUT, TIMEOUT],
    ['public records', records('8.8.8.8'), NO_DATA],
  ] as const)('late %s after the deadline records nothing', async (_label, v4, v6) => {
    const { pending, sink, guard } = setup();
    const controller = new AbortController();
    const result = guard.resolveAndCheck(validated('https://www.sec.gov/'), context(controller));
    await flush();
    controller.abort();
    expect(!(await result).ok).toBe(true);
    pending[0]?.answer(v4);
    pending[1]?.answer(v6);
    await flush();
    expect(sink.events).toEqual([]);
  });

  it('a late prohibited address after the deadline is still recorded once as ADDRESS_PROHIBITED', async () => {
    const { pending, sink, guard } = setup();
    const controller = new AbortController();
    const result = guard.resolveAndCheck(validated('https://data.sec.gov/x'), context(controller));
    await flush();
    controller.abort();
    expect(await result).toMatchObject({ ok: false, error: { code: 'SEC_DNS_TIMEOUT' } });
    pending[0]?.answer(records('8.8.8.8', '127.0.0.1'));
    pending[1]?.answer(records('::1'));
    await flush();
    expect(sink.events).toEqual([
      {
        type: 'SEC_URL_REJECTED',
        reason: 'ADDRESS_PROHIBITED',
        stage: 'RESOLVE',
        at: NOW,
        hostname: 'data.sec.gov',
        prohibitedAddresses: ['127.0.0.1', '::1'],
      },
    ]);
  });

  it('a genuine failure within the deadline is DNS_FAILED with its event', async () => {
    const { pending, sink, guard } = setup();
    const result = guard.resolveAndCheck(validated('https://www.sec.gov/'), context());
    await flush();
    pending[0]?.answer(ERROR);
    pending[1]?.answer(records('2001:4860:4860::8888'));
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'SEC_URL_REJECTED', reason: 'DNS_FAILED' },
    });
    expect(sink.events.map((event) => event.reason)).toEqual(['DNS_FAILED']);
  });
});
