// AT-ARC-01, AT-ARC-02: dependency-cruiser fails seeded boundary violations, naming the
// rule, and the real tree passes. Static part of Property 11 (Filing independence).
// Validates: Requirements 11.5, 26.1, 26.2, 26.10
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

describe('AT-ARC-02: web/ boundary', () => {
  it('web/ must not import domain modules', () => {
    expect(has('web-not-to-domain', 'src/web/index.ts', 'src/risk/index.ts')).toBe(true);
  });
});

describe('real tree', () => {
  it('has no boundary violations', () => {
    const real = cruise(repoPath());
    expect(real.violations).toEqual([]);
    expect(real.code).toBe(0);
  });
});
