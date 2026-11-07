# Implementation Plan

## Overview

This plan implements `.kiro/specs/requirements.md` and `.kiro/specs/design.md` under the steering rules in `.kiro/steering/`. Phases follow the design's [Incremental Delivery Plan](design.md#incremental-delivery-plan). It is a plan only; it does not change any requirement, design decision, acceptance test, or correctness property.

## Notes

### Conventions

- **IDs.** Top-level tasks are numbered `1` to `25`; subtasks are `n.m`. IDs are stable; new work gets new IDs rather than renumbering.
- **Each subtask lists:**
  - **Outcome**: the concrete result.
  - **Depends on**: earlier task IDs.
  - **Blocked by**: open decisions that must be approved first (omitted when none).
  - **Done when**: measurable completion criteria.
  - **Verify**: how the result is checked.
  - **Tests** and **Properties**: the acceptance tests (`AT-*`) and correctness properties (`Property N`, defined in the design) that the subtask delivers.
  - The `_Requirements:_` line, plus a **Rules** line for FR-n, NFR-PERF-1, the Configuration section, and assumptions.
- **Financial values in tests.** Tests supply every financially significant setting explicitly. Values still open in OD-6 or OD-1 are never written into code, fixtures used for production, or the configuration template. A task that needs such a value for real use says so under "Blocked by"; its implementation and tests can proceed with explicit test values.
- **Blocked work** is split from unblocked work. A blocked subtask stays unchecked until its decision is recorded as Resolved in the requirements' Open Decisions table.
- **Every financial calculation** gets unit tests with a hand-calculated case and property tests against an independent rational (BigInt) reference, as `financial-rules.md` requires.

### Decision blockers

| Decision | Status | Blocks | Unblocked work that can proceed |
|---|---|---|---|
| OD-1 Sentiment aggregation formula | Open | 13.5 (AT-SEN-21) | Aggregator interface and contract tests (13.4); everything else in phase 4 |
| OD-2 Reference hardware | Open | 25.1 (AT-CSV-21, AT-FIX-07 enforcement, AT-DSH-04, budget enforcement) | Benchmarks that record the environment (7.7, 12.7, 13.7) |
| OD-3 Exchange holiday calendar | Open | 9.5 (AT-MD-15) | Weekends-only `TradingCalendar` (9.2) |
| OD-4 FX risk in VaR | Open | No task models FX scenario risk; FX is held constant (A-9) | All FX work (10.1) |
| OD-5 FX provider | Open | 10.2 | Fixture FX provider and `FxService` (10.1) |
| OD-6 Financial values | Open | Production configuration only | All implementation; tests supply explicit values |
| OD-7 Authentication | Open | 23.1 (AT-SEC-20) | Loopback-only binding and refusal to bind elsewhere without an `AuthGuard` (4.2) |
| OD-9 FIX support | Open | 18.2, 18.3 (AT-FIX-01 to AT-FIX-07) | Structural FIX tokenizer (18.1) |
| OD-10 Risk contribution | Open | No calculation task | Dashboard shows "not available" (17.1) |
| OD-12 Persistence | Open | 5.3 (AT-CSV-12; Property 21 on a real adapter) | Ports and in-memory unit of work (5.1) |
| OD-13 Market data and sentiment vendors | Open | 9.6, 13.8 | Fixture providers (9.1, 13.1) |
| OD-15 NLP chunking | Open | 21.2 | NLP port, fallback provider, filing scores for single-request text (21.1, 21.3) |
| OD-16 Lossless JSON library | Open | 8.4. The SEC client and filing locator (19.2, 20.1) require 8.4 because SEC responses are JSON (required dependency recorded in each). Real provider adapters 9.6, 10.2, and 13.8 also need it only if their approved vendor delivers JSON (conditional dependency recorded in each) | Wrapper interface and contract tests (8.1) |
| OD-17 Fastify | Provisional | 4.1 is the confirmation gate for 4.2 onward | Phase 1 |

OD-8 and OD-14 have interim positions in the requirements that the tasks implement as written (7.3, 12.2). OD-11 and OD-18 are Resolved.

## Tasks

### Phase 1: Foundations

- [ ] 1. Project scaffolding, toolchain, and CI

- [ ] 1.1 Convert the package to strict TypeScript with ES modules and a `tsc` build
  - Outcome: `package.json` has `"type": "module"`, `engines.node` `24.22.1`, and scripts `build` (`tsc` to `dist/`) and `typecheck` (`tsc --noEmit`). `.nvmrc` contains `24.22.1`. `tsconfig.json` has `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`, `module`/`moduleResolution` `NodeNext`, and `verbatimModuleSyntax`. The placeholder `main` entry is removed or pointed at `dist/`.
  - Depends on: none
  - Done when: `npm run build` emits ES module `.js` files into `dist/`; `npm run typecheck` passes on an empty `src/index.ts`; `dist/` stays git-ignored.
  - Verify: AT-ARC-04 as a test that reads `package.json` and `tsconfig.json`. Build portion of AT-ARC-03 (the compiled worker start is completed in 12.4).
  - Tests: AT-ARC-04, AT-ARC-03
  - Properties: none
  - _Requirements: 26.4, 26.6, 26.7, 26.8_

- [ ] 1.2 Install the pinned toolchain and commit the lockfile
  - Outcome: exact-version dev and runtime dependencies for TypeScript, Zod 4, Decimal.js, Vitest, fast-check, ESLint with typescript-eslint, Prettier, and dependency-cruiser. `.npmrc` sets `save-exact=true`. `package-lock.json` is committed. Playwright is added later, in 17.5.
  - Depends on: 1.1
  - Done when: no dependency version in `package.json` uses `^`, `~`, or a range; `npm ci` succeeds from the lockfile on Node.js 24.22.1.
  - Verify: AT-ARC-05 as a test that parses `package.json` and checks that the lockfile is present.
  - Tests: AT-ARC-05
  - Properties: none
  - _Requirements: 26.5, 26.7_

- [ ] 1.3 Configure ESLint with the financial rules, and Prettier
  - Outcome: ESLint flat config with typescript-eslint strict rules. In `risk/`, `portfolio/`, `fx/`, and `ingestion/`, it forbids `parseFloat`, `Number(`, unary `+`, and `Math.*`. It forbids `new Decimal(` and `Decimal.clone` outside `src/shared/decimal.ts`, and forbids importing `toChartNumber` anywhere except `src/web/chartAdapter.ts`. Prettier config, plus `lint` and `format:check` scripts.
  - Depends on: 1.2
  - Done when: seeded violation files under `test/fixtures/lint/` fail `npm run lint` with the expected rule IDs, and the clean tree passes.
  - Verify: a Vitest test runs ESLint programmatically on the seeded fixtures and asserts each violation (AT-DEC-05, AT-DEC-06 static part).
  - Tests: AT-DEC-05, AT-DEC-06
  - Properties: none
  - _Requirements: 4.2, 4.4, 27.13_

- [ ] 1.4 Configure dependency-cruiser module boundaries
  - Outcome: rules matching the `architecture.md` module table. Domain modules may not import `adapters/`, `persistence/` implementations, `app/`, `api/`, or `web/`. `risk/` may not import `sec/` or `nlp/`. `web/` may not import domain modules. Cross-module imports go through `index.ts`. A `deps:check` script.
  - Depends on: 1.2
  - Done when: seeded violating imports in a fixture tree fail `npm run deps:check` naming the rule; the real tree passes.
  - Verify: AT-ARC-01, AT-ARC-02 as tests that run dependency-cruiser on the seeded fixture tree. This is the static part of Property 11.
  - Tests: AT-ARC-01, AT-ARC-02
  - Properties: Property 11
  - _Requirements: 11.5, 26.1, 26.2, 26.10_

- [ ] 1.5 Set up the Vitest test harness and fixture layout
  - Outcome: Vitest projects for `test/unit`, `test/property`, and `test/integration`. A separate opt-in `test:live` script for tests that need network access. `npm test` runs unit, property, and integration suites and exits non-zero on failure. `test/fixtures/` is a tracked path.
  - Depends on: 1.2
  - Done when: a deliberately failing sample test makes `npm test` exit non-zero, and after its removal `npm test` exits zero; `git check-ignore test/fixtures/x` reports not ignored.
  - Verify: AT-CFG-03, AT-CFG-04.
  - Tests: AT-CFG-03, AT-CFG-04
  - Properties: none
  - _Requirements: 27.3, 27.10, 27.11_

- [ ] 1.6 Add CI on Node.js 24.22.1 and Node.js 26
  - Outcome: a CI workflow with a matrix of Node.js 24.22.1 and 26 that runs `npm ci`, `typecheck`, `lint`, `format:check`, `deps:check`, `test`, and `build`, failing on any error.
  - Depends on: 1.3, 1.4, 1.5
  - Done when: a branch with a seeded type error, lint error, formatting difference, or boundary violation fails CI on both Node versions, and a clean branch passes on both.
  - Verify: AT-ARC-06, AT-ARC-07, recorded with links to the passing and failing CI runs.
  - Tests: AT-ARC-06, AT-ARC-07
  - Properties: none
  - _Requirements: 27.12, 27.13_

- [ ] 1.7 Add the requirement coverage check
  - Outcome: `test/tools/coverage-matrix` parses the Acceptance Test Matrix and the `// Validates: Requirements ...` headers of test files. It fails when a requirement R1 to R35 has no referencing test, ignoring tests marked `Blocked`. It runs as part of `npm test`.
  - Depends on: 1.5
  - Done when: removing every test that references one requirement makes the check fail and name it.
  - Verify: a unit test of the script against a small sample matrix.
  - Tests: none
  - Properties: none
  - _Requirements: 27.1, 27.2, 27.4, 27.6, 27.8_

- [ ] 2. Shared financial primitives

- [ ] 2.1 Implement the Decimal helper
  - Outcome: `src/shared/decimal.ts` exports `DEC` (Decimal.js clone, precision 40, `ROUND_HALF_UP`), `d()` (accepts only strings or Decimals; rejects JS numbers, `NaN`, `Infinity`, and exponent notation), `toCanonical()` (no exponent, no trailing fractional zeros, no `-0`), `roundMoney()` (display only), and `toChartNumber()` (the only native-number conversion).
  - Depends on: 1.3, 1.5
  - Done when: hand-calculated unit cases pass, including `"0.1"` added 10,000 times equals `"1000"`, and `1.2345678901 × 1000.01` is exact; `d(0.1)` and `d("1e-5")` are rejected.
  - Verify: unit tests for AT-DEC-01, AT-DEC-02, AT-DEC-03, AT-DEC-04, AT-DEC-07.
  - Tests: AT-DEC-01, AT-DEC-02, AT-DEC-03, AT-DEC-04, AT-DEC-07
  - Properties: Property 1, Property 2
  - Rules: FR-14
  - _Requirements: 4.1, 4.3, 4.5, 4.6, 4.7, 30.4_

