// Deterministic harness for SecClient tests (task 19.2): FakeClock, FakeSleeper, a real guard
// with fake public DNS per host, a recording sink, a scripted SecTransport, the shared limiter,
// and a real ResilientCall.
import { createSecClient, createSecRateLimiter, createSecUrlGuard } from '../../src/sec/index.js';
import type {
  DnsFamilyAnswer,
  SecAllowedHost,
  SecClient,
  SecClientLimits,
  SecDnsResolver,
  SecRateLimiter,
  SecTransport,
  SecTransportOutcome,
  SecTransportRequest,
} from '../../src/sec/index.js';
import { FakeClock, FakeSleeper, createLogger, createResilientCall } from '../../src/shared/index.js';
import type { CircuitPolicy, ResilientCall, RetryPolicy } from '../../src/shared/index.js';
import { DEFAULT_CIRCUIT, DEFAULT_RETRY, START } from './resilience.js';
import { recordingSink } from './secGuard.js';
import type { RecordingSink } from './secGuard.js';

/** Obviously fake contact; never a real address. */
export const TEST_USER_AGENT = 'SpectralRiskChimera-test/0.0 test-contact@example.invalid';

export const LIMITS: SecClientLimits = { timeoutMs: 30_000, maxResponseBytes: 1_000, maxRedirects: 3 };

/** Public unicast answers (fake DNS), so the production address policy runs unchanged. */
export const PUBLIC_DNS: Readonly<Record<SecAllowedHost, readonly [DnsFamilyAnswer, DnsFamilyAnswer]>> = {
  'www.sec.gov': [
    { status: 'RECORDS', addresses: ['8.8.8.8', '8.8.4.4'] },
    { status: 'RECORDS', addresses: ['2001:4860:4860::8888'] },
  ],
  'data.sec.gov': [{ status: 'RECORDS', addresses: ['1.1.1.1'] }, { status: 'NO_DATA' }],
};

/**
 * Per-host DNS behaviour: fixed answers, 'HANG' (never settles, ignores the signal), or answers
 * delivered after `afterMs` (ignoring the signal, like a resolver that cannot be cancelled;
 * ERROR when `answers` is omitted).
 */
export type HostAnswer =
  | readonly [DnsFamilyAnswer, DnsFamilyAnswer]
  | 'HANG'
  | { readonly afterMs: number; readonly answers?: readonly [DnsFamilyAnswer, DnsFamilyAnswer] };

export interface HostResolver extends SecDnsResolver {
  readonly calls: {
    hostname: SecAllowedHost;
    family: 4 | 6;
    context?: { signal: AbortSignal; timeoutMs: number };
  }[];
}

/** A resolver answering per host. */
export function hostResolver(
  answers: Partial<Record<SecAllowedHost, HostAnswer>> = PUBLIC_DNS,
  sleeper?: FakeSleeper,
): HostResolver {
  const calls: HostResolver['calls'] = [];
  return {
    calls,
    resolve: async (hostname, family, context) => {
      calls.push({ hostname, family, ...(context === undefined ? {} : { context }) });
      const answer = answers[hostname] ?? PUBLIC_DNS[hostname];
      if (answer === 'HANG') {
        return new Promise<DnsFamilyAnswer>(() => undefined);
      }
      if ('afterMs' in answer) {
        await sleeper?.sleep(answer.afterMs);
        const late = answer.answers;
        return late === undefined ? { status: 'ERROR' } : family === 4 ? late[0] : late[1];
      }
      return family === 4 ? answer[0] : answer[1];
    },
  };
}

export interface RecordedRequest {
  readonly at: number;
  readonly hostname: SecAllowedHost;
  readonly addresses: readonly string[];
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}

export type Reply =
  | {
      readonly status: number;
      readonly locations?: readonly string[];
      readonly retryAfter?: string;
      readonly contentType?: string;
      readonly body?: string;
    }
  | { readonly failure: 'NETWORK' | 'TIMEOUT' | 'TLS' | 'TOO_LARGE' | 'INVALID_RESPONSE' }
  | 'HANG';

export interface ScriptedTransport extends SecTransport {
  readonly requests: RecordedRequest[];
}

