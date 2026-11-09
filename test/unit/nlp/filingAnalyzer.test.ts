// Task 21.1: the filing NLP port, the fallback provider, and the analyzer under FakeClock and
// FakeSleeper with the real ResilientCall.
// Validates: Requirements 7.1, 7.4, 7.7, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7, 21.1, 21.3, 21.5, 26.3, 33.7
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_METHOD,
  FallbackNlpProvider,
  RISK_CATEGORIES,
  createFilingAnalyzer,
} from '../../../src/nlp/index.js';
import type { FilingAnalysisResult, FilingNlpProvider, NlpError } from '../../../src/nlp/index.js';
import { FilingRiskScoreSchema, FilingText, SentimentText } from '../../../src/shared/index.js';
import type { AttemptOutcome, Result } from '../../../src/shared/index.js';
import { START, drive, harness, http } from '../../helpers/resilience.js';
import type { Harness } from '../../helpers/resilience.js';

const SETTINGS = { timeoutMs: 60_000, maxRetries: 2 };
const TEXT = 'Item 1A. Risk Factors. PRIVATE-FILING-TEXT';

type Step = AttemptOutcome<unknown> | 'HANG' | { readonly throws: unknown };

interface RecordingProvider extends FilingNlpProvider {
  readonly calls: { text: FilingText; signal: AbortSignal; at: number }[];
}

/** A provider that plays `steps` in order (the last repeats). */
function provider(h: Harness, steps: readonly Step[], name = 'acme-nlp'): RecordingProvider {
  const calls: RecordingProvider['calls'] = [];
  return {
    name,
    calls,
    analyzeFiling: (text, signal) => {
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ text, signal, at: h.clock.monotonicMs() });
      if (step === undefined || step === 'HANG') {
        return new Promise(() => undefined);
      }
      if ('throws' in step) {
        throw step.throws;
      }
      return Promise.resolve(step);
    },
  };
}

const valid = (overrides: Record<string, unknown> = {}): AttemptOutcome<unknown> => ({
  ok: true,
  value: {
    score: '0.750',
    categories: ['MARKET', 'LEGAL'],
    method: 'acme-risk',
    methodVersion: '2.1',
    ...overrides,
  },
});

function analyzerWith(h: Harness, p?: FilingNlpProvider, settings = SETTINGS) {
  return createFilingAnalyzer({
    ...(p === undefined ? {} : { provider: p }),
    resilience: h.rc,
    clock: h.clock,
    settings,
  });
}

const run = (h: Harness, p?: FilingNlpProvider, text = FilingText.of(TEXT), settings = SETTINGS) =>
  drive(h.sleeper, analyzerWith(h, p, settings).analyze(text));

function errorOf(result: Result<FilingAnalysisResult, NlpError>): NlpError {
  if (result.ok) {
    throw new Error('expected an error');
  }
  return result.error;
}

