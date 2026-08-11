/**
 * Locale-aware display formatting utilities.
 *
 * Canonical implementations shared by the extension host and the webview —
 * ported from `packages/webview/src/utils/formatters.ts` (step 1 of the
 * formatter convergence; the webview will re-export these in a later step).
 * Output shapes are frozen by tests: "2h 14min", "1.2 MB", "02:05"…
 * All functions handle edge cases (NaN, negative, zero) gracefully.
 */

/**
 * Format a number using locale-specific grouping and decimal separators.
 * @param n - The number to format.
 * @param locale - Optional BCP-47 locale string; defaults to the runtime locale.
 * @returns The formatted number string, or '0' for NaN/invalid input.
 */
export function formatNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * @param ms - Duration in milliseconds.
 * @returns Formatted string like "2h 14min", "45s", "120ms", or "0ms" for invalid values.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms === 0) return '0ms';

  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}min ${seconds}s` : `${minutes}min`;
  }
  if (seconds > 0) {
    return `${seconds}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** File size unit thresholds. */
const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Format a byte count to a human-readable file size string.
 * @param bytes - Number of bytes.
 * @returns Formatted string like "1.2 MB", or "0 B" for invalid values.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    FILE_SIZE_UNITS.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  const rounded = exponent === 0 ? value : parseFloat(value.toFixed(1));

  return `${rounded} ${FILE_SIZE_UNITS[exponent]}`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * Convenience wrapper around {@link formatDuration} for APIs that report in seconds.
 * @param seconds - Duration in seconds.
 * @returns Formatted string like "2h 14min", "45s", or "0ms".
 */
export function formatDurationSec(seconds: number): string {
  return formatDuration(seconds * 1_000);
}

/**
 * Format seconds as a compact elapsed-time string in MM:SS format.
 * Useful for stopwatch-style displays during execution.
 * @param totalSeconds - Elapsed time in seconds.
 * @returns Formatted string like "02:05" or "1:30:05" for hours.
 */
export function formatElapsed(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const h = Math.floor(totalSeconds / 3_600);
  const m = Math.floor((totalSeconds % 3_600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Format a size given in megabytes to a human-readable string.
 * @param mb - Size in megabytes.
 * @returns Formatted string like "512 KB", "3.5 MB", or "1.2 GB".
 */
export function formatSizeMB(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return '0 MB';
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}
