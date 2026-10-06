/**
 * Holds a sync run between two of its writes while it is paused.
 *
 * A run stops where a pause can be honoured without leaving anything half
 * done: before its next object, before an object's write once its records
 * are read, and before each batch or Bulk API job the writer opens. A batch
 * already sent is never taken back, and a Bulk API job runs on the platform
 * to its end once it is closed, so a pause asked during one holds the run
 * after it. Nothing is written while the run waits.
 *
 * A cancel ends a pause: the wait returns as soon as the run's signal aborts,
 * and the caller then stops as cancelled, as it would have at that point
 * without the pause.
 */
export class PauseGate {
  private paused = false;
  private readonly waiting = new Set<() => void>();

  /** Whether the run is asked to wait at its next stopping point. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Hold the run at its next stopping point. Asking twice is the same as once. */
  pause(): void {
    this.paused = true;
  }

  /** Let the run go on, and release a wait already under way. */
  resume(): void {
    this.paused = false;
    const released = [...this.waiting];
    this.waiting.clear();
    for (const release of released) release();
  }

  /**
   * Return at once unless the run is paused; while it is, return once it is
   * resumed, or once `signal` aborts.
   *
   * @param signal - The run's cancel.
   */
  async whilePaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.waiting.delete(release);
        signal?.removeEventListener('abort', release);
        resolve();
      };
      this.waiting.add(release);
      signal?.addEventListener('abort', release, { once: true });
    });
  }
}
