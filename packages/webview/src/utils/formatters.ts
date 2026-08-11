/**
 * Locale-aware formatting utilities for numbers, dates, currencies,
 * durations, file sizes, and relative time.
 * All functions handle edge cases (NaN, negative, zero) gracefully.
 *
 * The numeric/duration/file-size formatters are re-exported from the canonical
 * implementations in `@sandforge/shared` (single source of truth shared with
 * the extension host). The date/currency/relative-time helpers below are
 * webview-only (Intl + i18n shaped for the UI).
 */

export {
  formatNumber,
  formatDuration,
  formatFileSize,
  formatDurationSec,
  formatElapsed,
  formatSizeMB,
} from '@sandforge/shared';

/** Date display format options. */
export type DateFormatStyle = 'short' | 'medium' | 'long';

/**
 * Format a Date using locale-specific date formatting.
 * @param d - The Date to format.
 * @param locale - Optional BCP-47 locale string.
 * @param format - Display style: 'short', 'medium' (default), or 'long'.
 * @returns The formatted date string, or an empty string for invalid dates.
 */
export function formatDate(d: Date, locale?: string, format: DateFormatStyle = 'medium'): string {
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
