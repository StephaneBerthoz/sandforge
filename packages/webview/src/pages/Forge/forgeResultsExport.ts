import type { ForgeExecutionError, ForgeExecutionResult, ForgeNodeStatus } from '@sandforge/shared';
import { csvCell, forgeRunCreatedRecords, parseRecordError } from '@sandforge/shared';

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
 * The words the copied report and the results file give the lookups the
 * second pass left empty.
 */
const LEFT_EMPTY_WORDS = 'Lookups the second pass left empty';

/**
 * The per-object results as a CSV file: the rows the results table lists,
 * each status by its code as the copied report gives it, with what the run
 * created, linked and counted as failed of each object. Then, when its second
 * pass left lookups empty, a row of their own in the copied report's words:
 * how many of those it tried, and the codes it was refused with. Their records
 * are in the target and the run counts them failed nowhere, so the row leaves
 * the Failed column empty.
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
  const leftEmpty = lookupsLeftEmptyOf(result?.errors ?? []);
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
      // copied report's Errors column gives them: an object whose every row
      // the target refused had a failed count and an empty cell.
      [row.errors.join('; '), runFailureCell(row.objectApiName, result?.errors ?? [])]
        .filter(Boolean)
        .join('; '),
    ]),
    ...(leftEmpty === undefined
      ? []
      : [
          [
            LEFT_EMPTY_WORDS,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            leftEmptyCell(leftEmpty),
          ],
        ]),
  ]);
}

/**
 * The Errors cell of the second pass's row: "2 of 5 left empty", with the
 * codes its samples open with. A pass that counts no attempt says only how
 * many it left empty.
 */
function leftEmptyCell({ leftEmpty, attempted, codes }: LookupsLeftEmpty): string {
  const named = codes.length > 0 ? `: ${codes.join(', ')}` : '';
  const ofTried = attempted > 0 ? ` of ${String(attempted)}` : '';
  return `${String(leftEmpty)}${ofTried} left empty${named}`;
}

/**
 * Whether a report of the run is a note: one at the `scope` stage that counts
 * no failed record and does not skip its object — a lookup left empty because
 * its record is not in the clone, rows the platform writes itself, a check of
 * the target that could not be made. The run's status and its audit entry
 * read its reports the same way (`forgeAuditObjects`). A read that failed
 * counts no row either in a record-scoped run, which never learned how many
 * its scope held, and is a failure; so is an object skipped whole, whose
 * report may count none. Reference data the target holds no match for is a
 * note whatever it counts: never meant to be written, its rows are neither
 * written nor failed, as the run's totals and the audit trail count them, and
 * listed with the failures they swelled the panel's count of failed records.
 */
export function isRunNote(error: ForgeExecutionError): boolean {
  if (error.referenceData === true) return true;
  return error.stage === 'scope' && error.failedCount === 0 && error.skipped !== true;
}

/** The reports that are failures: neither notes nor reference data the target has no match for. */
function failuresOf(reports: readonly ForgeExecutionError[]): ForgeExecutionError[] {
  return reports.filter((report) => !isRunNote(report));
}

/**
 * The name the extension gives the report of its second pass, which fills in
 * the lookups the first could not: what it counts are lookups left empty on
 * records the target holds, which the run counts in no object's failures.
 */
const SECOND_PASS = '__pass2__';

/** Whether a report of the run is the second pass's, which names no object. */
export function isSecondPass(report: ForgeExecutionError): boolean {
  return report.objectApiName === SECOND_PASS;
}

/**
 * The name the extension gives the report of the parents it fetched for rows
 * whose required lookup pointed outside the clone (Auto-fetch parents): what
 * it counts are those parents it could not copy, each a record of its own
 * object, which its samples name. The rows that needed them fail under their
 * own object, and the run counts the parents failed nowhere.
 */
const ORPHAN_PARENTS = '__expandOrphanParents__';

/** Whether a report of the run is the fetched parents', which names no object. */
export function isOrphanParents(report: ForgeExecutionError): boolean {
  return report.objectApiName === ORPHAN_PARENTS;
}

