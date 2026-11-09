/**
 * Content-addressed series store and caching (task 9.4; design: Series store and
 * caching, D-10; R12.6, R12.7, R22.3, R25.3, R25.4).
 *
 * Lives in `app/` because `marketdata/` may not import the persistence ports.
 * Storage is reached only through `UnitOfWork.run` and `Repositories.series`.
 *
 * Rules:
 * 1. Key: the cleaned `PriceSeries.contentHash` of task 9.2, unchanged, so
 *    `seriesHashes`, `ReturnMatrix`, `RiskInput`, and snapshots are unaffected.
 *    `put` recomputes `sha256Hex(canonicalJson({ ticker, currency,
 *    observations }))`; a mismatch is a programmer error (`TypeError`).
 * 2. Content (immutable, at most once per hash) and provenance (append-only
 *    retrievals, `seq`-ordered) are separate. One content may carry several
 *    retrievals, REAL and DEMO alike; content itself is never labelled.
 * 3. Labels are per retrieval: REAL is `CACHED`, DEMO is `DEMO`. Stored data is
 *    never `CURRENT`. There is no expiry, time-to-live, eviction, or age-based
 *    `STALE`; `retrievedAt` is always returned with the label.
 * 4. `put` refuses a conflicting `CleanResult` (`SERIES_CONFLICT`) and writes
 *    nothing, so a stored series can never be reloaded as clean data.
 * 5. Re-putting identical content leaves the content untouched; an identical
 *    retrieval (hash, source, source kind, `retrievedAt`) is not appended twice.
 * 6. Each `put` is one synchronous unit of work: content and retrieval commit
 *    together or not at all. A `PersistenceError` gives `STORE_FAILED`.
 * 7. Reads validate every record with strict Zod schemas, recompute the hash,
 *    and check that retrievals match their content; any failure gives
 *    `SERIES_INTEGRITY_ERROR` and no data. A missing hash, or no retrieval of the
 *    requested kind, gives `NOT_FOUND`; nothing is fabricated and there is no
 *    fallback to another source kind or ticker.
 * 8. Prices keep their exact decimal text (decision C2): the hash is computed
 *    over it. They must match the fixed decimal grammar.
 *
 * Not in scope: a `ResilientCall` fetch-through service, concurrent-fetch
 * de-duplication, and refresh scheduling (with task 9.6, OD-13).
 */
import { z } from 'zod';
import type { CleanResult } from '../marketdata/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type {
  PersistenceErrorCode,
  Repositories,
  SeriesContentRecord,
  SeriesRetrievalRecord,
  SeriesSourceKind,
  UnitOfWork,
} from '../persistence/ports.js';
import {
  DecimalStringSchema,
  Iso4217Code,
  IsoDate,
  IsoUtcMillis,
  appError,
  assertNever,
  canonicalJson,
  err,
  ok,
  sha256Hex,
} from '../shared/index.js';
import type { AppError, DecimalString, Result } from '../shared/index.js';

/** Label of one stored retrieval. Never `CURRENT`. */
export type CachedLabel = 'CACHED' | 'DEMO';

export interface CachedRetrieval {
  readonly seq: number;
  readonly source: string;
  readonly sourceKind: SeriesSourceKind;
  readonly retrievedAt: string;
  readonly label: CachedLabel;
}

/** Series content without provenance; prices are the exact stored text. */
export interface StoredSeries {
  readonly contentHash: string;
  readonly ticker: string;
  readonly currency: string;
  readonly observations: readonly { readonly date: string; readonly adjustedClose: DecimalString }[];
}

export type SeriesStoreError =
  | (AppError<'SERIES_CONFLICT'> & { readonly ticker: string; readonly conflictDates: readonly string[] })
  | AppError<'NOT_FOUND'>
  | AppError<'SERIES_INTEGRITY_ERROR'>
  | (AppError<'STORE_FAILED'> & { readonly persistenceCode: PersistenceErrorCode });

export interface PutOutcome {
  readonly contentHash: string;
  readonly retrieval: CachedRetrieval;
  /** False when identical content was already stored. */
  readonly contentInserted: boolean;
  /** False when an identical retrieval was already stored. */
  readonly retrievalAppended: boolean;
}

export interface SeriesByHash {
  readonly series: StoredSeries;
  /** In `seq` order, each with its own label. */
  readonly retrievals: readonly CachedRetrieval[];
}

export interface LatestSeries {
  readonly series: StoredSeries;
  readonly retrieval: CachedRetrieval;
}

export interface SeriesStore {
  put(result: CleanResult): Result<PutOutcome, SeriesStoreError>;
  getByHash(contentHash: string): Result<SeriesByHash, SeriesStoreError>;
  latestFor(ticker: string, sourceKind: SeriesSourceKind): Result<LatestSeries, SeriesStoreError>;
}

