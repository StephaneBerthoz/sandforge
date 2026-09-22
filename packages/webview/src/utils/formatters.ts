/**
 * Locale-aware formatting utilities for numbers, dates, currencies,
 * durations, file sizes, and relative time.
 * All functions handle edge cases (NaN, negative, zero) gracefully.
 *
 * The numeric/duration/file-size formatters are re-exported from the canonical
 * implementations in `@sandforge/shared` (single source of truth shared with
 * the extension host); `formatNumber` is wrapped so its locale defaults to the
 * interface language. The date/currency/relative-time helpers below are
 * webview-only (Intl + i18n shaped for the UI).
 */
import { formatNumber as formatNumberIn } from '@sandforge/shared';
// The i18next singleton, not `../i18n`: that module initialises it for React
// and the panel imports it once at boot. Reading the instance is all this
// needs, and a test that mocks react-i18next can still import a formatter.
import i18n from 'i18next';

export {
  formatDuration,
  formatFileSize,
  formatDurationSec,
  formatElapsed,
  formatSizeMB,
} from '@sandforge/shared';

/** `en` of `en-GB`, lower-cased. */
function primarySubtag(tag: string): string {
  return tag.split('-')[0].toLowerCase();
}

/**
 * The locale every date and number on screen is written in.
 *
 * It follows the language picked in SandForge, which is not VS Code's: a
 * formatter given no locale takes the host's, so an interface set to French
 * wrote "Jan 15, 2026" and "1,234" beside French labels. The host locale is
 * kept for its region when it speaks the same language — English on an en-GB
 * machine still writes the day first — and set aside when it does not.
 *
 * Read it while rendering: a component that calls `t()` re-renders on a
 * language switch, and picks the new locale up with it.
 */
export function uiLocale(): string {
  const language = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const host = typeof navigator === 'undefined' ? undefined : navigator.language;
  return host && primarySubtag(host) === primarySubtag(language) ? host : language;
}

/**
 * Format a number with the grouping and decimal separators of `locale`.
 * @param n - The number to format.
 * @param locale - BCP-47 locale; defaults to {@link uiLocale}.
 * @returns The formatted number string, or '0' for NaN/invalid input.
 */
export function formatNumber(n: number, locale: string = uiLocale()): string {
  return formatNumberIn(n, locale);
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * An `Intl.DateTimeFormat` in `locale` ({@link uiLocale} by default), built
 * once per locale and options. Ask for it where the date is written: one built
 * at module scope keeps the language the panel was opened in.
 */
export function dateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  locale: string = uiLocale(),
): Intl.DateTimeFormat {
  const key = `${locale} ${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

/** Date display format options. */
export type DateFormatStyle = 'short' | 'medium' | 'long';

/**
 * Format a Date using locale-specific date formatting.
 * @param d - The Date to format.
 * @param locale - BCP-47 locale; defaults to {@link uiLocale}.
 * @param format - Display style: 'short', 'medium' (default), or 'long'.
 * @returns The formatted date string, or an empty string for invalid dates.
 */
export function formatDate(
  d: Date,
  locale: string = uiLocale(),
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
 * @param locale - BCP-47 locale; defaults to {@link uiLocale}.
 * @returns The formatted currency string, or the currency code with '0.00' for invalid input.
 */
export function formatCurrency(n: number, currency: string, locale: string = uiLocale()): string {
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

/**
 * "2 hours ago", "in 3 days", "now" — in `locale`, through Intl, so it needs
 * no translation key and ships no word list.
 * @param date - The moment to describe, relative to now.
 * @param locale - BCP-47 locale; defaults to {@link uiLocale}.
 * @returns The relative phrase, or an empty string for an invalid date.
 */
export function formatRelativeTime(date: Date, locale: string = uiLocale()): string {
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
