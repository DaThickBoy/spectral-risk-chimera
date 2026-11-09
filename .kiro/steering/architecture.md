---
inclusion: always
---

# Architecture Rules

Project-wide rules for Spectral Risk Chimera. They follow `.kiro/specs/requirements.md` (R26, R27, Configuration) and `.kiro/specs/design.md`. Financial arithmetic rules live in `financial-rules.md` and apply on top of these. If a task conflicts with a rule here, stop and ask. Decisions marked Open in the requirements' Open Decisions table are not final; do not implement them as if they were.

## 1. Language, runtime, and build

- TypeScript with `"strict": true`, plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `exactOptionalPropertyTypes`.
- ES modules: `package.json` `"type": "module"`; `tsconfig.json` `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"verbatimModuleSyntax": true`. Use `import type` for type-only imports and `.js` extensions in relative imports.
- Node.js 24.22.1 is the development baseline (`engines` and `.nvmrc`). CI also runs Node.js 26. Both must pass.
- Compile with `tsc` into `dist/`. Runtime entry points, including `worker_threads` workers, are compiled `.js` files resolved with `new URL('./file.js', import.meta.url)`. No TypeScript loader at runtime.
- Toolchain: Zod 4, Decimal.js, Vitest, fast-check, ESLint with typescript-eslint, Prettier, dependency-cruiser, Playwright. React with Vite for `web/`. Fastify for `api/` (provisional).
- Pin every dependency to an exact version and commit the lockfile. Add a dependency only when a requirement needs it.
- No `any`. Use `unknown` at boundaries and narrow it with Zod. No `@ts-ignore`; use `@ts-expect-error` only with a reason, in tests.
- No non-null assertions (`!`) in domain code. Handle the missing case.

## 2. Module boundaries

Code lives in these modules under `src/`. Each has one responsibility.

| Module | Responsibility | May import |
|---|---|---|
| `shared/` | Decimal helper, canonical JSON, lossless JSON, clock, sleeper, errors, `Result`, redaction, provider resilience (`ResilientCall`, `ProviderError`, circuit breaker), data status and last-valid store | nothing project-internal |
| `config/` | Zod config schema, loader, config version | `shared` |
| `audit/` | Append-only audit log | `shared`, `persistence` ports |
| `ingestion/` | CSV and FIX parsing, normalization, dedupe, quarantine | `shared`, `config`, `audit`, `portfolio` types, `persistence` ports |
| `portfolio/` | Ledger, positions, allocation, exposure | `shared`, `config` |
| `marketdata/`, `fx/` | Price series, returns, alignment, FX rates | `shared`, `config`, own ports |
| `sec/`, `nlp/` | EDGAR retrieval, Item 1A extraction, filing scores | `shared`, `config`, own ports |
| `sentiment/` | REST and WebSocket ingestion, aggregation, emission | `shared`, `config`, own ports |
| `risk/` | VaR engine, adjustment, snapshots, scheduler, worker | `shared`, `config`, `portfolio`, `marketdata`, `fx`, `sentiment` types |
| `alerts/` | Evaluation, state machine, dispatch | `shared`, `config`, `risk` and `sec` result types |
| `app/` | Use-case services that coordinate domain logic, persistence ports, and outbound ports (for example `PositionEventPublisher`); owns post-commit event publication | `shared`, `config`, domain modules (through `index.ts`), `persistence` ports |
| `persistence/`, `adapters/` | Database and external provider implementations | the ports they implement |
| `api/` | HTTP and WebSocket gateway, auth guard, view models | `app` services, shared API contracts |
| `web/` | Dashboard UI (separate Vite build) | shared API contract types and `toChartNumber` only |

Rules:
- Dependencies point inward. Domain modules never import `adapters/`, `persistence/` implementations, `app/`, `api/`, or `web/`.
- `portfolio/` is pure: it never imports persistence (ports or implementations) or the event bus. Reading the ledger, writing positions, and publishing `PositionsChanged` happen in `app/` (design D-16).
- `app/` never imports `persistence/` implementations, `adapters/`, `api/`, or `web/`. Concrete implementations are injected into it.
- Domain events are published by `app/` only after `UnitOfWork.run` has returned successfully, never from inside the unit-of-work callback. `UnitOfWork.run` is synchronous; never pass an `async` callback.
- A position rebuild reconciles all persisted positions of a portfolio against the complete ledger replay. Its upserts and deletes of orphaned positions happen in one unit of work. Only positions (a projection) have a delete operation; the transaction ledger and the audit log never do.
- The composition root (constructing concrete persistence, event-bus, logger, and clock implementations and injecting them into `app/` services) is deferred to a later application bootstrap task, which also decides its location and boundary rule. Until then, tests inject fakes.
- `risk/` must not import `sec/` or `nlp/`. `FilingRiskScore` never reaches the risk engine.
- `web/` never imports domain modules. It talks to the backend only through the API and WebSocket contracts.
- Import other modules through their `index.ts` public API, never their internal files.
- dependency-cruiser enforces these rules and fails the build on a violation (R26.10).

## 3. Modular, testable code

