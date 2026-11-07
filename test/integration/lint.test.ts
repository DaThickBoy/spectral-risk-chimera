// AT-DEC-05, AT-DEC-06 (static part): ESLint financial rules fail seeded violations
// with the expected rule IDs, and the clean tree passes (task 1.3).
// Validates: Requirements 4.2, 4.4, 27.13
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../helpers/repo.js';

const fixtureRoot = repoPath('test', 'fixtures', 'lint');

async function lintFixture(): Promise<{ file: string; line: number; rule: string | null }[]> {
  const eslint = new ESLint({ cwd: fixtureRoot, overrideConfigFile: repoPath('eslint.config.js') });
  const results = await eslint.lintFiles(['src/**/*.ts']);
  return results.flatMap((result) =>
    result.messages.map((message) => ({
      file: path.relative(fixtureRoot, result.filePath).replaceAll('\\', '/'),
      line: message.line,
      rule: message.ruleId,
    })),
  );
}

describe('AT-DEC-05 / AT-DEC-06: ESLint financial rules', () => {
  it('reports each seeded violation with the expected rule ID', async () => {
    const found = await lintFixture();
    expect(found).toEqual(
      expect.arrayContaining([
        { file: 'src/risk/nativeNumbers.ts', line: 3, rule: 'no-restricted-globals' },
        { file: 'src/risk/nativeNumbers.ts', line: 4, rule: 'no-restricted-syntax' },
        { file: 'src/risk/nativeNumbers.ts', line: 5, rule: 'no-restricted-syntax' },
        { file: 'src/risk/nativeNumbers.ts', line: 6, rule: 'no-restricted-syntax' },
        { file: 'src/risk/nativeNumbers.ts', line: 7, rule: 'no-restricted-syntax' },
        { file: 'src/portfolio/directDecimal.ts', line: 2, rule: '@typescript-eslint/no-restricted-imports' },
        { file: 'src/portfolio/directDecimal.ts', line: 4, rule: 'no-restricted-syntax' },
        { file: 'src/portfolio/directDecimal.ts', line: 5, rule: 'no-restricted-properties' },
        { file: 'src/api/chartNumber.ts', line: 2, rule: 'no-restricted-syntax' },
      ]),
    );
    expect(found).toHaveLength(9);
  });

  it('allows the chart adapter and non-financial modules', async () => {
    const found = await lintFixture();
    expect(found.filter((entry) => entry.file === 'src/web/chartAdapter.ts')).toEqual([]);
    expect(found.filter((entry) => entry.file === 'src/config/notFinancial.ts')).toEqual([]);
  });

  it('the real tree passes lint', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const results = await eslint.lintFiles(['.']);
    const errors = results.flatMap((result) =>
      result.messages.map((message) => `${result.filePath}:${message.line} ${message.ruleId ?? ''}`),
    );
    expect(errors).toEqual([]);
  });
});
