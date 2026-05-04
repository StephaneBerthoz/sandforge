import type { CDCEvent } from '@sandforge/shared';

/** Default batching window in milliseconds */
const DEFAULT_WINDOW_MS = 150;

/** Maximum capacity for the internal ring buffer */
const DEFAULT_CAPACITY = 10_000;

/**
 * Batches CDC events over a configurable time window before delivering them
 * in a single array via a post function. Uses a ring buffer internally to
 * bound memory usage -- when capacity is reached, oldest events are dropped.
 *
 * Typical usage: accumulate CDC events and post a single
 * `realtime:events-batch` message to the WebView every 150ms.
 */
export class CDCEventBatcher {
  private readonly postFn: (events: CDCEvent[]) => void;
  private readonly windowMs: number;
  private readonly capacity: number;
  private readonly buffer: Array<CDCEvent | undefined>;
  private writeIndex = 0;
  private count = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param postFn - Called with the accumulated batch of events on each flush
   * @param windowMs - Batching window duration in milliseconds (default 150)
   * @param capacity - Maximum number of events in the ring buffer (default 10000)
   */
  constructor(
    postFn: (events: CDCEvent[]) => void,
    windowMs = DEFAULT_WINDOW_MS,
    capacity = DEFAULT_CAPACITY,
  ) {
    this.postFn = postFn;
    this.windowMs = windowMs;
    this.capacity = capacity;
    this.buffer = new Array<CDCEvent | undefined>(capacity);
  }

  /**
   * Push an event into the batch buffer.
   * If no flush timer is running, starts one that will flush after windowMs.
   * When the buffer is full, the oldest event is overwritten.
   */
  push(event: CDCEvent): void {
    this.buffer[this.writeIndex] = event;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.windowMs);
    }
  }

  /**
   * Flush all buffered events to the post function and reset the buffer.
   * Reads events in order from the ring buffer.
   */
  flush(): void {
    if (this.count === 0) {
      this.clearTimer();
      return;
    }

    const events: CDCEvent[] = [];
    const start = this.count < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const event = this.buffer[idx];
      if (event) {
        events.push(event);
      }
    }

    // Reset the buffer
    this.writeIndex = 0;
    this.count = 0;
    this.clearTimer();

    if (events.length > 0) {
      this.postFn(events);
    }
  }

  /**
   * Dispose the batcher: flush any remaining events and clear the timer.
   */
  dispose(): void {
    this.flush();
  }

  /** Get the current number of buffered events. */
  getBufferedCount(): number {
    return this.count;
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
