import type { ForgeExecutionError, ForgeExecutionResult, ForgeNodeStatus } from '@sandforge/shared';
import { csvCell, forgeRunCreatedRecords } from '@sandforge/shared';

/** Rows of cells as CSV text, a line per row. */
function csv(rows: ReadonlyArray<ReadonlyArray<string | number | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

/**
 * The records of a run's target ids that it created, by target id, with the
 * object each belongs to: what the Id map can open in the target org.
 */
export function createdTargets(
  result: Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'>,
): Map<string, string> {
  const created = new Map<string, string>();
  for (const { objectApiName, ids } of forgeRunCreatedRecords(result)) {
    for (const id of ids) created.set(id, objectApiName);
  }
  return created;
}

/**
 * The copy the run created of the record it was asked to clone, `recordId`:
 * its id in the target and its object. For a run from a query, which names no
 * record, the first record it created of the root object. Nothing when the
 * run created none of them, linked to one the target held, or keeps its ids
 * in its journal. A record id typed with 15 characters finds the 18 the run
 * read it by.
 */
export function rootCopyOf(
  result: Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'> & {
    graph: Pick<ForgeExecutionResult['graph'], 'nodes'>;
  },
  recordId: string | undefined,
): { targetId: string; objectApiName: string; label?: string } | undefined {
  const table = result.idRemapTable ?? {};
  let sourceId: string | undefined;
  if (recordId) {
    const prefix = recordId.slice(0, 15);
    sourceId = Object.keys(table).find((id) => id.slice(0, 15) === prefix);
  } else {
    const root = result.graph.nodes.find((node) => node.level === 0)?.objectApiName;
    sourceId = result.idRemapCreated?.find((o) => o.objectApiName === root)?.sourceIds[0];
  }
  const targetId = sourceId === undefined ? undefined : table[sourceId];
  const objectApiName = targetId === undefined ? undefined : createdTargets(result).get(targetId);
  if (targetId === undefined || objectApiName === undefined) return undefined;
  // The object's label, which discovery's describe gave its node: the
  // results name the copy by it ("Open the Invoice cloned in …").
  const label = result.graph.nodes.find((node) => node.objectApiName === objectApiName)?.label;
  return label ? { targetId, objectApiName, label } : { targetId, objectApiName };
}

/** One object of the results table, as the file takes it. */
export interface ObjectResultRow {
  objectApiName: string;
  /** What the run read of it; nothing for an object it did not read. */
  records: number | undefined;
  status: ForgeNodeStatus;
  /** What went wrong with it as discovery described or counted it. */
  errors: readonly string[];
}

/**
 * The per-object results as a CSV file: the rows the results table lists,
 * each status by its code as the copied report gives it, with what the run
 * created, linked and counted as failed of each object.
 */
export function objectResultsCsv(
  rows: readonly ObjectResultRow[],
  result: Pick<ForgeExecutionResult, 'idRemapByObject' | 'errors'> | null,
): string {
  const remapped = new Map(
    (result?.idRemapByObject ?? []).map((counts) => [counts.objectApiName, counts]),
  );
  // Reference data the target holds no match for is neither written nor
  // failed, whatever its report counts: the run's totals count it in neither.
  const failed = new Map<string, number>();
  for (const report of result?.errors ?? []) {
    if (report.referenceData === true) continue;
    failed.set(report.objectApiName, (failed.get(report.objectApiName) ?? 0) + report.failedCount);
  }
  return csv([
    ['Object', 'Records read', 'Status', 'Created', 'Linked', 'Failed', 'Errors'],
    ...rows.map((row) => [
      row.objectApiName,
      row.records,
      row.status,
      remapped.get(row.objectApiName)?.created ?? 0,
      remapped.get(row.objectApiName)?.linked ?? 0,
      failed.get(row.objectApiName) ?? 0,
      // What discovery said of it, then what the run failed of it, as the
      // copied report's Errors column gives them.
      [row.errors.join('; '), runFailureCell(row.objectApiName, result?.errors ?? [])]
        .filter(Boolean)
        .join('; '),
    ]),
  ]);
}

/**
 * Whether a report of the run is a note: one at the `scope` stage that counts
 * no failed record and does not skip its object — a lookup left empty because
 * its record is not in the clone, rows the platform writes itself, a check of
 * the target that could not be made, records sent in smaller calls after the
 * target's automation hit a Salesforce limit. The run's status and its audit
 * entry read its reports the same way (`forgeAuditObjects`). A read that
 * failed counts no row either in a record-scoped run, which never learned how
 * many its scope held, and is a failure; so is an object skipped whole, whose
 * report may count none. Reference data the target holds no match for is a
 * note whatever it counts: never meant to be written, its rows are neither
 * written nor failed, as the run's totals and the audit trail count them, and
 * listed with the failures they swelled the panel's count of failed records.
 */
export function isRunNote(error: ForgeExecutionError): boolean {
  if (error.referenceData === true) return true;
  return error.stage === 'scope' && error.failedCount === 0 && error.skipped !== true;
}

/** The longest a cell of the copied report runs before it is cut. */
const REPORT_CELL_MAX = 300;

