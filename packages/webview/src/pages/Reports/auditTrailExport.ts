import type { AuditAction, AuditLogEntry, AuditObjectCounts } from '@sandforge/shared';
import { csvCell } from '../Forge/forgeResultsExport';

/** The part of the trail an export holds: what the Audit Trail's filters showed. */
export interface AuditExportFilter {
  module?: string;
  orgId?: string;
  action?: AuditAction;
}

/** An object's counts, in the order a line of the Audit Trail reads them. */
const COUNT_COLUMNS = [
  'created',
  'updated',
  'upserted',
  'writtenWithoutFields',
  'deleted',
  'failed',
  'mayHaveBeenWritten',
  'notSent',
] as const satisfies ReadonlyArray<keyof AuditObjectCounts>;

/** The file's header row: one column per thing an entry says, English as the copied report is. */
const HEADER = [
  'Timestamp',
  'Action',
  'Module',
  'Outcome',
  'Code',
  'Guard',
  'Target org',
  'Target org id',
  'Source org',
  'Source org id',
  'Operation id',
  'User (hash)',
  'Anonymized',
  'Contact points',
  'Review skipped',
  'Simulated (min before)',
  'Rehearsed (min before)',
  'Flows on insert',
  'Triggers on insert',
  'Processes on insert',
  'Workflow rules on insert',
  'Automation unread',
  'Confirmed',
  'Decisions',
  'Objects',
  'Left by',
  'Details',
];

/** A yes or a no, or nothing when the entry says neither. */
const yesNo = (value: boolean | undefined): string | undefined =>
  value === undefined ? undefined : value ? 'yes' : 'no';

/**
 * An object's counts in one cell: its name, then each count it has by the
 * name the entry keeps it under — `Account created=3 failed=1` — and how it
 * was skipped when it was.
 */
function objectCell(counts: AuditObjectCounts): string {
  return [
    counts.objectApiName,
    ...COUNT_COLUMNS.filter((column) => (counts[column] ?? 0) > 0).map(
      (column) => `${column}=${counts[column] ?? 0}`,
    ),
    ...(counts.skipped ? [`skipped=${counts.skipped}`] : []),
  ].join(' ');
}

/**
 * What the entry says beside the columns, by name — a Forge run's counts of
 * the email addresses and phone numbers it neutralized among them — without
 * the code, which has a column of its own.
 */
function detailsCell(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(([key]) => key !== 'code')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join('; ');
}

/** One entry as a row of the file. */
function row(entry: AuditLogEntry): Array<string | number | undefined> {
  const context = entry.context;
  const fired = context?.firedOnInsert;
  const code = entry.details['code'];
  return [
    entry.timestamp,
    entry.action,
    entry.module,
    entry.outcome,
    typeof code === 'string' ? code : undefined,
    entry.guard,
    entry.orgAlias,
    entry.orgId,
    entry.sourceOrgAlias,
    entry.sourceOrgId,
    entry.operationId,
    entry.userId,
    yesNo(context?.anonymized),
    context?.contactPoints,
    yesNo(context?.reviewSkipped),
    context?.simulatedMinutesBefore,
    context?.rehearsedMinutesBefore,
    fired?.flow,
    fired?.trigger,
    fired?.process,
    fired?.workflowRule,
    fired?.unread.join('; '),
    context?.confirmed?.join('; '),
    context?.decisions
      ?.map((d) => `${d.kind} ${d.count}${d.rows !== undefined ? ` (${d.rows} rows)` : ''}`)
      .join('; '),
    (entry.objects ?? []).map(objectCell).join('; '),
    entry.leftBy,
    detailsCell(entry.details),
  ];
}

/**
 * The entries as a CSV file, a row each in the order given, every cell
 * quoted and guarded as the Forge results are (`csvCell`): an alias, a code
 * or a detail that begins as a formula would is read as text by a
 * spreadsheet, and a comma or a quote in it stays in its cell.
 */
export function auditTrailCsv(entries: readonly AuditLogEntry[]): string {
  return [HEADER, ...entries.map(row)]
    .map((cells) => cells.map(csvCell).join(','))
    .join('\n');
}

/**
 * The entries as a JSON file: each as the trail keeps it, with when the file
 * was made and the filters it was made under, so a file read later says
 * which part of the trail it holds.
 */
export function auditTrailJson(
  entries: readonly AuditLogEntry[],
  filter: AuditExportFilter,
  exportedAt: string,
): string {
  const kept = Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined && value !== ''),
  );
  return JSON.stringify({ exportedAt, filter: kept, total: entries.length, entries }, null, 2);
}