describe('AT-FIL-20: fallback results are labelled FALLBACK / DEMO and never genuine', () => {
  it('"0" is inside the approved FilingRiskScore range', () => {
    expect(FilingRiskScoreSchema.safeParse('0')).toEqual({ success: true, data: '0' });
  });

  it('without a provider the fixed demo placeholder is returned, stamped FALLBACK / DEMO', async () => {
    const h = harness();
    expect(await run(h)).toEqual({
      ok: true,
      value: {
        analysis: { score: '0', categories: [], method: 'fallback-placeholder', methodVersion: '1' },
        provider: 'fallback-placeholder',
        mode: 'FALLBACK',
        sourceKind: 'DEMO',
        analyzedAt: START,
      },
    });
    expect(h.rc.status('nlp-filing:fallback')).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
  });

  it('an explicit FallbackNlpProvider (or a subclass) is still FALLBACK / DEMO', async () => {
    class Custom extends FallbackNlpProvider {}
    for (const p of [new FallbackNlpProvider(), new Custom()]) {
      const result = await run(harness(), p);
      expect(result.ok && [result.value.mode, result.value.sourceKind]).toEqual(['FALLBACK', 'DEMO']);
    }
  });

  it('the placeholder does not depend on the text', async () => {
    for (const text of ['', 'x', TEXT.repeat(50)]) {
      const result = await run(harness(), undefined, FilingText.of(text));
      expect(result.ok && result.value.analysis).toEqual({
        score: '0',
        categories: [],
        method: FALLBACK_METHOD,
        methodVersion: '1',
      });
    }
  });

  it('a real provider is REAL / REAL; its output is returned exactly as received, frozen', async () => {
    const h = harness();
    const result = await run(h, provider(h, [valid()]));
    expect(result).toEqual({
      ok: true,
      value: {
        analysis: {
          score: '0.750',
          categories: ['MARKET', 'LEGAL'],
          method: 'acme-risk',
          methodVersion: '2.1',
        },
        provider: 'acme-nlp',
        mode: 'REAL',
        sourceKind: 'REAL',
        analyzedAt: START,
      },
    });
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
    expect(result.ok && Object.isFrozen(result.value.analysis)).toBe(true);
  });

  it.each([
    ['mode', { mode: 'REAL' }],
    ['sourceKind', { sourceKind: 'REAL' }],
    ['analyzedAt', { analyzedAt: '2020-01-01T00:00:00.000Z' }],
    ['provider', { provider: 'someone-else' }],
  ])('a provider cannot set %s: the output is rejected as invalid', async (_label, extra) => {
    const h = harness();
    const p = provider(h, [valid(extra)]);
    expect(errorOf(await run(h, p))).toMatchObject({
      code: 'NLP_FAILED',
      cause: 'NLP_INVALID_OUTPUT',
      attempts: 1,
    });
  });

  it('analyzedAt is the injected clock time when the analysis completes', async () => {
    const h = harness();
    const slow: FilingNlpProvider = {
      name: 'slow',
      analyzeFiling: async () => {
        await h.sleeper.sleep(1_500);
        return valid();
      },
    };
    const result = await run(h, slow);
    expect(result.ok && result.value.analyzedAt).toBe('2026-11-07T12:00:01.500Z');
  });

  it('a failed primary is never replaced by the fallback', async () => {
    const h = harness();
    const result = await run(h, provider(h, [http(503)]));
    expect(result.ok).toBe(false);
    expect('value' in result).toBe(false);
  });
});

describe('AT-FIL-06: provider output outside the schema is rejected, never clamped or retried', () => {
  it.each([
    ['score above 1', { score: '1.01' }],
    ['score below 0', { score: '-0.1' }],
    ['negative zero sign with fraction', { score: '-0.0001' }],
    ['exponent notation', { score: '1e-1' }],
    ['NaN text', { score: 'NaN' }],
    ['a JSON number', { score: 0.5 }],
    ['an empty score', { score: '' }],
    ['a padded score', { score: ' 0.5' }],
    ['a missing score', { score: undefined }],
    ['an unknown category', { categories: ['MARKET', 'WEATHER'] }],
    ['duplicate categories', { categories: ['MARKET', 'MARKET'] }],
    ['an empty method', { method: '' }],
    ['a whitespace-only method', { method: '   ' }],
    ['a method with surrounding spaces', { method: ' acme ' }],
    ['a method that is too long', { method: 'm'.repeat(65) }],
    ['a method with a control character', { method: 'acme\nrisk' }],
    ['a non-ASCII method', { method: 'acmé' }],
    ['a whitespace-only version', { methodVersion: '\t' }],
    ['a version that is too long', { methodVersion: 'v'.repeat(33) }],
    ['an unknown field', { confidence: '0.9' }],
  ])('%s', async (_label, overrides) => {
    const h = harness();
    const p = provider(h, [valid(overrides), valid()]);
    const error = errorOf(await run(h, p));
    expect(error).toEqual({
      code: 'NLP_FAILED',
      message: 'Filing analysis failed (NLP_FAILED).',
      cause: 'NLP_INVALID_OUTPUT',
      provider: 'acme-nlp',
      mode: 'REAL',
      attempts: 1,
    });
    expect(p.calls).toHaveLength(1);
  });

  it.each([
    ['score "0"', { score: '0' }],
    ['score "1"', { score: '1' }],
    ['score "1.000" (unchanged, not canonicalized)', { score: '1.000' }],
    ['score "0.0"', { score: '0.0' }],
    ['no categories', { categories: [] }],
    ['all eight categories', { categories: [...RISK_CATEGORIES] }],
    ['a 64-character method', { method: 'm'.repeat(64) }],
    ['a 32-character version', { methodVersion: 'v'.repeat(32) }],
    ['inner spaces in the method', { method: 'acme risk model' }],
  ])('accepts %s exactly as received', async (_label, overrides) => {
    const h = harness();
    const result = await run(h, provider(h, [valid(overrides)]));
    expect(result.ok && result.value.analysis).toEqual({
      score: '0.750',
      categories: ['MARKET', 'LEGAL'],
      method: 'acme-risk',
      methodVersion: '2.1',
      ...overrides,
    });
  });

  it('a non-object success value is invalid output', async () => {
    for (const value of [null, '0.5', 0.5, [], undefined]) {
      const h = harness();
      const p = provider(h, [{ ok: true, value }]);
      expect(errorOf(await run(h, p)).cause).toBe('NLP_INVALID_OUTPUT');
    }
  });
});