export interface SeriesStoreDependencies {
  readonly unitOfWork: UnitOfWork;
}

const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

const ContentSchema = z.strictObject({
  contentHash: ContentHashSchema,
  ticker: z.string().min(1),
  currency: Iso4217Code,
  observations: z.array(z.strictObject({ date: IsoDate, adjustedClose: DecimalStringSchema })),
});

const RetrievalSchema = z.strictObject({
  seq: z.int().positive(),
  contentHash: ContentHashSchema,
  ticker: z.string().min(1),
  source: z.string().min(1),
  sourceKind: z.enum(['REAL', 'DEMO']),
  retrievedAt: IsoUtcMillis,
});

type ValidContent = z.infer<typeof ContentSchema>;
type ValidRetrieval = z.infer<typeof RetrievalSchema>;

/** The task 9.2 content hash. */
const hashOf = (content: Pick<StoredSeries, 'ticker' | 'currency' | 'observations'>): string =>
  sha256Hex(
    canonicalJson({ ticker: content.ticker, currency: content.currency, observations: content.observations }),
  );

export function labelFor(sourceKind: SeriesSourceKind): CachedLabel {
  switch (sourceKind) {
    case 'REAL':
      return 'CACHED';
    case 'DEMO':
      return 'DEMO';
    default:
      return assertNever(sourceKind);
  }
}

const toCached = (record: ValidRetrieval | SeriesRetrievalRecord): CachedRetrieval =>
  Object.freeze({
    seq: record.seq,
    source: record.source,
    sourceKind: record.sourceKind,
    retrievedAt: record.retrievedAt,
    label: labelFor(record.sourceKind),
  });

const toStored = (content: ValidContent): StoredSeries =>
  Object.freeze({
    contentHash: content.contentHash,
    ticker: content.ticker,
    currency: content.currency,
    observations: Object.freeze(
      content.observations.map((o) => Object.freeze({ date: o.date, adjustedClose: o.adjustedClose })),
    ),
  });

const integrityError = (): { readonly ok: false; readonly error: SeriesStoreError } =>
  err(appError('SERIES_INTEGRITY_ERROR', 'A stored series failed validation; no data is returned.'));

const notFound = (): { readonly ok: false; readonly error: SeriesStoreError } =>
  err(appError('NOT_FOUND', 'No stored series matches the request.'));

const storeFailed = (code: PersistenceErrorCode): { readonly ok: false; readonly error: SeriesStoreError } =>
  err({
    ...appError('STORE_FAILED', 'The series store could not complete the operation.'),
    persistenceCode: code,
  });

/** Validates content read back from storage; `undefined` when it fails any check. */
function validContent(raw: unknown, expectedHash: string): ValidContent | undefined {
  const parsed = ContentSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const content = parsed.data;
  for (let i = 1; i < content.observations.length; i += 1) {
    // index only, not a financial value
    const previous = content.observations[i - 1];
    const current = content.observations[i];
    if (previous === undefined || current === undefined || !(previous.date < current.date)) {
      return undefined;
    }
  }
  if (content.contentHash !== expectedHash || hashOf(content) !== expectedHash) {
    return undefined;
  }
  return content;
}

/** Validates retrievals read back from storage; `undefined` when any fails. */
function validRetrievals(
  raw: readonly unknown[],
  check: (r: ValidRetrieval) => boolean,
): readonly ValidRetrieval[] | undefined {
  const valid: ValidRetrieval[] = [];
  for (const item of raw) {
    const parsed = RetrievalSchema.safeParse(item);
    if (!parsed.success || !check(parsed.data)) {
      return undefined;
    }
    const last = valid[valid.length - 1];
    if (last !== undefined && !(last.seq < parsed.data.seq)) {
      return undefined;
    }
    valid.push(parsed.data);
  }
  return valid;
}

function assertCleanResult(result: CleanResult): void {
  const series: unknown = (result as { series?: unknown } | null)?.series;
  if (typeof series !== 'object' || series === null || !Array.isArray(result.series.observations)) {
    throw new TypeError('SeriesStore.put requires a CleanResult.');
  }
  if (typeof result.conflict !== 'boolean') {
    throw new TypeError('SeriesStore.put requires a CleanResult with a conflict flag.');
  }
}

