# Security: dependency audit

This document describes how dependency vulnerability findings are handled in Spectral Risk Chimera (task 25.3, requirement R26.5). It does not change, suppress, or bypass any CI gate.

## The CI gate

The `dependency-audit` job in `.github/workflows/ci.yml` runs on every push and pull request:

```sh
npm audit --audit-level=high
```

- **Fails on high and critical findings.** Moderate, low, and info findings are reported in the job log but do not fail the job.
- **Audits all dependencies**, including dev dependencies. There is no `--omit` option.
- **Reads `package-lock.json` only.** Nothing is installed and no package scripts run.
- **Runs in CI only.** Local `npm test` stays offline and does not run the audit.

The `verify` job also checks, offline and on both Node.js versions, that every dependency is pinned to an exact version and that the lockfile matches `package.json` with an integrity hash for every package (AT-ARC-05).

## Reviewing a finding

Review every finding the audit reports, including those below the failing threshold.

1. Read the advisory: affected package, vulnerable versions, severity, and whether a fixed version exists.
2. Find how the package is reached (`npm ls <package>`), and whether it is a production or a dev dependency.
3. Assess whether the vulnerable code is reachable in how this project uses the package.
4. Resolve it by changing the dependency: upgrade to an exact fixed version, update the lockfile, and run the full verification suite. Do not use `npm audit fix --force`; a breaking upgrade is a reviewed change like any other.
5. If no acceptable fix exists, request an exception as described below.

## Exceptions

An exception records that a known finding is accepted for a limited time. Every exception needs all of the following:

- **Explicit approval** by the project owner, recorded by name and date.
- **A justification**: why the finding is not exploitable here, or why the risk is accepted, and what was checked.
- **An expiry date.** On expiry the exception lapses and the finding is reviewed again; it is not renewed automatically.

Record each exception in the table below.

An exception is a record only. It does not suppress the finding, hide it from the audit output, or make a failing CI job pass. While a high or critical finding exists, the `dependency-audit` job keeps failing. Any change to the gate itself (its command, threshold, or scope) is a change to `.github/workflows/ci.yml` and needs its own explicit approval.

| Advisory | Package | Severity | Justification | Approved by (date) | Expires |
| -------- | ------- | -------- | ------------- | ------------------ | ------- |
| None     |         |          |               |                    |         |

## Outstanding findings

Findings that are known, reviewed, and not yet resolved. An entry here is a tracking record only: it is not an exception, it does not suppress the finding or change the CI gate, and the finding keeps appearing in the audit output until the dependency is changed.

### GHSA-g3hv-75wg-m249 (CVE-2026-118764): minimatch

- **Status:** Open. Tracked; waiting for upstream support. Not fixed. Decision: track and wait for upstream (approved 2026-11-08).
- **Severity:** moderate (CWE-405). Below the failing threshold, so the `dependency-audit` job reports it without failing.
- **Advisory:** pattern amplification in `firstPhasePreProcess()` when `optimizationLevel` is 2 or higher. An attacker who can supply a glob pattern can cause excessive CPU and memory use.
- **Installed:** `minimatch@10.2.6` (one copy, `node_modules/minimatch`), a development dependency only.
- **Affected range:** `>=7.0.0 <11.0.1`. **First fixed version:** `11.0.1`. No patched 10.x release exists.
- **Audit report:** 10 moderate entries, all from this advisory: `minimatch` itself and the packages that depend on it.
- **Dependency paths** (from `npm ls minimatch --all`):
  - `eslint@10.14.0` → `minimatch@10.2.6` (declared range `^10.2.6`)
  - `eslint@10.14.0` → `@eslint/config-array@0.23.5` → `minimatch@10.2.6` (declared range `^10.2.4`)
  - `typescript-eslint@8.72.1` → `@typescript-eslint/typescript-estree@8.72.1` → `minimatch@10.2.6` (declared range `^10.2.2`); reached through `@typescript-eslint/parser`, `@typescript-eslint/utils`, `@typescript-eslint/type-utils`, and `@typescript-eslint/eslint-plugin`
- **Current reachability assessment (2026-11-08).** The vulnerable preprocessing in the installed `minimatch@10.2.6` runs only when `optimizationLevel` is 2 or higher; the default is 1. The three consumers above pass only `{ dot: true }` (`@eslint/config-array` adds only `flipNegate`), so none of them sets `optimizationLevel`. The patterns come from the repository's lint configuration and the lint command line. The project's own source and tests do not use `minimatch`. On this basis, the vulnerable code path does not appear to be reached in the current use.
- **Limitations of the assessment.** It was made by reading the installed versions of these packages at that date, not by running a proof-of-concept against them. It covers only the current installed versions and the current lint configuration and command lines. It no longer holds if any of these change: an upgrade of a consumer, a new consumer of `minimatch`, a consumer or configuration that sets `optimizationLevel` to 2 or higher, or glob patterns that come from an untrusted source. It does not mean the vulnerability is fixed or permanently unreachable.
- **Why not resolved now.** All three consumers are at their latest releases and still declare `minimatch ^10`, which excludes the fixed `11.x` line. Forcing `11.x` with an override would break their declared ranges and could change ESLint's file matching (11.0 changes partial matching and trailing-slash behaviour). `npm audit fix --force` would downgrade ESLint by a major version.
- **Remediation trigger.** When the upstream consumers (`eslint`, `@eslint/config-array`, and `@typescript-eslint/typescript-estree`, through `typescript-eslint`) officially support `minimatch` 11 (their published dependency ranges include `>=11.0.1`), upgrade them to exact pinned versions through the normal review in this document, confirm with `npm ls minimatch --all` and `npm audit` that no copy below `11.0.1` remains, and remove this entry.
- **Re-review.** Re-check this entry, including the reachability assessment, on every upgrade of a consumer listed above and whenever the audit output for this advisory changes.
