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
| OD-5 FX provider | Open | 10.2 for real use (legal reuse confirmation; the query-shape live check passed on 2026-11-09) | Fixture FX provider and `FxService` (10.1); 10.2 itself within the hackathon scope (DR-KW-1, H2) |
| OD-6 Financial values | Open | Production configuration only | All implementation; tests supply explicit values |
| OD-7 Authentication | Open | 23.1 (AT-SEC-20) | Loopback-only binding and refusal to bind elsewhere without an `AuthGuard` (4.2) |
| OD-9 FIX support | Open | 18.2, 18.3 (AT-FIX-01 to AT-FIX-07) | Structural FIX tokenizer (18.1) |
| OD-10 Risk contribution | Open | No calculation task | Dashboard shows "not available" (17.1) |
| OD-12 Persistence | Resolved | 5.3 (AT-CSV-12; Property 21 on a real adapter) | Ports and in-memory unit of work (5.1); SQLite adapter (5.3) |
| OD-13 Market data and sentiment vendors | Open | 9.6, 13.8 | Fixture providers (9.1, 13.1) |
| OD-15 NLP chunking | Open | 21.2 | NLP port, fallback provider, filing scores for single-request text (21.1, 21.3) |
| OD-16 Lossless JSON library | Open | 8.4. `SecClient.getJson` and the filing locator (19.3, 20.1) require 8.4 because SEC responses are JSON (required dependency recorded in each). Real provider adapters 9.6, 10.2, and 13.8 also need it only if their approved vendor delivers JSON (conditional dependency recorded in each) | Wrapper interface and contract tests (8.1) |
| OD-19 Production mode | Open | The production-mode rule of 12.3 (AT-FX-11) | Everything else in 12.3, including `DEMO_DATA` flagging and labelling (AT-FX-10) |

OD-8 and OD-14 have interim positions in the requirements that the tasks implement as written (7.3, 12.2). OD-11, OD-17 (Fastify 5, 5.12.8; 4.1), and OD-18 are Resolved.

### Deferred work