- [ ] 2.2 Write property tests for decimal exactness and canonical round trips
  - Outcome: `test/property/decimal.property.test.ts` with an independent BigInt-fraction reference. Property 1: any list of decimal strings sums exactly. Property 2: canonical form is stable under round trips through `d()` and JSON.
  - Depends on: 2.1
  - Done when: both properties pass at least 1,000 generated cases each, and the file header names `Property 1`, `Property 2`, and their `Validates` requirements.
  - Verify: `npm test`.
  - Tests: AT-DEC-01, AT-DEC-04
  - Properties: Property 1, Property 2
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 27.4_

- [ ] 2.3 Implement canonical JSON and hashing
  - Outcome: `src/shared/canonical.ts` with `canonicalJson` (keys sorted by code point, no whitespace, decimals already strings, UTC ISO timestamps with milliseconds) and `sha256Hex`.
  - Depends on: 2.1
  - Done when: canonical output is identical for any key or array insertion order of the same object (defined arrays are sorted by the caller), and hashes match known SHA-256 vectors.
  - Verify: unit tests and a fast-check permutation test (AT-REP-05).
  - Tests: AT-REP-05
  - Properties: none
  - _Requirements: 32.3_

- [ ] 2.4 Implement `Clock`, `Result`, errors, ids, and `BoundedQueue`
  - Outcome: `Clock` interface with a real and a fake implementation (UTC time and monotonic milliseconds). `Result<T, E>` and typed error-code unions. Id generation. `BoundedQueue` with coalescing by key and drop-oldest.
  - Depends on: 1.5
  - Done when: unit tests cover fake-clock advancement, queue coalescing, drop-oldest, and the dropped counter.
  - Verify: `npm test`. The queue's property test is in 13.2 (Property 29).
  - Tests: none
  - Properties: none
  - _Requirements: 26.2, 33.5_

- [ ] 2.5 Implement redaction and the structured logger
  - Outcome: `src/shared/redact.ts` removes API keys, tokens, `Authorization` and cookie headers, the SEC contact from `SEC_USER_AGENT`, and FIX `Account` (tag 1) values. A structured JSON logger with correlation ids routes every log through `redact()`.
  - Depends on: 2.4
  - Done when: a property test over generated payloads never finds a configured secret or account value in the output.
  - Verify: unit tests and the Property 35 property test (AT-SEC-19).
  - Tests: AT-SEC-19
  - Properties: Property 35
  - _Requirements: 24.7, 29.12_

- [ ] 2.6 Implement the shared Zod 4 primitives and score schemas
  - Outcome: `DecimalStringSchema` (fixed grammar, exponent notation rejected), `PositiveDecimalString`, `UnitIntervalDecimalString` (FilingRiskScore), `SignedUnitDecimalString` (SentimentIndex), `IsoDate`, `IsoTimestamp` (`z.iso.datetime({ offset: true })`), and `Iso4217Code`. `SentimentIndex` and `FilingRiskScore` are distinct branded types that are not assignable to each other.
  - Depends on: 2.1
  - Done when: out-of-range, non-finite, JSON-number, and exponent inputs are rejected without clamping; a type-level test proves the two score types are not interchangeable.
  - Verify: unit tests plus the schema part of the Property 17 property test.
  - Tests: AT-DEC-07
  - Properties: Property 17
  - _Requirements: 4.6, 21.1, 21.2, 21.3_

- [ ] 3. Configuration and secrets

- [ ] 3.1 Implement the configuration schema
  - Outcome: `src/config/schema.ts` defines `ConfigSchema` with `z.strictObject` groups mirroring the requirements' Configuration table. Class F keys have no `.default()`. Class O keys declare their documented defaults, flagged provisional where the table says so. Validation covers: confidence in (0, 1); `horizonDays` literal 1; `minObservations` <= `lookbackReturns`; threshold in [-1, 1]; multiplier >= 1; `windowSeconds` <= `maxAgeSeconds`; `resetPct` <= threshold; enumerations. There is no `adjustment.enabled` key.
  - Depends on: 2.6
  - Done when: each validation rule has a passing and a failing unit case; an `adjustment.enabled` key is rejected as unknown.
  - Verify: AT-CFG-01, AT-SEN-16, AT-SEN-26, and the configuration part of AT-SEN-15 (completed in 14.1).
  - Tests: AT-CFG-01, AT-SEN-16, AT-SEN-26
  - Properties: none
  - Rules: Configuration
  - _Requirements: 14.2, 14.3, 15.1, 29.5_

- [ ] 3.2 Implement the configuration loader and feature availability
  - Outcome: `src/config/loader.ts` reads only the JSONC file named by `SRC_CONFIG_FILE`. It refuses a path that resolves to `config/config.template.jsonc`, treats `null` as absent, and parses feature by feature. It returns a feature-availability map (feature → missing or invalid keys) for: Base VaR, Adjusted VaR, sentiment ingestion, alerts, import, and filing. It logs a start-up summary listing provisional operational defaults. It assigns `ConfigVersion` (monotonic sequence plus SHA-256 of the canonical configuration).
  - Depends on: 3.1, 2.3, 2.5
  - Done when: omitting each class F key disables only its dependent features with the key named, and the process still starts; no value is ever substituted; a missing runtime file reports every class F key as missing.
  - Verify: AT-CFG-05, AT-CFG-06, and the loader part of AT-CFG-07 as unit tests with temporary files.
  - Tests: AT-CFG-05, AT-CFG-06
  - Properties: none
  - Rules: Configuration
  - _Requirements: 32.7_

- [ ] 3.3 Add the configuration template conformance test
  - Outcome: a test checks the existing `config/config.template.jsonc`. Its keys equal the class F keys of `ConfigSchema`. The approved values are exact (`"0.95"`, `1`, `250`, `200`, `"-0.60"`, `"1.15"`, `"ADJUSTED"`), every other value is `null` with an `OD-n` or operator comment, there is no `enabled` key, and the loader refuses the file. The template's values are not changed by this task.
  - Depends on: 3.2
  - Done when: the test passes against the committed template and fails if any approved value or placeholder is altered.
  - Verify: AT-CFG-07.
  - Tests: AT-CFG-07
  - Properties: none
  - Rules: Configuration
  - _Requirements: 14.2, 14.4, 13.1, 15.1, 18.1_

- [ ] 3.4 Implement `EnvSchema` and `.env.example`
  - Outcome: `EnvSchema` (Zod) for `SRC_CONFIG_FILE`, `SEC_USER_AGENT`, and provider credentials. Secrets never enter `AppConfig`. `.env.example` contains placeholders only.
  - Depends on: 2.6, 1.5
  - Done when: `.env.example` has no real values; `.env` is ignored by Git; missing `SEC_USER_AGENT` disables only SEC retrieval.
  - Verify: AT-CFG-02 as a test that checks the placeholders and runs `git check-ignore .env`.
  - Tests: AT-CFG-02
  - Properties: none
  - _Requirements: 24.2, 24.3, 24.4, 6.6_

- [ ] 3.5 Add secret scanning to CI
  - Outcome: a secret-scanning step in CI over source, tests, fixtures, and committed configuration, using a scanner selected and pinned to an exact version in this task. It is extended to the built frontend bundle in 17.6.
  - Depends on: 1.6
  - Done when: a seeded fake credential in a fixture fails CI, and the clean tree passes.
  - Verify: AT-SEC-24 (repository part).
  - Tests: AT-SEC-24
  - Properties: none
  - _Requirements: 24.1, 24.5_

### Phase 2: HTTP API gateway and transaction import

- [ ] 4. HTTP API gateway

- [ ] 4.1 Decision gate: confirm Fastify
  - Outcome: OD-17 is recorded as Resolved (Fastify confirmed) or replaced by an approved alternative before gateway code is written.
  - Depends on: none
  - Blocked by: OD-17 (provisional)
  - Done when: the requirements' Open Decisions table shows OD-17 Resolved.
  - Verify: review of the decision record.
  - Tests: none
  - Properties: none
  - _Requirements: 26.9_

- [ ] 4.2 Implement the gateway skeleton with validation and safe errors
  - Outcome:
    - `src/api/server.ts` binds to `127.0.0.1` only (A-15) and refuses to bind to any other address unless an `AuthGuard` implementation is configured.
    - Every route validates body, query, and parameters with `z.strictObject`.
    - A global error handler returns a generic body with a correlation id. Redacted logging.
    - A shared API contract module (request, response, and WebSocket event schemas) is importable by `api/` and later `web/`.
  - Depends on: 4.1, 3.2, 3.4, 2.5
  - Done when: unknown fields return HTTP 400; an injected internal error returns a generic body with no stack trace or path; a non-loopback bind without an `AuthGuard` fails to start.
  - Verify: integration tests with Fastify `inject()` for AT-SEC-26 and AT-SEC-27.
  - Tests: AT-SEC-26, AT-SEC-27
  - Properties: none
  - Rules: A-15
  - _Requirements: 24.5, 24.6, 26.9, 29.5, 29.13_

- [ ] 4.3 Add per-client rate limiting
  - Outcome: a token bucket per client for `api.rateLimitPerMinute` and `api.uploadRateLimitPerMinute`, returning HTTP 429.
  - Depends on: 4.2
  - Done when: the request after the limit receives 429 under a fake clock, and capacity refills over time.
  - Verify: AT-SEC-21.
  - Tests: AT-SEC-21
  - Properties: none
  - _Requirements: 29.4_

- [ ] 4.4 Add safe upload handling
  - Outcome: multipart upload streamed into memory, capped at `import.maxFileBytes` before parsing. Filenames are sanitized, never used to build file system paths, and stored under generated names.
  - Depends on: 4.2
  - Done when: an oversized upload is rejected with `FILE_TOO_LARGE` before parsing; path-traversal filenames such as `../../x.csv` never reach the file system.
  - Verify: AT-SEC-25 and the size part of AT-CSV-08.
  - Tests: AT-SEC-25, AT-CSV-08
  - Properties: none
  - _Requirements: 28.4, 29.6_

- [ ] 5. Persistence ports and audit

- [ ] 5.1 Define persistence ports and an in-memory unit of work
  - Outcome: `src/persistence/ports.ts` with the repository interfaces from the design and `UnitOfWork.run`. An in-memory implementation for tests, with fault injection that fails a commit and rolls back all writes. Financial columns are modelled as canonical decimal strings.
  - Depends on: 2.4
  - Done when: a failed commit leaves every repository unchanged; repositories reject `number` values for financial fields at the type level.
  - Verify: unit tests of rollback and isolation.
  - Tests: none
  - Properties: none
  - _Requirements: 4.3, 28.15, 28.16_

- [ ] 5.2 Implement the append-only audit log
  - Outcome: `src/audit/auditLog.ts` with `append(event)` only, no update or delete API, the design's categories, and `redact()` on details.
  - Depends on: 5.1, 2.5
  - Done when: ingestion, validation, provider, and calculation errors are recorded with timestamps; no API can modify or remove an entry; details pass redaction.
  - Verify: AT-AUD-05.
  - Tests: AT-AUD-05
  - Properties: none
  - _Requirements: 22.6, 3.3_

