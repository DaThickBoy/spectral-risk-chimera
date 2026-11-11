# Kiroween Kiro evidence

These three examples pair short quotations from the owner-supplied `Kiro conversation.md` with repository evidence. The [transcript index](kiro-transcript-index.md) identifies the relevant prompts, tool records, and responses. Test results below are historical results recorded in the transcript.

## 1. ECB provenance and deterministic replay

> Do not call live ECB or other external providers during the replay export.

Owner prompt, T140, line 61009. The owner approved an additive SQLite migration, compatibility with older rows, and a fixed-clock export of both portfolios. Kiro implemented the published-quote provenance and wrote the replay exporter and tests. Kiro reported that two exports were byte-identical and eight local Playwright checks passed. The owner approved exact canonical decimal storage in T141, line 62326. The ECB response itself remains a separate, unmodified replay file.

- **Repository evidence** — [SQLite schema](../../src/persistence/sqlite/schema.ts), [FX provenance test](../../test/integration/fxProvenancePersistence.test.ts), [replay exporter](../../src/main/replayExport.ts), and [replay test](../../test/unit/main/replayExport.test.ts).
- **Commits** — [SQLite schema](https://github.com/DaThickBoy/spectral-risk-chimera/commit/4f1b6dc), [FX provenance round trip](https://github.com/DaThickBoy/spectral-risk-chimera/commit/37c5056), [replay exporter](https://github.com/DaThickBoy/spectral-risk-chimera/commit/bc9d1a0), and [Pages workflow and browser tests](https://github.com/DaThickBoy/spectral-risk-chimera/commit/f78085e).

## 2. Decimal.js Type 7 quantile and independent reference

> Implement Task 12.1 only. Read the existing FR-7, Property 3, design and task specifications first.

Owner prompt, T49, line 17625. The owner requested bounded quantile implementation and unit and property tests. Kiro wrote the quantile and a property test that compares the result with independent BigInt-fraction arithmetic. The later T125 batch integrated the quantile into the scenario engine. The current engine test contains a hand-calculated two-asset Base VaR of `20.025`.

- **Repository evidence** — [quantile](../../src/risk/quantile.ts), [known-answer quantile test](../../test/unit/risk/quantile.test.ts), [independent property test](../../test/property/quantile.property.test.ts), and [engine test](../../test/unit/risk/engine.test.ts).
- **Commit** — [Historical-simulation VaR engine and tests](https://github.com/DaThickBoy/spectral-risk-chimera/commit/5cf495a).

## 3. Signed-zero histogram CI regression

> Add a focused regression test using the exact reported "-0" / "0" inputs.

Owner prompt, T193, line 90981. The owner supplied the CI counterexample and limited the fix to bucket indexing. Kiro normalized signed-zero bucket indices and added a unit regression and a deterministic fast-check replay with seed `-2078451211` and path `253:3:3`. Kiro recorded both tests failing when the old guard was restored and passing with the fix.

- **Repository evidence** — [histogram guard](../../src/risk/histogram.ts), [unit regression](../../test/unit/risk/histogram.test.ts), and [seeded property test](../../test/property/lossHistogram.property.test.ts).
- **Commit** — [Three-file signed-zero fix](https://github.com/DaThickBoy/spectral-risk-chimera/commit/1d0c159).
