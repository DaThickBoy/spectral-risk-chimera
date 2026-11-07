// Test helpers: repository paths and child-process runners (no network access).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const repoPath = (...segments: string[]): string => path.join(REPO_ROOT, ...segments);

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a Node.js script from node_modules or the repository with the current Node binary. */
export function runNode(
  script: string,
  args: readonly string[],
  cwd: string = REPO_ROOT,
  envOverrides: Readonly<Record<string, string | undefined>> = {},
): RunResult {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...envOverrides,
  };
  const env = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Runs `git` in the repository. */
export function runGit(args: readonly string[]): RunResult {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Creates a temporary directory and returns it with a cleanup function. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `src-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
