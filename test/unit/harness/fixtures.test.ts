// AT-CFG-04: committed fixtures live in tracked, non-ignored paths (task 1.5).
// Validates: Requirements 27.11
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath, runGit } from '../../helpers/repo.js';

describe('AT-CFG-04: test fixtures are not ignored', () => {
  it.each(['test/fixtures/x', 'test/fixtures/lint/src/risk/nativeNumbers.ts', 'test/fixtures/benchmark.csv'])(
    'git check-ignore reports %s as not ignored',
    (file) => {
      // Exit code 1 means the path is not ignored.
      expect(runGit(['check-ignore', '-q', file]).code).toBe(1);
    },
  );

  it('.kiroignore does not exclude test/fixtures/', () => {
    const patterns = readFileSync(repoPath('.kiroignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    for (const pattern of patterns) {
      expect(pattern.startsWith('test')).toBe(false);
      expect(pattern).not.toMatch(/fixtures/);
    }
  });
});
