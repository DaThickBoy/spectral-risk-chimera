# Release verification — public GitHub Pages replay

Status as of **2026-11-21**: **NOT VERIFIED**. No public-site check below may be marked passed until an owner-approved deployment of the release candidate exists and the signed-out checks pass. Deployment requires owner approval and must not be automated by an agent.

## Current revisions

| Item                                | Value                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Audited branch                      | `feat/fintech-dashboard`                                                                                                  |
| Branch HEAD (`git rev-parse HEAD`)  | `75ce8d64aafd414795d3b225289e4093ac2cb5d0` (`75ce8d6`, "fix(ci): avoid apt dependencies in Pages browser checks")         |
| Local `main`                        | `7675dfc` ("Merge pull request #8 from DaThickBoy/feat/fintech-dashboard", 2026-11-11)                                    |
| Branch vs `main`                    | Diverged: 3 commits on the branch not on `main` (`dfba204`, `0636e2b`, `75ce8d6`); 1 merge commit on `main` not on branch |
| Newest discovered public deployment | Reported built from commit `3234dab` — **not present in the local repository**; its contents could not be inspected       |

## Historical deployment mismatch

- The audited branch HEAD is `75ce8d6`. The newest discovered public deployment was reported as built from `3234dab`. That commit does not exist locally (no local or fetched ref contains it), so the deployed contents cannot be compared with any local artifact. **Parity between the public site and the branch is unverified.**
- Earlier claim: the previous submission checklist recorded that on 2026-11-11 the public manifest, both portfolio responses, and the recorded ECB response matched the then-current local replay byte for byte. No standalone evidence file for that check was committed, so it stands as a historical report only. It predates the redesign commits and does not establish current parity.
- The five-view redesign has passed isolated local validation. Until the owner approves a release and `pages.yml` deploys it, public parity remains unverified.

## Local baseline at `75ce8d6` (2026-11-21, verified by the lead engineer)

| Check                                     | Command                 | Result                              |
| ----------------------------------------- | ----------------------- | ----------------------------------- |
| Types                                     | `npm run typecheck`     | Pass                                |
| Lint                                      | `npm run lint`          | Pass                                |
| Format                                    | `npm run format:check`  | Pass                                |
| Module boundaries                         | `npm run deps:check`    | Pass                                |
| Unit/property/integration/component tests | `npm test`              | 3794 passed, 1 skipped (161 files)  |
| Build                                     | `npm run build`         | Pass                                |
| Replay export                             | `npm run export:replay` | Pass (deterministic)                |
| Browser suite (replay)                    | `npm run test:e2e`      | 49 passed (Chromium, static replay) |

These results describe the branch baseline, not the public site. The redesign is mid-change; re-run everything at the final release candidate.

## Five-view stabilization candidate (2026-11-22, working tree on `75ce8d6` + uncommitted redesign)

All gates below ran sequentially on the final working tree (five-view architecture: `#/overview`, `#/risk`, `#/portfolio`, `#/signals`, `#/fx`; financial calculations unchanged — `src/shared/` and `src/main/` have no diff).

| Check                                     | Command                 | Result                                                       |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| Types (root, web, web-tests)              | `npm run typecheck`     | Pass                                                         |
| Lint                                      | `npm run lint`          | Pass                                                         |
| Format                                    | `npm run format:check`  | Pass                                                         |
| Module boundaries                         | `npm run deps:check`    | Pass (237 modules, 1027 dependencies)                        |
| Production dependency audit               | `npm audit --omit=dev`  | 0 vulnerabilities                                            |
| Unit/property/integration/component tests | `npm test`              | 3813 passed, 1 skipped (164 files)                           |
| Build                                     | `npm run build`         | Pass                                                         |
| Replay export                             | `npm run export:replay` | Pass; two consecutive exports byte-identical (SHA-256 equal) |
| Browser suite (replay, Chromium)          | `npm run test:e2e`      | 58 passed; also 116 passed with `--repeat-each=2`            |

The 1 skipped unit test is the pre-existing environment-conditional symlink case in `test/unit/config/loader.test.ts` (hard/symbolic links unavailable on this Windows host); it is not a new skip.

Browser coverage highlights (all against the built replay under the Pages subpath):

