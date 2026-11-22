# Kiroween 2026 submission checklist

**Category** — Frankenstein. **Deadline** — December 4, 2026 at 2:00 p.m. PST (22:00 UTC), confirmed against the [official rules](https://kiroween.devpost.com/rules) on 2026-11-22. The public video must be under three minutes; the project target is a 2:35–2:45 cut.

**Release status (2026-11-22).** The five-view release was committed (`110f45d`), merged (`df0ea19`), and deployed to GitHub Pages with owner approval. Signed-out public acceptance passed and all four served replay hashes match the approved baseline; compiled frontend byte parity was verified on 2026-11-23 by a clean rebuild of the merge-commit source. Details: [release verification](evidence/release-verification.md).

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
- [x] Re-ran every command above at the final release candidate `110f45d` in an independent checkout (2026-11-22): 3,816 unit/component/integration tests passed, one existing skip; 68 Chromium tests passed; build and replay export byte-identical to the approved baseline. The `75ce8d6` rows above are the historical pre-redesign baseline.

CI repeats these checks on Node.js 24.22.1 and 26 (`.github/workflows/ci.yml`), plus a pinned gitleaks secret scan (repository and built `dist/web` bundle) and `npm audit --audit-level=high`. `npm audit` reports existing moderate, development-only findings; see [SECURITY.md](../SECURITY.md).

## Exact-SHA release verification procedure

Deployment is **owner-approved only**. An agent must not merge to `main`, push, trigger `workflow_dispatch`, or otherwise deploy. The owner performs (or explicitly authorizes) each release step.

1. **Record the target release SHA.** `git rev-parse HEAD` on the approved release candidate; write it into [release verification](evidence/release-verification.md).
2. **Build the artifact with provenance.** At that SHA: `npm run build && npm run export:replay`. Save the resulting `dist/web/replay/manifest.json` (reference clock, `live: false`, per-file SHA-256) with the evidence. Two exports from the same inputs must be byte-identical.
3. **Deploy through the reviewed workflow only.** `.github/workflows/pages.yml` triggers on **push to `main`** or manual **`workflow_dispatch`**. It re-runs typecheck, lint, format, boundaries, tests, build, replay export, Playwright, and a gitleaks scan of `dist/web`, then publishes only `dist/web/`. The owner merges/pushes or dispatches; record the workflow run URL and the commit it built (the run page shows the SHA — it must equal the target SHA from step 1).
4. **Verify the public site signed out** (checklist below). Any mismatch means the release is not verified; do not submit until it passes.
5. **Record the outcome** in [release verification](evidence/release-verification.md): SHA, run URL, manifest hashes, date, and each check's result.

### Signed-out public-site verification (completed 2026-11-22 against merge `df0ea19`; results in [release verification](evidence/release-verification.md))

Open the site in a private/incognito window, signed out of GitHub, with no local server running.

- [x] Both portfolios load: `demo-eur-usd-gbp` and `demo-eur-only` (selector and `?portfolio=` URL form both verified signed-out 2026-11-22).
- [x] `demo-eur-usd-gbp`: NAV **22375.74 EUR**, Base VaR **124.10 EUR**, cash **1000.00 EUR** verified signed-out 2026-11-22.
- [x] `demo-eur-only`: NAV **14025.44 EUR**, Base VaR **140.18 EUR**, cash **1000.00 EUR** verified signed-out 2026-11-22.
- [x] **Recorded Replay · Not live** and the demo notice visible signed-out 2026-11-22; replay disclosure opened: DEMO DATA, RECORDED REPLAY recorded 2026-11-06 16:00 UTC, DEMO FIXTURES; **Fresh at replay time** badge present on the summary.
- [x] Loss distribution verified signed-out 2026-11-22 for both portfolios: 250 scenarios in 20 buckets, **13 exceedances** each (multi-currency exact-value table opened; EUR-only summary verified: 20 buckets of 12.07 EUR, marker 140.18 EUR). A full bucket-by-bucket JSON cross-check was not repeated in the public pass.
- [ ] Methodology disclosed: historical simulation, 95% confidence, one-day asset-price horizon, FX held fixed, Hyndman–Fan type 7.
- [x] Published EUR→USD 1.1165 with reference date 2026-11-06 and inverse precision/rounding verified in the mobile USD disclosure; GBP disclosure opened on desktop showing the exact derived GBPEUR rate, ECB-EXR (REAL) source, and publication-convention timestamp; "Source: ECB statistics." attribution present (all signed-out 2026-11-22).
- [x] Adjusted VaR unavailable with the OD-1 explanation and SEC filing risk **Not configured** verified signed-out 2026-11-22; DEMO sentiment labels were confirmed in local validation.
- [x] All five views opened signed-out 2026-11-22 (touch menu on mobile); allocation and positions rendered. Chart legend/badge details were confirmed in local validation and owner visual review.
- [x] Mobile **390×844** touch navigation and FX disclosure verified signed-out 2026-11-22; full overflow/scroll-region audit was done in local validation (68 Chromium tests), not repeated in the public pass.
- [x] Desktop public pass observed only `GET` requests to the Pages origin, no backend or live API calls (2026-11-22). Static hosting still requires access to the Pages files; offline reload is not verified.
- [ ] Footer link opens the complete `THIRD_PARTY_NOTICES.txt`.
- [x] All four served replay files (`manifest.json`, both portfolio JSONs, recorded ECB CSV) hashed signed-out 2026-11-22 and matched the approved baseline.

## Owner-only confirmations (never checked by an agent)

- [ ] Confirm entrant or team eligibility, representative where applicable, timeline, ownership, and disclosure of any incorporated pre-existing work.
- [ ] Confirm third-party data and media permissions, including the right to reuse and redistribute the recorded ECB response ("Source: ECB statistics.") and any video assets.
- [ ] Approve which transcript excerpts can be shared from the [Kiro evidence packet](evidence/kiro-evidence.md) (the full transcript is owner-supplied, outside the repository) and review the [attribution write-up](kiro-usage.md).
- [x] Dashboard version approved and release/deployment authorized by the owner; merged (`df0ea19`) and deployed 2026-11-22. (Historical authorization recorded here; future deployments still require owner approval.)
- [ ] Verify that the final public URL and the video demonstrate the same version.
- [ ] Confirm the category claim (Frankenstein) and any optional prize claims against the official rules before selecting them.
  - Rules verified against <https://kiroween.devpost.com/rules> on 2026-11-23: Submission Period Oct 30 – Dec 4, 2026 (2:00 p.m. Pacific); repository created 2026-11-06, inside the window; Frankenstein category matches the stitched integration; required `.kiro` directory is committed at the repository root; MIT LICENSE is committed and the repository is public; demo video must be under three minutes and publicly viewable.
  - **Social Blitz (2026 rules):** the post must **start with** `#KiroweenHackathon26` (not #Kiroween), be posted during the Submission Period, describe a favorite Kiro feature and how it changed development, and its link must be included in the submission form.
  - **Bonus Blog (2026 rules):** a public third-party blog post published during the Submission Period that explicitly mentions it was written as part of Kiroween 2026; URL in the submission form.
  - **Best Student Project:** every team member must be a currently enrolled student; LinkedIn profiles, student emails, year/degree, and school required; proof of enrollment may be requested.
  - **Best Demo:** requires a Top-10% overall score plus the highest Presentation score — not a separate opt-in claim.
  - Also new in 2026: Best Ghost of Kiroween Past (revival of an abandoned Kiro project — not applicable here) and Costume Contest (Kiro-branded costume — optional, owner decision).
- [x] Deadline confirmed against the official rules on 2026-11-22: December 4, 2026, 2:00 p.m. PST (22:00 UTC).
- [ ] Give final approval to submit.

## Video and form (owner actions)

- [ ] Rehearse the [script and shot list](demo-script.md); verify the actual runtime including cuts and end card (2:45 or less).
- [ ] Publish the authorized video as **Public** on YouTube and confirm it plays while signed out. No video URL exists yet.
- [ ] Use English materials or provide the required English translations.
- [ ] Complete the Devpost fields using the [submission draft](devpost-submission.md): category, description, repository, application URL, video URL, and Kiro write-up, aligned with the five judging criteria.
- [ ] Submit before the verified deadline; keep the demonstration freely accessible through judging.

## Final owner handoff

Review and stage only intended source, tests, documentation and selected screenshot evidence. Exclude local settings, scratch scripts and generated output. After owner approval, commit and merge through the normal review workflow, record the deployed workflow SHA, and complete the signed-out [release verification](evidence/release-verification.md) checklist before submitting. Record the demo video against that same public version.
