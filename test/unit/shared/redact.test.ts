// AT-SEC-19 (examples): credentials and account identifiers are absent from logs (task 2.5).
// Validates: Requirements 24.7, 29.12
import { describe, expect, it } from 'vitest';
import { createLogger, d, FakeClock, REDACTED, redact, redactText } from '../../../src/shared/index.js';

const SECRET = 'test-api-key-0000';
const CONTACT = 'Example Research ops@example.invalid';

describe('redactText', () => {
  it('removes configured secret values', () => {
    expect(redactText(`key=${SECRET}; again ${SECRET}`, [SECRET])).toBe(`key=${REDACTED}; again ${REDACTED}`);
  });

  it('removes Authorization header lines and Bearer or Basic credentials', () => {
    expect(redactText('Authorization: Bearer abc.def-123', [])).toBe(`authorization: ${REDACTED}`);
    expect(redactText('sent Bearer abc.def-123 to provider', [])).toBe(`sent Bearer ${REDACTED} to provider`);
    expect(redactText('Basic dXNlcjpwYXNz', [])).toBe(`Basic ${REDACTED}`);
  });

  it('removes credential query parameters', () => {
    expect(redactText('GET https://example.invalid/q?symbol=AAA&apikey=abc123&x=1', [])).toBe(
      `GET https://example.invalid/q?symbol=AAA&apikey=${REDACTED}&x=1`,
    );
  });

  it('removes FIX Account (tag 1) in SOH and pipe delimited messages', () => {
    expect(redactText('8=FIX.4.4\u00011=ACC12345\u000155=AAA\u0001', [])).toBe(
      `8=FIX.4.4\u00011=${REDACTED}\u000155=AAA\u0001`,
    );
    expect(redactText('8=FIX.4.4|1=ACC12345|55=AAA|', [])).toBe(`8=FIX.4.4|1=${REDACTED}|55=AAA|`);
    expect(redactText('1=ACC12345|55=AAA', [])).toBe(`1=${REDACTED}|55=AAA`);
    // Other tags that end in 1 (for example 11 ClOrdID) are kept.
    expect(redactText('|11=ORDER1|', [])).toBe('|11=ORDER1|');
  });
});

describe('redact', () => {
  it('redacts sensitive keys at any depth without modifying the input', () => {
    const input = {
      headers: { Authorization: 'Bearer x', Cookie: 'session=1', 'X-Api-Key': SECRET, 'User-Agent': CONTACT },
      nested: [{ password: 'pw', accessToken: 't', account: 'ACC1', ticker: 'AAA' }],
    };
    const output = redact(input) as typeof input;
    expect(output.headers).toEqual({
      Authorization: REDACTED,
      Cookie: REDACTED,
      'X-Api-Key': REDACTED,
      'User-Agent': REDACTED,
    });
    expect(output.nested[0]).toEqual({
      password: REDACTED,
      accessToken: REDACTED,
      account: REDACTED,
      ticker: 'AAA',
    });
    expect(input.headers.Authorization).toBe('Bearer x');
  });

  it('removes the SEC contact wherever it appears', () => {
    const output = JSON.stringify(
      redact({ message: `request failed for ${CONTACT}` }, { secrets: [CONTACT] }),
    );
    expect(output).not.toContain('ops@example.invalid');
  });

  it('serializes Decimals canonically, Dates as ISO, and Errors without secrets', () => {
    const error = new Error(`provider rejected ${SECRET}`);
    const output = redact(
      { nav: d('1000.50'), at: new Date('2026-11-06T00:00:00Z'), error },
      { secrets: [SECRET] },
    ) as {
      nav: string;
      at: string;
      error: { message: string; stack?: string };
    };
    expect(output.nav).toBe('1000.5');
    expect(output.at).toBe('2026-11-06T00:00:00.000Z');
    expect(output.error.message).toBe(`provider rejected ${REDACTED}`);
    expect(output.error.stack ?? '').not.toContain(SECRET);
  });

  it('handles circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[Circular]' });
  });
});

describe('structured logger', () => {
  it('writes one redacted JSON line per record with a correlation id', () => {
    const lines: string[] = [];
    const logger = createLogger({
      clock: new FakeClock('2026-11-06T00:00:00Z'),
      sink: (line) => lines.push(line),
      secrets: [SECRET],
      correlationId: 'corr-1',
    });
    logger.info('provider call', {
      url: `https://example.invalid/?apikey=${SECRET}`,
      authorization: 'Bearer x',
    });
    logger.child({ correlationId: 'corr-2', provider: 'fixture' }).warn(`retry with ${SECRET}`);
    logger.debug('not written at info level');

    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({
      level: 'info',
      msg: 'provider call',
      correlationId: 'corr-1',
      authorization: REDACTED,
    });
    expect(first?.['time']).toBe('2026-11-06T00:00:00.000Z');
    expect(second).toMatchObject({ level: 'warn', correlationId: 'corr-2', provider: 'fixture' });
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
