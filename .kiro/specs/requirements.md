# Requirements Document

## Introduction

**Spectral Risk Chimera** is a real-time, multi-source portfolio risk analysis application. Its purpose is to combine financial transaction records, historical market prices, SEC regulatory filings, and market sentiment data into a unified portfolio risk monitoring system.

The system will support CSV and FIX transaction ingestion, automated portfolio position normalization, SEC 10-K and 10-Q filing analysis, real-time sentiment monitoring, historical Value-at-Risk (VaR) calculations, risk alerts, and interactive dashboard visualizations.

The application is designed for portfolio managers, risk analysts, traders, and quantitative strategists. It is an analytical and monitoring platform, not an automated trading or order execution system.

The system must prioritize financial calculation accuracy, data integrity, traceability, reliability, and transparent reporting. Real external data must be distinguished from cached, unavailable, and demo data.

## Requirements

### Requirement 1: CSV Transaction Import

**User Story:** As a Risk Analyst, I want to upload CSV transaction files, so that historical financial transactions can be imported and converted into standardized portfolio positions without manual processing.

#### Acceptance Criteria

1. WHEN a user uploads a valid CSV transaction file THE SYSTEM SHALL parse its records and normalize supported fields into a standardized Transaction schema.
2. WHEN a CSV file contains configurable column names THE SYSTEM SHALL allow the corresponding columns to be mapped to the standardized transaction fields.
3. WHEN a CSV file contains 10,000 valid transaction records THE SYSTEM SHALL parse and normalize those records within 500 milliseconds in the defined benchmark environment, excluding file upload and database persistence time.
4. WHEN a CSV file is successfully processed THE SYSTEM SHALL return a summary containing the total number of records, successfully imported records, rejected records, and skipped records.
5. WHEN a CSV file is empty, unsupported, or unreadable THE SYSTEM SHALL return a descriptive validation error without crashing the application.

### Requirement 2: FIX Transaction Import

**User Story:** As a Risk Analyst, I want to import legacy FIX transaction logs, so that supported financial messages can be converted into standardized transactions and portfolio positions.

#### Acceptance Criteria

1. WHEN a user uploads a supported FIX log file THE SYSTEM SHALL parse the supported FIX messages and extract relevant transaction information.
2. WHEN a supported FIX message contains valid instrument identifiers, transaction direction, quantity, price, and timestamp THE SYSTEM SHALL normalize the extracted information into the Transaction schema.
3. WHEN a FIX message uses an unsupported message type or contains malformed fields THE SYSTEM SHALL reject that message and record the reason.
4. WHEN a FIX file contains both valid and invalid messages THE SYSTEM SHALL process valid messages without terminating the entire import operation.
5. THE SYSTEM SHALL document the supported FIX versions, message types, and tag mappings.

### Requirement 3: Invalid Transaction Handling

**User Story:** As a Risk Analyst, I want invalid financial records to be identified and isolated, so that corrupted data cannot compromise portfolio calculations.

#### Acceptance Criteria

1. WHEN an imported record contains malformed numerical values, missing required fields, or invalid instrument identifiers THE SYSTEM SHALL reject the affected record and record a descriptive validation error.
2. WHEN an imported file contains invalid records alongside valid records THE SYSTEM SHALL continue processing all valid records.
3. WHEN a record is rejected THE SYSTEM SHALL create an audit entry containing the source, record identifier where available, timestamp, and rejection reason.
4. THE SYSTEM SHALL prevent rejected records from entering portfolio position and risk calculations.
5. THE SYSTEM SHALL provide the user with an import summary containing the number of accepted and rejected records.

### Requirement 4: Financial Precision

**User Story:** As a Quantitative Strategist, I want financial calculations to use precise decimal arithmetic, so that rounding errors do not accumulate across portfolio and risk calculations.

#### Acceptance Criteria

1. THE SYSTEM SHALL use Decimal.js for financial arithmetic, including transaction values, quantities, prices, position values, allocation percentages, and risk calculations.
2. THE SYSTEM SHALL NOT use JavaScript IEEE-754 floating-point arithmetic for financial calculations.
3. WHEN financial values are serialized to JSON THE SYSTEM SHALL preserve decimal precision using appropriate decimal string representations.
4. WHEN financial values are converted to JavaScript numbers for chart rendering or presentation THE SYSTEM SHALL perform the conversion only at the presentation boundary.
5. WHEN financial calculations are performed repeatedly THE SYSTEM SHALL preserve the configured decimal precision without unintended rounding loss.

