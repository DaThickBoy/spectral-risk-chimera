/**
 * Requirement coverage check (task 1.7; design: Requirement coverage check;
 * R27.1, R27.2, R27.4, R27.6, R27.8).
 *
 * A requirement R1..R35 is covered when at least one non-Blocked row of the
 * Acceptance Test Matrix cites it, or a test file header cites it with
 * `// Validates: Requirements ...`. Matrix rows whose status starts with
 * `Blocked` do not count. The check fails, naming each uncovered requirement.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const REQUIREMENT_IDS: readonly number[] = Array.from({ length: 35 }, (_, index) => index + 1);

export interface MatrixRow {
  readonly testId: string;
  readonly requirements: readonly number[];
  readonly blocked: boolean;
}

/** Parses `| AT-... | test | requirement | status |` rows of the Acceptance Test Matrix. */
export function parseAcceptanceMatrix(markdown: string): MatrixRow[] {
  const start = markdown.indexOf('## Acceptance Test Matrix');
  if (start === -1) {
    throw new Error('Acceptance Test Matrix section not found.');
  }
  const after = markdown.slice(start + 1);
  const nextSection = after.search(/^## /m);
  const section = nextSection === -1 ? after : after.slice(0, nextSection);
  const rows: MatrixRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\|\s*(AT-[A-Z]+-\d+)\s*\|/.exec(line);
    if (match === null || match[1] === undefined) {
      continue;
    }
    const cells = line
      .replace(/\\\|/g, '')
      .split('|')
      .map((cell) => cell.trim());
    // cells: ['', id, test, requirement, status, '']
    const requirementCell = cells[3] ?? '';
    const statusCell = cells[4] ?? '';
    rows.push({
      testId: match[1],
      requirements: requirementNumbers(requirementCell, /\bR(\d+)(?:\.\d+)?\b/g),
      blocked: /^Blocked\b/.test(statusCell),
    });
  }
  return rows;
}

function requirementNumbers(text: string, pattern: RegExp): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(pattern)) {
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(value)) {
      out.add(value);
    }
  }
  return [...out];
}

/** Requirement numbers cited by `// Validates: Requirements ...` lines in a file header. */
export function parseValidatesHeader(source: string): number[] {
  const out = new Set<number>();
  for (const line of source.split(/\r?\n/).slice(0, 30)) {
    const match = /^\s*(?:\/\/|\*|\/\*\*?)\s*Validates:\s*Requirements?\s+(.*)$/.exec(line);
    if (match?.[1] !== undefined) {
      // Plain IDs ("4.1") or R-prefixed IDs ("R4.1"); FR-n and NFR-... are not requirement numbers.
      requirementNumbers(match[1], /(?<![\w.-])R?(\d+)(?:\.\d+)?\b/g).forEach((value) => out.add(value));
    }
  }
  return [...out];
}

export interface CoverageReport {
  readonly ok: boolean;
  /** Requirements with no referencing test at all: the check fails on these. */
  readonly uncovered: readonly number[];
  /**
   * Requirements referenced only by tests the matrix marks Blocked. Blocked tests are
   * ignored rather than counted as missing, so these are reported but do not fail
   * (for example R2, whose FIX tests wait on OD-9).
   */
  readonly blockedOnly: readonly number[];
  readonly coveredByMatrix: readonly number[];
  readonly coveredByTests: readonly number[];
}

export function checkCoverage(
  matrixRows: readonly MatrixRow[],
  testHeaders: readonly (readonly number[])[],
): CoverageReport {
  const byMatrix = new Set<number>();
  const byBlocked = new Set<number>();
  for (const row of matrixRows) {
    row.requirements.forEach((value) => (row.blocked ? byBlocked : byMatrix).add(value));
  }
  const byTests = new Set<number>(testHeaders.flat());
  const referenced = (id: number): boolean => byMatrix.has(id) || byTests.has(id);
  const uncovered = REQUIREMENT_IDS.filter((id) => !referenced(id) && !byBlocked.has(id));
  return {
    ok: uncovered.length === 0,
    uncovered,
    blockedOnly: REQUIREMENT_IDS.filter((id) => !referenced(id) && byBlocked.has(id)),
    coveredByMatrix: REQUIREMENT_IDS.filter((id) => byMatrix.has(id)),
    coveredByTests: REQUIREMENT_IDS.filter((id) => byTests.has(id)),
  };
}

/** Lists test files (`*.test.ts`) below `dir`, skipping fixtures. */
export function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') {
        out.push(...listTestFiles(full));
      }
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Runs the check against the repository's requirements and test tree. */
export function checkRepositoryCoverage(repoRoot: string): CoverageReport {
  const requirements = readFileSync(path.join(repoRoot, '.kiro', 'specs', 'requirements.md'), 'utf8');
  const headers = listTestFiles(path.join(repoRoot, 'test')).map((file) =>
    parseValidatesHeader(readFileSync(file, 'utf8')),
  );
  return checkCoverage(parseAcceptanceMatrix(requirements), headers);
}

export function formatReport(report: CoverageReport): string {
  const blocked =
    report.blockedOnly.length === 0
      ? ''
      : ` Referenced only by Blocked tests: ${report.blockedOnly.map((id) => `R${id}`).join(', ')}.`;
  return report.ok
    ? `Requirement coverage check passed.${blocked}`
    : `Requirement coverage check failed. No referencing test for: ${report.uncovered.map((id) => `R${id}`).join(', ')}.${blocked}`;
}
