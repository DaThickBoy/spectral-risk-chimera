# Demo video script (target 2:45, hard limit under 3:00)

This is the script for the Kiroween 2026 YouTube demo. It shows the recorded replay, either on the live GitHub Pages site, [https://dathickboy.github.io/spectral-risk-chimera/](https://dathickboy.github.io/spectral-risk-chimera/), or served locally:

```bash
npm run build
npm run export:replay
npm run serve:pages   # http://127.0.0.1:4173/spectral-risk-chimera/
```

Recording notes:

- Use no copyrighted music. Narration only, or royalty-free audio you have the right to use.
- Show the `RECORDED REPLAY` and `DEMO DATA` badges on screen whenever figures are visible.
- Read the figures from the screen. The values below are the ones in the current recorded replay. If the replay is re-recorded and a value changes, use the value on screen, not this script.
- Do not describe anything as live, real-time, production-ready, or investment advice.

## 0:00–0:20 · Problem

**On screen:** title card "Spectral Risk Chimera · Kiroween 2026 · Frankenstein", then the dashboard.

**Narration:**

> Risk dashboards often hide the parts you need when you have to defend a number: floating-point money, FX rates of unknown origin, stale data shown as current, and "adjusted" figures that quietly fall back to the base number. Spectral Risk Chimera does the opposite. Every value is an exact decimal, every figure shows where it came from, and anything it cannot calculate honestly is shown as unavailable, with the reason.

## 0:20–0:40 · Dashboard overview

**On screen:** the top bar. Point to the portfolio selector, base currency, NAV, the `DEMO DATA` badge, and `RECORDED REPLAY` with its recorded time. Then the row of four panels.

**Narration:**

> This is the static replay. It is responses recorded from the real backend at a fixed reference time, 6 November 2026, 16:00 UTC. Prices are deterministic demo fixtures, not market data, and the dashboard labels that everywhere. The four risk dimensions are kept as four separate panels: Base VaR, Sentiment-Adjusted VaR, Market Sentiment, and SEC Filing Risk. They are never merged into one score.

## 0:40–1:05 · EUR/USD/GBP portfolio and EUR valuation

**On screen:** select `demo-eur-usd-gbp`. Show Portfolio overview (NAV 22375.74 EUR), then Positions and allocation (DEMO-EU 40.20%), then Currency exposure.

**Narration:**

> This demo portfolio holds euro, dollar, and sterling positions, valued in euros. NAV is 22,375.74 euros. Each position is converted at its FX rate, and allocation uses a largest-remainder rule, so the percentages add up to exactly 100. The backend computes every figure as a decimal string. The browser only displays text, and does no arithmetic.

## 1:05–1:25 · Base VaR and exposure

**On screen:** the Base VaR panel (124.10 EUR) and its header parameters (1 day, 95%, as-of date). Then scroll to the Loss distribution below the positions: 20 buckets, the dashed `VaR 95% · 124.10 EUR` marker, and the bucket table.

**Narration:**

> Base VaR is a one-day, 95% historical simulation: 250 daily returns, with a documented quantile method. Here it is 124.10 euros. That is a percentile loss estimate, not a worst case. The loss distribution shows those same 250 scenarios in 20 buckets, with the marker at the exact quantile. It is a view of the Base VaR scenarios, not a second risk method. The result is content-hashed, so the same inputs reproduce the same snapshot.

## 1:25–1:50 · ECB published versus derived rates

**On screen:** the "FX rates used" table. Point to the published EUR→USD 1.1165 and EUR→GBP 0.83415, and to the "Derived: 1 / published …" label on USD→EUR. Then the "Source: ECB statistics" attribution.

**Narration:**

> FX comes from the European Central Bank's euro reference rates. The ECB publishes euro-to-dollar, 1.1165. To value dollars in euros we need the inverse, so the app computes one divided by the published rate at 40 significant digits, and labels it derived. It never pretends that the inverse was published. The published observation is stored beside it. The ECB publishes these rates for information purposes only.

## 1:50–2:10 · Why Adjusted VaR is unavailable

**On screen:** the Market Sentiment panel: DEMO-UK `-0.72` with `CURRENT` and `DEMO` badges and "latest observation, not an aggregated index". Then the Sentiment-Adjusted VaR panel showing `Unavailable` and its reason. Then the SEC Filing Risk panel showing that it is not configured.

**Narration:**

> These sentiment values are invented demo observations, labelled DEMO. Each is a single latest observation, not a market sentiment index. The sentiment adjustment engine is built and tested, but no method for aggregating sentiment has been approved yet. That is an open decision, OD-1. Demo sentiment is never used: even DEMO-UK at minus 0.72, below the minus 0.60 trigger, changes nothing. So Adjusted VaR shows Unavailable, with that reason. It does not show a copy of Base VaR, and it does not show zero. SEC filing analysis is not connected in this version either, so that panel says so instead of inventing a score.

## 2:10–2:25 · Recorded replay and reproducibility

**On screen:** switch to `demo-eur-only` (Base VaR 140.18 EUR). Then briefly show `replay/manifest.json` in the browser or an editor: reference clock, `DEMO`, `live: false`, and the SHA-256 per view.

**Narration:**

> The second portfolio is euro-only. The public site is built by a GitHub Actions workflow from recorded fixtures and one recorded ECB response, with no live request. Two exports from the same inputs are byte-identical, and the manifest records the clock, the data mode, and a hash for every view.

## 2:25–2:45 · Architecture, the Frankenstein angle, and Kiro

**On screen:** the architecture diagram from the README, then the `.kiro/specs` and `.kiro/steering` folders.

**Narration:**

> It is a Frankenstein of parts that rarely meet: exact decimal finance, central-bank statistics, historical-simulation VaR, a sentiment stress engine, SEC filing guards, and a static replay, stitched together behind strict module boundaries. It was built with Kiro from a spec of requirements, design, and tasks, with steering rules for financial code. Every financial decision was approved by a person.

## 2:45–2:55 · Closing

**On screen:** repository URL and the MIT license.

**Narration:**

> Spectral Risk Chimera. Open source under MIT. Demo data only, not investment advice. Thanks for watching.

## Checks before uploading

- [ ] Runtime is under 3:00.
- [ ] No copyrighted music, logos, or third-party footage.
- [ ] Every figure shown matches the screen, and `DEMO DATA` and `RECORDED REPLAY` are visible.
- [ ] Nothing is described as live, real-time, production-ready, or an adjusted VaR result.
- [ ] The video is set to **Public** on YouTube, and its link is added to the Devpost submission.
