// Task 15.1: the /stream hub over fake clients: validation before sending, a bounded unsent
// buffer per client, bounded clients, and a publisher that is never interrupted by a client.
// Validates: Requirements 10.5, 16.7, 25.1, 26.9
import { describe, expect, it } from 'vitest';
import { createStreamHub } from '../../../src/api/index.js';
import type { StreamClient } from '../../../src/api/index.js';
import type { StreamEvent } from '../../../src/shared/index.js';
import { capturingLogger } from '../../helpers/api.js';

const T0 = '2026-11-08T12:00:00.000Z';

class FakeClient implements StreamClient {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  terminated = false;
  failSend = false;
  /** When false, sent bytes stay buffered (a client that stops reading). */
  constructor(private readonly drains = true) {}
  send(data: string): void {
    if (this.failSend) {
      throw new Error('socket gone');
    }
    this.sent.push(data);
    if (!this.drains) {
      this.bufferedAmount += Buffer.byteLength(data);
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

const status: StreamEvent = {
  type: 'ProviderStatus',
  providers: [{ provider: 'fx:a', state: 'AVAILABLE', circuit: 'CLOSED', since: T0 }],
};
const size = Buffer.byteLength(JSON.stringify(status));

function setup(maxBufferedBytes: number, maxClients = 4) {
  const { logger, lines } = capturingLogger();
  return { hub: createStreamHub({ logger, maxClients, maxBufferedBytes }), lines };
}

describe('stream hub', () => {
  it('sends the validated event text to every client', () => {
    const { hub } = setup(10_000);
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a);
    hub.add(b);
    expect(hub.publish(status)).toEqual({ ok: true, delivered: 2, dropped: 0 });
    expect(a.sent).toEqual([JSON.stringify(status)]);
    expect(b.sent).toEqual(a.sent);
  });

  it('refuses an event that fails the contract (a JSON number value) and sends nothing', () => {
    const { hub, lines } = setup(10_000);
    const a = new FakeClient();
    hub.add(a);
    const bad = {
      type: 'SentimentUpdate',
      ticker: 'AAA',
      index: null,
      latest: {
        value: 0.5,
        observedAt: T0,
        receivedAt: T0,
        provider: 'p',
        sourceKind: 'REAL',
        status: 'CURRENT',
      },
    } as unknown as StreamEvent;
    expect(hub.publish(bad)).toEqual({ ok: false, code: 'EVENT_INVALID' });
    expect(a.sent).toEqual([]);
    const logged = lines.find((line) => line.msg === 'stream.event_invalid');
    expect(logged).toMatchObject({ type: 'SentimentUpdate' });
    expect(JSON.stringify(logged)).not.toContain('0.5');
  });

  it('a client may hold exactly maxBufferedBytes unsent; one byte more drops it, others keep receiving', () => {
    const { hub, lines } = setup(size * 2);
    const slow = new FakeClient(false);
    const fast = new FakeClient();
    hub.add(slow);
    hub.add(fast);
    expect(hub.publish(status)).toEqual({ ok: true, delivered: 2, dropped: 0 });
    expect(hub.publish(status)).toEqual({ ok: true, delivered: 2, dropped: 0 }); // exactly at the limit
    expect(slow.bufferedAmount).toBe(size * 2);
    expect(hub.publish(status)).toEqual({ ok: true, delivered: 1, dropped: 1 });
    expect(slow.terminated).toBe(true);
    expect(slow.sent).toHaveLength(2);
    expect(fast.sent).toHaveLength(3);
    expect(hub.clientCount).toBe(1);
    expect(lines.filter((line) => line.msg === 'stream.client_dropped')).toEqual([
      expect.objectContaining({ reason: 'SLOW' }),
    ]);
  });

  it('an event larger than the per-client limit is refused instead of dropping every client', () => {
    const { hub } = setup(size - 1);
    const a = new FakeClient();
    hub.add(a);
    expect(hub.publish(status)).toEqual({ ok: false, code: 'EVENT_TOO_LARGE' });
    expect(a.terminated).toBe(false);
    expect(hub.clientCount).toBe(1);
  });

  it('a failing send drops that client only and never throws to the publisher', () => {
    const { hub } = setup(10_000);
    const broken = new FakeClient();
    broken.failSend = true;
    const ok = new FakeClient();
    hub.add(broken);
    hub.add(ok);
    expect(hub.publish(status)).toEqual({ ok: true, delivered: 1, dropped: 1 });
    expect(broken.terminated).toBe(true);
    expect(ok.sent).toHaveLength(1);
  });

  it('accepts at most maxClients clients; removal frees a slot', () => {
    const { hub } = setup(10_000, 2);
    const a = new FakeClient();
    expect(hub.add(a)).toBe(true);
    expect(hub.add(new FakeClient())).toBe(true);
    expect(hub.add(new FakeClient())).toBe(false);
    hub.remove(a);
    expect(hub.add(new FakeClient())).toBe(true);
    expect(hub.clientCount).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects limit %s', (limit) => {
    const { logger } = capturingLogger();
    expect(() => createStreamHub({ logger, maxClients: limit, maxBufferedBytes: 10 })).toThrow(TypeError);
    expect(() => createStreamHub({ logger, maxClients: 1, maxBufferedBytes: limit })).toThrow(TypeError);
  });
});
