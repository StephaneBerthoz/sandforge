import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18n from '../i18n';
import {
  formatNumber,
  formatDate,
  formatCurrency,
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  formatRelativeTimeI18n,
  formatStoredDate,
  dateTimeFormat,
  uiLocale,
} from './formatters';

describe('formatStoredDate', () => {
  it('writes a stored date with a date-fns pattern', () => {
    expect(formatStoredDate('2026-03-01T09:30:00', 'yyyy-MM-dd HH:mm')).toBe('2026-03-01 09:30');
  });

  it('writes a stored date with an Intl format, handed its bound format', () => {
    const fmt = dateTimeFormat({ year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-US');

    expect(formatStoredDate(Date.UTC(2026, 2, 1, 12), fmt.format)).toBe('03/01/2026');
  });

  it('answers null for a value that is not a date, rather than throwing', () => {
    // Formatting one threw "Invalid time value" and the screen did not render.
    expect(formatStoredDate('not a date', 'yyyy-MM-dd')).toBeNull();
    expect(formatStoredDate(Number.NaN, dateTimeFormat({ dateStyle: 'medium' }).format)).toBeNull();
    expect(formatStoredDate('', (date) => date.toLocaleString())).toBeNull();
  });

  it('answers null for no value at all, where a Date would have read 1970', () => {
    expect(formatStoredDate(null, 'yyyy')).toBeNull();
    expect(formatStoredDate(undefined, 'yyyy')).toBeNull();
  });
});

describe('formatNumber', () => {
  it('should format integers with locale grouping', () => {
    const result = formatNumber(1234567, 'en-US');
    expect(result).toBe('1,234,567');
  });

  it('should format decimals', () => {
    const result = formatNumber(1234.56, 'en-US');
    expect(result).toBe('1,234.56');
  });

  it('should return "0" for NaN', () => {
    expect(formatNumber(NaN)).toBe('0');
  });

  it('should return "0" for Infinity', () => {
    expect(formatNumber(Infinity)).toBe('0');
  });

  it('should handle zero', () => {
    expect(formatNumber(0, 'en-US')).toBe('0');
  });

  it('should handle negative numbers', () => {
    const result = formatNumber(-42, 'en-US');
    expect(result).toContain('42');
  });
});

describe('formatDate', () => {
  const testDate = new Date(2024, 0, 15); // Jan 15, 2024

  it('should format date in short style', () => {
    const result = formatDate(testDate, 'en-US', 'short');
    expect(result).toContain('2024');
    expect(result).toContain('15');
  });

  it('should format date in medium style by default', () => {
    const result = formatDate(testDate, 'en-US');
    expect(result).toContain('2024');
  });

  it('should format date in long style', () => {
    const result = formatDate(testDate, 'en-US', 'long');
    expect(result).toContain('January');
    expect(result).toContain('2024');
  });

  it('should return empty string for invalid date', () => {
    expect(formatDate(new Date('invalid'))).toBe('');
  });

  it('should return empty string for non-Date input', () => {
    expect(formatDate(null as unknown as Date)).toBe('');
  });
});

describe('formatCurrency', () => {
  it('should format USD amount', () => {
    const result = formatCurrency(1234.5, 'USD', 'en-US');
    expect(result).toContain('1,234.50');
    expect(result).toContain('$');
  });

  it('should format EUR amount', () => {
    const result = formatCurrency(99.99, 'EUR', 'en-US');
    expect(result).toContain('99.99');
  });

  it('should return formatted zero for NaN', () => {
    const result = formatCurrency(NaN, 'USD', 'en-US');
    expect(result).toContain('$');
    expect(result).toContain('0.00');
  });

  it('should handle zero', () => {
    const result = formatCurrency(0, 'USD', 'en-US');
    expect(result).toContain('$');
    expect(result).toContain('0.00');
  });

  it('should handle negative amounts', () => {
    const result = formatCurrency(-50, 'USD', 'en-US');
    expect(result).toContain('50.00');
  });
});

describe('formatDuration', () => {
  it('should format hours and minutes', () => {
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14min');
  });

  it('should format hours only', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(3 * 60_000 + 30_000)).toBe('3min 30s');
  });

  it('should format minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5min');
  });

  it('should format seconds', () => {
    expect(formatDuration(3_000)).toBe('3s');
  });

  it('should format milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('should return "0ms" for zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('should return "0ms" for NaN', () => {
    expect(formatDuration(NaN)).toBe('0ms');
  });

  it('should return "0ms" for negative values', () => {
    expect(formatDuration(-1000)).toBe('0ms');
  });
});

