/**
 * Risk worker thread entry (task 12.4; design: Risk Worker and Scheduler; R23.4,
 * R26.8, R33.9). Started from the compiled `dist/risk/riskWorker.js` through
 * `RISK_WORKER_URL`; no TypeScript loader is used at runtime.
 *
 * Protocol: the main thread posts `{ id, input }` where `input` is the canonical
 * JSON text of a `RiskInput` (decimal strings only). The worker replies
 * `{ id, ok: true, result }` with the canonical JSON text of the `RiskResult`, or
 * `{ id, ok: false, code: 'CALCULATION_ERROR' }` without any input text. The
 * engine validates every financial field itself (`INVALID_INPUT`).
 */
import { parentPort } from 'node:worker_threads';
import { canonicalJson } from '../shared/index.js';
import { computeRisk } from './engine.js';
import type { RiskInput } from './types.js';

const port = parentPort;
if (port === null) {
  throw new Error('riskWorker must run in a worker thread.');
}

port.on('message', (message: unknown) => {
  const id = typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined;
  const input =
    typeof message === 'object' && message !== null ? (message as { input?: unknown }).input : undefined;
  if (typeof id !== 'string' || typeof input !== 'string') {
    port.postMessage({ id: typeof id === 'string' ? id : null, ok: false, code: 'CALCULATION_ERROR' });
    return;
  }
  try {
    // Canonical JSON produced by the main thread: decimal strings and integer counts only.
    const result = computeRisk(JSON.parse(input) as RiskInput);
    port.postMessage({ id, ok: true, result: canonicalJson(result) });
  } catch {
    port.postMessage({ id, ok: false, code: 'CALCULATION_ERROR' });
  }
});