- Domain logic is pure where possible: explicit inputs, explicit outputs, no hidden I/O. The risk engine is a pure function of `RiskInput`.
- External systems sit behind interfaces (ports): market data, FX, sentiment, SEC, NLP, persistence, clock. Inject them; do not import a concrete client inside domain code.
- Use the `Clock` interface for all time. Never call `Date.now()` or `new Date()` directly in domain code. Waits and timeouts go through the injected `Sleeper`, and randomness (for example retry jitter) through an injected `random()`, so tests are deterministic.
- Provider calls go through `ResilientCall` (`shared/`). Concrete transports (HTTPS clients) live in `adapters/`, never in `shared/`. TLS certificate verification is always on: no code sets `rejectUnauthorized` to anything but `true`, sets a custom `ca` outside tests, or reads `NODE_TLS_REJECT_UNAUTHORIZED`.
- Return `Result<T, E>` with typed error codes from domain and adapter functions. Throw only for programmer errors.
- Keep functions small and single-purpose. A file over about 300 lines is a signal to split it.
- Every module has tests in `test/`. Use fakes for ports instead of network calls. Name each correctness property test after its `Property N` heading in the design.

## 4. No financial calculations in UI components

- UI components display values from view models. They do not add, subtract, multiply, divide, compare thresholds, compute percentages, VaR, P&L, allocations, or statuses.
- The backend computes and sends every displayed figure as a decimal string, including differences (for example `varDifference`) and status labels.
- The only allowed conversion in `web/` is `toChartNumber()` inside the chart adapter, for plotting.

```tsx
// CORRECT
<Metric label="Adjusted VaR (1d, 95%)" value={view.sentimentAdjustedVaR.absolute} unit={view.currency} />

// INCORRECT: calculation in a component
<Metric value={(Number(view.baseVaR) * 1.15).toFixed(2)} />
```

## 5. Explicit types and Zod 4 validation

- Every external boundary has a Zod schema: HTTP requests, WebSocket messages, uploaded rows, FIX fields, provider payloads, environment, configuration, and data read back from storage.
- Derive types with `z.infer`. Do not write a parallel hand-made type for the same shape.
- Exported functions declare explicit parameter and return types.
- Use discriminated unions for states and results (`status: 'OK' | 'INSUFFICIENT_DATA' | ...`), and handle every case with an exhaustive `switch`.
- Reject unknown fields in request and config schemas. Prefer `z.strictObject()`; the `.strict()` form used in `financial-rules.md` examples is equivalent and still supported in Zod 4. Use `z.iso.datetime()` rather than the deprecated `z.string().datetime()`. Use `z.partialRecord()` when an enum-keyed record may omit keys.
- Exception for persisted timestamps: any timestamp stored under the project's fixed UTC millisecond contract (`IsoUtc`, `YYYY-MM-DDTHH:mm:ss.sssZ`), or validated before it is stored (for example audit event times), must use the shared `IsoUtcMillis` schema (or `isIsoUtcMillis`) from `src/shared/timestamps.ts`, not `z.iso.datetime()`. It checks real calendar and clock values and rejects offsets, other precisions, and expanded years, so every boundary and persistence adapter accepts exactly the same form.
- Shared API contracts (request, response, WebSocket events) live in one place and are imported by both `api/` and `web/`.

## 6. Configuration

- Financially significant settings (class F in the requirements' Configuration table) have no `.default()` in code. A missing one is reported by key, nothing is substituted, and the dependent feature does not start.
- Operational settings (class O) may declare their documented default. Provisional defaults are reported as provisional at start.
- Approved baseline values (confidence 0.95, horizon 1, lookback 250, minimum 200, threshold -0.60, multiplier 1.15, alert metric `ADJUSTED`) are documented in `config/config.template.jsonc`. There is no setting that disables the downside adjustment. Values still open (OD-6, OD-1) stay as empty placeholders there.
- The template is never a runtime source. The loader reads only the file named by `SRC_CONFIG_FILE`, never opens or merges the template, and refuses a path that resolves to it. With no runtime file, every financially significant key counts as missing.
- A missing or invalid financially significant setting disables only the dependent feature. The application still starts. For VaR: a missing Base VaR setting gives `CONFIG_MISSING` and makes both figures `null`. A missing adjustment or sentiment setting gives `ADJUSTMENT_CONFIG_MISSING` and makes only Adjusted VaR `null`. The API returns Base and Adjusted VaR as separate entries, each with its own validity and reason. The dashboard shows each status as text, and no alert is evaluated from an unavailable figure.

## 7. No hardcoded credentials

- No API keys, tokens, passwords, private keys, or SEC contact details in source, tests, fixtures, or committed config.
- Read secrets and personal data (including `SEC_USER_AGENT`) from environment variables validated by an `EnvSchema`, or from a secrets manager. Keep `.env.example` with placeholders only.
- Secrets never enter `AppConfig`, snapshots, logs, error messages, API responses, or the frontend bundle.
- Pass all logs through the shared `redact()` helper.
- Tests use obvious fake values (for example `test-api-key`) and never real credentials.

## Checklist

- [ ] Strict TypeScript, ES modules (`NodeNext`, `verbatimModuleSyntax`), no `any`, no `@ts-ignore`.
- [ ] Built with `tsc` to `dist/`; workers start from compiled `.js`.
- [ ] Exact dependency pins and a committed lockfile.
- [ ] Imports respect module boundaries; `risk/` does not import `sec/` or `nlp/`; `portfolio/` imports no persistence or event bus; dependency-cruiser passes.
- [ ] External systems are behind injected ports; time comes from `Clock`.
- [ ] No financial calculations in `web/`.
- [ ] Every external input has a Zod 4 schema; types come from `z.infer`.
- [ ] No code defaults for financially significant settings.
- [ ] No credentials or personal contact details in code, tests, config, logs, or the frontend.
- [ ] Passes on Node.js 24.22.1 and Node.js 26.