### Requirement 5: Standardized Portfolio Positions

**User Story:** As a Portfolio Manager, I want transactions from different data sources to produce standardized portfolio positions, so that the entire application can analyze assets consistently.

#### Acceptance Criteria

1. WHEN valid transactions are imported THE SYSTEM SHALL convert them into standardized portfolio position updates.
2. THE SYSTEM SHALL maintain a common Position model containing at least an identifier, portfolio identifier, ticker, quantity, average price, market price, market value, currency, allocation percentage, source, and update timestamp.
3. WHEN multiple transactions affect the same asset THE SYSTEM SHALL aggregate their effects into the corresponding portfolio position.
4. THE SYSTEM SHALL distinguish imported transaction records from aggregated portfolio positions.
5. WHEN a portfolio position changes THE SYSTEM SHALL make the updated position available to the portfolio risk calculation engine.

### Requirement 6: SEC Filing Retrieval and Extraction

**User Story:** As a Portfolio Manager, I want to retrieve SEC 10-K and 10-Q filings and extract their risk disclosures, so that corporate risk information can be incorporated into portfolio monitoring.

#### Acceptance Criteria

1. WHEN a user provides a valid SEC filing URL or supported company identifier THE SYSTEM SHALL retrieve the corresponding filing using official SEC EDGAR resources where possible.
2. WHEN a filing is successfully retrieved THE SYSTEM SHALL identify its company, ticker where available, filing type, filing date, and source URL.
3. WHEN a 10-K or 10-Q filing contains an Item 1A section THE SYSTEM SHALL identify and extract its Risk Factors content.
4. WHEN the extracted filing content is HTML or otherwise contains formatting THE SYSTEM SHALL normalize it into clean text suitable for NLP processing.
5. WHEN an Item 1A section is missing, inaccessible, or cannot be extracted THE SYSTEM SHALL return a descriptive status rather than generating a fabricated result.
6. THE SYSTEM SHALL use configurable SEC identification information, respect applicable SEC rate limits, and handle unsuccessful requests gracefully.

### Requirement 7: SEC Filing Risk Analysis

**User Story:** As a Portfolio Manager, I want SEC risk disclosures to be analyzed and converted into numerical risk scores, so that qualitative corporate risks can be monitored consistently.

#### Acceptance Criteria

1. WHEN valid Item 1A text is available THE SYSTEM SHALL pass the extracted text to the configured NLP analysis module.
2. WHEN filing analysis is completed THE SYSTEM SHALL produce a FilingRiskScore within the range of 0.00 to 1.00.
3. THE SYSTEM SHALL interpret a score of 0.00 as minimal identified risk and a score of 1.00 as very high identified risk.
4. WHEN risk categories can be identified THE SYSTEM SHALL classify them into categories such as market risk, liquidity risk, credit risk, operational risk, regulatory risk, legal risk, cybersecurity risk, and business risk.
5. THE SYSTEM SHALL retain the filing type, filing date, company ticker, source URL, analysis timestamp, scoring method, and identified risk categories alongside the score.
6. THE SYSTEM SHALL distinguish the severity of disclosed risk from the probability of a stock price decline.
7. WHEN filing analysis fails THE SYSTEM SHALL report the failure and SHALL NOT present an unverified score as genuine analysis.

### Requirement 8: Configurable NLP Provider

**User Story:** As a System Administrator, I want NLP providers to be interchangeable, so that the application can support different analysis models without changing its core functionality.

#### Acceptance Criteria

1. THE SYSTEM SHALL use a provider-independent interface for NLP analysis.
2. WHEN an NLP provider is configured THE SYSTEM SHALL use that provider to analyze supported filing and sentiment text.
3. WHEN no NLP provider or credentials are configured THE SYSTEM SHALL support an explicitly identified demo or fallback mode.
4. THE SYSTEM SHALL identify whether an analysis result was generated by a real NLP provider or a fallback implementation.
5. THE SYSTEM SHALL NOT present demo or fallback analysis results as genuine external AI analysis.

