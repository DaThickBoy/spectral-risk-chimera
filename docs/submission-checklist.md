# Kiroween 2026 submission checklist

**Category** — Frankenstein. **Deadline (reported)** — December 4, 2026 at 2:00 p.m. PST (23:00 in Warsaw). Reported date; verify against the [official rules](https://kiroween.devpost.com/rules) and [FAQ](https://kiroween.devpost.com/details/faqs) before submitting. The public video must be under three minutes; the project target is a 2:40–2:45 cut.

**Release status (2026-11-21).** The five-view candidate passed isolated local validation (see release verification below). The [public application](https://dathickboy.github.io/spectral-risk-chimera/) is a static recorded replay whose newest discovered deployment was reported as built from commit `3234dab`; **parity with the audited branch HEAD is not verified**. Do not claim parity until the signed-out checks below pass against an owner-approved deployment. Details: [release verification](evidence/release-verification.md).

Items are split into **automatically verifiable** (a command or local procedure proves them) and **owner-only** (a human must confirm; an agent must never check these boxes).

## Automatically verifiable — local baseline

Run from the repository root at the exact release candidate commit. Record the commit SHA and the date with the results.

- [x] Dependencies install from the lockfile — `npm ci` (verified at `75ce8d6`, 2026-11-21).
- [x] Strict types — `npm run typecheck` (verified at `75ce8d6`, 2026-11-21).
- [x] Lint, including financial rules — `npm run lint` (verified at `75ce8d6`, 2026-11-21).
- [x] Formatting — `npm run format:check` (verified at `75ce8d6`, 2026-11-21).
- [x] Module boundaries — `npm run deps:check` (verified at `75ce8d6`, 2026-11-21).
- [x] Unit, property, integration, and dashboard component tests — `npm test` (3794 passed, 1 skipped, 161 files at `75ce8d6`, 2026-11-21).
- [x] Backend and dashboard build — `npm run build` (verified at `75ce8d6`, 2026-11-21).
- [x] Deterministic replay export — `npm run export:replay` (verified at `75ce8d6`, 2026-11-21; the manifest hashes each file).
- [x] Browser suite against the built replay under the Pages subpath — `npm run test:e2e` (49 passed, Chromium, at `75ce8d6`, 2026-11-21; requires `npx playwright install chromium` once, plus `build` and `export:replay` first).
- [x] Public [GitHub repository](https://github.com/DaThickBoy/spectral-risk-chimera), [MIT license](../LICENSE), setup instructions in the [README](../README.md), and tracked `.kiro/specs/` and `.kiro/steering/` are present — `git ls-files .kiro LICENSE README.md`.
- [ ] Re-run every command above at the final release candidate after the redesign lands, and update the counts and SHA here.

CI repeats these checks on Node.js 24.22.1 and 26 (`.github/workflows/ci.yml`), plus a pinned gitleaks secret scan (repository and built `dist/web` bundle) and `npm audit --audit-level=high`. `npm audit` reports existing moderate, development-only findings; see [SECURITY.md](../SECURITY.md).

## Exact-SHA release verification procedure

Deployment is **owner-approved only**. An agent must not merge to `main`, push, trigger `workflow_dispatch`, or otherwise deploy. The owner performs (or explicitly authorizes) each release step.

1. **Record the target release SHA.** `git rev-parse HEAD` on the approved release candidate; write it into [release verification](evidence/release-verification.md).
2. **Build the artifact with provenance.** At that SHA: `npm run build && npm run export:replay`. Save the resulting `dist/web/replay/manifest.json` (reference clock, `live: false`, per-file SHA-256) with the evidence. Two exports from the same inputs must be byte-identical.
3. **Deploy through the reviewed workflow only.** `.github/workflows/pages.yml` triggers on **push to `main`** or manual **`workflow_dispatch`**. It re-runs typecheck, lint, format, boundaries, tests, build, replay export, Playwright, and a gitleaks scan of `dist/web`, then publishes only `dist/web/`. The owner merges/pushes or dispatches; record the workflow run URL and the commit it built (the run page shows the SHA — it must equal the target SHA from step 1).
4. **Verify the public site signed out** (checklist below). Any mismatch means the release is not verified; do not submit until it passes.
5. **Record the outcome** in [release verification](evidence/release-verification.md): SHA, run URL, manifest hashes, date, and each check's result.

### Signed-out public-site verification (after the owner-approved deploy)

Open the site in a private/incognito window, signed out of GitHub, with no local server running.

- [ ] Both portfolios load: `demo-eur-usd-gbp` and `demo-eur-only` (selector and `?portfolio=` URL).
- [ ] `demo-eur-usd-gbp`: NAV **22375.74 EUR**, Base VaR **124.10 EUR**, cash **1000.00 EUR**.
- [ ] `demo-eur-only`: NAV **14025.44 EUR**, Base VaR **140.18 EUR**, cash **1000.00 EUR**.
- [ ] **Recorded Replay · Not live** and the demo notice are visible. Open the replay disclosure to check source, details, and recording time (2026-11-06 16:00 UTC). Freshness reads **Fresh at replay time**.
- [ ] Loss distribution: 250 scenarios in 20 buckets, **13 exceedances** of the raw quantile marker in each portfolio; the marker bucket is visually distinguished from the exceedance count; the exact-value table opens and matches the replay JSON.
- [ ] Methodology disclosed: historical simulation, 95% confidence, one-day asset-price horizon, FX held fixed, Hyndman–Fan type 7.
- [ ] Published ECB quotes shown separately from derived inverses (EUR→USD published 1.1165; USD→EUR and GBP→EUR labelled derived), with "Source: ECB statistics." attribution.
- [ ] Adjusted VaR unavailable with the OD-1 explanation; sentiment labelled DEMO observations; SEC filing risk marked not configured. No blocked feature appears to work.
- [ ] Charts render (allocation with numbered badges, currency exposure, loss histogram with marker and tail legend); navigation opens each of the five views.
- [ ] Mobile **390×844**: no page-level horizontal overflow; the loss chart fits without horizontal scrolling; overflowing tables scroll inside named focusable regions; panels stack readably.
- [ ] No backend dependency: DevTools network tab shows only static files from the Pages origin (HTML, assets, `replay/*.json`, the recorded ECB CSV, notices); no WebSocket, no API host, no failed live requests. Static hosting still requires access to the Pages files; offline reload is not verified.
- [ ] Footer link opens the complete `THIRD_PARTY_NOTICES.txt`.
- [ ] The public `replay/manifest.json` hashes match the manifest saved in step 2 (fetch it signed out and compare).

## Owner-only confirmations (never checked by an agent)

- [ ] Confirm entrant or team eligibility, representative where applicable, timeline, ownership, and disclosure of any incorporated pre-existing work.
- [ ] Confirm third-party data and media permissions, including the right to reuse and redistribute the recorded ECB response ("Source: ECB statistics.") and any video assets.
- [ ] Approve which transcript excerpts can be shared from the [Kiro evidence packet](evidence/kiro-evidence.md) (the full transcript is owner-supplied, outside the repository) and review the [attribution write-up](kiro-usage.md).
- [ ] Approve the dashboard version and **authorize the release/deployment** (merge to `main` or `workflow_dispatch`). Deployment must never be automated by an agent.
- [ ] Verify that the final public URL and the video demonstrate the same version.
- [ ] Confirm the category claim (Frankenstein) and any optional prize claims against the official rules before selecting them.
- [ ] Confirm the reported deadline against the official rules.
- [ ] Give final approval to submit.

## Video and form (owner actions)

- [ ] Rehearse the [script and shot list](demo-script.md); verify the actual runtime including cuts and end card (2:45 or less).
- [ ] Publish the authorized video as **Public** on YouTube and confirm it plays while signed out. No video URL exists yet.
- [ ] Use English materials or provide the required English translations.
- [ ] Complete the Devpost fields using the [submission draft](devpost-submission.md): category, description, repository, application URL, video URL, and Kiro write-up, aligned with the five judging criteria.
- [ ] Submit before the verified deadline; keep the demonstration freely accessible through judging.

## Final owner handoff

Review and stage only intended source, tests, documentation and selected screenshot evidence. Exclude local settings, scratch scripts and generated output. After owner approval, commit and merge through the normal review workflow, record the deployed workflow SHA, and complete the signed-out [release verification](evidence/release-verification.md) checklist before submitting. Record the demo video against that same public version.
