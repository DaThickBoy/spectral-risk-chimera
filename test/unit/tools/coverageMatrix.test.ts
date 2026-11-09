// Requirement coverage check (task 1.7) against a small sample matrix, and against the repository.
// Validates: Requirements 27.1, 27.2, 27.4, 27.6, 27.8
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers/repo.js';
import {
  checkCoverage,
  checkRepositoryCoverage,
  formatReport,
  parseAcceptanceMatrix,
  parseValidatesHeader,
  REQUIREMENT_IDS,
} from '../../tools/coverage-matrix/index.js';

const allButThree = REQUIREMENT_IDS.filter((id) => id !== 3).map(
  (id, index) => `| AT-S-${index + 1} | sample | R${id}.1 | Ready |`,
);

const sample = (extraRows: string[]): string =>
  [
    '# Requirements',
    '## Acceptance Test Matrix',
    '| ID | Test | Requirement | Status |',
    '|---|---|---|---|',
    ...allButThree,
    ...extraRows,
    '## Assumptions and Constraints',
    '| AT-X-1 | outside the matrix | R3.1 | Ready |',
  ].join('\n');

describe('parseAcceptanceMatrix', () => {
  it('reads requirement IDs and Blocked status, ignoring FR-n and rows outside the matrix', () => {
    const rows = parseAcceptanceMatrix(
      sample([
        '| AT-B-1 | blocked | R3.2 | Blocked (OD-7) |',
        '| AT-C-1 | mixed | R14.7, FR-7, R13.1 to R13.3 | Ready |',
      ]),
    );
    expect(rows.find((row) => row.testId === 'AT-B-1')).toEqual({
      testId: 'AT-B-1',
      requirements: [3],
      blocked: true,
    });
    expect(rows.find((row) => row.testId === 'AT-C-1')?.requirements).toEqual([14, 13]);
    expect(rows.some((row) => row.testId === 'AT-X-1')).toBe(false);
  });

  it('treats "Ready (record only); enforcement Blocked" as not blocked', () => {
    const rows = parseAcceptanceMatrix(
      sample(['| AT-R-1 | bench | R3.3 | Ready (record only); enforcement Blocked (OD-2) |']),
    );
    expect(rows.find((row) => row.testId === 'AT-R-1')?.blocked).toBe(false);
  });

  it('handles escaped pipes in the test description', () => {
    const rows = parseAcceptanceMatrix(
      sample(['| AT-P-1 | tolerance on `\\|interval - 3000\\|` | R3.4 | Ready |']),
    );
    expect(rows.find((row) => row.testId === 'AT-P-1')?.requirements).toEqual([3]);
  });
});

describe('parseValidatesHeader', () => {
  it('reads plain and R-prefixed IDs from header comments and ignores FR-n', () => {
    const source = [
      '// Property 1: Decimal exactness',
      '// Validates: Requirements 4.1, 4.2, R30.4, FR-5',
      'code();',
    ].join('\n');
    expect(parseValidatesHeader(source).sort((a, b) => a - b)).toEqual([4, 30]);
    expect(parseValidatesHeader(' * Validates: Requirements 14.1-14.9, FR-7.')).toEqual([14]);
    expect(parseValidatesHeader('// no header')).toEqual([]);
  });
});

describe('checkCoverage', () => {
  it('fails and names a requirement with no referencing test', () => {
    const report = checkCoverage(parseAcceptanceMatrix(sample([])), []);
    expect(report.ok).toBe(false);
    expect(report.uncovered).toEqual([3]);
    expect(formatReport(report)).toContain('R3');
  });

  it('ignores tests marked Blocked: a requirement with only Blocked tests is reported, not failed', () => {
    const report = checkCoverage(
      parseAcceptanceMatrix(sample(['| AT-B-1 | blocked | R3.2 | Blocked (OD-7) |'])),
      [],
    );
    expect(report.ok).toBe(true);
    expect(report.uncovered).toEqual([]);
    expect(report.blockedOnly).toEqual([3]);
    expect(formatReport(report)).toContain('Referenced only by Blocked tests: R3');
  });

  it('passes when a matrix row or a test header references the requirement', () => {
    expect(checkCoverage(parseAcceptanceMatrix(sample(['| AT-N-1 | ready | R3.1 | Ready |'])), []).ok).toBe(
      true,
    );
    expect(checkCoverage(parseAcceptanceMatrix(sample([])), [[3]]).ok).toBe(true);
  });
});

describe('repository coverage (runs as part of npm test)', () => {
  it('every requirement R1 to R35 has a referencing test', () => {
    const report = checkRepositoryCoverage(REPO_ROOT);
    expect(report.uncovered, formatReport(report)).toEqual([]);
    // Requirements whose only tests are Blocked by open decisions (R2: OD-9 FIX). R23 is covered since
    // task 12.4: the compiled risk worker test validates R23.4 (VaR outside the UI rendering path).
    expect(report.blockedOnly).toEqual([2]);
  });
});
