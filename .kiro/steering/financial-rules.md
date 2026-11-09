---
inclusion: always
---

# Financial Engineering Rules

These rules apply to every file in Spectral Risk Chimera. They are permanent and project-wide. They implement R4, R10, R11, R14, R15, R21, R27, R32, and R35 of `.kiro/specs/requirements.md` and the design in `.kiro/specs/design.md`. If a task conflicts with a rule here, stop and ask instead of working around it.

Scope: "financial values" means monetary amounts, portfolio and position values, NAV, quantities, transaction amounts, prices, FX rates, returns, P&L, scenario losses, VaR, thresholds, multipliers, allocation percentages, and financial ratios.

## 1. Use Decimal.js for all financial values

- Hold financial values as `Decimal` internally. Do not hold them as `number`.
- Construct `Decimal` only through the project helper `d()` in `src/shared/decimal.ts`. It accepts strings (or an existing `Decimal`) and rejects `NaN`, `Infinity`, and JS numbers.
- Use the project Decimal configuration: `precision = 40`, `rounding = ROUND_HALF_UP`. Do not call `Decimal.set` anywhere else.
- Do not round intermediate results. Round only at defined output points (display money, 2-decimal allocation display).

```ts
// CORRECT
import { d } from '../shared/decimal';
const exposure = d(position.signedQuantity).times(d(position.marketPrice)).times(d(fx.rate));

// INCORRECT: native number type for money
const exposure: number = position.quantity * position.price * fxRate;
```

## 2. Never use native number operators on financial values

Forbidden on financial values: `+ - * / %`, `**`, `Math.*`, `+=`, `++`, unary `+`, `toFixed`, `Number()`, `parseFloat()`, `parseInt()`, `Number.parseFloat`. Use Decimal methods instead.

```ts
// CORRECT
const total = positions.reduce((acc, p) => acc.plus(p.marketValue), d('0'));

// INCORRECT: floating-point drift (0.1 + 0.2 !== 0.3)
const total = positions.reduce((acc, p) => acc + Number(p.marketValue), 0);
```

Integers that are not money (array indexes, counts, observation counts, retry attempts) may use native integers. Example: the quantile index `j = floor(h)` is an index. Compute `h` in Decimal, then convert only the floored index with `h.floor().toNumber()`. Add a comment `// index only, not a financial value`.

## 3. Read financial inputs as decimal strings

- Every financial field in a CSV cell, FIX tag, JSON body, provider payload, config file, or database column is text.
- Provider JSON must be parsed with the project lossless JSON parser so numeric tokens like `0.1` stay text: each JSON number becomes a `LosslessJsonNumber` holding its exact source text (`src/shared/losslessJson.ts`). `JSON.parse` on provider payloads is forbidden because it converts numbers to binary floats before validation.
- Decimal strings must match the fixed decimal grammar: optional `-`, digits, optional `.` and digits. Exponent notation (for example `1e-5`) is always rejected; there is no configurable exponent limit (R4.6). No thousands separators, no `NaN` or `Infinity`.

```ts
// CORRECT
const raw = parser.parse(responseText);             // LosslessJsonParser: Result, never throws
if (!raw.ok) return raw;                            // JSON_PARSE_ERROR, no input text in the message
const payload = PriceBarSchema.parse(raw.value);    // Zod: close is z.instanceof(LosslessJsonNumber)
const closeText = DecimalStringSchema.safeParse(payload.close.text);   // exact token text; "1e-5" fails here
if (!closeText.success) return reject('MALFORMED_NUMBER', closeText.error);
const close = d(closeText.data);

// INCORRECT
const payload = JSON.parse(responseText);           // 0.1 already lost exactness
const close = new Decimal(payload.close);
const close = d(String(payload.close));             // a JSON number is a LosslessJsonNumber, not a string; use .text
```

## 4. Never use parseFloat before Decimal construction

```ts
// INCORRECT: any of these is a violation
new Decimal(parseFloat(input));
new Decimal(Number(input));
new Decimal(+input);
new Decimal(0.1);                    // JS number literal

// CORRECT
d(input);                            // input is a validated decimal string
d('0.1');
```

## 5. Use Decimal methods for arithmetic and comparison

| Operation | Use | Never |
|---|---|---|
| Add / subtract | `plus()`, `minus()` | `+`, `-` |
| Multiply / divide | `times()`, `dividedBy()` | `*`, `/` |
| Negate / absolute value | `negated()`, `abs()` | `-x`, `Math.abs` |
| Compare | `equals()`, `greaterThan()`, `greaterThanOrEqualTo()`, `lessThan()`, `lessThanOrEqualTo()`, `comparedTo()` | `==`, `===`, `<`, `>` on Decimal objects |
| Min / max | `Decimal.min()`, `Decimal.max()` | `Math.min`, `Math.max` |
| Sort | `(a, b) => a.comparedTo(b)` | `(a, b) => a - b` |