- Five views deep-linkable, back/forward/reload preserve portfolio and route; hash navigation never reloads the document.
- Guided tour: six steps across views by keyboard (1440/390 px) and by tap on a touch phone; each step's card and controls visible without scrolling; ends with focus on the start control; navigating away cancels the tour and focuses the destination heading (unit).
- Touch phone (390×844, `hasTouch`): Menu disclosure opens navigation and closes on destination tap; bucket tap commits including an empty bucket, with the exact unrounded range announced; tour runs fully by tap.
- Accessibility: axe-core clean on all five views at desktop and 390 px (both portfolios); keyboard skip link, selector, focus rings, reduced motion; no page-level overflow at 320–1920 px.
- Overview first screen: NAV and Base VaR both fully in the viewport at 390×844 and 320×844 (phone chrome compaction keeps every provenance fact visible).
- Stale-response guard: superseded index/view results ignored across consecutive reloads (`test/web/requests.test.tsx`).
- Loss-chart geometry: compact frame fits the phone; the regression test now waits for the ResizeObserver-driven geometry to settle before asserting (the wide frame renders for one frame before measurement — a test-timing fix, not a product change).

Historical local stabilization screenshots (not included in the release scope): `docs/evidence/screenshots/final-{overview,risk,portfolio,signals,fx}-{1440,390}.png`.

Replay artifact hashes (SHA-256, first 16 hex): `demo-eur-only.json` `bf2ad5f650900163`, `demo-eur-usd-gbp.json` `630caac6d07f3a69`, `ecb-exr-gbp-usd-2026-11-06.csv` `be7147dd92819e66`, `manifest.json` `d24767992ccee5bf`.

These results describe the local working tree only. The public-site checks below remain **NOT VERIFIED** pending an owner-approved deployment of this candidate.

## Exact-SHA release verification procedure

Owner-approved only. An agent must not merge to `main`, push, dispatch the workflow, or deploy.

1. **Record the actual deployment-trigger SHA (which may be the merge commit) rather than assuming it equals the pre-merge SHA** — `git rev-parse HEAD` on the approved release candidate; enter it in the status table below.
2. **Build artifact provenance** — at that SHA run `npm run build && npm run export:replay`. Archive `dist/web/replay/manifest.json` (reference clock `2026-11-06T16:00:00.000Z`, `dataMode: DEMO`, `live: false`, per-file SHA-256). Verify determinism: two exports from the same inputs are byte-identical.
3. **Deployment trigger** — `.github/workflows/pages.yml` runs on **push to `main`** or manual **`workflow_dispatch`**. It re-validates (typecheck, lint, format, deps, tests), builds, records the replay, runs the Playwright suite and a pinned gitleaks scan of `dist/web`, then deploys only `dist/web/`. The owner performs or explicitly authorizes the merge/push/dispatch. Record the workflow run URL and confirm the run's commit SHA equals the target SHA.
4. **Signed-out public verification** — run the checklist below in a private window, signed out, with no local backend running.
5. **Record results** — update the status table with date, run URL, manifest hashes, and per-check outcomes. Any failure blocks submission.

## Public-site verification status (all pending owner-approved deploy)

Target release SHA: _pending owner approval_. Workflow run: _none_. Verification date: _none_.

| #   | Check                                                                                                                                                    | Status     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Both portfolios load signed out: `demo-eur-usd-gbp`, `demo-eur-only`                                                                                     | UNVERIFIED |
| 2   | `demo-eur-usd-gbp`: NAV 22375.74 EUR, Base VaR 124.10 EUR, cash 1000.00 EUR                                                                              | UNVERIFIED |
| 3   | `demo-eur-only`: NAV 14025.44 EUR, Base VaR 140.18 EUR, cash 1000.00 EUR                                                                                 | UNVERIFIED |
| 4   | Recorded Replay · Not live and demo notice visible; open replay disclosure for source, details, and 2026-11-06 16:00 UTC timestamp; Fresh at replay time | UNVERIFIED |
| 5   | Loss distribution: 250 scenarios, 20 buckets, 13 exceedances per portfolio; marker bucket distinguished from exceedance count                            | UNVERIFIED |
| 6   | Exact-value table opens and matches the replay JSON                                                                                                      | UNVERIFIED |
| 7   | Methodology disclosed: historical simulation, 95%, one-day asset-price horizon, FX fixed, Hyndman–Fan type 7                                             | UNVERIFIED |
| 8   | Published EUR→USD 1.1165 shown separately from derived USD→EUR / GBP→EUR inverses; "Source: ECB statistics." attribution                                 | UNVERIFIED |
| 9   | Adjusted VaR unavailable (OD-1 reason); DEMO sentiment observations labelled; SEC filing risk not configured                                             | UNVERIFIED |
| 10  | Charts render: allocation with numbered badges, currency exposure, loss histogram with marker/tail legend; section navigation works                      | UNVERIFIED |
| 11  | Mobile 390×844: no page-level horizontal overflow; inner scroll regions focusable; readable stacked layout                                               | UNVERIFIED |
| 12  | No backend dependency: network tab shows only static GETs from the Pages origin; no WebSocket or live API calls                                          | UNVERIFIED |
| 13  | Footer opens the complete `THIRD_PARTY_NOTICES.txt`                                                                                                      | UNVERIFIED |
| 14  | Public replay manifest and served JSON/ECB bytes match the approved hashes; served HTML/assets match the approved workflow artifact                      | UNVERIFIED |
| 15  | Public site version matches the version shown in the demo video                                                                                          | UNVERIFIED |