describe('AT-PRV-09: nlp.timeoutMs and nlp.maxRetries; a timeout gives NLP_FAILED and no score', () => {
  it('a hanging provider times out per attempt and is retried nlp.maxRetries times', async () => {
    const h = harness();
    const p = provider(h, ['HANG']);
    const result = await run(h, p);
    const error = errorOf(result);
    expect(error).toEqual({
      code: 'NLP_FAILED',
      message: 'Filing analysis failed (NLP_FAILED).',
      cause: 'NLP_TIMEOUT',
      provider: 'acme-nlp',
      mode: 'REAL',
      attempts: 3,
    });
    expect('value' in result).toBe(false);
    expect(p.calls).toHaveLength(3);
    expect(p.calls.every((call) => call.signal.aborted)).toBe(true);
    // 60,000 per attempt plus the 8.2 jittered backoff between attempts (random 0.5: 125, then 250).
    expect(p.calls.map((call) => call.at)).toEqual([0, 60_125, 120_375]);
    expect(h.clock.monotonicMs()).toBe(180_375);
  });

  it('uses the configured timeout and retry count', async () => {
    const h = harness();
    const p = provider(h, ['HANG']);
    const error = errorOf(await run(h, p, FilingText.of(TEXT), { timeoutMs: 5_000, maxRetries: 0 }));
    expect(error).toMatchObject({ cause: 'NLP_TIMEOUT', attempts: 1 });
    expect(h.clock.monotonicMs()).toBe(5_000);
  });

  it('retryable failures are retried, then succeed', async () => {
    const h = harness();
    const p = provider(h, [{ ok: false, failure: 'NETWORK' }, valid()]);
    expect((await run(h, p)).ok).toBe(true);
    expect(p.calls).toHaveLength(2);
  });

  it.each([
    ['HTTP 503 (retried, then exhausted)', [http(503)], 'HTTP_SERVER_ERROR', 3, 503],
    ['HTTP 429 (retried, then exhausted)', [http(429)], 'RATE_LIMITED', 3, 429],
    ['HTTP 404 (not retried)', [http(404)], 'HTTP_CLIENT_ERROR', 1, 404],
    [
      'a provider-reported invalid response',
      [{ ok: false, failure: 'INVALID_RESPONSE' }],
      'INVALID_RESPONSE',
      1,
      undefined,
    ],
    ['a TLS failure', [{ ok: false, failure: 'TLS' }], 'TLS_ERROR', 1, undefined],
    ['a throwing provider', [{ throws: new Error(`boom ${TEXT}`) }], 'UNEXPECTED_ERROR', 1, undefined],
    ['a malformed outcome', [{ ok: 'yes' } as never], 'UNEXPECTED_ERROR', 1, undefined],
  ] as const)('%s gives NLP_FAILED with that cause', async (_label, steps, cause, attempts, httpStatus) => {
    const h = harness();
    const error = errorOf(await run(h, provider(h, steps)));
    expect(error).toMatchObject({ code: 'NLP_FAILED', cause, attempts });
    expect(error.httpStatus).toBe(httpStatus);
    expect(JSON.stringify(error)).not.toContain('PRIVATE-FILING-TEXT');
  });
});

