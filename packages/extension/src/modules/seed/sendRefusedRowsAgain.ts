/**
 * A seeded row the target refused on fields it named, written again without
 * them.
 *
 * Seed fills a contact's phone with a number from the ranges kept for
 * fiction, which nobody holds; a target with a phone format rule of its own
 * refuses it. Run into a client sandbox whose rule wants `+xx(0)xxxxxxxxxx`,
 * a seed of ten contacts wrote none: every row was refused on `Phone`, which
 * the rule named (`FIELD_CUSTOM_VALIDATION_EXCEPTION`). Forge, Frozen and Sync
 * have sent such a row again without the fields a validation rule, a
 * restricted picklist or a lookup filter named since they first met one; Seed
 * now does too, on the same rules (`refusedFields`), and says which fields, for
 * how many rows and in the rule's words (`fieldsLeftOutNote`).
 *
 * Never without a field the run settled: the lookup a relation filled, a
 * reference rule's, the record type the run chose — written without it, the
 * row would stand alone or as another kind of record. The target names one
 * refusal at a time, so a row goes again at most twice, each time without the
 * fields its last refusal named; a row refused again keeps the target's last
 * word on it.
 */

import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  addWrittenWithoutFields,
  refusedFields,
  without,
  type FieldToLeaveOut,
  type WrittenWithoutFields,
} from '../../core/common/refusedFields.js';
import type { InsertResult, InsertedRow } from './SeedOrchestrator.js';

/** How many times a refused row is sent again, at most. */
const MAX_PASSES = 2;

/** What sending the refused rows again came to. */
export interface SentAgain {
  /** The insert's answer for every record, the rows sent again counted as they last came back. */
  result: InsertResult;
  /**
   * The rows written once sent again, and the fields they went without: what
   * `fieldsLeftOutNote` says in the object's result.
   */
  written?: WrittenWithoutFields;
  /** Why refused rows could not be sent again, when sending them failed outright. */
  unsent: string[];
  /** What the first insert said of how it sent the records (`InsertResult.notes`). */
  notes?: string[];
}

/**
 * Send again, without the fields the target named, the rows it refused for a
 * validation rule, a restricted picklist or a lookup filter.
 *
 * @param send - The insert, given the rows to write; it answers per row.
 * @param records - The rows of the first insert, in the order sent.
 * @param first - What the first insert answered. Without an answer per row —
 *   the Bulk API's paths give none — nothing is sent again.
 * @param keep - The fields no row goes without: what the run settled.
 * @param stopped - Whether the run's cancel came: nothing is sent again after it.
 */
export async function sendRefusedRowsAgain(
  send: (rows: Record<string, unknown>[]) => Promise<InsertResult>,
  records: readonly Record<string, unknown>[],
  first: InsertResult,
  keep: ReadonlySet<string>,
  stopped: () => boolean = () => false,
): Promise<SentAgain> {
  const answered = first.rows;
  if (!answered || answered.length !== records.length || first.stopped) {
    return { result: first, unsent: [] };
  }
  const rows: InsertedRow[] = [...answered];
  const current = [...records];
  const leftOut = records.map((): FieldToLeaveOut[] => []);
  const unsent: string[] = [];
  let cancelled = false;

  for (let pass = 0; pass < MAX_PASSES && !stopped(); pass++) {
    const at: number[] = [];
    const again: Record<string, unknown>[] = [];
    const named: FieldToLeaveOut[][] = [];
    rows.forEach((row, index) => {
      if (row.id) return;
      const fields = refusedFields(row.errorDetails, current[index], undefined);
      if (!fields || fields.some(({ field }) => keep.has(field))) return;
      at.push(index);
      again.push(without(current[index], fields));
      named.push(fields);
    });
    if (at.length === 0) break;

    let second: InsertResult;
    try {
      second = await send(again);
    } catch (err: unknown) {
      // The rows stay refused as they were; those written before stay written.
      const fields = [...new Set(named.flat().map(({ field }) => field))].sort();
      unsent.push(
        `${at.length} record(s) refused on ${fields.join(', ')} could not be written again ` +
          `without ${fields.length === 1 ? 'it' : 'them'}: ${extractErrorMessage(err)}`,
      );
      break;
    }
    const back = answeredRows(second, again.length);
    back.forEach((row, position) => {
      const index = at[position];
      rows[index] = row;
      current[index] = again[position];
      leftOut[index].push(...named[position]);
    });
    if (second.stopped) {
      cancelled = true;
      break;
    }
  }

  let written: WrittenWithoutFields | undefined;
  rows.forEach((row, index) => {
    if (!row.id || leftOut[index].length === 0) return;
    written = addWrittenWithoutFields(written, {
      rows: 1,
      fields: leftOut[index].map((field) => ({ ...field, rows: 1 })),
    });
  });
  return {
    result: {
      successIds: rows.flatMap((row) => (row.id ? [row.id] : [])),
      errors: rows.flatMap((row) => (row.id ? [] : [row.error ?? 'Unknown insert error'])),
      rows,
      ...(cancelled ? { stopped: true } : {}),
    },
    ...(written ? { written } : {}),
    unsent,
  };
}

/**
 * The insert's answer per row sent, in order. One that gives none, or not one
 * per row, is read off its lists: the ids first, then the errors — what was
 * written is counted and can be taken back, though which row each id was is
 * not known. A row a cancel kept from being sent is answered as not written.
 */
function answeredRows(result: InsertResult, sent: number): InsertedRow[] {
  if (result.rows && (result.rows.length === sent || result.stopped)) {
    return result.rows.slice(0, sent);
  }
  const fromLists: InsertedRow[] = [
    ...result.successIds.map((id) => ({ id })),
    ...result.errors.map((error) => ({ error })),
  ];
  return fromLists.slice(0, sent);
}
