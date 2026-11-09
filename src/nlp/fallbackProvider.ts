/**
 * Fallback NLP provider (task 21.1; R8.3 to R8.5; design: NLP port and
 * FilingRiskScore).
 *
 * Used when no NLP provider is configured. It returns a fixed demo placeholder
 * for any filing text: score "0" (inside the approved FilingRiskScore range
 * [0, 1]), no categories, method `fallback-placeholder`, version `1`. It does not
 * analyze the text. The analyzer always stamps its results `FALLBACK` / `DEMO`;
 * they are displayed as demo and never trigger filing-risk alerts.
 */
import { FilingText } from '../shared/index.js';
import type { AttemptOutcome } from '../shared/index.js';
import type { FilingNlpProvider } from './ports.js';

export const FALLBACK_METHOD = 'fallback-placeholder';
export const FALLBACK_METHOD_VERSION = '1';

export class FallbackNlpProvider implements FilingNlpProvider {
  readonly name = 'fallback-placeholder';

  analyzeFiling(text: FilingText, signal: AbortSignal): Promise<AttemptOutcome<unknown>> {
    if (!(text instanceof FilingText)) {
      throw new TypeError('analyzeFiling accepts only FilingText.');
    }
    if (signal.aborted) {
      return Promise.resolve({ ok: false, failure: 'TIMEOUT' });
    }
    return Promise.resolve({
      ok: true,
      value: { score: '0', categories: [], method: FALLBACK_METHOD, methodVersion: FALLBACK_METHOD_VERSION },
    });
  }
}
