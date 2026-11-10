/**
 * Dashboard loss distribution (Kiroween decision A2, approved 2026-11-10).
 *
 * Builds the `lossDistribution` view from the Base VaR scenario losses of the latest stored
 * result, recomputed from its verified snapshot (`RiskService.scenarioLosses`). It adds no VaR
 * methodology: the losses are `scenarioLosses(input)` (FR-5), the marker is the raw Type 7
 * quantile at the stored confidence (FR-7), and the bucketing is `lossHistogram` (`src/risk/`).
 *
 * Unavailable, in this order, each with its reason and never as zero-valued bars:
 * 1. Base VaR has no figure in the latest result (`BASE_VAR_UNAVAILABLE`; also when only a
 *    LAST_VALID figure is shown, because its scenarios are not the latest result's).
 * 2. No stored snapshot (`NO_SNAPSHOT`), or it fails recomputation (`SNAPSHOT_RECOMPUTE_FAILED`).
 * 3. Scenarios from another snapshot than the shown result (`SNAPSHOT_MISMATCH`: the risk view
 *    and the scenarios are read separately, so a newer calculation may be stored in between; it
 *    is never substituted). Checked before the scenario count and the quantile.
 * 4. Fewer than two losses (`INSUFFICIENT_SCENARIOS`), a scenario count different from the
 *    Base VaR observations (`SCENARIO_COUNT_MISMATCH`), or a recomputed quantile that differs
 *    from the stored Base VaR raw quantile (`QUANTILE_MISMATCH`).
 *
 * Exact values are canonical strings; `*Display` strings are FR-14 money text in the base
 * currency's ISO 4217 minor units (`currencyMinorUnits`).
 */
import { lossHistogram } from '../risk/index.js';
import { d, formatMoneyDisplay, toCanonical } from '../shared/index.js';
import type { DecimalString, LossDistribution } from '../shared/index.js';
import type { RiskView, ScenarioLossesOutcome } from './riskService.js';

export interface LossDistributionParts {
  readonly risk: RiskView;
  readonly scenarios: ScenarioLossesOutcome | undefined;
  readonly currency: string;
  readonly minorUnits: number;
  /** Production: `LOSS_HISTOGRAM_BUCKETS` (20). */
  readonly bucketCount: number;
}

type Unavailable = Extract<LossDistribution, { status: 'UNAVAILABLE' }>;

const unavailable = (reason: Unavailable['reason'], explanation: string): Unavailable => ({
  status: 'UNAVAILABLE',
  reason,
  explanation,
});

export function buildLossDistribution(parts: LossDistributionParts): LossDistribution {
  const { risk, scenarios, currency, minorUnits, bucketCount } = parts;
  const base = risk.baseVaR.value;
  // `value` is null whenever validity is UNAVAILABLE or LAST_VALID (RiskService.view).
  if (base === null) {
    return unavailable(
      'BASE_VAR_UNAVAILABLE',
      `Base VaR is unavailable (${risk.status}), so no scenario loss distribution is shown.`,
    );
  }
  if (scenarios === undefined || scenarios.status === 'NO_SNAPSHOT') {
    return unavailable(
      'NO_SNAPSHOT',
      'The scenarios of this result are not stored, so no scenario loss distribution is shown.',
    );
  }
  switch (scenarios.status) {
    case 'SNAPSHOT_RECOMPUTE_FAILED':
      return unavailable(
        'SNAPSHOT_RECOMPUTE_FAILED',
        `The stored scenarios could not be verified (${scenarios.code}), so no distribution is shown.`,
      );
    case 'BASE_VAR_UNAVAILABLE':
      return unavailable(
        'BASE_VAR_UNAVAILABLE',
        'The recomputed result has no Base VaR, so no scenario loss distribution is shown.',
      );
    case 'OK':
      break;
    default: {
      const never: never = scenarios;
      return never;
    }
  }
  // Bind the scenarios to the exact result shown: the risk view and the scenarios are read
  // separately, so a calculation stored in between yields another snapshot. Never substitute it.
  if (risk.snapshotHash === null || scenarios.snapshotHash !== risk.snapshotHash) {
    return unavailable(
      'SNAPSHOT_MISMATCH',
      'The stored scenarios belong to a different calculation than the shown result, so no distribution is shown.',
    );
  }
  if (scenarios.losses.length !== risk.observations) {
    return unavailable(
      'SCENARIO_COUNT_MISMATCH',
      'The stored scenarios do not match the Base VaR observations, so no distribution is shown.',
    );
  }
  const histogram = lossHistogram(scenarios.losses, {
    bucketCount,
    minorUnits,
    confidence: d(scenarios.confidence),
  });
  if (!histogram.ok) {
    if (histogram.error.code === 'INVALID_INPUT') {
      throw new TypeError(`buildLossDistribution: ${histogram.error.message}`);
    }
    return unavailable(
      'INSUFFICIENT_SCENARIOS',
      'Fewer than two scenario losses exist, so no distribution is shown.',
    );
  }
  const h = histogram.value;
  if (!h.rawQuantile.equals(d(base.rawQuantile)) || !h.rawQuantile.equals(d(scenarios.rawQuantile))) {
    return unavailable(
      'QUANTILE_MISMATCH',
      'The recomputed VaR quantile differs from the stored Base VaR, so no distribution is shown.',
    );
  }
  const money = (value: DecimalString): string => formatMoneyDisplay(value, minorUnits);
  const exact = toCanonical;
  return {
    status: 'AVAILABLE',
    metric: 'BASE_VAR_SCENARIO_LOSSES',
    currency,
    confidence: scenarios.confidence,
    horizonDays: 1,
    quantileMethod: 'HYNDMAN_FAN_TYPE_7',
    calculatedAt: risk.calculatedAt,
    scenarioWindow: { firstDate: scenarios.firstDate, lastDate: scenarios.lastDate },
    scenarioCount: h.scenarioCount,
    bucketCount: h.buckets.length,
    width: exact(h.width),
    widthDisplay: money(exact(h.width)),
    min: exact(h.min),
    max: exact(h.max),
    buckets: h.buckets.map((bucket) => ({
      lower: exact(bucket.lower),
      upper: exact(bucket.upper),
      upperInclusive: bucket.upperInclusive,
      count: bucket.count,
      lowerDisplay: money(exact(bucket.lower)),
      upperDisplay: money(exact(bucket.upper)),
    })),
    varMarker: {
      rawQuantile: exact(h.rawQuantile),
      rawQuantileDisplay: money(exact(h.rawQuantile)),
      confidence: scenarios.confidence,
      bucketIndex: h.varBucketIndex,
      scenariosAbove: h.scenariosAboveVaR,
      position: exact(h.markerPosition),
    },
  };
}