- [ ] 5.3 (Blocked) Implement the approved persistence adapter
  - Outcome: the persistence technology approved in OD-12, with migrations, `TEXT` columns for every financial value, append-only enforcement for `audit_log`, and the schema from the design's persisted tables. AT-CSV-12 and Property 21 are run against it.
  - Depends on: 5.1
  - Blocked by: OD-12. SQLite is a recommendation, not an approved choice.
  - Done when: AT-CSV-12 passes against the real adapter, and Property 21 passes with injected commit failures at each write.
  - Verify: integration tests against the adapter.
  - Tests: AT-CSV-12
  - Properties: Property 21
  - _Requirements: 22.1, 22.2, 22.3, 28.15, 28.16, 32.1_

- [ ] 6. Portfolio and ledger

- [ ] 6.1 Implement portfolio creation with explicit cash
  - Outcome: `PortfolioCreateSchema` requires `id`, `base_currency`, and `cash` (a decimal string with no default and no `.optional()`; `"0"` and negative values are valid). Route `POST /portfolios`.
  - Depends on: 4.2, 5.1, 2.6
  - Done when: a request without `cash` returns `VALIDATION_FAILED`; `"0"` is accepted; no code path substitutes zero.
  - Verify: AT-ALC-10. The design lists AT-ALC-10 in phase 3; it is verified here because CSV import needs portfolios.
  - Tests: AT-ALC-10
  - Properties: none
  - Rules: FR-10, A-7
  - _Requirements: 20.1, 30.1_

- [ ] 6.2 Implement the ledger and position projector
  - Outcome: `src/portfolio/positionProjector.ts` deterministically replays the ledger in `(tradeTimestamp, sequence)` order. `BUY` adds and `SELL` subtracts. Average price follows FR-13. One netted signed position per instrument, with the short flag. Emits `PositionsChanged`. Market price and valuation fields of the Position model stay `null` with a status until 11.1.
  - Depends on: 5.1, 2.1
  - Done when: hand-calculated average-price cases pass, including a SELL leaving the average unchanged and a reset at zero quantity; batch import order does not change the result.
  - Verify: AT-POS-01, AT-POS-02, AT-POS-03 (field presence), and the Property 23 property test.
  - Tests: AT-POS-01, AT-POS-02, AT-POS-03
  - Properties: Property 23
  - Rules: FR-13
  - _Requirements: 5.1, 5.3, 5.4, 5.5, 28.19_

- [ ] 7. CSV ingestion

- [ ] 7.1 Implement CSV pre-checks and streaming parsing
  - Outcome: `src/ingestion/csv/`:
    - Byte and row limits; fatal UTF-8 decoding (`INVALID_ENCODING`); BOM stripping.
    - Header validation (`INVALID_HEADER` naming the columns).
    - A streaming CSV library selected and pinned in this task, with `relax_quotes` disabled.
    - Field-length limit; empty rows counted as `skipped`; fields treated only as text.
  - Depends on: 2.6, 3.2
  - Done when: each file-level rejection carries its reason code; formula-like content stays as text; the parser never throws on empty or unreadable input.
  - Verify: unit tests with committed fixtures for AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18, AT-CSV-22.
  - Tests: AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18, AT-CSV-22
  - Properties: none
  - _Requirements: 1.1, 1.5, 28.3, 28.4, 28.5, 28.6, 28.8_

- [ ] 7.2 Implement column mapping and row validation
  - Outcome: `CsvColumnMappingSchema` (`z.partialRecord`); `CsvRowSchema` (`z.object`, unknown columns stripped). Dates use the explicitly configured `import.defaultTimezone`; date-only values are rejected with `INVALID_DATE` when it is absent. Row-level errors carry row number, column, and reason code.
  - Depends on: 7.1
  - Done when: renamed columns map correctly; unsupported types give `UNSUPPORTED_TRANSACTION_TYPE`; every invalid field produces exactly one row error.
  - Verify: AT-CSV-09, AT-CSV-17, AT-CSV-23.
  - Tests: AT-CSV-09, AT-CSV-17, AT-CSV-23
  - Properties: none
  - _Requirements: 1.2, 3.1, 28.1, 28.2, 28.7_

- [ ] 7.3 Implement normalization and deduplication
  - Outcome:
    - `transactionKey` exactly as R28.11, with occurrence counting per identical canonical-field group within a file.
    - Duplicate lookup against the ledger and the current batch.
    - `UNSUPPORTED_CURRENCY` against `fx.supportedCurrencies`, and `CURRENCY_MISMATCH` against the instrument's established currency.
    - User documentation of the cross-file limitation for trades without `external_id` (R28.14, OD-8 interim position).
  - Depends on: 7.2, 5.1
  - Done when: re-importing a file creates no transactions; two identical rows in one file are both kept; the documentation page exists.
  - Verify: AT-CSV-04, AT-CSV-13, AT-CSV-14, AT-CSV-20.
  - Tests: AT-CSV-04, AT-CSV-13, AT-CSV-14, AT-CSV-20
  - Properties: none
  - _Requirements: 28.11, 28.12, 28.13, 28.14, 28.22, 30.2_

- [ ] 7.4 Implement chronological processing and the oversell policy
  - Outcome: accepted rows are merged with the ledger in `(tradeTimestamp, sequence)` order using the projector replay from 6.2. `import.oversellPolicy` must be explicitly configured; import is refused when it is absent. `REJECT` rejects a SELL beyond the available quantity with `OVERSELL`. `ALLOW_SHORT` marks the position short.
  - Depends on: 7.3, 6.2
  - Blocked by: OD-6 for the production value of `import.oversellPolicy` only. Tests supply both values explicitly.
  - Done when: no position becomes negative under `REJECT`; a same-file SELL after a BUY is accepted.
  - Verify: AT-CSV-10, AT-CSV-11, AT-CSV-19, AT-CSV-24.
  - Tests: AT-CSV-10, AT-CSV-11, AT-CSV-19, AT-CSV-24
  - Properties: none
  - _Requirements: 28.18, 28.20, 28.21_

- [ ] 7.5 Implement the import service and import routes
  - Outcome:
    - `src/ingestion/importService.ts` classifies every row exactly once (accepted, rejected, duplicate, skipped).
    - Transactions, summary, quarantine records, and audit entries are written in one `UnitOfWork` transaction.
    - The import summary includes the file SHA-256.
    - Positions are projected only after a successful commit; a failed commit sets status `FAILED`.
    - Routes `POST /portfolios/:id/imports`, `GET /imports/:id`, and `GET /imports/:id/rejections`.
  - Depends on: 7.4, 5.2, 4.4, 6.1, 6.2
  - Done when: counts always sum to `totalRows`; with the in-memory fake failing the commit, no transaction, summary, or position persists.
  - Verify: integration tests through `inject()` for AT-CSV-05, AT-CSV-16, AT-AUD-01, AT-POS-04.
  - Tests: AT-CSV-05, AT-CSV-16, AT-AUD-01, AT-POS-04
  - Properties: none
  - _Requirements: 1.4, 3.2, 3.3, 3.4, 3.5, 22.1, 28.9, 28.10, 28.15, 28.16, 28.17, 27.2_

- [ ] 7.6 Write import property tests
  - Outcome: fast-check generators for CSV files mixing valid, invalid, duplicate, and empty rows, and for transaction sequences.
  - Depends on: 7.5
  - Done when: Properties 18, 19, 20, and 22 pass; Property 21 passes against the in-memory unit of work with commit failures injected at every write. Each test file header names its property and `Validates` line.
  - Verify: `npm test`.
  - Tests: none
  - Properties: Property 18, Property 19, Property 20, Property 21, Property 22
  - _Requirements: 3.2, 3.4, 28.13, 28.15, 28.20, 27.4_

- [ ] 7.7 Add the CSV ingestion benchmark
  - Outcome: a committed, fixed fixture of exactly 10,000 data rows, 10 columns, and 0 invalid rows, generated once by a committed script. A benchmark harness runs 3 warm-up and 20 measured runs, reports p95 by nearest rank (19th value), and records CPU, cores, RAM, OS, and Node.js version.
  - Depends on: 7.2
  - Done when: the benchmark runs the timed scope from NFR-PERF-1 only and writes the environment record; the result is reported against 500 ms but not enforced until 25.1.
  - Verify: AT-CSV-01, AT-CSV-02, AT-CSV-03 (local record).
  - Tests: AT-CSV-01, AT-CSV-02, AT-CSV-03
  - Properties: none
  - Rules: NFR-PERF-1
  - _Requirements: 1.3, 33.1_

### Phase 3: Market data, FX, valuation, and Base VaR

- [ ] 8. Provider infrastructure

- [ ] 8.1 Define the lossless JSON wrapper and its contract tests
  - Outcome: `src/shared/losslessJson.ts` interface (`parse(text)` returning numeric tokens as strings) and a contract test suite that any implementation must pass (decimal tokens kept exactly, exponent tokens surfaced for rejection, deep nesting).
  - Depends on: 2.1
  - Done when: the contract suite exists and runs against a test double; providers in this phase use fixture objects whose numbers are already strings.
  - Verify: `npm test`.
  - Tests: none
  - Properties: none
  - _Requirements: 4.2, 4.6_

- [ ] 8.2 Implement the provider resilience layer
  - Outcome:
    - `ResilientCall` with per-call timeouts and retries using exponential backoff with jitter, honouring `Retry-After`; no retry on 4xx other than 429.
    - A circuit breaker that surfaces `ProviderStatus`.
    - `DataStatusPolicy` (`CURRENT`, `STALE`, `CACHED`, `UNAVAILABLE`, `DEMO`).
    - Retention of the last valid data.
    - TLS certificate verification that is never disabled.
  - Depends on: 2.4, 2.5, 3.2
  - Done when:
    - fault-injected providers show last valid data retained and labelled stale, and no fabricated value;
    - a slow provider does not delay an unrelated calculation;
    - an invalid certificate from a local TLS server fails the call.
  - Verify: AT-PRV-01, AT-PRV-02, AT-PRV-03, AT-PRV-08, AT-PRV-10, AT-PRV-11, AT-SEC-23, and the Property 36 fault-injection test.
  - Tests: AT-PRV-01, AT-PRV-02, AT-PRV-03, AT-PRV-08, AT-PRV-10, AT-PRV-11, AT-SEC-23
  - Properties: Property 36
  - _Requirements: 24.8, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 33.9, 33.10_

- [ ] 8.3 Add the provider status route
  - Outcome: `GET /providers/status` returns each provider's status, `since`, and last error code, without secrets.
  - Depends on: 8.2, 4.2
  - Done when: a failed provider shows its status and error code, and no credential appears in the response.
  - Verify: integration test with `inject()`.
  - Tests: none
  - Properties: none
  - _Requirements: 25.1, 25.6_

- [ ] 8.4 (Blocked) Select and pin the lossless JSON library
  - Outcome: the library approved in OD-16, wrapped by `losslessJson.ts`, passing the contract suite from 8.1.
  - Depends on: 8.1
  - Blocked by: OD-16
  - Done when: the contract suite passes against the real library on Node.js 24.22.1 and 26.
  - Verify: `npm test`.
  - Tests: none
  - Properties: none
  - _Requirements: 4.2, 12.1_

- [ ] 9. Market data