describe('formatFileSize', () => {
  it('should format bytes', () => {
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('should format kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
  });

  it('should format megabytes with one decimal', () => {
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });

  it('should format gigabytes', () => {
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('should return "0 B" for zero', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('should return "0 B" for NaN', () => {
    expect(formatFileSize(NaN)).toBe('0 B');
  });

  it('should return "0 B" for negative values', () => {
    expect(formatFileSize(-100)).toBe('0 B');
  });

  it('should handle 1 byte', () => {
    expect(formatFileSize(1)).toBe('1 B');
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should format seconds ago', () => {
    const date = new Date(2024, 0, 15, 11, 59, 30);
    const result = formatRelativeTime(date, 'en-US');
    expect(result).toContain('30');
    expect(result).toContain('second');
  });

  it('should format minutes ago', () => {
    const date = new Date(2024, 0, 15, 11, 55, 0);
    const result = formatRelativeTime(date, 'en-US');
    expect(result).toContain('5');
    expect(result).toContain('minute');
  });

  it('should format hours ago', () => {
    const date = new Date(2024, 0, 15, 9, 0, 0);
    const result = formatRelativeTime(date, 'en-US');
    expect(result).toContain('3');
    expect(result).toContain('hour');
  });

  it('should format days ago', () => {
    const date = new Date(2024, 0, 13, 12, 0, 0);
    const result = formatRelativeTime(date, 'en-US');
    expect(result).toContain('2');
    expect(result).toContain('day');
  });

  it('should return empty string for invalid date', () => {
    expect(formatRelativeTime(new Date('invalid'))).toBe('');
  });

  it('should return empty string for non-Date input', () => {
    expect(formatRelativeTime(null as unknown as Date)).toBe('');
  });
});

describe('formatRelativeTimeI18n', () => {
  const mockT = vi.fn((key: string, opts?: Record<string, unknown>) => {
    if (opts) return `${key}:${JSON.stringify(opts)}`;
    return key;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
    mockT.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return justNow for timestamps less than 60 seconds ago', () => {
    const ts = Date.now() - 30_000; // 30 seconds ago
    const result = formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(result).toBe('ns.justNow');
  });

  it('should return minutesAgo with count for timestamps 1-59 minutes ago', () => {
    const ts = Date.now() - 5 * 60_000; // 5 minutes ago
    formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(mockT).toHaveBeenCalledWith('ns.minutesAgo', { count: 5 });
  });

  it('should return hoursAgo with count for timestamps 60+ minutes ago', () => {
    const ts = Date.now() - 3 * 3_600_000; // 3 hours ago
    formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(mockT).toHaveBeenCalledWith('ns.hoursAgo', { count: 3 });
  });

  it('should handle the boundary at 59 minutes', () => {
    const ts = Date.now() - 59 * 60_000;
    formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(mockT).toHaveBeenCalledWith('ns.minutesAgo', { count: 59 });
  });

  it('should switch to hours at exactly 60 minutes', () => {
    const ts = Date.now() - 60 * 60_000;
    formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(mockT).toHaveBeenCalledWith('ns.hoursAgo', { count: 1 });
  });

  it('should return justNow for future timestamps', () => {
    const ts = Date.now() + 60_000; // 1 minute in the future
    const result = formatRelativeTimeI18n(ts, mockT, 'ns');
    expect(result).toBe('ns.justNow');
  });

  it('should return justNow for current timestamp', () => {
    const result = formatRelativeTimeI18n(Date.now(), mockT, 'ns');
    expect(result).toBe('ns.justNow');
  });

  it('should use the provided keyPrefix correctly', () => {
    const ts = Date.now() - 120_000; // 2 minutes ago
    formatRelativeTimeI18n(ts, mockT, 'sidePanel.relativeTime');
    expect(mockT).toHaveBeenCalledWith('sidePanel.relativeTime.minutesAgo', { count: 2 });
  });
});

describe('the UI locale', () => {
  // The language the labels are in, with a bundle registered so i18next
  // resolves to it the way `changeLanguageLazy` leaves it after a load.
  async function showInterfaceIn(language: string): Promise<void> {
    if (!i18n.hasResourceBundle(language, 'translation')) {
      i18n.addResourceBundle(language, 'translation', { probe: language });
    }
    await i18n.changeLanguage(language);
  }

  function hostSpeaks(tag: string): void {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(tag);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await i18n.changeLanguage('en');
  });

  it('writes numbers in the language picked in SandForge, not the host’s', async () => {
    hostSpeaks('en-US');
    await showInterfaceIn('fr');

    expect(uiLocale()).toBe('fr');
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('fr').format(1234.5));
    expect(formatNumber(1234.5)).not.toBe('1,234.5');
  });

  it('keeps the host’s region when the host speaks the same language', async () => {
    hostSpeaks('en-GB');
    await showInterfaceIn('en');

    expect(uiLocale()).toBe('en-GB');
    expect(dateTimeFormat({ dateStyle: 'short' }).format(new Date(2026, 0, 15))).toBe('15/01/2026');
  });

  it('follows a language switch after a date has already been written', async () => {
    hostSpeaks('en-US');
    const day = new Date(2026, 0, 15);
    const english = dateTimeFormat({ dateStyle: 'long' }).format(day);

    await showInterfaceIn('de');

    expect(dateTimeFormat({ dateStyle: 'long' }).format(day)).toBe('15. Januar 2026');
    expect(english).toBe('January 15, 2026');
  });

  it('describes a moment relative to now in the interface language', async () => {
    hostSpeaks('en-US');
    await showInterfaceIn('es');

    expect(formatRelativeTime(new Date(Date.now() - 2 * 3_600_000))).toBe('hace 2 horas');
  });
});
