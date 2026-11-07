// Property 35: Secret and PII redaction
// Validates: Requirements 24.7, 29.12, 29.13
// Traceability: AT-SEC-19
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogger, FakeClock, redact } from '../../src/shared/index.js';

const alnum = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''));
const secretArb = fc.string({ unit: alnum, minLength: 16, maxLength: 24 }).map((s) => `sk${s}`);
const accountArb = fc
  .string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: 8, maxLength: 12 })
  .map((s) => `ACCT${s}`);
const tokenArb = fc.string({ unit: alnum, minLength: 16, maxLength: 24 }).map((s) => `tok${s}`);

/** Free text with a sensitive value embedded at a random position. */
const embed = (value: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc
    .tuple(fc.string({ maxLength: 12 }), value, fc.string({ maxLength: 12 }))
    .map(([a, v, b]) => `${a} ${v} ${b}`);

describe('Property 35: Secret and PII redaction', () => {
  it('configured secrets, Authorization headers, API keys, and FIX Account values never appear in log output', () => {
    fc.assert(
      fc.property(
        secretArb,
        accountArb,
        tokenArb,
        fc.string({ maxLength: 20 }),
        fc.constantFrom('\u0001', '|'),
        (secret, account, token, noise, delimiter) => {
          const contact = `Research Desk ${secret.slice(0, 8)}@example.invalid`;
          const payload = {
            note: noise,
            message: `failed for ${secret}`,
            headers: { Authorization: `Bearer ${token}`, 'x-api-key': secret, 'User-Agent': contact },
            text: [`Authorization: Bearer ${token}`, `see https://example.invalid/?api_key=${token}&q=1`],
            fix: `8=FIX.4.4${delimiter}35=8${delimiter}1=${account}${delimiter}55=AAA${delimiter}`,
            nested: { list: [{ deeper: `prefix${secret}suffix` }], account },
            error: new Error(`upstream echoed ${secret} and ${contact}`),
          };
          const lines: string[] = [];
          const logger = createLogger({
            clock: new FakeClock('2026-11-06T00:00:00Z'),
            sink: (line) => lines.push(line),
            secrets: [secret, contact],
          });
          logger.error(`call failed: ${secret}`, payload);
          const output = lines.join('\n');
          for (const forbidden of [secret, account, token, contact]) {
            expect(output).not.toContain(forbidden);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('redact() removes every configured secret from arbitrary nested payloads', () => {
    fc.assert(
      fc.property(
        fc.array(secretArb, { minLength: 1, maxLength: 3 }),
        fc.array(embed(fc.constant('§')), { maxLength: 5 }),
        (secrets, templates) => {
          const payload = {
            items: templates.map((template, index) =>
              template.replace('§', secrets[index % secrets.length] ?? ''),
            ),
            [`key-${secrets[0] ?? ''}`]: 'value',
          };
          const output = JSON.stringify(redact(payload, { secrets }));
          for (const secret of secrets) {
            expect(output).not.toContain(secret);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
