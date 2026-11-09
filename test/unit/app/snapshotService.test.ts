// Task 12.5: calculation snapshots and reproducibility (design: Snapshot Service; R32).
// Tests: AT-REP-01, AT-REP-02, AT-REP-03, AT-REP-04, AT-REP-06, AT-REP-07, AT-REP-08, AT-REP-09, AT-REP-10, AT-FX-05, AT-AUD-04
// Validates: Requirements 32.1, 32.2, 32.3, 32.4, 32.5, 32.6, 22.4, 22.5, 30.10, 11.5
import { describe, expect, it } from 'vitest';
import { CalculationSnapshotSchema, buildSnapshot } from '../../../src/app/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import { canonicalJson, sha256Hex } from '../../../src/shared/index.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { observedFx } from '../../helpers/risk.js';
import { PF, VERSION, cleanSeries, riskHarness } from '../../helpers/riskService.js';
import type { RiskHarnessOptions } from '../../helpers/riskService.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);
const POSITIONS = { AAA: ['USD', '10'], BBB: ['EUR', '-4'] } as const;
const PRICES = { AAA: { price: '100' }, BBB: { price: '20', fx: observedFx('EUR', '1.1') } };

function setup(options: RiskHarnessOptions = {}) {
  const h = riskHarness(POSITIONS, { values: SMALL, prices: PRICES, ...options });
  if (options.uow === undefined) {
    h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
    h.putSeries(cleanSeries('BBB', ['20', '21', '20', '22'], { start: '2026-11-03', currency: 'EUR' }));
  }
  return h;
}

async function calculated(options: RiskHarnessOptions = {}) {
  const h = setup(options);
  await h.service.calculate(PF);
  const snap = h.uow.snapshot();
  const record = snap.snapshots.at(-1);
  const result = snap.riskResults.at(-1);
  if (record === undefined || result === undefined) {
    throw new Error('expected a snapshot');
  }
  return { h, record, result, snapshot: JSON.parse(record.snapshot) as Record<string, unknown> };
}

describe('snapshot content (AT-REP-07, AT-FX-05, AT-AUD-04)', () => {
  it('contains every R32.1 field and validates against the snapshot schema', async () => {
    const { snapshot, record } = await calculated();
    expect(CalculationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      algorithmVersion: 'hs-var-2',
      portfolioId: PF,
      asOfDate: '2026-11-06',
      configVersion: VERSION,
      baseCurrency: 'USD',
      cash: '100',
      params: {
        confidence: '0.95',
        lookbackReturns: 3,
        minObservations: 2,
        maxReturnGapDays: 5,
        observations: 3,
        horizonDays: 1,
        quantileMethod: 'HYNDMAN_FAN_TYPE_7',
        adjustment: { threshold: '-0.60', multiplier: '1.15' },
      },
      adjustmentOutcome: { status: 'SENTIMENT_NOT_CURRENT' },
      sentiment: [],
      triggeredAssets: [],
      displayOnly: { filingScores: [] },
    });
    // Positions sorted by ticker, with base-currency value (FR-4): -4 * 20 * 1.1 = -88.
    expect(snapshot['positions']).toEqual([
      {
        ticker: 'AAA',
        signedQuantity: '10',
        marketPrice: '100',
        currency: 'USD',
        valueBase: '1000',
        fxPair: 'USDUSD',
        historySourceKind: 'REAL',
      },
      {
        ticker: 'BBB',
        signedQuantity: '-4',
        marketPrice: '20',
        currency: 'EUR',
        valueBase: '-88',
        fxPair: 'EURUSD',
        historySourceKind: 'REAL',
      },
    ]);
    // FX rates sorted by pair, including the identity rate (AT-FX-05).
    expect(snapshot['fxRates']).toEqual([
      expect.objectContaining({
        pair: 'EURUSD',
        rate: '1.1',
        observedAt: '2026-11-06T15:00:00.000Z',
        observedAtBasis: 'PROVIDER',
        source: 'test-fx',
        sourceKind: 'REAL',
      }),
      expect.objectContaining({ pair: 'USDUSD', rate: '1', observedAt: null, sourceKind: 'IDENTITY' }),
    ]);
    // Traceable to its series and returns (AT-AUD-04).
    expect(Object.keys(snapshot['seriesHashes'] as object)).toEqual(['AAA', 'BBB']);
    expect(snapshot['returnsHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(record.hash).toBe(sha256Hex(record.inputsCanonical));
  });

  it('the hash covers the snapshot without displayOnly; byte-identical text is the canonical form (AT-REP-10)', async () => {
    const { snapshot, record } = await calculated();
    const body = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'displayOnly'));
    expect(canonicalJson(body)).toBe(record.inputsCanonical);
    expect(record.inputsCanonical).not.toContain('displayOnly');
    expect(record.inputsCanonical).not.toContain(record.evaluatedAt);
  });
});

