/**
 * A bounded FIFO queue that coalesces by key and drops the oldest entry when
 * full (R33.5). Used later by the sentiment ingestor.
 *
 * - `offer` of a value whose key is already queued replaces that value in place
 *   (the entry keeps its queue position) and returns `COALESCED`.
 * - `offer` of a new key when the queue is full removes the oldest entry,
 *   increments `droppedCount`, appends the new value, and returns `DROPPED_OLDEST`.
 * - Otherwise the value is appended and `ACCEPTED` is returned.
 */
export type OfferOutcome = 'ACCEPTED' | 'COALESCED' | 'DROPPED_OLDEST';

export class BoundedQueue<K, V> {
  private readonly entries = new Map<K, V>();
  private dropped = 0;

  constructor(
    private readonly maxSize: number,
    private readonly keyOf: (value: V) => K,
  ) {
    if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
      throw new RangeError('BoundedQueue maxSize must be a positive integer.');
    }
  }

  offer(value: V): OfferOutcome {
    const key = this.keyOf(value);
    if (this.entries.has(key)) {
      this.entries.set(key, value);
      return 'COALESCED';
    }
    let outcome: OfferOutcome = 'ACCEPTED';
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
      this.dropped += 1;
      outcome = 'DROPPED_OLDEST';
    }
    this.entries.set(key, value);
    return outcome;
  }

  take(): V | undefined {
    const first = this.entries.entries().next();
    if (first.done) {
      return undefined;
    }
    const [key, value] = first.value;
    this.entries.delete(key);
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  get droppedCount(): number {
    return this.dropped;
  }
}
