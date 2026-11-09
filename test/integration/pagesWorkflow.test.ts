// OD-21 (approved 2026-11-09): the GitHub Pages workflow publishes only the static dashboard with
// the deterministic replay, after validation, the replay export, and the browser tests, with least
// privilege and one deployment at a time. Static checks only: the workflow's run on GitHub must be
// verified there (no YAML parser or actionlint is installed locally). Also checks the CI e2e job.
// Validates: Requirements 27.12, 26.5, 24.1
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';

const pages = readFileSync(repoPath('.github', 'workflows', 'pages.yml'), 'utf8');
const ci = readFileSync(repoPath('.github', 'workflows', 'ci.yml'), 'utf8');
const section = (text: string, start: string, end?: string): string =>
  text.slice(text.indexOf(start), end === undefined ? undefined : text.indexOf(end));

describe('Pages workflow', () => {
  it('runs on main and by hand, with read-only default permissions and serialized deployments', () => {
    expect(pages).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:$/m);
    expect(pages).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(pages).toMatch(/^concurrency:\n {2}group: pages\n {2}cancel-in-progress: false$/m);
    expect(pages).not.toMatch(/pull_request/);
  });

  it('validates, builds, records the replay, and runs the browser tests before uploading', () => {
    const build = section(pages, '  build:', '  deploy:');
    const steps = [
      'run: npm ci',
      'run: npm run typecheck',
      'run: npm run lint',
      'run: npm run format:check',
      'run: npm run deps:check',
      'run: npm test',
      'run: npm run build',
      'run: npm run export:replay',
      'run: npx playwright install --with-deps chromium',
      'run: npm run test:e2e',
      'uses: actions/configure-pages@',
      'uses: actions/upload-pages-artifact@',
    ];
    let last = -1;
    for (const step of steps) {
      const index = build.indexOf(step);
      expect(index, step).toBeGreaterThan(last);
      last = index;
    }
    expect(build).toMatch(/node-version: '24\.22\.1'/);
    expect(build).toMatch(/permissions:\n {6}contents: read/);
    // Only the static dashboard directory is published.
    expect(build).toMatch(/with:\n {10}path: dist\/web\n/);
  });

  it('only the deploy job can write to Pages, from main, through the github-pages environment', () => {
    const deploy = section(pages, '  deploy:');
    expect(deploy).toMatch(/needs: build/);
    expect(deploy).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(deploy).toMatch(/permissions:\n {6}pages: write\n {6}id-token: write\n/);
    expect(deploy).toMatch(/name: github-pages/);
    expect(deploy).toMatch(/uses: actions\/deploy-pages@/);
    expect(deploy).not.toMatch(/run:/);
    expect(pages.match(/pages: write/g)).toHaveLength(1);
  });

  it('pins every action to a commit SHA and uses no secret, backend, or paid service', () => {
    const uses = [...pages.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? '');
    expect(uses.length).toBe(5);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
    expect(pages).not.toMatch(
      /secrets\.|GITHUB_TOKEN|npm start|start\.js|SRC_DATABASE_FILE|SEC_USER_AGENT|API_KEY/,
    );
    expect(pages).toMatch(/persist-credentials: false/);
  });

  it('documents the one-time manual Pages setting', () => {
    expect(pages).toContain('Settings -> Pages -> Build and deployment -> Source: "GitHub Actions"');
  });
});

describe('CI browser-test job', () => {
  it('builds, records the replay, installs Chromium, and runs Playwright', () => {
    const e2e = section(ci, '  e2e:');
    const steps = [
      'run: npm ci',
      'run: npm run build',
      'run: npm run export:replay',
      'run: npx playwright install --with-deps chromium',
      'run: npm run test:e2e',
    ];
    let last = -1;
    for (const step of steps) {
      const index = e2e.indexOf(step);
      expect(index, step).toBeGreaterThan(last);
      last = index;
    }
    for (const action of [...e2e.matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? '')) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
