import type { TFunction } from 'i18next';
import { formatFileSize, formatNumber } from '../../utils/formatters';

/** One thing an audit entry's `details` says, as a line of the trail reads it. */
export interface AuditDetailLine {
  key: string;
  text: string;
}

/**
 * The details whose value is a word of the host's, one of a few it writes:
 * said in the reader's language. Every other text is a name or a code, which
 * reads the same in any language, and which a catalogue lookup could mistake
 * for a key path: a pipeline may be called "Nightly.Refresh".
 */
const WORDED_VALUES: ReadonlySet<string> = new Set([
  'confirmed',
  'contactPoints',
  'decision',
  'deliverability',
  'status',
  'trigger',
  'triggeredBy',
  'via',
]);

/** The details that hold a date, read as the entry's own timestamp is. */
const DATE_VALUES: ReadonlySet<string> = new Set(['grantedAt', 'loadedAt']);

/** A key the catalogue does not name, in words: `recordsLeft` reads "Records left". */
function spelledOut(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A detail's value, as text. */
function valueText(t: TFunction, key: string, value: unknown): string {
  if (key === 'bytes' && typeof value === 'number') return formatFileSize(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') {
    if (DATE_VALUES.has(key)) return value.slice(0, 19).replace('T', ' ');
    return WORDED_VALUES.has(key)
      ? t(`reports.detailValue.${key}.${value}`, { defaultValue: value })
      : value;
  }
  // A list or an object a later host records: its content, never "[object Object]".
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * What an audit entry says beside its counts, a line each: "Records left in
 * the org: 3" where the trail printed `recordsLeft: 3`, its keys being the
 * host's and written for the export. A flag that is set says its name alone,
 * as "sweep: true" had nothing more to say than its key. A key the catalogue
 * does not name, which a newer host may record, is spelled out in words, and
 * a detail with no value says nothing.
 */
export function auditDetailLines(
  t: TFunction,
  details: Readonly<Record<string, unknown>>,
): AuditDetailLine[] {
  return Object.entries(details).flatMap(([key, value]) => {
    if (value === null || value === undefined) return [];
    const label = t(`reports.detailField.${key}`, { defaultValue: spelledOut(key) });
    const text =
      value === true ? label : t('reports.detailLine', { label, value: valueText(t, key, value) });
    return [{ key, text }];
  });
}