```ts
// CORRECT: strict trigger, -0.60 does not trigger, -0.6001 does
const triggered = effectiveSentiment.lessThan(threshold);

// INCORRECT: object comparison and float coercion
const triggered = effectiveSentiment < threshold;
if (a === b) { /* compares object identity, always false for distinct Decimals */ }
```

Guard division: before `dividedBy()` confirm the divisor is positive (or non-zero). A zero or negative NAV must produce an explicit status such as `NAV_NOT_POSITIVE`, not a number.

```ts
// CORRECT
if (!nav.greaterThan(0)) return { status: 'NAV_NOT_POSITIVE', percentOfNav: null };
const pct = varAbs.dividedBy(nav).times(100);

// INCORRECT: Infinity or NaN leaks into results
const pct = varAbs.dividedBy(nav).times(100);
```

## 6. Strings at API and persistence boundaries

- Serialize with `toCanonical()` (no exponent, no trailing fractional zeros, no negative zero). Use it for JSON responses, WebSocket messages, database `TEXT` columns, snapshots, audit details, and logs.
- Database columns holding financial values are `TEXT`, never `REAL`, `FLOAT`, or `NUMERIC` with float affinity.
- Never put a financial value into a JSON number, query parameter as a number, or `JSON.stringify` a `Decimal` implicitly. Convert explicitly first.
- One narrow exception (task 9.4, approved decision C2): the observation prices of a stored market-data series (`price_series.observations_json`) keep the exact decimal text that the series cleaner produced (for example `"100.0"`), because the series `contentHash` is computed over that text and must verify on reload (D-10, R32). They must still match the fixed decimal grammar (no exponent, no separators, no `NaN` or `Infinity`), and the hash is recomputed on every read. This exception covers no other column, payload, or log; everything else is canonical.

```ts
// CORRECT
res.send({ nav: toCanonical(nav), baseVaR: toCanonical(baseVar) });
db.prepare('INSERT INTO transactions (quantity, price) VALUES (?, ?)').run(toCanonical(q), toCanonical(p));

// INCORRECT
res.send({ nav: nav.toNumber() });                  // precision lost at the API boundary
db.prepare('...').run(q.toNumber(), p.toNumber());  // REAL storage
JSON.stringify({ nav });                            // implicit conversion, not canonical
```

## 7. Native numbers only at the final chart boundary