- [ ] 9.1 Implement the market data port and a fixture provider
  - Outcome: `MarketDataProvider` interface and a recorded-fixture provider. Normalization of dates, tickers, and currency, and recording of source, retrieval timestamp, and content hash.
  - Depends on: 8.1, 8.2
  - Done when: a fixture payload produces a normalized `PriceSeries` with source, retrieval timestamp, and content hash.
  - Verify: AT-MD-17.
  - Tests: AT-MD-17
  - Properties: none
  - _Requirements: 12.1, 12.2, 12.3, 12.6, 26.3, 27.3_

- [ ] 9.2 Implement series cleaning with a weekends-only calendar
  - Outcome: `SeriesCleaner` implementing FR-3.1 to FR-3.3 behind a `TradingCalendar` interface that treats weekends as non-trading (A-14). Discard counts. `DATA_CONFLICT` for conflicting duplicates.
  - Depends on: 9.1
  - Done when: non-positive, non-finite, and weekend observations are discarded and counted; identical duplicates collapse; conflicting duplicates invalidate the series.
  - Verify: AT-MD-04, AT-MD-05, AT-MD-06, AT-MD-14.
  - Tests: AT-MD-04, AT-MD-05, AT-MD-06, AT-MD-14
  - Properties: none
  - Rules: FR-3
  - _Requirements: 12.5_

- [ ] 9.3 Implement returns, alignment, and lookback status
  - Outcome: `ReturnsBuilder` with Decimal simple returns (FR-2):
    - Intersection of common dates, with no forward fill.
    - Discard of returns across gaps larger than `marketData.maxReturnGapDays`, and a `multiDayReturnCount`.
    - The newest `var.lookbackReturns` returns, with status `COMPLETE`, `REDUCED_LOOKBACK`, or `INSUFFICIENT_DATA` against `var.minObservations`.
    - The as-of date and the limiting ticker.
  - Depends on: 9.2
  - Done when: hand-built fixtures for 199, 200, 249, 250, and 300 returns give the specified statuses, and every output return comes from two real observations.
  - Verify: unit tests for the listed tests, and the Property 13 and Property 14 property tests.
  - Tests: AT-MD-01, AT-MD-02, AT-MD-03, AT-MD-07, AT-MD-08, AT-MD-09, AT-MD-10, AT-MD-11, AT-MD-12, AT-VAR-08, AT-VAR-09, AT-VAR-10, AT-VAR-11, AT-VAR-12
  - Properties: Property 13, Property 14
  - Rules: FR-2, FR-3
  - _Requirements: 12.4, 12.8, 13.1, 13.2, 13.3, 13.6, 14.4, 27.8_

- [ ] 9.4 Implement the content-addressed series store and caching
  - Outcome: `SeriesStore` keyed by series content hash (immutable), with cached series labelled with retrieval time and status, behind the persistence port.
  - Depends on: 9.1, 5.1
  - Done when: a cached series is never labelled `CURRENT`; provenance (source, observation timestamp, real or demo) is retained.
  - Verify: AT-MD-18, and the market-data part of AT-AUD-03.
  - Tests: AT-MD-18, AT-AUD-03
  - Properties: none
  - _Requirements: 12.6, 12.7, 22.3_

- [ ] 9.5 (Blocked) Add an exchange holiday calendar
  - Outcome: a `TradingCalendar` implementation from the source approved in OD-3.
  - Depends on: 9.2
  - Blocked by: OD-3
  - Done when: AT-MD-15 passes with recorded holiday fixtures.
  - Verify: AT-MD-15.
  - Tests: AT-MD-15
  - Properties: none
  - Rules: FR-3.1
  - _Requirements: 12.5_

- [ ] 9.6 (Blocked) Implement the real market data adapter
  - Outcome: an adapter for the vendor approved in OD-13, parsing the vendor's payload format and validating with Zod. JSON payloads are parsed with the library from 8.4.
  - Depends on: 9.1
  - Blocked by: OD-13
  - Conditional dependency: if the approved vendor delivers JSON, this subtask also depends on 8.4 (OD-16), because financial-rules rule 3 and design D-5 forbid `JSON.parse` on provider payloads. The vendor's payload format is recorded when OD-13 is resolved.
  - Done when: recorded vendor responses pass the same normalization tests as the fixture provider, and exponent notation in vendor numbers is rejected (R4.6).
  - Verify: integration tests against recorded responses; live checks only through `test:live`.
  - Tests: none
  - Properties: none
  - _Requirements: 12.1, 12.3, 4.6_

- [ ] 10. FX

- [ ] 10.1 Implement the FX port, a fixture provider, and `FxService`
  - Outcome: `FxProvider` port and fixture provider; `FxService.rateToBase` returns `Rate(X/B)` (exactly `"1"` for the base currency, `1 / quote` for inverse quotes):
    - Selection of the rate as of the market-data as-of date, not later than the calculation time.
    - `FX_UNAVAILABLE` and `FX_STALE` against `fx.maxRateAgeSeconds`, with no substitution.
    - Each rate's pair, rate, timestamp, source, and status recorded as `FxRateUsed`.
    - No FX scenario risk is modelled; rates are held constant across scenarios (A-9, OD-4 open).
  - Depends on: 8.1, 8.2, 3.2
  - Done when: missing and stale rates produce their statuses and list the affected currencies; inverse conversion is exact to the configured precision.
  - Verify: unit tests for the listed tests, and the Property 26 and FX part of Property 25 property tests.
  - Tests: AT-FX-01, AT-FX-02, AT-FX-03, AT-FX-04, AT-FX-06, AT-FX-08, AT-FX-09, AT-AUD-03
  - Properties: Property 25, Property 26
  - Rules: A-9
  - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.7, 30.8, 30.10, 22.3_

- [ ] 10.2 (Blocked) Implement the real FX provider adapter
  - Outcome: an adapter for the FX provider approved in OD-5, parsing the provider's payload format and validating with Zod. JSON payloads are parsed with the library from 8.4.
  - Depends on: 10.1
  - Blocked by: OD-5
  - Conditional dependency: if the approved FX provider delivers JSON, this subtask also depends on 8.4 (OD-16), because financial-rules rule 3 and design D-5 forbid `JSON.parse` on provider payloads. The provider's payload format is recorded when OD-5 is resolved.
  - Done when: recorded responses pass the `FxService` tests, including inverse-quote handling.
  - Verify: integration tests against recorded responses.
  - Tests: none
  - Properties: none
  - _Requirements: 30.3_

- [ ] 11. Valuation, exposure, and allocation

- [ ] 11.1 Implement position valuation
  - Outcome: the valuation fields of the Position model (market price, market value in instrument and base currency) from the latest unadjusted market price and `FxService`. The fields stay `null` with a status when a price or rate is unavailable.
  - Depends on: 6.2, 9.1, 10.1
  - Done when: a mixed-currency fixture portfolio is valued exactly in base currency; a missing rate gives `FX_UNAVAILABLE`, never zero.
  - Verify: AT-FX-07 and unit tests.
  - Tests: AT-FX-07
  - Properties: none
  - Rules: FR-4
  - _Requirements: 5.2, 30.6, 30.9_

- [ ] 11.2 Implement exposure and NAV
  - Outcome: long value, short value, gross and net exposure, and NAV per FR-10 and FR-12, using the explicitly supplied cash.
  - Depends on: 11.1
  - Done when: hand-calculated cases with shorts and negative cash pass.
  - Verify: AT-ALC-09.
  - Tests: AT-ALC-09
  - Properties: none
  - Rules: FR-10, FR-12
  - _Requirements: 20.6_

- [ ] 11.3 Implement allocation with the largest-remainder rule
  - Outcome: `AllocationCalculator` per FR-11 (ROUND_DOWN, remaining units, ties by ascending ticker with `CASH` last), `ALLOCATION_UNAVAILABLE` for a non-positive denominator, and unforced totals for ineligible portfolios.
  - Depends on: 11.2
  - Done when: three equal assets give `{33.34, 33.33, 33.33}`; eligible portfolios total exactly `100.00` for every input order.
  - Verify: unit tests for the listed tests, and the Property 15 and Property 16 property tests.
  - Tests: AT-ALC-01, AT-ALC-02, AT-ALC-03, AT-ALC-04, AT-ALC-05, AT-ALC-06, AT-ALC-07, AT-ALC-08
  - Properties: Property 15, Property 16
  - Rules: FR-10, FR-11
  - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.8_

- [ ] 11.4 Add the positions and allocation routes
  - Outcome: `GET /portfolios/:id/positions` and `GET /portfolios/:id/allocation`, with decimal strings, statuses, and the denominator used.
  - Depends on: 11.3, 4.2
  - Done when: responses contain no JSON numbers for financial values and expose raw exposure values separately from percentages.
  - Verify: integration tests with `inject()`.
  - Tests: none
  - Properties: none
  - _Requirements: 5.2, 20.6, 20.8, 4.3_

- [ ] 12. Base VaR engine, worker, and snapshots

- [ ] 12.1 Implement the Type 7 quantile and its known-answer fixtures
  - Outcome: `src/risk/quantile.ts` computes `h` in Decimal, derives the index `j` as an integer only, uses `gamma`, applies the endpoint guard, and sorts with `Decimal.comparedTo`. A committed 250-return known-answer fixture with hand-calculated 95% and 99% results.
  - Depends on: 2.1
  - Done when: results equal `0.45*x[237] + 0.55*x[238]` and `0.49*x[247] + 0.51*x[248]` exactly; `gamma = 0` and `n = 2` cases pass.
  - Verify: unit tests for the listed tests, and the Property 3 property test with a rational reference.
  - Tests: AT-VAR-01, AT-VAR-02, AT-VAR-04, AT-VAR-05, AT-VAR-06
  - Properties: Property 3
  - Rules: FR-7
  - _Requirements: 14.7, 27.6_

- [ ] 12.2 Implement the Base VaR engine
  - Outcome: `RiskEngine.compute` for Base VaR, as a pure function with no filing field in `RiskInput`:
    - exposures, position and portfolio scenario P&L, and losses;
    - `reportedVar` with the `NO_LOSS_AT_CONFIDENCE` flag and the raw quantile kept;
    - `percentOfNav` with `NAV_NOT_POSITIVE`, and statuses `NO_POSITIONS` and `INVALID_INPUT`;
    - the full metadata list.
    In this phase `sentimentAdjustedVaR` is `null` with adjusted status `SENTIMENT_NOT_CURRENT` (every ticker `ABSENT`), because no sentiment exists yet (R15.8).
  - Depends on: 12.1, 9.3, 11.1
  - Done when: hand-calculated two-asset and short-position cases pass; horizons other than 1 and confidences outside (0, 1) are rejected.
  - Verify: unit tests for the listed tests, and the Property 4 and Property 5 property tests.
  - Tests: AT-VAR-03, AT-VAR-07, AT-VAR-13, AT-VAR-14, AT-VAR-15, AT-VAR-16, AT-VAR-17, AT-VAR-18
  - Properties: Property 4, Property 5
  - Rules: FR-4, FR-5, FR-7, FR-12
  - _Requirements: 14.1, 14.2, 14.3, 14.5, 14.6, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 11.5_