describe('snapshot hash (AT-REP-01, AT-REP-03, AT-REP-04, AT-REP-06, AT-REP-09)', () => {
  it('same inputs give the same Base VaR, Adjusted outcome, and hash; the hash index is not unique', async () => {
    const h = setup();
    await h.service.calculate(PF);
    await h.service.calculate(PF);
    const [a, b] = h.uow.snapshot().snapshots;
    expect(a?.hash).toBe(b?.hash);
    const [r1, r2] = h.uow.snapshot().riskResults;
    expect(r1?.body).toBe(r2?.body);
  });

  it('the calculation timestamp is not hashed (AT-REP-06)', async () => {
    const a = await calculated({ at: '2026-11-08T12:00:00.000Z' });
    const b = await calculated({ at: '2026-11-09T08:30:00.000Z' });
    expect(a.record.evaluatedAt).not.toBe(b.record.evaluatedAt);
    expect(a.record.hash).toBe(b.record.hash);
  });

  it('a configuration version change changes the hash (AT-REP-03)', async () => {
    const a = await calculated();
    const b = await calculated({ version: { seq: 2, hash: 'd'.repeat(64) } });
    expect(b.record.hash).not.toBe(a.record.hash);
    expect(b.result.configVersionSeq).toBe(2);
  });

  it('an input change changes the hash (AT-REP-04)', async () => {
    const a = await calculated();
    const b = await calculated({ prices: { ...PRICES, AAA: { price: '100.01' } } });
    const c = await calculated({ values: withKey(SMALL, 'var.confidence', '0.99') });
    expect(new Set([a.record.hash, b.record.hash, c.record.hash]).size).toBe(3);
  });

  it('display-only filing scores never change the hash and are stored (AT-REP-09)', async () => {
    const { h } = await calculated();
    const input = await h.builder.build(PF);
    if (!input.ok) {
      throw new Error('expected an input');
    }
    const result = riskEngine.compute(input.value);
    const without = buildSnapshot(input.value, result, VERSION, 5, { filingScores: [] });
    const withScores = buildSnapshot(input.value, result, VERSION, 5, {
      filingScores: [{ ticker: 'AAA', score: '0.9' as never, status: 'CURRENT' }],
    });
    expect(withScores.hash).toBe(without.hash);
    expect(withScores.snapshot.displayOnly.filingScores).toHaveLength(1);
  });
});

describe('schema versions (hs-var-2, schema version 2)', () => {
  /** Rewrites a stored version 2 snapshot as the version 1 shape, with a consistent hash. */
  async function asVersion1(algorithmVersion: string) {
    const { h, record } = await calculated();
    const snapshot = JSON.parse(record.snapshot) as Record<string, unknown>;
    const v1 = {
      ...snapshot,
      schemaVersion: 1,
      algorithmVersion,
      sentiment: [{ ticker: 'AAA', value: '0.1', status: 'CURRENT', sourceKind: 'REAL' }],
    };
    const body = Object.fromEntries(Object.entries(v1).filter(([key]) => key !== 'displayOnly'));
    const inputsCanonical = canonicalJson(body);
    return {
      h,
      stored: { ...record, snapshot: canonicalJson(v1), inputsCanonical, hash: sha256Hex(inputsCanonical) },
    };
  }

  it('new snapshots are schema version 2 with source on every sentiment entry', async () => {
    const { snapshot } = await calculated();
    expect(snapshot['schemaVersion']).toBe(2);
    expect(snapshot['algorithmVersion']).toBe('hs-var-2');
    expect(
      CalculationSnapshotSchema.safeParse({
        ...snapshot,
        sentiment: [{ ticker: 'AAA', value: '0.1', status: 'CURRENT', sourceKind: 'REAL' }],
      }).success,
    ).toBe(false);
  });

  it('a version 1 snapshot still validates and hash-checks; recompute refuses its algorithm version', async () => {
    const { h, stored } = await asVersion1('hs-var-1');
    expect(CalculationSnapshotSchema.safeParse(JSON.parse(stored.snapshot)).success).toBe(true);
    const deps = { seriesStore: h.seriesStore, returns: h.returns, engine: riskEngine };
    const { recomputeFromSnapshot } = await import('../../../src/app/index.js');
    expect(recomputeFromSnapshot(stored, deps)).toMatchObject({
      ok: false,
      error: { code: 'ALGORITHM_VERSION_MISMATCH' },
    });
    const tampered = { ...stored, hash: 'e'.repeat(64) };
    expect(recomputeFromSnapshot(tampered, deps)).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_INVALID' },
    });
    const mixed = await asVersion1('hs-var-2');
    expect(recomputeFromSnapshot(mixed.stored, deps)).toMatchObject({
      ok: false,
      error: { code: 'SCHEMA_VERSION_UNSUPPORTED' },
    });
  });
});

describe('recompute (AT-REP-08, AT-REP-02)', () => {
  it('reproduces the stored Base VaR and Adjusted outcome as identical strings', async () => {
    const { h, record, result } = await calculated();
    const again = h.service.recompute(record.id);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(canonicalJson({ kind: 'CALCULATED', result: again.value })).toBe(result.body);
    }
  });

  it('a tampered snapshot or a missing series is refused, never recalculated from other data', async () => {
    const { h, record } = await calculated();
    const tampered = { ...record, snapshot: record.snapshot.replace('"cash":"100"', '"cash":"101"') };
    const { recomputeFromSnapshot } = await import('../../../src/app/index.js');
    const deps = { seriesStore: h.seriesStore, returns: h.returns, engine: riskEngine };
    expect(recomputeFromSnapshot(tampered, deps)).toMatchObject({
      ok: false,
      error: { code: 'SNAPSHOT_INVALID' },
    });
    const empty = riskHarness(POSITIONS, { values: SMALL, prices: PRICES });
    expect(recomputeFromSnapshot(record, { ...deps, seriesStore: empty.seriesStore })).toMatchObject({
      ok: false,
      error: { code: 'SERIES_UNAVAILABLE' },
    });
    expect(h.service.recompute('missing')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
