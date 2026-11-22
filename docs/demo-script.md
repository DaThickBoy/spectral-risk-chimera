# Kiroween demo video

Target cut **2:40–2:45**, under the three-minute limit. The narration below is **355 words**; at 130–140 words per minute that is roughly **2:32–2:44** of speech alone. This is an estimate. Rehearse the timed cut, speak toward the faster end, keep transitions tight, and trim narration as needed so the finished video is 2:45 or less.

## What to record, and where

Record the dashboard in the **local replay preview** of the release candidate (`npm run build && npm run export:replay && npm run serve:pages`, then open `http://127.0.0.1:4173/spectral-risk-chimera/`; see the [README](../README.md#recorded-replay-what-github-pages-serves)). Keep **Recorded Replay · Not live** and the demo notice in frame. Open the replay disclosure to show the source, recording timestamp, and details.

The [public site](https://dathickboy.github.io/spectral-risk-chimera/) has not been verified against the current candidate (see [release verification](evidence/release-verification.md)). Before publishing the video, the owner must approve the release and confirm the public URL shows the same version the video demonstrates. Do not present the local preview as the public site.

The five-view release candidate passed local validation. Recheck every figure against the actual replay before the final cut.

Use prepared cuts for the code, spec, and manifest shots. Show existing files; do not start a provider request or regenerate the replay on camera. The manifest identifies recorded files by SHA-256. Snapshot recomputation is a separate local-backend capability, not something the public replay does.

**Optional local-import insert.** If you show CSV import, record it only against the **local live demo backend** (`npm start -- --demo-fixtures`, see [README](../README.md#optional-import-a-csv-into-the-local-backend)), and label the shot clearly, e.g. an overlay reading "LOCAL demo backend — not the public replay". The dashboard UI is read-only; imports go through the API (`POST /portfolios/:id/imports`), so show the terminal command and the returned import summary, then the dashboard reflecting the change. If time is tight, cut this insert first — the replay already shows the seeded CSV lineage.

## Shot list and narration

### 0:00–0:14 — Problem framing

**Shot** — Cold open on the multi-currency overview with NAV and Base VaR visible. Overlay the project name and the Frankenstein category.

> Where did this portfolio risk figure come from? Spectral Risk Chimera lets a reviewer follow the holdings, currency conversion, and scenarios behind the number.

### 0:14–0:36 — Portfolio overview and recorded-demo transparency

**Shot** — Point to **Recorded Replay · Not live** and the demo notice, open the replay disclosure to show the timestamp and source, then show the portfolio selector, NAV, and the Base VaR tile with its methodology line (historical simulation, 95%, one day).

> This is a recorded demo at a fixed November sixth reference time, not live data; prices and histories are synthetic fixtures. The portfolio holds euro, dollar, and sterling instruments plus cash. Net asset value: twenty-two thousand, three hundred seventy-five euros and seventy-four cents. Base VaR: one hundred twenty-four euros and ten cents.

### 0:36–1:04 — Frankenstein data lineage

**Shot** — Prepared cut of the seed CSV construction in [demoPortfolios.ts](../src/main/demoPortfolios.ts) (the import use case runs on fixed CSV rows). Cut back to Positions and allocation, then to FX rates used: the published EUR→USD quote beside the derived inverse, labelled derived.

> The Frankenstein build stitches separate systems together. Holdings begin as validated CSV transactions in a persisted ledger. The recorded ECB quote is one point one one six five dollars per euro; its inverse converts dollar holdings into euros and is labeled derived, never published. Aligned historical returns become loss scenarios, and the scenarios become an explainable VaR. Every stage keeps its evidence.

### 1:04–1:30 — Loss-distribution inspection

**Shot** — The loss histogram: dashed raw-quantile marker, orange marker bucket with its text legend, the 13-of-250 exceedance summary. Open the exact-value disclosure table and scroll it briefly. Point out that the marker bucket's count (31) is not the exceedance count.

> Base VaR uses historical simulation at ninety-five percent confidence, a one-day asset-price horizon, FX held fixed. Twenty buckets hold two hundred fifty scenarios; thirteen exceed the raw quantile marker. The exact values are in this table, from the backend. The orange marker bucket also holds losses below the marker, so its count differs — the dashboard reports both.

### 1:30–1:48 — Honest limits

**Shot** — The Market Sentiment panel with DEMO OBSERVATION labels, Adjusted VaR marked unavailable with the OD-1 reason, SEC Filing Risk marked not configured.

> The limits stay visible. Sentiment values are labeled demo observations and do not affect risk. Adjusted VaR is unavailable: no aggregation method is approved. SEC filing analysis is not configured. Each panel explains itself instead of falling back to another number.

### 1:48–2:05 — Second portfolio and reproducible replay

**Shot** — Switch to `demo-eur-only`; show NAV 14025.44 EUR and Base VaR 140.18 EUR. Prepared cut of the local `dist/web/replay/manifest.json`: reference clock, DEMO mode, `live: false`, per-file SHA-256 hashes.

> A second, euro-only portfolio needs no FX. The replay manifest records the reference clock, demo mode, and a hash for every file; two exports from the same inputs are byte-identical. A reviewer can verify exactly what they are looking at.

### 2:05–2:28 — One authentic Kiro decision

**Shot** — The tracked `.kiro/specs/` and `.kiro/steering/` directories. Prepared cut of the signed-zero regression evidence: the [Kiro evidence packet, example 3](evidence/kiro-evidence.md#3-signed-zero-histogram-ci-regression) and commit `1d0c159`. Show only excerpts the owner has cleared for sharing; the full transcript is owner-supplied and kept outside the repository. If no excerpt is cleared, show the repository artifacts and the commit alone.

> The foundation was built spec-first with Kiro: requirements, design, tasks, and financial steering, tracked in the repository. One real example: CI caught a negative-zero histogram index. Kiro traced it, normalized the index, and added a regression test replaying the exact failing seed. Later dashboard and review work used other AI assistance, documented separately.

### 2:28–2:42 — Closing and honest future work

**Shot** — End card: project name, repository URL, application URL, MIT license, "Recorded DEMO replay". Start the closing line as the card appears; hold the card for the last second.

> Next: approved sentiment aggregation, live providers, production hardening — open decisions, not promises. Spectral Risk Chimera: follow the number from its inputs to its limits.

## Capture checklist

- [ ] Release candidate confirmed stable by the lead engineer; local replay rebuilt (`npm run build && npm run export:replay`) from the exact release commit.
- [ ] Every shown figure matches the actual replay: NAV 22375.74 / Base VaR 124.10 (`demo-eur-usd-gbp`), NAV 14025.44 / Base VaR 140.18 (`demo-eur-only`), 13 of 250 exceedances, published EUR→USD 1.1165, cash 1000.00 EUR.
- [ ] Keep the persistent replay status and demo notice in frame where possible; show the expanded replay disclosure in the opening shot.
- [ ] Any local-backend import shot carries the "LOCAL demo backend" overlay and is visually distinct from the replay.
- [ ] Kiro shot uses only owner-cleared excerpts or repository artifacts; no fabricated transcripts.
- [ ] Owner has approved the release; the public URL shows the same version as the video (see [release verification](evidence/release-verification.md)).
- [ ] Rehearse and time the finished cut, including transitions and the end card: 2:45 or less.
- [ ] Use only media you are authorized to include.
- [ ] Owner publishes the video as Public on YouTube, checks it signed out, and adds the URL to the Devpost form. No URL exists yet; do not invent one.
