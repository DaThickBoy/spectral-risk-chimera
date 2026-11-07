// AT-ARC-03 (build part): tsc builds ES modules into an output directory, and the
// compiled entry point runs on Node.js without a TypeScript loader. The compiled
// risk worker start is completed in task 12.4.
// Validates: Requirements 26.6, 26.8
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, runNode, tempDir } from '../helpers/repo.js';

const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const temp = tempDir('build');
// Inside the repository's (ignored) node_modules so runtime dependencies resolve; dist/ is untouched.
const outDir = path.join(REPO_ROOT, 'node_modules', '.cache', `src-build-test-${process.pid}`);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}

let build = { code: null as number | null, stdout: '', stderr: '' };

beforeAll(() => {
  build = runNode(tsc, ['-p', 'tsconfig.build.json', '--outDir', outDir]);
});
afterAll(() => {
  temp.cleanup();
  rmSync(outDir, { recursive: true, force: true });
});

describe('AT-ARC-03 (build part)', () => {
  it('compiles with tsc', () => {
    expect(build.code, build.stdout + build.stderr).toBe(0);
  });

  it('emits JavaScript ES modules only, mirroring src/', () => {
    const files = listFiles(outDir).map((file) => path.relative(outDir, file).replaceAll('\\', '/'));
    expect(files).toContain('index.js');
    expect(files).toContain('shared/decimal.js');
    expect(files).toContain('config/loader.js');
    expect(files.filter((file) => file.endsWith('.ts'))).toEqual([]);
    const source = readFileSync(path.join(outDir, 'config', 'loader.js'), 'utf8');
    expect(source).toMatch(/^import /m);
    expect(source).not.toMatch(/\brequire\(|module\.exports|exports\./);
  });

  it('runs the compiled entry point with plain Node.js and no configuration', () => {
    expect(existsSync(path.join(outDir, 'index.js'))).toBe(true);
    const run = runNode(path.join(outDir, 'index.js'), [], temp.dir, {
      SRC_CONFIG_FILE: undefined,
      SEC_USER_AGENT: undefined,
    });
    expect(run.code, run.stderr).toBe(0);
    const records = run.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const summary = records.find((record) => record['msg'] === 'config.loaded');
    expect(summary?.['availableFeatures']).toEqual(['api']);
    expect(summary?.['missingFinancialKeys']).toHaveLength(24);
  });
});
