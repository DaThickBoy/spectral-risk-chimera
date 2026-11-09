/**
 * SEC URL guard (task 19.1; design: URL Guard and Client; R29.8, R29.9, R29.11, R29.14).
 *
 * `validate` parses the input with the WHATWG URL parser (Node.js `URL`) and runs
 * the checks in this fixed order; the first failure is the reason:
 *   MALFORMED_URL, NOT_HTTPS, CREDENTIALS_PRESENT, IP_LITERAL, HOST_NOT_ALLOWED,
 *   PORT_NOT_ALLOWED, FRAGMENT_PRESENT.
 * The host check is exact string equality with `www.sec.gov` or `data.sec.gov`
 * on the parser's hostname, which is already lowercased and converted to ASCII
 * by IDNA (UTS #46); no suffix, prefix, or substring match is used, so a trailing
 * dot or a look-alike (`xn--...`) host fails. On success only the parser's
 * normalized `href` may be used for a request.
 *
 * `resolveAndCheck` accepts only a `ValidatedSecUrl`, queries the A and AAAA
 * families through `SecDnsResolver`, and applies the design's family table:
 * any `ERROR` (or a throwing or rejecting resolver, or an unrecognized answer)
 * gives DNS_FAILED, even when the other family returned records; a `RECORDS`
 * answer with no records or with any record that is not a valid address of its
 * family (including a zone index) gives DNS_FAILED; no records in either family
 * gives DNS_EMPTY; any prohibited record under the pinned address policy gives
 * ADDRESS_PROHIBITED. Otherwise every validated address is returned (family 4
 * first, answer order, duplicates removed). The guard sets no timeout of its own.
 *
 * Deadline (task 19.2): `resolveAndCheck` takes an optional `DnsQueryContext`
 * (the caller's deadline signal and remaining milliseconds), passed to each
 * lookup. A `TIMEOUT` answer, or the signal aborting before both answers arrive,
 * gives `SEC_DNS_TIMEOUT` (reason DNS_TIMEOUT): not a rejection, so no security
 * event, and never DNS_FAILED. Precedence of the combined answers: any ERROR, an
 * empty list, or an invalid record gives DNS_FAILED; then any prohibited record
 * gives ADDRESS_PROHIBITED; then any TIMEOUT gives DNS_TIMEOUT; then no records
 * gives DNS_EMPTY. After an abort, answers that still arrive are evaluated only
 * for a genuine address-policy rejection (ADDRESS_PROHIBITED), which is recorded
 * as a security event; every other late outcome is dropped silently.
 *
 * Every rejection calls `SecurityEventSink.record` exactly once. The event never
 * contains any part of the input URL. The rejection is always returned; its
 * `securityEvent` is `RECORDED` only when the sink returned a success result,
 * otherwise `DELIVERY_FAILED` (error result, thrown error, or any other return
 * value). Error messages never contain the input.
 *
 * No network request is made here; connecting to a validated address with
 * hostname-based TLS verification and SNI is task 19.2.
 */
import { isIPv4 } from 'node:net';
import { types } from 'node:util';
import { appError, assertNever, err, ok } from '../shared/index.js';
import type { AppError, Clock, Result } from '../shared/index.js';
import { ADDRESS_POLICY_VERSION, classifyAddress } from './addressPolicy.js';
import { SEC_ALLOWED_HOSTS } from './ports.js';
import type {
  DnsFamilyAnswer,
  DnsQueryContext,
  SecAllowedHost,
  SecDnsResolver,
  SecUrlRejectionReason,
  SecUrlStage,
  SecurityEvent,
  SecurityEventSink,
} from './ports.js';

export type SecurityEventDelivery = 'RECORDED' | 'DELIVERY_FAILED';

export type SecUrlRejected = AppError<'SEC_URL_REJECTED'> & {
  readonly reason: SecUrlRejectionReason;
  readonly stage: SecUrlStage;
  readonly securityEvent: SecurityEventDelivery;
};

/** DNS did not finish within the caller's deadline. Not a rejection: no security event. */
export type SecDnsTimeout = AppError<'SEC_DNS_TIMEOUT'> & {
  readonly reason: 'DNS_TIMEOUT';
  readonly stage: 'RESOLVE';
};

declare const VALIDATED: unique symbol;

