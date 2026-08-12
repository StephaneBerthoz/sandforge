import { useState, useEffect } from 'react';

/** How often the elapsed reading is refreshed while a run is active. */
const TICK_MS = 500;

/**
 * Milliseconds elapsed since `startedAt`, refreshed while it is non-null.
 *
 * A timestamp alone does not re-render, so the Seed and Sync execution views
 * displayed a hardcoded `0` and their "execution time" read "0.0s" for the
 * whole run. Returns 0 when idle so callers can render unconditionally.
 *
 * @param startedAt - Epoch ms the run began, or null when nothing is running.
 */
export function useElapsedSince(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0);
      return;
    }
    // Set immediately so the first paint after start is not a stale 0.
    setElapsed(Date.now() - startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  return elapsed;
}