### Requirement 9: Market Sentiment Data Ingestion

**User Story:** As a Quantitative Strategist, I want to ingest market sentiment from external REST and WebSocket APIs, so that sentiment changes can be monitored for individual assets.

#### Acceptance Criteria

1. WHEN a REST sentiment provider is configured THE SYSTEM SHALL retrieve and normalize supported sentiment data.
2. WHEN a WebSocket sentiment provider is configured THE SYSTEM SHALL establish a connection and process incoming sentiment messages.
3. WHEN a sentiment message contains a supported asset ticker THE SYSTEM SHALL associate the message with that asset.
4. WHEN a WebSocket connection is interrupted THE SYSTEM SHALL attempt to reconnect according to a configurable retry policy.
5. WHEN duplicate, malformed, or invalid sentiment messages are received THE SYSTEM SHALL handle them without crashing the application.
6. THE SYSTEM SHALL record the source and timestamp of each valid sentiment observation.
7. THE SYSTEM SHALL distinguish current data from cached, stale, unavailable, and demo data.

### Requirement 10: Sentiment Aggregation and Normalization

**User Story:** As a Quantitative Strategist, I want incoming market sentiment to be converted into a standardized Bullish/Bearish Sentiment Index, so that sentiment can be compared across portfolio assets.

#### Acceptance Criteria

1. WHEN valid sentiment observations are received THE SYSTEM SHALL aggregate them into a ticker-specific SentimentIndex.
2. THE SYSTEM SHALL constrain every valid SentimentIndex to the inclusive range of -1.00 to +1.00.
3. THE SYSTEM SHALL interpret -1.00 as Extreme Bearish, 0.00 as Neutral, and +1.00 as Extreme Bullish.
4. WHEN new sentiment observations are received THE SYSTEM SHALL update the corresponding sentiment state.
5. THE SYSTEM SHALL publish aggregated sentiment updates approximately every 3 seconds when new observations are available.
6. WHEN no new sentiment observations are available THE SYSTEM SHALL preserve the last valid score and display its last update timestamp.
7. WHEN an external sentiment result falls outside the permitted range THE SYSTEM SHALL reject it and record a validation error.

### Requirement 11: Separation of Regulatory Risk and Market Sentiment

**User Story:** As a Quantitative Strategist, I want regulatory risk and market sentiment to remain independent measurements, so that fundamentally different sources of information are not incorrectly combined.

#### Acceptance Criteria

1. THE SYSTEM SHALL maintain FilingRiskScore and SentimentIndex as separate measurements.
2. THE SYSTEM SHALL use FilingRiskScore to represent the severity of risks disclosed in regulatory filings.
3. THE SYSTEM SHALL use SentimentIndex to represent the directional mood of market participants.
4. THE SYSTEM SHALL NOT automatically interpret negative regulatory disclosures as bearish sentiment.
5. WHEN both values are available for an asset THE SYSTEM SHALL make them independently available to the portfolio risk matrix.
6. THE SYSTEM SHALL NOT combine these measurements into a single score without an explicitly documented and configurable aggregation formula.

### Requirement 12: Historical Market Data

**User Story:** As a Risk Analyst, I want the system to retrieve historical prices for portfolio assets, so that portfolio risk can be calculated from actual market observations.

#### Acceptance Criteria

1. WHEN a supported asset is included in a portfolio THE SYSTEM SHALL support retrieval of its historical market prices through a configurable market data provider.
2. THE SYSTEM SHALL support historical daily price observations for VaR calculations.
3. WHEN historical prices are retrieved THE SYSTEM SHALL normalize timestamps, ticker identifiers, and currency information.
4. THE SYSTEM SHALL support calculating daily asset returns from historical price observations.
5. THE SYSTEM SHALL handle missing, delayed, invalid, or unavailable market data.
6. THE SYSTEM SHALL retain source and timestamp information for retrieved market observations.
7. THE SYSTEM SHALL support caching historical market data where appropriate.
8. THE SYSTEM SHALL use a provider-independent market data interface.

### Requirement 13: Insufficient Market Data Handling

