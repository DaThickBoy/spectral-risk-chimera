# Spectral Risk Chimera

Spectral Risk Chimera helps reviewers understand where a portfolio risk figure comes from. It connects validated CSV transactions, ledger-based positions, currency conversion with published-rate provenance, historical-simulation VaR, and a reproducible recorded dashboard.

The dashboard shows portfolio value, allocation, currency exposure, and the scenario losses behind Base VaR. Published ECB quotes and derived conversion rates remain distinguishable. Unavailable calculations carry an explanation.

**Kiroween 2026 category — Frankenstein.** The integration brings trade ingestion, financial arithmetic, external-data provenance, scenario analysis, and reproducible presentation into one application.

Prices and histories are synthetic DEMO fixtures. The replay uses a fixed reference time and a recorded ECB response. Base VaR models one-day asset-price changes with FX held fixed. Synthetic sentiment does not affect risk, Adjusted VaR remains unavailable under OD-1, and SEC filing analysis is unconfigured.

- [Public demo](https://dathickboy.github.io/spectral-risk-chimera/) — static recorded replay. The dark redesign has been verified locally and awaits release approval. On November 11, 2026, the public site served the earlier interface with identical replay files.
- [Kiro and Codex contributions](docs/kiro-usage.md)
- [Devpost draft](docs/devpost-submission.md)
- [Video script and shot list](docs/demo-script.md)
- [Submission checklist](docs/submission-checklist.md)

## Problem and motivation

Risk dashboards often hide the parts that matter most when you have to defend a number:

- Floating-point drift in money.
- FX rates of unknown origin, or inverted rates shown as if they were published.
- Stale inputs shown as current.
- "Adjusted" figures that quietly fall back to the unadjusted number.

Financial values use decimal strings at API and storage boundaries. The dashboard reports freshness and provenance where supplied, and explains unavailable calculations.

## What is implemented

| Area                       | What it does                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact arithmetic           | All money, prices, rates, and risk figures use Decimal.js: 40 significant digits, ROUND_HALF_UP. No JavaScript floating point is used for financial values, and APIs and storage use canonical decimal strings.                                                                                                                                                 |
| Transactions and positions | CSV import with validation, quarantine, deduplication, an append-only audit log, and an oversell policy. Positions are netted from a full ledger replay. A structural FIX tokenizer exists.                                                                                                                                                                     |
| Valuation and exposure     | Values each position in the base currency. Reports long, short, gross, net, cash, and NAV. Allocation uses the largest-remainder rule. Currency exposure is computed by the backend.                                                                                                                                                                            |
| Base VaR                   | Historical Simulation VaR (`hs-var-2`): a one-day horizon, 95% confidence, a lookback of 250 adjusted-close simple returns (minimum 200), and the Hyndman–Fan type 7 quantile. FX is held constant across scenarios. Runs in a worker thread. Snapshots are content-hashed for reproducibility.                                                                 |
| FX (ECB)                   | An adapter for the ECB euro reference rates (fixed CSV format, verified TLS, bounded cache). Publication timestamps use the documented convention `ECB-PUB-1600-FRANKFURT-v1` (16:00 Frankfurt time). Inverse rates (`X→EUR = 1 / published EUR→X`) are labelled **derived**. The published observation is stored beside the derived rate (SQLite migration 2). |
| Sentiment-adjusted VaR     | The adjustment engine is implemented and tested: a configurable bearish threshold and a multiplier on negative scenario P&L. **No sentiment aggregation method is approved (open decision OD-1), so Adjusted VaR is always Unavailable in the demo**, with that reason shown.                                                                                   |
| SEC filings                | A URL guard and a guarded SEC client exist. **No live SEC analysis is connected** (deferred until after the hackathon); the filing panel shows _Not configured_.                                                                                                                                                                                                |
| Alerts                     | VaR alert evaluation, a state machine, and an outbox dispatcher. Results built from DEMO data never raise alerts.                                                                                                                                                                                                                                               |
| Dashboard                  | A React and Vite single-page app with a read-only data path. It renders backend financial values and computes only presentation geometry for charts. The same source supports the local backend and recorded replay, with `VITE_DASHBOARD_SOURCE` selecting the mode at Vite serve or build time.                                                               |
| Persistence                | SQLite through `node:sqlite` (WAL), with forward-only migrations and append-only tables enforced by triggers.                                                                                                                                                                                                                                                   |

## Three kinds of data in the demo

| Label                                         | Meaning                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DEMO DATA**                                 | Prices and history are deterministic fixtures (`DEMO-EU`, `DEMO-US`, `DEMO-UK`, `DEMO-A`, `DEMO-B`), not market data. Every result is flagged `DEMO_DATA` and never alerts.                                                                                                                                                     |
| **ECB statistics** (published versus derived) | FX comes from the ECB euro reference rates. The ECB publishes `EUR→X`. The application uses `X→EUR`, computed as `1 / published` at 40 significant digits, and labels that value **Derived**. The published value is shown separately. Source: ECB statistics. The reference rates are published for information purposes only. |
| **RECORDED REPLAY**                           | The public site shows responses recorded from the real backend at a fixed reference time (2026-11-06 16:00 UTC), using the DEMO fixtures and one recorded ECB response. It is not live data.                                                                                                                                    |

## Reading the redesigned replay

The local dark dashboard starts with the portfolio overview and freshness at replay time. The loss distribution and allocation follow, then currency exposure, positions, risk signals, and FX provenance. Allocation shows backend-reported position percentages and a separate cash amount.

- **Base VaR** is a one-day, 95% historical-simulation estimate for asset-price changes with FX held fixed. The histogram shows the same 250 scenario losses in 20 equal-width buckets. The dashed marker locates the raw quantile. Thirteen scenarios exceed the marker in each recorded portfolio. The orange marker bucket also contains observations below the marker.
- **Adjusted VaR** shows unavailable because no sentiment aggregation method is approved under OD-1.
- **Market Sentiment** labels synthetic values as demo observations and shows their observation times. These values do not affect the risk calculation.
- **SEC Filing Risk** is unconfigured in the demo.

## Quick start (local demo)

Requirements: Node.js **24.22.1** (pinned in `package.json` and `.nvmrc`) and npm.

```bash
npm ci
npm run build
```

### Run the demo backend

The demo uses the committed demo configuration `config/demo/kiroween-2026.demo.jsonc`. Its provisional values are approved for the hackathon demo only. It needs a database file path. Environment variables are read from the shell; a `.env` file is not loaded.

PowerShell:

```powershell
$env:SRC_CONFIG_FILE = "config/demo/kiroween-2026.demo.jsonc"
$env:SRC_DATABASE_FILE = "$env:TEMP\src-demo.db"
npm start -- --demo-fixtures --port 8080 --allowed-origin http://127.0.0.1:5173
```

bash:

```bash
SRC_CONFIG_FILE=config/demo/kiroween-2026.demo.jsonc SRC_DATABASE_FILE=/tmp/src-demo.db \
  npm start -- --demo-fixtures --port 8080 --allowed-origin http://127.0.0.1:5173
```

- **Binding and startup:** the server binds to `127.0.0.1` only. Without `--demo-fixtures` it refuses to start (`PROVIDERS_NOT_CONFIGURED`), and the demo configuration is refused outside demo mode.
- **Seeding:** at startup it seeds two portfolios: `demo-eur-usd-gbp` (EUR, USD, and GBP holdings, EUR base) and `demo-eur-only`.
- **Live ECB request:** in this live local mode the backend requests the current rates from the ECB API. If the ECB is unreachable or the rate is stale, the multi-currency portfolio shows _FX UNAVAILABLE_ or _STALE_, and the EUR-only portfolio still calculates.
- **Read-only endpoints:** `GET /dashboard` and `GET /dashboard/portfolios/<id>`.
- **Request guard:** the backend accepts only a `Host` of `127.0.0.1:<port>` or `localhost:<port>` for its own port, which blocks DNS rebinding. `POST`, `PUT`, `PATCH`, and `DELETE` also need an `Origin` that exactly matches an `--allowed-origin` value, which blocks cross-site writes. A script that writes to the local API must send that `Origin` header. This is not authentication (OD-7 is still open).
- **Stopping:** stop with Ctrl+C.

### Dashboard against the local backend

In a second terminal, with the backend running on port 8080:

```powershell
$env:VITE_DASHBOARD_SOURCE = "live"
$env:SRC_DASHBOARD_BACKEND = "http://127.0.0.1:8080"
npm run dev:web
```

Open the URL Vite prints (`http://127.0.0.1:5173/`). Vite proxies `/dashboard` and the read-only `/stream` WebSocket to the backend. For live updates, start the backend with `--allowed-origin http://127.0.0.1:5173`: the stream accepts only listed origins. Risk updates then refresh the shown view, at most once per animation frame. Sentiment updates change only their ticker, and the top bar shows the stream and provider state. The public replay has no stream.

### Recorded replay (what GitHub Pages serves)

```bash
npm run build
npm run export:replay   # records dist/web/replay/ deterministically; no live provider is called
npm run serve:pages     # serves dist/web at http://127.0.0.1:4173/spectral-risk-chimera/
```

Two exports from the same inputs produce byte-identical files. The manifest (`dist/web/replay/manifest.json`) records:

- the reference clock and dates;
- the data mode (`DEMO`) and `live: false`;
- each view's freshness and SHA-256;
- the recorded ECB response, which is copied unmodified.

## Testing and verification

| Command                 | What it checks                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`     | Strict TypeScript (backend, dashboard, dashboard tests)                                                                                                        |
| `npm run lint`          | ESLint, including financial rules (no native-number arithmetic on financial values; no calculation in the dashboard)                                           |
| `npm run format:check`  | Prettier                                                                                                                                                       |
| `npm run deps:check`    | dependency-cruiser module boundaries (for example, `risk/` never imports `sec/`; `web/` imports only the API contracts)                                        |
| `npm test`              | Vitest unit, property-based (fast-check), integration, and dashboard component tests (jsdom and axe-core)                                                      |
| `npm run build`         | `tsc` backend build and the Vite dashboard build                                                                                                               |
| `npm run export:replay` | Records the static replay                                                                                                                                      |
| `npm run test:e2e`      | Playwright (Chromium) against the built replay under the Pages subpath. Run `npx playwright install chromium` once, and run `build` and `export:replay` first. |

CI (`.github/workflows/ci.yml`) runs these on Node.js 24.22.1 and 26, together with a pinned secret scan (gitleaks over the repository and, with `.gitleaks-bundle.toml`, over the built `dist/web` bundle that GitHub Pages publishes), `npm audit --audit-level=high`, and the browser tests. `npm audit` reports existing moderate, development-only findings; see [SECURITY.md](SECURITY.md).

## Architecture

```text
CSV import ──────► ingestion ──► ledger ──► portfolio (positions, allocation, exposure)
DEMO fixtures ───► marketdata (series, cleaning, returns) ─┐
ECB CSV ─────────► adapters/fx ──► fx (FxService, provenance)├─► risk (Historical Simulation VaR, worker)
sentiment (engine; no approved aggregator) ────────────────┘            │
                                                                        ▼
SQLite (persistence) ◄── app (use cases, recorder, dashboard service) ──► api (Fastify, read-only dashboard routes)
                                                                        │
                                                   web (React dashboard) ◄── live backend or recorded replay
```

```text
src/
  shared/       Decimal helper, Zod schemas, API contracts, resilience, clock, Result
  config/       Zod config schema and loader (no defaults for financial settings)
  ingestion/    CSV and FIX parsing, normalization, deduplication, quarantine
  portfolio/    Ledger replay, positions, allocation, exposure (pure)
  marketdata/   Series, cleaning, returns, DEMO fixture provider
  fx/           FX service, attribution, fixture provider
  risk/         VaR engine, adjustment, worker
  sentiment/    Sentiment state, emitter, poller (no approved aggregator)
  sec/, nlp/    SEC URL guard and client; NLP port with a fallback placeholder (not connected)
  alerts/       Alert evaluation and state machine
  app/          Use cases: valuation, recorder, risk service, dashboard service
  persistence/  Ports, in-memory and SQLite adapters, migrations
  audit/        Append-only audit log (redacted details)
  adapters/     HTTPS transport, ECB adapter, SEC and WebSocket transports
  api/          Fastify gateway and routes
  main/         Composition root, demo start, demo fixtures, replay exporter
  web/          React and Vite dashboard
config/demo/    Hackathon demo configuration (demo only)
test/           unit, property, integration, web, e2e, fixtures (recorded ECB responses)
.kiro/          Specs (requirements, design, tasks) and steering rules
```

## Limitations and deferred work (honest list)

- **No live market data.** Prices and history are DEMO fixtures; no market-data vendor is selected (OD-13).
- **FX.** The ECB is approved for the hackathon demo only (OD-5 stays open for real use). The replay uses one recorded ECB response. With the demo's four-day freshness threshold, ECB rates are stale over the Easter closure.
- **Adjusted VaR.** Unavailable until a sentiment aggregation method is approved (OD-1).
- **SEC filing risk.** Not connected; no filing score is shown or fabricated.
- **Holiday calendar.** Weekends only (OD-3).
- **Production mode.** Undefined (OD-19); production startup is blocked.
- **No authentication** (OD-7). The backend binds to loopback only and must not be exposed publicly. The public demo is a static replay with no backend.
- **Cross-origin reads of the local backend.** The request guard blocks cross-site writes, but it does not require an `Origin` on `GET`. While the local backend runs, a web page open in the same browser can still send `GET` requests to it. It cannot read the responses, and no `GET` changes a portfolio, the ledger, or an alert. However, the valuation reads (positions, allocation, dashboard view) can trigger outbound FX provider requests, record FX observations, and use up the shared rate limit. Removing these side effects from reads is planned as separate hardening work.
- **Demo configuration values** (freshness and staleness thresholds, oversell policy, and the sentiment maximum age, window, and future-skew tolerance) are approved for the hackathon only, not for real use (OD-6; H3 and H9).

## Security

- No credentials are in the repository; secrets come only from environment variables (`.env.example` holds placeholders).
- `test/fixtures/tls/` holds a self-signed localhost certificate and its private key. They exist only for the local TLS tests and are not production credentials. See [test/fixtures/tls/README.md](test/fixtures/tls/README.md).
- TLS verification is always on.
- The public site is static files with GET requests only.
- See [SECURITY.md](SECURITY.md) for the dependency-audit policy.

## License and attribution

- **License:** MIT. See [LICENSE](LICENSE).
- **FX data:** Source: ECB statistics. The euro foreign exchange reference rates are published by the European Central Bank for information purposes only. Values of the form `X→EUR` are derived (inverted) from the published rates and are not identical to them. The recorded responses in `test/fixtures/fx/ecb/` are stored unmodified (see their README).
- **Other data:** all other market data is fictitious DEMO data.
