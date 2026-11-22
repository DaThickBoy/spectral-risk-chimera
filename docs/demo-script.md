# Kiroween demo video — revised storyboard

Target cut **2:35–2:45**, under the three-minute limit. Narration below is **303 words**: at 125 wpm that is ~2:25 of speech, at 130 wpm ~2:20. The storyboard slots sum to 2:38, so holds and transitions are already inside the slots — do not add pauses on top of them. Pacing notes: the FX segment (1:15–1:42) is the tightest at 124 wpm with a mid-segment cut to mobile; rehearse it first and trim words there before slowing anywhere else. Segments 0:00–0:15 and 1:42–2:14 run at ~124 wpm with under a second of slack — speak them at a steady clip or extend the slot by 2–3 s (total budget allows up to 2:45). Rehearse the timed cut; the finished video must stay under 3:00.

## What to record, and where

Record the **public site** (<https://dathickboy.github.io/spectral-risk-chimera/>), signed out, no local backend. The deployed release (merge `df0ea19`, 2026-11-22) passed signed-out acceptance; see [release verification](evidence/release-verification.md). Keep **Recorded Replay · Not live** and the demo notice in frame throughout. Recheck every figure against the live public replay before the final cut.

Desktop capture at 1440×900 or larger, normal zoom. For the mobile FX shot, cut to a separate 390×844 capture rather than shrinking the desktop recording. Use short zoom-ins only for exact numbers; hold the source quote and inverse long enough to read. Captions on; no background music unless licensed.

Use prepared cuts for the Kiro evidence shots (spec file, quantile property test, signed-zero commit). Show existing repository files; do not run builds or provider requests on camera. The public app performs **no live CSV ingestion and no live risk calculation** — it serves a recorded replay. Do not imply otherwise.

## Storyboard

| Time | Route, action, framing | Narration |
| ---- | -------------------- | --------- |
| 0:00–0:15 | Overview, full desktop frame, `demo-eur-usd-gbp`. Replay status, NAV, Base VaR visible. Callout: "Where did this number come from?" | "A risk number is easy to show. Proving where it came from is harder. Spectral Risk Chimera lets you trace the number back through the records, rates, and scenarios behind it." |
| 0:15–0:35 | Overview. Hold on **22,375.74 EUR** and **124.10 EUR**. Briefly open the replay disclosure, then close it. | "This recorded portfolio is worth twenty-two thousand three hundred seventy-five euros and seventy-four cents. Its Base VaR, a loss threshold from historical simulation, is one hundred twenty-four euros and ten cents — an estimate, not a guaranteed limit." |
| 0:35–0:57 | Risk Analytics. Hover a bucket, select it, open **Exact values and bucket table**. Frame the marker label and exceedance count together. | "Two hundred fifty historical scenarios form this distribution. Thirteen exceeded the VaR marker. The orange bucket contains the marker, so its count includes losses below the threshold. Exceedances and bucket counts are different numbers, kept separate." |
| 0:57–1:15 | Portfolio. Show allocation, scroll to signed positions, sort by base value. Callout: "Trade records → ledger → holdings." | "Portfolio shows the holdings behind the risk. CSV trade records feed an auditable ledger; the dashboard shows signed positions, cash, and allocation. The chart helps you scan; the table is where you check the numbers." |
| 1:15–1:42 | FX & Provenance. Show the lineage, then cut to **390 px** mobile with USD expanded. Frame **Derived**, **EUR→USD 1.1165**, and the exact inverse together. | "Here is the Frankenstein connection: the ledger supplies positions, the European Central Bank supplies reference quotes, and historical scenarios supply the losses. The ECB published one point one one six five dollars per euro. To value a dollar position in euros, the app uses the derived inverse — showing both values, the method, and the rounding." |
| 1:42–1:58 | Risk Signals. Open Adjusted VaR details; show **Not configured** for filing risk. | "Not every signal becomes a number. Sentiment is demo data with no approved aggregation method, so there is no Adjusted VaR. Filing risk is not configured. These states are explicit, not silently zero." |
| 1:58–2:14 | Return to Overview. Switch to `demo-eur-only`; hold **14,025.44 EUR / 140.18 EUR**. Keep replay status in frame. | "The euro-only portfolio changes the holdings and the risk result. Both public portfolios are recorded replays, not live feeds. The browser serves inspectable responses with no backend, so anyone can reproduce this walkthrough." |
| 2:14–2:38 | Cut to prepared Kiro evidence: `.kiro/specs/tasks.md` (quantile task), then `test/property/quantile.property.test.ts`, then the signed-zero commit diff. Return to Overview with the public link on screen. | "Kiro turned the financial rules into specs and testable tasks: it implemented the quantile against an independent reference and reproduced a signed-zero histogram failure from a CI counterexample. One place to inspect how trades, rates, and scenarios become a risk number." |

**Total narration: 303 words.** Slot sum 2:38. At 125 wpm the speech is ~2:25, leaving ~13 s across the eight slots for clicks and holds; at 130 wpm, ~18 s. Estimated finished runtime 2:35–2:45. The tightest segments are 0:00–0:15, 1:15–1:42, 1:42–1:58, and 1:58–2:14 (~124 wpm required); the two table/inspection segments (0:35–0:57, 2:14–2:38) carry the slack.

## Kiro evidence verification

The three Kiro contributions shown are verified against repository artifacts:

1. **Type 7 quantile** — `src/risk/quantile.ts` and `test/property/quantile.property.test.ts` exist at the deployed merge; the property test uses an independent BigInt-fraction reference. Linked in [kiro-usage.md](kiro-usage.md).
2. **Signed-zero histogram regression** — commit `1d0c159` ("fix(risk): normalize negative-zero histogram indices") modifies `src/risk/histogram.ts`, `test/unit/risk/histogram.test.ts`, and `test/property/lossHistogram.property.test.ts`. Verified present in the repository.
3. **ECB provenance and replay exporter** — `test/integration/fxProvenancePersistence.test.ts` and `src/main/replayExport.ts` exist at the deployed merge.

**Owner-only confirmation required:** The Kiro attribution (which tool performed which task) is recorded in the owner-supplied transcript, not in commit metadata. The owner must confirm the phase split and approve any transcript excerpts before publication. The repository artifacts prove the code exists; they do not independently prove which AI tool wrote it.

## Post-production checklist

- [ ] Runtime ≤ 2:45 including cuts and end card; under 3:00 hard limit.
- [ ] All figures match the live public replay at recording time.
- [ ] **Recorded Replay · Not live** visible in every dashboard shot.
- [ ] No claim of live CSV ingestion or live risk calculation on the public app.
- [ ] Kiro evidence shots show real repository files, not mockups.
- [ ] Owner has confirmed Kiro attribution and approved transcript excerpts.
- [ ] Published as **Public** on YouTube; plays signed out.
- [ ] No unlicensed music, footage, or third-party marks.