describe('logging privacy: provider exceptions and filing text are never logged', () => {
  // Synthetic sensitive values (obviously fake), distinctive excerpts, and the full text.
  const EXCERPT_A = 'MATERIAL-WEAKNESS-ZETA-7731';
  const EXCERPT_B = 'Undisclosed litigation with Example Holdings';
  const SENSITIVE = [
    'acct-0000-1111-2222',
    'jane.doe@example.invalid',
    '4111 1111 1111 1111',
    'test-api-key-9999',
  ];
  const FULL_TEXT = [
    'Item 1A. Risk Factors.',
    `${EXCERPT_A}: our controls over financial reporting were not effective.`,
    `${EXCERPT_B} may result in losses.`,
    `Contact ${SENSITIVE[1] ?? ''}; account ${SENSITIVE[0] ?? ''}; card ${SENSITIVE[2] ?? ''}; key ${SENSITIVE[3] ?? ''}.`,
  ].join('\n');
  const MARKERS = [FULL_TEXT, EXCERPT_A, EXCERPT_B, 'controls over financial reporting', ...SENSITIVE];

  const leaked = (h: Harness): string[] => {
    const text = JSON.stringify(h.logs);
    return MARKERS.filter(
      (marker) => text.includes(marker) || text.includes(JSON.stringify(marker).slice(1, -1)),
    );
  };

  class ProviderFailure extends Error {
    readonly payload = FULL_TEXT;
    readonly request = { body: FULL_TEXT, headers: { authorization: SENSITIVE[3] } };
  }

  const throwing: [string, () => unknown][] = [
    ['a thrown Error with the full text', () => new Error(FULL_TEXT)],
    ['a thrown Error with excerpts', () => new Error(`model failed near "${EXCERPT_A}" and "${EXCERPT_B}"`)],
    ['an Error whose cause holds the text', () => new Error('wrapper', { cause: new Error(FULL_TEXT) })],
    ['a custom error with text-bearing properties', () => new ProviderFailure('provider failed')],
    ['a thrown string', () => FULL_TEXT],
    ['a thrown object', () => ({ text: FULL_TEXT, secret: SENSITIVE[0] })],
  ];

  it.each(throwing)('%s (thrown) is not logged; only safe metadata is', async (_label, make) => {
    const h = harness();
    const p: FilingNlpProvider = {
      name: 'acme-nlp',
      analyzeFiling: () => {
        throw make();
      },
    };
    const result = await run(h, p, FilingText.of(FULL_TEXT));
    expect(errorOf(result)).toMatchObject({ code: 'NLP_FAILED', cause: 'UNEXPECTED_ERROR', attempts: 1 });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      level: 'error',
      code: 'UNEXPECTED_ERROR',
      provider: 'nlp-filing:real:acme-nlp',
      operation: 'analyzeFiling',
      failure: 'EXCEPTION',
      attempt: 1,
    });
    expect(h.logs[0]).not.toHaveProperty('error');
    expect(leaked(h)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(EXCERPT_A);
  });

  it.each(throwing)('%s (rejected) is not logged; only safe metadata is', async (_label, make) => {
    const h = harness();
    const p: FilingNlpProvider = { name: 'acme-nlp', analyzeFiling: () => Promise.reject(make()) };
    const result = await run(h, p, FilingText.of(FULL_TEXT));
    expect(errorOf(result).cause).toBe('UNEXPECTED_ERROR');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ failure: 'EXCEPTION', attempt: 1 });
    expect(leaked(h)).toEqual([]);
  });

  it('logs the attempt number when an exception follows retryable failures', async () => {
    const h = harness();
    const p = provider(h, [
      { ok: false, failure: 'NETWORK' },
      { ok: false, failure: 'NETWORK' },
      { throws: new Error(FULL_TEXT) },
    ]);
    await run(h, p, FilingText.of(FULL_TEXT));
    expect(h.logs.map((entry) => [entry['failure'], entry['attempt']])).toEqual([['EXCEPTION', 3]]);
    expect(leaked(h)).toEqual([]);
  });

  it('a malformed outcome carrying the text is logged as metadata only', async () => {
    const h = harness();
    const p = provider(h, [{ ok: 'maybe', text: FULL_TEXT } as never]);
    expect(errorOf(await run(h, p, FilingText.of(FULL_TEXT))).cause).toBe('UNEXPECTED_ERROR');
    expect(h.logs[0]).toMatchObject({ failure: 'MALFORMED_OUTCOME', attempt: 1 });
    expect(leaked(h)).toEqual([]);
  });

  it('a late rejection with the text after a timeout is never logged', async () => {
    const h = harness();
    let rejectLate: (reason: unknown) => void = () => undefined;
    const p: FilingNlpProvider = {
      name: 'acme-nlp',
      analyzeFiling: () => new Promise((_resolve, reject) => (rejectLate = reject)),
    };
    const result = await run(h, p, FilingText.of(FULL_TEXT), { timeoutMs: 1_000, maxRetries: 0 });
    expect(errorOf(result).cause).toBe('NLP_TIMEOUT');
    rejectLate(new Error(FULL_TEXT));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.logs).toEqual([]);
  });

  it('invalid output carrying the text is rejected without any log', async () => {
    const h = harness();
    const p = provider(h, [valid({ method: EXCERPT_A, rationale: FULL_TEXT })]);
    expect(errorOf(await run(h, p, FilingText.of(FULL_TEXT))).cause).toBe('NLP_INVALID_OUTPUT');
    expect(h.logs).toEqual([]);
  });

  it('expected failures are not logged', async () => {
    const h = harness({ maxRetries: 0 });
    for (const step of [http(503), http(404), { ok: false, failure: 'NETWORK' } as const]) {
      await run(h, provider(h, [step]), FilingText.of(FULL_TEXT), { timeoutMs: 60_000, maxRetries: 0 });
    }
    expect(h.logs).toEqual([]);
  });
});

