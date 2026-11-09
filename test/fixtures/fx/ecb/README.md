# Recorded ECB FX responses (task 10.2)

Source: ECB statistics.

These files are responses of the ECB data API, stored byte for byte as received
(CRLF line endings, one trailing newline). They are never edited or normalized
(`.gitattributes` disables end-of-line conversion for them). Reuse follows the
ECB policy on the reuse of ESCB statistics
(https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html):
the statistics may be reused free of charge if the source is quoted and the
statistics are not modified. The euro foreign exchange reference rates are
published for information purposes only. Rates of the form `X -> EUR` used by the
application are derived (inverted) from these published `EUR -> X` reference
rates; they are not identical to the published values.

The files contain no credentials and no personal data. Tests never use the
network; the optional live check runs only through `npm run test:live`.

## Files

Every request: `GET https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?endPeriod=<endPeriod>&lastNObservations=2&detail=dataonly&format=csvdata`
with header `Accept: text/csv` and no credentials. Every response: HTTP 200,
`Content-Type: text/csv`. Retrieved 2026-11-09.

| File | endPeriod | Rows (TIME_PERIOD) | Bytes | SHA-256 |
|---|---|---|---|---|
| `exr-gbp-usd-2026-11-06.csv` | 2026-11-06 (Friday) | 2026-11-05, 2026-11-06 | 306 | `be7147dd92819e669c69b7b485e2c8d3e826d82ff6bd3a1f946eb52489e5f30f` |
| `exr-gbp-usd-2026-11-07.csv` | 2026-11-07 (Saturday) | 2026-11-05, 2026-11-06 | 306 | `be7147dd92819e669c69b7b485e2c8d3e826d82ff6bd3a1f946eb52489e5f30f` |
| `exr-gbp-usd-2026-10-26.csv` | 2026-10-26 (Monday after the end of summer time) | 2026-10-23 (CEST), 2026-10-26 (CET) | 305 | `8a6dd2bdbd05c2c7c97f37196bcdc5e20744420aade1b30cc386eaed8695f55a` |
| `exr-gbp-usd-2026-04-07.csv` | 2026-04-07 (Tuesday after Easter) | 2026-04-02, 2026-04-07 (TARGET closed 3 and 6 April) | 306 | `736cc2accc390642893bacddb2ff76cbbcb3f96f201dbacb83b572c065405785` |
| `exr-gbp-usd-2025-12-29.csv` | 2025-12-29 (Monday after Christmas) | 2025-12-24, 2025-12-29 (TARGET closed 25 and 26 December) | 304 | `24ad0ab667cde82666d5f1782569cb775d6208952f82e3b9e2434da34c002d3b` |

Observation during recording: the ECB API intermittently answered HTTP 504 for
some of these queries (a request for `endPeriod=2026-11-08` failed three times in
a row); a retry later succeeded for the others. No 504 body is stored.

## Refresh

Run `node scripts/record-ecb-fixtures.mjs` manually. It prints the status,
Content-Type, length, and SHA-256 of every body. Update this table and review the
diff; never edit a recorded file by hand.