- **Composition root (application bootstrap).** Constructing the concrete persistence adapter, the event-bus adapter behind `PositionEventPublisher`, the logger, and the clock, and injecting them into `app/` services and `api/`, is deferred to a later application bootstrap task (design: [Layers and dependency rule](design.md#layers-and-dependency-rule), D-16). That task does not exist in this plan yet and must be added with a new ID; it also decides the composition root's location and its dependency-cruiser rule. Until then, tasks that add `app/` services (6.2, 7.5) take ports as parameters and their tests wire fakes. No current task depends on it, so the dependency table and execution waves are unaffected.
  - Implementation note (first integration milestone; no ID assigned yet): the root lives in `src/main/` (`createApplication`, `components.ts`, `configValues.ts`). dependency-cruiser rule `nothing-imports-main`: no other module imports it, and it may import every module except `web/`. The root assembles the modules with injected ports and adds no behaviour of its own:
    - Ports injected because their decisions are open (OD-12 has since been resolved; the SQLite unit of work comes from `openApplicationDatabase`): the `UnitOfWork`; the market data, FX, and sentiment providers (OD-5, OD-13, OD-16); and an optional sentiment aggregator (OD-1). No production aggregator exists, so Adjusted VaR stays unavailable.
    - Event and data flow: `PositionsChanged` is delivered synchronously in-process to the risk scheduler. Each stored result goes to `/stream` as `RiskUpdate` and to the VaR alert service. A raised alert wakes the outbox dispatcher, which publishes only to the `/stream` hub; no event-bus adapter is created. The sentiment emitter pushes changed tickers to `/stream`.
    - Sentiment ingestion: the REST poller runs only with an injected polling provider, `sentiment.rest.pollSeconds`, and the caller's ticker list. The WSS stream is not wired (13.8, OD-13).
    - Configuration: a component whose keys are missing is not built. Its missing keys are reported in `Application.status`, and the rest still starts.
    - Lifecycle: `start()` listens on the loopback host, then starts the background loops and delivers alerts left `PENDING`. A failed listen releases everything. `stop()` closes the gateway and its WebSocket clients, aborts the loops, drains recalculations, stops the dispatcher (new `AlertDispatcher.stop()`), and closes the worker.
    - Not wired: the 12.4 price trigger and the 14.3 eligibility trigger (no approved contracts); history fetch-through into the series store (9.6, unspecified); `ProviderStatus` stream events (no trigger is specified); the scheduled recalculation interval; and the app-layer `SecurityEventSink` (no SEC client is assembled before phase 7).
    - Executable entry point (implementation note; no ID assigned yet): `src/main/start.ts`, run as `npm run build` then `npm start -- --demo-fixtures --port <n> --allowed-origin <origin>`. It parses options strictly (`--port` and at least one `--allowed-origin` are required; unknown options are refused; there is no host option, the host is always `127.0.0.1`, OD-7). It then loads the environment and `SRC_CONFIG_FILE`, opens `SRC_DATABASE_FILE` (required in every mode; there is no in-memory database), assembles `createApplication`, and listens. Risk calculations run in the compiled worker.
      - Modes: approved market data and FX providers do not exist (OD-5, OD-13), so the only startable mode is the explicit `--demo-fixtures`. It uses `FixtureMarketDataProvider` and `FixtureFxProvider` (`kind: 'DEMO'`) with data generated by `src/main/demoFixtures.ts` (`DEMO-A`, `DEMO-B`, in `fx.baseCurrency`). It logs `start.demo_mode`, and every result carries `DEMO_DATA` and is never evaluated for VaR alerts. At start the fixture history is retrieved into the series store through `components.seriesRetrieval`. This is fixture seeding only, not the undecided 9.6 trigger or range. Sentiment is not wired in this mode (OD-1). Without the flag, start-up is refused with `PROVIDERS_NOT_CONFIGURED` before the database is opened. The demo mode is not the R30.11 production mode, whose semantics stay open (OD-19).
      - Refusals and exit codes: `USAGE`, `PROVIDERS_NOT_CONFIGURED`, `DATABASE_CONFIG_MISSING`, `DATABASE_CONFIG_INVALID`, `DATABASE_UNAVAILABLE`, and `GATEWAY_CONFIG_MISSING` exit with 2 (`start.refused`). Any other start-up failure releases what was opened and exits with 1 (`start.failed`). `SIGINT`, `SIGTERM`, or the IPC message `{ "type": "shutdown" }` stop the application gracefully (database closed last) and exit with 0.
      - Provisional operational values without configuration keys (OD-6), logged in `start.ready`: database busy timeout 5000 ms, stream 16 clients and 1,048,576 buffered bytes, alert delivery backoff 1000 to 30,000 ms with a 10,000 ms attempt timeout, sentiment history 1000.
      - Tests: `test/unit/main/start.test.ts` (options, refusals, in-process start and stop on a temporary SQLite file, the fixture series by hand) and the executable smoke test in `test/integration/build.test.ts` (compiled `main/start.js` as a child process: DEMO start, portfolio, import, Base VaR with `DEMO_DATA`, IPC shutdown with exit 0, data on the reopened file, exit 2 refusals).
      - Still blocked: production start-up (OD-5, OD-13 providers; OD-19 production-mode semantics) and authentication (OD-7).
      - Hackathon additions (requirements DR-KW-1):
        - H3: a configuration with `demo.profile` is refused outside `--demo-fixtures` (`DEMO_CONFIG_OUTSIDE_DEMO_MODE`, exit 2); in demo mode `start.demo_config` and `start.ready` log `demo.provisionalKeys` with each key's status. The committed demo file is `config/demo/kiroween-2026.demo.jsonc`; every unapproved value in it is empty.
        - H2: in demo mode `fx.provider` `ECB` uses the ECB adapter over `httpsGet` (logged as `start.fx_provider`); an invalid `fx.ecb.*` setting refuses start-up (`FX_PROVIDER_CONFIG_INVALID`) instead of falling back to DEMO rates. `FIXTURE` keeps the DEMO fixture rates.
        - H6: the DEMO fixtures add `DEMO-EU` (EUR), `DEMO-US` (USD), and `DEMO-UK` (GBP), and two fixed DEMO FX rates (`EUR -> USD` inverse path, `GBP -> EUR` direct path). With the EUR base, `src/main/demoPortfolios.ts` seeds `demo-eur-usd-gbp` and the EUR-only fallback `demo-eur-only` through the portfolio service and the import use case (logged as `start.demo_portfolio`). It seeds nothing without the EUR base or without an available import (`import.oversellPolicy`), and leaves an existing portfolio untouched.
        - Tests: `test/unit/main/demoMultiCurrency.test.ts` (ECB-derived and DEMO conversion, attribution, DEMO_DATA without alerts, Adjusted VaR unavailable with DEMO sentiment, FX unavailable and weekend-stale fallback, re-seeding).
        - H3 values (approved 2026-11-09, demo only): the committed demo file carries `fx.maxRateAgeSeconds` 345600, `marketData.maxStalenessDays` 5, `marketData.maxReturnGapDays` 5, `recalc.minValueChangePct` "0.10", and `import.oversellPolicy` `REJECT`, all in `demo.provisionalKeys`; with it, `npm start -- --demo-fixtures` seeds both portfolios and calculates Base VaR. It was checked once against the live ECB on 2026-11-09 (Monday rates, `CURRENT`). Tests on the committed file cover the weekend, Christmas 2026 and New Year 2027 (synthetic ECB-format rows), the exact four-day boundary, the known Easter limitation (recorded 7 April 2026: `FX_STALE`), and ECB missing or unavailable (EUR-only stays available).
- **App-layer `SecurityEventSink` (SEC security audit).** The `app/` implementation of the `sec/` `SecurityEventSink` port, which records each SEC URL rejection with `recordAuditEvent` (category `SECURITY`, type `SEC_URL_REJECTED`) and reports a failed audit write as a delivery failure, is delivered with the composition root above (design: [URL Guard and Client](design.md#url-guard-and-client), R29.14). Task 19.1 defines the port and tests it with a recording fake; no current task depends on the app-layer implementation.

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
  - Outcome: OD-17 is recorded as Resolved (Fastify confirmed) or replaced by an approved alternative before gateway code is written. Recorded 2026-11-08: Fastify 5 confirmed, exact pin 5.12.8, with the OD-17 conditions (requirements Open Decisions; design D-8, U-13, Gateway rules). This task is a framework decision only and delivers no gateway code.
  - Depends on: none
  - Done when: the requirements' Open Decisions table shows OD-17 Resolved.
  - Verify: review of the decision record.
  - Tests: none
  - Properties: none
  - _Requirements: 26.9_

- [ ] 4.2 Implement the gateway skeleton with validation and safe errors
  - Outcome (design: Gateway rules 1–8):
    - `src/api/server.ts` binds to `127.0.0.1` only (A-15). Host and port are supplied by the caller; no configuration key is added. Every other host is refused before listening, including one supplied with an `AuthGuard`, until OD-7 is resolved. `AuthGuard` is a minimal type-only interface, with no authentication implemented.
    - Every route validates body, query, and parameters with `z.strictObject` through a project Zod validator compiler. The body limit is 1 MiB.
    - A global error and not-found handler returns `{ error: { code, message, correlationId } }` with a generic message. Fastify's built-in logger is disabled, and logging goes through the shared redacting logger.
    - A shared API contract module in `src/shared/apiContracts/` (request, response, error, and later WebSocket event schemas) is importable by `api/` and later `web/`.
    - Adds the exact-pinned dependency `fastify` 5.12.8.
  - Depends on: 4.1, 3.2, 3.4, 2.5
  - Done when: unknown fields return HTTP 400; an injected internal error returns a generic body with no stack trace or path; a non-loopback bind without an `AuthGuard` fails to start.
  - Verify: integration tests with Fastify `inject()` for AT-SEC-26 and AT-SEC-27.
  - Tests: AT-SEC-26, AT-SEC-27
  - Properties: none
  - Rules: A-15
  - _Requirements: 24.5, 24.6, 26.9, 29.5, 29.13_

- [ ] 4.3 Add per-client rate limiting
  - Outcome: a token bucket per client for `api.rateLimitPerMinute` and `api.uploadRateLimitPerMinute`, returning HTTP 429 (design: Rate limiting rules 1–6). This covers atomic two-bucket admission for uploads, the socket address as client identity, a check before body parsing, `RATE_LIMITED` with `Retry-After`, and bounded memory.
  - Depends on: 4.2
  - Done when: the request after the limit receives 429 under a fake clock, and capacity refills over time.
  - Verify: AT-SEC-21.
  - Tests: AT-SEC-21
  - Properties: none
  - _Requirements: 29.4_

- [ ] 4.4 Add safe upload handling
  - Outcome: multipart upload streamed into memory, capped at `import.maxFileBytes` before parsing. Filenames are sanitized, never used to build file system paths, and stored under generated names (design: Upload rules 1–5).
    - Adds the exact-pinned `@fastify/multipart` 10.1.8.
    - Exactly one file and no other parts. The rejection codes are `FILE_TOO_LARGE` (413), `UPLOAD_INVALID` (400), and `UNSUPPORTED_MEDIA_TYPE` (415).
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
  - Blocked by: none any more (OD-12 resolved: built-in `node:sqlite`, WAL with `synchronous=FULL`, multi-process access with a bounded busy timeout, `SRC_DATABASE_FILE`, `INTEGRITY_ERROR`, ports authoritative, config versions deferred).
  - Implementation note:
    - **Adapter:** `src/persistence/sqlite/` (`driver.ts` is the only `node:sqlite` user; plus `schema.ts`, `repositories.ts`, `sqliteUnitOfWork.ts`). Write rules are shared with the in-memory unit of work through `src/persistence/constraints.ts`, and the thenable guard through `src/persistence/thenable.ts`.
    - **Schema:** migration 1 creates every table of the implemented ports. It adds `UNIQUE`/`CHECK`/`REFERENCES` constraints and append-only triggers; alert content and status rules are also triggers.
    - **Composition root:** `openApplicationDatabase(env, { busyTimeoutMs })` reads `SRC_DATABASE_FILE` and refuses an absent or invalid value with no in-memory fallback. `createApplication({ database })` closes it in `stop()`.
    - **Tests:** the repository contract runs on in-memory, SQLite `:memory:`, and SQLite file adapters, and so does Property 21. `test/integration/sqlitePersistence.test.ts` covers durability across reopen, exact text, migrations, direct-SQL append-only, read integrity, busy handling in one process and across processes, recovery after a killed process, and AT-CSV-12. `test/integration/application.test.ts` covers an application restart on one file.
    - **Not implemented:** an observable test for `synchronous=FULL`, which is a connection setting with no visible effect short of power loss.
  - Done when: AT-CSV-12 passes against the real adapter, and Property 21 passes with injected commit failures at each write.
  - Verify: integration tests against the adapter.
  - Tests: AT-CSV-12
  - Properties: Property 21
  - _Requirements: 22.1, 22.2, 22.3, 28.15, 28.16, 32.1_

- [ ] 6. Portfolio and ledger

- [ ] 6.1 Implement portfolio creation with explicit cash
  - Outcome: `PortfolioCreateSchema` requires `id`, `base_currency`, and `cash` (a decimal string with no default and no `.optional()`; `"0"` and negative values are valid). Route `POST /portfolios`. Also:
    - the `PortfolioRepo` port with in-memory constraints (design: Portfolio repository);
    - `createPortfolioService`, which canonicalizes cash and requires `base_currency` to equal `fx.baseCurrency` (R30.1), otherwise `BASE_CURRENCY_NOT_SUPPORTED` (HTTP 422);
    - `PORTFOLIO_EXISTS` (HTTP 409) for an existing id (design: Allocation and cash, Portfolio creation).
  - Depends on: 4.2, 5.1, 2.6
  - Done when: a request without `cash` returns `VALIDATION_FAILED`; `"0"` is accepted; no code path substitutes zero.
  - Verify: AT-ALC-10. The design lists AT-ALC-10 in phase 3; it is verified here because CSV import needs portfolios.
  - Tests: AT-ALC-10
  - Properties: none
  - Rules: FR-10, A-7
  - _Requirements: 20.1, 30.1_

- [ ] 6.2 Implement the ledger and position projector
  - Outcome (design: [Portfolio](design.md#portfolio), D-16):
    - Persistence ports (`src/persistence/ports.ts`) and the in-memory unit of work: `TransactionRecord` gains `sourceId` and `sourceSequence` (R28.18); `PositionRecord.averagePrice` becomes `DecimalString | null`, accepted only with `signedQuantity` `"0"` and `isShort: false`; `PositionRepo` gains `delete(portfolioId, ticker)`, which is part of the unit of work like every other write and violates a constraint for a position that does not exist. Write-time validation is extended accordingly. No database adapter (OD-12).
    - `src/portfolio/` (pure; imports only `shared/` and `config/`): `LedgerEntry` and `compareLedgerOrder` with the total order `(tradeTimestamp, sourceId, sourceSequence, transactionKey)`; `positionId(portfolioId, ticker)`; `PositionProjector.replay` folding each ticker's entries with FR-13 (increase, reduction, zero reset to `null`, reversal at the reversing price, shorts on the absolute quantity); `POSITION_CURRENCY_CONFLICT` for mixed currencies; `PositionChange`; the `PositionsChanged` event type; `PositionView` with `marketPrice`, `marketValueInstrument`, `marketValueBase`, `allocationPct` all `null` and `valuationStatus: 'NOT_VALUED'` (view only, not persisted). The projector does not apply `import.oversellPolicy` (7.4).
    - `src/app/` (new layer, D-16): `PositionEventPublisher` port and `PositionService.rebuild(portfolioId)`, which runs one synchronous `UnitOfWork.run` that reads the complete ledger and all persisted positions of the portfolio, replays the complete ledger, and reconciles atomically (upsert new and changed positions, delete persisted positions with no ledger transaction, keep zero-quantity positions produced by the ledger, skip unchanged positions), then publishes one `PositionsChanged` with sorted tickers only after a successful commit and only when something changed. A publication failure leaves the committed positions, returns `REBUILT_PUBLISH_FAILED`, and is logged through the redacting logger.
    - Not in scope: the composition root. Services take their ports as parameters and tests wire fakes; concrete wiring is deferred to a later application bootstrap task (see [Deferred work](#deferred-work)).
  - Depends on: 5.1, 2.1, 2.3, 2.4, 2.5
  - Done when: hand-calculated average-price cases pass, including a SELL leaving the average unchanged, a reset to `null` at zero quantity, a reversal, and short increases and reductions; batch import order and repeated rebuilds do not change any position field; no event is published for a failed projection, a failed commit, or an unchanged ledger; an orphaned persisted position is removed while a zero-quantity position from ledger history is kept; a commit failure injected at any write of a rebuild leaves all positions unchanged; dependency-cruiser passes with `portfolio/` importing no persistence or event-bus module.
  - Verify: unit tests for AT-POS-01, AT-POS-02, AT-POS-03 (field presence), AT-POS-05, AT-POS-06, AT-POS-07, AT-POS-08, AT-POS-09 against the in-memory unit of work with injected commit failures and a recording publisher fake, plus the Property 23 property test against an independent rational (BigInt) reference.
  - Tests: AT-POS-01, AT-POS-02, AT-POS-03, AT-POS-05, AT-POS-06, AT-POS-07, AT-POS-08, AT-POS-09
  - Properties: Property 23
  - Rules: FR-13
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 28.17, 28.18, 28.19_

- [ ] 7. CSV ingestion

- [ ] 7.1 Implement CSV pre-checks and streaming parsing
  - Outcome: `src/ingestion/csv/`:
    - Byte and row limits; fatal UTF-8 decoding (`INVALID_ENCODING`); BOM stripping.
    - Header validation (`INVALID_HEADER` naming the columns).
    - The streaming CSV library `csv-parse` 7.0.3 (MIT; approved 2026-11-08), pinned exactly, with `relax_quotes` disabled.
    - Field-length limit; empty rows counted as `skipped`; fields treated only as text.
    - File-level reasons are reported before any record. `MALFORMED_CSV` (quote error or field-count mismatch) is added to `RejectReason` (design: CSV Parser, Implementation).
  - Depends on: 2.6, 3.2
  - Done when: each file-level rejection carries its reason code; formula-like content stays as text; the parser never throws on empty or unreadable input.
  - Verify: unit tests with committed fixtures for AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18, AT-CSV-22.
  - Tests: AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18, AT-CSV-22
  - Properties: none
  - _Requirements: 1.1, 1.5, 28.3, 28.4, 28.5, 28.6, 28.8_

- [ ] 7.2 Implement column mapping and row validation
  - Outcome: `CsvColumnMappingSchema` (`z.partialRecord`, delivered with 7.1); per-field row validation in `src/ingestion/csv/rowValidation.ts` with the shared validators instead of a single `CsvRowSchema` object, so each invalid field gives exactly one error naming its source column (design: CSV Parser, row validation table; unknown columns are already dropped by 7.1). New reason `PORTFOLIO_MISMATCH` for a `portfolio_id` naming another portfolio. Tickers are validated by the shared `TickerSchema`: the fixed pattern `^[A-Z0-9][A-Z0-9.-]{0,14}$`, with no setting, no trimming, and no case folding. A mismatch is `INVALID_TICKER` (R28.7). Dates use the explicitly configured `import.defaultTimezone`; date-only values are rejected with `INVALID_DATE` when it is absent. Row-level errors carry row number, column, and reason code.
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
    - `sourceId` (`"CSV:" + fileSha256`) and `sourceSequence` (the record's `RawRecord.sequence`) on every accepted transaction (R28.18).
    - `UNSUPPORTED_CURRENCY` against `fx.supportedCurrencies`, and `CURRENCY_MISMATCH` against the instrument's established currency.
    - User documentation of the cross-file limitation for trades without `external_id` (R28.14, OD-8 interim position): `docs/import-deduplication.md`.
    - Implementation note: only an accepted row or a ledger transaction makes a later row a duplicate; a row rejected in 7.4 does not (R28.12), and the decisions are repeated without its key (design: Normalizer and Deduper). Found by Property 20.
  - Depends on: 7.2, 5.1, 6.2
  - Done when: re-importing a file creates no transactions; two identical rows in one file are both kept; every accepted transaction carries `sourceId` and `sourceSequence`; the documentation page exists.
  - Verify: AT-CSV-04, AT-CSV-13, AT-CSV-14, AT-CSV-20, and AT-FX-06 (import part).
  - Tests: AT-CSV-04, AT-CSV-13, AT-CSV-14, AT-CSV-20, AT-FX-06 (import part)
  - Properties: none
  - _Requirements: 28.11, 28.12, 28.13, 28.14, 28.18, 28.22, 30.2_

- [ ] 7.4 Implement chronological processing and the oversell policy
  - Outcome: accepted rows are merged with the ledger in `(tradeTimestamp, sourceId, sourceSequence, transactionKey)` order using `compareLedgerOrder` and the pure replay from 6.2 (`portfolio/` public API). `import.oversellPolicy` must be explicitly configured; import is refused when it is absent. `REJECT` rejects a SELL beyond the available quantity with `OVERSELL`. `ALLOW_SHORT` marks the position short. Implemented in `src/ingestion/chronology.ts`; a back-dated SELL is also checked against later committed ledger entries (conservative: a later BUY in the same file does not count toward covering them; design: Normalizer and Deduper).
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
    - Positions are projected only after a successful commit; a failed commit sets status `FAILED`. `src/app/importUseCase.ts` runs the import and, only after its commit succeeded, calls `PositionService.rebuild(portfolioId)` (6.2), which reconciles all positions of the portfolio; `ingestion/` neither writes positions nor publishes events (design D-16).
    - Routes `POST /portfolios/:id/imports`, `GET /imports/:id`, and `GET /imports/:id/rejections`, calling the app-layer use case.
    - Implementation note: column mapping and source label come from the query (uploads keep `fields: 0`); imports of one portfolio are serialized in-process; a commit failure is a generic 500 and is audited as `IMPORT_FAILED` (design: Import summary). AT-CSV-12 stays Blocked by OD-12; the in-memory fake covers atomicity (Property 21).
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
  - Implementation note: generator `scripts/generate-csv-fixture.mjs` (fixed seed, `--check` mode used by a unit test), fixture `test/fixtures/csv/benchmark-10k.csv`, harness `test/bench/csvIngestion.bench.test.ts` run by `npm run bench:csv` (`vitest.bench.config.ts`, never part of `npm test`); records go to the gitignored `bench-results/`.
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
  - Outcome (design: Provider Resilience Layer):
    - In `src/shared/`: `ProviderError`, `ProviderErrorCode`, `RetryPolicy`, `CircuitPolicy`, `ProviderStatus`, `AttemptOutcome`, and `ResilientCall` with `createResilientCall`. Injected `Clock`, `Sleeper` (with `systemSleeper` and `FakeSleeper`), `random()`, and logger. `fn` returns `AttemptOutcome`; `run` always resolves to a `Result`.
    - Retries: `maxRetries` additional attempts; full-jitter backoff (`provider.backoff.*`); `Retry-After` in seconds or as an HTTP date, waiting `max(backoff, Retry-After)`, and ending the call at once, with no wait, when it exceeds `provider.retryAfter.maxMs` (429 `RATE_LIMITED`; 5xx `HTTP_SERVER_ERROR` with its status, counted by the circuit). `TLS_ERROR` for certificate or TLS verification failures (not retried, counts toward the circuit). Per-attempt timeout (`provider.timeoutMs` or a provider-specific one), optional overall deadline on monotonic time, caller cancellation (`CANCELLED`), protection against a non-settling `fn`, and `UNEXPECTED_ERROR` for unexpected exceptions.
    - A per-provider in-memory circuit breaker (`provider.circuit.*`) that surfaces `ProviderStatus`; any non-successful half-open probe reopens it for a fresh full cooldown.
    - `dataStatus` (`CURRENT`, `STALE`, `CACHED`, `UNAVAILABLE`, `DEMO`) with caller-supplied `maxAgeMs`, and an in-memory `LastValidStore` that failed fetches never overwrite.
    - The new operational settings in `ConfigSchema`.
    - A TLS-verified HTTPS transport in `src/adapters/http/` that cannot disable certificate verification, and a committed test-only certificate fixture with an exact-path secret-scan exception.
    - Not in scope: SEC DNS/IP pinning (19.2), the production JSON parser (8.4), persistent provider status, and the risk engine (12.2).
  - Depends on: 2.4, 2.5, 3.2
  - Done when:
    - fault-injected providers show last valid data retained and labelled stale, and no fabricated value;
    - a slow provider does not delay an unrelated calculation (a stand-in calculation until 12.2; see 12.2);
    - an untrusted certificate from a real local HTTPS server fails the call, also with `NODE_TLS_REJECT_UNAUTHORIZED=0`;
    - retry, backoff, `Retry-After` (including the `provider.retryAfter.maxMs` limit), deadline, cancellation, TLS classification, and circuit transitions are exact under `FakeClock`, `FakeSleeper`, and injected randomness.
  - Verify: AT-PRV-01, AT-PRV-02, AT-PRV-03, AT-PRV-08, AT-PRV-10, AT-PRV-11, AT-PRV-12, AT-PRV-13, AT-SEC-23, and the Property 36 fault-injection test.
  - Tests: AT-PRV-01, AT-PRV-02, AT-PRV-03, AT-PRV-08, AT-PRV-10, AT-PRV-11, AT-PRV-12, AT-PRV-13, AT-SEC-23
  - Properties: Property 36
  - _Requirements: 24.8, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 33.9, 33.10_

- [ ] 8.3 Add the provider status route
  - Outcome: `GET /providers/status` returns each provider's status, `since`, and last error code, without secrets (design: Provider status rules 1–3; contract `ProviderStatusResponseSchema`; keys must match `ProviderKeySchema`).
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
  - Outcome (design: [Market Data and FX](design.md#market-data-and-fx)): `MarketDataProvider` interface (`name`, `kind`, `getDailySeries`, `getLatestPrice`) and an in-code fixture provider (always `DEMO`). Normalization of dates (`YYYY-MM-DD` only), tickers (exact match with the request), and currency (`Iso4217Code`), and recording of source, retrieval timestamp, and content hash on a `ProviderSeries`. Structural and lexical validation only: exponent notation, native numbers, malformed text, invalid dates, mismatches, and unknown fields reject the payload (`INVALID_RESPONSE`), while observation-level defects (zero or negative decimals, missing values as `MISSING`, `NaN` and infinities as `NOT_FINITE` markers, weekend dates) are preserved unchanged for 9.2. Quotes are strict (positive decimals only; equally latest quotes are ambiguous). No data is `HTTP_CLIENT_ERROR` 404. Not in scope: cleaning (9.2), returns (9.3), caching (9.4), the holiday calendar (9.5), the real adapter (9.6), and a `ResilientCall` market data service.
  - Depends on: 8.1, 8.2
  - Done when: a fixture payload produces a normalized `ProviderSeries` with source, retrieval timestamp, and content hash; malformed lexical input is rejected; observation-level defects reach the result intact.
  - Verify: AT-MD-17.
  - Tests: AT-MD-17
  - Properties: none
  - _Requirements: 12.1, 12.2, 12.3, 12.6, 26.3, 27.3_

- [ ] 9.2 Implement series cleaning with a weekends-only calendar
  - Outcome: `SeriesCleaner` converting a `ProviderSeries` (from 9.1, which preserves observation-level defects) into a sorted, cleaned `PriceSeries`, implementing FR-3.1 to FR-3.3 behind a `TradingCalendar` interface that treats weekends as non-trading (A-14). Discards and counts `MISSING`, `NOT_FINITE`, non-positive, and non-trading-date observations. Discard counts. `DATA_CONFLICT` for conflicting duplicates. Approved rules (design: Cleaning rules): each defect counted once in the order missing, non-finite, non-positive, non-trading date; discards happen before duplicate detection; identical duplicates (`Decimal.equals()`) keep the first-received text and count as `duplicateCollapsed`; a conflicting date excludes all its observations (`conflicting`), is listed in sorted `conflictDates`, and sets `conflict`, which invalidates the whole series (9.3 propagates `DATA_CONFLICT`); the counts balance with the received count; provenance (`source`, `sourceKind`, `retrievedAt`) is copied and no freshness status is assigned; `contentHash = sha256Hex(canonicalJson({ ticker, currency, observations }))` over the cleaned, sorted observations. Not in scope: holiday logic (9.5, OD-3), returns (9.3).
  - Depends on: 9.1
  - Done when: non-positive, non-finite, and weekend observations are discarded and counted; identical duplicates collapse; conflicting duplicates invalidate the series; the counts balance; the input is not modified.
  - Verify: AT-MD-04, AT-MD-05, AT-MD-06, AT-MD-14.
  - Tests: AT-MD-04, AT-MD-05, AT-MD-06, AT-MD-14
  - Properties: none
  - Rules: FR-3
  - _Requirements: 12.5_

- [ ] 9.3 Implement returns, alignment, and lookback status
  - Outcome: `ReturnsBuilder` with Decimal simple returns (FR-2), taking `CleanResult[]` (design: `ReturnsBuilder.build` algorithm):
    - `DATA_CONFLICT` with the sorted conflicting tickers before any calculation; no partial returns on conflict.
    - Intersection of common dates, with no forward fill.
    - Discard of returns across gaps larger than `marketData.maxReturnGapDays` (before the sufficiency count), and a `multiDayReturnCount` over the kept window.
    - The newest `var.lookbackReturns` returns, with status `COMPLETE`, `REDUCED_LOOKBACK`, or `INSUFFICIENT_DATA` against `var.minObservations`.
    - The as-of date (latest common date) and the limiting ticker (latest first observation date, then fewer observations, then smaller ticker).
    - Returns as canonical decimal strings; `TypeError` for empty inputs, duplicate tickers, or invalid options. Not in scope: `MARKET_DATA_STALE` and `NO_POSITIONS` (the risk input builder, 12.x), and the quantile values `h` of AT-VAR-09/10 (12.2).
  - Depends on: 9.2
  - Done when: hand-built fixtures for 199, 200, 249, 250, and 300 returns give the specified statuses; every output return comes from two real observations; a conflicting input gives `DATA_CONFLICT` and no returns.
  - Verify: unit tests for the listed tests, and the Property 13 and Property 14 property tests.
  - Tests: AT-MD-01, AT-MD-02, AT-MD-03, AT-MD-07, AT-MD-08, AT-MD-09, AT-MD-10, AT-MD-11, AT-MD-12, AT-VAR-08, AT-VAR-09, AT-VAR-10, AT-VAR-11, AT-VAR-12
  - Properties: Property 13, Property 14
  - Rules: FR-2, FR-3
  - _Requirements: 12.4, 12.8, 13.1, 13.2, 13.3, 13.6, 14.4, 27.8_

- [ ] 9.4 Implement the content-addressed series store and caching
  - Outcome (design: Series store and caching): `SeriesStore` in `app/` keyed by the cleaned series content hash (immutable), behind the persistence port (`SeriesRepo` in `persistence/ports.ts`, in-memory implementation in `persistence/memory/`):
    - Content (`price_series`) and provenance (`series_retrievals`, append-only, `seq`-ordered) are stored separately, so one hash may carry several retrievals, REAL and DEMO alike.
    - Labels are per retrieval, never per content hash: REAL retrievals are `CACHED`, DEMO retrievals are `DEMO`; stored data is never `CURRENT`. No expiry, time-to-live, eviction, or age-based `STALE`.
    - `put(CleanResult)` recomputes the hash (mismatch: `TypeError`), refuses `conflict = true` (`SERIES_CONFLICT`, nothing written), is idempotent for identical content and identical retrievals, and commits content and retrieval in one unit of work (`STORE_FAILED` on a `PersistenceError`).
    - `getByHash` returns the content and all retrievals in `seq` order, each with its own label; `latestFor(ticker, sourceKind)` returns the selected retrieval (latest `retrievedAt`, then higher `seq`) and its label; `NOT_FOUND` otherwise.
    - Reads are Zod-validated and the hash recomputed (`SERIES_INTEGRITY_ERROR`, no data returned).
    - Prices keep their exact decimal text (the C2 exception to canonical storage, financial-rules §6). `contentHash`, `seriesHashes`, `ReturnMatrix`, and `RiskInput` are unchanged.
    - Not in scope: a `ResilientCall` fetch-through service, concurrent-fetch de-duplication, and refresh scheduling (with 9.6, OD-13); the durable adapter (5.3, OD-12).
  - Depends on: 9.1, 5.1
  - Done when: a cached series is never labelled `CURRENT`; provenance (source, observation timestamp, real or demo) is retained per retrieval; content with both REAL and DEMO retrievals keeps each retrieval's own label.
  - Verify: AT-MD-18, and the market-data part of AT-AUD-03; series-store round-trip and order-independence property tests (not numbered design properties).
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
  - Implementation note (the parts specified without OD-13): `src/app/seriesRetrieval.ts`, `SeriesRetrievalService.retrieve(ticker, range)`. It makes one explicit request and adds no schedule or cache:
    - `getDailySeries` runs once through the shared `ResilientCall` under `marketdata:<provider name>`, operation `getDailySeries`, with the price mapping `toPriceAttempt`.
    - Inside the attempt the result is re-validated like a quote: strict shape, requested ticker, dates within the range, `source`/`sourceKind` equal to the provider, recomputed content hash. A failure is `INVALID_RESPONSE` with its reason.
    - The series is then cleaned by the 9.2 cleaner with the weekends-only calendar and stored with `SeriesStore.put`; `SERIES_CONFLICT` and `STORE_FAILED` are passed through.
    - The composition root assembles it as `components.seriesRetrieval`. No trigger is wired, and Base VaR reads the stored series through `seriesStoreHistory` unchanged.
    - Still undecided: when retrieval runs, which `DateRange` it requests, refresh, expiry, de-duplication of concurrent requests, and staleness of stored series. The vendor adapter itself is blocked by OD-13.
  - Conditional dependency: if the approved vendor delivers JSON, this subtask also depends on 8.4 (OD-16), because financial-rules rule 3 and design D-5 forbid `JSON.parse` on provider payloads. The vendor's payload format is recorded when OD-13 is resolved.
  - Done when: recorded vendor responses pass the same normalization tests as the fixture provider, and exponent notation in vendor numbers is rejected (R4.6).
  - Verify: integration tests against recorded responses; live checks only through `test:live`.
  - Tests: none
  - Properties: none
  - _Requirements: 12.1, 12.3, 4.6_

- [ ] 10. FX

- [ ] 10.1 Implement the FX port, a fixture provider, and `FxService`
  - Outcome (design: FX rules): `FxProvider` port (`name`, `kind`, `getRate(from, to, asOf, at)`, returning the latest rate with `observedAt <= min(end of asOf UTC, at)`), strict `ProviderFxRate` validation, an in-code fixture provider (always `DEMO`), the local `FxSourceKind` (`DataSourceKind | 'IDENTITY'`; the shared `DataSourceKind` is unchanged), and `FxService.rateToBase(currency, asOf, at)`:
    - `Rate(X/B)`: direct `(X, B)` quotes canonicalized; inverse `(B, X)` quotes converted by one Decimal division `1 / quote`; the result always carries the requested pair `X + B` and `Rate(X/B)`, never the quote orientation. The base currency returns the `IDENTITY` rate (`"1"`, source `BASE_CURRENCY`, `observedAt: null`, status `CURRENT` without `dataStatus`) and makes no provider call.
    - Provenance: the rate's `source` and `sourceKind` must equal the configured provider's `name` and `kind`; a mismatch is `INVALID_RESPONSE`.
    - Selection: observed no later than the end of `asOf` (UTC) and no later than `at`; staleness `at - observedAt > fx.maxRateAgeSeconds` (strict), measured directly for every source kind; fresh rates take `CURRENT` or `DEMO` from `dataStatus`. `at` and `observedAt` use `IsoUtcMillis`.
    - `FX_UNAVAILABLE` (`PROVIDER_ERROR`, `INVALID_RESPONSE`, `UNSUPPORTED_CURRENCY`) and `FX_STALE` (with a display-only `StaleFxRate`, not assignable to `FxRateUsed`). The `FxError` type also declares `RATE_CONFLICT`, `RECORD_FAILED`, and `lastValid`, which only task 10.3 sets.
    - No triangulation, substitution, or fallback; provider calls through `ResilientCall`; deterministic for identical inputs; results frozen.
    - Schema, pair, provenance, and selection-bound checks run inside the `ResilientCall` operation: invalid provider data is the non-retryable `INVALID_RESPONSE` outcome, counts toward the circuit breaker (8.2), and gives `FX_UNAVAILABLE` (`INVALID_RESPONSE`). Provider-returned `CIRCUIT_OPEN`, `CANCELLED`, or `UNEXPECTED_ERROR` are unexpected outcomes; attempt timeouts and cancellation stay `TIMEOUT` and `CANCELLED` from `ResilientCall`. An unexpected `dataStatus` for a fresh rate gives `FX_UNAVAILABLE` (`INVALID_RESPONSE`); `rateToBase` never throws for it.
    - No FX scenario risk is modelled; rates are held constant across scenarios (A-9, OD-4 open).
    - Not in scope: recording, `FxRepo`, and the last valid rate (10.3); transaction rejection for unsupported currencies (task 7.3; AT-FX-06 import part); DEMO-rate result validity (12.3, R30.11); FX rates in the snapshot (12.5, AT-FX-05); the real adapter (10.2).
  - Depends on: 8.1, 8.2, 3.2
  - Done when: missing, invalid, mismatched-provenance, and stale rates produce their statuses with the currency; invalid provider data counts toward the circuit breaker; the identity rate has no timestamp; a stale DEMO rate is `FX_STALE`; inverse conversion equals the correctly rounded 40-significant-digit value of `1 / quote`.
  - Verify: unit tests for the listed tests, and the Property 26 and FX part of Property 25 property tests.
  - Tests: AT-FX-01, AT-FX-02, AT-FX-03, AT-FX-04, AT-FX-06 (FX service part), AT-FX-08, AT-FX-09, AT-AUD-03 (in-memory FX part)
  - Properties: Property 25, Property 26
  - Rules: A-9
  - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.7, 30.8, 22.3_

- [ ] 10.2 (Blocked) Implement the ECB FX provider adapter (proposed route)
  - Outcome (design: ECB FX adapter; applies only if OD-5 is resolved as ECB for a EUR base):
    - Port change (U9): `FxProvider.getRate` gains the attempt `AbortSignal` as its fifth argument (FxService passes it, FX rule 4; the fixture provider ignores it). The timestamp-basis fields come from task 10.4; the ECB provider emits `PUBLICATION_CONVENTION` with `ECB-PUB-1600-FRANKFURT-v1` (ECB adapter rule 2).
    - `src/adapters/fx/`: the ECB provider over the 8.2 `httpsGet` with the fixed endpoint and query (ECB adapter rule 1), the `ECB-PUB-1600-FRANKFURT-v1` convention with integer EU summer-time arithmetic (rule 2), selection (rule 3), and the dedicated dependency-free fixed-format CSV parser (rule 4).
    - Shared request and cache (rule 5): exact (`asOf`, `at`) key; only completed, valid responses cached, frozen and never modified; failed, aborted, timed-out, and partial responses never cached; at most `fx.ecb.cacheMaxEntries` entries (LRU); each caller cancels independently; the shared request is aborted only when every waiting caller has abandoned it. No extra limiter (rule 6).
    - `ConfigSchema`: `fx.provider` (class F, no default, a Base VaR key under R14.14; `ECB` requires base `EUR`) and `fx.ecb.*` (class O, provisional, validated).
    - Recorded ECB fixtures, immutable, with the attribution README and the manual refresh procedure (rule 9); an optional live check under `test:live` only.
    - Not in scope: the timestamp-basis types and FX rule 5 validation (10.4), the general CSV library (7.1), JSON parsing (8.4), other providers, triangulation, FX persistence (10.3), the composition root, and rendering of the attribution (17.3).
  - Implementation note (hackathon scope, requirements DR-KW-1 H2; real use still blocked by OD-5):
    - Delivered: `src/adapters/fx/` (`ecbFxProvider.ts`, `ecbConvention.ts`, `ecbCsv.ts`, public API through `src/adapters/index.ts`), the U9 port change (`getRate(..., signal)`; FxService passes the attempt signal and the optional `attemptTimeoutMs`, wired to `fx.ecb.timeoutMs`), `fx.provider` (class F, Base VaR key) and `fx.ecb.*` (class O, provisional) with the cross-key rule `ECB_REQUIRES_EUR_BASE`, and `fxAttribution` (`fx/attribution.ts`, rule 8) exposed as `fxRate.attribution` in the positions response.
    - Precondition (b) is met: the live query check passed on 2026-11-09 (U4). Preconditions (a) and (c) are met for the hackathon demo only (H2); for real use they stay open.
    - Recorded fixtures: five responses under `test/fixtures/fx/ecb/` with the README (rule 9), recorded with `node scripts/record-ecb-fixtures.mjs`; `.gitattributes` keeps their bytes.
    - Tests: `test/unit/adapters/fx/ecbConvention.test.ts`, `ecbCsv.test.ts`, `ecbFxProvider.test.ts`, `test/integration/ecbFxService.test.ts`, `test/unit/fx/attribution.test.ts`, `test/unit/config/demoConfig.test.ts`. The design-review mutation checks were run; the quote-character check is an equivalent mutant (every field is validated exactly, so a quote is always rejected anyway).
    - Not delivered: the optional `test:live` check; rendering of the attribution (17.3); a `Retry-After` path through the FX port (design rule 6).
  - Depends on: 10.1, 10.4, 8.2, 3.2
  - Blocked by: OD-5. Before implementation, also: (a) explicit approval of the financial configuration (`fx.baseCurrency` = EUR, `fx.provider` = `ECB`) for real use (tests supply explicit values); (b) live verification of the query shape, `endPeriod` with `lastNObservations=2` (U4); if it fails, ECB adapter rule 1 is amended first; (c) the legal reuse question of R30.14 (derived values, risk-monitoring use). No dependency on 8.4: the ECB route uses CSV.
  - Done when: recorded responses pass the FxService tests, including inverse conversion; no rate is ever used before its convention instant for any `at`; malformed CSV counts toward the circuit; one request serves all currencies of a calculation; aborting the last waiting caller aborts the request, while aborting one of several does not; aborted and partial responses are never cached.
  - Verify: unit, property, and integration tests (recorded responses), the mutation checks listed in the design review (DST off-by-one, bound comparison, cache key without `at`, header check, quote handling, size limit, signal not passed, failures cached), and the optional live check.
  - Tests: AT-FX-13, AT-FX-14, AT-FX-15, AT-FX-16, AT-FX-17, AT-FX-19
  - Properties: Property 26 (re-run against recorded ECB data)
  - _Requirements: 30.3, 30.4, 30.5, 30.7, 30.13, 30.14, 14.14, 24.8, 25.7, 25.8_

- [ ] 10.3 Record FX rates and keep the last valid rate for display
  - Outcome (design: FX rate recording and last valid rate): `app/fxRateRecorder.ts`, `createRecordingFxService`, which builds the 10.1 `FxService` itself from the same `FxServiceDependencies` and uses `FxRepo` (`persistence/ports.ts`, in-memory unit of work), the shared `LastValidStore`, an injected `IdGenerator`, and the `Clock`:
    - Appends to `fx_rates`, before returning, the rate of a successful `OBSERVED` result and the `displayRate` of an `FX_STALE` result; nothing else is recorded (in particular no `FX_UNAVAILABLE` result, including `INVALID_RESPONSE` from the FX rule 8 status guard). Each record holds the requested pair `X + B`, canonical `Rate(X/B)` (inverted for inverse quotes, never the quote orientation), the configured provider's `source` and `sourceKind`, `observedAt` with its `observedAtBasis` and `conventionId` (R30.13; task 10.4), and `recordedAt`; both timestamps as `IsoUtcMillis`.
    - Identical re-receipts write nothing (identical: the same `rate`, `observedAtBasis`, and `conventionId` as the stored record); a record under the same `(pair, source, sourceKind, observedAt)` whose `rate`, `observedAtBasis`, or `conventionId` differs is `RATE_CONFLICT` and is not used; a recording failure is `RECORD_FAILED` and the rate is not used. An `FX_STALE` result is returned only after its `displayRate` is recorded.
    - Only a successful `OBSERVED` result whose record has committed updates the last valid rate, keyed `pair:kind` with `kind` the configured provider's kind (`FxServiceDependencies.provider.kind`, never inferred from results); stale, invalid, future-dated, conflicting, and unrecorded rates never do.
    - Only `PersistenceError` maps to `RECORD_FAILED`; any other exception during recording or the last valid update propagates (programmer error). Record ids come from the injected `IdGenerator` (`randomIds` in production, `sequentialIds` in tests).
    - On `PROVIDER_ERROR` or `INVALID_RESPONSE`, `FX_UNAVAILABLE` carries `lastValid` as a display-only `StaleFxRate`; it never enters `FxRateUsed` or makes VaR available.
    - Not in scope: durable storage (5.3, OD-12; the in-memory unit of work is not durable); rebuilding the last valid rate after a restart (not delivered by any task); identity rates (never recorded).
  - Implementation note (OD-20, resolved 2026-11-09, option 2):
    - Each record also stores the provider's quote as `FxRateRecord.published`, in SQLite migration 2 (nullable `fx_rates` columns, insert trigger):
      - the quote's own pair and canonical value;
      - the provider's reference date (the ECB adapter adds it as `ProviderFxRate.referenceDate`);
      - `derivation_method` (`AS_PUBLISHED` or `DECIMAL_INVERSE`) and `derivation_precision` (`SIGNIFICANT_DIGITS_40_ROUND_HALF_UP`).
    - `createFxService` returns a `QuotedFxService`, whose `rateToBaseQuoted` reports the quote beside the unchanged result. `FxRateUsed`, risk inputs, and snapshots are unchanged.
    - An identical re-receipt also needs an identical stored quote; a pre-migration row is matched on its original fields and never rewritten.
    - The positions response reads the quote back from `fx_rates` as `fxRate.quote`, and the dashboard shows it beside the derived rate.
    - Tests: `test/integration/fxProvenancePersistence.test.ts` (migration from version 1, round trip on every adapter, rows without a quote, restart, direct-SQL consistency, read integrity, the recorder over recorded ECB data, conflict), plus the updated recorder unit tests.
  - Depends on: 10.1, 10.4, 5.1
  - Done when: a fault-injected FX provider leaves the last valid rate unchanged and visibly stale; no rate is fabricated; no stale or last valid rate reaches `FxRateUsed`; stale, invalid, and future-dated rates never replace the last valid rate; a stale rate that cannot be recorded gives `RECORD_FAILED`; a non-persistence exception propagates; record ids are deterministic under `sequentialIds`.
  - Verify: unit tests for the listed tests, and the FX part of Property 36.
  - Tests: AT-FX-12, AT-PRV-01 (FX part), AT-PRV-02 (FX part), AT-PRV-03 (FX part), AT-AUD-03 (FX recording part)
  - Properties: Property 36
  - _Requirements: 22.3, 25.3, 25.4, 25.5, 30.5, 30.8, 30.12, 33.10_

- [ ] 10.4 Add FX timestamp-basis metadata and its validation
  - Outcome (design: FX rules 5 and 12; R30.5, R30.13):
    - `ObservedAtBasis` (`PROVIDER` | `PUBLICATION_CONVENTION`) and `conventionId` on `ProviderFxRate`, `FxRateUsed` (`OBSERVED`), and `StaleFxRate`; `IDENTITY` has neither. Exported from `src/fx/index.ts`.
    - FX rule 5, inside the `ResilientCall` operation (rule 4a): `PROVIDER` requires `conventionId` absent; `PUBLICATION_CONVENTION` requires a `conventionId` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a missing or unknown basis, or any other combination, is `FX_UNAVAILABLE` (`INVALID_RESPONSE`) and counts toward the circuit breaker. Both fields are copied unchanged into `FxRateUsed` (`OBSERVED`) and `StaleFxRate`.
    - The fixture provider emits `PROVIDER` for every rate (its entries carry explicit `observedAt` values); fixture entries themselves are unchanged.
    - Mechanical updates to the accepted 10.1 tests (design: FX rule 12); no other 10.1 behaviour changes.
    - Not in scope: the `AbortSignal` port change and the ECB provider (10.2), FX recording (10.3).
  - Depends on: 10.1
  - Done when: every observed and stale rate carries its basis; each invalid basis combination is `INVALID_RESPONSE` counted by the circuit; all accepted 10.1 tests pass with only the listed mechanical changes; the 10.1 mutation checks still fail their tests.
  - Verify: unit tests for AT-FX-20, the 10.1 suite, Property 25 (FX part) and Property 26, and re-run of the 10.1 mutation checks (M1–M9, N1–N5), sequentially.
  - Tests: AT-FX-20
  - Properties: Property 25, Property 26 (re-run)
  - _Requirements: 22.3, 30.5, 30.13_

- [ ] 11. Valuation, exposure, and allocation

- [ ] 11.1 Implement position valuation
  - Outcome (design: [Portfolio](design.md#portfolio), Valuation rules 1–17):
    - `portfolio/positionView.ts`: `ValuationStatus` widened to `NOT_VALUED | VALUED | PRICE_UNAVAILABLE | PRICE_CURRENCY_MISMATCH | FX_UNAVAILABLE | FX_STALE`, and a pure `toValuedPositionView(position, input)`. `PositionView`'s shape and `toPositionView` are unchanged.
    - `app/positionValuation.ts`: `createPositionValuationService({ marketData, resilientCall, fx, clock })`. `value(portfolioId, positions)` reads `at` once from the `Clock`, wraps `getLatestPrice` with `ResilientCall` (circuit key `marketdata:<provider name>`, FX rule 4 mapping, rule 4a accounting), re-validates each quote, and rejects quotes dated after the UTC date of `at` (`PRICE_UNAVAILABLE`, `FUTURE_DATED`). A quote currency that differs from the position currency gives `PRICE_CURRENCY_MISMATCH`. The service converts with `FxService.rateToBase(currency, quote.asOf, at)` and returns one `PositionValuation` per position: status, view, `priceAsOf`, the complete quote, and the `FxRateUsed` or `FxError`.
    - The fields stay `null` with a status when a price or rate is unavailable. An `FX_STALE` display rate or `lastValid` rate never enters a valuation. There is no price staleness rule. Lookups are reused only within one call and only when their complete keys match.
    - The attempt timeout bounds waiting but cannot abort the provider's work, because the 9.1 port has no `AbortSignal`. Late results never affect a valuation.
    - `allocationPct` is filled by 11.3. Valuation fields are not persisted with positions.
    - Not in scope: a last valid price for display (R33.10, R25.3); 11.1 does not fulfil it, and it is delivered by 11.5.
    - Not changed: the 6.2, 8.2, 9.1, 10.1, 10.3, and 10.4 contracts.
  - Depends on: 6.2, 8.2, 9.1, 10.1 (10.4 fields carried through unchanged; works with the 10.3 recording service)
  - Done when: a mixed-currency fixture portfolio is valued exactly in base currency (hand-calculated case, including a short, a zero-quantity, and a base-currency `IDENTITY` position); a missing rate gives `FX_UNAVAILABLE`, never zero; `FX_STALE`, `PRICE_UNAVAILABLE` (provider error, invalid quote, future-dated quote), and `PRICE_CURRENCY_MISMATCH` leave the specified fields `null`; a timed-out price whose late result arrives afterwards does not change the valuation; identical FX keys make one call, and different `asOf` values make separate calls.
  - Verify: AT-FX-07 and unit tests.
  - Tests: AT-FX-07
  - Properties: none
  - Rules: FR-4
  - _Requirements: 5.2, 25.7, 25.8, 25.9, 30.6, 30.7, 30.8, 30.9, 33.9_

- [ ] 11.2 Implement exposure and NAV
  - Outcome: long value, short value, gross and net exposure, and NAV per FR-10 and FR-12, using the explicitly supplied cash (design: Exposure rules 1–6): `computeExposure(views, cash)`, with `navStatus` (`NAV_NOT_POSITIVE` when NAV <= 0, NAV still reported). Flat positions contribute nothing. Any other position without a base value gives `EXPOSURE_UNAVAILABLE` (`VALUATION_INCOMPLETE`) with the tickers and statuses and no measures, never zero.
  - Depends on: 11.1
  - Done when: hand-calculated cases with shorts and negative cash pass.
  - Verify: AT-ALC-09.
  - Tests: AT-ALC-09
  - Properties: none
  - Rules: FR-10, FR-12
  - _Requirements: 20.6_

- [ ] 11.3 Implement allocation with the largest-remainder rule
  - Outcome: `AllocationCalculator` per FR-11 (ROUND_DOWN, remaining units, ties by ascending ticker with `CASH` last), `ALLOCATION_UNAVAILABLE` for a non-positive denominator, `INELIGIBLE` with reasons `SHORT_POSITIONS`, `NEGATIVE_CASH`, `LEVERAGE` (independent ROUND_HALF_UP two-decimal lines; shorts listed with values and no percentage), a `CASH` line of its own kind, canonical percentage strings (two-decimal display formatting by the dashboard, 17.3), `withAllocation` for `PositionView.allocationPct`, and unforced totals for ineligible portfolios (design: Allocation rules 1–7). Fills `PositionView.allocationPct` (6.2), which stays `null` with its status when no allocation is available.
  - Depends on: 11.2
  - Done when: three equal assets give `{33.34, 33.33, 33.33}`; eligible portfolios total exactly `100.00` for every input order.
  - Verify: unit tests for the listed tests, and the Property 15 and Property 16 property tests.
  - Tests: AT-ALC-01, AT-ALC-02, AT-ALC-03, AT-ALC-04, AT-ALC-05, AT-ALC-06, AT-ALC-07, AT-ALC-08
  - Properties: Property 15, Property 16
  - Rules: FR-10, FR-11
  - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.8_

- [ ] 11.4 Add the positions and allocation routes
  - Outcome: `GET /portfolios/:id/positions` and `GET /portfolios/:id/allocation`, with decimal strings, statuses, and the denominator used. Response contracts are `PositionsResponseSchema` and `AllocationResponseSchema` (`src/shared/apiContracts/portfolio.ts`), including `priceProvenance`, `fxRate`, `priceUnavailable`, and `fxUnavailable`, with nullability per design "Positions and allocation responses" rule 4.
  - Depends on: 11.3, 4.2, 6.1 (the allocation route needs the explicitly stored portfolio cash)
  - Done when: responses contain no JSON numbers for financial values and expose raw exposure values separately from percentages.
  - Verify: integration tests with `inject()`.
  - Tests: none
  - Properties: none
  - _Requirements: 5.2, 20.6, 20.8, 4.3_

- [ ] 11.5 Retain the last valid market price for display only
  - Outcome (design: [Portfolio](design.md#portfolio), Last valid price rules 1–8; an additive extension of 11.1 and 11.4):
    - **Storage.** A dedicated `app/` `PriceLastValidStore` in process memory. It is keyed `ticker + ":" + position currency + ":" + marketData.kind`, using the configured kind and never one inferred from a result, so `DEMO` and `REAL` never mix and a price in another currency is never stored or shown. Only currency-matched quotes are stored: a quote whose `currency` differs from the key currency is a programmer error (`TypeError`). The 8.2 `LastValidStore` is neither used nor changed, because its single timestamp cannot express the ordering below and it overwrites on equal timestamps.
    - **What becomes last valid.** Writes are selected by status, never by `price !== null`: only the quote of a `VALUED`, `FX_UNAVAILABLE`, or `FX_STALE` result. They happen in one synchronous step after the inner 11.1 `value()` has resolved for the whole call; nothing is written if it rejects. Failed, invalid, future-dated, currency-mismatched, and late or timed-out attempt results never write.
    - **Ordering.** By (`asOf`, `retrievedAt`):
      - a strictly newer quote replaces the entry and clears any conflict, including a same-`asOf` intraday price change and a newer `asOf` that was retrieved earlier;
      - an older quote never overwrites newer state;
      - an identical quote leaves the entry unchanged;
      - an equal key with different content marks the entry conflicted, so nothing is displayed until a strictly newer quote arrives.
      The final state for any set of offers does not depend on their arrival order. Nothing is stored for a ticker that never had a valid quote.
    - **Display provenance.** The `PRICE_UNAVAILABLE` variant of `PositionValuation` gains an optional `lastValid` (task 11.5 only).
      - It is attached only for outage, timeout, invalid-response, and future-date failures: cause `PROVIDER_ERROR` with `providerCode` `NETWORK_ERROR`, `TIMEOUT`, `HTTP_SERVER_ERROR`, `RATE_LIMITED`, `CIRCUIT_OPEN`, `TLS_ERROR`, or `INVALID_RESPONSE`; cause `INVALID_RESPONSE`; and cause `FUTURE_DATED`.
      - It is never attached to `PRICE_CURRENCY_MISMATCH`, which is a currency-integrity failure, not an outage. It is never attached to `HTTP_CLIENT_ERROR`, which includes 404 (no data) and other non-outage 4xx responses that 11.1 does not distinguish by status. It is never attached to `UNEXPECTED_ERROR` or `CANCELLED`.
      - It is a `StalePriceDisplay` with `kind: 'LAST_VALID_DISPLAY'`, `status: 'STALE'`, label `LAST_VALID`, and the stored quote: `ticker`, `currency`, `price` as a Canonical Decimal String, `asOf`, `source`, `sourceKind`, and `retrievedAt`.
      - Here `STALE` means "not current because retrieval failed"; it is not a price-age rule, and 11.1 V6 stands.
      - Its `kind` and `status` make it unassignable to `ProviderQuote` and to the `toValuedPositionView` input.
    - **Display only.** The market fields stay `null` and the status stays `PRICE_UNAVAILABLE`. A last valid price never enters valuation, exposure, NAV, allocation, `RiskInput`, VaR, snapshots, or alert evaluation, and never makes any of them available (R33.10: no stale data where current data is required).
    - **Outage and recovery.** During an outage, including timeouts and `CIRCUIT_OPEN`, every call returns the same stored value unchanged. When retrieval recovers, the current quote is used (`VALUED`), no `lastValid` is attached, and the store advances only under the ordering rule.
    - **API.** The 11.4 positions route returns `lastValid` additively, as an optional field validated by `StalePriceDisplaySchema` in the shared API contract: a canonical decimal string, `IsoDate`, `IsoUtcMillis`, source kind, and label. No JSON numbers; existing fields are unchanged.
    - **Not in scope:**
      - durable storage: the store is empty after a restart (5.3, OD-12);
      - rebuilding the store from the series store (9.4);
      - dashboard rendering (view-model and dashboard tasks);
      - any change to the 9.1 provider interface, which stays as accepted unless a separately approved decision changes it.
    - **Delivered as** a wrapper `createLastValidPriceValuationService({ valuation, store })` that implements `PositionValuationService` (the 10.3 pattern). The 11.1 factory and behaviour are unchanged, and there is no on/off setting.
  - Depends on: 11.1, 11.4, 8.2
  - Done when:
    - after a successful valuation followed by eligible provider failures (network error, server error, rate limiting, timeout, open circuit, TLS error, invalid quote, future-dated quote), each failing position carries the unchanged last valid quote labelled `LAST_VALID` with status `STALE`, its `asOf`, and its `retrievedAt`;
    - `PRICE_CURRENCY_MISMATCH`, `HTTP_CLIENT_ERROR` (including 404), and `UNEXPECTED_ERROR` results never receive `lastValid`;
    - any permutation of the same offers gives the same store state, including the equal-key conflict and its clearing by a strictly newer quote;
    - a newer `asOf` retrieved earlier replaces a stored older `asOf`, and an older quote never overwrites newer state;
    - a `PRICE_CURRENCY_MISMATCH` quote never writes, and a stored value in one currency is never attached to a position in another;
    - a rejected inner `value()` writes nothing;
    - a `DEMO` last valid value keeps `sourceKind` `DEMO`;
    - the displayed timestamps are the quote's `asOf` and `retrievedAt`;
    - every valuation field stays `null`, and every result other than the attached `lastValid` is identical with and without a stored value;
    - no value exists for a ticker that never had a valid quote;
    - a late result never writes the store;
    - `DEMO` and `REAL` keys stay separate;
    - recovery gives `VALUED` with no `lastValid`;
    - an older quote never replaces a newer one;
    - the route contains no JSON numbers for it.
  - Verify: unit tests; a type-level test that `StalePriceDisplay` is not assignable to the valuation input; the Property 36 fault-injection test (price part); and an integration test of the route with `inject()`.
  - Tests: AT-PRV-01 (price part), AT-PRV-02 (price part), AT-PRV-03 (price part)
  - Properties: Property 36 (price part)
  - _Requirements: 25.3, 25.4, 25.5, 33.10_

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
  - Implementation note: `src/risk/engine.ts` (`hs-var-1`). `RiskInput` also carries `marketDataStale` and per-position `historySourceKind`; `DEMO_DATA` also covers DEMO history; `snapshotHash` and the configuration version are added on storage, not by the engine. Adjusted VaR placeholder until 14.1/14.2 (superseded by 14.1 and 14.2): always `null`, with `BASE_UNAVAILABLE` when Base VaR is not `OK`, `ADJUSTMENT_CONFIG_MISSING` (keys listed) when an R15.1 setting is missing, otherwise `SENTIMENT_NOT_CURRENT` (every ticker `ABSENT`); a non-empty `sentiment` input is a programmer error until 14.1 (design: Risk Engine, implementation).
  - Versioning note (approved after 14.5): the engine is now `hs-var-2`, covering Base VaR and the R15 adjustment together; `hs-var-1` meant Base VaR only. Recomputation requires an exact algorithm-version match. Snapshots are written as `schemaVersion` 2 (sentiment entries carry `source` and an optional `aggregatorVersion`); version 1 snapshots still validate and hash-check, and recomputing one gives `ALGORITHM_VERSION_MISMATCH` (or `SCHEMA_VERSION_UNSUPPORTED`). No calculation changed.
  - Depends on: 12.1, 9.3, 11.1
  - Done when: hand-calculated two-asset and short-position cases pass; horizons other than 1 and confidences outside (0, 1) are rejected.
  - Verify: unit tests for the listed tests, and the Property 4 and Property 5 property tests. Also re-run the Property 36 test (8.2) with this Base VaR calculation in place of its stand-in, to confirm that unrelated risk calculations still complete during provider failures.
  - Tests: AT-VAR-03, AT-VAR-07, AT-VAR-13, AT-VAR-14, AT-VAR-15, AT-VAR-16, AT-VAR-17, AT-VAR-18
  - Properties: Property 4, Property 5
  - Rules: FR-4, FR-5, FR-7, FR-12
  - _Requirements: 14.1, 14.2, 14.3, 14.5, 14.6, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 11.5_

- [ ] 12.3 Implement the Base VaR configuration gate and validity policy
  - Outcome: `RiskInputBuilder` returns `CONFIG_MISSING` with keys when a Base VaR setting is missing. It does this before loading data. It also checks for FX, market-data, and position preconditions. `ResultValidityPolicy` derives `baseValidity` and `adjustedValidity` separately. Earlier results are retained as `LAST_VALID`. `MARKET_DATA_STALE` makes the result `STALE`. FX (R30.8, R30.11):
    - Only `FxRateUsed` values (`OBSERVED` or `IDENTITY`) enter `RiskInput`; `FX_UNAVAILABLE` and `FX_STALE` make both figures unavailable with the affected currencies; a `StaleFxRate` (including `lastValid`) never enters a calculation.
    - Any result that used a `DEMO` FX rate or `DEMO` price history carries `DEMO_DATA`, is labelled DEMO, is never presented as a valid production result, and is never evaluated for VaR alerts.
    - In production mode, any required `DEMO` FX rate gives `FX_DEMO_NOT_ALLOWED` with both figures unavailable and the affected currencies listed. This rule waits for OD-19 (how production mode is determined).
  - Implementation note: `src/app/riskInputBuilder.ts`, `src/risk/validity.ts`, `src/app/riskService.ts` (append-only `risk_results`). A missing price is `INSUFFICIENT_DATA` with reason `PRICE_UNAVAILABLE`, and a price in another currency is `INSUFFICIENT_DATA` with reason `PRICE_CURRENCY_MISMATCH`, both reported together when both occur: `priceIssues` lists each category in the fixed order `PRICE_UNAVAILABLE`, `PRICE_CURRENCY_MISMATCH` with its own sorted tickers, `tickers` is their sorted union, and `reason` is the first entry's reason (R13.2; no price converted). Every outcome, including a precondition failure, is appended to `risk_results`; earlier rows are never updated or deleted; history comes through the `RiskHistorySource` port with an explicitly chosen source kind. `FX_DEMO_NOT_ALLOWED` is not implemented (OD-19).
  - Depends on: 12.2, 3.2
  - Blocked by: OD-19 for the production-mode rule only (AT-FX-11). Everything else, including `DEMO_DATA`, proceeds.
  - Done when: a missing Base VaR key gives `CONFIG_MISSING`, both figures `null`, and both validities `UNAVAILABLE`, with the earlier result kept as `LAST_VALID`; a stale as-of date is never `CURRENT`; a result with a DEMO FX rate or DEMO price history is always flagged `DEMO_DATA` and never alerts.
  - Verify: AT-MD-13, AT-MD-16, AT-FX-10; AT-FX-11 once OD-19 is resolved.
  - Tests: AT-MD-13, AT-MD-16, AT-FX-10, AT-FX-11 (blocked by OD-19)
  - Properties: none
  - _Requirements: 13.4, 13.5, 13.7, 14.14, 30.8, 30.11_

- [ ] 12.4 Implement the compiled risk worker and the recalculation scheduler
  - Outcome:
    - The worker starts from compiled `dist/risk/riskWorker.js` via `new URL('./riskWorker.js', import.meta.url)`. JSON with decimal strings crosses the thread boundary.
    - A crash is audited and the worker is restarted.
    - `RiskScheduler` coalesces requests (one running, one queued per portfolio) and reacts to `PositionsChanged` (the event type from 6.2, delivered through the event bus adapter behind `PositionEventPublisher`) and `PriceUpdated` using `recalc.minValueChangePct`.
    - Price-update trigger (approved; R16.2, AT-DSH-08), all arithmetic in Decimal.js:
      - Baseline: the per-position base-currency market values `valueBase[k]` (signed quantity x market price x FX rate, FR-4) and the NAV of the last successfully stored risk snapshot of the portfolio.
      - Cumulative change: `changePct = (sum over k of |currentValueBase[k] - valueBase[k]|) / |baselineNAV| * 100`, where `currentValueBase[k]` uses the latest valid price received since the baseline (unchanged positions contribute 0). Absolute per-position differences are summed, so opposite movements never cancel.
      - Threshold: recalculation is requested when `changePct >= recalc.minValueChangePct` (inclusive). Below the threshold, valuation is updated only.
      - Baseline NAV <= 0: the percentage is not calculated; every valid price update that affects a non-flat position requests recalculation.
      - Requests from price updates are coalesced like every other request (one running, one queued per portfolio).
      - The baseline advances only after a successful calculation whose result and snapshot were stored; a precondition result, an engine failure, or a commit failure leaves it unchanged, so changes keep accumulating.
      - Only a valid price update counts: a validated quote in the position's currency for a non-flat position. Invalid, mismatched, or stale-display prices never count and never move the baseline.
  - Implementation note: worker `src/risk/riskWorker.ts` and client `src/app/riskWorkerClient.ts` (crash audit and restart), scheduler `src/app/riskScheduler.ts` (coalescing, `PositionsChanged`). Not done: the price-update trigger and AT-DSH-08. The rule is now specified above, but no `PriceUpdated` event exists yet.
  - Depends on: 12.3, 1.1, 5.2, 6.2
  - Blocked by: the `PriceUpdated` event contract and the deferred composition root (event bus adapter), for the price-update trigger and AT-DSH-08 only. Neither the event nor an adapter is created in this task. Everything else in 12.4 is done.
  - Done when: an integration test starts the compiled worker without a TypeScript loader; a burst of requests yields at most two runs; sub-threshold price changes update valuation only, a change exactly at the threshold requests recalculation, opposite movements do not cancel, a baseline NAV <= 0 requests recalculation for every valid price update of a non-flat position, and a failed calculation does not advance the baseline.
  - Verify: AT-ARC-03 (worker part), AT-DSH-07, AT-DSH-08 (blocked as above).
  - Tests: AT-ARC-03, AT-DSH-07, AT-DSH-08
  - Properties: none
  - _Requirements: 16.1, 16.2, 16.3, 16.6, 16.7, 23.4, 26.8, 33.9_

- [ ] 12.5 Implement the snapshot service and reproducibility
  - Outcome: `SnapshotService.create` builds the full snapshot, computes `inputsCanonical` without `displayOnly`, the timestamp, and generated ids, hashes it, and persists `calc_snapshots` with a non-unique hash index. `recompute` reloads series by hash and reruns the engine.
  - Implementation note: `src/app/snapshotService.ts` and the `calc_snapshots` port (in-memory). The body also holds cash, base currency, `minObservations`, `maxReturnGapDays`, `adjustmentConfigMissing`, `marketDataStale`, and per-position `valueBase`/`fxPair`/`historySourceKind`, so `recompute` needs only the snapshot and the series store (design: Snapshot Service, implementation).
  - Depends on: 12.2, 2.3, 9.4, 5.1
  - Done when: recomputing from a stored snapshot reproduces the stored figures as identical strings; any input or configuration change changes the hash or version.
  - Verify: unit tests for the listed tests, and the base part of the Property 24 property test.
  - Tests: AT-REP-01, AT-REP-02, AT-REP-03, AT-REP-04, AT-REP-06, AT-REP-07, AT-REP-08, AT-REP-10, AT-FX-05, AT-AUD-04
  - Properties: Property 24
  - _Requirements: 32.1, 32.2, 32.4, 32.5, 32.6, 22.4, 22.5, 30.10_

- [ ] 12.6 Add the risk and snapshot routes
  - Outcome: `GET /portfolios/:id/risk` returns Base and Adjusted VaR as separate `VarEntry` objects (validity, value or `null`, status, reason, last valid); `GET /portfolios/:id/snapshots/:hash`.
  - Implementation note: `src/api/routes/risk.ts` with contracts in `src/shared/apiContracts/risk.ts`; 404 when no result or snapshot exists.
  - Depends on: 12.3, 12.5, 4.2
  - Done when: an unavailable figure is `null` with its status and reason; no response contains a JSON number for a financial value.
  - Verify: integration tests with `inject()` (API part of AT-DSH-15, completed in 17.3).
  - Tests: none
  - Properties: none
  - _Requirements: 14.10, 14.12, 17.10, 22.5_

- [ ] 12.7 Add the VaR timing benchmark
  - Outcome: a benchmark for 50 and 500 instruments with 250 scenarios (3 warm-up and 20 measured runs, nearest-rank p95), recording the environment.
  - Implementation note: `test/bench/varEngine.bench.test.ts` via `npm run bench:var`; the fixture has no adjustment settings, so the timed scope is Base VaR plus the 14.1 eligibility gate (the adjusted scenario P&L is not timed); records in the gitignored `bench-results/`.
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
  - Implementation note: `src/sentiment/observation.ts` (strict schema, exact value text, no clamping, `observedAt` normalized to UTC milliseconds without rounding), `provider.ts` (port with one-attempt `fetchLatest`, fixture provider), `poller.ts` (`ResilientCall`, per-message validation, `run` every `pollSeconds`). Rejections are audited by `src/app/sentimentAudit.ts` (`VALIDATION`/`SENTIMENT_REJECTED`, provider and reason only), because `sentiment/` may not import `audit/`.
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
  - Implementation note: the transport-independent rules (deduplication, out-of-order observations as history, future-dated rejection) are implemented in `src/sentiment/state.ts` with 13.3 and tested there (AT-SEN-19, AT-SEN-20). The subscription logic is `src/sentiment/stream.ts` (`StreamTransport` port; reconnect delay `min(max, initial * 2^(attempt - 1))` with optional full jitter, `GAVE_UP` after `maxAttempts` consecutive failures; `BoundedQueue` keyed by provider and ticker, an older arrival goes straight to the state as history, drops logged once per minute). The concrete transport is `src/adapters/ws/sentimentWsTransport.ts` on `ws@8.22.2` (`wss://` only, `rejectUnauthorized: true`, no CA option, required `maxPayloadBytes` and `handshakeTimeoutMs`, no compression, no redirects); `@types/ws@8.18.2` is a pinned dev dependency for strict types. The decoder is injected; the real vendor message format waits for 13.8 (OD-13). Integration tests run a local `wss://` server whose test certificate is trusted only inside the test process.
  - Depends on: 13.1, 2.4
  - Done when: a flood never exceeds the queue bound; duplicates change state once; older observations never overwrite newer state.
  - Verify: integration tests against a local WSS server, and the Property 29 and Property 30 property tests.
  - Tests: AT-PRV-04, AT-PRV-05, AT-PRV-06, AT-PRV-07, AT-SEN-19, AT-SEN-20, AT-SEN-23
  - Properties: Property 29, Property 30
  - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.8, 9.9, 24.8, 33.5_

- [ ] 13.3 Implement sentiment state and freshness
  - Outcome: per-ticker sentiment state with `FreshnessPolicy` (FR-8, `sentiment.maxAgeSeconds`). The last valid value is retained for display, labelled `STALE` with its timestamp, and never treated as current.
  - Implementation note: `src/sentiment/freshness.ts` and `state.ts`. The index comes from the injected aggregator (none approved, OD-1); its timestamp is the newest `REAL` observation inside the window (interim basis pending OD-1). The index is refreshed on every accepted observation, and the last valid index is retained and ages to `STALE`. History observations never enter the index. `forRisk` gives the engine entry, `undefined` when nothing was received (`ABSENT`).
  - Depends on: 13.1
  - Done when: under a fake clock, a value becomes `STALE` exactly when its age exceeds `maxAgeSeconds`; demo values are never `CURRENT` for adjustment.
  - Verify: unit tests, and the sentiment part of the Property 25 property test.
  - Tests: none
  - Properties: Property 25
  - Rules: FR-8
  - _Requirements: 10.4, 10.6, 15.13, 21.5_

- [ ] 13.4 Define the sentiment aggregator interface and contract tests
  - Outcome: `SentimentAggregator` interface with a `version` string, and a contract suite every implementation must pass: output in [-1, +1] or `null`, deterministic, Decimal only, `REAL` observations only, and `null` when no observation is in the window. No formula is implemented here.
  - Implementation note: interface `src/sentiment/aggregator.ts`; contract suite `test/contracts/sentimentAggregator.contract.ts`, run against `test/helpers/sentimentAggregatorDouble.ts` (latest `REAL` value in the window; tests only, not an OD-1 proposal).
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
  - Implementation note: `src/sentiment/emitter.ts`: drift-corrected ticks at `start + k * 3000` on the monotonic clock; a ticker is emitted when its view changed, including ageing to `STALE`; emit failures are reported and the schedule continues.
  - Depends on: 13.3, 13.4
  - Done when: over a simulated five-minute window with jittered provider arrivals, the p95 of the absolute deviation from 3,000 ms is at most 500 ms; nothing is emitted when nothing changed.
  - Verify: unit tests with a fake clock, and the Property 31 simulation.
  - Tests: AT-CAD-01, AT-CAD-02, AT-CAD-03, AT-CAD-04, AT-CAD-05, AT-CAD-06
  - Properties: Property 31
  - _Requirements: 10.5, 10.6, 10.8_

- [ ] 13.7 Add the sentiment handler timing benchmark
  - Outcome: per-message handler timing (3 warm-up and 20 measured runs, nearest-rank p95), recording the environment.
  - Implementation note: `test/bench/sentimentHandler.bench.test.ts` via `npm run bench:sentiment` (never part of `npm test`). Timed scope: decode, validation, normalization, queue, and state update of one message through `createSentimentStream`; records in the gitignored `bench-results/`.
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
  - Implementation note: `src/risk/adjustment.ts` (`evaluateEligibility`), wired into `src/risk/engine.ts`. Order per position: `ABSENT`, `INVALID`, `DEMO`, `UNAVAILABLE`, `STALE`. `RiskInputBuilder` gets sentiment through the optional `RiskSentimentSource` port (for example the 13.3 state) and validates every entry before it enters `RiskInput`. Two entries for one ticker are `INVALID_INPUT`.
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
  - Implementation note: `adjustScenarios` in `src/risk/adjustment.ts`. The algorithm version stays `hs-var-1`: Base VaR is unchanged, and an input without eligible sentiment gives exactly the earlier result.
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
  - Blocked by: the event contract and the deferred composition root (no `SentimentEligibilityChanged` event or event bus exists), as for the 12.4 price-update trigger. The calculation part holds already: a sentiment change leaves the Base VaR string unchanged (`test/unit/app/adjustedRisk.test.ts`).
  - Done when: a sentiment change produces a new result whose Base VaR string equals the previous one.
  - Verify: AT-SEN-17, AT-SEN-25.
  - Tests: AT-SEN-17, AT-SEN-25
  - Properties: none
  - _Requirements: 15.9, 16.4_

- [ ] 14.4 Extend snapshots and reproducibility to Adjusted VaR
  - Outcome: snapshots record `adjustmentOutcome` and nullable adjustment parameters. `displayOnly` filing scores are stored but excluded from the hash. Recompute reproduces the Adjusted figure or its `null` status.
  - Implementation note: the snapshot body's `sentiment` now holds the engine's sentiment entries (sorted by ticker), stored results carry triggered assets, and `recompute` passes the stored sentiment back to the engine. Schema version 1 is kept: the `sentiment` field was part of the first snapshot shape.
  - Depends on: 14.2, 12.5
  - Done when: identical inputs reproduce identical Adjusted strings; changing only `displayOnly` filing scores leaves the hash unchanged.
  - Verify: AT-REP-02 (adjusted case), AT-REP-09, and the adjusted part of the Property 24 property test.
  - Tests: AT-REP-02, AT-REP-09
  - Properties: Property 24
  - _Requirements: 32.1, 32.2, 32.4_

- [ ] 14.5 Verify filing independence on the risk side
  - Outcome: property tests vary `FilingRiskScore` fixtures (the phase 1 type) and assert that `RiskResult`, triggered assets, and the snapshot hash are identical. A type test asserts `RiskInput` has no filing field. Invalid sentiment and filing scores cannot enter `RiskInput`.
  - Implementation note: `test/property/filingIndependence.property.test.ts`. An invalid sentiment value from the port is replaced by an `UNAVAILABLE` entry without a value before the engine runs, so it is reported as `UNAVAILABLE`, not `INVALID`; the engine keeps its own `INVALID` gate for direct inputs.
  - Depends on: 14.2, 2.6, 1.4
  - Done when: Property 11 (risk side) passes; injecting an invalid score into the input builder is rejected before the engine runs.
  - Verify: AT-FIL-01, AT-FIL-02, AT-FIL-03, AT-VAL-01, and the Property 11 and Property 17 property tests.
  - Tests: AT-FIL-01, AT-FIL-02, AT-FIL-03, AT-VAL-01
  - Properties: Property 11, Property 17
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 15.14, 21.4, 27.9_

- [ ] 15. WebSocket gateway

- [ ] 15.1 Implement the `/stream` WebSocket gateway
  - Outcome: a Fastify WebSocket route on the loopback-bound server. It pushes Zod-validated `SentimentUpdate`, `RiskUpdate`, and `ProviderStatus` events from the shared contract, with decimal strings only, and a bounded send buffer per client.
  - Implementation note: `src/api/routes/stream.ts` (`streamRoutes`, `@fastify/websocket@11.3.7` registered in its own encapsulated plugin), hub `src/api/streamHub.ts`, contract `src/shared/apiContracts/stream.ts` (`StreamEventSchema`, also `AlertRaised` for 16.3), event builders `src/app/streamEvents.ts`. The upgrade passes the gateway hooks first (correlation id, rate limit: one token per connection attempt, `AuthGuard`), then: `Origin` must exactly match a caller-supplied `allowedOrigins` entry (403 `ORIGIN_FORBIDDEN`, also when absent); strict empty query and params (400); at most `maxClients` connections (503 `STREAM_CAPACITY`). Clients may not send: any message closes with 1008, frames above 1,024 bytes with 1009; no compression. Each event is validated before sending; a client whose unsent bytes plus the next event exceed `maxBufferedBytes` is terminated (nothing is queued in the hub); an event above that limit is refused. `allowedOrigins`, `maxClients`, and `maxBufferedBytes` are caller options with no configuration key, like the listening host and port. `FilingScoreUpdate` is not in the contract until the filing pipeline exists. Wiring to the emitter and scheduler waits for the composition root.
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
  - Implementation note: `src/alerts/settings.ts` and `evaluator.ts` (pure). Settings are explicit per-portfolio inputs (`thresholdPct`, `metric`, `resetPct`, both severity ratios, `cooldownSeconds`) with no defaults in the module; a missing or invalid one gives `ALERT_CONFIG_MISSING` with the keys (the same range rules as the configuration schema). Checks run in the order settings, selected figure `CURRENT`, `NAV > 0`; a skip carries its reason (`ALERT_CONFIG_MISSING`, `FIGURE_NOT_CURRENT` with the entry's validity and status, `NAV_NOT_POSITIVE`, or `FIGURE_INVALID`). With `ADJUSTED` the Base entry is never read. Severity bands are tested exactly as `percentOfNav >= ratio * thresholdPct`. Skips are audited as `ALERT` / `ALERT_SKIPPED` by `src/app/alertService.ts`. No production threshold exists (OD-6).
  - Depends on: 12.3, 14.1, 3.2
  - Blocked by: OD-6 for production threshold values only. Tests supply explicit thresholds.
  - Done when: equality never alerts; an unavailable Adjusted VaR with the `ADJUSTED` metric never alerts even when Base VaR exceeds the threshold.
  - Verify: unit tests for the listed tests, and the Property 34 property test.
  - Tests: AT-ALR-07, AT-ALR-08, AT-ALR-09, AT-ALR-13, AT-ALR-14, AT-ALR-15, AT-ALR-18
  - Properties: Property 34
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 34.2_

- [ ] 16.2 Implement the alert state machine
  - Outcome: a persisted `alert_state` per key (type, portfolio, asset), implementing the design's state machine. One alert per crossing, escalation alerts, and re-arming only after the reset threshold and cooldown. Unavailable figures never advance the state.
  - Implementation note: pure transitions in `src/alerts/stateMachine.ts`; persistence port `AlertStateRepo` (`alert_state`) with the in-memory implementation; `src/app/alertService.ts` reads and writes the state in the same unit of work as the alert and its audit entry (`ALERT_RAISED`, `ALERT_SUPPRESSED`). Between the reset level and the threshold a breach stays `BREACHED`. In `REARMING`, a breach within the cooldown is suppressed unless its severity is above the last alert's. A skipped evaluation never reads or writes the state. A persistence failure returns `COMMIT_FAILED` and never throws into the calculation.
  - Depends on: 16.1, 5.1
  - Done when: model-based property tests over metric sequences pass, and a restart does not re-fire an open breach.
  - Verify: unit tests for the listed tests, and the Property 32 property test.
  - Tests: AT-ALR-01, AT-ALR-02, AT-ALR-03, AT-ALR-04
  - Properties: Property 32
  - _Requirements: 34.1, 34.5, 34.6_

- [ ] 16.3 Implement the alert outbox, dispatcher, and alert routes
  - Outcome: the alert is persisted before publishing. The outbox dispatcher publishes to the event bus and the `/stream` gateway, retrying with backoff up to `alerts.delivery.maxRetries` and then marking `FAILED`. The dashboard de-duplicates by alert id. Routes `GET /alerts` and `POST /alerts/:id/dismiss`; dismissal preserves history.
  - Implementation note: the `alerts` table (`AlertRepo`) is the outbox: an alert is inserted with `delivery = PENDING` in the evaluation's unit of work, and the dispatcher (`src/app/alertDispatcher.ts`) is notified only after the commit. It publishes the shared `AlertRaised` event to injected `AlertPublisher`s only (`streamAlertPublisher(hub)` in `src/api/streamHub.ts`; the event-bus adapter and the composition root are not part of this task). Each attempt is persisted before publishing; a retry publishes only to publishers that have not accepted the alert, with the same id; waits are `min(maxBackoffMs, initialBackoffMs * 2^(retry - 1))` and an attempt has a timeout (both caller options; no configuration key). After `1 + maxRetries` attempts the alert is `FAILED`, logged with id and attempt count, and audited as `ALERT_DELIVERY_FAILED`. Content fields never change after insertion and status fields never move backwards; there is no delete. Routes `src/api/routes/alerts.ts`: `GET /alerts?portfolioId=` (required, newest first) and `POST /alerts/:id/dismiss` (empty JSON body; 404 unknown, 409 `ALERT_NOT_OPEN`).
  - Depends on: 16.2, 15.1
  - Done when: an injected publish failure never stops calculations; retries create one dashboard entry; payloads contain every R19.2 field.
  - Verify: unit tests for the listed tests, and the Property 33 fault-injection test.
  - Tests: AT-ALR-05, AT-ALR-10, AT-ALR-11, AT-ALR-12, AT-ALR-17
  - Properties: Property 33
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 34.7, 34.8_

- [ ] 17. View models and dashboard

- [ ] 17.1 Implement the view model builder with signal separation
  - Outcome: `PortfolioRiskView` and `AssetRiskRow`, with separate `VarEntry` objects for Base and Adjusted VaR and the explanation text (APPLIED, NONE_TRIGGERED, or the unavailable reason). Separate sentiment and filing fields with no combined field. `riskContribution: null` shown as "not available" (OD-10). Each `AssetRiskRow` carries the price and provenance fields defined in the design's [View models](design.md#view-models-signal-separation) from the 11.1 and 11.5 results, without recomputing them:
    - `currency`, `marketPrice`, and `marketValueBase`, each `null` with `valuationStatus` when unavailable, never `"0"`;
    - `priceProvenance`, the quote used (`asOf`, `source`, `sourceKind`, `retrievedAt`), or `null`;
    - `lastValidPrice`, the display-only 11.5 `StalePriceDisplay` (`LAST_VALID`, `STALE`, canonical price, `asOf`, `retrievedAt`, `source`, `sourceKind`). It is non-null only for an eligible `PRICE_UNAVAILABLE` and never feeds any figure in the view.
  - Implementation note: `src/app/riskViewBuilder.ts` (`buildPortfolioRiskView`, pure) with the contract `src/shared/apiContracts/views.ts` (`PortfolioRiskViewSchema`, types from `z.infer`). Inputs: the stored risk view, `RiskService.adjustmentDetail` (triggered assets and ineligible tickers of the latest result, added for this task), the positions and allocation responses, and the 13.3 sentiment view. Differences from the design sketch: exposure figures are grouped with an `exposure.status` and are `null` when exposure is unavailable; `VarView.reason` also carries the fixed reason `code`; sentiment carries its display `basis` (`INDEX` or `LATEST_OBSERVATION`) and `sourceKind` is `null` without an observation; rows also carry `signedQuantity`, and `adjustment` carries the multiplier. Filing is `UNAVAILABLE` with a `null` score, date, and source kind for every asset: the builder has no filing input until the filing pipeline exists, so the "high filing risk" half of AT-FIL-04 waits for phase 7. Hackathon wiring (DR-KW-1): the builder is wired to the read-only routes `GET /dashboard` and `GET /dashboard/portfolios/:id` (`app/dashboardService.ts`, `api/routes/dashboard.ts`, contract `shared/apiContracts/dashboard.ts`), which add the per-currency FX summary, currency exposure, FR-14 display text, the H7 OD-1 reason (`sentimentAggregation`, `AGGREGATION_NOT_APPROVED_EXPLANATION`), and `filing: NOT_CONFIGURED`. Tests: `test/unit/app/dashboardService.test.ts`, `test/property/currencyExposure.property.test.ts`, the H7 cases in `test/unit/app/riskViewBuilder.test.ts`, and the route cases in `test/unit/main/demoMultiCurrency.test.ts`.
  - Depends on: 12.6, 14.2, 11.4, 11.5
  - Done when: a type test proves no field derives from both sentiment and filing; high filing risk with bullish sentiment produces both values unchanged.
  - Verify: unit tests, and the Property 12 static and example tests.
  - Tests: AT-FIL-04
  - Properties: Property 12
  - _Requirements: 11.6, 11.7, 17.1, 17.2, 17.3, 17.4, 17.6, 17.7, 17.8, 17.9, 17.10, 35.2, 35.3, 35.6_

- [ ] 17.2 Scaffold the React and Vite dashboard
  - Outcome: `src/web/` as a separate Vite build with its own strict `tsconfig`. Design tokens from `ui-guidelines.md` as CSS variables. `chartAdapter.ts` is the only `toChartNumber` caller. Imports only the shared API contract types. Included in lint, `deps:check`, and CI.
  - Depends on: 1.4, 4.2
  - Implementation note (hackathon scope, DR-KW-1):
    - React 19 and Vite 8, exact pins, as dev dependencies; the web bundle is built, not served by the backend.
    - `vite.web.config.ts` builds `src/web/` into `dist/web/` with a relative `base`; `npm run build` now runs both builds, so CI covers it unchanged. `npm run typecheck` also checks `src/web/tsconfig.json` and `test/web/tsconfig.json`.
    - Design tokens are in `src/web/styles.css`.
    - `web/` may import only `src/shared/apiContracts/index.ts` (dependency-cruiser `web-not-to-domain`; the generic index rule excludes `web/`). ESLint forbids native-number parsing, `Math`, and `decimal.js` there.
    - No chart exists yet, so there is no `chartAdapter.ts`.
    - A `web` Vitest project runs in jsdom, with `axe-core` for automated accessibility checks.
  - Done when: `deps:check` fails if `web/` imports a domain module; ESLint fails if any other file calls `toChartNumber`; the Vite build succeeds in CI.
  - Verify: AT-DEC-06 (re-run for `web/`), and the boundary checks from 1.4.
  - Tests: AT-DEC-06
  - Properties: none
  - _Requirements: 4.4, 23.4, 26.2, 26.9_

- [ ] 17.3 Build the dashboard panels and status presentation
  - Outcome: the top bar and four separate panels in the specified order (Base VaR, Sentiment-Adjusted VaR, Market Sentiment, SEC Filing Risk), plus positions and allocation, exposures, and alerts:
    - Text status badges.
    - Scale captions.
    - Money rounding per FR-14, and allocation display to two decimals. 17.3 owns this formatting: the canonical API value `"33.3"` is shown as `"33.30%"`. That is padding only; the dashboard never re-rounds or recalculates percentages (design: Allocation rule 5, AT-ALC-11).
    - An "Unavailable" Adjusted panel with its reason, never showing the Base figure; `LAST_VALID` figures only when labelled.
    - VaR described as a percentile estimate, never as drawdown.
    - For ECB-derived FX rates (R30.14): `Source: ECB statistics.`, the derived-value note, and the information-purposes note. This part waits for 10.2 (OD-5); the rest of 17.3 does not. Hackathon scope (DR-KW-1, H2): the data part is delivered as `fxRate.attribution` in the positions response; only its display remains.
  - Implementation note (hackathon scope, DR-KW-1):
    - Layout: the top bar (data mode, run mode, source with recording time, NAV, as-of, calculation time, backend freshness summary, manual reload), the four panels in order, the portfolio overview with exposures, currency exposure, positions with padded allocation, and the FX table with published-or-derived attribution, reference date, convention, precision, and the R30.14 notes.
    - Money is shown as the backend `display` text, and other values exactly as received; `—` replaces a missing value, never zero.
    - Loading, error (with retry), invalid-data, stale, and unavailable states are covered.
    - Not done: the alerts list (alerts are not configured in the demo), charts, the stream subscription (17.4), and Playwright (17.5).
    - Tests: `test/web/dashboard.test.tsx` and `test/web/dataSource.test.tsx`, plus the recorded-response compatibility case in `test/unit/main/demoMultiCurrency.test.ts`.
  - Depends on: 17.1, 17.2, 15.1
  - Blocked by: OD-5 for the ECB attribution part only (AT-FX-18).
  - Done when: component tests cover each listed test, and no unavailable value renders as a number or zero.
  - Verify: component tests with Vitest. AT-DSH-15 is verified across the API (12.6) and the UI. AT-FX-18 once OD-5 is resolved as ECB.
  - Tests: AT-DSH-01, AT-DSH-02, AT-DSH-03, AT-DSH-09, AT-DSH-10, AT-DSH-11, AT-DSH-12, AT-DSH-13, AT-DSH-14, AT-DSH-15, AT-ALC-11, AT-FX-18 (blocked by OD-5)
  - Properties: none
  - Rules: FR-14
  - _Requirements: 14.13, 17.1, 17.2, 17.3, 17.4, 17.7, 17.9, 17.10, 18.6, 20.7, 30.14, 35.1, 35.4, 35.5, 35.6, 35.7_

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
  - Implementation note (hackathon scope, DR-KW-1 H4 and OD-21):
    - `@playwright/test` 1.65.0 (exact pin), Chromium only, `playwright.config.ts`, and `test/e2e/dashboard.spec.ts` (8 tests).
    - The tests run against the BUILT dashboard with the exported deterministic replay, served under `/spectral-risk-chimera/` by `scripts/serve-pages.mjs` (read-only, with GitHub Pages path semantics). There is no backend and no network beyond 127.0.0.1.
    - Covered:
      - recorded values for both portfolios (Base VaR 124.10 EUR and 140.18 EUR);
      - panel order and separation, with the OD-1 explanation;
      - DEMO and recorded-replay labels;
      - published versus derived ECB values;
      - stale and unavailable FX, through a test-only intercepted variant;
      - SEC not configured;
      - loading, missing, and invalid replay states;
      - deep links, back, forward, refresh, and the subpath without its trailing slash;
      - every asset loading;
      - GET-only same-origin requests with no backend route;
      - no console errors and no failed requests.
    - Runs in the CI `e2e` job and before every Pages deployment.
    - Not covered, because the hackathon has no write path: the outcome's live-API scenario (CSV import, sentiment supply, and alert update), which needs a backend (alerts are not configured in the demo).
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
  - Implementation note: `src/ingestion/fix/tokenizer.ts` (`tokenizeFix`, byte-level and synchronous), `mapping.ts` (`FIX_MAPPING_TABLE`, frozen and empty while OD-9 is open; nothing reads it), `quarantine.ts` (`fixQuarantineRecords`: `FIX` rows, `FIX_MALFORMED`, a fixed message per detail code, the tag as `columnName`). Checks: 8, 9, 35 as the first three fields; tags of 1 to 9 digits without a leading zero; non-empty printable ASCII values up to `import.maxFieldLength`; 8, 9, 35 not repeated; BodyLength in bytes; CheckSum of three digits over the bytes before `10=`, counting each `|` as SOH for `|` logs; at most 512 fields. After a failure the tokenizer resynchronises at the next `8=` at a line start or after a delimiter. File limits reuse `import.maxFileBytes` and `import.maxRows`. Excerpts are bounded (512 / 64) and replace the tag 1 (Account) value with `[REDACTED]`; the parsed field list still holds it for 18.2, which must not store it. Not wired into the import service (18.2).
  - Depends on: 7.5
  - Done when: unit tests on synthetic messages cover the delimiters, body length, and checksum failures. No AT-FIX test is claimed, because the supported set is not approved.
  - Verify: unit tests.
  - Tests: none
  - Properties: none
  - _Requirements: 2.1, 2.4, 28.10_

- [ ] 18.2 (Blocked) Implement the approved FIX message mapping
  - Outcome: the BeginString, message types, `ExecType` values, and tag mapping approved in OD-9, documented in `docs/fix-mapping.md`. Rejection reasons `FIX_UNSUPPORTED_MSG_TYPE`, `FIX_MISSING_TAG`, and `FIX_INVALID_VALUE`. Deduplication by `ExecID`. Accepted transactions carry `sourceId` (`"FIX:" + fileSha256`) and `sourceSequence` (the message sequence) per R28.18. FIX `Account` values are never stored and are redacted.
  - Depends on: 18.1
  - Blocked by: OD-9
  - Done when: AT-FIX-01 to AT-FIX-06 pass on recorded sample logs, and Properties 18, 19, and 20 pass for FIX input.
  - Verify: the listed tests, and the FIX parts of the Property 18, 19, and 20 property tests.
  - Tests: AT-FIX-01, AT-FIX-02, AT-FIX-03, AT-FIX-04, AT-FIX-05, AT-FIX-06
  - Properties: Property 18, Property 19, Property 20
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 28.10, 28.11, 28.12, 28.18, 29.12, 27.2_

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
  - Outcome (design: [URL Guard and Client](design.md#url-guard-and-client)):
    - `src/sec/ports.ts`: the `SecDnsResolver` port (one DNS family per call) and the `SecurityEventSink` port. `sec/` imports only `shared/` and `config/`, never `audit/` or persistence.
    - `src/sec/addressPolicy.ts`: the fixed address policy `iana-special-purpose-2025-10-09` (IANA IPv4 and IPv6 Special-Purpose Address Registries, Last Updated 2025-10-09; RFC 5771 multicast; IPv6 only in `2000::/3`), with every block listed in the design, including the explicitly prohibited globally reachable blocks (AS112, AMT, anycast).
    - `src/sec/urlGuard.ts`: `SecUrlGuard.validate`, which checks in the fixed order `MALFORMED_URL`, `NOT_HTTPS`, `CREDENTIALS_PRESENT`, `IP_LITERAL`, `HOST_NOT_ALLOWED` (exact match after IDNA to ASCII; trailing dot rejected; no suffix or substring match), `PORT_NOT_ALLOWED`, `FRAGMENT_PRESENT`. And `resolveAndCheck`, which resolves both families, applies the family rules (`DNS_EMPTY`, `DNS_FAILED`) and the address policy (`ADDRESS_PROHIBITED`), and returns every validated address.
    - Every rejection calls `SecurityEventSink.record` once with no part of the input URL and reports `RECORDED` or `DELIVERY_FAILED`; the rejection stands either way.
    - Not in scope: the app-layer `SecurityEventSink` implementation (audit with category `SECURITY`), see [Deferred work](#deferred-work); the production DNS adapter and connection pinning (19.2).
  - Depends on: 2.4, 2.5
  - Done when: every listed test passes with a stubbed DNS resolver and a recording `SecurityEventSink` fake; every rejection emits exactly one security event containing no part of the input URL; a failing or throwing sink still yields the rejection with `DELIVERY_FAILED`; the implementation's address list equals the design table, and the first and last address of every block are rejected; dependency-cruiser passes with `sec/` importing only `shared/` and `config/`.
  - Verify: unit tests for the listed tests, and the URL and address part of the Property 27 property test over generated URLs (the redirect part is in 19.2).
  - Tests: AT-SEC-01, AT-SEC-02, AT-SEC-03, AT-SEC-04, AT-SEC-05, AT-SEC-06, AT-SEC-07, AT-SEC-08, AT-SEC-09, AT-SEC-28, AT-SEC-29, AT-SEC-30, AT-SEC-31
  - Properties: Property 27
  - _Requirements: 29.8, 29.9, 29.11, 29.14_

- [ ] 19.2 Implement the guarded SEC client
  - Outcome (design: [URL Guard and Client](design.md#url-guard-and-client)); `getText` and the transport only:
    - `SecClient.getText` in `src/sec/`, using an injected `SecTransport` port. `sec/` still imports only `shared/` and `config/`.
    - Connects only to an address returned by `resolveAndCheck`: the connection's lookup returns only the validated addresses, so the transport never resolves the hostname itself. The normalized allowlisted hostname is kept for TLS certificate verification, SNI, and the `Host` header (no DNS rebinding, no uncontrolled re-resolution). Connection reuse is disabled.
    - Production Node.js HTTPS `SecTransport` and `SecDnsResolver` adapters in `src/adapters/` (the DNS adapter maps resolver results to `RECORDS`, `NO_DATA`, `NOT_FOUND`, or `ERROR` per family). Certificate verification is never disabled.
    - `User-Agent` from `SEC_USER_AGENT`; retrieval refuses to start if it is unset. No cookies and no `Authorization` header are sent or forwarded.
    - A shared rate limiter at `sec.maxRequestsPerSecond`.
    - Manual redirects: every hop is validated and resolved again, up to `sec.maxRedirects`.
    - One overall deadline (`sec.timeoutMs`) across redirects, retries, rate-limit waits, and body streaming. Retries go through `ResilientCall` (8.2), keeping its 429 and 5xx classifications and the `provider.retryAfter.maxMs` limit.
    - No compression (`Accept-Encoding: identity`); the streamed body is limited to `sec.maxResponseBytes`.
    - Errors and security events never contain a requested URL.
    - Not in scope: `SecClient.getJson` (19.3, blocked by OD-16 through 8.4); the app-layer `SecurityEventSink`; the composition root.
  - Depends on: 19.1, 8.2, 3.4
  - Done when: local integration servers, reached through the injected transport seam with fake public DNS results, show that every listed test behaves as specified; no request reaches a rejected target; the production address policy is unchanged and has no test bypass.
  - Verify: integration tests for the listed tests, and the redirect part of the Property 27 property test.
  - Tests: AT-SEC-10, AT-SEC-11, AT-SEC-12, AT-SEC-13, AT-SEC-14, AT-SEC-15, AT-SEC-16, AT-SEC-17
  - Properties: Property 27
  - _Requirements: 6.6, 6.7, 6.8, 29.10, 33.6, 25.2_

- [ ] 19.3 (Blocked) Implement `SecClient.getJson`
  - Outcome: `SecClient.getJson` fetches through `getText` (19.2) and parses every SEC JSON body with the lossless JSON parser from 8.4 (through `losslessJson.ts`) before Zod validation, never with `JSON.parse` (financial-rules rule 3, design D-5).
  - Depends on: 19.2, 8.4
  - Blocked by: OD-16 (through 8.4)
  - Done when: SEC JSON bodies are parsed losslessly and validated with Zod; a malformed body gives an error without a value; `JSON.parse` is not used.
  - Verify: unit tests against recorded SEC JSON bodies.
  - Tests: none beyond 19.2 and 20.1
  - Properties: none
  - _Requirements: 6.8, 4.6_

- [ ] 20. Filing location and Item 1A extraction

- [ ] 20.1 Implement the filing locator and record SEC fixtures
  - Outcome: ticker-to-CIK resolution from the SEC company ticker file. The company ticker file (`company_tickers.json`) and the submissions JSON (`data.sec.gov/submissions/CIK##########.json`) are both read through `SecClient.getJson`, parsed with the lossless JSON parser from 8.4, and validated with Zod; recorded fixtures are parsed the same way. Selection of the latest 10-K or 10-Q, and construction of the document URL. Recorded fixtures for one company's ticker file entry, submissions JSON, and 10-K and 10-Q documents, captured once with a placeholder contact and committed without personal data.
  - Depends on: 19.3, 8.4
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
  - Outcome (design: [NLP port and FilingRiskScore](design.md#nlp-port-and-filingriskscore)):
    - `src/shared/analysisText.ts`: runtime-distinguishable `FilingText` and `SentimentText`; `AnalysisMethodName` and `AnalysisMethodVersion` schemas in `src/shared/schemas.ts`.
    - `src/nlp/ports.ts`: the `FilingNlpProvider` port (`analyzeFiling(text: FilingText, signal): Promise<AttemptOutcome<unknown>>`) and `FilingAnalysisSchema` (branded `FilingRiskScore` in [0, 1], unique categories, bounded method and version).
    - `src/nlp/filingAnalyzer.ts`: one `ResilientCall` run per analysis with `nlp.timeoutMs` and `nlp.maxRetries`; output validated inside the attempt (invalid output is non-retryable `INVALID_RESPONSE`, never clamped); public failure `NLP_FAILED` with a typed `cause`; `mode`, `sourceKind`, and `analyzedAt` set by the analyzer from the injected `Clock`; separate identities `nlp-filing:real:<name>` and `nlp-filing:fallback`.
    - `src/nlp/fallbackProvider.ts`: `FallbackNlpProvider`, the fixed demo placeholder (score `"0"`, no categories, method `fallback-placeholder`, version `1`), always `FALLBACK` / `DEMO`.
    - `src/sentiment/ports.ts`: the `SentimentTextProvider` port and `SentimentTextAnalysisSchema`, declared only (implementation and wiring in 13.x).
    - dependency-cruiser rules `filing-text-not-to-sentiment` and `sentiment-text-not-to-filing`.
    - Not in scope: chunking and `nlp.maxInputChars` (21.2, OD-15); the `NLP_FAILED` audit entry (21.3 or the app layer); real NLP adapters and their payload parsing (OD-16 for JSON).
  - Depends on: 2.6, 8.2
    - Logging privacy: provider exceptions are replaced by a contentless error and every run uses the `ResilientCall` option `exceptionLogging: 'METADATA_ONLY'` (default `FULL` keeps 8.2 behaviour for other providers); the method `fallback-placeholder` is reserved for `FallbackNlpProvider`.
  - Done when: fallback output is never labelled genuine; a timeout stores no score; a test proves the separation of inputs; invalid provider output is rejected unchanged and never retried; no filing text, provider exception, or sensitive value appears in captured logs; a REAL provider cannot claim the fallback method.
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
    - `FilingScoreRecord` values (the stored record; `FilingRiskScore` stays the branded decimal type): scores in [0, 1] with categories, method and version, provider, mode, source URL, and analysis timestamp.
    - An audit entry for every `NLP_FAILED` from the analyzer (21.1 returns the error; `nlp/` cannot import `audit/`).
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
  - Outcome: `neutralizeCsvCell(cell)` in `src/shared/csvCell.ts`, exported through `src/shared/index.ts`, for use by any CSV export. It prefixes with a single quote every cell starting with `=`, `+`, `-`, `@`, TAB, or CR, except a negative cell that fully matches the `DecimalStringSchema` grammar (decimal exception) and a cell already starting with `'` (R29.7). Per-cell only: no quoting, escaping, trimming, or look-alike mapping. No export feature is added, because none is specified.
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
  - Implementation note: `test/soak/sentiment.soak.test.ts` via `npm run soak` (`vitest.soak.config.ts`; `SOAK_DURATION_MS`, default 300,000) and the workflow `.github/workflows/soak.yml` (weekly schedule and manual dispatch, pinned actions, Node.js 24.22.1). The cadence run uses real timers and the 13.6 emitter; the flood run checks that the queue never exceeds `ws.maxQueueSize` and that every message is accounted for (`sunk + coalesced + dropped = sent`). Results go to the gitignored `bench-results/`; the CI records are not reviewed yet.
  - Depends on: 13.6, 13.2
  - Done when: the cadence soak reports a p95 deviation of 500 ms or less, and the flood run shows a bounded queue and an accurate dropped counter.
  - Verify: AT-CAD-07, and a soak re-run of AT-PRV-07.
  - Tests: AT-CAD-07, AT-PRV-07
  - Properties: none
  - _Requirements: 10.5, 33.5_

- [ ] 25.3 Add the dependency audit gate
  - Outcome: `npm audit` on every change in CI, with a documented review step for findings; exact pins and the lockfile are re-checked. Approved decisions: a CI-only `dependency-audit` job runs `npm audit --audit-level=high` over all dependencies including dev dependencies (high and critical fail; lower severities are reported); `SECURITY.md` documents finding review and exceptions, each needing explicit approval, a justification, and an expiry, and never suppressing a finding or bypassing CI; an offline CI step and AT-ARC-05 verify exact pins and lockfile integrity (root maps match `package.json`, direct dependencies locked at their pins, an integrity hash on every package), with seeded range and stale-lockfile cases; local `npm test` stays offline.
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
| 6.2 | 5.1, 2.1, 2.3, 2.4, 2.5 | None |
| 7.1 | 2.6, 3.2 | None |
| 7.2 | 7.1 | None |
| 7.3 | 7.2, 5.1, 6.2 | None |
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
| 10.2 | 10.1, 10.4, 8.2, 3.2 | 8.4 (OD-16) only if OD-5 is resolved to a provider that delivers JSON; none on the proposed ECB CSV route |
| 10.3 | 10.1, 10.4, 5.1 | None |
| 10.4 | 10.1 | None |
| 11.1 | 6.2, 8.2, 9.1, 10.1 | None |
| 11.2 | 11.1 | None |
| 11.3 | 11.2 | None |
| 11.4 | 11.3, 4.2, 6.1 | None |
| 11.5 | 11.1, 11.4, 8.2 | None |
| 12.1 | 2.1 | None |
| 12.2 | 12.1, 9.3, 11.1 | None |
| 12.3 | 12.2, 3.2 | None |
| 12.4 | 12.3, 1.1, 5.2, 6.2 | None |
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
| 17.1 | 12.6, 14.2, 11.4, 11.5 | None |
| 17.2 | 1.4, 4.2 | None |
| 17.3 | 17.1, 17.2, 15.1 | None |
| 17.4 | 17.3 | None |
| 17.5 | 17.3, 16.3, 7.5 | None |
| 17.6 | 17.2, 3.5 | None |
| 18.1 | 7.5 | None |
| 18.2 | 18.1 | None |
| 18.3 | 18.2 | None |
| 19.1 | 2.4, 2.5 | None |
| 19.2 | 19.1, 8.2, 3.4 | None |
| 19.3 | 19.2, 8.4 | None |
| 20.1 | 19.3, 8.4 | None |
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
    { "id": 10, "tasks": ["7.3", "7.7", "9.2", "9.4", "9.6", "10.4", "11.1", "13.2", "13.3", "17.6", "19.3", "21.2"] },
    { "id": 11, "tasks": ["7.4", "9.3", "9.5", "10.2", "10.3", "11.2", "13.4", "13.7", "13.8", "20.1"] },
    { "id": 12, "tasks": ["7.5", "11.3", "12.2", "13.5", "13.6", "20.2"] },
    { "id": 13, "tasks": ["7.6", "11.4", "12.3", "12.5", "12.7", "18.1", "21.3", "25.2"] },
    { "id": 14, "tasks": ["11.5", "12.4", "12.6", "14.1", "18.2", "21.4"] },
    { "id": 15, "tasks": ["14.2", "15.1", "16.1", "18.3"] },
    { "id": 16, "tasks": ["14.3", "14.4", "14.5", "16.2", "17.1", "23.1"] },
    { "id": 17, "tasks": ["16.3", "17.3", "22.1"] },
    { "id": 18, "tasks": ["17.4", "17.5", "22.2"] },
    { "id": 19, "tasks": ["25.1"] }
  ]
}
```