- [ ] 12.3 Implement the Base VaR configuration gate and validity policy
  - Outcome: `RiskInputBuilder` returns `CONFIG_MISSING` with keys when a Base VaR setting is missing. It does this before loading data. It also checks for FX, market-data, and position preconditions. `ResultValidityPolicy` derives `baseValidity` and `adjustedValidity` separately. Earlier results are retained as `LAST_VALID`. `MARKET_DATA_STALE` makes the result `STALE`.
  - Depends on: 12.2, 3.2
  - Done when: a missing Base VaR key gives `CONFIG_MISSING`, both figures `null`, and both validities `UNAVAILABLE`, with the earlier result kept as `LAST_VALID`; a stale as-of date is never `CURRENT`.
  - Verify: AT-MD-13, AT-MD-16.
  - Tests: AT-MD-13, AT-MD-16
  - Properties: none
  - _Requirements: 13.4, 13.5, 13.7, 14.14_

- [ ] 12.4 Implement the compiled risk worker and the recalculation scheduler
  - Outcome:
    - The worker starts from compiled `dist/risk/riskWorker.js` via `new URL('./riskWorker.js', import.meta.url)`. JSON with decimal strings crosses the thread boundary.
    - A crash is audited and the worker is restarted.
    - `RiskScheduler` coalesces requests (one running, one queued per portfolio) and reacts to `PositionsChanged` and `PriceUpdated` using `recalc.minValueChangePct`.
  - Depends on: 12.3, 1.1, 5.2
  - Done when: an integration test starts the compiled worker without a TypeScript loader; a burst of requests yields at most two runs; sub-threshold price changes update valuation only.
  - Verify: AT-ARC-03 (worker part), AT-DSH-07, AT-DSH-08.
  - Tests: AT-ARC-03, AT-DSH-07, AT-DSH-08
  - Properties: none
  - _Requirements: 16.1, 16.2, 16.3, 16.6, 16.7, 23.4, 26.8, 33.9_

- [ ] 12.5 Implement the snapshot service and reproducibility
  - Outcome: `SnapshotService.create` builds the full snapshot, computes `inputsCanonical` without `displayOnly`, the timestamp, and generated ids, hashes it, and persists `calc_snapshots` with a non-unique hash index. `recompute` reloads series by hash and reruns the engine.
  - Depends on: 12.2, 2.3, 9.4, 5.1
  - Done when: recomputing from a stored snapshot reproduces the stored figures as identical strings; any input or configuration change changes the hash or version.
  - Verify: unit tests for the listed tests, and the base part of the Property 24 property test.
  - Tests: AT-REP-01, AT-REP-02, AT-REP-03, AT-REP-04, AT-REP-06, AT-REP-07, AT-REP-08, AT-REP-10, AT-FX-05, AT-AUD-04
  - Properties: Property 24
  - _Requirements: 32.1, 32.2, 32.4, 32.5, 32.6, 22.4, 22.5, 30.10_

- [ ] 12.6 Add the risk and snapshot routes
  - Outcome: `GET /portfolios/:id/risk` returns Base and Adjusted VaR as separate `VarEntry` objects (validity, value or `null`, status, reason, last valid); `GET /portfolios/:id/snapshots/:hash`.
  - Depends on: 12.3, 12.5, 4.2
  - Done when: an unavailable figure is `null` with its status and reason; no response contains a JSON number for a financial value.
  - Verify: integration tests with `inject()` (API part of AT-DSH-15, completed in 17.3).
  - Tests: none
  - Properties: none
  - _Requirements: 14.10, 14.12, 17.10, 22.5_

- [ ] 12.7 Add the VaR timing benchmark
  - Outcome: a benchmark for 50 and 500 instruments with 250 scenarios (3 warm-up and 20 measured runs, nearest-rank p95), recording the environment.
  - Depends on: 12.2
  - Done when: results are recorded with the environment; enforcement waits for 25.1.
  - Verify: AT-BEN-01 (record only).
  - Tests: AT-BEN-01
  - Properties: none
  - _Requirements: 33.3_

### Phase 4: Sentiment, adjustment, and WebSocket gateway

- [ ] 13. Sentiment ingestion

- [ ] 13.1 Implement the sentiment port, REST polling, and a fixture provider
  - Outcome: `SentimentProvider` port and fixture provider. `SentimentObservationSchema` (`z.strictObject`). A REST poller through `ResilientCall` using `sentiment.rest.pollSeconds`. `REAL` or `DEMO` tagging by provider kind (a demo provider can never emit `REAL`). Validation errors are audited, never clamped.
  - Depends on: 8.2, 2.6, 3.2
  - Done when: valid payloads normalize; out-of-range and `NaN` values are rejected and audited.
  - Verify: AT-SEN-22, AT-SEN-24, AT-SEN-10, and the sentiment part of the Property 17 property test.
  - Tests: AT-SEN-22, AT-SEN-24, AT-SEN-10
  - Properties: Property 17
  - _Requirements: 9.1, 9.6, 9.7, 10.7, 21.2, 21.3, 21.5, 26.3_

- [ ] 13.2 Implement the WSS client, deduplication, and backpressure
  - Outcome:
    - `wss://` only, with certificate validation.
    - Reconnect with backoff and jitter (`sentiment.reconnect`).
    - A `BoundedQueue` (`ws.maxQueueSize`) that coalesces per provider and ticker and drops oldest with a counter, logged at most once per minute.
    - Deduplication; out-of-order messages stored as history only; future-dated rejection using `sentiment.maxFutureSkewSeconds`.
  - Depends on: 13.1, 2.4
  - Done when: a flood never exceeds the queue bound; duplicates change state once; older observations never overwrite newer state.
  - Verify: integration tests against a local WSS server, and the Property 29 and Property 30 property tests.
  - Tests: AT-PRV-04, AT-PRV-05, AT-PRV-06, AT-PRV-07, AT-SEN-19, AT-SEN-20, AT-SEN-23
  - Properties: Property 29, Property 30
  - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 24.8, 33.5_

- [ ] 13.3 Implement sentiment state and freshness
  - Outcome: per-ticker sentiment state with `FreshnessPolicy` (FR-8, `sentiment.maxAgeSeconds`). The last valid value is retained for display, labelled `STALE` with its timestamp, and never treated as current.
  - Depends on: 13.1
  - Done when: under a fake clock, a value becomes `STALE` exactly when its age exceeds `maxAgeSeconds`; demo values are never `CURRENT` for adjustment.
  - Verify: unit tests, and the sentiment part of the Property 25 property test.
  - Tests: none
  - Properties: Property 25
  - Rules: FR-8
  - _Requirements: 10.4, 10.6, 15.13, 21.5_

- [ ] 13.4 Define the sentiment aggregator interface and contract tests
  - Outcome: `SentimentAggregator` interface with a `version` string, and a contract suite every implementation must pass: output in [-1, +1] or `null`, deterministic, Decimal only, `REAL` observations only, and `null` when no observation is in the window. No formula is implemented here.
  - Depends on: 13.3
  - Done when: the contract suite exists and runs against a test double that is not used outside tests.
  - Verify: `npm test`.
  - Tests: none
  - Properties: none
  - _Requirements: 10.1, 10.2, 10.3_

- [ ] 13.5 (Blocked) Implement the approved sentiment aggregation formula
  - Outcome: the formula approved in OD-1, versioned and validated with `SentimentIndexSchema` before storage, using `sentiment.windowSeconds`.
  - Depends on: 13.4
  - Blocked by: OD-1. `windowed-mean-v1` is a proposal, not an approved formula.
  - Done when: AT-SEN-21 passes, and the contract suite from 13.4 passes against the real implementation.
  - Verify: AT-SEN-21, and the aggregate-range part of the Property 30 property test.
  - Tests: AT-SEN-21
  - Properties: Property 30
  - _Requirements: 10.1, 10.2_

- [ ] 13.6 Implement the sentiment emitter cadence
  - Outcome: a drift-corrected scheduler on the monotonic clock with a 3,000 ms target. It emits only changed tickers, keeps running during disconnects, and ages states to stale.
  - Depends on: 13.3, 13.4
  - Done when: over a simulated five-minute window with jittered provider arrivals, the p95 of the absolute deviation from 3,000 ms is at most 500 ms; nothing is emitted when nothing changed.
  - Verify: unit tests with a fake clock, and the Property 31 simulation.
  - Tests: AT-CAD-01, AT-CAD-02, AT-CAD-03, AT-CAD-04, AT-CAD-05, AT-CAD-06
  - Properties: Property 31
  - _Requirements: 10.5, 10.6, 10.8_

- [ ] 13.7 Add the sentiment handler timing benchmark
  - Outcome: per-message handler timing (3 warm-up and 20 measured runs, nearest-rank p95), recording the environment.
  - Depends on: 13.2
  - Done when: results are recorded; enforcement waits for 25.1.
  - Verify: AT-BEN-02 (record only).
  - Tests: AT-BEN-02
  - Properties: none
  - _Requirements: 33.4_

- [ ] 13.8 (Blocked) Implement the real sentiment provider adapters
  - Outcome: REST and WSS adapters for the vendor approved in OD-13, parsing the vendor's message format and validating with Zod. JSON messages are parsed with the library from 8.4.
  - Depends on: 13.2
  - Blocked by: OD-13
  - Conditional dependency: if the approved vendor delivers JSON (REST bodies or WebSocket messages), this subtask also depends on 8.4 (OD-16), because financial-rules rule 3 and design D-5 forbid `JSON.parse` on provider payloads. The vendor's message format is recorded when OD-13 is resolved.
  - Done when: recorded vendor messages pass the 13.1 and 13.2 tests, and exponent notation is rejected (R4.6).
  - Verify: integration tests against recorded messages; live checks only through `test:live`.
  - Tests: none
  - Properties: none
  - _Requirements: 9.1, 9.2, 4.6_

- [ ] 14. Adjusted VaR

- [ ] 14.1 Implement the strict Adjusted VaR eligibility gate
  - Outcome:
    - The engine sets `sentimentAdjustedVaR` to `null` with `ADJUSTMENT_CONFIG_MISSING` (and the keys) when any setting in R15.1 is missing.
    - It sets `null` with `SENTIMENT_NOT_CURRENT`, listing tickers with `STALE`, `UNAVAILABLE`, `INVALID`, `DEMO`, or `ABSENT`, when any position with non-zero net quantity lacks eligible sentiment.
    - It sets `BASE_UNAVAILABLE` when Base VaR is unavailable.
    - Base VaR is unaffected, and the Base figure is never copied into the Adjusted field.
    - There is no switch that disables the adjustment.
  - Depends on: 12.3, 13.3, 13.4
  - Done when: each ineligible case yields Base VaR `CURRENT` with Adjusted VaR `UNAVAILABLE` and its reason; an `adjustment.enabled` key is rejected at load.
  - Verify: unit tests for the listed tests, and the Property 9 and Property 10 property tests.
  - Tests: AT-SEN-08, AT-SEN-09, AT-SEN-11, AT-SEN-15, AT-SEN-27, AT-SEN-28, AT-SEN-29
  - Properties: Property 9, Property 10
  - _Requirements: 13.7, 14.14, 15.1, 15.2, 15.8, 15.9, 15.13_

