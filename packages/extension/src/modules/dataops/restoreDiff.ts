/**
 * Which rows of a backup a restore writes: the ones whose values the org no
 * longer holds.
 *
 * A restore used to upsert every row of the snapshot. Run for real, a backup
 * of 12 000 contacts, three of whose titles had been changed since, was put
 * back with 12 000 upserts, sixty calls, to write three rows. Each batch is
 * now read from the org first, by Id and with the fields the restore would
 * write, and only the rows where one of them differs are sent. A row the read
 * does not find — deleted for good, out of the user's sight — goes as before,
 * and the org's answer says what became of it.
 */

import type { OrgSession } from './RecordRemoval.js';
import { isRecordId, readRecordsById } from './RecordRemoval.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/**
 * Characters of field names one read names at most. A query travels in a
 * URL, which the org refuses past some 16 000 characters (414, URI Too Long,
 * on a scratch org); 200 Ids take 4 200 of them, and a backup of an object
 * with hundreds of fields named every one of them in each row.
 */
const COLUMN_CHARACTERS_PER_READ = 3_000;

/** What a restore makes of one batch of a backup's rows. */
export interface RowsToRestore {
  /** The rows to write, in the batch's order. */
  write: Array<Record<string, unknown>>;
  /** How many of the batch's rows the org holds as the backup does: not written. */
  unchanged: number;
  /** Why the org's values could not be read, when they could not: every row is then written. */
  unread?: string;
}

/** A record by its first fifteen characters, whichever length its Id is written in. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/**
 * Whether a value the backup kept is the one the org holds now. An empty
 * value is one whether the answer leaves it out or says null; a value the
 * answer gives as a number and the backup kept as its text — or the reverse —
 * is the same value. A compound value is compared whole.
 */
export function sameValue(kept: unknown, now: unknown): boolean {
  const a = kept ?? null;
  const b = now ?? null;
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

/** `fields` in groups whose names stay short of what one read names. */
function columnGroups(fields: readonly string[]): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;
  for (const field of fields) {
    if (group.length > 0 && length + field.length + 2 > COLUMN_CHARACTERS_PER_READ) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(field);
    length += field.length + 2;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * The rows of `rows` the restore writes: those whose record the org does not
 * hold with every value the row would write — read by Id, a few columns at a
 * time for a wide object — and every row when that read fails, as a restore
 * wrote them all before.
 *
 * @param rows - One batch of the backup's rows, as the restore would send
 *   them: `Id` and the fields this org lets it write.
 */
export async function rowsToRestore(
  conn: Pick<OrgSession, 'query'>,
  objectApiName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<RowsToRestore> {
  const ids = rows.map((row) => row.Id).filter(isRecordId);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (field) => field.toLowerCase() !== 'id',
  );
  if (ids.length === 0 || fields.length === 0) return { write: [...rows], unchanged: 0 };

  const now = new Map<string, Record<string, unknown>>();
  try {
    for (const group of columnGroups(fields)) {
      for (const row of await readRecordsById(conn, objectApiName, group, ids)) {
        if (typeof row.Id !== 'string') continue;
        now.set(keyOf(row.Id), { ...now.get(keyOf(row.Id)), ...row });
      }
    }
  } catch (err: unknown) {
    return { write: [...rows], unchanged: 0, unread: extractErrorMessage(err) };
  }

  const write = rows.filter((row) => {
    const held = isRecordId(row.Id) ? now.get(keyOf(row.Id)) : undefined;
    if (!held) return true;
    return Object.keys(row).some(
      (field) => field.toLowerCase() !== 'id' && !sameValue(row[field], held[field]),
    );
  });
  return { write, unchanged: rows.length - write.length };
}

/** A backup's rows of one object, merged by record, and how many lines they were read from. */
export interface MergedRows {
  /** Each record once, `size` at a time; read again from the backup each time. */
  batches: AsyncIterable<Array<Record<string, unknown>>>;
  /** The lines the last pass read, before they were merged. */
  lines(): number;
}

/**
 * A backup's rows of one object, each record once: the lines it was kept in
 * merged, each field as the first line holding it kept it.
 *
 * A Sync run keeps, before each call that writes over records, the values of
 * the fields that call writes (`syncOverwrites`): a record two calls wrote —
 * an update, then the pass that sets its lookups — is kept in two lines, the
 * first holding a field as it was before the run, the second as the run had
 * left it. Restored as they came, two lines of one record went in one upsert,
 * which the org refuses for the Id it names twice; in two, the second wrote
 * the run's value back. The removal of the run reads them the same way
 * (`SyncRunRestore`). The object's rows are held while they are merged: a Sync
 * run's backup holds what it wrote over, which its removal reads whole too.
 *
 * @param rows - The backup's rows of the object, read from the start each
 *   time they are gone through.
 */
export function mergedById(
  rows: AsyncIterable<readonly Record<string, unknown>[]>,
  size: number,
): MergedRows {
  let lines = 0;
  return {
    batches: {
      async *[Symbol.asyncIterator]() {
        const merged = new Map<string, Record<string, unknown>>();
        /** Rows that name no record: left as they are, for the org to answer. */
        const unnamed: Array<Record<string, unknown>> = [];
        let counted = 0;
        for await (const batch of rows) {
          for (const row of batch) {
            counted++;
            if (!isRecordId(row.Id)) {
              unnamed.push({ ...row });
              continue;
            }
            const kept = merged.get(keyOf(row.Id));
            if (!kept) {
              merged.set(keyOf(row.Id), { ...row });
              continue;
            }
            for (const [field, value] of Object.entries(row)) {
              if (!(field in kept)) kept[field] = value;
            }
          }
        }
        lines = counted;
        const records = [...merged.values(), ...unnamed];
        for (let at = 0; at < records.length; at += size) yield records.slice(at, at + size);
      },
    },
    lines: () => lines,
  };
}