/**
 * Whether a report of the run is a pass's rather than an object's — the
 * second pass, or the parents fetched outside the clone — as the audit trail
 * reads them: counted apart from the failed records and their objects.
 */
export function isPassReport(report: ForgeExecutionError): boolean {
  return isSecondPass(report) || isOrphanParents(report);
}

/**
 * The parents the run fetched outside the clone and could not copy, across
 * its reports: none when it copied every one it fetched, or fetched none.
 */
export function parentsNotCopiedOf(reports: readonly ForgeExecutionError[]): number {
  let parents = 0;
  for (const report of failuresOf(reports).filter(isOrphanParents)) parents += report.failedCount;
  return parents;
}

/**
 * The words the copied report gives the parents fetched outside the clone
 * that it could not copy.
 */
const PARENTS_NOT_COPIED_WORDS = 'Parents fetched outside the clone, not copied';

/** What the second pass left empty, across its reports. */
export interface LookupsLeftEmpty {
  /** The lookups it left empty. */
  leftEmpty: number;
  /** The lookups it tried to fill in. */
  attempted: number;
  /** The codes its samples open with, each once, in the order first seen. */
  codes: string[];
}

/**
 * The lookups the run's second pass left empty, added up across its reports,
 * with the codes it was refused with: nothing when it left none. Those
 * records are in the target, without the lookup, and the run counts them
 * failed nowhere: the copied report, the results file and the errors panel
 * count them apart from the failed records and objects.
 */
