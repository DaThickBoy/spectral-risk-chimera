// AT-ARC-06, AT-ARC-07 (static part): the CI workflow runs every gate on Node.js 24.22.1
// and 26 and includes the pinned secret scan. Passing and failing CI runs must still be
// recorded from GitHub Actions (tasks 1.6 and 3.5).
// Validates: Requirements 27.12, 27.13, 26.7, 24.1, 24.5
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';

const workflow = readFileSync(repoPath('.github', 'workflows', 'ci.yml'), 'utf8');

describe('CI workflow', () => {
  it('runs a matrix of Node.js 24.22.1 and 26 without fail-fast', () => {
    expect(workflow).toMatch(/node: \['24\.22\.1', '26'\]/);
    expect(workflow).toMatch(/fail-fast: false/);
  });

  it('runs every gate in order', () => {
    const steps = [
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm run deps:check',
      'npm test',
      'npm run build',
    ];
    let last = -1;
    for (const step of steps) {
      const index = workflow.indexOf(`run: ${step}`);
      expect(index, step).toBeGreaterThan(last);
      last = index;
    }
  });

  it('pins actions to commit SHAs', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('scans with a pinned, checksum-verified gitleaks', () => {
    expect(workflow).toContain('GITLEAKS_VERSION: 8.30.1');
    expect(workflow).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).toContain('--exit-code 1');
  });
});