/** A URL that passed `validate`. Only `validate` creates it. */
export type ValidatedSecUrl = {
  readonly href: string;
  readonly hostname: SecAllowedHost;
} & { readonly [VALIDATED]: true };

export interface ValidatedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface ResolvedSecHost {
  /** Used for TLS certificate verification, SNI, and the Host header (task 19.2). */
  readonly hostname: SecAllowedHost;
  readonly addresses: readonly [ValidatedAddress, ...ValidatedAddress[]];
  readonly policyVersion: typeof ADDRESS_POLICY_VERSION;
}

export interface SecUrlGuard {
  validate(url: string): Result<ValidatedSecUrl, SecUrlRejected>;
  resolveAndCheck(
    url: ValidatedSecUrl,
    context?: DnsQueryContext,
  ): Promise<Result<ResolvedSecHost, SecUrlRejected | SecDnsTimeout>>;
}

export interface SecUrlGuardDependencies {
  readonly resolver: SecDnsResolver;
  readonly sink: SecurityEventSink;
  readonly clock: Clock;
}

const isAllowedHost = (hostname: string): hostname is SecAllowedHost =>
  (SEC_ALLOWED_HOSTS as readonly string[]).includes(hostname);

/**
 * Every ValidatedSecUrl issued by `validate` (any guard instance). The objects are
 * frozen, so neither `href` nor `hostname` can change after validation, and
 * `resolveAndCheck` accepts only objects in this set: a hand-built or cast object
 * is refused even when its hostname is allowlisted.
 */
const issuedUrls = new WeakSet<object>();

/**
 * The authority of the raw input, as the URL parser would see it: ASCII tab and
 * newline removed and surrounding C0 controls and spaces trimmed; after the scheme
 * and any run of `/` or `\`, up to the first `/`, `\`, `?`, or `#`. Used to detect
 * userinfo the parser drops (an empty `@`). Slashes are optional, as for special
 * schemes in the parser (`https:@host` has the authority `@host`).
 */
