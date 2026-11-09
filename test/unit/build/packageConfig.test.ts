// AT-ARC-04, AT-ARC-05: package, TypeScript, and dependency pinning configuration. Task 25.3
// adds the lockfile integrity check and seeded range and stale-lockfile cases; CI runs this
// file as an explicit offline step.
// Validates: Requirements 26.4, 26.5, 26.7, 26.8
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath, runGit } from '../../helpers/repo.js';
import {
  checkRepositoryDependencies,
  lockfileProblems,
  pinProblems,
} from '../../tools/dependency-pins/index.js';
import type { Lockfile, PackageManifest } from '../../tools/dependency-pins/index.js';

interface PackageJson {
  type?: string;
  main?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(repoPath(file), 'utf8'));
const pkg = readJson('package.json') as PackageJson;

describe('AT-ARC-04: ES modules and strict TypeScript', () => {
  it('declares "type": "module" and pins engines.node to 24.22.1', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('24.22.1');
    expect(readFileSync(repoPath('.nvmrc'), 'utf8').trim()).toBe('24.22.1');
  });

  it('has no placeholder main entry and defines build and typecheck scripts', () => {
    expect(pkg.main).toBeUndefined();
    // Task 17.2: the backend tsc build runs first, then the separate dashboard Vite build, so CI's
    // `npm run build` covers both; typecheck also checks the dashboard and its tests.
    expect(pkg.scripts?.['build']).toBe(
      'tsc -p tsconfig.build.json && vite build --config vite.web.config.ts',
    );
    expect(pkg.scripts?.['typecheck']).toBe(
      'tsc --noEmit && tsc -p src/web/tsconfig.json && tsc -p test/web/tsconfig.json',
    );
  });

  it('uses strict mode, NodeNext, and verbatimModuleSyntax', () => {
    const tsconfig = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    const options = tsconfig.compilerOptions;
    expect(options['strict']).toBe(true);
    expect(options['noUncheckedIndexedAccess']).toBe(true);
    expect(options['noImplicitOverride']).toBe(true);
    expect(options['noFallthroughCasesInSwitch']).toBe(true);
    expect(options['exactOptionalPropertyTypes']).toBe(true);
    expect(options['module']).toBe('NodeNext');
    expect(options['moduleResolution']).toBe('NodeNext');
    expect(options['verbatimModuleSyntax']).toBe(true);
  });

  it('builds src/ into dist/ with the build configuration', () => {
    const build = readJson('tsconfig.build.json') as {
      extends: string;
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.compilerOptions['outDir']).toBe('dist');
    expect(build.compilerOptions['rootDir']).toBe('src');
    expect(build.include).toEqual(['src/**/*.ts']);
  });
});

describe('AT-ARC-05: exact dependency pins and lockfile', () => {
  const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

  it('pins every dependency to an exact version', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(all)) {
      expect(version, `${name} must be pinned exactly`).toMatch(exact);
    }
  });

  it('includes the approved toolchain', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      'typescript',
      'zod',
      'decimal.js',
      'vitest',
      'fast-check',
      'eslint',
      'typescript-eslint',
      'prettier',
      'dependency-cruiser',
    ]) {
      expect(all, `${name} is part of the approved toolchain`).toHaveProperty(name);
    }
    expect(all['zod']).toMatch(/^4\./);
  });

  it('the repository passes the full pin and lockfile integrity check', () => {
    expect(checkRepositoryDependencies(REPO_ROOT)).toEqual([]);
  });

  it('sets save-exact and keeps a lockfile that Git does not ignore', () => {
    expect(readFileSync(repoPath('.npmrc'), 'utf8')).toMatch(/^save-exact=true$/m);
    expect(existsSync(repoPath('package-lock.json'))).toBe(true);
    const lock = readJson('package-lock.json') as { lockfileVersion: number };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
    // Exit code 1 means "not ignored".
    expect(runGit(['check-ignore', '-q', 'package-lock.json']).code).toBe(1);
  });
});