**User Story:** As a Risk Analyst, I want incomplete historical data to be identified, so that unreliable VaR calculations are not presented as valid results.

#### Acceptance Criteria

1. WHEN historical market observations are insufficient for the configured VaR calculation THE SYSTEM SHALL return an `INSUFFICIENT_DATA` calculation status.
2. WHEN required market prices are missing or invalid THE SYSTEM SHALL identify the affected assets.
3. THE SYSTEM SHALL NOT fabricate historical prices or return a fabricated VaR result.
4. WHEN stale or incomplete market data is used THE SYSTEM SHALL clearly identify the data limitations.
5. THE SYSTEM SHALL preserve the last valid calculation while clearly distinguishing it from a current calculation.

### Requirement 14: Historical Simulation Value-at-Risk

**User Story:** As a Portfolio Manager, I want the system to calculate portfolio Value-at-Risk using historical market observations, so that I can estimate potential portfolio losses under historical market conditions.

#### Acceptance Criteria

1. WHEN sufficient historical market data and valid portfolio positions are available THE SYSTEM SHALL calculate portfolio Value-at-Risk using Historical Simulation as the default methodology.
2. THE SYSTEM SHALL use a default confidence level of 95%.
3. THE SYSTEM SHALL use a default risk horizon of one trading day.
4. THE SYSTEM SHALL use a configurable historical lookback period with a default of 250 trading days.
5. WHEN daily asset returns are available THE SYSTEM SHALL apply those returns to the corresponding portfolio market exposures to generate historical portfolio profit and loss scenarios.
6. THE SYSTEM SHALL aggregate the asset-level profit and loss observations into portfolio-level daily profit and loss scenarios.
7. THE SYSTEM SHALL calculate the 5th percentile of the historical portfolio profit and loss distribution.
8. THE SYSTEM SHALL report the corresponding potential loss as a positive VaR value.
9. THE SYSTEM SHALL provide both absolute VaR in the portfolio base currency and VaR as a percentage of portfolio value.
10. THE SYSTEM SHALL display the confidence level, risk horizon, lookback period, calculation status, and data timestamp alongside each VaR result.
11. WHEN the portfolio value is zero or the calculation inputs are invalid THE SYSTEM SHALL return an appropriate calculation status rather than a misleading percentage.

### Requirement 15: Bearish Sentiment Downside Adjustment

**User Story:** As a Quantitative Strategist, I want extreme bearish sentiment to increase the estimated downside risk of the affected asset, so that potential market panic and illiquidity are reflected in adjusted portfolio risk.

#### Acceptance Criteria

1. WHEN an asset has a valid SentimentIndex below -0.60 THE SYSTEM SHALL apply a downside stress multiplier of 1.15 to that asset's negative historical scenario contributions.
2. WHEN an asset has a SentimentIndex greater than or equal to -0.60 THE SYSTEM SHALL use a downside multiplier of 1.00.
3. WHEN the downside adjustment is applied THE SYSTEM SHALL increase the magnitude of negative asset-level scenario contributions by 15% without increasing positive contributions.
4. THE SYSTEM SHALL recalculate the adjusted portfolio P&L scenarios using the affected asset-level downside adjustments.
5. THE SYSTEM SHALL calculate adjusted VaR from the resulting adjusted portfolio loss distribution.
6. THE SYSTEM SHALL NOT automatically multiply the entire portfolio VaR by 1.15 because of one bearish asset.
7. THE SYSTEM SHALL display base VaR and sentiment-adjusted VaR separately.
8. THE SYSTEM SHALL identify which assets triggered the downside adjustment.
9. THE SYSTEM SHALL identify the 1.15 multiplier as a configurable downside stress adjustment rather than claiming it is a statistically estimated change in market volatility.

### Requirement 16: Dynamic Portfolio Risk Recalculation

**User Story:** As a Trader, I want portfolio risk metrics to update when relevant underlying data changes, so that the dashboard reflects current portfolio exposure and risk conditions.

#### Acceptance Criteria

