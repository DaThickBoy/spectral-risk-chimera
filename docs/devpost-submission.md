# Kiroween 2026 Devpost submission draft

## Tagline

Follow a portfolio risk figure from its ledger inputs to its scenario losses.

## Project description

Spectral Risk Chimera starts with a practical question: **where did this portfolio risk number come from?**

For analysts and technical reviewers, evaluating a figure means understanding the holdings, exchange rates, and assumptions behind it. Spectral Risk Chimera puts that evidence in one workflow.

Validated CSV transactions enter a ledger. The backend rebuilds positions, values them in a base currency, and applies aligned asset-price returns to estimate portfolio loss scenarios. Published ECB quotes remain visible beside the derived rates used for conversion. Calculation snapshots support recomputation, and a static recorded replay lets reviewers inspect the results in a browser.

In the multi-currency example, Base VaR is **124.10 EUR**. **Thirteen of 250 scenarios** exceed the raw quantile marker. The orange bucket containing the marker includes losses below it, and its count has a different meaning. The dashboard also shows holding values, allocation, cash, and currency exposure.

The Frankenstein integration connects trade ingestion, central-bank FX provenance, scenario analysis, and reproducible presentation. Each stage provides evidence for understanding the final figure.

The replay uses synthetic prices and histories, a fixed reference clock, and a recorded ECB response. Base VaR models one-day asset-price changes with FX held fixed. Synthetic sentiment does not affect risk. Adjusted VaR remains unavailable pending the aggregation decision, and SEC filing analysis is unconfigured.

The public link has not been verified against the current candidate. The five-view dashboard has passed local validation and awaits owner-approved release and subsequent signed-out verification. Until then, the public site and the current branch are not claimed to match.

## Technical overview

The backend uses strict TypeScript, Zod validation, and Decimal.js arithmetic at 40 significant digits. Financial values use decimal strings at API and storage boundaries. The lossless JSON parser preserves numeric tokens as text for validation.

CSV ingestion validates, quarantines, and deduplicates records. After commit, the position service rebuilds positions from the ledger. The FX service preserves the recorded ECB quote and labels the inverse used for conversion as derived.

The risk engine applies aligned adjusted-close simple returns to current signed exposures. The demo configuration uses a one-day horizon, 95% confidence, a target of 250 returns with a minimum of 200, and the Hyndman–Fan type 7 quantile. FX stays fixed across scenarios. SQLite stores calculation snapshots for recomputation.

React presents the backend results, with chart calculations limited to display geometry. GitHub Pages serves responses captured from the backend with a fixed clock and recorded inputs — static files only, no public backend. The replay manifest includes hashes for each view and the ECB recording. The standalone backend runs in the supported loopback demo configuration. At the audited baseline (`75ce8d6`, 2026-11-21), typecheck, lint, format, module-boundary checks, 3794 Vitest tests (1 skipped), and 49 Playwright browser tests against the built replay all pass.

## How this maps to the judging criteria

- **Potential Impact** — Risk figures are only useful if they can be defended. Exact decimal arithmetic, published-versus-derived FX provenance, visible staleness, and explicit unavailability address failure modes that erode trust in real risk reporting.
- **Technological Implementation** — Strict TypeScript end to end; Zod-validated boundaries; Decimal.js at 40 significant digits with an independent BigInt-fraction property test for the quantile; append-only SQLite ledger with trigger enforcement; a deterministic, hash-manifested replay pipeline with byte-identical re-exports. Local release validation: 3,814 unit/component/integration tests passed, one existing skip, and 66 Chromium tests passed.
- **Design** — A calm fintech dashboard (light canvas, deep navy chart surfaces) that leads with the answer and keeps the evidence one click away: methodology disclosure, exact-value tables, labelled demo data, and a validated, colour-vision-safe chart palette with numbered badges so colour is never the only cue.
- **Innovation / Idea** — The Frankenstein stitching is the idea: trade CSV → persisted ledger → published ECB quote → derived inverse → historical scenarios → explainable VaR, with each stage's provenance preserved end to end and reproducible as a static public replay. Spec-first development with Kiro kept the financial rules reviewable before code existed.
- **Presentation** — A sub-three-minute video that walks the lineage from NAV to the 13-of-250 exceedances, a public demo anyone can open signed out with no setup, and honest, visible limitations instead of silent fallbacks.

## Development attribution

The foundation was built spec-first with Kiro: requirements, design, tasks, steering, and decision records, all tracked in the repository, with a [Kiro write-up](kiro-usage.md) and an [evidence packet](evidence/kiro-evidence.md) linking three concrete contributions to owner-supplied transcript excerpts and commits. Later phases used other AI assistance: Codex (independent review, the earlier dark-theme redesign, license-notice remediation, testing) and Claude Code (the current light-theme redesign and release-readiness documentation). The full Kiro transcript is owner-supplied and kept outside the repository; excerpts are shared only with owner approval, and none are fabricated. Commit metadata does not record tool attribution; the owner confirms the phase split.

## Submission fields

- **Project name** — Spectral Risk Chimera
- **Category** — Frankenstein
- **Repository** — [DaThickBoy/spectral-risk-chimera](https://github.com/DaThickBoy/spectral-risk-chimera)
- **Application** — [Spectral Risk Chimera replay](https://dathickboy.github.io/spectral-risk-chimera/)
- **License** — [MIT](../LICENSE)
- **Video** — pending owner-provided public YouTube URL (none exists yet)
- **Kiro write-up** — [draft](kiro-usage.md), pending owner confirmation of transcript-excerpt sharing
- **Deadline** — reported as December 4, 2026, 2:00 p.m. PST; verify against the official rules before submitting

See the [recording script](demo-script.md) and [final checklist](submission-checklist.md) before entering the final URLs.
