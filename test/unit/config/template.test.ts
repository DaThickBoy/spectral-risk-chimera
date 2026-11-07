// AT-CFG-07: configuration template conformance (task 3.3). The test reads the
// template as a document; the loader never does.
// Validates: Requirements 14.2, 14.4, 13.1, 15.1, 18.1
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATE_PATH,
  FINANCIAL_KEYS,
  keyMeta,
  loadConfig,
  parseConfigJsonc,
} from '../../../src/config/index.js';
import type { ConfigKey } from '../../../src/config/index.js';
import { captureLogger } from '../../helpers/config.js';

/** Approved baseline values (requirements: Configuration policy 2). */
const APPROVED: Readonly<Record<string, unknown>> = {
  'var.confidence': '0.95',
  'var.horizonDays': 1,
  'var.lookbackReturns': 250,
  'var.minObservations': 200,
  'adjustment.bearishThreshold': '-0.60',
  'adjustment.multiplier': '1.15',
  'alerts.var.metric': 'ADJUSTED',
};

function leafEntries(value: unknown, prefix = ''): [string, unknown][] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      leafEntries(item, prefix === '' ? key : `${prefix}.${key}`),
    );
  }
  return [[prefix, value]];
}

/** Returns every conformance problem found in template text (empty when it conforms). */
export function templateProblems(text: string): string[] {
  const problems: string[] = [];
  const parsed = parseConfigJsonc(text);
  if (!parsed.ok) {
    return [`template does not parse: ${parsed.error.message}`];
  }
  const leaves = new Map(leafEntries(parsed.value));
  const keys = [...leaves.keys()].sort();
  const expected = [...FINANCIAL_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    problems.push(`template keys differ from class F keys: got ${keys.join(', ')}`);
  }
  if ([...leaves.keys()].some((key) => key.endsWith('.enabled') || key === 'enabled')) {
    problems.push('template contains an "enabled" key');
  }
  const lines = text.split(/\r?\n/);
  for (const [key, value] of leaves) {
    if (Object.prototype.hasOwnProperty.call(APPROVED, key)) {
      if (value !== APPROVED[key]) {
        problems.push(`${key} must be ${JSON.stringify(APPROVED[key])}`);
      }
      continue;
    }
    if (value !== null) {
      problems.push(`${key} must be a null placeholder`);
      continue;
    }
    const name = key.split('.').pop() ?? key;
    const line = lines.find((candidate) => new RegExp(`"${name}"\\s*:\\s*null`).test(candidate));
    const comment = line?.split('//')[1] ?? '';
    const optional = FINANCIAL_KEYS.includes(key as ConfigKey) && keyMeta(key as ConfigKey).optional === true;
    // Placeholders name an open decision (OD-n) or an operator decision; the optional
    // critical filing threshold explains that null disables the critical level.
    const explained =
      /OD-\d+/.test(comment) || /\boperator\b/i.test(comment) || (optional && /\boptional\b/i.test(comment));
    if (!explained) {
      problems.push(`${key} placeholder needs an OD-n or operator comment`);
    }
  }
  return problems;
}

const templateText = readFileSync(DEFAULT_TEMPLATE_PATH, 'utf8');

describe('AT-CFG-07: configuration template conformance', () => {
  it('the committed template conforms', () => {
    expect(templateProblems(templateText)).toEqual([]);
  });

  it.each([
    ['"confidence": "0.95"', '"confidence": "0.96"'],
    ['"horizonDays": 1', '"horizonDays": 2'],
    ['"lookbackReturns": 250', '"lookbackReturns": 251'],
    ['"minObservations": 200', '"minObservations": 199'],
    ['"bearishThreshold": "-0.60"', '"bearishThreshold": "-0.6"'],
    ['"multiplier": "1.15"', '"multiplier": "1.2"'],
    ['"metric": "ADJUSTED"', '"metric": "BASE"'],
    ['"maxAgeSeconds": null', '"maxAgeSeconds": 900'],
    ['"thresholdPct": null', '"thresholdPct": "15"'],
    ['"oversellPolicy": null', '"oversellPolicy": "REJECT"'],
  ])('fails when %s is altered to %s', (original, altered) => {
    expect(templateText).toContain(original);
    expect(templateProblems(templateText.replace(original, altered))).not.toEqual([]);
  });

  it('fails when an enabled key is added', () => {
    const altered = templateText.replace(
      '"multiplier": "1.15"',
      '"multiplier": "1.15",\n    "enabled": true',
    );
    expect(templateProblems(altered)).not.toEqual([]);
  });

  it('fails when a placeholder comment loses its decision reference', () => {
    const altered = templateText.replace('// OD-6: proposed 900', '// proposed 900');
    expect(templateProblems(altered)).not.toEqual([]);
  });

  it('is refused by the loader as runtime configuration', () => {
    const { logger } = captureLogger();
    const result = loadConfig({ srcConfigFile: DEFAULT_TEMPLATE_PATH, logger });
    expect(result.file.status).toBe('TEMPLATE_REFUSED');
  });
});