1. WHEN a portfolio position changes THE SYSTEM SHALL recalculate the affected portfolio risk metrics.
2. WHEN a relevant market price changes portfolio exposure THE SYSTEM SHALL update the corresponding portfolio valuation and risk calculations.
3. WHEN new historical market observations become available THE SYSTEM SHALL make them available to the risk calculation engine.
4. WHEN an asset's SentimentIndex changes THE SYSTEM SHALL update its downside adjustment state and recalculate affected risk metrics.
5. WHEN a new SEC FilingRiskScore becomes available THE SYSTEM SHALL update the asset's regulatory risk information in the risk matrix.
6. THE SYSTEM SHALL avoid unnecessary recalculations when incoming data does not materially affect the portfolio.
7. THE SYSTEM SHALL retain calculation timestamps and statuses for updated risk results.

### Requirement 17: Integrated Portfolio Risk Matrix

**User Story:** As a Portfolio Manager, I want to see portfolio exposure, VaR, sentiment, and filing risk in one dashboard, so that I can understand the different factors affecting portfolio risk.

#### Acceptance Criteria

1. THE SYSTEM SHALL display total portfolio market value.
2. THE SYSTEM SHALL display asset-level market values and allocation percentages.
3. THE SYSTEM SHALL display base portfolio VaR.
4. THE SYSTEM SHALL display sentiment-adjusted downside VaR.
5. THE SYSTEM SHALL display the SentimentIndex for each asset where valid data is available.
6. THE SYSTEM SHALL display the FilingRiskScore for each asset where a filing analysis is available.
7. THE SYSTEM SHALL display asset-level risk contributions where they can be calculated.
8. THE SYSTEM SHALL clearly distinguish missing, stale, unavailable, and demo data.
9. THE SYSTEM SHALL NOT combine unrelated risk and sentiment measurements into an undocumented single score.
10. THE SYSTEM SHALL provide data timestamps and calculation status for important displayed metrics.

### Requirement 18: Configurable Risk Alerts

**User Story:** As a Risk Analyst, I want to receive alerts when portfolio risk exceeds configured limits, so that I can identify potentially dangerous exposure changes.

#### Acceptance Criteria

1. WHEN adjusted portfolio VaR exceeds a configured threshold THE SYSTEM SHALL generate a risk alert.
2. THE SYSTEM SHALL use 15% of portfolio value as the default example threshold for adjusted one-day 95% VaR.
3. THE SYSTEM SHALL allow the risk threshold to be configured.
4. WHEN an alert is generated THE SYSTEM SHALL assign an appropriate priority and severity.
5. THE SYSTEM SHALL distinguish VaR from maximum drawdown and SHALL NOT label VaR as maximum drawdown risk.
6. THE SYSTEM SHALL support alert deduplication or cooldown handling to prevent repeated notifications for the same unresolved condition.

### Requirement 19: Risk Alert Events

**User Story:** As a Trader, I want risk alerts to appear on the dashboard when thresholds are exceeded, so that I can react to important changes in portfolio risk.

#### Acceptance Criteria

1. WHEN a risk alert is generated THE SYSTEM SHALL publish an event to the dashboard event bus.
2. THE SYSTEM SHALL include a unique alert identifier, portfolio identifier, severity, metric name, observed value, configured threshold, timestamp, and human-readable description in the alert payload.
3. WHEN an individual asset causes or contributes materially to an alert THE SYSTEM SHALL include its ticker where applicable.
4. WHEN an alert is dismissed or resolved THE SYSTEM SHALL preserve its alert history.
5. THE SYSTEM SHALL handle alert publishing failures without crashing portfolio calculations.

### Requirement 20: Portfolio Allocation Integrity

**User Story:** As a Portfolio Manager, I want portfolio allocation percentages to be calculated consistently, so that portfolio exposure is represented accurately.

#### Acceptance Criteria

1. WHEN a fully invested, long-only portfolio is normalized THE SYSTEM SHALL calculate allocation percentages that total exactly 100.00% at the configured display precision.
2. THE SYSTEM SHALL use Decimal.js for allocation calculations.
3. WHEN displayed percentage rounding creates a residual THE SYSTEM SHALL assign the rounding residual deterministically.
4. WHEN a portfolio contains short positions, leverage, or unallocated cash THE SYSTEM SHALL NOT force its allocation percentages to total 100.00%.
5. THE SYSTEM SHALL report gross exposure, net exposure, and cash separately where applicable.
6. THE SYSTEM SHALL distinguish between raw exposure values and normalized long-only allocation percentages.