/** A transport that answers with `reply(request, index)`; 'HANG' settles only on abort (TIMEOUT). */
export function scriptedTransport(
  clock: FakeClock,
  reply: (request: SecTransportRequest, index: number) => Reply,
): ScriptedTransport {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    request: (req) => {
      const index = requests.length;
      requests.push({
        at: clock.monotonicMs(),
        hostname: req.host.hostname,
        addresses: req.host.addresses.map((entry) => entry.address),
        path: req.path,
        headers: { ...req.headers },
        maxBytes: req.maxBytes,
      });
      const answer = reply(req, index);
      if (answer === 'HANG') {
        return new Promise<SecTransportOutcome>((resolve) => {
          req.signal.addEventListener('abort', () => resolve({ ok: false, failure: 'TIMEOUT' }), {
            once: true,
          });
        });
      }
      if ('failure' in answer) {
        return Promise.resolve({ ok: false, failure: answer.failure });
      }
      return Promise.resolve({
        ok: true,
        status: answer.status,
        locations: answer.locations ?? [],
        ...(answer.retryAfter === undefined ? {} : { retryAfter: answer.retryAfter }),
        ...(answer.contentType === undefined ? {} : { contentType: answer.contentType }),
        body: new TextEncoder().encode(answer.body ?? ''),
      });
    },
  };
}

export const ok200 = (body = 'ok'): Reply => ({ status: 200, body, contentType: 'text/html' });
export const redirect = (location: string, status = 302): Reply => ({ status, locations: [location] });

export interface SecHarness {
  readonly clock: FakeClock;
  readonly sleeper: FakeSleeper;
  readonly resolver: HostResolver;
  readonly sink: RecordingSink;
  readonly transport: ScriptedTransport;
  readonly limiter: SecRateLimiter;
  readonly resilience: ResilientCall;
  readonly client: SecClient;
  readonly logs: string[];
  /** Calls of ResilientCall.run made by the client. */
  readonly runCalls: { count: number };
  randomValue: number;
}

export interface SecHarnessOptions {
  readonly reply?: (request: SecTransportRequest, index: number) => Reply;
  readonly dns?: Partial<Record<SecAllowedHost, HostAnswer>>;
  readonly userAgent?: string | undefined;
  readonly limits?: Partial<SecClientLimits>;
  readonly retry?: Partial<Omit<RetryPolicy, 'deadlineMs'>>;
  readonly circuit?: Partial<CircuitPolicy>;
  readonly maxPerSecond?: number;
}

export function secHarness(options: SecHarnessOptions = {}): SecHarness {
  const clock = new FakeClock(START);
  const sleeper = new FakeSleeper(clock);
  const resolver = hostResolver(options.dns ?? PUBLIC_DNS, sleeper);
  const sink = recordingSink();
  const transport = scriptedTransport(clock, options.reply ?? (() => ok200()));
  const logs: string[] = [];
  const h = { clock, sleeper, resolver, sink, transport, logs, randomValue: 0 } as SecHarness;
  const resilience = createResilientCall({
    clock,
    sleeper,
    random: () => h.randomValue,
    logger: createLogger({ clock, level: 'debug', sink: (line) => logs.push(line) }),
    retry: { ...DEFAULT_RETRY, ...options.retry },
    circuit: { ...DEFAULT_CIRCUIT, ...options.circuit },
  });
  const limiter = createSecRateLimiter({
    clock,
    sleeper,
    maxPerWindow: options.maxPerSecond ?? 5,
    windowMs: 1000,
  });
  const runCalls = { count: 0 };
  const counted: ResilientCall = {
    run: (provider, operation, fn, opts) => {
      runCalls.count += 1;
      return resilience.run(provider, operation, fn, opts);
    },
    status: (provider) => resilience.status(provider),
  };
  const client = createSecClient({
    guard: createSecUrlGuard({ resolver, sink, clock }),
    transport,
    limiter,
    resilience: counted,
    clock,
    sleeper,
    userAgent: 'userAgent' in options ? options.userAgent : TEST_USER_AGENT,
    limits: { ...LIMITS, ...options.limits },
  });
  return Object.assign(h, { limiter, resilience, client, runCalls });
}
