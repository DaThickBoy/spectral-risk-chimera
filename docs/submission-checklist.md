# Kiroween 2026 submission checklist

This checklist uses only the official Kiroween 2026 requirements published on [kiroween.devpost.com](https://kiroween.devpost.com/) and its rules page. The official rules always take precedence over this file. Check them again before submitting, in case they have changed.

- **Deadline:** December 4, 2026, 2:00 PM Pacific Time.
- **Eligibility window:** the project must have been started between October 30 and December 4, 2026. The first commit in this repository is dated 2026-11-06.
- **Category:** Frankenstein (decision DR-KW-1, H1).

Status key: **Done** means present in the repository now. **Manual** means a step the repository owner must do outside the code. **Pending** means not done yet.

## Required items

| #   | Requirement                                                                                 | Status                            | Notes and evidence                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A working application built with Kiro                                                       | Done locally                      | `npm run build`, `npm test`, `npm run export:replay`, and `npm run test:e2e` pass locally. The public URL is not live yet (item 6).                                                                        |
| 2   | Public GitHub repository (not GitLab or Bitbucket)                                          | Manual, not verified              | Remote: `https://github.com/DaThickBoy/spectral-risk-chimera`. Confirm that its visibility is **Public**.                                                                                                  |
| 3   | The repository contains all source code, assets, and instructions needed to run the project | Pending                           | Most of the implementation is still **uncommitted** on `feat/phase-2-foundation`. It must be committed, pushed, and merged before the repository is complete. The instructions are in `README.md`.         |
| 4   | An open-source license, visible in the repository's About section                           | Done in files; About not verified | `LICENSE` is MIT. Confirm that GitHub detects it and shows "MIT license" in the About sidebar.                                                                                                             |
| 5   | The `/.kiro` directory at the repository root, not ignored                                  | Done locally                      | `.kiro/specs/` and `.kiro/steering/` exist and are tracked. Their latest edits are uncommitted (item 3). `.kiro/settings/` is untracked local configuration; review it before committing anything from it. |
| 6   | A URL to the working application                                                            | Pending                           | Planned: `https://dathickboy.github.io/spectral-risk-chimera/`. **Not deployed or verified.** See "Deploying GitHub Pages" below.                                                                          |
| 7   | A text description of the project                                                           | Pending (Devpost form)            | Draft from the README sections "Problem and motivation", "What is implemented", and "Limitations".                                                                                                         |
| 8   | A demo video under 3 minutes, public on YouTube, with no copyrighted music                  | Pending                           | Script: [demo-script.md](demo-script.md). Record, check the length, and upload as **Public**.                                                                                                              |
| 9   | An explanation of how Kiro was used                                                         | Done (draft)                      | [kiro-usage.md](kiro-usage.md). Paste it or summarise it in the Devpost form.                                                                                                                              |
| 10  | Category selected                                                                           | Pending (Devpost form)            | Frankenstein.                                                                                                                                                                                              |
| 11  | Final submission on Devpost before the deadline                                             | Pending                           | December 4, 2026, 2:00 PM PT.                                                                                                                                                                              |

Optional items from the official page (not required): a blog post, a social media post with `#KiroweenHackathon26`, and requesting free Kiro credits (deadline December 1, 2026, 12:00 PM PT).

Judging criteria from the official page, for reference: Potential Impact, Technological Implementation, Design, Innovation/Idea, and Presentation. See the official wording on the rules page.

## Deploying GitHub Pages (manual)

The workflow `.github/workflows/pages.yml` builds the dashboard, records the replay from fixtures, runs the browser tests, and deploys. It does not run until these steps are done:

1. Commit the work in reviewable milestones, push the branch, open a pull request, and merge it into `main` after CI passes.
2. In GitHub, open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. The "Pages (static DEMO replay)" workflow runs on every push to `main` and can also be started by hand (`workflow_dispatch`). Confirm that the run succeeds.
4. Open `https://dathickboy.github.io/spectral-risk-chimera/` and check that:
   - Base VaR shows `124.10 EUR`;
   - the `DEMO DATA` and `RECORDED REPLAY` badges are visible;
   - Adjusted VaR shows `Unavailable` with the OD-1 reason;
   - switching to `demo-eur-only` shows `140.18 EUR`.
5. Update the README line "Not deployed or verified yet" once the site has been checked.

## Final pre-submission checks

- [ ] `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run deps:check`, `npm test`, `npm run build`, `npm run export:replay`, and `npm run test:e2e` pass on a clean clone.
- [ ] CI passes on `main` (Node.js 24.22.1 and 26).
- [ ] The repository is public, the About section shows the MIT license, and `/.kiro` is visible at the root.
- [ ] The Pages URL works and matches the demo video.
- [ ] The YouTube video is public, under 3 minutes, and has no copyrighted music.
- [ ] The Devpost form has the description, the repository URL, the app URL, the video URL, the Kiro usage write-up, and the Frankenstein category.
- [ ] Submitted before December 4, 2026, 2:00 PM PT.