export function createSeriesStore(dependencies: SeriesStoreDependencies): SeriesStore {
  const { unitOfWork } = dependencies;

  /** Runs `work` in one unit of work, mapping a `PersistenceError` to `STORE_FAILED`. */
  const inUnitOfWork = <T>(
    work: (tx: Repositories) => T,
  ): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SeriesStoreError } => {
    try {
      // Synchronous callback: never async, never returns a promise.
      return ok(unitOfWork.run(work));
    } catch (error) {
      if (error instanceof PersistenceError) {
        return storeFailed(error.code);
      }
      throw error;
    }
  };

  return {
    put: (result) => {
      assertCleanResult(result);
      const { series } = result;
      if (hashOf(series) !== series.contentHash) {
        throw new TypeError('PriceSeries.contentHash does not match its content.');
      }
      if (result.conflict) {
        return err({
          ...appError('SERIES_CONFLICT', 'A conflicting series is never stored (DATA_CONFLICT).'),
          ticker: series.ticker,
          conflictDates: Object.freeze([...result.conflictDates]),
        });
      }
      const content: SeriesContentRecord = {
        contentHash: series.contentHash,
        ticker: series.ticker,
        currency: series.currency,
        observations: series.observations.map((o) => ({ date: o.date, adjustedClose: o.adjustedClose })),
      };
      const provenance = {
        contentHash: series.contentHash,
        ticker: series.ticker,
        source: series.source,
        sourceKind: series.sourceKind,
        retrievedAt: series.retrievedAt,
      };
      const written = inUnitOfWork((tx) => {
        const contentInserted = tx.series.insertContent(content);
        const existing = tx.series
          .listRetrievalsByHash(series.contentHash)
          .find(
            (r) =>
              r.source === provenance.source &&
              r.sourceKind === provenance.sourceKind &&
              r.retrievedAt === provenance.retrievedAt,
          );
        if (existing !== undefined) {
          return { contentInserted, retrieval: existing, retrievalAppended: false };
        }
        return { contentInserted, retrieval: tx.series.appendRetrieval(provenance), retrievalAppended: true };
      });
      if (!written.ok) {
        return written;
      }
      return ok(
        Object.freeze({
          contentHash: series.contentHash,
          retrieval: toCached(written.value.retrieval),
          contentInserted: written.value.contentInserted,
          retrievalAppended: written.value.retrievalAppended,
        }),
      );
    },

    getByHash: (contentHash) => {
      if (typeof contentHash !== 'string') {
        throw new TypeError('contentHash must be a string.');
      }
      const read = inUnitOfWork((tx) => ({
        content: tx.series.getContent(contentHash),
        retrievals: tx.series.listRetrievalsByHash(contentHash),
      }));
      if (!read.ok) {
        return read;
      }
      const { content: rawContent, retrievals: rawRetrievals } = read.value;
      if (rawContent === undefined) {
        return rawRetrievals.length === 0 ? notFound() : integrityError();
      }
      const content = validContent(rawContent, contentHash);
      if (content === undefined) {
        return integrityError();
      }
      const retrievals = validRetrievals(
        rawRetrievals,
        (r) => r.contentHash === contentHash && r.ticker === content.ticker,
      );
      // Content without any provenance violates the store's invariant (one unit of work per put).
      if (retrievals === undefined || retrievals.length === 0) {
        return integrityError();
      }
      return ok(
        Object.freeze({
          series: toStored(content),
          retrievals: Object.freeze(retrievals.map(toCached)),
        }),
      );
    },

    latestFor: (ticker, sourceKind) => {
      if (typeof ticker !== 'string' || ticker.length === 0) {
        throw new TypeError('ticker must be a non-empty string.');
      }
      if (sourceKind !== 'REAL' && sourceKind !== 'DEMO') {
        throw new TypeError('sourceKind must be REAL or DEMO.');
      }
      const read = inUnitOfWork((tx) => {
        const rawRetrievals = tx.series.listRetrievalsByTicker(ticker, sourceKind);
        const hashes = new Set(rawRetrievals.map((r) => r.contentHash));
        const contents = new Map([...hashes].map((h) => [h, tx.series.getContent(h)] as const));
        return { rawRetrievals, contents };
      });
      if (!read.ok) {
        return read;
      }
      const { rawRetrievals, contents } = read.value;
      if (rawRetrievals.length === 0) {
        return notFound();
      }
      const retrievals = validRetrievals(
        rawRetrievals,
        (r) => r.ticker === ticker && r.sourceKind === sourceKind,
      );
      if (retrievals === undefined) {
        return integrityError();
      }
      // Latest `retrievedAt` (fixed-width UTC, so ordinal order is chronological); ties: higher seq.
      let selected: ValidRetrieval | undefined;
      for (const r of retrievals) {
        if (
          selected === undefined ||
          r.retrievedAt > selected.retrievedAt ||
          (r.retrievedAt === selected.retrievedAt && r.seq > selected.seq)
        ) {
          selected = r;
        }
      }
      if (selected === undefined) {
        return notFound();
      }
      const content = validContent(contents.get(selected.contentHash), selected.contentHash);
      if (content === undefined || content.ticker !== ticker) {
        return integrityError();
      }
      return ok(Object.freeze({ series: toStored(content), retrieval: toCached(selected) }));
    },
  };
}
