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

The dark redesign is a verified local build. The public link currently shows the earlier interface with the same recorded results.

## Technical overview

The backend uses strict TypeScript, Zod validation, and Decimal.js arithmetic at 40 significant digits. Financial values use decimal strings at API and storage boundaries. The lossless JSON parser preserves numeric tokens as text for validation.

CSV ingestion validates, quarantines, and deduplicates records. After commit, the position service rebuilds positions from the ledger. The FX service preserves the recorded ECB quote and labels the inverse used for conversion as derived.

The risk engine applies aligned adjusted-close simple returns to current signed exposures. The demo configuration uses a one-day horizon, 95% confidence, a target of 250 returns with a minimum of 200, and the Hyndman–Fan type 7 quantile. FX stays fixed across scenarios. SQLite stores calculation snapshots for recomputation.

React presents the backend results, with chart calculations limited to display geometry. GitHub Pages serves responses captured from the backend with a fixed clock and recorded inputs. The replay manifest includes hashes for each view and the ECB recording. The standalone backend runs in the supported loopback demo configuration.

## Development attribution

The repository documents the earlier Kiro-assisted foundation through requirements, design, tasks, steering, and decision records. Codex assisted the subsequent review, dashboard clarifications, dark redesign, targeted tests, and browser verification. See the [Kiro write-up](kiro-usage.md) for evidence and owner-confirmation items.

## Submission fields

- **Project name** — Spectral Risk Chimera
- **Category** — Frankenstein
- **Repository** — [DaThickBoy/spectral-risk-chimera](https://github.com/DaThickBoy/spectral-risk-chimera)
- **Application** — [Spectral Risk Chimera replay](https://dathickboy.github.io/spectral-risk-chimera/)
- **License** — [MIT](../LICENSE)
- **Video** — pending owner-provided public YouTube URL
- **Kiro write-up** — [draft](kiro-usage.md), pending confirmation of historical examples

See the [recording script](demo-script.md) and [final checklist](submission-checklist.md) before entering the final URLs.