### Requirement 21: Risk Score and Sentiment Validation

**User Story:** As a Risk Analyst, I want risk and sentiment scores to be validated before use, so that invalid external or internal results cannot contaminate the risk engine.

#### Acceptance Criteria

1. WHEN a FilingRiskScore is calculated THE SYSTEM SHALL verify that its value is within the inclusive range of 0.00 to 1.00.
2. WHEN a SentimentIndex is calculated THE SYSTEM SHALL verify that its value is within the inclusive range of -1.00 to +1.00.
3. WHEN either score falls outside its permitted range THE SYSTEM SHALL reject the result and record a descriptive validation error.
4. THE SYSTEM SHALL prevent rejected scores from entering portfolio risk calculations.
5. THE SYSTEM SHALL preserve the source and timestamp of validated scores.

### Requirement 22: Data Provenance and Auditability

**User Story:** As a Risk Analyst, I want the system to retain information about the origin of its financial data and calculations, so that results can be reviewed and traced.

#### Acceptance Criteria

1. THE SYSTEM SHALL retain source and timestamp information for imported transactions.
2. THE SYSTEM SHALL retain filing identifiers, filing dates, source URLs, and analysis timestamps for SEC filing analysis.
3. THE SYSTEM SHALL retain source and observation timestamps for sentiment and market data.
4. THE SYSTEM SHALL retain the calculation methodology and relevant configuration used for each portfolio VaR result.
5. THE SYSTEM SHALL provide sufficient information to trace a risk calculation to its underlying portfolio positions and market observations.
6. THE SYSTEM SHALL record relevant ingestion errors, validation failures, external provider failures, and calculation errors.

### Requirement 23: Dashboard Performance

**User Story:** As a Trader, I want the dashboard to remain responsive when live data updates, so that I can monitor portfolio risk without interface interruptions.

#### Acceptance Criteria

1. WHILE the application is processing representative live asset price and sentiment updates THE SYSTEM SHALL target at least 30 frames per second for dashboard rendering.
2. THE SYSTEM SHALL batch or throttle frequent incoming updates where appropriate.
3. THE SYSTEM SHALL avoid unnecessary full-page and full-dashboard re-rendering.
4. THE SYSTEM SHALL keep intensive financial calculations separate from presentation components.
5. THE SYSTEM SHALL preserve dashboard responsiveness when external data providers are temporarily unavailable.

### Requirement 24: Credential and Application Security

**User Story:** As a System Administrator, I want external credentials and sensitive configuration to be stored securely, so that application integrations cannot expose private information.

#### Acceptance Criteria

1. THE SYSTEM SHALL NOT hardcode API keys, private keys, or credentials in application source files.
2. THE SYSTEM SHALL retrieve sensitive configuration from environment variables or an appropriate secrets manager.
3. THE SYSTEM SHALL provide an `.env.example` file containing placeholder values only.
4. THE SYSTEM SHALL exclude actual `.env` files and sensitive credentials from version control.
5. THE SYSTEM SHALL NOT expose private API credentials through frontend code or client-side responses.
6. THE SYSTEM SHALL validate uploaded files and incoming external API payloads.
7. THE SYSTEM SHALL prevent sensitive credentials from being written to application logs.
8. THE SYSTEM SHALL use secure communication protocols for supported external API and WebSocket connections.

### Requirement 25: External Provider Reliability

**User Story:** As a System Administrator, I want the application to handle external provider failures gracefully, so that one unavailable integration does not bring down the entire application.

#### Acceptance Criteria

1. WHEN an external market data, SEC, sentiment, or NLP provider becomes unavailable THE SYSTEM SHALL report the provider status without crashing the application.
2. WHEN a provider request fails THE SYSTEM SHALL use an appropriate retry policy where applicable.
3. THE SYSTEM SHALL preserve previously stored valid data when new data cannot be retrieved.
4. THE SYSTEM SHALL clearly identify stale, cached, unavailable, and demo data.
5. THE SYSTEM SHALL NOT silently replace missing real data with fabricated financial results.
6. THE SYSTEM SHALL return descriptive errors when an external operation cannot be completed.

