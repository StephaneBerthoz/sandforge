/**
 * Fixed-capacity FIFO ring buffer. O(1) push, O(n) toArray.
 * Self-contained — no external deps (RESEARCH §1: no `mnemonist`).
 *
 * Used by TimeSeriesStore to cap per-series memory growth without
 * paying for Array.shift() reallocations.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  /** Next write index. */
  private head = 0;
  /** Current entry count (0..capacity). */
  private size = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0 || !Number.isFinite(capacity)) {
      throw new Error(`RingBuffer capacity must be a positive finite number, got ${capacity}`);
    }
    this.buffer = new Array<T | undefined>(capacity);
  }

  /**
   * Append a value. If the buffer is full, the oldest entry is evicted
   * and returned; otherwise returns `undefined`.
   */
  push(value: T): T | undefined {
    const evicted = this.size === this.capacity ? (this.buffer[this.head] as T) : undefined;
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
    return evicted;
  }

  /** Snapshot in chronological insertion order. */
  toArray(): T[] {
    if (this.size < this.capacity) {
      return this.buffer.slice(0, this.size) as T[];
    }
    return [...(this.buffer.slice(this.head) as T[]), ...(this.buffer.slice(0, this.head) as T[])];
  }

  /** Filter the chronological snapshot by predicate. */
  range(predicate: (t: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer.fill(undefined);
  }
}