export function lookupsLeftEmptyOf(
  reports: readonly ForgeExecutionError[],
): LookupsLeftEmpty | undefined {
  let leftEmpty = 0;
  let attempted = 0;
  const codes = new Set<string>();
  for (const report of failuresOf(reports).filter(isSecondPass)) {
    leftEmpty += report.failedCount;
    attempted += report.attemptedCount;
    for (const { code } of codesInSamples(report)) codes.add(code);
  }
  return leftEmpty > 0 ? { leftEmpty, attempted, codes: [...codes] } : undefined;
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
 * The codes the samples of `report` open with, each with the number of
 * samples it was seen in, in the order first seen. Read as the results page
 * groups refusals (`parseRecordError`): `CODE: message`, or a Bulk job's
 * `CODE:message:Field --`. A report keeps three samples at most: these say
 * what the samples hold, not how many of the failed records each code refused.
 */
function codesInSamples(report: ForgeExecutionError): Array<{ code: string; samples: number }> {
  const seen = new Map<string, number>();
  for (const sample of report.samples) {
    const codes = new Set<string>();
    for (const message of sample.messages) {
      const { code } = parseRecordError(message);
      if (code !== null) codes.add(code);
    }
    for (const code of codes) seen.set(code, (seen.get(code) ?? 0) + 1);
  }
  return [...seen].map(([code, samples]) => ({ code, samples }));
}

/** What the run failed of an object at one stage, as one of its reports says it. */
export interface RunFailure {
  /** Where it failed: its read, its scope, or its write. */
  stage: ForgeExecutionError['stage'];
  /** The records the report counts failed. */
  failed: number;
  /** Whether the run skipped the object whole. */
  skipped: boolean;
  /** The codes its samples open with, each once, in the order first seen. */
  codes: string[];
}

/**
 * What the run failed of `objectApiName`, a part per report, for the Errors
 * column of the results table, of the file it is saved to and of the copied
 * report: the page words each part in its language, the file and the report
 * in English. Notes and reference data are left out: they count no failed
 * record.
 */
export function runFailuresOf(
  objectApiName: string,
  reports: readonly ForgeExecutionError[],
): RunFailure[] {
  return failuresOf(reports)
    .filter((report) => report.objectApiName === objectApiName)
    .map((report) => ({
      stage: report.stage,
      failed: report.failedCount,
      skipped: report.skipped === true,
      codes: codesInSamples(report).map(({ code }) => code),
    }));
}

/**
 * What the run failed of `objectApiName`, for its cell of the Errors column:
 * a phrase per report, "2 failed at insert: FIELD_CUSTOM_VALIDATION_EXCEPTION",
 * with the codes its samples open with, or "skipped whole" for an object the
 * run did not write at all, joined by semicolons. Empty when the run failed
 * none of it. Notes and reference data are left out: they count no failed record.
 */
export function runFailureCell(
  objectApiName: string,
  reports: readonly ForgeExecutionError[],
): string {
  return runFailuresOf(objectApiName, reports)
    .map(({ stage, failed, skipped, codes }) => {
      const named = codes.length > 0 ? `: ${codes.join(', ')}` : '';
      // An object skipped before its read counts none of its rows: "0 failed"
      // would say it lost nothing.
      if (skipped && failed === 0) return `skipped whole${named}`;
      const whole = skipped ? ' (skipped whole)' : '';
      // "failed" is the verb here, so the count needs no noun to agree with,
      // and the report is written in English whatever the panel's language.
      return `${String(failed)} failed at ${stage}${whole}${named}`;
    })
    .join('; ');
}

/**
 * The copied report's Run Errors section: the records the run failed, across
 * how many objects, then apart the lookups its second pass left empty — those
 * records are in the target, and the run counts them failed nowhere — and the
 * parents it fetched outside the clone and could not copy, which the rows that
 * needed them are already failed for. Then a row per report, as the errors
 * panel lists them, the passes' included: its stage, what it failed of what it
 * tried, the codes its samples open with and the first of their messages.
 * Nothing when the run failed nothing. Only the failed and attempted counts
 * are exact: the codes are read from three samples at most, which the
 * column's heading says.
 */
export function runErrorsReportLines(reports: readonly ForgeExecutionError[]): string[] {
  const failures = failuresOf(reports);
  if (failures.length === 0) return [];
  // A pass names no object: counted as one, the fetched parents' report read
  // "3 objects" of a run that failed rows of two.
  const ofObjects = failures.filter((report) => !isPassReport(report));
  let failed = 0;
  for (const report of ofObjects) failed += report.failedCount;
  const leftEmpty = lookupsLeftEmptyOf(failures)?.leftEmpty ?? 0;
  const parentsNotCopied = parentsNotCopiedOf(failures);
  // Counted as the errors panel counts them: an object with two reports is one.
  const objects = new Set(ofObjects.map((report) => report.objectApiName)).size;
  const lines = ['', '## Run Errors', ''];
  if (objects > 0) {
    lines.push(
      `- Failed records: ${String(failed)} across ${String(objects)} ${objects === 1 ? 'object' : 'objects'}`,
    );
  }
  if (leftEmpty > 0) {
    lines.push(`- ${LEFT_EMPTY_WORDS}: ${String(leftEmpty)}`);
  }
  if (parentsNotCopied > 0) {
    lines.push(`- ${PARENTS_NOT_COPIED_WORDS}: ${String(parentsNotCopied)}`);
  }
  lines.push(
    '',
    '| Object | Stage | Failed | Attempted | Codes seen in samples | Sample message |',
    '|--------|-------|--------|-----------|-----------------------|----------------|',
  );
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
 * could not check, a row per sample of each note as the notes panel lists
 * them — what it is about, then what it says. A note of the lookups an object
 * was written without names each lookup in a sample of its own: kept to its
 * first, the report named one lookup of several. Nothing when the run took
 * no note.
 */
export function runNotesReportLines(notes: readonly ForgeExecutionError[]): string[] {
  if (notes.length === 0) return [];
  const lines = ['', '## Run Notes', '', '| Object | Note |', '|--------|------|'];
  for (const note of notes) {
    const object = reportCell(note.objectApiName);
    if (note.samples.length === 0) lines.push(`| ${object} | - |`);
    for (const { recordSummary, messages } of note.samples) {
      const said = [recordSummary, messages.join('; ')].filter(Boolean).join(' — ');
      lines.push(`| ${object} | ${reportCell(said) || '-'} |`);
    }
  }
  return lines;
}
