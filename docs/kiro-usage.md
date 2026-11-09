# How Kiro was used

This write-up describes how Spectral Risk Chimera was built with Kiro for Kiroween 2026 (category: Frankenstein). It covers only what is visible in this repository. It gives no usage statistics, and it does not claim the code is correct because an agent wrote it. Correctness is backed by tests, static checks, and human review, all described below.

## What is in `.kiro/`

| Path                                | Contents                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.kiro/specs/requirements.md`       | Numbered requirements (R1 onwards) with acceptance criteria, a Configuration table that marks each setting as financially significant (F) or operational (O), Assumptions and Constraints, and an **Open Decisions** register (OD-1 onwards) |
| `.kiro/specs/design.md`             | Architecture, module boundaries, design decisions (D-*), data models, and the numbered correctness properties that the property-based tests are named after                                                                                  |
| `.kiro/specs/tasks.md`              | The implementation plan, split into phases and numbered tasks that trace back to requirements                                                                                                                                                |
| `.kiro/steering/financial-rules.md` | Permanent rules for financial code: Decimal.js only, decimal strings at every boundary, no silent zeros, Zod validation, separation of filing risk and sentiment, mandatory unit and property tests                                          |
| `.kiro/steering/architecture.md`    | TypeScript and ESM settings, module dependency rules, ports and injected clock, configuration without defaults for financial settings, no hardcoded credentials                                                                              |
| `.kiro/steering/ui-guidelines.md`   | Dashboard rules: dark design tokens, tabular numbers with units, four separate risk panels, status badges, no calculations in components, accessibility                                                                                      |

No agent hooks, MCP servers, or custom agents are configured in this repository. The committed `.kiro/` directory contains only `specs/` and `steering/`.

## Spec-driven development

The project started from a spec, not from code. Requirements, design, and tasks were written and reviewed in Kiro's spec workflow before implementation began, and they were updated whenever an implementation slice changed the contract.

- **Requirements first.** Each feature has acceptance criteria written as testable statements. Examples: Adjusted VaR is `null`, never a copy of Base VaR, when no eligible sentiment exists (R15.8); and the dashboard shows Base VaR, Adjusted VaR, Market Sentiment, and SEC Filing Risk as four separate panels (R35.1).
- **Open decisions stay open.** Anything that needed a human decision went into the Open Decisions register with an interim position, rather than being guessed in code. For example, OD-1 (how to aggregate sentiment) is still open. That is why the demo shows Adjusted VaR as **Unavailable** with the reason, rather than inventing an aggregation formula.
- **Design properties map to tests.** The correctness properties in `design.md` (for example "adjusted loss is never below base loss" and "filing score changes never change VaR") are implemented as fast-check property tests in `test/property/`, named after their headings.

## Steering rules as guardrails

The three steering files are loaded into every Kiro session. In practice they acted as a standing code review checklist:

- **Financial rules.** These kept every monetary value in Decimal.js, with canonical strings at API, database, and log boundaries. They also forbid `JSON.parse` on provider payloads (a lossless parser is used instead), defaults or zeros for missing financial data, and any combined "filing plus sentiment" score.
- **Architecture rules.** These defined the module boundaries that dependency-cruiser enforces in `npm run deps:check`. Examples: `risk/` never imports `sec/` or `nlp/`, `portfolio/` stays pure, and `web/` only sees the shared API contracts.
- **UI rules.** These made the dashboard render backend text only, show `—` with a status badge instead of `0`, and label every demo value.

When a task appeared to conflict with a steering rule, the instruction was to stop and ask rather than work around it. Several of the human decisions below came from exactly that.

## Incremental slices with full verification

Work was done in small, reviewable slices that followed `tasks.md`. Hackathon examples: the ECB FX adapter; the demo configuration and seeded portfolios; the dashboard; the persistence of published ECB rates (OD-20); the replay exporter and the GitHub Pages workflow; and the Playwright browser tests.

Each slice ended with the same local verification before it was reported:

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run deps:check`
- `npm test` (unit, property, integration, and dashboard tests)
- `npm run build`