- [ ] 14.2 Implement direction-aware triggering and adjusted scenario P&L
  - Outcome:
    - `EffectiveSentiment` per FR-9; trigger strictly below `adjustment.bearishThreshold`.
    - The multiplier is applied only to a triggered position's negative contributions (FR-6), and the loss distribution and Adjusted VaR are recomputed. The portfolio VaR is never multiplied.
    - Triggered assets are listed with raw and effective sentiment, direction, and multiplier.
    - Status is `APPLIED` or `NONE_TRIGGERED`.
  - Depends on: 14.1
  - Done when: -0.60 does not trigger and -0.6001 does; a hand-calculated five-scenario case and the 250-scenario case match; Adjusted VaR differs from `1.15 × Base VaR`.
  - Verify: unit tests for the listed tests, and the Property 6, Property 7, and Property 8 property tests.
  - Tests: AT-SEN-01, AT-SEN-02, AT-SEN-03, AT-SEN-04, AT-SEN-05, AT-SEN-06, AT-SEN-07, AT-SEN-12, AT-SEN-13, AT-SEN-14, AT-SEN-18
  - Properties: Property 6, Property 7, Property 8
  - Rules: FR-6, FR-9
  - _Requirements: 15.3, 15.4, 15.5, 15.6, 15.7, 15.10, 15.11, 15.12, 27.7_

- [ ] 14.3 Recalculate Adjusted VaR on eligibility changes
  - Outcome: `SentimentEligibilityChanged` events (a trigger flip or a stale/current change) request recalculation, leaving Base VaR unchanged when its inputs are unchanged.
  - Depends on: 14.2, 12.4
  - Done when: a sentiment change produces a new result whose Base VaR string equals the previous one.
  - Verify: AT-SEN-17, AT-SEN-25.
  - Tests: AT-SEN-17, AT-SEN-25
  - Properties: none
  - _Requirements: 15.9, 16.4_

- [ ] 14.4 Extend snapshots and reproducibility to Adjusted VaR
  - Outcome: snapshots record `adjustmentOutcome` and nullable adjustment parameters. `displayOnly` filing scores are stored but excluded from the hash. Recompute reproduces the Adjusted figure or its `null` status.
  - Depends on: 14.2, 12.5
  - Done when: identical inputs reproduce identical Adjusted strings; changing only `displayOnly` filing scores leaves the hash unchanged.
  - Verify: AT-REP-02 (adjusted case), AT-REP-09, and the adjusted part of the Property 24 property test.
  - Tests: AT-REP-02, AT-REP-09
  - Properties: Property 24
  - _Requirements: 32.1, 32.2, 32.4_

- [ ] 14.5 Verify filing independence on the risk side
  - Outcome: property tests vary `FilingRiskScore` fixtures (the phase 1 type) and assert that `RiskResult`, triggered assets, and the snapshot hash are identical. A type test asserts `RiskInput` has no filing field. Invalid sentiment and filing scores cannot enter `RiskInput`.
  - Depends on: 14.2, 2.6, 1.4
  - Done when: Property 11 (risk side) passes; injecting an invalid score into the input builder is rejected before the engine runs.
  - Verify: AT-FIL-01, AT-FIL-02, AT-FIL-03, AT-VAL-01, and the Property 11 and Property 17 property tests.
  - Tests: AT-FIL-01, AT-FIL-02, AT-FIL-03, AT-VAL-01
  - Properties: Property 11, Property 17
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 15.14, 21.4, 27.9_

- [ ] 15. WebSocket gateway

- [ ] 15.1 Implement the `/stream` WebSocket gateway
  - Outcome: a Fastify WebSocket route on the loopback-bound server. It pushes Zod-validated `SentimentUpdate`, `RiskUpdate`, and `ProviderStatus` events from the shared contract, with decimal strings only, and a bounded send buffer per client.
  - Depends on: 4.2, 13.6, 12.6
  - Done when: a test client receives sentiment emissions and risk updates as they occur; a slow client cannot grow memory without bound.
  - Verify: integration tests with a local WebSocket client.
  - Tests: none
  - Properties: none
  - _Requirements: 10.5, 16.7, 17.10, 25.1, 26.9_

### Phase 5: Dashboard and VaR alerts

- [ ] 16. VaR alerts

- [ ] 16.1 Implement the VaR alert evaluator
  - Outcome:
    - The evaluator selects the figure named by `alerts.var.metric` and evaluates only when that figure's validity is `CURRENT`; with `ADJUSTED` it never falls back to Base VaR.
    - Strict comparison with `alerts.var.thresholdPct`.
    - `ALERT_CONFIG_MISSING` and `NAV_NOT_POSITIVE`.
    - Per-portfolio thresholds.
    - Severity bands from the operational ratios (provisional defaults).
    - Skips are audited.
  - Depends on: 12.3, 14.1, 3.2
  - Blocked by: OD-6 for production threshold values only. Tests supply explicit thresholds.
  - Done when: equality never alerts; an unavailable Adjusted VaR with the `ADJUSTED` metric never alerts even when Base VaR exceeds the threshold.
  - Verify: unit tests for the listed tests, and the Property 34 property test.
  - Tests: AT-ALR-07, AT-ALR-08, AT-ALR-09, AT-ALR-13, AT-ALR-14, AT-ALR-15, AT-ALR-18
  - Properties: Property 34
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 34.2_

- [ ] 16.2 Implement the alert state machine
  - Outcome: a persisted `alert_state` per key (type, portfolio, asset), implementing the design's state machine. One alert per crossing, escalation alerts, and re-arming only after the reset threshold and cooldown. Unavailable figures never advance the state.
  - Depends on: 16.1, 5.1
  - Done when: model-based property tests over metric sequences pass, and a restart does not re-fire an open breach.
  - Verify: unit tests for the listed tests, and the Property 32 property test.
  - Tests: AT-ALR-01, AT-ALR-02, AT-ALR-03, AT-ALR-04
  - Properties: Property 32
  - _Requirements: 34.1, 34.5, 34.6_

- [ ] 16.3 Implement the alert outbox, dispatcher, and alert routes
  - Outcome: the alert is persisted before publishing. The outbox dispatcher publishes to the event bus and the `/stream` gateway, retrying with backoff up to `alerts.delivery.maxRetries` and then marking `FAILED`. The dashboard de-duplicates by alert id. Routes `GET /alerts` and `POST /alerts/:id/dismiss`; dismissal preserves history.
  - Depends on: 16.2, 15.1
  - Done when: an injected publish failure never stops calculations; retries create one dashboard entry; payloads contain every R19.2 field.
  - Verify: unit tests for the listed tests, and the Property 33 fault-injection test.
  - Tests: AT-ALR-05, AT-ALR-10, AT-ALR-11, AT-ALR-12, AT-ALR-17
  - Properties: Property 33
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 34.7, 34.8_

- [ ] 17. View models and dashboard

- [ ] 17.1 Implement the view model builder with signal separation
  - Outcome: `PortfolioRiskView` and `AssetRiskRow`, with separate `VarEntry` objects for Base and Adjusted VaR and the explanation text (APPLIED, NONE_TRIGGERED, or the unavailable reason). Separate sentiment and filing fields with no combined field. `riskContribution: null` shown as "not available" (OD-10).
  - Depends on: 12.6, 14.2, 11.4
  - Done when: a type test proves no field derives from both sentiment and filing; high filing risk with bullish sentiment produces both values unchanged.
  - Verify: unit tests, and the Property 12 static and example tests.
  - Tests: AT-FIL-04
  - Properties: Property 12
  - _Requirements: 11.6, 11.7, 17.1, 17.2, 17.3, 17.4, 17.6, 17.7, 17.8, 17.9, 17.10, 35.2, 35.3, 35.6_

- [ ] 17.2 Scaffold the React and Vite dashboard
  - Outcome: `src/web/` as a separate Vite build with its own strict `tsconfig`. Design tokens from `ui-guidelines.md` as CSS variables. `chartAdapter.ts` is the only `toChartNumber` caller. Imports only the shared API contract types. Included in lint, `deps:check`, and CI.
  - Depends on: 1.4, 4.2
  - Done when: `deps:check` fails if `web/` imports a domain module; ESLint fails if any other file calls `toChartNumber`; the Vite build succeeds in CI.
  - Verify: AT-DEC-06 (re-run for `web/`), and the boundary checks from 1.4.
  - Tests: AT-DEC-06
  - Properties: none
  - _Requirements: 4.4, 23.4, 26.2, 26.9_

- [ ] 17.3 Build the dashboard panels and status presentation
  - Outcome: the top bar and four separate panels in the specified order (Base VaR, Sentiment-Adjusted VaR, Market Sentiment, SEC Filing Risk), plus positions and allocation, exposures, and alerts:
    - Text status badges.
    - Scale captions.
    - Money rounding per FR-14 and allocation to two decimals.
    - An "Unavailable" Adjusted panel with its reason, never showing the Base figure; `LAST_VALID` figures only when labelled.
    - VaR described as a percentile estimate, never as drawdown.
  - Depends on: 17.1, 17.2, 15.1
  - Done when: component tests cover each listed test, and no unavailable value renders as a number or zero.
  - Verify: component tests with Vitest. AT-DSH-15 is verified across the API (12.6) and the UI.
  - Tests: AT-DSH-01, AT-DSH-02, AT-DSH-03, AT-DSH-09, AT-DSH-10, AT-DSH-11, AT-DSH-12, AT-DSH-13, AT-DSH-14, AT-DSH-15, AT-ALC-11
  - Properties: none
  - Rules: FR-14
  - _Requirements: 14.13, 17.1, 17.2, 17.3, 17.4, 17.7, 17.9, 17.10, 18.6, 20.7, 35.1, 35.4, 35.5, 35.6, 35.7_

- [ ] 17.4 Implement dashboard update batching
  - Outcome: the WebSocket client coalesces messages to at most one render per animation frame. Per-ticker subscriptions so a single-asset update does not re-render the dashboard. Provider status shown during outages.
  - Depends on: 17.3
  - Done when: a test with simulated bursts shows one render per frame and no full re-render for a single-ticker update.
  - Verify: component tests; frame-rate enforcement (AT-DSH-04) is in 25.1.
  - Tests: none
  - Properties: none
  - _Requirements: 23.2, 23.3, 23.5, 33.8_

- [ ] 17.5 Add the Playwright end-to-end test
  - Outcome: Playwright pinned to an exact version. One scenario starts the API with fixture providers, imports a CSV, supplies market data and sentiment, and asserts that the dashboard risk metrics and an alert update.
  - Depends on: 17.3, 16.3, 7.5
  - Done when: the scenario passes in CI on both Node versions.
  - Verify: AT-DSH-05.
  - Tests: AT-DSH-05
  - Properties: none
  - _Requirements: 16.1, 27.5_

- [ ] 17.6 Extend secret scanning to the frontend bundle
  - Outcome: the CI secret-scanning step also scans the built Vite bundle.
  - Depends on: 17.2, 3.5
  - Done when: a seeded fake key in a web source file fails CI.
  - Verify: AT-SEC-24 (bundle part).
  - Tests: AT-SEC-24
  - Properties: none
  - _Requirements: 24.5_

### Phase 6: FIX import