describe('AT-ARC-05 (seeded): a dependency added with a range or a stale lockfile fails', () => {
  const manifest = readJson('package.json') as PackageManifest;
  const lock = readJson('package-lock.json') as Lockfile;
  const withDependency = (field: 'dependencies' | 'devDependencies', name: string, version: string) =>
    ({ ...manifest, [field]: { ...manifest[field], [name]: version } }) as PackageManifest;

  it.each([
    '^1.3.0',
    '~1.3.0',
    '*',
    '',
    'latest',
    '>=1.0.0',
    '<2.0.0',
    '1.x',
    '1.3.x',
    '1.3',
    '1',
    '1.3.0 - 2.0.0',
    '1.3.0 || 2.0.0',
    '=1.3.0',
    'v1.3.0',
    'github:example/left-pad',
    'git+https://example.invalid/left-pad.git',
    'file:../left-pad',
    'link:../left-pad',
    'https://example.invalid/left-pad-1.3.0.tgz',
    'npm:left-pad@^1.3.0',
    'workspace:*',
  ])('a dependency pinned as %j is rejected', (version) => {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const problems = pinProblems(withDependency(field, 'left-pad', version));
      expect(problems).toEqual([
        `${field}.left-pad is not pinned to an exact version (${JSON.stringify(version)})`,
      ]);
    }
  });

  it.each(['1.3.0', '0.0.1', '10.20.30', '4.0.0-beta.1', '1.0.0-rc.1.2'])(
    'an exact version %s is accepted',
    (version) => {
      expect(pinProblems(withDependency('dependencies', 'left-pad', version))).toEqual([]);
    },
  );

  it('optional and peer dependencies are checked too', () => {
    expect(
      pinProblems({ ...manifest, optionalDependencies: { a: '^1.0.0' }, peerDependencies: { b: '>=2' } }),
    ).toEqual([
      'optionalDependencies.a is not pinned to an exact version ("^1.0.0")',
      'peerDependencies.b is not pinned to an exact version (">=2")',
    ]);
  });

  it('a dependency added to package.json without updating the lockfile is a stale lockfile', () => {
    const added = withDependency('dependencies', 'left-pad', '1.3.0');
    expect(lockfileProblems(added, lock)).toEqual([
      'the lockfile root dependencies differ from package.json (stale lockfile)',
      'left-pad is not in the lockfile',
    ]);
  });

  it('a pin that differs from the locked version is rejected', () => {
    const [name, version] = Object.entries(manifest.dependencies ?? {})[0] ?? ['', ''];
    const bumped = withDependency('dependencies', name, `${version}-changed.0`);
    expect(lockfileProblems(bumped, lock)).toContain(
      `${name} is locked at ${JSON.stringify(version)}, not the pinned ${version}-changed.0`,
    );
  });

  it('a locked package without a valid integrity hash is rejected; workspace links are exempt', () => {
    const packages = { ...lock.packages } as Record<string, Record<string, unknown>>;
    const [firstKey = ''] = Object.keys(packages).filter((key) => key !== '');
    const missing = {
      ...lock,
      packages: { ...packages, [firstKey]: { ...packages[firstKey], integrity: undefined } },
    };
    expect(lockfileProblems(manifest, missing as Lockfile)).toEqual([
      `${firstKey} has no valid integrity hash`,
    ]);
    const malformed = {
      ...lock,
      packages: { ...packages, [firstKey]: { ...packages[firstKey], integrity: 'md5-abc' } },
    };
    expect(lockfileProblems(manifest, malformed as Lockfile)).toEqual([
      `${firstKey} has no valid integrity hash`,
    ]);
    const link = {
      ...lock,
      packages: { ...packages, 'node_modules/local-link': { link: true, resolved: 'packages/x' } },
    };
    expect(lockfileProblems(manifest, link as Lockfile)).toEqual([]);
  });

  it('an old lockfile version or a missing root entry is rejected', () => {
    expect(lockfileProblems(manifest, { ...lock, lockfileVersion: 2 })).toEqual([
      'lockfileVersion must be 3 or later (got 2)',
    ]);
    expect(lockfileProblems(manifest, { lockfileVersion: 3, packages: {} })).toEqual([
      'the lockfile has no root package entry',
    ]);
  });
});
