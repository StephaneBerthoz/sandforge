/**
 * Locale-aware formatting utilities for numbers, dates, currencies,
 * durations, file sizes, and relative time.
 * All functions handle edge cases (NaN, negative, zero) gracefully.
 */

/**
 * Format a number using locale-specific grouping and decimal separators.
 * @param n - The number to format.
 * @param locale - Optional BCP-47 locale string; defaults to the browser locale.
 * @returns The formatted number string, or '0' for NaN/invalid input.
 */
export function formatNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(locale).format(n);
}

/** Date display format options. */
export type DateFormatStyle = 'short' | 'medium' | 'long';

/**
 * Format a Date using locale-specific date formatting.
 * @param d - The Date to format.
 * @param locale - Optional BCP-47 locale string.
 * @param format - Display style: 'short', 'medium' (default), or 'long'.
 * @returns The formatted date string, or an empty string for invalid dates.
 */
export function formatDate(
  d: Date,
  locale?: string,
  format: DateFormatStyle = 'medium',
): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';

  const options: Intl.DateTimeFormatOptions =
    format === 'short'
      ? { year: 'numeric', month: 'numeric', day: 'numeric' }
      : format === 'long'
        ? { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }
        : { year: 'numeric', month: 'short', day: 'numeric' };

  return new Intl.DateTimeFormat(locale, options).format(d);
}

/**
 * Format a number as currency using locale-specific conventions.
 * @param n - The monetary amount.
 * @param currency - ISO 4217 currency code (e.g. 'USD', 'EUR').
 * @param locale - Optional BCP-47 locale string.
 * @returns The formatted currency string, or the currency code with '0.00' for invalid input.
 */
export function formatCurrency(n: number, currency: string, locale?: string): string {
  if (!Number.isFinite(n)) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(0);
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
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
 * Format a Date as relative time (e.g., "5 minutes ago", "in 2 hours").
 * Uses Intl.RelativeTimeFormat for locale-aware output.
 * @param date - The Date to compare against now.
 * @param locale - Optional BCP-47 locale string.
 * @returns Formatted relative time string, or an empty string for invalid dates.
 */
/**
 * Format a timestamp as relative time using i18n translation keys.
 * Expects the translation namespace to contain: `justNow`, `minutesAgo` (with `count`), `hoursAgo` (with `count`).
 * @param timestamp - Unix timestamp in milliseconds.
 * @param t - i18n translation function.
 * @param keyPrefix - Namespace prefix (e.g. 'home' or 'sidePanel.relativeTime').
 */
export function formatRelativeTimeI18n(
  timestamp: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
  keyPrefix: string,
): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return t(`${keyPrefix}.justNow`);
  if (diffMin < 60) return t(`${keyPrefix}.minutesAgo`, { count: diffMin });
  const diffH = Math.floor(diffMin / 60);
  return t(`${keyPrefix}.hoursAgo`, { count: diffH });
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

export function formatRelativeTime(date: Date, locale?: string): string {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';

  const now = Date.now();
  const diffMs = date.getTime() - now;
  const absDiffMs = Math.abs(diffMs);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (absDiffMs < 60_000) {
    return rtf.format(Math.round(diffMs / 1_000), 'second');
  }
  if (absDiffMs < 3_600_000) {
    return rtf.format(Math.round(diffMs / 60_000), 'minute');
  }
  if (absDiffMs < 86_400_000) {
    return rtf.format(Math.round(diffMs / 3_600_000), 'hour');
  }
  return rtf.format(Math.round(diffMs / 86_400_000), 'day');
}
