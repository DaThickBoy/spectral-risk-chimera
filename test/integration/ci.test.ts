// AT-ARC-06, AT-ARC-07 (static part): the CI workflow runs every gate on Node.js 24.22.1
// and 26 and includes the pinned secret scan. Passing and failing CI runs must still be
// recorded from GitHub Actions (tasks 1.6 and 3.5).
// Task 25.3 adds the npm audit gate, the explicit pin and lockfile step, and SECURITY.md.
// Validates: Requirements 27.12, 27.13, 26.5, 26.7, 24.1, 24.5
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
    // The secret-scan job also installs and builds, so the order is checked within `verify`.
    const verify = workflow.slice(workflow.indexOf('  verify:'), workflow.indexOf('  e2e:'));
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
      const index = verify.indexOf(`run: ${step}`);
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

  it('task 25.3: audits all dependencies with npm audit, failing on high and critical findings', () => {
    const audit = workflow.slice(workflow.indexOf('dependency-audit:'), workflow.indexOf('  verify:'));
    expect(audit).toMatch(/^\s+run: npm audit --audit-level=high\r?$/m);
    // All dependencies, no suppression, no bypass.
    expect(audit).not.toMatch(
      /--omit|--production|--only|continue-on-error|\|\| true|--audit-level=(critical|none)/,
    );
    // The audit reads the lockfile: nothing is installed, no package scripts run.
    expect(audit).not.toContain('npm ci');
    expect(audit).not.toContain('npm install');
    expect(audit).not.toContain('if:');
  });

  it('task 25.3: verifies exact pins and lockfile integrity offline on both Node.js versions', () => {
    const verify = workflow.slice(workflow.indexOf('  verify:'));
    const pins = verify.indexOf('run: npx vitest run test/unit/build/packageConfig.test.ts');
    expect(pins).toBeGreaterThan(verify.indexOf('run: npm ci'));
    expect(pins).toBeLessThan(verify.indexOf('run: npm run typecheck'));
  });

  it('task 25.3: SECURITY.md documents the same gate and exceptions that never bypass it', () => {
    const security = readFileSync(repoPath('SECURITY.md'), 'utf8');
    expect(security).toContain('npm audit --audit-level=high');
    expect(security).toMatch(/Explicit approval/);
    expect(security).toMatch(/justification/i);
    expect(security).toMatch(/expiry date/i);
    expect(security).toContain('It does not suppress the finding');
    expect(security).not.toMatch(/--audit-level=(critical|none)|audit-ci|\.nsprc|auditConfig/);
  });

  it('scans with a pinned, checksum-verified gitleaks', () => {
    expect(workflow).toContain('GITLEAKS_VERSION: 8.30.1');
    expect(workflow).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).toContain('--exit-code 1');
  });

  describe('A3: scans the built dashboard that GitHub Pages publishes', () => {
    const job = workflow.slice(workflow.indexOf('  secret-scan:'), workflow.indexOf('  dependency-audit:'));
    const bundleConfig = readFileSync(repoPath('.gitleaks-bundle.toml'), 'utf8');
    const sourceConfig = readFileSync(repoPath('.gitleaks.toml'), 'utf8');
    const pages = readFileSync(repoPath('.github', 'workflows', 'pages.yml'), 'utf8');
    const scan =
      '"${RUNNER_TEMP}/gitleaks" dir dist/web --config .gitleaks-bundle.toml --redact --no-banner --exit-code 1';

    it('builds and records the replay, checks the bundle exists, then scans dist/web', () => {
      const order = [
        'run: npm ci',
        'run: npm run build',
        'run: npm run export:replay',
        'test -s dist/web/index.html',
        'test -s dist/web/replay/manifest.json',
        scan,
      ];
      let last = job.indexOf('dir . --config .gitleaks.toml');
      expect(last, 'source scan').toBeGreaterThan(-1);
      for (const step of order) {
        const index = job.indexOf(step);
        expect(index, step).toBeGreaterThan(last);
        last = index;
      }
      expect(job).not.toMatch(/continue-on-error|\|\| true|if:/);
    });

    it('L5: self-tests the bundle scan with a fake secret planted in a source map (sourcesContent)', () => {
      const name = '- name: Self-test, the bundle scan detects a fake secret in a source map';
      const step = job.slice(job.indexOf(name));
      expect(job.indexOf(name)).toBeGreaterThan(job.indexOf(scan));
      // A copy of the real bundle; the token goes into sourcesContent of a .js.map file.
      expect(step).toContain('cp -R dist/web "${canary}/dist/web"');
      expect(step).toContain("-name '*.js.map'");
      expect(step).toContain('map.sourcesContent[0] +=');
      // The same bundle config and flags as the real scan; the run must return exactly the leak code
      // and report the planted token in the .map file.
      expect(step).toContain('--config "${GITHUB_WORKSPACE}/.gitleaks-bundle.toml"');
      expect(step).toContain('--redact --no-banner --exit-code 1');
      expect(step).toContain('test "${code}" -eq 1');
      expect(step).toContain('"RuleID": *"github-pat"');
      expect(step).toContain('\\.js\\.map"');
      // No real or literal token in the repository: the prefix is joined at run time.
      expect(workflow).not.toMatch(/ghp_[A-Za-z0-9]{36}/);
    });

    it('scans the same directory that the Pages workflow uploads', () => {
      expect(pages).toMatch(/^\s+path: dist\/web\r?$/m);
    });

    it('uses a bundle config with the default rules and no allowlist that could hide dist/', () => {
      // The source config excludes dist/; reusing it would silently skip the whole bundle.
      expect(sourceConfig).toContain("'''(^|/)dist/'''");
      expect(bundleConfig).toMatch(/^useDefault = true\r?$/m);
      const settings = bundleConfig
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
      expect(settings).toEqual(['[extend]', 'useDefault = true']);
    });
  });
});