/**
 * `text` as a cell of a Markdown table: its spaces and line breaks run into
 * one space — an Apex message spans lines, and a line break ends the row —
 * cut at 300 characters with an ellipsis, then each `|` escaped, which would
 * otherwise open a column.
 */
export function reportCell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > REPORT_CELL_MAX ? `${flat.slice(0, REPORT_CELL_MAX - 1)}…` : flat;
  return cut.replace(/\|/g, '\\|');
}

/**
 * The status code a message of a sample opens with, `CODE: message`, as
 * Salesforce gives it: words in capitals joined by underscores. The
 * `STATUS_CODE` of the shared `error-hints` followed by its colon, copied
 * rather than imported, as the results page's `namesARequiredFieldMissing`
 * copies its own test of a code.
 */
const MESSAGE_CODE = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):/;

/**
 * The codes the samples of `report` open with, each with the number of
 * samples it was seen in, in the order first seen. A report keeps three
 * samples at most: these say what the samples hold, not how many of the
 * failed records each code refused.
 */
function codesInSamples(report: ForgeExecutionError): Array<{ code: string; samples: number }> {
  const seen = new Map<string, number>();
  for (const sample of report.samples) {
    const codes = new Set<string>();
    for (const message of sample.messages) {
      const code = MESSAGE_CODE.exec(message)?.[1];
      if (code !== undefined) codes.add(code);
    }
    for (const code of codes) seen.set(code, (seen.get(code) ?? 0) + 1);
  }
  return [...seen].map(([code, samples]) => ({ code, samples }));
}

/** The reports that are failures: neither notes nor reference data the target has no match for. */
function failuresOf(reports: readonly ForgeExecutionError[]): ForgeExecutionError[] {
  return reports.filter((report) => !isRunNote(report));
}

/**
 * What the run failed of `objectApiName`, for its cell of the Errors column:
 * a phrase per report, "116 failed at insert: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY",
 * with whether the object was skipped whole and the codes its samples open
 * with, joined by semicolons. Empty when the run failed none of it. Notes and
 * reference data are left out: they count no failed record.
 */
export function runFailureCell(
  objectApiName: string,
  reports: readonly ForgeExecutionError[],
): string {
  return failuresOf(reports)
    .filter((report) => report.objectApiName === objectApiName)
    .map((report) => {
      const codes = codesInSamples(report).map(({ code }) => code);
      const skipped = report.skipped === true ? ' (skipped whole)' : '';
      const named = codes.length > 0 ? `: ${codes.join(', ')}` : '';
      // "failed" is the verb here, so the count needs no noun to agree with.
      const failed = String(report.failedCount);
      return `${failed} failed at ${report.stage}${skipped}${named}`;
    })
    .join('; ');
}

/**
 * The copied report's Run Errors section: the records the run failed, across
 * how many objects, then a row per report — its stage, what it failed of what
 * it tried, the codes its samples open with and the first of their messages.
 * The reports of the run's own passes (`__pass2__`) are listed too, though
 * the per-object table has no row for them. Nothing when the run failed
 * nothing. Only the failed and attempted counts are exact: the codes are read
 * from three samples at most, which the column's heading says.
 */
export function runErrorsReportLines(reports: readonly ForgeExecutionError[]): string[] {
  const failures = failuresOf(reports);
  if (failures.length === 0) return [];
  let failed = 0;
  for (const report of failures) failed += report.failedCount;
  // Counted as the errors panel counts them: an object with two reports is one.
  const objects = new Set(failures.map((report) => report.objectApiName)).size;
  const lines = [
    '',
    '## Run Errors',
    '',
    `- Failed records: ${String(failed)} across ${String(objects)} ${objects === 1 ? 'object' : 'objects'}`,
    '',
    '| Object | Stage | Failed | Attempted | Codes seen in samples | Sample message |',
    '|--------|-------|--------|-----------|-----------------------|----------------|',
  ];
  for (const report of failures) {
    const total = report.samples.length;
    const codes = codesInSamples(report)
      .map(
        ({ code, samples }) =>
          `${code} (${String(samples)} of ${String(total)} ${total === 1 ? 'sample' : 'samples'})`,
      )
      .join(', ');
    const message = report.samples.flatMap((sample) => sample.messages)[0];
    const cells = [
      reportCell(report.objectApiName),
      report.skipped === true ? 'skipped whole' : report.stage,
      String(report.failedCount),
      String(report.attemptedCount),
      codes || '(no code)',
      message === undefined ? '-' : reportCell(message) || '-',
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

/**
 * The copied report's Run Notes section: what the run did differently, or
 * could not check, a row per note with its first sample — what it is about,
 * then what it says. Nothing when the run took no note.
 */
export function runNotesReportLines(notes: readonly ForgeExecutionError[]): string[] {
  if (notes.length === 0) return [];
  const lines = ['', '## Run Notes', '', '| Object | Note |', '|--------|------|'];
  for (const note of notes) {
    const sample = note.samples[0];
    const said = sample
      ? [sample.recordSummary, sample.messages[0]].filter(Boolean).join(' — ')
      : '';
    lines.push(`| ${reportCell(note.objectApiName)} | ${reportCell(said) || '-'} |`);
  }
  return lines;
}