- [ ] 18. FIX import

- [ ] 18.1 Implement the structural FIX tokenizer
  - Outcome: splitting on SOH or `|` (`fix.delimiter`), `tag -> value` parsing, `BodyLength` and `CheckSum` checks giving `FIX_MALFORMED`, and a mapping-table interface that is left empty. Invalid messages are quarantined with reasons without stopping the file.
  - Depends on: 7.5
  - Done when: unit tests on synthetic messages cover the delimiters, body length, and checksum failures. No AT-FIX test is claimed, because the supported set is not approved.
  - Verify: unit tests.
  - Tests: none
  - Properties: none
  - _Requirements: 2.1, 2.4, 28.10_

- [ ] 18.2 (Blocked) Implement the approved FIX message mapping
  - Outcome: the BeginString, message types, `ExecType` values, and tag mapping approved in OD-9, documented in `docs/fix-mapping.md`. Rejection reasons `FIX_UNSUPPORTED_MSG_TYPE`, `FIX_MISSING_TAG`, and `FIX_INVALID_VALUE`. Deduplication by `ExecID`. FIX `Account` values are never stored and are redacted.
  - Depends on: 18.1
  - Blocked by: OD-9
  - Done when: AT-FIX-01 to AT-FIX-06 pass on recorded sample logs, and Properties 18, 19, and 20 pass for FIX input.
  - Verify: the listed tests, and the FIX parts of the Property 18, 19, and 20 property tests.
  - Tests: AT-FIX-01, AT-FIX-02, AT-FIX-03, AT-FIX-04, AT-FIX-05, AT-FIX-06
  - Properties: Property 18, Property 19, Property 20
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 28.10, 28.11, 28.12, 29.12, 27.2_

- [ ] 18.3 (Blocked) Add the FIX ingestion benchmark
  - Outcome: a fixed 10,000-message fixture and a benchmark recording the environment, compared with the provisional 750 ms budget.
  - Depends on: 18.2
  - Blocked by: OD-9 (fixture content); OD-2 (enforcement)
  - Done when: results are recorded; enforcement happens in 25.1.
  - Verify: AT-FIX-07 (record).
  - Tests: AT-FIX-07
  - Properties: none
  - _Requirements: 33.2_

### Phase 7: SEC filing risk

- [ ] 19. SEC client

- [ ] 19.1 Implement the SEC URL guard
  - Outcome: `SecUrlGuard.validate` (HTTPS only; exact hosts `www.sec.gov` or `data.sec.gov` after IDNA normalization; port 443; no credentials; IP literals rejected) and `resolveAndCheck` (rejects loopback, private, link-local, unique-local, CGNAT, multicast, unspecified, and IPv4-mapped forms).
  - Depends on: 2.4, 2.5
  - Done when: every listed test passes with a stubbed DNS resolver; rejections are audited as `SECURITY`.
  - Verify: unit tests for the listed tests, and the Property 27 property test over generated URLs.
  - Tests: AT-SEC-01, AT-SEC-02, AT-SEC-03, AT-SEC-04, AT-SEC-05, AT-SEC-06, AT-SEC-07, AT-SEC-08, AT-SEC-09
  - Properties: Property 27
  - _Requirements: 29.8, 29.9, 29.11_

- [ ] 19.2 Implement the guarded SEC client
  - Outcome:
    - Connects to the validated address while keeping the `Host` header and TLS server name (no DNS rebinding).
    - `User-Agent` from `SEC_USER_AGENT`; retrieval refuses to start if it is unset.
    - A shared token bucket at `sec.maxRequestsPerSecond`.
    - Manual redirects, each re-validated, up to `sec.maxRedirects`.
    - Streamed size limit and timeout; retries through `ResilientCall`.
    - `SecClient.getJson` parses every SEC JSON body with the lossless JSON parser from 8.4 (through `losslessJson.ts`) before Zod validation, never with `JSON.parse` (financial-rules rule 3, design D-5).
  - Depends on: 19.1, 8.2, 3.4, 8.4
  - Done when: local test servers show that every listed test behaves as specified; no request reaches a rejected target.
  - Verify: integration tests for the listed tests, and the redirect part of the Property 27 property test.
  - Tests: AT-SEC-10, AT-SEC-11, AT-SEC-12, AT-SEC-13, AT-SEC-14, AT-SEC-15, AT-SEC-16, AT-SEC-17
  - Properties: Property 27
  - _Requirements: 6.6, 6.7, 6.8, 29.10, 33.6, 25.2_

- [ ] 20. Filing location and Item 1A extraction

- [ ] 20.1 Implement the filing locator and record SEC fixtures
  - Outcome: ticker-to-CIK resolution from the SEC company ticker file. The company ticker file (`company_tickers.json`) and the submissions JSON (`data.sec.gov/submissions/CIK##########.json`) are both read through `SecClient.getJson`, parsed with the lossless JSON parser from 8.4, and validated with Zod; recorded fixtures are parsed the same way. Selection of the latest 10-K or 10-Q, and construction of the document URL. Recorded fixtures for one company's ticker file entry, submissions JSON, and 10-K and 10-Q documents, captured once with a placeholder contact and committed without personal data.
  - Depends on: 19.2, 8.4
  - Done when: from recorded fixtures, a ticker resolves to the correct CIK, accession number, form, filing date, and URL, and metadata with a retrieval timestamp is stored.
  - Verify: AT-FIL-13, AT-FIL-17.
  - Tests: AT-FIL-13, AT-FIL-17
  - Properties: none
  - _Requirements: 6.1, 6.2, 22.2_

- [ ] 20.2 Implement Item 1A extraction
  - Outcome: HTML-to-text normalization with an HTML parser and an offset map. Start and end candidate detection for 10-K and 10-Q. Selection of the longest span to skip the table of contents and cross-references. `ITEM_1A_TOO_SHORT` below `sec.item1a.minChars`, plus `ITEM_1A_NOT_FOUND` and `EXTRACTION_FAILED`. The SHA-256 and offsets are stored.
  - Depends on: 20.1
  - Done when: the extracted text is always a substring of the normalized document; recorded 10-K and 10-Q fixtures return the real section; synthetic fixtures cover each failure status.
  - Verify: unit tests for the listed tests, and the Property 28 property test over generated HTML.
  - Tests: AT-FIL-12, AT-FIL-14, AT-FIL-15, AT-FIL-16, AT-SEC-18
  - Properties: Property 28
  - _Requirements: 6.3, 6.4, 6.5, 7.7_

- [ ] 21. NLP and filing scores

- [ ] 21.1 Implement the NLP port and the fallback provider
  - Outcome:
    - `NlpProvider` port with separate `analyzeFiling` and `analyzeSentimentText` methods.
    - `FallbackNlpProvider`, whose results are stamped `FALLBACK` / `DEMO`.
    - `FilingAnalysisSchema` validation; `nlp.timeoutMs` and `nlp.maxRetries` giving `NLP_FAILED` with no score.
    - Module separation, so SEC text never reaches sentiment and sentiment text never reaches filing scoring.
  - Depends on: 2.6, 8.2
  - Done when: fallback output is never labelled genuine; a timeout stores no score; a test proves the separation of inputs.
  - Verify: unit tests for the listed tests, and the filing part of the Property 17 property test.
  - Tests: AT-FIL-06, AT-FIL-10, AT-FIL-20, AT-PRV-09
  - Properties: Property 17
  - _Requirements: 7.1, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 21.1, 21.3, 26.3, 33.7_

- [ ] 21.2 (Blocked) Implement NLP input chunking
  - Outcome: splitting Item 1A text at `nlp.maxInputChars` and combining chunk scores with the method approved in OD-15, recording the method version.
  - Depends on: 21.1
  - Blocked by: OD-15. Maximum-severity combination is a proposal, not an approved method.
  - Done when: texts longer than the limit produce one score with the recorded method version, and the combination matches the approved definition on hand-built cases.
  - Verify: unit tests.
  - Tests: none
  - Properties: none
  - _Requirements: 7.1, 7.2_

- [ ] 21.3 Implement the FilingRisk service and freshness
  - Outcome:
    - Scores in [0, 1] with categories, method and version, provider, mode, source URL, and analysis timestamp.
    - `filing.maxAgeDays` freshness (`CURRENT` or `STALE`), `NO_FILING`, and `SUPERSEDED` retention.
    - Recalculation when the method or provider changes.
    - A `FilingScoreUpdated` event that updates the matrix without VaR recalculation.
    - Until 21.2 is unblocked, texts longer than the configured NLP input limit are not scored and are reported as such.
  - Depends on: 20.2, 21.1, 5.1, 3.2
  - Blocked by: OD-6 for the production value of `filing.maxAgeDays` only. Tests supply explicit values.
  - Done when: each listed test passes with the fallback provider and recorded fixtures.
  - Verify: unit tests for the listed tests, and the filing part of the Property 25 property test.
  - Tests: AT-FIL-07, AT-FIL-08, AT-FIL-09, AT-FIL-18, AT-FIL-19, AT-AUD-02, AT-DSH-06
  - Properties: Property 25
  - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 16.5, 22.2, 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8_

- [ ] 21.4 Add the filing analysis route
  - Outcome: `POST /filings/analyze` accepts a ticker, a CIK, or an SEC URL. URLs go through `SecUrlGuard`; tickers and CIKs are resolved to URLs the application constructs itself.
  - Depends on: 21.3, 4.2, 19.1
  - Done when: a non-SEC URL is rejected before any request; a ticker triggers analysis from fixtures.
  - Verify: integration tests with `inject()`.
  - Tests: none
  - Properties: none
  - _Requirements: 6.1, 29.11_

- [ ] 22. Filing alerts and display

- [ ] 22.1 Implement filing-risk alerts
  - Outcome: `FILING_RISK` alerts only for `CURRENT`, `REAL`, non-fallback scores at or above `alerts.filing.threshold`. `WARNING` severity unless `alerts.filing.criticalThreshold` is set. Separate state, history, and reset (`alerts.filing.resetThreshold`) from VaR alerts. No code path into the risk engine.
  - Depends on: 21.3, 16.2
  - Blocked by: OD-6 for production threshold values only. Tests supply explicit values.
  - Done when: filing alerts never change any stored `RiskResult` or snapshot hash; VaR and filing alerts keep independent state.
  - Verify: unit tests for the listed tests, and the full-pipeline Property 11 property test.
  - Tests: AT-FIL-05, AT-FIL-11, AT-ALR-06, AT-ALR-16
  - Properties: Property 11
  - _Requirements: 34.1, 34.3, 34.4, 34.6, 11.5_

- [ ] 22.2 Show filing values in the dashboard
  - Outcome: the SEC Filing Risk panel and asset rows show real filing scores with filing date and status, still separate from sentiment.
  - Depends on: 21.3, 17.3
  - Done when: AT-DSH-10 and AT-FIL-04 pass again with real filing data from fixtures.
  - Verify: component tests (re-run of AT-DSH-10, AT-FIL-04).
  - Tests: AT-DSH-10, AT-FIL-04
  - Properties: none
  - _Requirements: 17.5, 35.1, 35.3_

### Phase 8: Hardening

- [ ] 23. Authentication and authorization

