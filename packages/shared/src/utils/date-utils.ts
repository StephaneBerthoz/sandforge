/**
 * Date and time utility functions.
 *
 * Provides duration formatting, relative time display,
 * recency checks, and completion time estimation.
 */

/** Formats milliseconds into human-readable duration (e.g. "2m 30s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

/** Returns ISO date string for the current instant. */
export function nowISO(): string {
  return new Date().toISOString();
}

/** Returns relative time string (e.g. "2 minutes ago", "1 hour ago"). */
export function timeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 60_000) return 'just now';

  if (diffMs < 3_600_000) {
    const mins = Math.floor(diffMs / 60_000);
    return `${mins} minute${mins > 1 ? 's' : ''} ago`;
  }

  if (diffMs < 86_400_000) {
    const hours = Math.floor(diffMs / 3_600_000);
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }

  const days = Math.floor(diffMs / 86_400_000);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

/** Checks if a date string is within the last N minutes. */
export function isWithinMinutes(isoDate: string, minutes: number): boolean {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  return diffMs <= minutes * 60_000;
}

/**
 * Calculates estimated remaining time in milliseconds based on progress.
 * Returns `undefined` when progress data is insufficient to estimate.
 */
export function estimateCompletion(
  processed: number,
  total: number,
  elapsedMs: number,
): number | undefined {
  if (processed === 0 || total === 0) return undefined;
  const rate = processed / elapsedMs;
  const remaining = total - processed;
  return Math.round(remaining / rate);
}
