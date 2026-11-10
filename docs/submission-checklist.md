# Kiroween 2026 submission checklist

This checklist uses only the official Kiroween 2026 requirements published on [kiroween.devpost.com](https://kiroween.devpost.com/) and its rules page. The official rules always take precedence over this file. Check them again before submitting, in case they have changed.

- **Deadline:** December 4, 2026, 2:00 PM Pacific Time.
- **Eligibility window:** the project must have been started between October 30 and December 4, 2026. The first commit in this repository is dated 2026-11-06.
- **Category:** Frankenstein (decision DR-KW-1, H1).

Status key: **Done** means present in the repository now. **Manual** means a step the repository owner must do outside the code. **Pending** means not done yet.

## Required items

| #   | Requirement                                                                                 | Status                 | Notes and evidence                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A working application built with Kiro                                                       | Done                   | `npm run build`, `npm test`, `npm run export:replay`, and `npm run test:e2e` pass locally and in CI on `main`. The public demo is live (item 6).                                                                                             |
| 2   | Public GitHub repository (not GitLab or Bitbucket)                                          | Done                   | `https://github.com/DaThickBoy/spectral-risk-chimera` is public (GitHub API: `visibility: public`).                                                                                                                                          |
| 3   | The repository contains all source code, assets, and instructions needed to run the project | Done                   | Pull request [#2](https://github.com/DaThickBoy/spectral-risk-chimera/pull/2) was merged into `main` on 2026-11-09 (merge commit `2a834618`). The instructions are in `README.md`.                                                           |
| 4   | An open-source license, visible in the repository's About section                           | Done                   | `LICENSE` is MIT, and GitHub recognizes it (GitHub API: `license: MIT`).                                                                                                                                                                     |
| 5   | The `/.kiro` directory at the repository root, not ignored                                  | Done                   | `.kiro/specs/` and `.kiro/steering/` are tracked on `main`. `.kiro/settings/` is local configuration that is intentionally not committed.                                                                                                    |
| 6   | A URL to the working application                                                            | Done                   | [https://dathickboy.github.io/spectral-risk-chimera/](https://dathickboy.github.io/spectral-risk-chimera/), deployed from `main` by the "Pages (static DEMO replay)" workflow. Verified on 2026-11-09 (see "GitHub Pages deployment" below). |
| 7   | A text description of the project                                                           | Pending (Devpost form) | Draft from the README sections "Problem and motivation", "What is implemented", and "Limitations".                                                                                                                                           |
| 8   | A demo video under 3 minutes, public on YouTube, with no copyrighted music                  | Pending                | Script: [demo-script.md](demo-script.md). Record, check the length, and upload as **Public**.                                                                                                                                                |
| 9   | An explanation of how Kiro was used                                                         | Done (draft)           | [kiro-usage.md](kiro-usage.md). Paste it or summarise it in the Devpost form.                                                                                                                                                                |
| 10  | Category selected                                                                           | Pending (Devpost form) | Frankenstein.                                                                                                                                                                                                                                |
| 11  | Final submission on Devpost before the deadline                                             | Pending                | December 4, 2026, 2:00 PM PT.                                                                                                                                                                                                                |

Optional items from the official page (not required): a blog post, a social media post with `#KiroweenHackathon26`, and requesting free Kiro credits (deadline December 1, 2026, 12:00 PM PT).

Judging criteria from the official page, for reference: Potential Impact, Technological Implementation, Design, Innovation/Idea, and Presentation. See the official wording on the rules page.

## GitHub Pages deployment

Done. Pull request #2 was merged into `main` on 2026-11-09 (merge commit `2a834618`). The Pages source is set to **GitHub Actions**, and the "Pages (static DEMO replay)" workflow, which builds, records the replay from fixtures, runs the browser tests, and deploys only `dist/web/`, succeeded on that commit.

Verified on 2026-11-09:

- `https://dathickboy.github.io/spectral-risk-chimera/` answers HTTP 200.
- The published `replay/manifest.json` has the same SHA-256 as a local `npm run export:replay` from the same commit.

Every later push to `main` redeploys the site. After any change that alters the replay, check again in a browser that:

- Base VaR shows `124.10 EUR`;
- the `DEMO DATA` and `RECORDED REPLAY` badges are visible;
- Adjusted VaR shows `Unavailable` with the OD-1 reason and the status `SENTIMENT NOT CURRENT`;
- the Loss distribution below the positions shows 20 buckets, the marker `VaR 95% · 124.10 EUR`, and a 20-row bucket table (250 scenarios in total);
- Market Sentiment shows the DEMO observation of each position (DEMO-EU `-0.35`, DEMO-UK `-0.72`, DEMO-US `0.42`), each with `CURRENT` and `DEMO` badges, "latest observation, not an aggregated index", and "observed 2026-11-06 15:55 UTC";
- switching to `demo-eur-only` shows `140.18 EUR`, the marker `VaR 95% · 140.18 EUR`, and DEMO-A `0.15` and DEMO-EU `-0.35`;
- the published `replay/manifest.json` has the same SHA-256 as a local `npm run export:replay` from the deployed commit (`d24767992cce…` for the current replay).

## Final pre-submission checks

- [ ] `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run deps:check`, `npm test`, `npm run build`, `npm run export:replay`, and `npm run test:e2e` pass on a clean clone.
- [x] CI passes on `main` (Node.js 24.22.1 and 26). Verified on 2026-11-09 for merge commit `2a834618`.
- [x] The repository is public, the About section shows the MIT license, and `/.kiro` is visible at the root.
- [ ] The Pages URL works and matches the demo video. The URL works (verified 2026-11-09); the video is not recorded yet.
- [ ] The YouTube video is public, under 3 minutes, and has no copyrighted music.
- [ ] The Devpost form has the description, the repository URL, the app URL, the video URL, the Kiro usage write-up, and the Frankenstein category.
- [ ] Submitted before December 4, 2026, 2:00 PM PT.