- The only permitted conversion is `toChartNumber()` called from the dashboard chart adapter (`src/web/chartAdapter.ts`), for pixel or axis values.
- Chart numbers are display-only. Never feed them back into calculations, never send them to the API, never store them.
- Displayed money text comes from decimal strings with `roundMoney()` (ROUND_HALF_UP to the currency's minor units), not from `toFixed` on a native number.

```ts
// CORRECT
const points = series.map(p => ({ x: p.date, y: toChartNumber(p.valueBase) }));   // chartAdapter.ts only

// INCORRECT
const total = rows.map(r => Number(r.value)).reduce((a, b) => a + b, 0);         // calculation on native numbers
```

## 8. Validate external input and serialized data with Zod

- Every external boundary has a Zod schema: HTTP bodies/queries, CSV rows after mapping, FIX fields, provider payloads (market data, FX, sentiment, SEC, NLP), environment variables, configuration, WebSocket messages, and data read back from persistence or snapshots.
- Use the shared schemas: `DecimalStringSchema`, `PositiveDecimalString`, `UnitIntervalDecimalString` (FilingRiskScore, 0 to 1), `SignedUnitDecimalString` (SentimentIndex, -1 to +1), `IsoDate`, `IsoTimestamp`, `Iso4217Code`.
- Financial fields are `z.string()` based. Never use `z.number()` for money, prices, quantities, scores, or thresholds.
- Use `.strict()` on configuration and API request objects so unknown fields are rejected. Never use `.passthrough()` on financial payloads.
- Types come from `z.infer`. Do not hand-write a second type for an external shape.
- A validation failure rejects the value and records an error. Never clamp, coerce, or default a failed value into range.

```ts
// CORRECT
const TransactionRow = z.object({
  quantity: PositiveDecimalString,
  price: PositiveDecimalString,
  currency: Iso4217Code,
}).strict();

// INCORRECT
const TransactionRow = z.object({ quantity: z.number(), price: z.coerce.number() });   // floats, silent coercion
const score = Math.min(1, Math.max(0, raw));                                          // clamping hides invalid data
```

## 9. Validate portfolio and sentiment invariants

Enforce these at the point of creation and again before use in calculations. A violation rejects the record, audits it, and never reaches the risk engine.

Portfolio and market invariants:
- Quantity > 0 on transactions; price > 0; currency is a supported ISO 4217 code.
- Position is the netted, signed quantity per portfolio and instrument; long and short are never held separately for one instrument.
- No negative position unless `import.oversellPolicy = ALLOW_SHORT`; a SELL beyond available quantity is rejected with `OVERSELL` otherwise.
- Adjusted Close values are finite and > 0; dates are unique per asset; no forward-filled or fabricated observations.
- Allocation percentages for an eligible long-only portfolio sum to exactly 100.00 using the largest-remainder rule; they are never forced to 100% for portfolios with shorts, negative cash, or leverage.
- `confidence` is strictly between 0 and 1; `horizonDays` is exactly 1; the multiplier is >= 1; the bearish threshold is within [-1, +1].
- VaR is non-negative as reported (raw quantile retained); Adjusted VaR >= Base VaR whenever Adjusted VaR is available.

Sentiment invariants:
- `SentimentIndex` is a finite decimal within [-1, +1]. Out-of-range values are rejected, not clamped.
- A sentiment value may trigger the downside adjustment only if it is valid, `REAL` (not demo), `CURRENT` (within `sentiment.maxAgeSeconds`), and associated with that instrument.
- The trigger is strictly less than the threshold: `-0.60` does not trigger, `-0.6001` does.
- Direction-aware: effective sentiment is `s` for a long and `-s` for a short.
- Stale or demo sentiment may be displayed with its label but must never drive a calculation or an alert.
- Adjusted VaR exists only when the adjustment settings are present and every position has eligible sentiment. Otherwise it is `null` with status `ADJUSTMENT_CONFIG_MISSING` or `SENTIMENT_NOT_CURRENT`, while Base VaR is still calculated. Never copy Base VaR into the Adjusted VaR field, never label an unadjusted figure as adjusted, and never fall back to Base VaR for an `ADJUSTED` alert (R15.8, R18.7).
- The adjustment has no on/off switch. Only the threshold and multiplier are configurable, and both must be supplied explicitly.

```ts
// CORRECT
const parsed = SentimentIndexSchema.safeParse(msg.value);
if (!parsed.success) return reject('SENTIMENT_INVALID', parsed.error);

// INCORRECT
const value = msg.value > 1 ? 1 : msg.value;        // clamps invalid input into a valid-looking one
```

## 10. Never silently replace missing or invalid financial data with zero

Zero is a real financial value. Using it as a placeholder changes results without any warning.

- Missing price, return, FX rate, quantity, sentiment, score, cash, or NAV must produce an explicit status (`INSUFFICIENT_DATA`, `FX_UNAVAILABLE`, `DATA_CONFLICT`, `UNAVAILABLE`, `NAV_NOT_POSITIVE`) or a `null`/`Result` error. Missing cash is a validation error, never zero.
- Missing financially significant configuration is never replaced by a default or by a template value. A missing Base VaR setting gives `CONFIG_MISSING`, and both Base and Adjusted VaR are `null`. A missing adjustment or sentiment setting gives `ADJUSTMENT_CONFIG_MISSING`: only Adjusted VaR is `null`. No alert is evaluated from an unavailable figure (R14.14, R15.8, R18.7).
- Do not use `|| 0`, `?? 0`, `|| d(0)`, `Number(x) || 0`, `isNaN(x) ? 0 : x`, default parameter values of zero, or `reduce` seeds that hide absent items.
- Do not forward-fill prices, interpolate missing returns, or substitute another FX rate.
- Zero is allowed when it is genuinely the value (for example a cash balance explicitly defined as `"0"`, or the floored VaR with the `NO_LOSS_AT_CONFIDENCE` flag).
- When a previous valid result is shown instead, label it `LAST_VALID` or `STALE` with its timestamp.

```ts
// CORRECT
const rate = await fx.rateToBase(currency, asOf);
if (!rate.ok) return { status: 'FX_UNAVAILABLE', currencies: [currency] };

// INCORRECT: a missing FX rate silently becomes 1 (or 0) and corrupts every downstream number
const rate = fxRates[currency] ?? d(1);
const price = quote.price || d(0);
```

## 11. Keep SEC filing risk and market sentiment separate

- `FilingRiskScore` (0 to 1, severity of disclosed risk) and `SentimentIndex` (-1 to +1, market mood) are different signals with different types, tables, modules, statuses, and view-model fields.
- `FilingRiskScore` must never affect VaR, Adjusted VaR, the sentiment threshold, the multiplier, or which assets are triggered. `RiskInput` has no filing field. Do not add one.
- Do not create a combined, composite, blended, average, netted, or ranked score from the two. Do not share a gauge, color scale, or sort key for both. A combined score requires a new approved requirement.
- SEC text is never sentiment input. Sentiment text is never filing input.
- Filing-risk alerts and VaR alerts are separate alert types with separate state.
- Only `src/risk/` consumes sentiment for the adjustment. `src/risk/` must not import from `src/sec/` or `src/nlp/`.

```ts
// CORRECT
type AssetRiskRow = {
  sentiment: { value: DecimalString | null; status: DataStatus };
  filing:    { score: DecimalString | null; status: FilingStatus };
};

// INCORRECT
const combined = filing.score.times(0.5).plus(sentiment.value.negated().times(0.5));   // undocumented fusion
const multiplier = filing.score.greaterThan('0.8') ? d('1.25') : d('1.15');            // filing leaks into VaR
```

## 12. Every financial calculation needs unit tests and property-based tests

A change that adds or alters a financial calculation is not complete without tests in the same change.

Unit tests (Vitest) must include:
- A hand-calculated, known-answer case (the expected value written down independently of the implementation).
- Boundary cases (for example sentiment `-0.60` and `-0.6001`; 199, 200, 249, 250 observations; `NAV = 0`).
- Error and missing-data cases proving no number is produced.

Property-based tests (fast-check) must include, where relevant:
- Decimal exactness and canonical string round trips.
- Quantile bounds and monotonicity in `p`.
- Portfolio P&L equals the sum of position P&L.
- Adjusted loss >= base loss in every scenario; Adjusted VaR >= Base VaR whenever Adjusted VaR is available.
- Ineligible sentiment or a missing adjustment setting makes Adjusted VaR `null`, never a copy of Base VaR.
- Allocation sum is exactly 100.00 and independent of input order.
- Score range validation rejects out-of-range values.
- Filing score changes never change VaR output.

Rules for tests:
- Compare Decimals with `equals()` or canonical strings, never with `toBe` on numbers or `toBeCloseTo`.
- Use a reference implementation based on integer or rational arithmetic that does not use Decimal.js.
- Start each property test file with `// Validates: Requirements ...`.
- Do not use tolerances to hide rounding differences. If results differ, find the cause.

```ts
// CORRECT
expect(toCanonical(result.baseVaR.absolute)).toBe('4.55');
fc.assert(fc.property(decimalListArb, xs => sumDecimals(xs).equals(referenceSum(xs))));

// INCORRECT
expect(result.baseVaR.absolute.toNumber()).toBeCloseTo(4.55, 2);   // float comparison with tolerance
```

## 13. Document assumptions behind all risk calculations

Every risk calculation module has a header comment, and every `RiskResult`/snapshot carries the configuration needed to reproduce it. State at least:

- Method and version (for example Historical Simulation, Hyndman-Fan Type 7, `algorithmVersion`).
- Confidence level, horizon (one trading day, no square-root-of-time scaling), lookback (250 simple returns, minimum 200), and what happens outside those limits.
- Return definition (adjusted-close simple returns) and alignment (intersection of common dates, no forward fill, gap handling).
- Exposure definition (signed quantity times latest market price times FX rate) and that FX is held constant across historical scenarios.
- Sentiment adjustment as a configurable stress assumption (threshold, multiplier, freshness, direction handling), not a statistical estimate of volatility.
- That VaR is a percentile-based loss estimate, not maximum drawdown and not a worst-case loss.
- Known limitations and the requirement or open decision they relate to.

When an assumption changes, update the header comment, `.kiro/specs/requirements.md` (Assumptions and Constraints), and the snapshot schema version in the same change. Never present a stress assumption, demo value, or fallback result as real analysis.

```ts
// CORRECT
/**
 * Historical Simulation VaR, algorithmVersion "hs-var-1".
 * Assumptions: one-day horizon (no scaling); newest 250 common simple returns (min 200);
 * exposures = signed qty * market price * FX (FX constant across scenarios);
 * quantile = Hyndman-Fan Type 7 on losses (Loss = -PnL).
 * Validates: Requirements 14.1-14.9, FR-5, FR-7.
 */
export function computeVar(input: RiskInput): RiskResult { /* ... */ }

// INCORRECT: no stated method, horizon, or assumptions
export function calcRisk(data: any) { /* ... */ }
```

## Enforcement checklist

Before finishing any change that touches financial code, confirm:

- [ ] No `number` typed financial values; no `parseFloat`, `Number()`, unary `+`, `Math.*`, or native arithmetic on them.
- [ ] Decimals are created only via `d()` from validated strings.
- [ ] Money crosses API, persistence, snapshot, and log boundaries as canonical strings.
- [ ] `toChartNumber()` is called only in the chart adapter.
- [ ] Each external input has a Zod schema and invalid values are rejected, not clamped or zeroed.
- [ ] Missing or invalid data yields an explicit status, never a silent zero.
- [ ] No code path lets `FilingRiskScore` influence VaR, and no combined score exists.
- [ ] Unit tests (with a hand-calculated case) and property tests exist for each new calculation.
- [ ] Assumptions are documented in the module header and, if they changed, in the requirements.