Later slices also ran `npm run export:replay` twice (and compared the outputs byte for byte), `npm run test:e2e`, `npm audit`, and `git diff --check`. A slice was not called done while any step failed.

## Tests, and checking that the tests can fail

Kiro generated most of the test code: hand-calculated known-answer cases, boundary cases (for example sentiment `-0.60` versus `-0.6001`, and 199 versus 200 observations), and property tests with reference implementations that use integer or rational arithmetic instead of Decimal.js.

A passing test only matters if it would fail on a wrong implementation. So for important rules, the review included **mutation checks**: a temporary PowerShell script deliberately broke the implementation (for example removing a guard or flipping a comparison), confirmed that the relevant tests failed, and then restored the file and removed the script. This found tests that passed for the wrong reason, and those tests were tightened.

## Reconciling contracts and architecture

Because the spec, the steering rules, and the code were all in the repository, Kiro could check them against each other. These are examples where that surfaced a real conflict that a person then resolved:

- **Panel order.** The dashboard sketch in `design.md` listed the four panels in a different order from R35.1 and `ui-guidelines.md`. The implementation follows R35.1, and the design records the earlier order as superseded, so the requirements stay the single source.
- **Exact text versus canonical text.** The OD-20 work needed to store the published ECB rate beside the derived inverse rate. Storing the value "exactly as received" would have conflicted with financial-rules rule 6, which allows verbatim decimal text only for the price-series exception (C2). The conflict was raised instead of worked around. The approved result stores canonical decimal text, which is numerically exact. Every recorded ECB value is already canonical.
- **Module boundaries.** Composition, recording, and the replay exporter were placed in `app/` and `main/`, so the domain modules stay free of persistence and transport code. dependency-cruiser checks this on every run.

## Human approval of financial decisions

Kiro proposed options and trade-offs. A person made every financially significant decision, and each one is recorded in `requirements.md`. Examples:

- **OD-12:** SQLite through `node:sqlite` as the persistence technology, with its transaction semantics.
- **DR-KW-1 (H1 to H8):** the hackathon scope. This covers the Frankenstein category, the ECB with a EUR base for the demo only, and the demo-only configuration values. It also covers static replay on GitHub Pages, DEMO mode only, the two seeded portfolios, Adjusted VaR shown as unavailable, and no SEC integration.
- **The five demo configuration values:** FX and market-data freshness limits, the return-gap limit, the recalculation threshold, and the oversell policy. They were approved for the demo only, after Kiro reported a concrete consequence: with a four-day FX freshness limit, ECB rates become stale over the Easter closure. That limitation is documented rather than hidden.
- **OD-20:** how the published ECB observation is persisted (nullable columns on `fx_rates`, canonical decimal text).
- **OD-21:** how the public replay is produced (recorded fixtures only, a fixed clock, and a GitHub Actions Pages workflow).

Decisions that are still open (for example OD-1 sentiment aggregation, OD-5 and OD-13 provider selection, OD-7 authentication, and OD-19 production mode) were deliberately left open. The code reports them as unavailable or refuses to start.

## Where Kiro accelerated the work

- Turning requirements into module skeletons, Zod schemas, ports, and fakes that already followed the steering rules.
- Writing large amounts of test code, including property tests and their reference implementations.
- Building the ECB adapter, the provenance plumbing through FX service, recorder, and API, and the replay exporter across many files, while keeping types and contracts consistent.
- Repeating the full verification after every slice and reading the failures, which kept regressions small.
- Keeping the spec in step with the code (requirements rows, design notes, and task notes).

## Where human judgment mattered

- **Choosing what not to build.** No sentiment formula, no SEC analysis, and no production mode. Each of these would have produced numbers nobody had approved.
- **Approving numbers.** Demo thresholds, the ECB as a demo source, and the representation of stored rates were human decisions, made with the trade-offs Kiro reported.
- **Honest labelling.** Insisting that DEMO data, derived FX rates, and recorded replays are labelled as such everywhere, including this documentation.
- **Reviewing the tests themselves.** Mutation checks and known-answer cases were used because a green test suite written by the same agent as the code is not proof of correctness on its own.
