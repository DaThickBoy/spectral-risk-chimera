// AT-ARC-01, AT-ARC-02: dependency-cruiser fails seeded boundary violations, naming the
// rule, and the real tree passes. Static part of Property 11 (Filing independence).
// Validates: Requirements 8.6, 11.5, 26.1, 26.2, 26.10
import { describe, expect, it } from 'vitest';
import { repoPath, runNode } from '../helpers/repo.js';

const depcruise = repoPath('node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const config = repoPath('.dependency-cruiser.mjs');

interface Violation {
  from: string;
  to: string;
  rule: { name: string; severity: string };
}

function cruise(cwd: string): { code: number | null; violations: Violation[] } {
  const run = runNode(depcruise, ['src', '--config', config, '--output-type', 'json'], cwd);
  const output = JSON.parse(run.stdout) as { summary: { violations: Violation[] } };
  return { code: run.code, violations: output.summary.violations };
}

const seeded = cruise(repoPath('test', 'fixtures', 'depcruise'));
const has = (rule: string, from: string, to: string): boolean =>
  seeded.violations.some((v) => v.rule.name === rule && v.from === from && v.to === to);

describe('AT-ARC-01: domain and risk boundaries', () => {
  it('fails the check (deps:check exits non-zero, naming the rule)', () => {
    expect(seeded.violations.length).toBeGreaterThan(0);
    expect(seeded.violations.every((v) => v.rule.severity === 'error')).toBe(true);
    // The default "err" reporter used by `npm run deps:check` sets the exit code.
    const run = runNode(depcruise, ['src', '--config', config], repoPath('test', 'fixtures', 'depcruise'));
    expect(run.code).not.toBe(0);
    expect(run.stdout).toContain('risk-not-to-sec-or-nlp');
  });

  it('risk/ must not import sec/ or nlp/ (Property 11, static part)', () => {
    expect(has('risk-not-to-sec-or-nlp', 'src/risk/index.ts', 'src/sec/index.ts')).toBe(true);
    expect(has('risk-not-to-sec-or-nlp', 'src/risk/usesNlp.ts', 'src/nlp/index.ts')).toBe(true);
  });

  it('domain modules must not import adapters, persistence implementations, or api/', () => {
    expect(has('domain-not-to-outer-layers', 'src/portfolio/index.ts', 'src/adapters/index.ts')).toBe(true);
    expect(has('domain-not-to-outer-layers', 'src/marketdata/index.ts', 'src/persistence/sqlite.ts')).toBe(
      true,
    );
    expect(has('domain-not-to-outer-layers', 'src/fx/index.ts', 'src/api/index.ts')).toBe(true);
  });

  it('cross-module imports go through index.ts', () => {
    expect(has('cross-module-through-index', 'src/alerts/index.ts', 'src/risk/internal.ts')).toBe(true);
  });
});

describe('AT-FIL-10 (static): filing and sentiment text stay in separate modules (R8.6)', () => {
  it('nlp/ and sec/ must not import sentiment/', () => {
    expect(has('filing-text-not-to-sentiment', 'src/nlp/usesSentiment.ts', 'src/sentiment/index.ts')).toBe(
      true,
    );
    expect(has('filing-text-not-to-sentiment', 'src/sec/usesSentiment.ts', 'src/sentiment/index.ts')).toBe(
      true,
    );
  });

  it('sentiment/ must not import nlp/ or sec/', () => {
    expect(has('sentiment-text-not-to-filing', 'src/sentiment/usesFiling.ts', 'src/nlp/index.ts')).toBe(true);
    expect(has('sentiment-text-not-to-filing', 'src/sentiment/usesFiling.ts', 'src/sec/index.ts')).toBe(true);
  });
});

describe('AT-ARC-02: web/ boundary', () => {
  it('web/ must not import domain modules', () => {
    expect(has('web-not-to-domain', 'src/web/index.ts', 'src/risk/index.ts')).toBe(true);
  });

  it('A2: only the chart adapter may import the Decimal helper, and nothing else beyond the contracts', () => {
    expect(has('web-not-to-domain', 'src/web/usesDecimal.ts', 'src/shared/decimal.ts')).toBe(true);
    expect(has('web-chart-adapter-boundary', 'src/web/chartAdapter.ts', 'src/risk/index.ts')).toBe(true);
    expect(
      seeded.violations.filter(
        (v) => v.from === 'src/web/chartAdapter.ts' && v.to === 'src/shared/decimal.ts',
      ),
    ).toEqual([]);
  });
});

describe('real tree', () => {
  it('has no boundary violations', () => {
    const real = cruise(repoPath());
    expect(real.violations).toEqual([]);
    expect(real.code).toBe(0);
  });
});