describe('the fallback method is reserved for FallbackNlpProvider', () => {
  it('a REAL provider returning method "fallback-placeholder" is NLP_INVALID_OUTPUT, not retried', async () => {
    const h = harness();
    const p = provider(h, [valid({ method: 'fallback-placeholder' }), valid()]);
    const error = errorOf(await run(h, p));
    expect(error).toEqual({
      code: 'NLP_FAILED',
      message: 'Filing analysis failed (NLP_FAILED).',
      cause: 'NLP_INVALID_OUTPUT',
      provider: 'acme-nlp',
      mode: 'REAL',
      attempts: 1,
    });
    expect(p.calls).toHaveLength(1);
  });

  it('even the exact fallback placeholder from a REAL provider is rejected', async () => {
    const h = harness();
    const placeholder = {
      ok: true,
      value: { score: '0', categories: [], method: 'fallback-placeholder', methodVersion: '1' },
    } as const;
    expect(errorOf(await run(h, provider(h, [placeholder]))).cause).toBe('NLP_INVALID_OUTPUT');
  });

  it('only the exact reserved name is refused; other method names are unaffected', async () => {
    for (const method of ['fallback-placeholder-v2', 'Fallback-Placeholder', 'acme-fallback']) {
      const h = harness();
      const result = await run(h, provider(h, [valid({ method })]));
      expect(result.ok && result.value.analysis.method).toBe(method);
    }
  });

  it('the fallback provider (and a subclass) still returns the reserved method', async () => {
    class Custom extends FallbackNlpProvider {}
    for (const p of [undefined, new FallbackNlpProvider(), new Custom()]) {
      const result = await run(harness(), p);
      expect(result.ok && [result.value.analysis.method, result.value.mode]).toEqual([
        'fallback-placeholder',
        'FALLBACK',
      ]);
    }
  });
});