Related: [submission checklist](../submission-checklist.md) · [demo script](../demo-script.md) · [palette validation](palette-validation.md)

## Final acceptance rerun (2026-11-22, uncommitted candidate)

Typecheck, lint, format, boundaries (237 modules / 1027 dependencies), build and export passed. 3813 tests passed, 1 pre-existing skip across 164 files; 58 Chromium tests passed. Two exports matched for all four files and matched the stabilization SHA-256 prefixes listed above. This is replay data verification, not compiled frontend asset identity. No diff in financial calculation modules.

Original polish screenshots were visually reviewed across all 20 combinations. The historical local `accepted-*.png` set (before the FX closure below) records the follow-up candidate; document overflow passed on all 20. Follow-up changes: mobile positions valuation text outside the scroll pane, preserved accessible caption, scroll cue, unbroken FX primary rates and aligned wide-screen footer. At that stage, mobile FX still required horizontal scrolling to see the complete provenance column.

Chromium reversal probe at 1440 px: 225 → 170.58 → 225 px with one active sidebar transition at the intermediate sample; reduced motion: 225 → 67.5 → 225 px with zero active transitions. Both returned focus to the same control without a lingering animation. A same-document route burst, rapid portfolio switch and USD FX detail opening also passed. These samples do not establish frame rate or device-wide smoothness.

Public parity remains **NOT VERIFIED**. Use the exact-SHA procedure above after owner approval.

## Mobile FX acceptance closure

The mobile provenance clipping noted above is resolved. The existing table rows reflow into cards through 600 px, with one native disclosure per pair and no duplicate controls. Desktop retains the four-column table. The previous 20-cell matrix is unchanged except for FX:

| Width | Final FX acceptance                                            |
| ----- | -------------------------------------------------------------- |
| 320   | Cards fit; full inverse values wrap within their cards.        |
| 390   | Cards and full disclosure labels fit; GBP and USD open by tap. |
| 768   | Table retains its columns; expanded evidence fits.             |
| 1440  | Desktop table retained; both inverses inspectable.             |
| 1920  | Desktop table and source attribution intact.                   |

Evidence: `screenshots/accepted-fx-{320,390,768,1440,1920}-expanded.png`. The five viewport regressions exercise keyboard or touch activation, exact rate inspection and overflow. Full Chromium: **63 passed**. Unit/integration/component: **3813 passed, 1 pre-existing skip**. Types, lint, format, boundaries, build and export passed. Two exports matched each other and the four stabilization hashes. This does not verify frontend asset identity or public deployment. Chart geometry and financial calculations were not changed.

### Isolated 39-file scope verification

An independent local Git checkout at `75ce8d64aafd414795d3b225289e4093ac2cb5d0` with only the 39 proposed release files overlaid passed `npm ci`, typecheck, lint, formatting, dependency boundaries, 3,813 tests (one existing skip), build, replay export, and all 63 Chromium tests. Neither local tooling-ignore edit was applied. A preliminary archive-only run failed five Git-dependent tests because the archive had no checkout metadata; all five passed in the independent checkout. The two checkout exports matched byte for byte and matched the four stabilization replay hashes. This is local evidence only; public parity remains unverified.
