# Chart palette validation — dataviz six-check validator

Historical target-swatch evidence only. This does not validate every color in the final CSS or the full allocation palette.

Validated **2026-11-21** with the dataviz categorical-palette validator (six checks: lightness band, chroma floor, CVD separation for protan/deutan/tritan, normal-vision separation floor, and ≥3:1 contrast against the surface). These target swatches were compared against the approved steering direction (`.kiro/steering/ui-guidelines.md`, decisions D1 light theme and D2 chart palette: blue/green/violet families, position numbers so colour is never the only cue).

## Results

### Light surface `#FFFFFF` — categorical position/currency palette

Palette: `#2E6BE6` (blue), `#0E9F5D` (green), `#A21CAF` (violet/magenta).

**ALL CHECKS PASS.**

| Check                    | Result                                         |
| ------------------------ | ---------------------------------------------- |
| Lightness band           | Pass                                           |
| Chroma floor             | Pass                                           |
| CVD separation (worst)   | ΔE **8.9** (deutan) — above the required floor |
| Normal-vision separation | ΔE **22.3**                                    |
| Contrast vs `#FFFFFF`    | All three colours ≥ 3:1                        |

### Navy surface `#0F1D38` — categorical palette on the deep navy chart surface

Palette: `#5B8DEF` (blue), `#1FA97C` (green), `#D160C4` (violet/magenta).

**ALL CHECKS PASS.**

| Check                    | Result                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Lightness band           | Pass                                                                                                         |
| Chroma floor             | Pass                                                                                                         |
| CVD separation (worst)   | ΔE **8.0** (protan) — passes; **secondary encoding via numbered position badges is mandated by steering D2** |
| Normal-vision separation | ΔE **19.6**                                                                                                  |
| Contrast vs `#0F1D38`    | All three colours ≥ 3:1                                                                                      |

### Navy surface `#0F1D38` — histogram pair (bars vs tail/marker)

Pair: `#5B8DEF` (bars), `#D07C26` (tail/marker orange).

**ALL CHECKS PASS.** CVD separation ΔE **27.4**. The tail/marker colour is additionally always accompanied by a text legend label per steering D2, so colour is never the sole cue.

## Remediation history

The original violet `#7C5CE0` **failed** the CVD separation check against the blue on the light surface: ΔE **1.5** under protan simulation (normal-vision ΔE 9.6) — effectively indistinguishable for protan viewers. It was snapped to `#A21CAF` (light surface) / `#D160C4` (navy surface), keeping the approved blue/green/violet families required by steering D2. All checks pass after the snap.

## Ownership note

These are the validated target values. The **lead engineer updates the steering token values** (`--chart-seq-*`, `--chart-tail`, `--chart-marker` in `.kiro/steering/ui-guidelines.md` and `src/web/styles.css`); this document records the validation evidence, not the token edit itself. Re-run the validator if any palette token changes again.

Related: [release verification](release-verification.md) · [submission checklist](../submission-checklist.md)