- [ ] 23.1 (Blocked) Implement the approved authentication mechanism
  - Outcome: an `AuthGuard` implementation for the mechanism approved in OD-7. Authentication on API, upload, and WebSocket endpoints. Per-portfolio, per-role authorization with deny by default. Error responses that do not reveal whether a resource exists.
  - Depends on: 4.2, 15.1
  - Blocked by: OD-7. The local single-user binding (4.2) is not an authentication mechanism.
  - Done when: AT-SEC-20 passes for every route and the WebSocket.
  - Verify: AT-SEC-20.
  - Tests: AT-SEC-20
  - Properties: none
  - _Requirements: 29.1, 29.2, 29.3_

- [ ] 24. Export safety

- [ ] 24.1 Implement CSV export cell neutralization
  - Outcome: a shared utility that prefixes cells starting with `=`, `+`, `-`, or `@` with a single quote, for use by any CSV export. No export feature is added, because none is specified.
  - Depends on: 1.5
  - Done when: unit and property tests show that every dangerous prefix is neutralized and other cells are unchanged.
  - Verify: AT-SEC-22.
  - Tests: AT-SEC-22
  - Properties: none
  - _Requirements: 29.7_

- [ ] 25. Performance enforcement, soak tests, and dependency review

- [ ] 25.1 (Blocked) Enforce performance budgets on the reference environment
  - Outcome: CI or scheduled jobs on the reference environment enforce:
    - the CSV p95 of 500 ms or less;
    - the provisional FIX, VaR, and sentiment budgets, after confirmation;
    - a 5th-percentile dashboard frame rate of 30 fps or more under the reference load.
  - Depends on: 7.7, 12.7, 13.7, 17.4, 18.3
  - Blocked by: OD-2 (all); OD-9 (the FIX part)
  - Done when: each budget passes or fails the job on the reference environment, and the recorded environment matches it.
  - Verify: AT-CSV-21, AT-FIX-07, AT-DSH-04, and enforcement of AT-BEN-01 and AT-BEN-02.
  - Tests: AT-CSV-21, AT-FIX-07, AT-DSH-04
  - Properties: none
  - Rules: NFR-PERF-1
  - _Requirements: 23.1, 33.1, 33.2, 33.3, 33.4, 1.3_

- [ ] 25.2 Add scheduled soak tests
  - Outcome: a scheduled (not default-suite) five-minute real-time cadence run and a WebSocket flood run, with results recorded.
  - Depends on: 13.6, 13.2
  - Done when: the cadence soak reports a p95 deviation of 500 ms or less, and the flood run shows a bounded queue and an accurate dropped counter.
  - Verify: AT-CAD-07, and a soak re-run of AT-PRV-07.
  - Tests: AT-CAD-07, AT-PRV-07
  - Properties: none
  - _Requirements: 10.5, 33.5_

- [ ] 25.3 Add the dependency audit gate
  - Outcome: `npm audit` on every change in CI, with a documented review step for findings; exact pins and the lockfile are re-checked.
  - Depends on: 1.6
  - Done when: CI reports audit results on each run, and a dependency added with a range fails AT-ARC-05.
  - Verify: CI run records.
  - Tests: AT-ARC-05
  - Properties: none
  - _Requirements: 26.5_

## Task Dependency Graph

This table restates the "Depends on" and "Conditional dependency" lines of every subtask in [Tasks](#tasks); those lines remain the source of truth. A required dependency must be complete before the subtask starts. A conditional dependency applies only when its stated condition holds and is never mandatory otherwise. Decision blockers are listed in each subtask and in [Decision blockers](#decision-blockers).

| Subtask ID | Required dependencies | Conditional dependencies |
|---|---|---|
| 1.1 | None | None |
| 1.2 | 1.1 | None |
| 1.3 | 1.2 | None |
| 1.4 | 1.2 | None |
| 1.5 | 1.2 | None |
| 1.6 | 1.3, 1.4, 1.5 | None |
| 1.7 | 1.5 | None |
| 2.1 | 1.3, 1.5 | None |
| 2.2 | 2.1 | None |
| 2.3 | 2.1 | None |
| 2.4 | 1.5 | None |
| 2.5 | 2.4 | None |
| 2.6 | 2.1 | None |
| 3.1 | 2.6 | None |
| 3.2 | 3.1, 2.3, 2.5 | None |
| 3.3 | 3.2 | None |
| 3.4 | 2.6, 1.5 | None |
| 3.5 | 1.6 | None |
| 4.1 | None | None |
| 4.2 | 4.1, 3.2, 3.4, 2.5 | None |
| 4.3 | 4.2 | None |
| 4.4 | 4.2 | None |
| 5.1 | 2.4 | None |
| 5.2 | 5.1, 2.5 | None |
| 5.3 | 5.1 | None |
| 6.1 | 4.2, 5.1, 2.6 | None |
| 6.2 | 5.1, 2.1 | None |
| 7.1 | 2.6, 3.2 | None |
| 7.2 | 7.1 | None |
| 7.3 | 7.2, 5.1 | None |
| 7.4 | 7.3, 6.2 | None |
| 7.5 | 7.4, 5.2, 4.4, 6.1, 6.2 | None |
| 7.6 | 7.5 | None |
| 7.7 | 7.2 | None |
| 8.1 | 2.1 | None |
| 8.2 | 2.4, 2.5, 3.2 | None |
| 8.3 | 8.2, 4.2 | None |
| 8.4 | 8.1 | None |
| 9.1 | 8.1, 8.2 | None |
| 9.2 | 9.1 | None |
| 9.3 | 9.2 | None |
| 9.4 | 9.1, 5.1 | None |
| 9.5 | 9.2 | None |
| 9.6 | 9.1 | 8.4 (OD-16), if the approved vendor delivers JSON |
| 10.1 | 8.1, 8.2, 3.2 | None |
| 10.2 | 10.1 | 8.4 (OD-16), if the approved FX provider delivers JSON |
| 11.1 | 6.2, 9.1, 10.1 | None |
| 11.2 | 11.1 | None |
| 11.3 | 11.2 | None |
| 11.4 | 11.3, 4.2 | None |
| 12.1 | 2.1 | None |
| 12.2 | 12.1, 9.3, 11.1 | None |
| 12.3 | 12.2, 3.2 | None |
| 12.4 | 12.3, 1.1, 5.2 | None |
| 12.5 | 12.2, 2.3, 9.4, 5.1 | None |
| 12.6 | 12.3, 12.5, 4.2 | None |
| 12.7 | 12.2 | None |
| 13.1 | 8.2, 2.6, 3.2 | None |
| 13.2 | 13.1, 2.4 | None |
| 13.3 | 13.1 | None |
| 13.4 | 13.3 | None |
| 13.5 | 13.4 | None |
| 13.6 | 13.3, 13.4 | None |
| 13.7 | 13.2 | None |
| 13.8 | 13.2 | 8.4 (OD-16), if the approved vendor delivers JSON (REST bodies or WebSocket messages) |
| 14.1 | 12.3, 13.3, 13.4 | None |
| 14.2 | 14.1 | None |
| 14.3 | 14.2, 12.4 | None |
| 14.4 | 14.2, 12.5 | None |
| 14.5 | 14.2, 2.6, 1.4 | None |
| 15.1 | 4.2, 13.6, 12.6 | None |
| 16.1 | 12.3, 14.1, 3.2 | None |
| 16.2 | 16.1, 5.1 | None |
| 16.3 | 16.2, 15.1 | None |
| 17.1 | 12.6, 14.2, 11.4 | None |
| 17.2 | 1.4, 4.2 | None |
| 17.3 | 17.1, 17.2, 15.1 | None |
| 17.4 | 17.3 | None |
| 17.5 | 17.3, 16.3, 7.5 | None |
| 17.6 | 17.2, 3.5 | None |
| 18.1 | 7.5 | None |
| 18.2 | 18.1 | None |
| 18.3 | 18.2 | None |
| 19.1 | 2.4, 2.5 | None |
| 19.2 | 19.1, 8.2, 3.4, 8.4 | None |
| 20.1 | 19.2, 8.4 | None |
| 20.2 | 20.1 | None |
| 21.1 | 2.6, 8.2 | None |
| 21.2 | 21.1 | None |
| 21.3 | 20.2, 21.1, 5.1, 3.2 | None |
| 21.4 | 21.3, 4.2, 19.1 | None |
| 22.1 | 21.3, 16.2 | None |
| 22.2 | 21.3, 17.3 | None |
| 23.1 | 4.2, 15.1 | None |
| 24.1 | 1.5 | None |
| 25.1 | 7.7, 12.7, 13.7, 17.4, 18.3 | None |
| 25.2 | 13.6, 13.2 | None |
| 25.3 | 1.6 | None |

### Execution waves

The waves below are derived only from the required dependencies in the table above: each subtask is placed in the first wave after all of its required dependencies. Conditional dependencies are not added; the conditional dependency on 8.4 (wave 6) is still satisfied by this order for 9.6, 10.2 (wave 10), and 13.8 (wave 11). A wave does not lift decision blockers: a blocked subtask stays unchecked until its decision is Resolved.

```json
{
  "waves": [
    { "id": 1, "tasks": ["1.1", "4.1"] },
    { "id": 2, "tasks": ["1.2"] },
    { "id": 3, "tasks": ["1.3", "1.4", "1.5"] },
    { "id": 4, "tasks": ["1.6", "1.7", "2.1", "2.4", "24.1"] },
    { "id": 5, "tasks": ["2.2", "2.3", "2.5", "2.6", "3.5", "5.1", "8.1", "12.1", "25.3"] },
    { "id": 6, "tasks": ["3.1", "3.4", "5.2", "5.3", "6.2", "8.4", "19.1"] },
    { "id": 7, "tasks": ["3.2"] },
    { "id": 8, "tasks": ["3.3", "4.2", "7.1", "8.2"] },
    { "id": 9, "tasks": ["4.3", "4.4", "6.1", "7.2", "8.3", "9.1", "10.1", "13.1", "17.2", "19.2", "21.1"] },
    { "id": 10, "tasks": ["7.3", "7.7", "9.2", "9.4", "9.6", "10.2", "11.1", "13.2", "13.3", "17.6", "20.1", "21.2"] },
    { "id": 11, "tasks": ["7.4", "9.3", "9.5", "11.2", "13.4", "13.7", "13.8", "20.2"] },
    { "id": 12, "tasks": ["7.5", "11.3", "12.2", "13.5", "13.6", "21.3"] },
    { "id": 13, "tasks": ["7.6", "11.4", "12.3", "12.5", "12.7", "18.1", "21.4", "25.2"] },
    { "id": 14, "tasks": ["12.4", "12.6", "14.1", "18.2"] },
    { "id": 15, "tasks": ["14.2", "15.1", "16.1", "18.3"] },
    { "id": 16, "tasks": ["14.3", "14.4", "14.5", "16.2", "17.1", "23.1"] },
    { "id": 17, "tasks": ["16.3", "17.3", "22.1"] },
    { "id": 18, "tasks": ["17.4", "17.5", "22.2"] },
    { "id": 19, "tasks": ["25.1"] }
  ]
}
```
