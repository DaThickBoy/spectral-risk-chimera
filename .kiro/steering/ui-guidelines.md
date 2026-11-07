---
inclusion: always
---

# UI Guidelines

The Spectral Risk Chimera dashboard is an institutional financial terminal. It should feel calm, dense, and precise. Data comes first, decoration last. These rules apply to everything in `src/web/`. Signal-separation rules come from requirement R35, and the no-calculation rule comes from `architecture.md`.

## 1. Visual style

- Dark theme only in version 1. Use near-black neutral surfaces, not pure black: background `#0B0E13`, panels `#12161D`, raised panels `#1A1F28`, borders `#262C36`.
- Text: primary `#E6E9EF`, secondary `#9AA3B2`, muted `#6B7482`. Never use muted text for data values.
- One restrained accent for interaction and focus (`#4C8DFF`). Do not use the accent for data meaning.
- Flat surfaces with 1px borders. No gradients, glows, glassmorphism, or heavy shadows.
- Define all colours, spacing, and type sizes as design tokens (CSS variables). Do not hardcode hex values in components.

## 2. Typography and numbers

- UI text in a clean sans-serif (for example Inter). Numbers in a monospaced or tabular-figure font (`font-variant-numeric: tabular-nums`) so columns line up.
- Right-align numeric columns. Left-align text columns.
- Show units with every value: currency code (`USD`), `%`, or `bps`. Never show a bare number.
- Display values exactly as the backend formats them. Do not re-round in the UI.
- Show a negative sign as `-`, never only colour or parentheses.
- Minimum body size 13px; table data 12–13px; key metrics 20–28px.

## 3. Information hierarchy

- Top bar: portfolio, base currency, NAV, data as-of time, connection and provider status.
- Primary row: four separate panels in this order: Base VaR, Sentiment-Adjusted VaR, Market Sentiment, SEC Filing Risk (R35.1). Never merge them into one gauge or score.
- Then positions and allocation table, then charts, then alerts and audit detail.
- Each panel header states what the value is, its parameters, and its time: for example `Adjusted VaR · 1 day · 95% · as of 2026-11-06`.
- Show why Adjusted VaR differs from Base VaR, or that no position triggered. When Adjusted VaR is unavailable, show "Unavailable" and the reason in its own panel; never show the Base figure there (R35.6, R17.10).
- Use progressive disclosure: summary first, details on expand. Do not hide current status behind interaction.

## 4. Risk and data states

Use one consistent semantic palette. Each state also has a text label and an icon, because colour alone is not enough (R35.4, accessibility).

| State | Colour | Label | Use |
|---|---|---|---|
| Positive | `#2FBF71` | `+` value | Gains, bullish sentiment |
| Negative | `#E5484D` | `-` value | Losses, bearish sentiment |
| Warning | `#F5A524` | `WARNING` | Alert severity WARNING, stale data, reduced lookback |
| Critical | `#FF4D6D` on a tinted background with a border | `CRITICAL` | Alert severity CRITICAL, threshold breaches |
| High | `#FF7A45` | `HIGH` | Alert severity HIGH |
| Neutral | secondary text | `NEUTRAL` | Zero or neutral sentiment |

Data status badges, always visible beside the value:

| Status | Badge |
|---|---|
| Current | `CURRENT` (subtle, secondary text) |
| Stale | `STALE` + age, warning colour |
| Unavailable | `UNAVAILABLE`, value shown as `—` (never `0`) |
| Demo | `DEMO` in a distinct outlined badge, on every demo value |
| Last valid | `LAST VALID` + timestamp |

Rules:
- Never show a missing value as `0`. Use `—` with a status badge.
- Filing risk (0 low to 1 high) and sentiment (-1 bearish to +1 bullish) use their own scale captions. Do not put them on a shared colour scale, and do not imply that bullish sentiment offsets high filing risk.
- Text and data must meet WCAG 2.2 AA contrast (4.5:1 for text, 3:1 for graphics and badges). Full compliance still needs manual testing with assistive technology.

## 5. Charts

Every chart must have:
- A title stating the metric and parameters.
- Axis labels with units (for example `Loss (USD)`, `Sentiment index (-1 to +1)`).
- A visible legend when more than one series is shown.
- Timestamps: the x-axis time range, the data as-of time, and the timezone (UTC by default).
- Tooltips showing the exact decimal string from the backend, the unit, and the timestamp.
- A visible marker for the VaR level on loss distributions, labelled with confidence.
- Gaps shown as gaps. Never interpolate or draw lines across missing data.
- A text summary or data table alternative for screen readers.

Charts use `toChartNumber()` only for plotting. Labels and tooltips use the decimal strings.

## 6. Motion

- No decorative animation: no pulsing, bouncing, shimmering, count-up numbers, or animated backgrounds.
- Values update in place without animating the digits.
- A brief (≤ 300 ms) background highlight may mark an updated cell. It must not hide or delay the value.
- Respect `prefers-reduced-motion` by disabling all non-essential transitions.
- Loading states use static skeletons or a simple spinner, never placeholder numbers.

## 7. Interaction and density

- Compact, scannable tables with sticky headers, sorting, and keyboard navigation.
- Every interactive element is keyboard reachable with a visible focus ring in the accent colour.
- Provide accessible names for icons, badges, and charts (`aria-label`).
- Alerts appear in a dedicated panel with severity, type (`VAR` or `FILING_RISK`), metric, observed value, threshold, and time. Do not use modal pop-ups that block the data.
- Confirm destructive or configuration actions. Never trigger trades: this is a monitoring tool.

## Checklist

- [ ] Dark theme using design tokens; one accent colour.
- [ ] Numbers in tabular figures, right-aligned, with units.
- [ ] Four risk dimensions shown as separate panels with parameters and timestamps.
- [ ] Positive, negative, warning, high, and critical states use colour plus text label.
- [ ] Missing data shows `—` with a status badge, never `0`; demo data is always labelled.
- [ ] Charts have title, units, axis labels, legend, timestamps, and gaps.
- [ ] No decorative animation; reduced motion respected.
- [ ] No financial calculations in components.