describe('separate ResilientCall identities for the primary and the fallback', () => {
  it('a primary circuit opened by failures does not affect the fallback', async () => {
    const h = harness({ maxRetries: 0 });
    const failing = provider(h, [http(503)]);
    for (let i = 0; i < 5; i += 1) {
      await run(h, failing, FilingText.of(TEXT), { timeoutMs: 60_000, maxRetries: 0 });
    }
    expect(h.rc.status('nlp-filing:real:acme-nlp')).toMatchObject({
      circuit: 'OPEN',
      lastErrorCode: 'HTTP_SERVER_ERROR',
    });
    const blocked = errorOf(await run(h, failing));
    expect(blocked).toMatchObject({ cause: 'CIRCUIT_OPEN', attempts: 0 });
    // The fallback keeps its own, closed circuit.
    expect((await run(h)).ok).toBe(true);
    expect(h.rc.status('nlp-filing:fallback')).toMatchObject({ circuit: 'CLOSED', state: 'AVAILABLE' });
  });

  it('two real providers have separate identities', async () => {
    const h = harness({ maxRetries: 0 });
    const a = provider(h, [http(503)], 'vendor-a');
    for (let i = 0; i < 5; i += 1) {
      await run(h, a, FilingText.of(TEXT), { timeoutMs: 60_000, maxRetries: 0 });
    }
    expect(h.rc.status('nlp-filing:real:vendor-a').circuit).toBe('OPEN');
    expect((await run(h, provider(h, [valid()], 'vendor-b'))).ok).toBe(true);
  });
});

describe('AT-FIL-10: sentiment text never reaches filing scoring', () => {
  it('analyze accepts only FilingText; anything else throws before any provider call', async () => {
    const h = harness();
    const p = provider(h, [valid()]);
    const analyzer = analyzerWith(h, p);
    for (const input of [SentimentText.of(TEXT), TEXT, { text: TEXT }, null]) {
      await expect(analyzer.analyze(input as never)).rejects.toThrow(TypeError);
    }
    expect(p.calls).toEqual([]);
  });

  it('the provider receives exactly the FilingText instance', async () => {
    const h = harness();
    const p = provider(h, [valid()]);
    const text = FilingText.of(TEXT);
    await drive(h.sleeper, analyzerWith(h, p).analyze(text));
    expect(p.calls[0]?.text).toBe(text);
    expect(p.calls[0]?.text.text).toBe(TEXT);
  });

  it('the fallback provider refuses non-FilingText input', () => {
    const fallback = new FallbackNlpProvider();
    expect(() =>
      fallback.analyzeFiling(SentimentText.of('x') as never, new AbortController().signal),
    ).toThrow(TypeError);
  });
});

describe('construction', () => {
  it('rejects invalid settings', () => {
    const h = harness();
    for (const settings of [
      { timeoutMs: 0, maxRetries: 2 },
      { timeoutMs: 1.5, maxRetries: 2 },
      { timeoutMs: 60_000, maxRetries: -1 },
      { timeoutMs: 60_000, maxRetries: 0.5 },
    ]) {
      expect(() => analyzerWith(h, undefined, settings)).toThrow(RangeError);
    }
  });

  it('rejects provider names that cannot form a safe identity', () => {
    const h = harness();
    for (const name of ['', 'Acme', 'acme nlp', 'acme:x', 'a'.repeat(65), '-acme']) {
      expect(() => analyzerWith(h, provider(h, [valid()], name))).toThrow(TypeError);
    }
  });
});
