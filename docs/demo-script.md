# Kiroween demo video

Target cut **2:40**. The narration has **309 words**. At 130–140 words per minute it takes about **2:12–2:23**, leaving **17–28 seconds** for pauses and transitions. This is an estimate. Rehearse the timed cut before publishing and trim it to 2:45 or less.

Use the verified dark dashboard in the local replay preview. Keep “Local preview · recorded DEMO replay” visible while the redesign is local. The [public demo](https://dathickboy.github.io/spectral-risk-chimera/) currently serves the earlier interface with the same replay data. Before publishing the final video, confirm that the submitted application matches the version shown. The [README](../README.md#recorded-replay-what-github-pages-serves) explains how to open the local replay.

Use prepared cuts for the code and manifest shots. Show the existing files without starting a provider request or regenerating the replay. The manifest identifies recorded files by hash. Snapshot recomputation is a separate backend capability.

## Shot list and narration

### 0:00–0:14

**Shot** — Start on the multi-currency overview with NAV and Base VaR visible. Overlay the project name and Frankenstein category.

> Where did this portfolio risk figure come from? Spectral Risk Chimera lets a reviewer follow the holdings, currency conversion, and scenarios behind the number.

### 0:14–0:35

**Shot** — Point to DEMO DATA, RECORDED REPLAY, the fixed timestamp, portfolio selector, and NAV.

> This is a recorded demo at a fixed November sixth reference time. Prices and histories are synthetic fixtures. The portfolio holds euro, dollar, and sterling instruments, with a euro net asset value of twenty-two thousand, three hundred seventy-five euros and seventy-four cents.

### 0:35–0:56

**Shot** — Show the seed CSV construction in [demoPortfolios.ts](../src/main/demoPortfolios.ts). Cut to Positions and allocation, then the published EUR→USD quote and derived inverse in FX rates used.

> The holdings begin as validated CSV transactions in a ledger. Positions are rebuilt from that ledger. Here, the recorded ECB quote is one point one one six five dollars per euro. Its inverse converts dollar holdings into euros, and is labeled derived.

### 0:56–1:21

**Shot** — Frame Base VaR and its fixed-FX disclosure. Show the histogram, dashed raw quantile marker, orange bucket legend, and 13-of-250 summary.

> Base VaR is one hundred twenty-four euros and ten cents. It uses historical simulation at ninety-five percent confidence for a one-day asset-price horizon, with FX held fixed. These twenty buckets contain two hundred fifty scenarios. Thirteen exceed the marker. The orange marker bucket also contains scenarios below that threshold.

### 1:21–1:40

**Shot** — Show the allocation legend with holding values and cash. Move to the currency exposure bars and their EUR units.

> Allocation shows each holding’s reported share and value, with one thousand euros of cash identified separately. Currency bars show instrument-currency exposure valued in euros. They describe the holdings; currency shocks are excluded from this VaR.

### 1:40–1:59

**Shot** — Show DEMO OBSERVATION and its explanation, the OD-1 reason for unavailable Adjusted VaR, and SEC Filing Risk marked unconfigured.

> Sentiment values are labeled demo observations and do not affect risk. Adjusted VaR remains unavailable because sentiment aggregation is unresolved. SEC filing analysis is also unconfigured. Each limitation stays visible beside the relevant panel.

### 1:59–2:18

**Shot** — Switch to `demo-eur-only` and show 140.18 EUR Base VaR. Cut to the [replay manifest](https://dathickboy.github.io/spectral-risk-chimera/replay/manifest.json), showing the clock, DEMO mode, and per-view hashes.

> Switching portfolios shows the euro-only example. The replay manifest records the reference clock, demo mode, and file hashes. The backend also stores calculation snapshots for recomputation. Together, these connect ingestion, FX provenance, scenario calculations, and reproducible presentation.

### 2:18–2:35

**Shot** — Show the tracked `.kiro/specs/` and `.kiro/steering/` directories. If the owner clears an excerpt for sharing, show the signed-zero regression from the [Kiro evidence packet](evidence/kiro-evidence.md#3-signed-zero-histogram-ci-regression). Credit the later Codex work.

> The Kiro project folder contains requirements, design, tasks, and financial steering. The later dashboard redesign, review, and test updates used Codex. This Frankenstein entry brings those data and calculation workflows into one inspectable application.

### 2:35–2:42

**Shot** — End card with project name, repository, application URL, MIT license, and “Recorded DEMO replay.” Start the closing line as the card appears, allow six seconds for delivery, then hold the card for one second.

> Spectral Risk Chimera. Follow the number from its inputs to its limits.

## Recording checks

- [ ] Match the shown figures and disclosures to the actual replay.
- [ ] Rehearse and time the finished cut, including transitions and the end card.
- [ ] Use only media you are authorized to include.
- [ ] Check the public YouTube link signed out and add it to the Devpost form.
