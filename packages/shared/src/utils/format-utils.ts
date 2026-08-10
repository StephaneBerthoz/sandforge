/**
 * General-purpose display formatting utilities.
 *
 * Provides human-readable formatting for bytes, numbers,
 * percentages, throughput rates, and progress bars.
 */

/** Formats bytes into human-readable size (e.g. "1.5 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'N/A';
  if (bytes === 0) return '0 B';
  if (bytes < 0) return `-${formatBytes(-bytes)}`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Formats a number with thousands separators (en-US locale). */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/** Formats a percentage value (0-100) with configurable decimal places. */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/** Formats a throughput rate (records per second) for display. */
export function formatRate(recordsPerSecond: number): string {
  if (recordsPerSecond >= 1000) return `${(recordsPerSecond / 1000).toFixed(1)}K/s`;
  return `${Math.round(recordsPerSecond)}/s`;
}

/** Creates a text-based progress bar string of the given width. */
export function progressBar(percent: number, width: number = 20): string {
  const clamped = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}
