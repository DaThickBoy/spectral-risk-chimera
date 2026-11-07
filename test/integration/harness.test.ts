// AT-CFG-03: the test runner exits non-zero on a failing test and zero otherwise (task 1.5).
// Validates: Requirements 27.10, 27.3
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath, runNode } from '../helpers/repo.js';

const vitest = repoPath('node_modules', 'vitest', 'vitest.mjs');
const fixtureDir = repoPath('test', 'fixtures', 'vitest');
const run = (filter: string) => runNode(vitest, ['run', '--config', 'vitest.config.mjs', filter], fixtureDir);

describe('AT-CFG-03: test command exit codes', () => {
  it('exits non-zero when a test fails', () => {
    expect(run('failing.sample.ts').code).not.toBe(0);
  });

  it('exits zero when every test passes', () => {
    const result = run('passing.sample.ts');
    expect(result.code, result.stdout + result.stderr).toBe(0);
  });

  it('npm test runs the unit, property, and integration projects; live tests are opt-in', () => {
    const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test']).toBe('vitest run');
    expect(pkg.scripts['test:live']).toContain('vitest.live.config.ts');
    const config = readFileSync(repoPath('vitest.config.ts'), 'utf8');
    for (const name of ['unit', 'property', 'integration']) {
      expect(config).toContain(`name: '${name}'`);
    }
    expect(config).not.toMatch(/include: \['test\/live/);
  });
});
