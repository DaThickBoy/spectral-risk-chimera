// Test helpers for the ECB FX adapter (task 10.2): recorded responses from
// test/fixtures/fx/ecb/ (byte for byte, Source: ECB statistics.) and a recording fake
// transport. Tests never use the network.
import { readFileSync } from 'node:fs';
import type { EcbTransport } from '../../src/adapters/index.js';
import type { AttemptOutcome } from '../../src/shared/index.js';
import { repoPath } from './repo.js';

type HttpsResponse = Extract<Awaited<ReturnType<EcbTransport>>, { ok: true }>['value'];

/** Recorded file name by the query's endPeriod. */
export const RECORDED: Readonly<Record<string, string>> = {
  '2026-11-06': 'exr-gbp-usd-2026-11-06.csv',
  '2026-11-07': 'exr-gbp-usd-2026-11-07.csv',
  '2026-10-26': 'exr-gbp-usd-2026-10-26.csv',
  '2026-04-07': 'exr-gbp-usd-2026-04-07.csv',
  '2025-12-29': 'exr-gbp-usd-2025-12-29.csv',
};

export const recorded = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(repoPath('test', 'fixtures', 'fx', 'ecb', file)));

export const csvOk = (
  body: Uint8Array | string,
  contentType = 'text/csv',
): AttemptOutcome<HttpsResponse> => ({
  ok: true,
  value: {
    status: 200,
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  },
});

export interface TransportCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface RecordingTransport {
  readonly transport: EcbTransport;
  readonly calls: TransportCall[];
}

/** Answers every call with `respond(url)`; records url, headers, size limit, and signal. */
export function recordingTransport(
  respond: (
    url: string,
    signal: AbortSignal,
  ) => Promise<AttemptOutcome<HttpsResponse>> | AttemptOutcome<HttpsResponse>,
): RecordingTransport {
  const calls: TransportCall[] = [];
  return {
    calls,
    transport: async (url, options, signal) => {
      calls.push({ url, headers: options.headers, maxBytes: options.maxBytes, signal });
      return respond(url, signal);
    },
  };
}

/** The recorded response for the query's endPeriod; HTTP 404 when none is recorded. */
export function recordedTransport(): RecordingTransport {
  return recordingTransport((url) => {
    const endPeriod = new URL(url).searchParams.get('endPeriod') ?? '';
    const file = RECORDED[endPeriod];
    return file === undefined ? { ok: false, failure: 'HTTP', status: 404 } : csvOk(recorded(file));
  });
}
