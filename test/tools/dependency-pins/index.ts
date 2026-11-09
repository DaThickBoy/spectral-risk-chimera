/**
 * Dependency pin and lockfile integrity check (tasks 1.2 and 25.3; R26.5; AT-ARC-05).
 *
 * Offline: reads only `package.json` and `package-lock.json`. It runs as part of
 * `npm test` and as an explicit CI step. A problem is reported, never fixed.
 *
 * Pins: every entry of `dependencies`, `devDependencies`, `optionalDependencies`,
 * and `peerDependencies` is an exact `MAJOR.MINOR.PATCH` version (optionally with a
 * pre-release suffix). Ranges (`^`, `~`, `*`, `x`, comparators, hyphen and `||`
 * ranges), tags (`latest`), partial versions, and non-registry specifiers (git,
 * GitHub, file, link, URL, `npm:` aliases, `workspace:`) are rejected.
 *
 * Lockfile: `lockfileVersion` 3 or later; the root entry declares exactly the same
 * dependency maps as `package.json` (so a stale lockfile is caught); every direct
 * dependency is locked at its pinned version; and every locked package (except
 * workspace links) carries a Subresource Integrity hash (`sha256`, `sha384`, or
 * `sha512`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** Exact version: MAJOR.MINOR.PATCH with an optional pre-release suffix. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

export type PackageManifest = Partial<Record<DependencyField, Readonly<Record<string, string>>>> &
  Readonly<Record<string, unknown>>;

export interface LockEntry {
  readonly version?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface Lockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockEntry>>;
}

/** Every dependency that is not pinned to an exact version. */
export function pinProblems(manifest: PackageManifest): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        problems.push(`${field}.${name} is not pinned to an exact version (${JSON.stringify(version)})`);
      }
    }
  }
  return problems;
}

const sameMap = (
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
) => {
  const left = Object.entries(a ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const right = Object.entries(b ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify(left) === JSON.stringify(right);
};

/** Every way the lockfile fails to match the manifest or lacks integrity data. */
export function lockfileProblems(manifest: PackageManifest, lock: Lockfile): string[] {
  const problems: string[] = [];
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 3) {
    problems.push(`lockfileVersion must be 3 or later (got ${JSON.stringify(lock.lockfileVersion)})`);
  }
  const packages = lock.packages;
  const root = packages?.[''];
  if (packages === undefined || root === undefined) {
    problems.push('the lockfile has no root package entry');
    return problems;
  }
  for (const field of DEPENDENCY_FIELDS) {
    if (!sameMap(manifest[field], root[field])) {
      problems.push(`the lockfile root ${field} differ from package.json (stale lockfile)`);
    }
  }
  for (const field of DEPENDENCY_FIELDS) {
    if (field === 'peerDependencies') {
      continue;
    }
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      const locked = packages[`node_modules/${name}`];
      if (locked === undefined) {
        problems.push(`${name} is not in the lockfile`);
      } else if (locked.version !== version) {
        problems.push(`${name} is locked at ${JSON.stringify(locked.version)}, not the pinned ${version}`);
      }
    }
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || entry.link === true) {
      continue;
    }
    if (typeof entry.integrity !== 'string' || !INTEGRITY.test(entry.integrity)) {
      problems.push(`${key} has no valid integrity hash`);
    }
  }
  return problems;
}

/** Runs both checks against the repository's package.json and package-lock.json. */
export function checkRepositoryDependencies(repoRoot: string): string[] {
  const read = (file: string): unknown => JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8'));
  const manifest = read('package.json') as PackageManifest;
  const lock = read('package-lock.json') as Lockfile;
  return [...pinProblems(manifest), ...lockfileProblems(manifest, lock)];
}