### Requirement 26: Modular Application Architecture

**User Story:** As a Developer, I want application responsibilities to remain modular, so that individual data providers, financial calculations, and user interface components can be maintained independently.

#### Acceptance Criteria

1. THE SYSTEM SHALL maintain separate logical responsibilities for file ingestion, transaction normalization, portfolio management, market data retrieval, SEC filing retrieval, NLP analysis, sentiment processing, risk calculations, alert management, and dashboard presentation.
2. THE SYSTEM SHALL keep core financial calculations independent of frontend presentation components.
3. THE SYSTEM SHALL support interchangeable external provider implementations through appropriate interfaces.
4. THE SYSTEM SHALL use the existing repository's programming language, framework, naming conventions, and architectural patterns wherever practical.
5. THE SYSTEM SHALL avoid unnecessary dependencies and unrelated changes to existing application functionality.
6. THE SYSTEM SHALL remain buildable and runnable throughout implementation.

### Requirement 27: Testing and Verification

**User Story:** As a Developer, I want the application's major functionality and financial calculations to be tested, so that incorrect results and regressions can be identified before release.

#### Acceptance Criteria

1. THE SYSTEM SHALL include unit tests for transaction parsing, data validation, financial calculations, sentiment normalization, and filing risk scoring.
2. THE SYSTEM SHALL include integration tests for supported CSV and FIX ingestion workflows.
3. THE SYSTEM SHALL include integration tests for configured SEC, market data, and sentiment provider integrations.
4. THE SYSTEM SHALL include property-based tests for financial precision, score boundaries, and portfolio allocation calculations.
5. THE SYSTEM SHALL include an end-to-end test verifying that changes to portfolio positions update the dashboard risk metrics.
6. THE SYSTEM SHALL verify Historical Simulation VaR against known test datasets with expected results.
7. THE SYSTEM SHALL verify that a SentimentIndex of -0.75 activates the 1.15 downside adjustment for the affected asset.
8. THE SYSTEM SHALL verify that insufficient market data produces an `INSUFFICIENT_DATA` result.
9. THE SYSTEM SHALL verify that invalid risk scores cannot enter the risk calculation engine.
10. THE SYSTEM SHALL provide a documented way to run the project's automated tests.

## Glossary

- **Portfolio:** A collection of financial assets and positions monitored by the application.
- **Transaction:** An individual financial operation representing a purchase, sale, or other supported portfolio activity.
- **Position:** The aggregated holding of a particular asset within a portfolio.
- **CSV:** Comma-Separated Values, a file format used to store tabular transaction data.
- **FIX:** Financial Information eXchange, a messaging protocol used for electronic financial transactions.
- **SEC:** United States Securities and Exchange Commission.
- **EDGAR:** SEC's Electronic Data Gathering, Analysis, and Retrieval system.
- **10-K:** An annual corporate filing submitted to the SEC.
- **10-Q:** A quarterly corporate filing submitted to the SEC.
- **Item 1A:** The Risk Factors section of applicable SEC filings.
- **NLP:** Natural Language Processing, used to analyze and interpret textual information.
- **SentimentIndex:** A normalized market sentiment score ranging from -1.00 to +1.00.
- **FilingRiskScore:** A normalized score ranging from 0.00 to 1.00 representing the severity of identified risks disclosed in an SEC filing.
- **VaR:** Value-at-Risk, an estimate of potential portfolio loss at a specified confidence level and time horizon.
- **Historical Simulation:** A VaR methodology that applies historical market returns to current portfolio exposures to generate potential profit and loss scenarios.
- **Downside Stress Multiplier:** An adjustment applied to negative asset-level scenario contributions to represent an additional downside risk assumption.
- **Portfolio Allocation:** The percentage of portfolio value represented by an individual asset.
- **Gross Exposure:** The sum of the absolute market values of portfolio positions.
- **Net Exposure:** The signed sum of portfolio position market values.
- **Decimal Precision:** The number of decimal places maintained during financial calculations.
- **Data Provenance:** Information identifying the source, timestamp, and processing history of a data observation or calculation.
- **Demo Data:** Sample or simulated data used for demonstration and testing, which must not be presented as genuine market or regulatory data.