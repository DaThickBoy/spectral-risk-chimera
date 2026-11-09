// Test configuration helpers. Every financially significant setting is supplied
// explicitly here as a TEST value. Values that are still open (OD-6, OD-1) are
// test choices only; they are not approved values and never enter production
// configuration or the template.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger, FakeClock } from '../../src/shared/index.js';
import type { Logger } from '../../src/shared/index.js';

export function completeTestConfig(): Record<string, unknown> {
  return {
    var: { confidence: '0.95', horizonDays: 1, lookbackReturns: 250, minObservations: 200 },
    adjustment: { bearishThreshold: '-0.60', multiplier: '1.15' },
    sentiment: { maxAgeSeconds: 900, windowSeconds: 300, maxFutureSkewSeconds: 5 },
    marketData: { maxStalenessDays: 5, maxReturnGapDays: 5 },
    fx: {
      baseCurrency: 'USD',
      supportedCurrencies: ['USD', 'EUR'],
      maxRateAgeSeconds: 86400,
      provider: 'FIXTURE',
    },
    filing: { maxAgeDays: 120 },
    alerts: {
      var: { thresholdPct: '10', metric: 'ADJUSTED' },
      resetPct: '10',
      filing: { threshold: '0.8', resetThreshold: '0.8' },
    },
    import: { oversellPolicy: 'REJECT', defaultTimezone: 'America/New_York' },
    recalc: { minValueChangePct: '0.10' },
  };
}

/** Deep copy with one dotted key removed (`undefined`) or replaced. */
export function withKey(
  config: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(config);
  const segments = key.split('.');
  let current: Record<string, unknown> = copy;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  const last = segments[segments.length - 1] ?? '';
  if (value === undefined) {
    Reflect.deleteProperty(current, last);
  } else {
    current[last] = value;
  }
  return copy;
}

export function writeConfig(dir: string, name: string, content: unknown): string {
  const file = path.join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  return file;
}

const disabled = (missingKeys: string[], extra: Record<string, unknown> = {}) => ({
  available: false,
  missingKeys,
  invalidKeys: [],
  blockedBy: [],
  restrictedBy: [],
  ...extra,
});

/**
 * The complete feature map when no runtime configuration is loaded (every class F
 * key missing). Written out by hand from the requirements: R14.14 (Base VaR),
 * R15.1/R15.8 (Adjusted VaR, blocked by Base VaR per R13.7), R9/R10 (sentiment),
 * R18/R34 (alerts), R28.20 (import refused without oversellPolicy), R28.1
 * (missing defaultTimezone only restricts import), R31 (filing). `api` has no
 * class F dependency and stays available.
 */
export const UNAVAILABLE_CONFIGURATION_FEATURES = {
  baseVaR: disabled([
    'var.confidence',
    'var.horizonDays',
    'var.lookbackReturns',
    'var.minObservations',
    'marketData.maxStalenessDays',
    'marketData.maxReturnGapDays',
    'fx.baseCurrency',
    'fx.supportedCurrencies',
    'fx.maxRateAgeSeconds',
    'fx.provider',
    'recalc.minValueChangePct',
  ]),
  adjustedVaR: disabled(
    [
      'adjustment.bearishThreshold',
      'adjustment.multiplier',
      'sentiment.maxAgeSeconds',
      'sentiment.windowSeconds',
      'sentiment.maxFutureSkewSeconds',
    ],
    { blockedBy: ['baseVaR'] },
  ),
  sentimentIngestion: disabled([
    'sentiment.maxAgeSeconds',
    'sentiment.windowSeconds',
    'sentiment.maxFutureSkewSeconds',
  ]),
  varAlerts: disabled(['alerts.var.thresholdPct', 'alerts.var.metric', 'alerts.resetPct']),
  filingAlerts: disabled(['filing.maxAgeDays', 'alerts.filing.threshold', 'alerts.filing.resetThreshold']),
  import: disabled(['import.oversellPolicy'], { restrictedBy: ['import.defaultTimezone'] }),
  filing: disabled(['filing.maxAgeDays']),
  api: { available: true, missingKeys: [], invalidKeys: [], blockedBy: [], restrictedBy: [] },
};

export function captureLogger(): {
  logger: Logger;
  lines: string[];
  records: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    clock: new FakeClock('2026-11-06T00:00:00Z'),
    sink: (line) => lines.push(line),
  });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}
