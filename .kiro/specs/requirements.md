# Requirements Document

## Introduction

**Spectral Risk Chimera** is a multi-source portfolio risk analysis application. It combines financial transaction records, historical market prices, foreign exchange (FX) rates, SEC regulatory filings, and market sentiment data into one portfolio risk monitoring system.

The system supports CSV and FIX transaction ingestion, portfolio position normalization, SEC 10-K and 10-Q filing analysis, sentiment monitoring, Historical Simulation Value-at-Risk (VaR), a direction-aware sentiment downside adjustment, risk alerts, and dashboard visualizations.

The application serves portfolio managers, risk analysts, traders, and quantitative strategists. It is an analytical and monitoring platform. It is NOT an automated trading or order execution system.

Design principles that apply to every requirement:

1. **Financial calculation accuracy.** All financial values use Decimal.js. Formulas are defined once in [Data and Financial Rules](#data-and-financial-rules) and referenced by requirements.
2. **Two independent risk signals.** SEC filing risk (`FilingRiskScore`) and market sentiment (`SentimentIndex`) are separate signals. Only sentiment may adjust VaR, and only through the rule in R15. `FilingRiskScore` never affects VaR.
3. **No fabricated data.** Missing, stale, unavailable, or demo data is never silently replaced or presented as real. It is labelled, and where current data is required it is not used.
4. **Traceability.** Every risk result can be traced to its inputs and configuration (R22, R32).

Scope of this document: requirements only. Design, tasks, and implementation are produced in later phases. The repository currently contains only a `package.json` (still `"type": "commonjs"`, no dependencies, placeholder `test` script); no application code, persistence layer, or authentication exists yet. The approved technology baseline is TypeScript in strict mode, ES modules, and Node.js 24.22.1 (R26.4 to R26.10). Requirements that depend on missing infrastructure are marked as implementation dependencies (see [Assumptions and Constraints](#assumptions-and-constraints) and [Open Decisions](#open-decisions)).

Requirement conventions:

- Requirement IDs `R1` to `R27` are stable and come from the previous version. `R28` to `R35` are new.
- Acceptance criteria are numbered `Rn.m`. Test cases in the [Acceptance Test Matrix](#acceptance-test-matrix) reference these IDs.
- Rule IDs `FR-n` (Data and Financial Rules) and parameter names (Configuration) are normative and referenced by requirements.
- Keywords: SHALL (mandatory), WHEN (event trigger), IF (condition or error case), WHILE (state), THEN (consequence).

## Glossary

- **Portfolio:** A collection of positions and an explicitly supplied cash balance (which may be `"0"`, see A-7) monitored by the application, identified by a portfolio identifier.
- **Transaction:** An individual imported financial operation. Version 1 supports `BUY` and `SELL` (see R28).
- **Position:** The aggregated holding of one instrument within a portfolio, with a signed quantity (positive long, negative short).
- **Instrument:** A tradable asset identified by a normalized ticker (and currency). Positions are netted per portfolio per instrument.
- **Base Currency:** The configured portfolio currency in which all valuations and VaR results are expressed.
- **NAV:** Net asset value. `NAV = sum(signed position market values in base currency) + cash balance` (FR-12).
- **CSV:** Comma-Separated Values, a tabular file format.
- **FIX:** Financial Information eXchange, a messaging protocol for electronic trading.
- **SEC / EDGAR:** U.S. Securities and Exchange Commission and its Electronic Data Gathering, Analysis, and Retrieval system.
- **10-K / 10-Q:** Annual and quarterly corporate filings.
- **Item 1A:** The Risk Factors section of a 10-K or 10-Q.
- **NLP:** Natural Language Processing.
- **FilingRiskScore:** A normalized score from 0.00 to 1.00 representing the severity of risks disclosed in an SEC filing. It is not a probability of price decline.
- **SentimentIndex:** A normalized market sentiment score from -1.00 (extreme bearish) to +1.00 (extreme bullish), per ticker.
- **RawSentiment:** The SentimentIndex of a ticker as published by the sentiment pipeline.
- **EffectiveSentiment:** The direction-aware sentiment used for the downside adjustment (FR-9).
- **Adjusted Close:** A price series adjusted for splits and dividends, used only for return calculation.
- **Market Price:** The latest unadjusted price of an instrument, used to value positions.
- **Daily Simple Return:** `AdjustedClose[t] / AdjustedClose[t-1] - 1`.
- **Common Trading Date:** A date on which every asset in the portfolio has a valid Adjusted Close.
- **Scenario:** One historical return date applied to current exposures. Scenario `i` corresponds to one daily return observation.
- **Scenario P&L:** Profit or loss of a position or portfolio in one scenario, in base currency (FR-5).
- **Loss:** `-PortfolioPnL`. A positive Loss is a loss; a negative Loss is a gain.
- **VaR:** Value-at-Risk. A percentile-based loss estimate at a stated confidence and horizon. VaR is NOT maximum drawdown and NOT a guarantee of maximum possible loss.
- **Historical Simulation:** A VaR method that applies observed historical returns to current exposures to produce Scenario P&L.
- **Base VaR:** VaR calculated without any sentiment adjustment.
- **Adjusted VaR:** VaR calculated after applying the sentiment downside adjustment (R15). It is available only when the adjustment settings are present and every position has eligible sentiment (R15.8); otherwise it is unavailable and is never replaced by Base VaR.
- **Downside Multiplier:** A factor `m >= 1` applied to adverse (negative) Scenario P&L of an eligible position.
- **Quantile Method:** Hyndman and Fan Type 7 linear interpolation (FR-7).
- **Complete Lookback:** 250 valid common daily return observations.
- **Reduced Lookback:** 200 to 249 valid common daily return observations.
- **Real Data:** Data obtained from a configured real external provider.
- **Demo Data:** Sample, mock, or simulated data that must never be presented as real.
- **Current / Stale / Unavailable:** Data status values. Current: valid and within its freshness window. Stale: valid but older than its freshness window. Unavailable: not obtainable or invalid.
- **Calculation Snapshot:** The immutable record of every input, configuration value, and algorithm version used for one VaR result (R32).
- **Canonical Decimal String:** A decimal serialized without exponent notation, without trailing fractional zeros, and without a negative zero (for example `"1000"`, `"0.1"`, `"-12.5"`).
- **Data Provenance:** Information identifying source, timestamp, and processing history of a data item or calculation.
- **p95:** The 95th percentile computed by the nearest-rank method for benchmarks: the value at sorted position `ceil(0.95 * N)` (one-based).

## Requirements

### A. Transaction Ingestion

#### Requirement 1: CSV Transaction Import

**User Story:** As a Risk Analyst, I want to upload CSV transaction files, so that historical transactions are converted into standardized portfolio positions without manual processing.

##### Acceptance Criteria

1. WHEN a user uploads a valid CSV transaction file THEN THE SYSTEM SHALL parse its records and normalize supported fields into the standardized Transaction schema defined in R28.
2. WHEN a CSV file uses different column names THEN THE SYSTEM SHALL allow each column to be mapped to a standardized transaction field through a user-supplied or saved column mapping.
3. WHEN the benchmark fixture defined in NFR-PERF-1 (10,000 data rows, 10 columns, 0 invalid rows) is processed THEN THE SYSTEM SHALL complete parsing, column mapping, validation, normalization, and summary creation with a p95 of 500 ms or less across 20 measured runs, excluding upload transfer, persistence, and fixture generation.
4. WHEN a CSV file is processed THEN THE SYSTEM SHALL return an import summary containing total rows, accepted rows, rejected rows, duplicate rows, import timestamp, and source file hash (see R28.9).
5. IF a CSV file is empty, unsupported, or unreadable THEN THE SYSTEM SHALL return a descriptive validation error and SHALL NOT crash.

#### Requirement 2: FIX Transaction Import

**User Story:** As a Risk Analyst, I want to import legacy FIX transaction logs, so that supported financial messages become standardized transactions and positions.

##### Acceptance Criteria

1. WHEN a user uploads a supported FIX log file THEN THE SYSTEM SHALL parse the supported FIX messages and extract transaction information.
2. WHEN a supported FIX message contains a valid instrument identifier, side, quantity, price, currency, and timestamp THEN THE SYSTEM SHALL normalize it into the Transaction schema.
3. IF a FIX message has an unsupported message type, a missing required tag, an invalid tag value, an invalid quantity or price, or is malformed THEN THE SYSTEM SHALL reject that message and record an auditable reason (see R28.10).
4. WHEN a FIX file contains valid and invalid messages THEN THE SYSTEM SHALL process the valid messages without terminating the import.
5. THE SYSTEM SHALL document the supported FIX versions, message types, required tags, and tag-to-field mappings. The supported set is an open decision (OD-9).

#### Requirement 3: Invalid Transaction Handling

**User Story:** As a Risk Analyst, I want invalid records identified and isolated, so that corrupted data cannot compromise portfolio calculations.

##### Acceptance Criteria

1. IF an imported record has malformed numeric values, missing required fields, or an invalid instrument identifier THEN THE SYSTEM SHALL reject the record and record a descriptive validation error.
2. WHEN a file contains invalid and valid records THEN THE SYSTEM SHALL continue processing the valid records.
3. WHEN a record is rejected THEN THE SYSTEM SHALL create an audit entry containing source, record identifier where available (row number or message sequence), timestamp, and rejection reason.
4. THE SYSTEM SHALL prevent rejected records from entering position and risk calculations.
5. THE SYSTEM SHALL provide an import summary with accepted and rejected counts.

#### Requirement 28: Import Reliability, Idempotency, and Atomicity

**User Story:** As a Risk Analyst, I want imports to be repeatable and consistent, so that re-uploading a file never duplicates trades and a failure never leaves partial data.

##### Acceptance Criteria

**Supported structure**

1. THE SYSTEM SHALL support CSV files with the following canonical fields: `external_id` (optional), `trade_timestamp` (required, ISO 8601 with timezone, or a date-only value interpreted in the explicitly configured `import.defaultTimezone`; date-only values SHALL be rejected with `INVALID_DATE` if that setting is absent), `ticker` (required), `type` (required, `BUY` or `SELL`), `quantity` (required, positive decimal), `price` (required, positive decimal), `currency` (required, ISO 4217 code), and `portfolio_id` (optional; otherwise supplied at upload). Additional columns SHALL be ignored and not stored as financial values.
2. THE SYSTEM SHALL support exactly the transaction types `BUY` and `SELL` in version 1. WHEN a record has any other type THEN THE SYSTEM SHALL reject it with reason `UNSUPPORTED_TRANSACTION_TYPE`.
3. THE SYSTEM SHALL accept UTF-8 files with or without a byte-order mark and SHALL strip the BOM before parsing. IF a file is not valid UTF-8 THEN THE SYSTEM SHALL reject the entire file with reason `INVALID_ENCODING`.
4. THE SYSTEM SHALL reject a file larger than `import.maxFileBytes` (default 10 MiB) or with more than `import.maxRows` data rows (default 100,000) before processing any record, with reason `FILE_TOO_LARGE` or `TOO_MANY_ROWS`.
5. IF a CSV header row is missing a required column after mapping, contains duplicate header names, or is empty THEN THE SYSTEM SHALL reject the file with reason `INVALID_HEADER` and name the offending columns.
6. WHEN a CSV row is entirely empty THEN THE SYSTEM SHALL skip it and count it as `skipped`, not `rejected`.
7. THE SYSTEM SHALL validate per row: a parseable date, a positive finite quantity, a positive finite price, a supported ISO 4217 currency, and a ticker matching the fixed ticker pattern `^[A-Z0-9][A-Z0-9.-]{0,14}$` (approved 2026-11-08; not configurable). A ticker that does not match SHALL be rejected with `INVALID_TICKER` and SHALL NOT be normalized (no trimming or case folding). Each failure SHALL produce a row-level error with row number, column, and reason code.
8. THE SYSTEM SHALL protect against malicious file content by treating all fields as data, enforcing the limits in criteria 3 to 5, rejecting fields longer than `import.maxFieldLength` (default 256 characters), and never executing or evaluating file content.

**Summary and audit**

9. THE SYSTEM SHALL record an import summary containing source file name, source file SHA-256 hash, import timestamp, total data rows, accepted rows, rejected rows, duplicate rows, skipped rows, and final import status (`COMMITTED`, `COMMITTED_WITH_REJECTIONS`, `FAILED`).
10. THE SYSTEM SHALL record, for each rejected FIX message or CSV row, a reason code and a human-readable message, retaining the source and sequence identifier.

**Idempotency and deduplication**

11. THE SYSTEM SHALL assign each accepted transaction a deterministic `transactionKey` as follows. IF `external_id` is present THEN `transactionKey = SHA-256("EXT|" + portfolioId + "|" + source + "|" + external_id)`. OTHERWISE `transactionKey = SHA-256("CNT|" + portfolioId + "|" + canonicalFields + "|" + occurrence)`, where `canonicalFields` are the normalized timestamp (UTC), ticker, type, quantity (Canonical Decimal String), price (Canonical Decimal String), and currency, and `occurrence` is the one-based count of identical `canonicalFields` rows within the same source file.
12. WHEN a transaction's `transactionKey` already exists THEN THE SYSTEM SHALL NOT create a second transaction and SHALL count the row as `duplicate`.
13. WHEN the same file (same SHA-256) is imported twice THEN THE SYSTEM SHALL create no new transactions on the second import and SHALL report all non-rejected rows as duplicates.
14. THE SYSTEM SHALL treat two identical rows within one file as two legitimate transactions (they receive occurrence 1 and 2). The residual limitation is that an identical trade without `external_id` appearing again in a different file is treated as a duplicate; this limitation SHALL be documented to users (OD-8).

**Atomicity**

15. THE SYSTEM SHALL commit all accepted transactions of one import, together with the import summary and rejection audit entries, in a single persistence transaction.
16. IF the persistence commit fails THEN THE SYSTEM SHALL roll back all transactions and position changes of that import, set import status `FAILED`, and report the error. The system SHALL NOT leave a partially committed import.
17. THE SYSTEM SHALL apply accepted transactions to positions only after the commit in criterion 15 succeeds.

**Position handling**

18. THE SYSTEM SHALL process accepted transactions in ascending order of the key `(tradeTimestamp, sourceId, sourceSequence, transactionKey)`, compared field by field:
    - `tradeTimestamp` is the normalized UTC timestamp in the fixed form `YYYY-MM-DDTHH:mm:ss.sssZ`, so ordinal string comparison is chronological.
    - `sourceId` is a stable identifier of the source file the transaction came from: `"<sourceKind>:" + fileSha256`, for example `CSV:` followed by the 64 lowercase hexadecimal digits of the file's SHA-256 (R28.9). It is the same whenever the same file content is imported, and it does not depend on file name, import time, or import identifier.
    - `sourceSequence` is the positive integer position of the record within that source: the CSV data row number or the FIX message sequence, the same number used for quarantine records and audit entries (R3.3, R28.10). It is an index, not a financial value.
    - `transactionKey` (R28.11) is the final tie-break and makes the order total.
    - String fields are compared by ordinal (UTF-16 code unit) order, never by locale; `sourceSequence` is compared numerically.
    - Within one file this is source order. Between files with equal timestamps the order is fixed by `sourceId`, so the result never depends on the order in which files were imported.
    - `sourceId` and `sourceSequence` are stored with every transaction and are never changed after the commit.
19. THE SYSTEM SHALL update the netted position of an instrument as `quantity += q` for `BUY` and `quantity -= q` for `SELL`, and SHALL recompute average price per FR-13.
20. THE SYSTEM SHALL apply the explicitly configured `import.oversellPolicy` (financially significant; no default; recommended value `REJECT`, see OD-6). WHERE the policy is `REJECT`, a `SELL` whose quantity exceeds the available long quantity at that point in time SHALL be rejected with reason `OVERSELL`, and the position SHALL NOT become negative. IF the policy is not configured THEN THE SYSTEM SHALL NOT import transactions. THE SYSTEM SHALL NOT silently create a short position.
21. WHERE `import.oversellPolicy` is `ALLOW_SHORT`, THE SYSTEM SHALL permit a negative signed quantity, SHALL mark the position as short, and SHALL apply the short-position rules of FR-9, FR-12, and R20.
22. IF a transaction currency differs from the instrument's established currency THEN THE SYSTEM SHALL reject it with reason `CURRENCY_MISMATCH`.

#### Requirement 5: Standardized Portfolio Positions

**User Story:** As a Portfolio Manager, I want transactions from different sources to produce standardized positions, so the application analyzes assets consistently.

##### Acceptance Criteria

1. WHEN valid transactions are committed THEN THE SYSTEM SHALL convert them into position updates per R28.18 to R28.21.
2. THE SYSTEM SHALL maintain a Position model containing at least: identifier, portfolio identifier, ticker, instrument currency, signed quantity, average price, short flag, market price, market value (instrument currency), market value (base currency), allocation percentage, valuation status, source, and update timestamp. Monetary and quantity fields SHALL be Canonical Decimal Strings at API boundaries. Average price SHALL be `null` for a zero-quantity position (FR-13). A valuation field whose value is not available SHALL be `null` together with a valuation status, never `"0"`; until position valuation and allocation are implemented the status is `NOT_VALUED`.
3. WHEN multiple transactions affect the same instrument THEN THE SYSTEM SHALL aggregate them into one netted position per portfolio and instrument. THE SYSTEM SHALL NOT keep separate long and short positions for the same instrument within one portfolio. A position whose quantity reaches zero through its ledger history SHALL be retained with signed quantity `"0"`, `averagePrice: null`, and `isShort: false`. A persisted position for which the ledger has no transaction SHALL NOT be retained (R5.6).
4. THE SYSTEM SHALL keep imported Transaction records and aggregated Positions as distinct, linked entities.
5. WHEN a position changes THEN THE SYSTEM SHALL make the updated position available to the risk calculation engine by publishing a `PositionsChanged` event, only after the positions were committed and only when at least one position actually changed (was inserted, updated, or removed).
6. THE SYSTEM SHALL derive positions by deterministic replay of the committed ledger in the order of R28.18, so that the same ledger always yields identical positions, independent of import order and of how often the replay runs. The position identifier SHALL be derived from the portfolio identifier and ticker only; the update timestamp SHALL be the trade timestamp of the last applied transaction; and the source SHALL be the source of the last applied transaction. Each rebuild SHALL replay the complete committed ledger of the portfolio and reconcile the persisted positions of that portfolio against the complete replay result: a position in the result that is missing or different in storage SHALL be inserted or updated; a persisted position with no corresponding transaction in the ledger SHALL be removed; an unchanged position SHALL NOT be written. All insertions, updates, and removals of one rebuild SHALL be committed together in one persistence transaction, or none of them SHALL be.
7. IF the committed transactions of one position have more than one currency THEN THE SYSTEM SHALL report an explicit error for that position (`POSITION_CURRENCY_CONFLICT`), SHALL NOT write any position of that rebuild, and SHALL NOT choose one of the currencies.

### B. Financial Foundations

#### Requirement 4: Financial Precision

**User Story:** As a Quantitative Strategist, I want precise decimal arithmetic, so that rounding errors do not accumulate.

##### Acceptance Criteria

1. THE SYSTEM SHALL use Decimal.js for all of: monetary values, quantities, prices, position market values, FX rates and conversions, returns used in financial calculations, Scenario P&L, Losses, VaR, Adjusted VaR, allocation percentages, NAV, and financial thresholds.
2. THE SYSTEM SHALL NOT use native JavaScript number arithmetic, `parseFloat`, `Number()`, or unary `+` on financial values.
3. THE SYSTEM SHALL serialize financial values in API and JSON payloads, persisted data, snapshots, and logs as Canonical Decimal Strings and SHALL NOT serialize them as native JSON numbers.
4. THE SYSTEM SHALL convert financial values to native numbers only at explicitly defined presentation boundaries (chart rendering), and converted values SHALL NOT feed back into any financial calculation.
5. THE SYSTEM SHALL configure Decimal.js with `precision = 40` significant digits and `rounding = ROUND_HALF_UP`, SHALL perform no intermediate rounding, and SHALL round only at defined output points (FR-14).
6. THE SYSTEM SHALL parse incoming numeric text directly into Decimal and SHALL reject values that are not finite decimals (for example `NaN` or `Infinity`). Exponent notation (for example `1e-5` or `2E3`) is not part of the accepted decimal grammar: THE SYSTEM SHALL reject every value written in exponent notation at every input boundary (as `MALFORMED_NUMBER` for imported rows and messages, and as a validation error elsewhere). This is a fixed parsing rule with no configurable limit; accepting exponent notation would require a new approved requirement.
7. Integer index arithmetic (for example the `j` index in FR-7 and counts) MAY use native integers.

#### Requirement 20: Portfolio Allocation Integrity

**User Story:** As a Portfolio Manager, I want allocation percentages calculated consistently, so exposure is represented accurately.

##### Acceptance Criteria

1. THE SYSTEM SHALL calculate `AllocationDenominator = sum(long position market values in base currency) + max(cash, 0)` (FR-10).
2. IF `AllocationDenominator <= 0` THEN THE SYSTEM SHALL NOT calculate percentage allocations and SHALL return status `ALLOCATION_UNAVAILABLE` with the reason.
3. WHEN a portfolio is eligible (no short positions, cash balance >= 0, and `AllocationDenominator > 0`) THEN THE SYSTEM SHALL produce allocation percentages (one line per long instrument plus a `CASH` line when cash > 0) that sum to exactly 100.00%, using the largest-remainder method in FR-11.
4. THE SYSTEM SHALL use Decimal.js for all allocation calculations.
5. THE SYSTEM SHALL resolve largest-remainder ties by ascending ticker (lexicographic, with `CASH` last), as specified in FR-11.
6. WHEN a portfolio contains short positions, negative cash, or leverage (gross exposure greater than NAV) THEN THE SYSTEM SHALL NOT force allocations to total 100%, SHALL state the denominator used, and SHALL display long exposure, short exposure, cash, gross exposure, net exposure, and NAV separately.
7. THE SYSTEM SHALL display allocation percentages to two decimal places and monetary display values per FR-14.
8. THE SYSTEM SHALL distinguish raw exposure values from normalized allocation percentages.

#### Requirement 30: Currency and Foreign Exchange

**User Story:** As a Portfolio Manager, I want multi-currency positions converted into one base currency, so that valuations and VaR are comparable and correct.

##### Acceptance Criteria

1. THE SYSTEM SHALL provide a configurable portfolio base currency (`fx.baseCurrency`, ISO 4217) and a configurable list of supported transaction currencies (`fx.supportedCurrencies`).
2. IF a transaction or instrument uses a currency outside `fx.supportedCurrencies` THEN THE SYSTEM SHALL reject the transaction with reason `UNSUPPORTED_CURRENCY`.
3. THE SYSTEM SHALL obtain FX rates through a provider-independent FX interface. The default FX source is an open decision (OD-5). The FX provider is selected explicitly by `fx.provider` (financially significant, no default; see Configuration). There is no automatic fallback to another provider (R30.8).
4. THE SYSTEM SHALL define every FX rate as `Rate(X/B)` = units of base currency B per one unit of currency X, so that `ValueBase = ValueX * Rate(X/B)`. A provider quoting the inverse SHALL be converted by `Rate = 1 / quote` using Decimal.js. For `X = B` the rate SHALL be exactly `1`.
5. THE SYSTEM SHALL retain, for each FX rate used, the currency pair, rate (Canonical Decimal String), observation timestamp, its basis (`observedAtBasis`: `PROVIDER`, or `PUBLICATION_CONVENTION` with a `conventionId`, R30.13), source, source kind (`REAL`, `DEMO`, or `IDENTITY`), and data status. The pair is always the requested pair `X` + `B` and the rate is always `Rate(X/B)`, also when the provider quoted the inverse; the provider's quote orientation is not retained as the rate. Source and source kind are those of the configured provider. FX observation, calculation, and recording timestamps use the fixed UTC millisecond form `YYYY-MM-DDTHH:mm:ss.sssZ`. For `X = B` the rate is exactly `1` with source `BASE_CURRENCY`, source kind `IDENTITY`, and no observation timestamp; THE SYSTEM SHALL NOT fabricate a timestamp for it.
6. THE SYSTEM SHALL express all portfolio valuations, NAV, Scenario P&L, Base VaR, and Adjusted VaR in the base currency.
7. THE SYSTEM SHALL use, for converting market values, the latest FX rate observed no later than the end of the market-data as-of date (UTC) and no later than the calculation timestamp, and SHALL treat this rate as constant across all historical scenarios in version 1 (FX scenario risk is out of scope; see Assumptions A-9 and OD-4).
8. IF a required FX rate is unavailable or, at the calculation timestamp, older than `fx.maxRateAgeSeconds` THEN THE SYSTEM SHALL NOT substitute another rate. THE SYSTEM SHALL mark affected positions and the VaR result `FX_UNAVAILABLE` (or `FX_STALE` where the stale rate is shown for display only) and identify the affected currencies. VaR SHALL be unavailable while any required rate is unavailable or stale.
9. THE SYSTEM SHALL NOT assume all instruments share one currency.
10. THE SYSTEM SHALL preserve all FX rates used in a calculation in its Calculation Snapshot (R32).
11. A `DEMO` FX rate or `DEMO` price history MAY be used only for development and demonstration calculations. A result that used any `DEMO` FX rate or any `DEMO` price history (the series behind the returns, R25.4) SHALL carry the flag `DEMO_DATA`, SHALL be labelled DEMO, SHALL NOT be presented as a valid production VaR result, and SHALL NOT produce a VaR alert. WHEN the system runs in production mode AND any required FX rate is `DEMO` THEN Base VaR and Adjusted VaR SHALL be unavailable with calculation status `FX_DEMO_NOT_ALLOWED`, and THE SYSTEM SHALL identify the affected currencies. How production mode is determined is an open decision (OD-19).
12. WHEN an FX provider is unavailable THEN THE SYSTEM MAY show the last valid FX rate for display only, labelled `STALE` with its observation timestamp. Only a validated rate that was fresh when received SHALL become the last valid rate. A last valid rate SHALL NOT be used in any calculation and SHALL NOT make VaR available (R25.3, R33.10).
13. WHEN a provider publishes rates per date without an observation time THEN THE SYSTEM SHALL assign each rate a documented, versioned publication-time convention, SHALL NOT use the rate before that time, SHALL record that the timestamp comes from a convention rather than from the provider (`observedAtBasis` `PUBLICATION_CONVENTION` with its `conventionId`), and SHALL NOT present the convention time as a measured observation. For the ECB (proposed, OD-5), the convention is 16:00 Europe/Frankfurt local time (CET or CEST) on the reference date (convention `ECB-PUB-1600-FRANKFURT-v1`).
14. WHEN FX rates derived from ECB reference rates are displayed or exported THEN THE SYSTEM SHALL show the source statement `Source: ECB statistics.`, SHALL state that inverted values (`Rate(X/EUR) = 1 / quote`) are derived from, not identical to, the published reference rate, and SHALL state that the reference rates are published for information purposes. Whether derived values and use for risk monitoring are compatible with the ECB reuse policy is an open legal question (OD-5).

### C. SEC Filing Risk

#### Requirement 6: SEC Filing Retrieval and Extraction

**User Story:** As a Portfolio Manager, I want to retrieve SEC 10-K and 10-Q filings and extract their risk disclosures, so corporate risk information supports monitoring.

##### Acceptance Criteria

1. WHEN a user provides a valid SEC filing URL, a CIK, or a ticker THEN THE SYSTEM SHALL retrieve the filing using official SEC EDGAR resources. Ticker-to-CIK resolution SHALL use official SEC data.
2. WHEN a filing is retrieved THEN THE SYSTEM SHALL record company identifier (CIK), ticker where available, filing type, filing date, accession number, source URL, and retrieval timestamp.
3. WHEN a 10-K or 10-Q contains Item 1A THEN THE SYSTEM SHALL extract its Risk Factors content.
4. WHEN extracted content contains HTML or formatting THEN THE SYSTEM SHALL normalize it into clean text suitable for NLP.
5. IF Item 1A is missing, inaccessible, or cannot be extracted THEN THE SYSTEM SHALL return a descriptive status (`ITEM_1A_NOT_FOUND`, `FILING_UNAVAILABLE`, or `EXTRACTION_FAILED`) and SHALL NOT fabricate content or a score. IF an Item 1A section is found but is shorter than `sec.item1a.minChars` (for example a 10-Q stating only that there are no material changes) THEN THE SYSTEM SHALL return `ITEM_1A_TOO_SHORT`, SHALL store the filing metadata, and SHALL NOT produce a FilingRiskScore.
6. THE SYSTEM SHALL send a configurable, descriptive `User-Agent` identifying the application and a contact (`sec.userAgent`, required, supplied through the `SEC_USER_AGENT` environment variable and never committed) and SHALL NOT start SEC retrieval if it is unset. THE SYSTEM SHALL NOT send or forward cookies or `Authorization` headers on SEC requests, including redirect hops.
7. THE SYSTEM SHALL respect SEC fair-access limits by never exceeding `sec.maxRequestsPerSecond` (default 5, hard maximum 10) and SHALL back off on HTTP 429 and 5xx responses using the retry policy of R25.
8. IF SEC returns an error, rate limit, unavailable document, or malformed filing content THEN THE SYSTEM SHALL report a descriptive error and continue operating.

#### Requirement 7: SEC Filing Risk Analysis

**User Story:** As a Portfolio Manager, I want SEC risk disclosures converted into numerical scores, so qualitative corporate risks can be monitored consistently.

##### Acceptance Criteria

1. WHEN valid Item 1A text is available THEN THE SYSTEM SHALL pass it to the configured NLP module (R8).
2. WHEN analysis completes THEN THE SYSTEM SHALL produce a `FilingRiskScore` in the inclusive range 0.00 to 1.00.
3. THE SYSTEM SHALL interpret 0.00 as minimal identified risk and 1.00 as very high identified risk.
4. WHEN risk categories can be identified THEN THE SYSTEM SHALL classify them into: market, liquidity, credit, operational, regulatory, legal, cybersecurity, and business risk.
5. THE SYSTEM SHALL retain filing type, filing date, accession number, ticker, source URL, analysis timestamp, scoring method and version, NLP provider and mode (real or fallback), and identified risk categories with the score.
6. THE SYSTEM SHALL describe `FilingRiskScore` as the severity of disclosed risk and SHALL NOT present it as a probability of price decline or as an input to VaR.
7. IF analysis fails THEN THE SYSTEM SHALL report the failure and SHALL NOT present an unverified score as genuine analysis.

#### Requirement 8: Configurable NLP Provider

**User Story:** As a System Administrator, I want NLP providers to be interchangeable, so different models can be used without changing core functionality.

##### Acceptance Criteria

1. THE SYSTEM SHALL use a provider-independent interface for NLP analysis.
2. WHEN an NLP provider is configured THEN THE SYSTEM SHALL use it for filing text analysis and, separately, for sentiment text analysis.
3. IF no NLP provider or credentials are configured THEN THE SYSTEM SHALL support an explicitly identified demo or fallback mode.
4. THE SYSTEM SHALL record whether each result came from a real NLP provider or a fallback implementation.
5. THE SYSTEM SHALL NOT present demo or fallback results as genuine external analysis, and fallback or demo results SHALL NOT trigger sentiment adjustments or filing-risk alerts.
6. THE SYSTEM SHALL NOT use SEC filing text as input to SentimentIndex, and SHALL NOT use market sentiment text as input to FilingRiskScore.
7. THE SYSTEM SHALL enforce `nlp.timeoutMs` per request and handle timeouts per R33.7.

#### Requirement 31: FilingRiskScore Freshness and Validity

**User Story:** As a Risk Analyst, I want to know how old each filing score is, so that outdated disclosures are not mistaken for current risk.

##### Acceptance Criteria

1. THE SYSTEM SHALL store for each FilingRiskScore: the score calculation timestamp, the filing source date (filing date), the accession number, and the status.
2. THE SYSTEM SHALL compute filing score age as `now - filingDate` and classify the score `CURRENT` when age <= `filing.maxAgeDays` and `STALE` otherwise. `filing.maxAgeDays` is required configuration without a silent default (provisional recommendation in OD-6).
3. WHEN a stale score is displayed THEN THE SYSTEM SHALL label it stale together with the filing date. THE SYSTEM SHALL NOT present it as current.
4. IF no filing exists for an asset THEN THE SYSTEM SHALL report status `NO_FILING` and SHALL NOT display a score.
5. WHEN a newer 10-K or 10-Q for the same company is retrieved THEN THE SYSTEM SHALL recalculate the score, mark the previous score `SUPERSEDED`, and retain it for audit.
6. WHEN the scoring method or NLP provider configuration changes THEN THE SYSTEM SHALL permit recalculation and SHALL record the new scoring method version.
7. THE SYSTEM SHALL NOT use stale or non-current FilingRiskScores to generate filing-risk alerts (R34).
8. FilingRiskScore SHALL remain independent of VaR, Adjusted VaR, and the sentiment adjustment (R11).

### D. Market Sentiment

#### Requirement 9: Market Sentiment Data Ingestion

**User Story:** As a Quantitative Strategist, I want to ingest sentiment from external REST and WebSocket APIs, so sentiment changes can be monitored per asset.

##### Acceptance Criteria

1. WHEN a REST sentiment provider is configured THEN THE SYSTEM SHALL retrieve and normalize supported sentiment data.
2. WHEN a WebSocket sentiment provider is configured THEN THE SYSTEM SHALL connect and process incoming messages.
3. WHEN a message contains a supported ticker THEN THE SYSTEM SHALL associate it with that asset.
4. WHEN a WebSocket connection is interrupted THEN THE SYSTEM SHALL reconnect using the retry policy `sentiment.reconnect` (exponential backoff with jitter, configurable initial delay, maximum delay, and maximum attempts).
5. IF a duplicate, malformed, or invalid message is received THEN THE SYSTEM SHALL handle it without crashing. A duplicate is a message with the same provider message identifier, or, when none exists, the same provider, ticker, observation timestamp, and value.
6. THE SYSTEM SHALL record the provider, observation timestamp, and receipt timestamp of every valid observation.
7. THE SYSTEM SHALL mark every sentiment observation as `REAL` or `DEMO` and SHALL derive status `CURRENT`, `STALE`, or `UNAVAILABLE` from FR-8.
8. WHEN a message's observation timestamp is older than the latest accepted observation for the same ticker and provider THEN THE SYSTEM SHALL store it as history and SHALL NOT overwrite the current sentiment state.
9. WHEN a message's observation timestamp is more than `sentiment.maxFutureSkewSeconds` (financially significant; no default; proposed 5, see OD-6) in the future THEN THE SYSTEM SHALL reject it with a validation error.

#### Requirement 10: Sentiment Aggregation and Normalization

**User Story:** As a Quantitative Strategist, I want sentiment converted into a standardized Bullish/Bearish index, so it can be compared across assets.

##### Acceptance Criteria

1. WHEN valid observations are received THEN THE SYSTEM SHALL aggregate them into a ticker-specific SentimentIndex using a documented, versioned, deterministic aggregation function. The previously defined methodology (aggregation of valid observations into a normalized index) SHALL be preserved. The numeric aggregation formula (window, weighting) is an open decision (OD-1) and SHALL be approved before sentiment aggregation is implemented, without changing criteria 2 to 8. Any aggregation window SHALL be the explicitly configured `sentiment.windowSeconds` (financially significant; no default) and SHALL NOT exceed `sentiment.maxAgeSeconds`.
2. THE SYSTEM SHALL constrain every valid SentimentIndex to the inclusive range -1.00 to +1.00.
3. THE SYSTEM SHALL interpret -1.00 as Extreme Bearish, 0.00 as Neutral, and +1.00 as Extreme Bullish, and SHALL show the sign (bullish or bearish) explicitly in the dashboard.
4. WHEN new observations are received THEN THE SYSTEM SHALL update the corresponding sentiment state.
5. THE SYSTEM SHALL emit aggregated sentiment updates as follows. Three cadence levels are distinguished: (a) provider message arrival, which the application does not control and does not guarantee; (b) processed sentiment updates, which are state updates performed on arrival; (c) emitted application updates, which are batched by an application-controlled scheduler. Cadence (c) SHALL have a target interval of 3,000 ms. WHILE new observations have arrived since the previous emission and input is continuous, THE SYSTEM SHALL emit the aggregated update so that the p95 of the absolute deviation `|interval - 3000 ms|` between consecutive emissions is 500 ms or less, measured over a continuous five-minute observation window using the application's monotonic clock.
6. WHEN no new observation is available THEN THE SYSTEM SHALL emit no update for that ticker, SHALL retain the last valid score, and SHALL show its last update timestamp. The retained value SHALL become `STALE` once its age exceeds `sentiment.maxAgeSeconds` and SHALL be labelled stale (FR-8).
7. IF an external sentiment value is outside -1.00 to +1.00, not a finite decimal, or otherwise invalid THEN THE SYSTEM SHALL reject it and record a validation error. THE SYSTEM SHALL NOT clamp it into range.
8. WHILE the WebSocket is disconnected THEN THE SYSTEM SHALL continue the emission scheduler, SHALL age existing sentiment states, and SHALL apply the stale rule of criterion 6. WHEN the connection is re-established THEN THE SYSTEM SHALL resume without duplicating previously processed observations.

#### Requirement 11: Separation of Regulatory Risk and Market Sentiment

**User Story:** As a Quantitative Strategist, I want regulatory risk and market sentiment kept independent, so fundamentally different information is not incorrectly combined.

##### Acceptance Criteria

1. THE SYSTEM SHALL maintain FilingRiskScore and SentimentIndex as separate measurements with separate storage, status, and provenance.
2. THE SYSTEM SHALL use FilingRiskScore to represent severity of disclosed risk and SentimentIndex to represent the directional mood of market participants.
3. THE SYSTEM SHALL NOT interpret negative regulatory disclosures as bearish sentiment, and SHALL NOT interpret bullish sentiment as reducing filing risk.
4. WHEN both are available for an asset THEN THE SYSTEM SHALL make them independently available to the risk matrix (R17, R35).
5. **Invariant:** FilingRiskScore SHALL NOT affect VaR, Adjusted VaR, sentiment thresholds, downside multipliers, or the identification of sentiment-triggered assets.
6. THE SYSTEM SHALL NOT create a combined risk score from FilingRiskScore and SentimentIndex. A combined score requires a future, explicitly approved requirement that defines the formula, configuration, and tests.
7. THE SYSTEM MAY use FilingRiskScore for separate indicators, visualizations, and filing-risk alerts (R34).

### E. Market Data and Value-at-Risk

#### Requirement 12: Historical Market Data

**User Story:** As a Risk Analyst, I want historical prices for portfolio assets, so risk is calculated from actual market observations.

##### Acceptance Criteria

1. WHEN a supported asset is in a portfolio THEN THE SYSTEM SHALL support retrieval of its historical daily prices through a configurable, provider-independent market data interface.
2. THE SYSTEM SHALL retrieve for VaR a series of daily Adjusted Close prices, plus the latest Market Price for valuation.
3. THE SYSTEM SHALL normalize timestamps to calendar dates (the exchange trading date), ticker identifiers, and currency, and SHALL record the series currency.
4. THE SYSTEM SHALL calculate Daily Simple Returns using FR-2.
5. THE SYSTEM SHALL apply the data-cleaning rules in FR-3: missing, non-positive, non-finite, duplicate, and non-trading-date observations.
6. THE SYSTEM SHALL retain source, retrieval timestamp, and a content hash for each retrieved series.
7. THE SYSTEM SHALL support caching of historical data and SHALL label cached data with its retrieval time and status (R25).
8. THE SYSTEM SHALL NOT forward-fill prices or fabricate observations or returns.

#### Requirement 13: Insufficient Market Data Handling

**User Story:** As a Risk Analyst, I want incomplete history identified, so unreliable VaR is not presented as valid.

##### Acceptance Criteria

1. IF fewer than `var.minObservations` (explicitly configured; approved baseline value 200) valid common daily return observations are available THEN THE SYSTEM SHALL return calculation status `INSUFFICIENT_DATA`, SHALL NOT calculate VaR, and SHALL expose the observation count.
2. WHEN required prices are missing or invalid THEN THE SYSTEM SHALL identify each affected asset and, where relevant, the asset that limits the common history.
3. THE SYSTEM SHALL NOT fabricate historical prices, returns, or VaR.
4. WHEN a result is based on stale or reduced data THEN THE SYSTEM SHALL state the limitation: `REDUCED_LOOKBACK` when 200 to 249 observations were used, and `MARKET_DATA_STALE` when the as-of date is older than `marketData.maxStalenessDays`.
5. THE SYSTEM SHALL preserve the last valid VaR result and distinguish it from a current calculation by labelling it with its calculation timestamp and status `LAST_VALID`.
6. THE SYSTEM SHALL distinguish a Complete Lookback (250 observations, status `COMPLETE`) from a Reduced Lookback (200 to 249, status `REDUCED_LOOKBACK`).
7. THE SYSTEM SHALL expose a separate validity for Base VaR and for Adjusted VaR. Each is exactly one of `CURRENT`, `STALE`, `LAST_VALID`, or `UNAVAILABLE`; the two are never merged into one combined status.
   - **Base VaR validity:** `CURRENT` only for calculation status `OK`, calculated from the current inputs, without the `MARKET_DATA_STALE` flag. `STALE` when that flag is set. `LAST_VALID` for a retained earlier result. `UNAVAILABLE`, with no figure, for any other status (for example `INSUFFICIENT_DATA`, `FX_UNAVAILABLE`, `FX_STALE`, `DATA_CONFLICT`, `NO_POSITIONS`, `INVALID_INPUT`, or `CONFIG_MISSING`). A Reduced Lookback result with status `OK` is valid and MAY be `CURRENT`, with its `REDUCED_LOOKBACK` label shown.
   - **Adjusted VaR validity:** `UNAVAILABLE`, with no figure, when Base VaR is `UNAVAILABLE` (adjusted status `BASE_UNAVAILABLE`) or when R15.8 prevents its calculation (`ADJUSTMENT_CONFIG_MISSING` or `SENTIMENT_NOT_CURRENT`). Otherwise it has the same validity as the Base VaR it was calculated with. Base VaR MAY therefore be `CURRENT` while Adjusted VaR is `UNAVAILABLE`.

#### Requirement 14: Historical Simulation Value-at-Risk

**User Story:** As a Portfolio Manager, I want portfolio VaR from historical observations, so I can estimate potential losses under historical conditions.

##### Acceptance Criteria

1. WHEN sufficient market data, valid positions, and required FX rates are available THEN THE SYSTEM SHALL calculate Base VaR using Historical Simulation as defined in FR-4 to FR-7.
2. THE SYSTEM SHALL use an explicitly configured confidence level `var.confidence` (approved baseline value 0.95; no code default), supporting at least 0.95 and 0.99, and SHALL reject values that are not strictly between 0 and 1.
3. THE SYSTEM SHALL use a risk horizon of exactly one trading day in version 1 (`var.horizonDays = 1`). THE SYSTEM SHALL NOT apply square-root-of-time or any other horizon scaling, and SHALL reject any configured horizon other than 1.
4. THE SYSTEM SHALL use the explicitly configured lookback target `var.lookbackReturns` (approved baseline value 250 daily simple returns; no code default) (requiring at least 251 Adjusted Close prices per asset) and SHALL use the most recent 250 common valid returns when more are available.
5. THE SYSTEM SHALL generate position Scenario P&L, portfolio P&L, and Loss values per FR-5.
6. THE SYSTEM SHALL aggregate position Scenario P&L into portfolio daily P&L scenarios by summation.
7. THE SYSTEM SHALL sort Losses ascending and compute `VaR = Quantile(Losses, confidence)` using Hyndman and Fan Type 7 per FR-7. VaR is a loss quantile; the system SHALL NOT compute it as a quantile of returns or P&L without the sign conversion in FR-5.
8. THE SYSTEM SHALL report VaR as a non-negative value per FR-7 (negative quantiles are floored at zero and flagged `NO_LOSS_AT_CONFIDENCE`; the raw quantile SHALL also be retained).
9. THE SYSTEM SHALL provide absolute VaR in base currency and VaR as a percentage of NAV (FR-12). IF `NAV <= 0` THEN THE SYSTEM SHALL return percentage status `NAV_NOT_POSITIVE` and SHALL NOT display a percentage.
10. THE SYSTEM SHALL expose with each result the metadata in R14.12.
11. IF positions are empty or all net quantities are zero, or inputs are invalid THEN THE SYSTEM SHALL return a descriptive calculation status (`NO_POSITIONS`, `INVALID_INPUT`) rather than a misleading value.
12. Each VaR result SHALL expose: portfolio identifier, calculation timestamp, market data as-of date, confidence level, risk horizon, observation count, lookback target, completeness status, quantile method (`HYNDMAN_FAN_TYPE_7`), Base VaR, Adjusted VaR where applicable, currency, configuration version, and input data identifiers or hashes (R32).
13. THE SYSTEM SHALL describe VaR to users as a percentile-based loss estimate, not as maximum drawdown or the maximum possible loss.
14. IF any financially significant setting that Base VaR depends on is missing or invalid (`var.*`, `marketData.maxStalenessDays`, `marketData.maxReturnGapDays`, `fx.baseCurrency`, `fx.supportedCurrencies`, `fx.maxRateAgeSeconds`, `fx.provider`, `recalc.minValueChangePct`) THEN THE SYSTEM SHALL NOT calculate Base VaR or Adjusted VaR, SHALL record calculation status `CONFIG_MISSING` with the missing or invalid keys, SHALL report both validities `UNAVAILABLE` (R13.7), and SHALL keep any earlier result labelled `LAST_VALID`. A missing or invalid adjustment or sentiment setting (R15.1) does not affect Base VaR; it makes only Adjusted VaR unavailable (R15.8). Features that do not depend on these settings, such as import and position display, SHALL continue to operate.

#### Requirement 15: Bearish Sentiment Downside Adjustment

**User Story:** As a Quantitative Strategist, I want adverse sentiment on a position to increase its estimated downside, so that potential panic and illiquidity are reflected in Adjusted VaR.

##### Acceptance Criteria

1. THE SYSTEM SHALL require explicit configuration of `adjustment.bearishThreshold` (approved baseline value -0.60, valid range [-1, +1]) and `adjustment.multiplier` (approved baseline value 1.15, valid range >= 1), and of the sentiment settings the adjustment depends on: `sentiment.maxAgeSeconds` (FR-8), `sentiment.windowSeconds` (R10.1), and `sentiment.maxFutureSkewSeconds` (R9.9). These settings are financially significant and have no code defaults (see [Configuration](#configuration)). The adjustment itself is fixed behaviour: no setting can disable it, and whenever criterion 4 is met for an eligible position it SHALL be applied as specified.
2. THE SYSTEM SHALL evaluate eligibility per instrument. A sentiment value is eligible only if it is (a) valid and within [-1, +1], (b) from a `REAL` (non-demo) source, (c) `CURRENT` per FR-8, and (d) associated with that instrument.
3. THE SYSTEM SHALL compute `EffectiveSentiment` per FR-9: `RawSentiment` for a long position and `-RawSentiment` for a short position.
4. THE SYSTEM SHALL trigger the adjustment for a position if and only if sentiment is eligible and `EffectiveSentiment < adjustment.bearishThreshold` (strictly less). With threshold -0.60: sentiment -0.60 SHALL NOT trigger; sentiment -0.6001 SHALL trigger.
5. WHEN a position triggers THEN THE SYSTEM SHALL multiply only that position's negative Scenario P&L values by the multiplier and SHALL leave its non-negative values unchanged (FR-6).
6. THE SYSTEM SHALL handle multiple triggering positions independently and SHALL NOT affect non-triggering positions.
7. THE SYSTEM SHALL recalculate the full portfolio scenario P&L, Loss distribution, and Adjusted VaR from the adjusted position Scenario P&L. THE SYSTEM SHALL NOT multiply the portfolio VaR by the multiplier.
8. THE SYSTEM SHALL calculate Adjusted VaR only when every setting in criterion 1 is present and valid and every position with non-zero net quantity has eligible sentiment (criterion 2).
   - IF a setting in criterion 1 is missing or invalid THEN Adjusted VaR SHALL be `UNAVAILABLE` with adjusted status `ADJUSTMENT_CONFIG_MISSING` and the keys listed.
   - IF any such position's sentiment is stale, unavailable, invalid, demo, or not associated with it THEN Adjusted VaR SHALL be `UNAVAILABLE` with adjusted status `SENTIMENT_NOT_CURRENT`, listing each affected ticker and its sentiment status.
   - In both cases Base VaR SHALL still be calculated and MAY be `CURRENT` (R13.7), and ineligible sentiment SHALL NOT trigger an adjustment.
   - THE SYSTEM SHALL NOT substitute Base VaR for Adjusted VaR, SHALL NOT copy the Base VaR figure into the Adjusted VaR field, and SHALL NOT label an unadjusted figure as adjusted.
   - WHEN Adjusted VaR is calculated and no position triggers THEN Adjusted VaR equals Base VaR numerically and SHALL be reported as an adjusted figure with adjusted status `NONE_TRIGGERED`; when at least one position triggers the adjusted status is `APPLIED`.
9. THE SYSTEM SHALL calculate and persist Base VaR and Adjusted VaR as separately identifiable values, each with its own validity and status (R13.7). Base VaR SHALL be calculated whenever its own inputs and settings allow, independently of sentiment. A sentiment change SHALL NOT overwrite Base VaR.
10. THE SYSTEM SHALL identify the triggering instruments, their RawSentiment, EffectiveSentiment, direction, and the multiplier applied.
11. THE SYSTEM SHALL identify the multiplier as a configurable downside stress assumption and SHALL NOT claim it is a statistical estimate of volatility change.
12. THE SYSTEM SHALL apply the rule at instrument level on the netted signed position (R5.3) and SHALL NOT mix long and short exposure of one instrument. Net quantity zero means no exposure and no adjustment.
13. THE SYSTEM SHALL retain the last valid sentiment for display, labelled stale when appropriate, and SHALL NOT treat it as current for adjustment (R10.6).
14. FilingRiskScore SHALL NOT influence any criterion in this requirement (R11.5).

#### Requirement 16: Dynamic Portfolio Risk Recalculation

**User Story:** As a Trader, I want risk metrics to update when underlying data changes, so the dashboard reflects current exposure.

##### Acceptance Criteria

1. WHEN a position changes THEN THE SYSTEM SHALL recalculate affected risk metrics.
2. WHEN valid market price updates change position market values by at least `recalc.minValueChangePct` percent (financially significant; no default; proposed 0.10, see OD-6) since the last successfully stored calculation THEN THE SYSTEM SHALL update valuation and VaR exposures; smaller changes SHALL update valuation only. The change is cumulative and is measured against the per-position base-currency market values and the NAV of the last successfully stored snapshot: `sum over positions of |current value - baseline value| / |baseline NAV| * 100`, so opposite movements do not cancel; the comparison is inclusive (at or above). IF the baseline NAV is zero or negative THEN every valid price update that affects a non-flat position SHALL request recalculation. The baseline SHALL advance only after a successful calculation, and recalculation requests SHALL be coalesced (criterion 6). This threshold defines "material" in this document.
3. WHEN new historical market observations become available THEN THE SYSTEM SHALL make them available to the risk engine and recalculate on the next scheduled calculation.
4. WHEN an instrument's eligibility or triggered state per R15.4 changes THEN THE SYSTEM SHALL recalculate Adjusted VaR (Base VaR need not be recalculated if its inputs are unchanged).
5. WHEN a new FilingRiskScore becomes available THEN THE SYSTEM SHALL update the filing-risk information in the risk matrix and SHALL NOT recalculate VaR because of it.
6. THE SYSTEM SHALL coalesce recalculation requests so that at most one VaR calculation runs per portfolio at a time and at most one is queued per portfolio.
7. THE SYSTEM SHALL retain calculation timestamps and statuses for all results.

### F. Dashboard and Alerts

#### Requirement 17: Integrated Portfolio Risk Matrix

**User Story:** As a Portfolio Manager, I want portfolio exposure, VaR, sentiment, and filing risk in one dashboard, so I can understand the different risk factors.

##### Acceptance Criteria

1. THE SYSTEM SHALL display NAV, total long and short exposure, gross and net exposure, and cash (R20.6).
2. THE SYSTEM SHALL display asset-level market values (base currency) and allocation percentages per R20.
3. THE SYSTEM SHALL display Base VaR and Adjusted VaR separately (R35).
4. THE SYSTEM SHALL display the SentimentIndex per asset where valid data exists, with status, source type, and timestamp.
5. THE SYSTEM SHALL display the FilingRiskScore per asset where available, with filing date and status.
6. THE SYSTEM SHALL display asset-level risk contribution where it can be calculated. Risk contribution is defined as the asset's average Loss contribution in the scenarios at and above the VaR scenario neighbourhood; the exact method is an open decision (OD-10). WHERE not yet defined or not calculable THEN THE SYSTEM SHALL show "not available".
7. THE SYSTEM SHALL distinguish missing, stale, unavailable, and demo data (R35).
8. THE SYSTEM SHALL NOT combine sentiment and filing measurements into any single score.
9. THE SYSTEM SHALL provide data timestamps and calculation status for important displayed metrics.
10. WHEN a metric is unavailable, stale, or a retained last valid value THEN the API SHALL return the validity (R13.7), the status, and the reason, and SHALL return `null` instead of a figure when the validity is `UNAVAILABLE`. Reasons include the missing configuration keys for `CONFIG_MISSING`, `ADJUSTMENT_CONFIG_MISSING`, or `ALERT_CONFIG_MISSING`, and the affected tickers for `SENTIMENT_NOT_CURRENT`. The API SHALL return Base VaR and Adjusted VaR as two separate entries, each with its own validity and status. The dashboard SHALL show each entry's status as text beside it, SHALL NOT display an unavailable metric as a number or as zero, and SHALL NOT display the Base VaR figure in the Adjusted VaR panel. An earlier figure MAY be shown beside an unavailable entry only when labelled `LAST_VALID` with its calculation timestamp.

#### Requirement 18: Configurable Risk Alerts

**User Story:** As a Risk Analyst, I want alerts when portfolio risk exceeds configured limits, so I can identify dangerous exposure changes.

##### Acceptance Criteria

1. THE SYSTEM SHALL generate a VaR alert WHEN `AlertMetric / NAV * 100 > alerts.var.thresholdPct`, where `AlertMetric` is selected by the explicitly configured `alerts.var.metric` (`ADJUSTED` or `BASE`; approved baseline value `ADJUSTED`; no code default), evaluated on the one-day VaR at the configured confidence level. Comparison is strictly greater than.
2. `alerts.var.thresholdPct` SHALL be required configuration in the range (0, 100]. THE SYSTEM SHALL NOT assume a default (the former 15% example is withdrawn). THE SYSTEM SHALL NOT evaluate VaR alerts and SHALL report `ALERT_CONFIG_MISSING` if it is unset.
3. THE SYSTEM SHALL allow thresholds to be configured per portfolio.
4. THE SYSTEM SHALL assign each alert a severity (`WARNING`, `HIGH`, `CRITICAL`) according to R34.2.
5. IF `NAV <= 0` THEN THE SYSTEM SHALL NOT evaluate the percentage threshold, SHALL set status `NAV_NOT_POSITIVE`, and SHALL NOT produce a VaR alert on that evaluation.
6. THE SYSTEM SHALL NOT label VaR as maximum drawdown risk.
7. THE SYSTEM SHALL evaluate a VaR alert only when the figure selected by `alerts.var.metric` has validity `CURRENT` (R13.7): Adjusted VaR for `ADJUSTED`, Base VaR for `BASE`. A selected figure that is `STALE`, `LAST_VALID`, or `UNAVAILABLE` (including `INSUFFICIENT_DATA`, `FX_UNAVAILABLE`, `FX_STALE`, `DATA_CONFLICT`, `NO_POSITIONS`, `INVALID_INPUT`, `CONFIG_MISSING`, `ADJUSTMENT_CONFIG_MISSING`, `SENTIMENT_NOT_CURRENT`, and `BASE_UNAVAILABLE`) SHALL NOT produce, escalate, or re-arm a VaR alert. WHERE the metric is `ADJUSTED`, THE SYSTEM SHALL NOT fall back to Base VaR when Adjusted VaR is unavailable. THE SYSTEM SHALL record why each evaluation was skipped.

#### Requirement 19: Risk Alert Events

**User Story:** As a Trader, I want alerts on the dashboard when thresholds are exceeded, so I can react to changes.

##### Acceptance Criteria

1. WHEN an alert is generated THEN THE SYSTEM SHALL publish an event to the dashboard event bus.
2. THE SYSTEM SHALL include in each alert payload: unique alert identifier, alert type (`VAR` or `FILING_RISK`), source, portfolio identifier, severity, metric name, observed value and threshold (Canonical Decimal Strings), timestamp, and human-readable description.
3. WHERE a specific asset causes or contributes to an alert THEN THE SYSTEM SHALL include its ticker. For VaR alerts, the triggering instruments of R15.10 SHALL be included when applicable.
4. WHEN an alert is dismissed or resolved THEN THE SYSTEM SHALL preserve its history.
5. IF alert publication fails THEN THE SYSTEM SHALL NOT interrupt portfolio calculations, SHALL persist the alert before publishing, and SHALL apply the delivery policy of R34.7.

#### Requirement 34: Alert Reliability and Filing-Risk Alerts

**User Story:** As a Risk Analyst, I want alerts that fire once per breach and that separate market risk from filing risk, so that I am not flooded and not misled.

##### Acceptance Criteria

1. THE SYSTEM SHALL support two independent alert types: `VAR` (R18) and `FILING_RISK`. Each alert SHALL identify its type and source, and the two types SHALL use separate thresholds, state, cooldowns, and history.
2. THE SYSTEM SHALL assign VaR alert severity by `ratio = observedPct / thresholdPct`: `WARNING` for 1.00 < ratio < `alerts.severity.highRatio`, `HIGH` for `highRatio` <= ratio < `alerts.severity.criticalRatio`, and `CRITICAL` for ratio >= `criticalRatio`. Priority equals severity. The ratios are operational settings with provisional defaults 1.25 and 1.50, pending approval (OD-6).
3. THE SYSTEM SHALL generate a `FILING_RISK` alert WHEN an asset has a `CURRENT` (R31) FilingRiskScore from real analysis (not fallback) with `score >= alerts.filing.threshold` (required configuration in [0.00, 1.00]; no silent default). Severity for filing-risk alerts SHALL be `WARNING` unless `alerts.filing.criticalThreshold` is configured.
4. A `FILING_RISK` alert SHALL NOT change VaR, Adjusted VaR, or any sentiment-adjustment state (R11.5).
5. THE SYSTEM SHALL fire exactly one alert per threshold crossing. WHILE the metric stays above the threshold THEN THE SYSTEM SHALL NOT fire further alerts, except when severity escalates to a higher level, in which case it SHALL fire one new alert for that level.
6. THE SYSTEM SHALL re-arm an alert key (type, portfolio, and asset where applicable) only after the metric has been at or below `alerts.resetPct` (VaR) or `alerts.filing.resetThreshold` (filing risk), both explicitly configured with no default (recommended value equal to the corresponding threshold, see OD-6), AND `alerts.cooldownSeconds` (operational; provisional default 900, OD-6) has elapsed since the last alert for that key. Severity escalation bypasses the cooldown.
7. THE SYSTEM SHALL deliver alerts with at-least-once semantics: on publish failure it SHALL retry up to `alerts.delivery.maxRetries` times with exponential backoff and, if still failing, SHALL log the failure (without sensitive data), keep the alert in history with delivery status `FAILED`, and continue calculations.
8. THE SYSTEM SHALL de-duplicate delivery using the alert identifier so that retries do not produce duplicate dashboard entries.

#### Requirement 35: Signal Separation in Display

**User Story:** As a Portfolio Manager, I want sentiment, filing risk, Base VaR, and Adjusted VaR shown as separate dimensions, so I never mistake one signal for another.

##### Acceptance Criteria

1. THE SYSTEM SHALL display four separate risk dimensions: (1) market sentiment, (2) SEC filing risk, (3) Base VaR, and (4) Adjusted VaR.
2. THE SYSTEM SHALL NOT combine sentiment and filing risk into a single score, rank, color scale, or aggregate indicator.
3. WHEN filing risk is high and sentiment is bullish THEN THE SYSTEM SHALL show both values independently, and SHALL NOT visually imply that one offsets the other (for example no shared gauge, netting, or averaged color).
4. THE SYSTEM SHALL label each displayed value with its status: current, stale, unavailable, or demo/simulated, using text labels in addition to color.
5. THE SYSTEM SHALL list the assets that triggered the sentiment adjustment, with RawSentiment, EffectiveSentiment, and direction.
6. THE SYSTEM SHALL explain the relationship between Base VaR and Adjusted VaR. WHEN Adjusted VaR is available THEN it SHALL show the difference `AdjustedVaR - BaseVaR` and the triggering assets, or state that no position triggered (`NONE_TRIGGERED`). WHEN Adjusted VaR is unavailable THEN it SHALL state why (`ADJUSTMENT_CONFIG_MISSING` with the keys; `SENTIMENT_NOT_CURRENT` with the affected tickers and whether each one's sentiment is stale, unavailable, invalid, or demo; or `BASE_UNAVAILABLE`), and SHALL NOT show a difference.
7. THE SYSTEM SHALL use distinct scale descriptions: FilingRiskScore 0 (low) to 1 (high risk), and SentimentIndex -1 (bearish) to +1 (bullish).

### G. Governance, Audit, and Reproducibility

#### Requirement 21: Risk Score and Sentiment Validation

**User Story:** As a Risk Analyst, I want scores validated before use, so invalid results cannot contaminate the risk engine.

##### Acceptance Criteria

1. WHEN a FilingRiskScore is produced THEN THE SYSTEM SHALL verify it is a finite decimal in the inclusive range 0.00 to 1.00.
2. WHEN a SentimentIndex is produced THEN THE SYSTEM SHALL verify it is a finite decimal in the inclusive range -1.00 to +1.00.
3. IF a score is outside its range or not a finite decimal THEN THE SYSTEM SHALL reject it and record a descriptive validation error.
4. THE SYSTEM SHALL prevent rejected scores from entering risk calculations, alerts, or displays as valid values.
5. THE SYSTEM SHALL preserve source and timestamp of validated scores.

#### Requirement 22: Data Provenance and Auditability

**User Story:** As a Risk Analyst, I want the origin of financial data and calculations retained, so results can be reviewed.

##### Acceptance Criteria

1. THE SYSTEM SHALL retain source and timestamp for imported transactions, including source file hash.
2. THE SYSTEM SHALL retain filing identifiers (accession number, CIK), filing dates, source URLs, and analysis timestamps.
3. THE SYSTEM SHALL retain source, observation timestamp, and real or demo status for sentiment, market, and FX data. The base-currency identity rate is not observed data: it is recorded with source `BASE_CURRENCY`, source kind `IDENTITY`, and no observation timestamp (R30.5).
4. THE SYSTEM SHALL retain the calculation methodology and configuration version for each VaR result.
5. THE SYSTEM SHALL allow a risk calculation to be traced to its position snapshot, market observations, FX rates, and sentiment inputs (R32).
6. THE SYSTEM SHALL record ingestion errors, validation failures, provider failures, and calculation errors with timestamps and without sensitive data.

#### Requirement 32: Reproducibility and Calculation Snapshots

**User Story:** As a Risk Analyst, I want every VaR result reproducible from stored inputs, so it can be audited and verified.

##### Acceptance Criteria

1. THE SYSTEM SHALL persist a Calculation Snapshot for every Base VaR and Adjusted VaR result containing: position snapshot (instrument, signed quantity, market price, currency, base-currency value, the FX pair it was converted with, and the REAL or DEMO source kind of its price history); base currency and cash; the market-data staleness flag as determined for the calculation (R13.4); the adjustment and sentiment setting keys that were missing or invalid (R15.1, R15.8); identifiers or SHA-256 hashes of the price and return series; market-data as-of date; FX rates with pair, rate, observation timestamp and its basis, source, and source kind (the base-currency identity rate has source kind `IDENTITY` and no timestamp); sentiment values with timestamp, source, status, and REAL or DEMO flag; the FilingRiskScores displayed alongside the result, held in a separate `displayOnly` section flagged as not used in calculation; configuration version; confidence level; lookback target, minimum observations, maximum return gap (`marketData.maxReturnGapDays`), and observation count; risk horizon; quantile method; adjustment threshold and multiplier (or none when R15.1 settings are missing); the Adjusted VaR outcome (status, missing setting keys, and ineligible instruments); triggered instruments; algorithm version; and snapshot schema version. The calculation timestamp is stored with the snapshot but is not part of its hashed content (criterion 4). A change to this content after the first snapshot has been produced SHALL increment the snapshot schema version.
2. THE SYSTEM SHALL produce the same numerical Base VaR and Adjusted VaR from the same snapshot and configuration, as Canonical Decimal Strings.
3. THE SYSTEM SHALL define a canonical serialization of the snapshot: UTF-8 JSON; object keys sorted lexicographically by Unicode code point; arrays in defined order (positions by instrument identifier ascending; scenarios by date ascending; triggered instruments by identifier ascending); financial values as Canonical Decimal Strings; timestamps in UTC ISO 8601 with milliseconds; no insignificant whitespace.
4. THE SYSTEM SHALL compute `snapshotHash = SHA-256(canonical bytes of the calculation inputs)`, where the hashed content is the canonical snapshot excluding the calculation timestamp, any generated identifiers, and the `displayOnly` section, and SHALL store the hash with the result. The full snapshot, including `displayOnly`, SHALL be persisted unchanged. Because FilingRiskScores are only in `displayOnly`, a change in filing data SHALL NOT change the hash (R11.5).
5. WHEN the configuration or an input changes THEN THE SYSTEM SHALL produce a different configuration version or snapshot hash respectively.
6. THE SYSTEM SHALL claim byte-identical output only for the canonical snapshot serialization defined in criterion 3, and SHALL NOT claim it for other API responses.
7. THE SYSTEM SHALL assign a configuration version (monotonic integer plus SHA-256 of the canonical configuration) every time a calculation-relevant configuration value changes.

## Non-Functional Requirements

### Performance and Reliability

#### NFR-PERF-1: CSV Ingestion Benchmark Definition

This definition is referenced by R1.3 and R33.1.

1. **Fixture:** A single fixed, committed CSV file (under a tracked path such as `test/fixtures/`, see R27.11) with exactly 10,000 data rows (plus one header row), exactly 10 columns, and 0 invalid rows. The same fixture SHALL be used for every run. Suggested columns: `external_id`, `portfolio_id`, `trade_timestamp`, `ticker`, `type`, `quantity`, `price`, `currency`, `venue`, `note`.
2. **Timed scope:** From the file bytes already in memory to the completed normalized Transaction list and import summary, including decoding, parsing, column mapping, per-row validation, Decimal construction, and normalization. Excluded: file upload transfer, persistence, fixture generation, process start-up, and test setup.
3. **Procedure:** 3 warm-up runs (not measured), then 20 measured runs in the same process, with timing from a monotonic clock.
4. **Statistic:** p95 by the nearest-rank method, which is the 19th value of the 20 measured durations sorted ascending. Pass if p95 <= 500 ms.
5. **Environment record:** Every benchmark output SHALL record CPU model, core count, RAM, OS and version, and Node.js version. The reference hardware is not yet specified (OD-2); until it is, results are valid for the recorded local environment only.
6. **Realism note:** A streaming parse plus validation of about 1 MB (10,000 rows) is expected to be well below 500 ms on a modern developer machine; Decimal.js construction is the main variable cost. This expectation is unmeasured and SHALL be confirmed by the first baseline run.

#### Requirement 23: Dashboard Performance

**User Story:** As a Trader, I want the dashboard to stay responsive under live updates, so monitoring is not interrupted.

##### Acceptance Criteria

1. WHILE the dashboard receives the reference load (50 instruments, 20 price updates per second in total, and one sentiment emission every 3 seconds) THE SYSTEM SHALL render at 30 frames per second or more at the 5th-percentile frame rate, measured over five minutes on the reference environment.
2. THE SYSTEM SHALL batch or coalesce frequent updates to at most one render per animation frame.
3. THE SYSTEM SHALL re-render only components whose data changed, and SHALL NOT re-render the full dashboard for a single-asset update.
4. THE SYSTEM SHALL keep financial calculations separate from presentation components and run VaR calculations outside the UI rendering path (for example a worker or backend service).
5. WHILE external providers are unavailable THE SYSTEM SHALL keep the dashboard responsive and display provider status.

#### Requirement 33: Performance Budgets and Provider Resilience

**User Story:** As a System Administrator, I want measurable performance and failure behaviour, so slow or failing services do not harm the system.

##### Acceptance Criteria

Budgets are measured on the reference environment (OD-2) with a fixed fixture, 3 warm-up runs, and 20 measured runs, reporting p95 by the nearest-rank method. Values marked provisional SHALL be confirmed after a baseline measurement and recorded.

1. **CSV ingestion:** NFR-PERF-1 (p95 <= 500 ms for 10,000 rows).
2. **FIX ingestion:** p95 <= 750 ms for 10,000 messages in a fixed fixture (provisional).
3. **VaR calculation:** for 50 instruments and 250 scenarios, p95 <= 250 ms for Base plus Adjusted VaR; for 500 instruments and 250 scenarios, p95 <= 2,000 ms (provisional).
4. **Sentiment processing:** p95 <= 20 ms handler time per message (provisional); emission cadence per R10.5.
5. **WebSocket handling:** THE SYSTEM SHALL process messages through a bounded queue of at most `ws.maxQueueSize` (default 1,000) messages per connection. WHEN the queue is full THEN THE SYSTEM SHALL coalesce by retaining only the latest observation per provider and ticker, and if still full SHALL drop the oldest unprocessed messages, increment a dropped-message counter, and log it at most once per minute. Memory use SHALL stay bounded; the queue SHALL NOT grow without limit.
6. **SEC retrieval:** one overall deadline `sec.timeoutMs` (default 30,000) per retrieval, covering every redirect hop, DNS resolution, rate-limit waits, retries and their waits, and body streaming; maximum response size `sec.maxResponseBytes` (default 25 MiB), enforced on the streamed body with no compression requested; maximum redirects `sec.maxRedirects` (default 3). On timeout or oversize THEN THE SYSTEM SHALL abort the request and report `SEC_TIMEOUT` or `SEC_RESPONSE_TOO_LARGE`.
7. **NLP processing:** request timeout `nlp.timeoutMs` (default 60,000), with at most `nlp.maxRetries` retries (default 2). On final failure THEN THE SYSTEM SHALL report `NLP_FAILED` and SHALL NOT generate a score.
8. **Dashboard updates:** per R23.
9. **Isolation:** THE SYSTEM SHALL execute SEC, NLP, market data, and FX calls asynchronously with timeouts so that a slow or failing external service does not block unrelated portfolio calculations or the dashboard.
10. **Outages:** WHEN a provider is unavailable THEN THE SYSTEM SHALL retain the last valid data marked stale, SHALL NOT fabricate data, and SHALL NOT use stale data where current data is required (R15.2, R30.8, R13).

#### Requirement 25: External Provider Reliability

**User Story:** As a System Administrator, I want provider failures handled gracefully, so one unavailable integration does not bring down the application.

##### Acceptance Criteria

1. WHEN an external market data, FX, SEC, sentiment, or NLP provider becomes unavailable THEN THE SYSTEM SHALL report provider status and continue operating.
2. WHEN a request fails with a retryable error (network error, attempt timeout, HTTP 429, 5xx) THEN THE SYSTEM SHALL retry with exponential backoff and jitter up to `provider.maxRetries` (default 3) additional attempts, so a call makes at most `1 + provider.maxRetries` provider calls, honoring `Retry-After`. Non-retryable errors (HTTP 4xx other than 429, invalid responses, cancellation, an open circuit, and unexpected exceptions) SHALL NOT be retried. The delay before retry `r` (zero-based) SHALL be a full-jitter delay, a random value from 0 to `min(provider.backoff.maxMs, provider.backoff.baseMs * 2^r)`; WHEN the response carries `Retry-After` (integer seconds or an HTTP date, evaluated against wall-clock time) THEN the delay SHALL be the larger of that value and the backoff delay. IF a valid `Retry-After` exceeds `provider.retryAfter.maxMs` (default 600,000) THEN THE SYSTEM SHALL stop immediately, without waiting, and SHALL return that response's own classification: `RATE_LIMITED` for HTTP 429, and `HTTP_SERVER_ERROR` with its HTTP status for 5xx (which counts toward the circuit breaker, R25.8); it SHALL NOT shorten the requested wait and retry earlier. WHEN no retries remain THEN the final error SHALL be unchanged by this limit. TLS and certificate verification failures (`TLS_ERROR`) SHALL NOT be retried.
3. THE SYSTEM SHALL preserve previously stored valid data when new data cannot be retrieved.
4. THE SYSTEM SHALL label stale, cached, unavailable, and demo data.
5. THE SYSTEM SHALL NOT silently replace missing real data with fabricated results.
6. THE SYSTEM SHALL return descriptive errors including provider name, operation, and error code, without secrets.
7. **Timeouts and cancellation.** THE SYSTEM SHALL bound every provider attempt by `provider.timeoutMs` (default 10,000), which a provider-specific timeout (for example `sec.timeoutMs`, `nlp.timeoutMs`) MAY replace, and SHALL support an optional overall deadline for the complete call, measured with monotonic time. THE SYSTEM SHALL NOT start an attempt or wait for a retry beyond that deadline; it SHALL return the last failure instead. A call that does not settle within its attempt timeout SHALL fail as a timeout even if the provider never cooperates with cancellation, and a late result or rejection from it SHALL be ignored safely. WHEN the caller cancels a call THEN THE SYSTEM SHALL abort the current attempt or retry wait immediately, SHALL NOT retry, and SHALL report `CANCELLED`.
8. **Circuit breaker.** THE SYSTEM SHALL keep an in-memory circuit per provider. A complete call (after its retries) that ends in a network error, timeout, HTTP 5xx, invalid response, or TLS error SHALL count as a qualifying failure; rate limiting, other HTTP 4xx, cancellation, and unexpected exceptions SHALL NOT count, and a successful call SHALL reset the count. After `provider.circuit.failureThreshold` (default 5) consecutive qualifying failures the circuit SHALL open, and calls SHALL fail with `CIRCUIT_OPEN` without contacting the provider. After `provider.circuit.openMs` (default 60,000) exactly one half-open probe call SHALL be allowed: success closes the circuit; any other result SHALL be returned to the probe's caller and SHALL reopen the circuit for a fresh full `provider.circuit.openMs`, after which exactly one probe is again allowed. A non-qualifying probe result SHALL NOT be counted as a qualifying failure. Provider status SHALL be `AVAILABLE` while the circuit is closed and no call is retrying, `DEGRADED` while a call is retrying or the circuit is half-open, and `UNAVAILABLE` while it is open.
9. IF a provider call raises an unexpected exception THEN THE SYSTEM SHALL fail it with the non-retryable code `UNEXPECTED_ERROR`, SHALL return a generic error without the original message, and SHALL log the original exception through the redacting logger. Unexpected exceptions SHALL NOT be reported as network errors.

### Security

#### Requirement 24: Credential and Application Security

**User Story:** As a System Administrator, I want credentials stored securely, so integrations cannot expose private information.

##### Acceptance Criteria

1. THE SYSTEM SHALL NOT hardcode API keys, private keys, or credentials in source files.
2. THE SYSTEM SHALL read sensitive configuration from environment variables or a secrets manager.
3. THE SYSTEM SHALL provide `.env.example` with placeholder values only.
4. THE SYSTEM SHALL exclude `.env` files and credentials from version control (already configured in `.gitignore` and `.kiroignore`; this SHALL be preserved).
5. THE SYSTEM SHALL NOT expose private API credentials through frontend code or client responses.
6. THE SYSTEM SHALL validate uploaded files and incoming external payloads (schema, types, sizes).
7. THE SYSTEM SHALL NOT write credentials, tokens, or full authorization headers to logs (R29.12).
8. THE SYSTEM SHALL use TLS (HTTPS and WSS) with certificate validation for external connections, and SHALL NOT disable certificate verification.

#### Requirement 29: Access Control, Input Safety, and SSRF Protection

**User Story:** As a System Administrator, I want access control, safe inputs, and protected outbound requests, so that the application cannot be abused or leak data.

##### Acceptance Criteria

**Implementation dependency:** The repository currently has no authentication or authorization implementation. Criteria 1 to 3 describe required behaviour once the application is network-accessible or multi-user; the mechanism is an open decision (OD-7). This document does not claim that authentication exists today.

1. WHERE the application is accessible beyond a single local user THEN THE SYSTEM SHALL require authentication for all API, upload, and WebSocket endpoints.
2. THE SYSTEM SHALL enforce authorization per portfolio and per role (at minimum: read-only viewer, analyst who can import and configure, administrator who can manage providers and secrets), and SHALL deny by default.
3. IF a request is unauthenticated or unauthorized THEN THE SYSTEM SHALL return an error that does not reveal whether the resource exists.
4. THE SYSTEM SHALL enforce upload limits per R28.4 and apply rate limiting `api.rateLimitPerMinute` (default 60 requests per client per minute; uploads `api.uploadRateLimitPerMinute` default 10) returning HTTP 429.
5. THE SYSTEM SHALL validate all input on the server (types, ranges, lengths, enumerations) and reject unknown fields in configuration updates.
6. THE SYSTEM SHALL sanitize uploaded filenames, never use them to build file system paths, and store uploads under generated names.
7. THE SYSTEM SHALL neutralize spreadsheet formula injection in any CSV export by prefixing with a single quote (`'`) every cell whose first character is `=`, `+`, `-`, `@`, TAB (U+0009), or CR (U+000D). **Decimal exception:** a cell that begins with `-` and whose entire content matches the existing decimal grammar of `DecimalStringSchema` (R4.6; for example `-12.5` or `-0.001`) SHALL be left unchanged, so negative financial values stay numeric; any other cell beginning with `-` (for example `-1+1`) SHALL be prefixed. A cell that already begins with `'` SHALL be left unchanged, so neutralization is idempotent. Neutralization applies per cell and does not trim, quote, escape, or map Unicode look-alike characters.
8. **SEC URL validation (SSRF).** THE SYSTEM SHALL accept a user-supplied SEC URL only if it satisfies all of: it parses as a URL; scheme `https`; host exactly `www.sec.gov` or `data.sec.gov`; port 443 (explicit or implicit); no embedded credentials (no userinfo at all, even empty); no fragment. The host SHALL be compared after IDNA normalization to ASCII, by exact equality with one of the two allowlisted names; suffix, prefix, or substring matching SHALL NOT be used, and a hostname with a trailing dot (`www.sec.gov.`) SHALL be rejected. THE SYSTEM SHALL reject unparseable URLs, HTTP URLs, non-SEC hosts (including look-alike hosts such as `www.sec.gov.example.com`), unsupported ports, URLs containing credentials, and URLs containing a fragment, each with one reason from the fixed set in the design (`SecUrlRejectionReason`).
9. THE SYSTEM SHALL resolve all A and AAAA records of the hostname before connecting and SHALL reject the request if any resolved address is not a globally reachable unicast address under the fixed address policy in the design (pinned to the IANA IPv4 and IPv6 Special-Purpose Address Registries, Last Updated 2025-10-09). The prohibited addresses include at least loopback, private (RFC 1918), link-local, unique-local IPv6, CGNAT, multicast, unspecified, and every IPv4-mapped IPv6 address. IF neither family returns a record THEN THE SYSTEM SHALL reject the request with reason `DNS_EMPTY`; IF a lookup fails for any other reason THEN THE SYSTEM SHALL reject it with reason `DNS_FAILED`. A lookup that does not complete in time (the resolver's own timeout, or the retrieval deadline of R33.6) is not a DNS failure: THE SYSTEM SHALL end the request with `SEC_TIMEOUT`, SHALL NOT connect, and SHALL NOT report it, then or later, as a `DNS_FAILED` rejection; a prohibited address in the answers SHALL still be rejected as `ADDRESS_PROHIBITED`. THE SYSTEM SHALL connect only to a validated address, SHALL keep the normalized allowlisted hostname for TLS certificate verification and the TLS server name (SNI), and SHALL NOT resolve the hostname again outside this validation, to prevent DNS rebinding. IP-literal hosts SHALL be rejected.
10. THE SYSTEM SHALL follow at most `sec.maxRedirects` redirects and SHALL validate every redirect destination independently against criteria 8 and 9. A redirect to a non-allowlisted host, to a non-HTTPS URL, or to a prohibited address SHALL abort the request with `SEC_URL_REJECTED`.
11. THE SYSTEM SHALL NOT allow user input to cause outbound requests to any destination other than those allowed in criteria 8 to 10.
12. THE SYSTEM SHALL redact secrets, tokens, authorization headers, API keys, and personal or account identifiers (for example FIX account tags) from logs and error messages.
13. THE SYSTEM SHALL return generic error messages to clients for internal failures and keep stack traces and internal paths out of responses.
14. WHEN an SEC URL or address is rejected under criteria 8 to 10 THEN THE SYSTEM SHALL emit a security event (audited with category `SECURITY`) that contains no part of the user-supplied URL. IF the event cannot be delivered THEN the request SHALL still be rejected, and THE SYSTEM SHALL report the delivery failure rather than report the event as recorded.

### Architecture and Verification

#### Requirement 26: Modular Application Architecture

**User Story:** As a Developer, I want responsibilities kept modular, so providers, calculations, and UI can be maintained independently.

##### Acceptance Criteria

1. THE SYSTEM SHALL separate responsibilities for file ingestion, transaction normalization, portfolio management, market data retrieval, FX, SEC retrieval, NLP, sentiment processing, risk calculation, alert management, and dashboard presentation.
2. THE SYSTEM SHALL keep core financial calculations independent of presentation components.
3. THE SYSTEM SHALL support interchangeable provider implementations through interfaces (market data, FX, sentiment, SEC, NLP).
4. THE SYSTEM SHALL be written in TypeScript with `strict: true` and SHALL use ES modules: `package.json` `"type": "module"`, TypeScript `module: "NodeNext"`, `moduleResolution: "NodeNext"`, and `verbatimModuleSyntax: true` (approved decision, OD-11). The repository's current `"type": "commonjs"` SHALL be changed during project setup.
5. THE SYSTEM SHALL avoid unnecessary dependencies, SHALL pin every added dependency to an exact version (no `^` or `~` ranges), and SHALL commit the npm lockfile.
6. THE SYSTEM SHALL remain buildable and runnable (`npm install` and `npm test` succeed) throughout implementation.
7. THE SYSTEM SHALL use Node.js 24 as the primary development baseline, pinned to 24.22.1 for the initial environment (via `engines` and a Node version file), and SHALL use this toolchain: Zod 4, Decimal.js, Vitest, fast-check, ESLint with typescript-eslint, Prettier, and dependency-cruiser.
8. THE SYSTEM SHALL compile application code with `tsc` into `dist/`. Runtime entry points, including every `worker_threads` worker, SHALL be compiled JavaScript files in `dist/`, resolved relative to the compiled module (for example `new URL('./riskWorker.js', import.meta.url)`), and SHALL NOT require a TypeScript loader at runtime.
9. THE SYSTEM SHALL use React with Vite for the dashboard and Fastify 5 for the HTTP and WebSocket API, pinned to an exact version (5.12.8 at resolution; OD-17 Resolved).
10. THE SYSTEM SHALL enforce module boundaries with dependency-cruiser as part of the build. At minimum, `risk/` SHALL NOT import `sec/` or `nlp/`; domain modules SHALL NOT import adapters, persistence implementations, `api/`, or `web/`; and `web/` SHALL NOT import domain modules (R11.5, R26.1, R26.2).

#### Requirement 27: Testing and Verification

**User Story:** As a Developer, I want major functionality and financial calculations tested, so incorrect results and regressions are found before release.

##### Acceptance Criteria

1. THE SYSTEM SHALL include unit tests for transaction parsing, validation, financial calculations, sentiment normalization, filing risk scoring, quantile calculation, allocation, FX conversion, and alert logic.
2. THE SYSTEM SHALL include integration tests for CSV and FIX ingestion.
3. THE SYSTEM SHALL include integration tests for SEC, market data, FX, and sentiment providers using recorded fixtures or local test servers. Tests that need live network access SHALL be separate and opt-in.
4. THE SYSTEM SHALL include property-based tests for financial precision, score boundaries, allocation sums, and quantile monotonicity.
5. THE SYSTEM SHALL include an end-to-end test, written with Playwright, showing that a position change updates dashboard risk metrics.
6. THE SYSTEM SHALL verify Historical Simulation VaR against hand-calculated expected values (see the Acceptance Test Matrix).
7. THE SYSTEM SHALL verify the sentiment adjustment boundary: -0.60 yields multiplier 1.00, -0.6001 yields 1.15, and -0.75 triggers.
8. THE SYSTEM SHALL verify that fewer than 200 observations yield `INSUFFICIENT_DATA`.
9. THE SYSTEM SHALL verify that invalid scores cannot enter the risk engine.
10. THE SYSTEM SHALL provide a documented command (`npm test`) that runs the automated tests and exits non-zero on failure. The current placeholder `test` script in `package.json` does not satisfy this and SHALL be replaced during implementation.
11. THE SYSTEM SHALL keep all committed test fixtures outside paths excluded by `.gitignore` and `.kiroignore` (`data/private/`, `data/raw/`, `*.db`, and similar). The CSV benchmark fixture SHALL live under a tracked path such as `test/fixtures/`.
12. THE SYSTEM SHALL run continuous integration on Node.js 24.22.1 (primary) and Node.js 26 (compatibility), and a change SHALL NOT be considered passing unless both succeed.
13. THE SYSTEM SHALL run type-checking (`tsc --noEmit`), ESLint, a Prettier format check, the dependency-cruiser boundary check, and the automated tests in continuous integration, and each SHALL fail the build on error.

## Data and Financial Rules

These rules are normative. All arithmetic uses Decimal.js (R4).

### FR-1: Notation

- `n` is the number of valid scenarios. `i = 1..n` indexes scenarios in ascending date order.
- `p` is the confidence level (`var.confidence`), `0 < p < 1`.
- Position `k` has signed base-currency exposure `E[k] = SignedQuantity[k] * MarketPrice[k] * Rate(X/B)`. Short positions have negative exposure.

### FR-2: Returns

`Return[k][t] = AdjustedClose[k][t] / AdjustedClose[k][t-1] - 1`, where `t-1` is the previous Common Trading Date (FR-3). Returns are unitless Decimals.

### FR-3: Market data cleaning and alignment

1. An observation is valid only if its date is a valid calendar date, is not a weekend (exchange holiday calendars are an open decision, OD-3), and its Adjusted Close is a finite Decimal strictly greater than 0.
2. Observations that are missing, non-positive, non-finite, or on non-trading dates SHALL be discarded and counted. They SHALL NOT be filled.
3. Duplicate dates with identical prices SHALL be collapsed to one observation. Duplicate dates with conflicting prices SHALL make that asset series invalid (`DATA_CONFLICT`); VaR SHALL be unavailable and the asset SHALL be identified.
4. The Common Trading Dates are the intersection of valid dates across all assets with non-zero net quantity. Prices SHALL NOT be forward-filled and returns SHALL NOT be fabricated.
5. A return is calculated between consecutive Common Trading Dates. IF the calendar gap between them exceeds `marketData.maxReturnGapDays` (financially significant; no default; proposed 5, see OD-6) THEN that return SHALL be discarded (not interpolated). Returns that span more than one trading day for any asset because of another asset's missing date SHALL be counted in metadata as `multiDayReturnCount`.
6. The as-of date is the latest Common Trading Date. The newest 250 valid returns ending at the as-of date form the lookback. At least 251 aligned Adjusted Close prices are required for a Complete Lookback, and at least 201 for the minimum of 200 returns.
7. IF the available returns are fewer than 200 THEN status is `INSUFFICIENT_DATA`. IF between 200 and 249 THEN status is `REDUCED_LOOKBACK`. IF 250 or more (the newest 250 are used) THEN status is `COMPLETE`.
8. THE SYSTEM SHALL identify the asset with the shortest valid history as the limiting asset in the result metadata.

### FR-4: Exposure

Exposure uses the latest Market Price (unadjusted) and the FX rate (R30.7). Adjusted Close is used only for returns.

### FR-5: Scenario P&L and Loss

```
PositionScenarioPnL[k][i] = E[k] * Return[k][i]
PortfolioPnL[i]           = sum over k of PositionScenarioPnL[k][i]
Loss[i]                   = -PortfolioPnL[i]
```

For a short position `E[k] < 0`, so a rising price (positive return) produces a negative P&L. Cash contributes zero P&L.

### FR-6: Adjusted scenario P&L

For each position `k` that is triggered (R15.4):

```
AdjPositionScenarioPnL[k][i] = PositionScenarioPnL[k][i] * m   if PositionScenarioPnL[k][i] < 0
AdjPositionScenarioPnL[k][i] = PositionScenarioPnL[k][i]       otherwise
```

where `m = adjustment.multiplier`. Non-triggered positions are unchanged. `AdjPortfolioPnL[i]` and `AdjLoss[i]` are computed with FR-5 using the adjusted position values, and Adjusted VaR is calculated by FR-7 on `AdjLoss`.

### FR-7: VaR quantile (Hyndman and Fan Type 7)

1. Sort Loss values ascending: `x[1] <= x[2] <= ... <= x[n]` (one-based order statistics).
2. `h = 1 + (n - 1) * p`, `j = floor(h)`, `gamma = h - j`. The value `h` is computed with Decimal.js; `j` is a native integer obtained from `floor(h)`.
3. `Q(p) = (1 - gamma) * x[j] + gamma * x[j + 1]`.
4. Endpoint handling: since `0 < p < 1`, `1 < h < n` for `n >= 2`, hence `1 <= j <= n - 1` and `x[j + 1]` always exists. IF `gamma = 0` THEN `Q(p) = x[j]` and `x[j + 1]` is not used. A defensive guard SHALL treat `j >= n` as `Q(p) = x[n]`. `n < 2` SHALL be rejected as `INSUFFICIENT_DATA`.
5. `RawQuantile = Q(p)`. Reported `VaR = max(RawQuantile, 0)`; if `RawQuantile < 0` the flag `NO_LOSS_AT_CONFIDENCE` SHALL be set.
6. `VaR% = VaR / NAV * 100` when `NAV > 0`.
7. Worked indices: `n = 250, p = 0.95`: `h = 237.55, j = 237, gamma = 0.55`, so `VaR = 0.45 * x[237] + 0.55 * x[238]`. `n = 250, p = 0.99`: `h = 247.51, j = 247, gamma = 0.51`, so `VaR = 0.49 * x[247] + 0.51 * x[248]`. `n = 200, p = 0.95`: `h = 190.05, j = 190, gamma = 0.05`. `n = 249, p = 0.95`: `h = 236.6, j = 236, gamma = 0.6`.
8. Sorting SHALL be numerically exact (Decimal comparison) and stable.

### FR-8: Data freshness status

- Sentiment status: `CURRENT` if `now - observationTimestamp <= sentiment.maxAgeSeconds`; `STALE` if older; `UNAVAILABLE` if never received or invalid. `DEMO` is a separate source flag; demo data is never `CURRENT` for adjustment or alert purposes.
- `sentiment.maxAgeSeconds` is required configuration; a provisional recommendation is in OD-6.
- Market data status: `MARKET_DATA_STALE` if the as-of date is more than `marketData.maxStalenessDays` calendar days before the calculation date. This setting is required configuration with no default; the proposed value 5 is listed in OD-6.
- FX status: per R30.8.
- Filing status: per R31.2.

### FR-9: Direction-aware sentiment

```
EffectiveSentiment = RawSentiment      for SignedQuantity > 0 (long)
EffectiveSentiment = -RawSentiment     for SignedQuantity < 0 (short)
Trigger  <=>  EffectiveSentiment < adjustment.bearishThreshold   (strict)
```

Positions are netted per instrument before evaluation. A zero net quantity has no exposure and no trigger.

### FR-10: Allocation denominator and exposure measures

```
LongValue    = sum of E[k] for E[k] > 0
ShortValue   = sum of |E[k]| for E[k] < 0
Cash         = portfolio cash balance in base currency, supplied explicitly per portfolio (may be "0" or negative; never defaulted, see A-7)
AllocationDenominator = LongValue + max(Cash, 0)
GrossExposure = LongValue + ShortValue
NetExposure   = LongValue - ShortValue
```

### FR-11: Largest-remainder allocation (eligible portfolios)

1. Compute exact percentages `P[k] = Value[k] / AllocationDenominator * 100` using Decimal.js, including the `CASH` line when `Cash > 0`.
2. `Floor[k] = P[k]` rounded down (ROUND_DOWN) to two decimal places.
3. `RemainingUnits = (100.00 - sum(Floor[k])) / 0.01`, an integer by construction.
4. Compute `Remainder[k] = P[k] - Floor[k]`. Sort by `Remainder` descending, with ties broken by ascending ticker (lexicographic; `CASH` last).
5. Add 0.01 to the first `RemainingUnits` entries of that order.
6. Result: sum is exactly 100.00. This rule supersedes independent rounding. Example: three equal assets give `{33.34, 33.33, 33.33}` with the extra 0.01 assigned to the lexicographically first ticker.

### FR-12: NAV

`NAV = sum of signed E[k] over all positions + Cash`. `VaR%` and alert percentages use `NAV` (R14.9, R18.1). If `NAV <= 0`, percentage values are not calculated.

### FR-13: Average price

Notation: `qty` is the signed quantity before the transaction, `q` the (positive) transaction quantity, `price` its price, and `avgPrice` the average price before the transaction.

1. **Increase (BUY on a flat or long position).** `avgPrice = (qty * avgPrice + q * price) / (qty + q)`. On a flat position (`qty = 0`) this is `price`.
2. **Reduction (SELL with `q <= qty` on a long position).** Average price is unchanged.
3. **Short positions** follow the same rules on the absolute quantity: a SELL on a flat or short position is an increase, `avgPrice = (|qty| * avgPrice + q * price) / (|qty| + q)`; a BUY with `q <= |qty|` on a short position is a reduction and leaves average price unchanged.
4. **Zero quantity.** When a position reaches zero quantity, average price is reset to `null` (no average price; never `"0"`). The position is retained with signed quantity `"0"`, `averagePrice: null`, and `isShort: false`.
5. **Reversal (crossing zero).** When a single transaction reduces a position by more than its absolute quantity (a SELL with `q > qty` on a long, or a BUY with `q > |qty|` on a short), it first closes the existing position (rule 4) and the remainder `q - |qty|` opens a position in the opposite direction with `avgPrice = price` of that reversing transaction.
6. **Precision.** Average price is computed with Decimal.js under FR-14 (`precision = 40`, `ROUND_HALF_UP`); a non-terminating quotient is therefore held to 40 significant digits. It is not rounded further and is serialized as a Canonical Decimal String. Because positions are rebuilt by full replay (R5.6), the same ledger always yields the same average price.
7. This rule computes signed quantity, average price, and the short flag only. Whether a SELL beyond the available quantity is allowed is decided by `import.oversellPolicy` before the transaction enters the ledger (R28.20, R28.21).

Cost-basis accounting beyond this (tax lots) is out of scope.

### FR-14: Precision and rounding

- Decimal.js: `precision = 40`, `rounding = ROUND_HALF_UP`. No intermediate rounding.
- Monetary display values are rounded ROUND_HALF_UP to the currency's minor unit (2 decimals by default, 0 for JPY).
- Allocation percentages display to 2 decimals via FR-11 (eligible) or ROUND_HALF_UP (ineligible).
- Sentiment and filing scores display to 2 decimals (ROUND_HALF_UP) but eligibility comparisons use the unrounded stored value.
- Serialization uses Canonical Decimal Strings.

## Configuration

All values are validated at load time with Zod. Invalid values SHALL prevent the affected feature from starting and SHALL produce a descriptive error.

### Configuration policy

1. **Financially significant settings** are settings that affect valuations, positions, risk calculations, data eligibility for risk calculations, or alert decisions. They SHALL be supplied explicitly and validated. The application SHALL NOT contain code defaults for them. IF one is missing THEN the loader SHALL report the missing key, SHALL NOT substitute any value, and the feature that depends on it SHALL NOT start (for example `ALERT_CONFIG_MISSING` in R18.2, or import refused in R28.20).
2. **Approved baseline values** are values approved in the requirements: `var.confidence` 0.95, `var.horizonDays` 1, `var.lookbackReturns` 250, `var.minObservations` 200, `adjustment.bearishThreshold` -0.60, `adjustment.multiplier` 1.15, and `alerts.var.metric` `ADJUSTED`. There is no setting that enables or disables the downside adjustment (R15.1). These values are still supplied explicitly, never as code defaults. A committed configuration template (`config/config.template.jsonc`, created in phase 1) SHALL contain exactly these values.
   - **Conditionally approved values (decision record DR-FX-1):** `fx.baseCurrency` `EUR` and `fx.provider` `ECB`. They take effect for real use only when OD-5 is resolved (live ECB query check and legal confirmation, R30.14) and task 10.2 is delivered; until then they are not approved baseline values, development and tests use `fx.provider` `FIXTURE` with explicit test values, and the template documents them in comments while keeping `fx.baseCurrency` as a placeholder (the `fx.provider` key enters the template with task 10.2). Like every financially significant setting, they are supplied explicitly in the runtime configuration and never as code defaults. Before risk results or snapshots are compared or reused across a change of `fx.baseCurrency`, THE SYSTEM SHALL check configuration-version compatibility (R32.5, R32.7); results from a different base currency SHALL NOT be compared or reused as if they were in the current base.
3. **Proposed values** for financially significant settings that are not yet approved are listed in OD-6. The configuration template SHALL leave them as empty placeholders with the proposal in a comment, so an operator must make an explicit choice.
4. **Operational settings** (limits, timeouts, retries, rate limits, alert cooldown, severity ratios) MAY have documented defaults. A default marked *provisional* is pending approval (OD-6) and SHALL be reported as provisional in the configuration summary logged at start.
5. **Fixed values** are not configurable in version 1.
6. **The template is not a runtime source.** The application SHALL read configuration only from the runtime configuration file named explicitly by the operator. It SHALL NOT read the committed template, SHALL NOT merge template values into the runtime configuration, and SHALL refuse a runtime path that resolves to the template. A missing runtime file is treated as every setting missing (criterion 1): dependent features stay disabled, and features that need no financially significant settings continue to run.
7. **Demo configuration (DR-KW-1, H3).** A demonstration configuration is a separate runtime file marked by `demo.profile` (`KIROWEEN_2026_DEMO`; the committed one is `config/demo/kiroween-2026.demo.jsonc`). It is never the template and never supplies a default to another configuration. A configuration with the marker SHALL start only in the explicit demo mode (`--demo-fixtures`); any other start is refused with `DEMO_CONFIG_OUTSIDE_DEMO_MODE`. Every value it fills in for a setting without an approved value SHALL be listed in `demo.provisionalKeys` (known, non-`demo.*` keys, unique), and the list with each key's status SHALL be logged at start. The marker has no other effect: missing or invalid settings follow criterion 1 unchanged.

Class key: **F** financially significant (required, no default), **O** operational (documented default), **X** fixed.

| Parameter | Class | Default or value | Validation | Used by |
|---|---|---|---|---|
| `var.confidence` | F | No default. Approved baseline 0.95 | Decimal, 0 < x < 1; 0.95 and 0.99 supported | R14.2 |
| `var.horizonDays` | F | No default. Must be supplied as 1 | Must equal 1 in v1 | R14.3 |
| `var.lookbackReturns` | F | No default. Approved baseline 250 | Integer >= `var.minObservations` | R14.4 |
| `var.minObservations` | F | No default. Approved baseline 200 | Integer, 2 <= x <= `var.lookbackReturns` | R13.1 |
| `adjustment.bearishThreshold` | F | No default. Approved baseline -0.60 | Decimal in [-1, +1] | R15 |
| `adjustment.multiplier` | F | No default. Approved baseline 1.15 | Decimal >= 1 | R15 |
| `sentiment.maxAgeSeconds` | F | No default. Proposed 900 (OD-6) | Integer > 0 | R15, R10.6 |
| `sentiment.windowSeconds` | F | No default. Proposed 300 (OD-1) | Integer > 0, <= `sentiment.maxAgeSeconds` | R10.1 |
| `sentiment.maxFutureSkewSeconds` | F | No default. Proposed 5 (OD-6) | Integer >= 0 | R9.9 |
| `sentiment.reconnect.*` | O | Initial 1 s, max 60 s, max attempts 10, jitter on | Positive numbers | R9.4 |
| `sentiment.rest.pollSeconds` | O | No default; required when a REST provider is configured | Integer > 0 | R9.1 |
| `marketData.maxStalenessDays` | F | No default. Proposed 5 (OD-6) | Integer >= 0 | R13.4 |
| `marketData.maxReturnGapDays` | F | No default. Proposed 5 (OD-6) | Integer >= 1 | FR-3 |
| `fx.baseCurrency` | F | No default. Conditionally approved `EUR` (DR-FX-1; effective only after OD-5 and task 10.2) | ISO 4217 | R30 |
| `fx.supportedCurrencies` | F | No default | ISO 4217 list including base | R30.2 |
| `fx.maxRateAgeSeconds` | F | No default. Proposed 86,400 (OD-6) | Integer > 0 | R30.8 |
| `fx.provider` | F | No default. Conditionally approved `ECB` (DR-FX-1; effective for real use only after OD-5); approved for the hackathon demo only (DR-KW-1, H2); `FIXTURE` for development and tests | `FIXTURE` or `ECB`; `ECB` requires `fx.baseCurrency` = `EUR` (ECB route proposed, OD-5) | R30.3, R14.14 |
| `fx.ecb.timeoutMs` | O | 10,000 (provisional, OD-6) | Integer > 0; per-attempt timeout of the ECB adapter, replacing `provider.timeoutMs` | R25.7, R33.9 |
| `fx.ecb.maxResponseBytes` | O | 1,048,576 (provisional, OD-6) | Integer > 0; larger responses are `INVALID_RESPONSE` | R25, R33.9 |
| `fx.ecb.cacheMaxEntries` | O | 64 (provisional, OD-6) | Integer >= 1; completed responses kept by the ECB adapter | R30.3 |
| `filing.maxAgeDays` | F | No default. Proposed 120 (OD-6) | Integer > 0 | R31 |
| `alerts.var.thresholdPct` | F | No default. No proposal (OD-6) | Decimal in (0, 100] | R18 |
| `alerts.var.metric` | F | No default. Approved baseline `ADJUSTED` | `ADJUSTED` or `BASE` | R18.1 |
| `alerts.resetPct` | F | No default. Recommended equal to threshold (OD-6) | Decimal <= threshold | R34.6 |
| `alerts.filing.threshold` | F | No default. No proposal (OD-6) | Decimal in [0, 1] | R34.3 |
| `alerts.filing.resetThreshold` | F | No default. Recommended equal to filing threshold (OD-6) | Decimal in [0, threshold] | R34.6 |
| `alerts.filing.criticalThreshold` | F | Optional; when absent the critical level is disabled | Decimal in [threshold, 1] | R34.3 |
| `alerts.cooldownSeconds` | O | 900 (provisional, OD-6) | Integer >= 0 | R34.6 |
| `alerts.severity.highRatio` / `criticalRatio` | O | 1.25 / 1.50 (provisional, OD-6) | 1 < high < critical | R34.2 |
| `alerts.delivery.maxRetries` | O | 3 | Integer >= 0 | R34.7 |
| `import.maxFileBytes` | O | 10 MiB | Integer > 0 | R28.4 |
| `import.maxRows` | O | 100,000 | Integer > 0 | R28.4 |
| `import.maxFieldLength` | O | 256 | Integer > 0 | R28.8 |
| `import.oversellPolicy` | F | No default. Recommended `REJECT` (OD-6) | `REJECT` or `ALLOW_SHORT` | R28.20 |
| `import.defaultTimezone` | F | No default; date-only timestamps rejected if absent | IANA time zone name | R28.1 |
| `recalc.minValueChangePct` | F | No default. Proposed 0.10 (OD-6) | Decimal >= 0 | R16.2 |
| `fix.delimiter` | O | SOH (`\x01`); `\|` allowed for text logs | `SOH` or `\|` | R2.1 |
| `sec.userAgent` | O | No default; required for SEC retrieval. Supplied only through the `SEC_USER_AGENT` environment variable because it contains a personal contact; never in committed configuration | Non-empty, includes contact | R6.6, R24.1 |
| `sec.maxRequestsPerSecond` | O | 5 | Integer 1 to 10 | R6.7 |
| `sec.timeoutMs` / `sec.maxResponseBytes` / `sec.maxRedirects` | O | 30,000 / 25 MiB / 3 | Positive integers; `sec.timeoutMs` is one overall deadline per retrieval | R33.6, R29.10 |
| `sec.item1a.minChars` | O | 500 (provisional, OD-6) | Integer > 0 | R6.5 |
| `nlp.timeoutMs` / `nlp.maxRetries` | O | 60,000 / 2 | Positive / non-negative integers | R33.7 |
| `nlp.maxInputChars` | O | No default until OD-15 is decided | Integer > 0 | R7.1 |
| `provider.maxRetries` | O | 3 | Integer >= 0 (additional attempts) | R25.2 |
| `provider.timeoutMs` | O | 10,000 | Integer > 0; per-attempt timeout, replaceable by a provider-specific timeout | R25.7, R33.9 |
| `provider.backoff.baseMs` / `provider.backoff.maxMs` | O | 250 / 10,000 | Positive integers, `baseMs <= maxMs` | R25.2 |
| `provider.circuit.failureThreshold` / `provider.circuit.openMs` | O | 5 / 60,000 | Positive integers | R25.8 |
| `provider.retryAfter.maxMs` | O | 600,000 (10 minutes) | Integer > 0; a longer valid `Retry-After` ends the call at once (429 `RATE_LIMITED`, 5xx `HTTP_SERVER_ERROR`) | R25.2 |
| `ws.maxQueueSize` | O | 1,000 | Integer > 0 | R33.5 |
| `api.rateLimitPerMinute` / `api.uploadRateLimitPerMinute` | O | 60 / 10 | Positive integers | R29.4 |
| `demo.profile` / `demo.provisionalKeys` | O | Absent (optional; no default value and no feature) | `KIROWEEN_2026_DEMO` / unique list of configuration keys outside `demo.*`; present only in a demo configuration (Configuration policy 7) | DR-KW-1 |
| `decimal.precision` / `decimal.rounding` | X | 40 / `ROUND_HALF_UP` | Not configurable in v1 | R4.5 |

Secrets (API keys and credentials) are read from environment variables or a secrets manager only (R24), never from committed configuration.

## Acceptance Test Matrix

Test identifiers use the pattern `AT-<area>-<n>`. Status: `Ready` (can be written now), `Blocked` (needs a stated open decision). Every test cites the requirement it verifies.

### VaR and quantile

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-VAR-01 | 250 known daily returns, hand-calculated 95% VaR with Type 7 (`0.45*x[237] + 0.55*x[238]`) | R14.7, FR-7 | Ready |
| AT-VAR-02 | Same dataset at 99% (`0.49*x[247] + 0.51*x[248]`) | R14.2, FR-7 | Ready |
| AT-VAR-03 | Configurable confidence: 0.95 and 0.99 accepted; 0, 1, -0.1, 1.5, `NaN` rejected | R14.2 | Ready |
| AT-VAR-04 | Losses sorted ascending, including ties and negative losses (gains) | R14.7, FR-7.8 | Ready |
| AT-VAR-05 | Interpolation with `gamma = 0` uses `x[j]` only; with `gamma > 0` interpolates | FR-7.4 | Ready |
| AT-VAR-06 | Endpoint handling for very small `n` (n = 2) and the guard for `j >= n` | FR-7.4 | Ready |
| AT-VAR-07 | VaR is a quantile of Loss, not of return or P&L: a dataset where the sign convention changes the answer | R14.7, FR-5 | Ready |
| AT-VAR-08 | 199 returns gives `INSUFFICIENT_DATA` and no VaR value | R13.1 | Ready |
| AT-VAR-09 | 200 returns allows calculation with `REDUCED_LOOKBACK` (`h = 190.05`) | R13.4, R13.6 | Ready |
| AT-VAR-10 | 249 returns gives `REDUCED_LOOKBACK` (`h = 236.6`) | R13.6 | Ready |
| AT-VAR-11 | 250 returns gives `COMPLETE` | R13.6 | Ready |
| AT-VAR-12 | More than 250 returns uses only the newest 250 | R14.4 | Ready |
| AT-VAR-13 | All scenarios are gains: `NO_LOSS_AT_CONFIDENCE`, VaR 0, raw quantile retained | R14.8, FR-7.5 | Ready |
| AT-VAR-14 | Horizon other than 1 is rejected; no scaling is applied | R14.3 | Ready |
| AT-VAR-15 | VaR% with `NAV > 0`; `NAV <= 0` gives `NAV_NOT_POSITIVE` and no percentage | R14.9 | Ready |
| AT-VAR-16 | Empty portfolio gives `NO_POSITIONS` | R14.11 | Ready |
| AT-VAR-17 | Result metadata contains every field listed in R14.12 | R14.12 | Ready |
| AT-VAR-18 | Two-asset portfolio P&L equals the sum of position scenario P&L | R14.6, FR-5 | Ready |

### Market data

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-MD-01 | 251 adjusted closes produce exactly 250 returns | R12.4, FR-2 | Ready |
| AT-MD-02 | Return formula `P[t]/P[t-1]-1` with Decimal values gives exact results | FR-2 | Ready |
| AT-MD-03 | Missing adjusted close removes that date; no fill | R12.8, FR-3.2 | Ready |
| AT-MD-04 | Non-positive and non-finite prices discarded | FR-3.1 | Ready |
| AT-MD-05 | Duplicate dates with identical prices collapsed | FR-3.3 | Ready |
| AT-MD-06 | Duplicate dates with conflicting prices give `DATA_CONFLICT` and VaR unavailable | FR-3.3 | Ready |
| AT-MD-07 | Misaligned dates across two assets use the intersection only | FR-3.4 | Ready |
| AT-MD-08 | No forward filling: a missing date in one asset removes it for all assets | R12.8, FR-3.4 | Ready |
| AT-MD-09 | No fabricated observations or returns | R13.3 | Ready |
| AT-MD-10 | As-of date equals the last common valid trading date | FR-3.6 | Ready |
| AT-MD-11 | Gap larger than `maxReturnGapDays` discards that return | FR-3.5 | Ready |
| AT-MD-12 | Limiting asset (shortest history) is identified | R13.2, FR-3.8 | Ready |
| AT-MD-13 | Stale as-of date gives `MARKET_DATA_STALE`, and the result is exposed with validity `STALE`, never `CURRENT`; a Reduced Lookback `OK` result may be `CURRENT` with its label | R13.4, R13.7, FR-8 | Ready |
| AT-MD-14 | Weekend observation discarded | FR-3.1 | Ready |
| AT-MD-15 | Exchange-holiday observation discarded | FR-3.1 | Blocked (OD-3) |
| AT-MD-16 | Last valid result retained and labelled `LAST_VALID`; a run with a missing Base VaR setting returns `CONFIG_MISSING` with the keys listed and no Base or Adjusted VaR, while the earlier result stays `LAST_VALID` | R13.5, R14.14 | Ready |
| AT-MD-17 | Provider payload normalized through the provider interface: dates, ticker, currency, source, retrieval timestamp, and content hash recorded | R12.1, R12.2, R12.3, R12.6 | Ready |
| AT-MD-18 | Cached series is labelled with its retrieval time and status, and is never presented as current | R12.7, R25.4 | Ready |

### Sentiment and adjustment

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-SEN-01 | Sentiment -0.60 gives multiplier 1.00 | R15.4 | Ready |
| AT-SEN-02 | Sentiment -0.6001 gives multiplier 1.15 | R15.4 | Ready |
| AT-SEN-03 | Sentiment -0.75 triggers | R27.7 | Ready |
| AT-SEN-04 | Positive scenario contributions unchanged after adjustment | R15.5, FR-6 | Ready |
| AT-SEN-05 | Only the triggering asset's negative contributions change | R15.6 | Ready |
| AT-SEN-06 | Multiple triggering assets are adjusted independently | R15.6 | Ready |
| AT-SEN-07 | Portfolio VaR is not multiplied by 1.15 (Adjusted VaR differs from `1.15 * Base VaR`) | R15.7 | Ready |
| AT-SEN-08 | Stale sentiment observation for one position: it triggers nothing, Adjusted VaR is `UNAVAILABLE` with `SENTIMENT_NOT_CURRENT` naming the ticker and status `STALE`, Base VaR stays `CURRENT`, and the stale value is displayed labelled stale | R15.8, R15.13, R13.7 | Ready |
| AT-SEN-09 | Demo sentiment never triggers; demo sentiment for a position makes Adjusted VaR `UNAVAILABLE` with `SENTIMENT_NOT_CURRENT` | R15.2, R15.8 | Ready |
| AT-SEN-10 | Invalid sentiment (out of range, `NaN`) gives no adjustment and is rejected | R10.7, R21 | Ready |
| AT-SEN-11 | Unavailable sentiment for a position makes Adjusted VaR `UNAVAILABLE` with `SENTIMENT_NOT_CURRENT` and is never treated as "not triggered" | R15.8 | Ready |
| AT-SEN-12 | Long position: `EffectiveSentiment = RawSentiment` | FR-9 | Ready |
| AT-SEN-13 | Short position: raw -0.80 gives effective +0.80 and no trigger; raw +0.80 gives effective -0.80 and triggers | FR-9 | Ready |
| AT-SEN-14 | Netted long and short in one instrument produce one signed position | R15.12 | Ready |
| AT-SEN-15 | No setting disables the adjustment: an `adjustment.enabled` key is rejected as an unknown field, and eligible sentiment below the threshold always triggers the adjustment | R15.1, R15.4 | Ready |
| AT-SEN-16 | Threshold outside [-1, 1] and multiplier below 1 rejected | R15.1 | Ready |
| AT-SEN-17 | Base VaR remains unchanged after a sentiment change | R15.9 | Ready |
| AT-SEN-18 | Result lists triggering instruments with Raw and Effective sentiment | R15.10 | Ready |
| AT-SEN-19 | Out-of-order and duplicate observations do not overwrite newer state | R9.5, R9.8 | Ready |
| AT-SEN-20 | Future-dated observation rejected | R9.9 | Ready |
| AT-SEN-21 | Numeric aggregation of observations into the index | R10.1 | Blocked (OD-1) |
| AT-SEN-22 | REST provider payload is retrieved through the provider interface, validated, and normalized | R9.1 | Ready |
| AT-SEN-23 | Message is associated with its ticker, and provider, observation timestamp, and receipt timestamp are recorded | R9.3, R9.6 | Ready |
| AT-SEN-24 | Every observation is tagged `REAL` or `DEMO`; a demo provider can never produce `REAL` | R9.7 | Ready |
| AT-SEN-25 | A change in a ticker's eligibility or trigger state recalculates Adjusted VaR and leaves Base VaR unchanged | R16.4, R15.9 | Ready |
| AT-SEN-26 | `sentiment.windowSeconds` greater than `sentiment.maxAgeSeconds` is rejected at load | R10.1, Configuration | Ready |
| AT-SEN-27 | Missing `sentiment.windowSeconds`: Base VaR is calculated and `CURRENT`; Adjusted VaR is `UNAVAILABLE` with `ADJUSTMENT_CONFIG_MISSING` naming the key; sentiment is shown as unavailable with that reason | R15.1, R15.8, R14.14, R10.1 | Ready |
| AT-SEN-28 | Missing `sentiment.maxAgeSeconds` (and, in separate cases, missing `adjustment.bearishThreshold` or `adjustment.multiplier`): Base VaR is calculated and `CURRENT`; Adjusted VaR is `UNAVAILABLE` with `ADJUSTMENT_CONFIG_MISSING` naming the key | R15.1, R15.8, R14.14 | Ready |
| AT-SEN-29 | Valid Base VaR with unavailable Adjusted VaR: the result has the Base figure with validity `CURRENT` and a `null` Adjusted figure with validity `UNAVAILABLE` and its adjusted status; the Adjusted field never holds the Base figure | R15.8, R15.9, R13.7 | Ready |

### Filing independence and SEC

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-FIL-01 | Changing FilingRiskScore does not change Base VaR | R11.5 | Ready |
| AT-FIL-02 | Changing FilingRiskScore does not change Adjusted VaR | R11.5 | Ready |
| AT-FIL-03 | Changing FilingRiskScore does not change triggered sentiment instruments | R11.5 | Ready |
| AT-FIL-04 | High filing risk and bullish sentiment shown as two separate values with no combined indicator | R35.2, R35.3 | Ready |
| AT-FIL-05 | Filing-risk alert does not alter VaR | R34.4 | Ready |
| AT-FIL-06 | Score outside 0 to 1 rejected | R21.1 | Ready |
| AT-FIL-07 | Stale score labelled stale and excluded from filing alerts | R31.3, R31.7 | Ready |
| AT-FIL-08 | No filing gives `NO_FILING` and no score | R31.4 | Ready |
| AT-FIL-09 | Newer filing supersedes and retains the old score | R31.5 | Ready |
| AT-FIL-10 | SEC text is not passed into sentiment; sentiment text is not passed into filing scoring | R8.6 | Ready |
| AT-FIL-11 | Fallback or demo NLP result does not trigger filing alert | R8.5, R34.3 | Ready |
| AT-FIL-12 | Missing Item 1A returns `ITEM_1A_NOT_FOUND` with no fabricated content | R6.5 | Ready |
| AT-FIL-13 | Filing metadata (accession number, CIK, date, retrieval timestamp) stored | R6.2 | Ready |
| AT-FIL-14 | Item 1A shorter than `sec.item1a.minChars` returns `ITEM_1A_TOO_SHORT`, stores metadata, and produces no score | R6.5 | Ready |
| AT-FIL-15 | Positive extraction from a recorded 10-K: the real Item 1A is returned, the table of contents and in-text cross-references are skipped, and the text is a substring of the normalized document | R6.3, R6.4 | Ready |
| AT-FIL-16 | Positive extraction of Part II Item 1A from a recorded 10-Q | R6.3 | Ready |
| AT-FIL-17 | Ticker resolves to CIK using recorded official SEC data, and the latest 10-K or 10-Q is located | R6.1 | Ready |
| AT-FIL-18 | Completed analysis produces a score in [0, 1] with categories, and stores method, version, provider, mode, and source URL | R7.2, R7.3, R7.4, R7.5 | Ready |
| AT-FIL-19 | A scoring-method or provider change allows recalculation and records the new method version | R31.6 | Ready |
| AT-FIL-20 | Fallback NLP results are labelled `FALLBACK` / `DEMO` and never presented as genuine analysis | R8.3, R8.4, R8.5 | Ready |

### Allocation

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-ALC-01 | Three equal assets give 33.34, 33.33, 33.33 (extra unit to lexicographically first ticker) | R20.3, FR-11 | Ready |
| AT-ALC-02 | Eligible long-only totals exactly 100.00 | R20.3 | Ready |
| AT-ALC-03 | Cash included in the denominator and shown as `CASH` line | R20.1 | Ready |
| AT-ALC-04 | Negative cash: no forced 100% total | R20.6 | Ready |
| AT-ALC-05 | Short positions shown separately; no forced 100% | R20.6 | Ready |
| AT-ALC-06 | Zero or negative denominator gives `ALLOCATION_UNAVAILABLE` | R20.2 | Ready |
| AT-ALC-07 | Tie-break by ascending ticker is deterministic across input orders | R20.5, FR-11 | Ready |
| AT-ALC-08 | Property test: any eligible portfolio sums to exactly 100.00 | R20.3, R27.4 | Ready |
| AT-ALC-09 | Gross, net, long, short exposure and NAV correct | FR-10, FR-12 | Ready |
| AT-ALC-10 | A portfolio without an explicit cash value is rejected; an explicit `"0"` is accepted | FR-10, A-7 | Ready |
| AT-ALC-11 | Allocation display uses two decimal places, and raw exposure values are reported separately from percentages | R20.7, R20.8 | Ready |

### Decimal precision and FX

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-DEC-01 | Adding 0.1 ten thousand times equals exactly 1000 | R4.1 | Ready |
| AT-DEC-02 | Monetary values preserve decimal precision | R4.1, R4.5 | Ready |
| AT-DEC-03 | FX conversion preserves precision (for example 1.2345678901 times 1000.01) | R30.4, R4.1 | Ready |
| AT-DEC-04 | JSON round trip preserves Canonical Decimal Strings exactly | R4.3 | Ready |
| AT-DEC-05 | Static check finds no `parseFloat`, `Number()`, or native arithmetic on financial values in calculation modules | R4.2 | Ready |
| AT-DEC-06 | Native number conversion occurs only at the declared presentation boundary | R4.4 | Ready |
| AT-DEC-07 | Non-finite numeric text rejected | R4.6 | Ready |
| AT-FX-01 | Base-currency position has rate exactly 1, source `BASE_CURRENCY`, source kind `IDENTITY`, and no observation timestamp | R30.4, R30.5 | Ready |
| AT-FX-02 | Inverse quote converted with `1 / quote` | R30.4 | Ready |
| AT-FX-03 | Missing FX rate gives `FX_UNAVAILABLE`, VaR unavailable, no substitution | R30.8 | Ready |
| AT-FX-04 | Stale FX rate gives `FX_STALE` | R30.8 | Ready |
| AT-FX-05 | FX rates stored in the snapshot | R30.10, R32.1 | Ready |
| AT-FX-06 | Unsupported currency rejected | R30.2 | Ready |
| AT-FX-07 | Mixed-currency portfolio valued in base currency | R30.6, R30.9 | Ready |
| AT-FX-08 | The rate as of the market-data as-of date (latest not after calculation time) is selected and held constant across all scenarios | R30.7 | Ready |
| AT-FX-09 | Each rate used records the requested pair, `Rate(X/B)` (inverted for inverse quotes), observation timestamp, source and source kind of the configured provider, and status | R30.5 | Ready |
| AT-FX-10 | A result that used a `DEMO` FX rate carries `DEMO_DATA`, is labelled DEMO, is never presented as a production result, and produces no VaR alert | R30.11, R25.4, R25.5 | Ready |
| AT-FX-11 | In production mode, a required `DEMO` FX rate makes Base and Adjusted VaR unavailable with `FX_DEMO_NOT_ALLOWED` and the currencies listed | R30.11, R13.7 | Blocked (OD-19) |
| AT-FX-12 | On FX provider failure the last valid rate is shown as display-only `STALE`, stays unchanged, never reaches a calculation, and stale, invalid, or future-dated rates never replace it | R30.12, R25.3, R33.10 | Ready |
| AT-FX-13 | The ECB adapter calls only the fixed ECB data endpoint over verified TLS, with one HTTP request per exact (`asOf`, `at`) for all supported currencies, and passes the attempt signal to the transport | R30.3, R24.8, R25.7 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-14 | An ECB rate for date D has `observedAt` 16:00 Europe/Frankfurt time on D (14:00Z in CEST, 15:00Z in CET), is never used for an `at` earlier than that, and is recorded with `observedAtBasis` `PUBLICATION_CONVENTION` and `conventionId` `ECB-PUB-1600-FRANKFURT-v1` | R30.13, R30.7 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-15 | Any deviation from the fixed ECB CSV format rejects the whole response as `INVALID_RESPONSE`, which counts toward the circuit breaker | R30.3, R4.6, R25.8 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-16 | The adapter cache is bounded, keyed by exact (`asOf`, `at`), holds only immutable completed responses, never caches failed, aborted, or partial responses, and cancelling one caller never cancels another; a shared request is aborted only when every caller has abandoned it | R30.3, R30.8, R25.7 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-17 | `fx.provider` missing gives `CONFIG_MISSING` for Base VaR; `ECB` with a base other than EUR is invalid configuration | R14.14, R30.3 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-18 | ECB-derived rates are shown with the source statement and the derived-value note | R30.14 | Ready within the hackathon scope (DR-KW-1 H2): `fxAttribution` data and dashboard display delivered; real use blocked by OD-5 |
| AT-FX-19 | Recorded ECB responses pass the FxService tests, including inverse conversion, with no network access | R30.3, R30.4 | Ready (hackathon demo scope, DR-KW-1 H2); real use blocked by OD-5 |
| AT-FX-20 | Every observed and stale FX rate carries `observedAtBasis`; `PROVIDER` has no `conventionId`, `PUBLICATION_CONVENTION` has a valid `conventionId`; a missing, unknown, or inconsistent basis is `INVALID_RESPONSE` and counts toward the circuit breaker | R30.13, R30.5, R25.8 | Ready |

### CSV and import

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-CSV-01 | Fixed fixture of 10,000 rows and 10 columns, 0 invalid | NFR-PERF-1 | Ready |
| AT-CSV-02 | 3 warm-up runs and 20 measured runs, p95 (nearest rank, 19th value) <= 500 ms | R1.3 | Ready |
| AT-CSV-03 | Benchmark output records CPU, RAM, OS, and Node.js version | NFR-PERF-1 | Ready |
| AT-CSV-04 | Same file imported twice creates no duplicate transactions | R28.13 | Ready |
| AT-CSV-05 | Invalid rows isolated and audited; valid rows still processed | R3.1, R3.2, R3.3 | Ready |
| AT-CSV-06 | Malformed or duplicate headers rejected with `INVALID_HEADER` | R28.5 | Ready |
| AT-CSV-07 | Invalid UTF-8 rejected; UTF-8 with BOM accepted | R28.3 | Ready |
| AT-CSV-08 | Oversized file and too many rows rejected | R28.4 | Ready |
| AT-CSV-09 | Unsupported transaction type rejected | R28.2 | Ready |
| AT-CSV-10 | Oversell rejected under `REJECT`; no silent short | R28.20 | Ready |
| AT-CSV-11 | Oversell under `ALLOW_SHORT` produces a negative, flagged position | R28.21 | Ready |
| AT-CSV-12 | Persistence failure leaves no partial commit | R28.15, R28.16 | Ready |
| AT-CSV-13 | Two identical rows in one file are both kept (occurrence 1 and 2) | R28.11, R28.14 | Ready |
| AT-CSV-14 | `external_id` deduplication across files | R28.11, R28.12 | Ready |
| AT-CSV-15 | Empty rows skipped and counted | R28.6 | Ready |
| AT-CSV-16 | Import summary contains total, accepted, rejected, duplicate, timestamp, and file hash | R28.9 | Ready |
| AT-CSV-17 | Column mapping works for renamed columns | R1.2 | Ready |
| AT-CSV-18 | Oversized field and formula-like content treated as data only | R28.8 | Ready |
| AT-CSV-19 | Transactions processed in timestamp order so a same-file SELL after BUY is accepted | R28.18 | Ready |
| AT-CSV-20 | Currency mismatch rejected | R28.22 | Ready |
| AT-CSV-21 | Benchmark on agreed reference hardware | NFR-PERF-1 | Blocked (OD-2) |
| AT-CSV-22 | Empty or unreadable file returns a descriptive validation error without crashing | R1.5 | Ready |
| AT-CSV-23 | Date-only timestamp is rejected with `INVALID_DATE` when `import.defaultTimezone` is absent, and converted when it is set | R28.1 | Ready |
| AT-CSV-24 | Import is refused when `import.oversellPolicy` is not configured | R28.20 | Ready |

### Positions

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-POS-01 | Average price after a sequence of BUYs matches a hand-calculated value | FR-13, R28.19 | Ready |
| AT-POS-02 | A SELL leaves average price unchanged; reaching zero quantity resets it to `null` and retains the position with quantity `"0"` and `isShort: false` | FR-13, R28.19, R5.3 | Ready |
| AT-POS-03 | Position model exposes every field in R5.2 as Canonical Decimal Strings (valuation fields `null` with status `NOT_VALUED` before valuation), and one netted position exists per instrument | R5.2, R5.3 | Ready |
| AT-POS-04 | Positions change only after the import commit succeeds (fake unit of work that fails the commit leaves positions unchanged) | R28.17, R5.4, R5.5 | Ready |
| AT-POS-05 | A transaction crossing zero closes the position and opens the remainder in the opposite direction at that transaction's price; short positions follow FR-13 on the absolute quantity | FR-13, R28.19, R28.21 | Ready |
| AT-POS-06 | Replay uses `(tradeTimestamp, sourceId, sourceSequence, transactionKey)`: the same files imported in any order, and a repeated rebuild, give identical positions including identifier, update timestamp, and source | R28.18, R5.6 | Ready |
| AT-POS-07 | Transactions of one position in two currencies give `POSITION_CURRENCY_CONFLICT`; no position of that rebuild is written and no event is published | R5.7 | Ready |
| AT-POS-08 | `PositionsChanged` is published once after a successful commit with sorted tickers, only when a position changed; it is not published when the commit fails or nothing changed; a publication failure leaves the committed positions unchanged and is reported | R5.5, R28.17 | Ready |
| AT-POS-09 | A rebuild reconciles persisted positions against the complete replay: a persisted position with no ledger transaction is removed and reported as a change with `after: null`; a zero-quantity position produced by ledger history is kept; a commit failure injected at any write leaves every insertion, update, and removal of that rebuild unapplied | R5.3, R5.6 | Ready |

### FIX

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-FIX-01 | Unsupported message type rejected with reason | R2.3 | Blocked (OD-9 supported set) |
| AT-FIX-02 | Missing required tag rejected with reason | R2.3 | Blocked (OD-9) |
| AT-FIX-03 | Malformed tag value rejected with reason | R2.3 | Blocked (OD-9) |
| AT-FIX-04 | Invalid quantity or price rejected with reason | R2.3 | Blocked (OD-9) |
| AT-FIX-05 | Duplicate message does not duplicate a transaction | R28.11, R28.12 | Blocked (OD-9) |
| AT-FIX-06 | Valid messages process when others are invalid | R2.4 | Blocked (OD-9) |
| AT-FIX-07 | FIX budget measured on fixed fixture | R33.2 | Blocked (OD-2) |

### SEC security

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-SEC-01 | Non-SEC domain rejected | R29.8 | Ready |
| AT-SEC-02 | Look-alike host (`www.sec.gov.example.com`) rejected | R29.8 | Ready |
| AT-SEC-03 | HTTP URL rejected | R29.8 | Ready |
| AT-SEC-04 | URL with embedded credentials rejected | R29.8 | Ready |
| AT-SEC-05 | Unsupported port rejected | R29.8 | Ready |
| AT-SEC-06 | IP-literal host rejected | R29.9 | Ready |
| AT-SEC-07 | Host resolving to loopback rejected | R29.9 | Ready |
| AT-SEC-08 | Host resolving to private (RFC 1918) address rejected | R29.9 | Ready |
| AT-SEC-09 | Host resolving to link-local address (including cloud metadata address) rejected | R29.9 | Ready |
| AT-SEC-10 | Redirect to non-SEC host rejected | R29.10 | Ready |
| AT-SEC-11 | Redirect to a prohibited IP range rejected | R29.10 | Ready |
| AT-SEC-12 | Redirect to HTTP rejected; redirect count above maximum rejected | R29.10 | Ready |
| AT-SEC-13 | Oversized response aborted | R33.6 | Ready |
| AT-SEC-14 | Timeout handled with `SEC_TIMEOUT` | R33.6 | Ready |
| AT-SEC-15 | HTTP 429 handled with backoff and `Retry-After` | R6.7, R25.2 | Ready |
| AT-SEC-16 | Request rate never exceeds `sec.maxRequestsPerSecond` | R6.7 | Ready |
| AT-SEC-17 | Missing `sec.userAgent` blocks SEC retrieval | R6.6 | Ready |
| AT-SEC-18 | No fabricated filing content on failure | R6.5, R7.7 | Ready |
| AT-SEC-19 | Credentials and account identifiers absent from logs | R24.7, R29.12 | Ready |
| AT-SEC-20 | Unauthenticated and unauthorized requests denied | R29.1 to R29.3 | Blocked (OD-7) |
| AT-SEC-21 | Rate limit returns HTTP 429 | R29.4 | Ready |
| AT-SEC-22 | Formula-injection neutralization in CSV export: cells starting with `=`, `+`, `-`, `@`, TAB, or CR get one leading `'`; a negative cell matching the `DecimalStringSchema` grammar (decimal exception) and a cell already starting with `'` are unchanged; other cells are unchanged; neutralizing twice equals neutralizing once | R29.7 | Ready |
| AT-SEC-23 | External calls fail on an invalid TLS certificate; no code path disables verification | R24.8 | Ready |
| AT-SEC-24 | Secret scan finds no credentials in source, tests, fixtures, committed configuration, or the built frontend bundle | R24.1, R24.5 | Ready |
| AT-SEC-25 | Uploaded filenames are sanitized, never used as file system paths, and stored under generated names | R29.6 | Ready |
| AT-SEC-26 | Internal errors return a generic body with a correlation id, without stack traces or internal paths | R29.13 | Ready |
| AT-SEC-27 | Unknown fields in API requests and configuration updates are rejected | R29.5, R24.6 | Ready |
| AT-SEC-28 | Unparseable URLs (`MALFORMED_URL`, checked first), URLs with a fragment (including an empty `#`), trailing-dot hosts, empty userinfo, and IDNA look-alike hosts are rejected; IDNA input that normalizes to exactly an allowlisted ASCII name is accepted; no suffix or substring match is accepted | R29.8 | Ready |
| AT-SEC-29 | A host is rejected when any one of several resolved A or AAAA addresses is prohibited; every block in the pinned address policy is rejected at its first and last address, including the explicitly prohibited globally reachable blocks (AS112, AMT, anycast); public unicast addresses just outside each block are accepted | R29.9 | Ready |
| AT-SEC-30 | No record in either family gives `DNS_EMPTY`; one family with records and the other `NO_DATA` or `NOT_FOUND` uses the available records; any other lookup error in either family gives `DNS_FAILED`, even when the other family returned records; a lookup timeout (resolver timeout or retrieval deadline) gives `SEC_TIMEOUT`, never `DNS_FAILED`, and emits no `DNS_FAILED` event then or later | R29.9, R33.6 | Ready |
| AT-SEC-31 | Every rejection emits a security event without any part of the input URL; when the event sink fails or throws, the request is still rejected and the result reports `DELIVERY_FAILED`, never `RECORDED` | R29.14 | Ready |

### Provider reliability

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-PRV-01 | Provider outage retains last valid data as stale | R25.3, R33.10 | Ready |
| AT-PRV-02 | Stale data visibly labelled | R25.4, R35.4 | Ready |
| AT-PRV-03 | No fabricated values on outage | R25.5 | Ready |
| AT-PRV-04 | WebSocket reconnection with backoff | R9.4 | Ready |
| AT-PRV-05 | Duplicate WebSocket messages handled | R9.5 | Ready |
| AT-PRV-06 | Delayed and out-of-order messages handled | R9.8 | Ready |
| AT-PRV-07 | WebSocket queue remains bounded under flood; dropped counter increments | R33.5 | Ready |
| AT-PRV-08 | Slow provider does not block unrelated portfolio calculation | R33.9 | Ready |
| AT-PRV-09 | NLP timeout gives `NLP_FAILED` and no score | R33.7 | Ready |
| AT-PRV-10 | Retryable and non-retryable errors handled per policy, including `TLS_ERROR` (not retried) and a `Retry-After` above `provider.retryAfter.maxMs` (seconds or HTTP date, with or without a deadline) ending the call at once with no wait: `RATE_LIMITED` for 429, `HTTP_SERVER_ERROR` with its status for 5xx (counted by the circuit breaker) | R25.2 | Ready |
| AT-PRV-11 | Provider status is reported on failure, and errors name provider, operation, and code without secrets | R25.1, R25.6 | Ready |
| AT-PRV-12 | Circuit breaker: five qualifying failed calls open the circuit; open calls fail with `CIRCUIT_OPEN` without contacting the provider; after `provider.circuit.openMs` exactly one half-open probe is allowed, success closes and any other probe result (qualifying or not) is returned to its caller and reopens the circuit for a fresh full cooldown, after which exactly one probe is allowed again; TLS errors count; rate limiting, other 4xx, cancellation, and unexpected exceptions do not count; status is `AVAILABLE`, `DEGRADED`, or `UNAVAILABLE` accordingly | R25.1, R25.8 | Ready |
| AT-PRV-13 | Attempt timeout, overall deadline (no attempt or wait beyond it), and caller cancellation (`CANCELLED`, no retry) behave as specified under a fake clock; a provider that never settles cannot make the call hang, and its late rejection is handled; an unexpected exception gives `UNEXPECTED_ERROR` with a generic message and a redacted log entry | R25.7, R25.9, R33.9 | Ready |

### Alerts

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-ALR-01 | Cooldown suppresses duplicate alerts | R34.6 | Ready |
| AT-ALR-02 | A threshold crossing fires exactly once while the breach continues | R34.5 | Ready |
| AT-ALR-03 | Reset then re-cross fires again after cooldown | R34.6 | Ready |
| AT-ALR-04 | Severity escalation fires a new alert and bypasses cooldown | R34.5, R34.6 | Ready |
| AT-ALR-05 | Publish failure does not stop calculations; retries then `FAILED` status | R19.5, R34.7 | Ready |
| AT-ALR-06 | VaR and filing-risk alerts remain separate (state, history, type) | R34.1 | Ready |
| AT-ALR-07 | Equality with threshold does not alert (strictly greater) | R18.1 | Ready |
| AT-ALR-08 | Missing threshold gives `ALERT_CONFIG_MISSING` with no default assumed | R18.2 | Ready |
| AT-ALR-09 | `NAV <= 0` gives no VaR alert and `NAV_NOT_POSITIVE` | R18.5 | Ready |
| AT-ALR-10 | Alert payload contains all required fields | R19.2 | Ready |
| AT-ALR-11 | Alert history preserved after dismissal | R19.4 | Ready |
| AT-ALR-12 | Retry does not produce duplicate dashboard entries | R34.8 | Ready |
| AT-ALR-13 | No VaR alert is produced, escalated, or re-armed from a result that is `STALE`, `LAST_VALID`, or `UNAVAILABLE` (including `INSUFFICIENT_DATA`, `FX_UNAVAILABLE`, `FX_STALE`, `DATA_CONFLICT`, `NO_POSITIONS`, `INVALID_INPUT`, and `CONFIG_MISSING`), and each skip is recorded | R18.7, R13.7 | Ready |
| AT-ALR-14 | Severity bands at the boundaries: ratio just above 1.00 gives `WARNING`, `highRatio` gives `HIGH`, `criticalRatio` gives `CRITICAL` | R34.2, R18.4 | Ready |
| AT-ALR-15 | Thresholds configured per portfolio are applied independently | R18.3 | Ready |
| AT-ALR-16 | VaR and filing alerts re-arm against their own reset thresholds | R34.6, R34.1 | Ready |
| AT-ALR-17 | Alert generation publishes an event to the dashboard event bus, including triggering tickers where applicable | R19.1, R19.3 | Ready |
| AT-ALR-18 | With `alerts.var.metric` = `ADJUSTED`, Adjusted VaR `UNAVAILABLE`, and Base VaR above the threshold: no VaR alert fires, escalates, or re-arms; Base VaR is not used as a fallback; the skip is recorded with the adjusted status | R18.7, R18.1 | Ready |

### Cadence

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-CAD-01 | Emission interval target of 3,000 ms (fake clock) | R10.5 | Ready |
| AT-CAD-02 | Tolerance of 500 ms enforced on `\|interval - 3000\|` | R10.5 | Ready |
| AT-CAD-03 | p95 computed over a simulated five-minute window (nearest rank) | R10.5 | Ready |
| AT-CAD-04 | Provider delays are distinguished from application scheduling (jittered provider arrival does not change the emission p95) | R10.5 | Ready |
| AT-CAD-05 | No emission when no new observation exists; last value retained with timestamp | R10.6 | Ready |
| AT-CAD-06 | Scheduler continues during disconnect and states age to stale | R10.8 | Ready |
| AT-CAD-07 | Real-time five-minute soak run (non-blocking, scheduled) | R10.5 | Ready |

### Reproducibility

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-REP-01 | Same positions, market data, and configuration give the same Base VaR | R32.2 | Ready |
| AT-REP-02 | Same inputs give the same Adjusted VaR | R32.2 | Ready |
| AT-REP-03 | Configuration change changes configuration version and snapshot hash | R32.5, R32.7 | Ready |
| AT-REP-04 | Input change changes snapshot hash | R32.5 | Ready |
| AT-REP-05 | Canonical serialization is deterministic regardless of input key or array order | R32.3 | Ready |
| AT-REP-06 | Snapshot hash excludes the calculation timestamp | R32.4 | Ready |
| AT-REP-07 | Snapshot contains every field required by R32.1 | R32.1 | Ready |
| AT-REP-08 | Recalculating from a stored snapshot reproduces the stored result | R32.2 | Ready |
| AT-REP-09 | Changing only the `displayOnly` filing scores leaves the snapshot hash unchanged, and the full snapshot including `displayOnly` is persisted | R32.1, R32.4, R11.5 | Ready |
| AT-REP-10 | Byte-identical claims are made only for the canonical snapshot serialization | R32.6 | Ready |

### Dashboard and others

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-DSH-01 | Four separate dimensions displayed | R35.1 | Ready |
| AT-DSH-02 | Status labels use text, not color alone | R35.4 | Ready |
| AT-DSH-03 | Explanation of the Adjusted vs Base VaR difference or `NONE_TRIGGERED` when Adjusted VaR is available; when it is unavailable, the reason is shown and no difference is shown | R35.6 | Ready |
| AT-DSH-04 | Frame rate at or above 30 fps (5th percentile) under reference load | R23.1 | Blocked (OD-2) |
| AT-DSH-05 | Position change updates dashboard risk metrics end to end | R27.5, R16.1 | Ready |
| AT-DSH-06 | Filing score update changes the matrix but triggers no VaR recalculation | R16.5 | Ready |
| AT-DSH-07 | Recalculation requests coalesced per portfolio | R16.6 | Ready |
| AT-DSH-08 | A price change below `recalc.minValueChangePct` updates valuation only; at or above it updates VaR exposures | R16.2 | Ready |
| AT-DSH-09 | Dashboard shows NAV, long, short, gross, and net exposure, and cash | R17.1, R20.6 | Ready |
| AT-DSH-10 | Asset-level values, allocations, sentiment, and filing scores are shown with status, source type, and timestamp; risk contribution shows "not available"; an unavailable VaR is returned by the API as `null` with validity, status, and missing keys, and the dashboard shows the status as text, never a number or zero | R17.2, R17.4, R17.5, R17.6, R17.9, R17.10 | Ready |
| AT-DSH-11 | Triggered assets are listed with raw sentiment, effective sentiment, and direction | R35.5, R15.10 | Ready |
| AT-DSH-12 | Scale captions read 0 (low) to 1 (high risk) for filing and -1 (bearish) to +1 (bullish) for sentiment | R35.7, R10.3 | Ready |
| AT-DSH-13 | Money display rounds ROUND_HALF_UP to the currency minor unit (2 decimals; 0 for JPY) | FR-14 | Ready |
| AT-DSH-14 | VaR is described as a percentile-based loss estimate and never labelled maximum drawdown | R14.13, R18.6 | Ready |
| AT-DSH-15 | The API returns Base and Adjusted VaR as separate entries. With Base `CURRENT` and Adjusted `UNAVAILABLE`, the Base panel shows its figure, and the Adjusted panel shows "Unavailable" with the reason (no number, no zero, no Base figure). Any earlier Adjusted figure appears only labelled `LAST_VALID` with its timestamp | R17.10, R35.6 | Ready |
| AT-VAL-01 | Invalid scores cannot enter the risk engine | R21.4, R27.9 | Ready |
| AT-CFG-01 | Invalid configuration values rejected at load | Configuration | Ready |
| AT-CFG-02 | `.env.example` contains placeholders only; `.env` not tracked | R24.3, R24.4 | Ready |
| AT-CFG-03 | `npm test` runs tests and exits non-zero on failure | R27.10 | Ready |
| AT-CFG-04 | Fixtures live in tracked, non-ignored paths | R27.11 | Ready |
| AT-CFG-05 | For each financially significant setting, omitting it is reported with its key named, no value is substituted, the dependent feature is marked disabled, and the application still starts with unrelated features available | Configuration | Ready |
| AT-CFG-06 | Operational defaults are applied and logged at start, with provisional defaults flagged as provisional | Configuration | Ready |
| AT-CFG-07 | The committed configuration template contains exactly the approved baseline values and leaves the unresolved financial values as empty placeholders; the loader never reads the template, refuses the template path as runtime configuration, and with no runtime file reports every financially significant key as missing | Configuration | Ready |

### Audit and provenance

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-AUD-01 | Transactions retain source, timestamp, and source file hash | R22.1 | Ready |
| AT-AUD-02 | Filing analysis retains accession number, CIK, filing date, source URL, and analysis timestamp | R22.2 | Ready |
| AT-AUD-03 | Sentiment, market, and FX observations retain source, observation timestamp, and real or demo status | R22.3 | Ready |
| AT-AUD-04 | A VaR result records methodology and configuration version and traces to its position, market, FX, and sentiment inputs | R22.4, R22.5 | Ready |
| AT-AUD-05 | Ingestion, validation, provider, and calculation errors are audited with timestamps and without sensitive data | R22.6 | Ready |

### Architecture, build, and CI

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-ARC-01 | dependency-cruiser fails the build if `risk/` imports `sec/` or `nlp/`, or a domain module imports adapters, persistence implementations, `api/`, or `web/` | R26.10, R26.1, R11.5 | Ready |
| AT-ARC-02 | dependency-cruiser fails the build if `web/` imports a domain module | R26.10, R26.2 | Ready |
| AT-ARC-03 | `tsc` builds to `dist/`, and the compiled risk worker starts from its JavaScript entry point without a TypeScript loader | R26.8 | Ready |
| AT-ARC-04 | `package.json` declares `"type": "module"`, and `tsconfig.json` uses strict mode, `NodeNext`, and `verbatimModuleSyntax` | R26.4 | Ready |
| AT-ARC-05 | Every dependency is pinned to an exact version and the lockfile is committed | R26.5 | Ready |
| AT-ARC-06 | CI runs on Node.js 24.22.1 and Node.js 26, and fails if either fails | R27.12, R26.7 | Ready |
| AT-ARC-07 | CI fails on a type error, lint error, formatting difference, or boundary violation | R27.13 | Ready |

### Benchmarks

| ID | Test | Requirement | Status |
|---|---|---|---|
| AT-BEN-01 | VaR timing for 50 and 500 instruments with 250 scenarios is measured and recorded with the environment | R33.3 | Ready (record only); enforcement Blocked (OD-2) |
| AT-BEN-02 | Sentiment message handler timing is measured and recorded with the environment | R33.4 | Ready (record only); enforcement Blocked (OD-2) |

## Assumptions and Constraints

- **A-1** The repository currently contains no application code, dependencies, persistence layer, or authentication. All requirements are for new work.
- **A-2** The approved runtime is Node.js 24.22.1 with TypeScript (strict) and ES modules (R26.4, R26.7). The existing `package.json` still declares `"type": "commonjs"` and will be changed during project setup. No dependencies, including Decimal.js (R4), are installed yet.
- **A-3** The current `package.json` `test` script is a placeholder that fails; R27.10 requires replacing it.
- **A-4** `.gitignore` and `.kiroignore` already exclude `.env*`, credentials, `*.db`, `data/private/`, and `data/raw/`; test fixtures must live elsewhere (R27.11).
- **A-5** Version 1 supports a one-trading-day horizon only; multi-day horizons are out of scope.
- **A-6** Version 1 supports `BUY` and `SELL` transactions only. Dividends, splits, transfers, fees, and corporate actions are out of scope for transactions. Adjusted Close handles corporate actions for returns only.
- **A-7** Cash balance is a portfolio attribute that the user supplies explicitly (it may be `"0"`), because the transaction types do not derive it. A missing cash value is never treated as zero.
- **A-8** Historical Simulation applies historical returns to current exposures. It assumes the past distribution is informative and does not model liquidity or gap risk, except through the explicit sentiment stress assumption.
- **A-9** FX rates are held constant across historical scenarios. FX risk is not included in version 1 VaR when positions are in non-base currencies (a known limitation, OD-4).
- **A-10** The 1.15 multiplier and -0.60 threshold are stress assumptions, not statistical estimates.
- **A-11** The system never places orders.
- **A-12** Sentiment and filing text are processed by NLP providers that may be external; sending text to a third party is subject to the user's data-handling approval and must not include credentials.
- **A-13** "Provisional" applies only to operational defaults and performance budgets, which need confirmation after baseline measurement or stakeholder review. Financially significant settings never have provisional defaults; their proposed values are listed in OD-6 and must be supplied explicitly.
- **A-14** Calendar weekends are the only non-trading dates in version 1 until an exchange calendar is chosen (OD-3).
- **A-15** Version 1 is a local, single-user deployment bound to the loopback interface until an authentication mechanism is approved (OD-7, R29.1).
- **A-16** The ECB publication convention `ECB-PUB-1600-FRANKFURT-v1` assumes the EU summer-time rule in force since 1996 (last Sunday of March to last Sunday of October, 01:00 UTC). ECB reference rates start in 1999, so earlier dates never occur. A change of the rule needs a new convention id (R30.13).

### Decision record DR-KW-1: Kiroween 2026 hackathon scope (approved 2026-11-09)

These decisions apply to the hackathon demonstration only. They resolve no open decision for real use, and every OD below keeps its status.

- **H1** The Kiroween category is Frankenstein.
- **H2** The ECB reference rates with the EUR base are approved for the hackathon demo only (OD-5 stays open for real use). Direct and inverse rates are allowed. Inverse rates are attributed as derived values, never presented as published ECB observations (R30.14).
- **H3** A separate demo configuration holds explicitly provisional settings (Configuration policy 7). Approved on 2026-11-09 for the hackathon demo only, and confined to `config/demo/kiroween-2026.demo.jsonc` (listed in `demo.provisionalKeys`): `fx.maxRateAgeSeconds` 345600 (four days: weekends with a 24-hour margin and the 2026-27 Christmas and New Year closures of 96 hours; the 120-hour Easter closure is not covered, so ECB rates are `FX_STALE` on the morning after Easter Monday), `marketData.maxStalenessDays` 5, `marketData.maxReturnGapDays` 5, `recalc.minValueChangePct` "0.10", and `import.oversellPolicy` `REJECT`. They are not production defaults and resolve none of these settings for real use (OD-6 stays open).
- **H4** GitHub Pages static replay is the primary public demo. The backend is not exposed publicly (OD-7, A-15 unchanged). The replay is recorded deterministically (OD-21, resolved 2026-11-09): `npm run export:replay` records the real backend in demo mode at the fixed reference clock 2026-11-06T16:00:00.000Z from DEMO fixtures and one recorded ECB response. `.github/workflows/pages.yml` validates the change, builds, records the replay, runs the Playwright tests, and deploys only `dist/web/` to Pages. The page goes live only after the one-time repository setting Pages source "GitHub Actions" is made and a run on `main` succeeds.
- **H5** Only the hackathon DEMO mode (`--demo-fixtures`) is implemented. Production start-up stays blocked (OD-13, OD-19).
- **H6** A seeded, deterministic EUR/USD/GBP demo portfolio (and an EUR-only fallback portfolio) exercises FX conversion into EUR.
- **H7** Adjusted VaR stays unavailable with its reason: no aggregation formula is approved (OD-1), and DEMO sentiment is never eligible (R15). The approved explanation states this explicitly: when no aggregator is assembled, every unavailable Adjusted VaR explanation starts with "No sentiment aggregation method is approved (open decision OD-1), ..." and the dashboard response carries `reasonCode` `AGGREGATION_NOT_APPROVED` with `openDecision` `OD-1`; the VaR status codes are unchanged. OD-1 itself stays open.
- **H8** Live SEC integration is deferred until after the hackathon; no filing score is shown or fabricated.

## Open Decisions

This table is the single register of decisions. The design's decision register (design `U-n` and `D-n` entries) refers to these IDs. Status values: **Open** (not decided), **Provisional** (approved for now, to be confirmed), **Resolved** (approved). The "Needed by" column refers to the design's delivery phases.

| ID | Status | Decision needed | Affects | Interim position or recommendation | Needed by |
|---|---|---|---|---|---|
| OD-1 | Open | Numeric sentiment aggregation formula (window length, observation weighting, source weighting) | R10.1, AT-SEN-21 | Recommendation: `windowed-mean-v1`, an equal-weight mean of `REAL` observations within `sentiment.windowSeconds` (proposed 300 s). Needs approval, including zero-observation and multi-provider behaviour. | Phase 4 |
| OD-2 | Open | Reference hardware and OS for benchmarks (Node.js version resolved by OD-11) | NFR-PERF-1, R33, R23 | Record CPU, RAM, OS, and Node.js version with every benchmark run until a reference is agreed. Budgets are not enforced until then. | Phase 8 |
| OD-3 | Open | Exchange holiday calendar source | FR-3.1 | Weekends only. | Not blocking for v1 |
| OD-4 | Open | Inclusion of FX risk in VaR scenarios | A-9, R30.7 | FX held constant. | Not blocking for v1 |
| OD-5 | Open | Default FX rate provider | R30.3, R30.13, R30.14 | Provider-independent interface; recorded-fixture provider for tests. A candidate provider must be checked for exponent notation in its numbers, which R4.6 rejects. Proposed: the ECB data API (EXR, `format=csvdata`, `detail=dataonly`) when `fx.baseCurrency` is EUR, with convention `ECB-PUB-1600-FRANKFURT-v1`. Decision record DR-FX-1 conditionally approves the financial configuration (`fx.baseCurrency` = EUR, `fx.provider` = `ECB`; Configuration policy 2); it does not resolve this decision, which stays open until the conditions below are met. Non-EUR bases need another provider; triangulation is forbidden (R30.8). Before implementation: live verification that the ECB accepts `endPeriod` together with `lastNObservations=2` (otherwise a start-period window design is needed), and legal confirmation that derived (inverted) values and use for risk monitoring fit the ECB reuse policy and its "information purposes" statement (R30.14). **Hackathon scope (decision DR-KW-1, H2, 2026-11-09):** the ECB route with the EUR base is approved for the Kiroween 2026 demo only, with direct and inverse rates; every inverse rate is attributed as derived from, not identical to, the published reference rate (R30.14, `fxAttribution`). This is not a production-provider approval: for real use the decision stays open (legal confirmation). The live query check is done: on 2026-11-09 the ECB accepted `endPeriod` with `lastNObservations=2` and answered `text/csv` with the fixed header and CRLF line endings; it also answered HTTP 504 intermittently. Task 10.2 is implemented within this scope. | Phase 3 (fixtures suffice) |
| OD-6 | Open | Values for financially significant settings without an approved baseline, and approval of provisional operational defaults | R9.9, R13.4, R15, R16.2, R18, R28.20, R30.8, R31, R34, FR-3.5, Configuration | Financial, no default, proposals only: `sentiment.maxAgeSeconds` 900; `sentiment.maxFutureSkewSeconds` 5; `marketData.maxStalenessDays` 5; `marketData.maxReturnGapDays` 5; `fx.maxRateAgeSeconds` 86,400 (the final value remains open; staleness is measured at the calculation timestamp, R30.8, so the approved value must cover weekends and market closures; 86,400 seconds does not cover a normal Friday-to-Monday interval, so with it a Monday calculation using Friday's rate is `FX_STALE` and VaR is unavailable); `filing.maxAgeDays` 120; `recalc.minValueChangePct` 0.10; `import.oversellPolicy` `REJECT`; `alerts.resetPct` and `alerts.filing.resetThreshold` equal to their thresholds; `alerts.var.thresholdPct` and `alerts.filing.threshold` no proposal. Operational, provisional defaults: `alerts.cooldownSeconds` 900; severity ratios 1.25 / 1.50; `sec.item1a.minChars` 500; `fx.ecb.timeoutMs` 10,000; `fx.ecb.maxResponseBytes` 1,048,576; `fx.ecb.cacheMaxEntries` 64. **Hackathon demo only (DR-KW-1, H3, approved 2026-11-09):** the separate demo configuration (`config/demo/kiroween-2026.demo.jsonc`) carries `fx.maxRateAgeSeconds` 345600, `marketData.maxStalenessDays` 5, `marketData.maxReturnGapDays` 5, `recalc.minValueChangePct` "0.10", and `import.oversellPolicy` `REJECT`, all listed in `demo.provisionalKeys`; they are not values for real use. Measured from recorded ECB data (convention instant 16:00 Frankfurt): consecutive publications are 24 hours apart on weekdays, 72 hours over a weekend (Friday to Monday), and 120 hours over Easter (2 to 7 April 2026) and Christmas (24 to 29 December 2025). The other unresolved values in the demo file stay empty as well. | Phase 2 (`oversellPolicy`), 3, 4, 5, 7 |
| OD-7 | Open | Authentication and authorization mechanism and roles | R29.1 to R29.3, A-15 | Recommendation: v1 is local single-user only, bound to 127.0.0.1, with no network deployment until decided. | Phase 8, or before any network exposure |
| OD-8 | Open | Handling of identical trades without `external_id` across different files | R28.14 | Treated as duplicates; documented limitation. | Not blocking for v1 |
| OD-9 | Open | Supported FIX versions, message types, and required tags | R2 | Recommendation: `ExecutionReport` (35=8) only. The trade-signalling `ExecType` (150) values differ between FIX 4.2 and 4.4, so the supported version must be chosen from real sample logs. | Phase 6 |
| OD-10 | Open | Method for asset-level risk contribution | R17.6 | Displayed as "not available" until defined. | Not blocking for v1 |
| OD-11 | Resolved | Language, runtime, module system, toolchain, frontend, and end-to-end testing | R26.4 to R26.10, R27.5, R27.12, R27.13 | TypeScript strict; ES modules (`"type": "module"`, `NodeNext`, `verbatimModuleSyntax`); `tsc` to `dist/`; Node.js 24.22.1 with Node.js 26 in CI; Zod 4, Decimal.js, Vitest, fast-check, ESLint with typescript-eslint, Prettier, dependency-cruiser; exact pins and committed lockfile; React with Vite; Playwright. | Phase 1 |
| OD-12 | Resolved | Persistence technology and transaction semantics | R28.15 to R28.17, R22, R32 | SQLite through the built-in `node:sqlite`, behind an internal driver interface and the repository ports; WAL with `synchronous=FULL`; multi-process access with a bounded busy timeout (an exhausted wait is `COMMIT_FAILED`); one `BEGIN IMMEDIATE` transaction per unit of work; database path from `SRC_DATABASE_FILE`, required in production with no in-memory fallback; `INTEGRITY_ERROR` for stored records that fail decoding, validation, or integrity checks; the implemented ports are authoritative for the schema; config-version persistence is a separate task. | Phase 2 |
| OD-13 | Open | Market data and sentiment provider selection | R9, R12 | Interfaces only; recorded-fixture providers for tests. A candidate provider must be checked for exponent notation in its numbers, which R4.6 rejects. | Phase 3 and 4 (fixtures suffice) |
| OD-14 | Open | Handling of negative NAV or leverage beyond display (for example margin accounts) | R18.5, R20.6 | Percentage metrics unavailable when NAV <= 0. | Not blocking for v1 |
| OD-15 | Open | NLP input chunking: maximum input size per request and how chunk scores combine into one FilingRiskScore | R7.1, R7.2, `nlp.maxInputChars` | Recommendation: split at `nlp.maxInputChars`, combine chunk scores by maximum severity, and record the method version. | Phase 7 |
| OD-16 | Open | Lossless JSON parser library for provider payloads | R4.2, R4.6, R12 | A maintained parser that keeps numeric tokens as text, pinned exactly. No candidate evaluated yet. | Phase 3 |
| OD-17 | Resolved | HTTP and WebSocket framework | R26.9 | Resolved 2026-11-08: Fastify 5 confirmed, exact pin `fastify` 5.12.8. Conditions:<br>(1) Fastify's built-in logger is disabled; all logging goes through the shared redacting logger (R29.13).<br>(2) Zod remains the validation authority: route body, query, and parameters are validated by project Zod schemas through a project validator compiler, with no type-provider dependency.<br>(3) Generic error and not-found handlers return `{ error: { code, message, correlationId } }`, with no stack trace, path, or echoed input (R29.13).<br>(4) An explicit request body limit of 1 MiB.<br>(5) Every financial input is a decimal string; a JSON number is rejected by the schema (R4.2).<br>(6) The WebSocket and multipart plugins are added and pinned by their own tasks. | Resolved |
| OD-18 | Resolved | Exponent notation at input boundaries | R4.6 | Exponent notation is rejected entirely as a fixed parsing rule (R4.6); no exponent-limit setting exists. The remaining compatibility check, whether a candidate provider emits exponent notation, is part of provider selection (OD-5, OD-13). | Resolved |
| OD-19 | Open | How production mode is determined for R30.11 (DEMO FX data refused in production) | R30.11, AT-FX-11 | No mode exists yet. Recommendation for review: a financially significant setting with no default whose absence makes Base VaR `CONFIG_MISSING`; name and values to be approved. Until resolved, every calculation that used DEMO FX data is flagged and labelled DEMO (AT-FX-10). | Phase 3 (before 12.3's production-mode rule) |
| OD-20 | Resolved | Persistence of the published ECB observation behind each derived FX rate | R30.5, R30.14, R22.3, R32 | Resolved 2026-11-09 (option 2): SQLite migration 2 adds nullable `fx_rates` columns `published_pair`, `published_rate`, `published_reference_date`, `derivation_method` (`AS_PUBLISHED` or `DECIMAL_INVERSE`), and `derivation_precision` (`SIGNIFICANT_DIGITS_40_ROUND_HALF_UP`); `FxRateRecord.published` carries them. Rows written before migration 2 keep NULLs and stay valid. The quote is all-or-nothing and consistent with the stored pair (adapter rule and insert trigger). The FX service reports the quote through `rateToBaseQuoted`; the recorder stores it; `FxRateUsed`, risk inputs, snapshots, rate selection, and the 40-digit inverse are unchanged. The published value is stored as canonical decimal text (numerically exact; every recorded ECB value is already canonical), not as a byte copy, because financial-rules 6 limits verbatim decimal text to the series exception C2. The positions response exposes it as `fxRate.quote`. | Delivered (hackathon scope) |
| OD-21 | Resolved | Static replay export for the public demo (DR-KW-1 H4) | R17, R30.14, R35 | Resolved 2026-11-09: (1) recorded from deterministic fixtures (DEMO market data and one recorded ECB response, SHA-256 checked), never a live request during deployment; (2) fixed reference clock 2026-11-06T16:00:00.000Z, matching the DEMO market-data as-of date and the ECB reference date 2026-11-06 (published 15:00Z under the convention); (3) a GitHub Actions workflow builds, records, tests, and deploys to GitHub Pages. Exporter `src/main/replayExport.ts`; manifest `DashboardReplayManifestSchema`. | Delivered; live only after the one-time Pages setting and a successful run on `main` |

### Final requirement ID list

R1 to R27 (existing, preserved or revised) and R28 to R35 (new). Supporting identifiers: NFR-PERF-1, FR-1 to FR-14, OD-1 to OD-18, A-1 to A-15, and test IDs `AT-*`.