function rawAuthority(input: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  const colon = cleaned.indexOf(':');
  if (colon < 0) {
    return '';
  }
  const afterScheme = cleaned.slice(colon + 1).replace(/^[/\\]+/, '');
  const end = afterScheme.search(/[/\\?#]/);
  return end < 0 ? afterScheme : afterScheme.slice(0, end);
}

function parse(input: string): URL | undefined {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
}

/** The first failing validate-stage check, or the validated URL. */
function check(
  input: unknown,
): { reason: SecUrlRejectionReason } | { hostname: SecAllowedHost; href: string } {
  const url = typeof input === 'string' ? parse(input) : undefined;
  if (typeof input !== 'string' || url === undefined) {
    return { reason: 'MALFORMED_URL' };
  }
  if (url.protocol !== 'https:') {
    return { reason: 'NOT_HTTPS' };
  }
  if (url.username !== '' || url.password !== '' || rawAuthority(input).includes('@')) {
    return { reason: 'CREDENTIALS_PRESENT' };
  }
  if (url.hostname.startsWith('[') || isIPv4(url.hostname)) {
    return { reason: 'IP_LITERAL' };
  }
  if (!isAllowedHost(url.hostname)) {
    return { reason: 'HOST_NOT_ALLOWED' };
  }
  if (url.port !== '') {
    return { reason: 'PORT_NOT_ALLOWED' };
  }
  if (input.includes('#')) {
    return { reason: 'FRAGMENT_PRESENT' };
  }
  return { hostname: url.hostname, href: url.href };
}

const ignoreRejection = (): undefined => undefined;

/** True only for a synchronous success result; a returned thenable gets a rejection handler. */
function confirmedSuccess(returned: unknown): boolean {
  if (types.isPromise(returned)) {
    Reflect.apply(Promise.prototype.then, returned, [undefined, ignoreRejection]);
    return false;
  }
  return typeof returned === 'object' && returned !== null && (returned as { ok?: unknown }).ok === true;
}

type AnswerOutcome =
  | { readonly kind: 'ERROR' }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'RECORDS'; readonly addresses: readonly string[] };

/** Interprets one family's answer conservatively; anything unexpected is ERROR. Never rejects. */
async function query(
  resolver: SecDnsResolver,
  hostname: SecAllowedHost,
  family: 4 | 6,
  context: DnsQueryContext | undefined,
): Promise<AnswerOutcome> {
  let answer: DnsFamilyAnswer;
  try {
    answer = await (context === undefined
      ? resolver.resolve(hostname, family)
      : resolver.resolve(hostname, family, context));
  } catch {
    return { kind: 'ERROR' };
  }
  if (typeof answer !== 'object' || answer === null) {
    return { kind: 'ERROR' };
  }
  switch (answer.status) {
    case 'NO_DATA':
    case 'NOT_FOUND':
      return { kind: 'NONE' };
    case 'TIMEOUT':
      return { kind: 'TIMEOUT' };
    case 'RECORDS':
      return Array.isArray(answer.addresses)
        ? { kind: 'RECORDS', addresses: answer.addresses }
        : { kind: 'ERROR' };
    default:
      // 'ERROR' and any unrecognized status.
      return { kind: 'ERROR' };
  }
}

type Verdict =
  | { readonly kind: 'OK'; readonly addresses: readonly [ValidatedAddress, ...ValidatedAddress[]] }
  | { readonly kind: 'TIMEOUT' }
  | {
      readonly kind: 'REJECT';
      readonly reason: 'DNS_FAILED' | 'DNS_EMPTY' | 'ADDRESS_PROHIBITED';
      readonly prohibitedAddresses?: readonly string[];
    };

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The combined verdict of both families, in this precedence: any ERROR, an empty
 * RECORDS list, or an invalid record gives DNS_FAILED; any prohibited record gives
 * ADDRESS_PROHIBITED; any TIMEOUT gives TIMEOUT (not a rejection: not every record
 * is known, so nothing may be connected to); no records gives DNS_EMPTY.
 */
function verdictOf(v4: AnswerOutcome, v6: AnswerOutcome): Verdict {
  if (v4.kind === 'ERROR' || v6.kind === 'ERROR') {
    return { kind: 'REJECT', reason: 'DNS_FAILED' };
  }
  const answers: { family: 4 | 6; addresses: readonly string[] }[] = [];
  for (const [family, outcome] of [
    [4, v4],
    [6, v6],
  ] as const) {
    if (outcome.kind === 'RECORDS') {
      if (outcome.addresses.length === 0) {
        return { kind: 'REJECT', reason: 'DNS_FAILED' };
      }
      answers.push({ family, addresses: outcome.addresses });
    }
  }
  const allowed: ValidatedAddress[] = [];
  const prohibited = new Set<string>();
  const seen = new Set<string>();
  for (const { family, addresses } of answers) {
    for (const text of addresses) {
      const classified = classifyAddress(text, family);
      if (classified.kind === 'INVALID') {
        return { kind: 'REJECT', reason: 'DNS_FAILED' };
      }
      if (classified.kind === 'PROHIBITED') {
        prohibited.add(classified.canonical);
      } else if (!seen.has(classified.canonical)) {
        seen.add(classified.canonical);
        allowed.push({ address: classified.canonical, family });
      }
    }
  }
  if (prohibited.size > 0) {
    return {
      kind: 'REJECT',
      reason: 'ADDRESS_PROHIBITED',
      prohibitedAddresses: [...prohibited].sort(compareText),
    };
  }
  if (v4.kind === 'TIMEOUT' || v6.kind === 'TIMEOUT') {
    return { kind: 'TIMEOUT' };
  }
  const [first, ...rest] = allowed;
  if (first === undefined) {
    // No records in either family (every record is otherwise allowed, prohibited, or invalid).
    return { kind: 'REJECT', reason: 'DNS_EMPTY' };
  }
  return { kind: 'OK', addresses: [first, ...rest] };
}

/** Resolves when the signal aborts (immediately if it already has); `dispose` removes the listener. */
function abortion(signal: AbortSignal): {
  readonly promise: Promise<'ABORTED'>;
  readonly dispose: () => void;
} {
  let dispose = (): void => undefined;
  const promise = new Promise<'ABORTED'>((resolve) => {
    if (signal.aborted) {
      resolve('ABORTED');
      return;
    }
    const onAbort = (): void => resolve('ABORTED');
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose };
}

export function createSecUrlGuard(dependencies: SecUrlGuardDependencies): SecUrlGuard {
  const { resolver, sink, clock } = dependencies;

  const reject = (
    reason: SecUrlRejectionReason,
    stage: SecUrlStage,
    extra: { hostname?: SecAllowedHost; prohibitedAddresses?: readonly string[] } = {},
  ): { ok: false; error: SecUrlRejected } => {
    let delivery: SecurityEventDelivery = 'DELIVERY_FAILED';
    try {
      const event: SecurityEvent = {
        type: 'SEC_URL_REJECTED',
        reason,
        stage,
        at: clock.nowUtc().toISOString(),
        ...(extra.hostname === undefined ? {} : { hostname: extra.hostname }),
        ...(extra.prohibitedAddresses === undefined
          ? {}
          : { prohibitedAddresses: [...extra.prohibitedAddresses] }),
      };
      if (confirmedSuccess(sink.record(event))) {
        delivery = 'RECORDED';
      }
    } catch {
      // A failing clock or sink never weakens the rejection; it is reported as a delivery failure.
    }
    return err({
      ...appError('SEC_URL_REJECTED', `SEC URL rejected (${reason}).`),
      reason,
      stage,
      securityEvent: delivery,
    });
  };

  const dnsTimeout = (): { ok: false; error: SecDnsTimeout } =>
    err({
      ...appError('SEC_DNS_TIMEOUT', 'SEC DNS resolution timed out.'),
      reason: 'DNS_TIMEOUT',
      stage: 'RESOLVE',
    });

  return {
    validate: (url) => {
      const outcome = check(url);
      if ('reason' in outcome) {
        return reject(outcome.reason, 'VALIDATE');
      }
      const issued = Object.freeze({ href: outcome.href, hostname: outcome.hostname }) as ValidatedSecUrl;
      issuedUrls.add(issued);
      return ok(issued);
    },

    resolveAndCheck: async (url, context) => {
      if (typeof url !== 'object' || url === null || !issuedUrls.has(url)) {
        // Only validate() creates a ValidatedSecUrl; anything else is a programmer error.
        throw new TypeError('resolveAndCheck requires a URL returned by validate().');
      }
      const hostname = url.hostname;
      if (!isAllowedHost(hostname)) {
        // Unreachable for an issued, frozen URL; fail closed regardless.
        throw new TypeError('resolveAndCheck requires a URL returned by validate().');
      }
      if (context?.signal.aborted === true) {
        // The deadline has already passed: no lookup, no event.
        return dnsTimeout();
      }
      const answers = Promise.all([
        query(resolver, hostname, 4, context),
        query(resolver, hostname, 6, context),
      ]);
      let settled: readonly [AnswerOutcome, AnswerOutcome];
      if (context === undefined) {
        settled = await answers;
      } else {
        const aborted = abortion(context.signal);
        const first = await Promise.race([answers, aborted.promise]);
        aborted.dispose();
        if (first === 'ABORTED') {
          // Deadline expiry is not a DNS failure: no DNS_FAILED or DNS_EMPTY event, now or later.
          // Only a genuine address-policy rejection in answers that still arrive is recorded.
          void answers.then(([lateV4, lateV6]) => {
            const late = verdictOf(lateV4, lateV6);
            if (late.kind === 'REJECT' && late.reason === 'ADDRESS_PROHIBITED') {
              reject('ADDRESS_PROHIBITED', 'RESOLVE', {
                hostname,
                ...(late.prohibitedAddresses === undefined
                  ? {}
                  : { prohibitedAddresses: late.prohibitedAddresses }),
              });
            }
          });
          return dnsTimeout();
        }
        settled = first;
      }
      const verdict = verdictOf(settled[0], settled[1]);
      switch (verdict.kind) {
        case 'TIMEOUT':
          return dnsTimeout();
        case 'REJECT':
          return reject(verdict.reason, 'RESOLVE', {
            hostname,
            ...(verdict.prohibitedAddresses === undefined
              ? {}
              : { prohibitedAddresses: verdict.prohibitedAddresses }),
          });
        case 'OK': {
          // Frozen throughout, so the validated address set cannot be changed before 19.2 connects.
          const addresses = Object.freeze(
            verdict.addresses.map((entry) => Object.freeze({ ...entry })),
          ) as unknown as ResolvedSecHost['addresses'];
          return ok(Object.freeze({ hostname, addresses, policyVersion: ADDRESS_POLICY_VERSION }));
        }
        default:
          return assertNever(verdict);
      }
    },
  };
}
