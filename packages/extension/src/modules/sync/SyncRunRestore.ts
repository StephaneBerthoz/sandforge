/**
 * Giving back what a Sync run wrote over: the records of the target an
 * update, or an upsert that matched, wrote, given the values they held
 * before the run, as the run kept them in the DataOps backup store
 * (`syncOverwrites`) and named them in its file.
 *
 * A record changed since the run — modified, by the org's clock, after the
 * run's last write — is left as it is unless the removal includes the
 * changed ones, as a removal keeps a record of the run changed since: the
 * change is someone's, and the run's values it holds alongside stay with it.
 * Of a record put back, only the fields that differ from their values before
 * the run are written: a record that holds them already — a call the run had
 * under way when it stopped, which the target never took — is counted put
 * back and not written. A record gone from the target, a record whose values
 * are no longer kept — its backup deleted, or past its retention — and what
 * the target refuses are counted apart, the refusals in its words. A value
 * from before the target no longer takes — a lookup to a record in its
 * recycle bin among them — is left as the run wrote it and named, the
 * record's other fields given back.
 *
 * The removal of the run makes it before its first delete
 * (`SyncRunRemoval`): a record the run wrote over that now names a record the
 * run created would keep that record in the org, depending on it.
 *
 * A checkpoint's rewind gives records their values back through it too, a
 * chunk of a snapshot at a time, its values read from the org just before
 * they are written. It names the fields that may be written back, as a
 * snapshot's row holds the org's stamps and `attributes` beside its values;
 * it holds the records to the moment it read the org, on the org's clock,
 * leaving what anyone but itself and its automation changed since; and it
 * keeps what each update writes over before it is sent, which its undo gives
 * back. A Sync run's removal names none of these and sends what it sent,
 * but for an object too wide to read in one statement, which the org
 * refused (414, or 431) and is now read in column groups.
 */

import type {
  AuditObjectCounts,
  SyncRestoreObjectResult,
  SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, isRecordId, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import type { BackupRecord } from '../dataops/BackupRecordStore.js';
import { CLOCK_LEEWAY_MS, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import type { SyncRunOverwritten } from './SyncRunCreations.js';
import type { OverwriteBackup } from './syncOverwrites.js';

/** The backups a restore reads the values from before of: the DataOps store (`BackupRecordStore`). */
export interface BackupReader {
  /** One object's records of a backup, `size` at a time; null when no file holds them. */
  batches(
    operationId: string,
    objectApiName: string,
    size: number,
  ): Promise<AsyncIterable<BackupRecord[]> | null>;
}

/** What a restore of a run's records is given. */
export interface SyncRestoreInput {
  org: Pick<RemovalOrg, 'query' | 'update' | 'serverTime'> & Partial<Pick<RemovalOrg, 'userId'>>;
  /** What the run wrote over and a removal puts back now (`syncRestorePlan`). */
  plan: readonly SyncRunOverwritten[];
  backups: BackupReader;
  /**
   * When the run last wrote, on this machine's clock (`SyncRunKept.lastWriteAt`):
   * a record modified after it, read on the org's clock, was changed since.
   * Absent, every record reads as changed since.
   */
  lastWriteAt?: string;
  /**
   * When the records are held to instead, on the org's own clock: a record
   * the org cannot date modified before it was changed since. Given,
   * `lastWriteAt` is not read, and no leeway is added — read on the org, the
   * date has no drift between two clocks to allow for, and the ten seconds a
   * date of this machine's gets would take a change made seconds after it
   * for none. The org dates a write to its second, truncated: a record dated
   * within the second the date falls in may have been modified after it, and
   * is taken for changed since. A rewind gives the moment it read the org to
   * rewind it.
   */
  changedAfter?: string;
  /**
   * The users, by id of either length, whose changes are the restore's own
   * doing: a record one of them modified last is given back as one unchanged
   * since, whenever it was modified, and one anyone else modified since is
   * left as they made it (`LastModifiedById`). A rewind names the user it
   * writes as and the org's Automated Process: what its own writes and the
   * automation they fired did in answer, which its second pass gives back
   * again. Where people sign in as that same user, their changes cannot be
   * told from its own.
   */
  ownWriters?: readonly string[];
  /**
   * The fields each object's records may be given back, by object: the only
   * columns read of them and the only fields written. A kept row's other
   * keys — the `attributes` the org answers a query with, the stamps, a
   * field deleted or hidden since — are neither read nor written, and a
   * record that holds none of these fields is counted as not kept. An object
   * it does not name has none. Absent, every key of a kept row is given
   * back, as a Sync run keeps only the fields it writes.
   */
  fields?: Readonly<Record<string, readonly string[]>>;
  /**
   * Keeps what the records of an update hold of the fields it writes, read
   * just before it, each with its `Id`, before the update is sent: a rewind's
   * journal, which its undo gives back from (`storeOverwriteBackup`). An
   * update whose values could not be kept is not sent, its records counted
   * refused with why, as a Sync run writes over nothing it cannot put back
   * (`syncOverwriteKeeper`); the next one is tried all the same.
   */
  keep?: OverwriteBackup['keep'];
  /** Put back the records changed since the run too. */
  includeChanged: boolean;
  /**
   * What earlier removals — the run's own, and those of runs after it that
   * wrote the same records — left on its records, by id: a record modified
   * no later than its stamp was not changed since the run, the removal that
   * dated it having taken back what made it so (`SyncRunRemovalState.removalStamps`).
   */
  stamps?: Readonly<Record<string, string>>;
  /**
   * The records whose `LastModifiedDate` the restore says back once it has
   * given them their values from before (`SyncRestoreOutcome.stamps`): those
   * an earlier run of the same target names too, which would otherwise read
   * the restore as a change since that run.
   */
  stampsFor?: (id: string) => boolean;
  /**
   * The encrypted fields the run wrote whose values from before were not
   * kept, read masked (`SyncRunKept.unkept`): said with each object's
   * reasons, as left as the run wrote them.
   */
  unkept?: ReadonlyArray<{ objectApiName: string; fields: readonly string[] }>;
  /**
   * Told each record it counts given back whole (`restored`) or no longer in
   * the org (`alreadyGone`), by the id the plan names it by: a rewind tells
   * apart, of what it gives back, the records it brought back from the
   * recycle bin, which come back with the values they had when deleted.
   */
  counted?: (id: string, as: 'restored' | 'alreadyGone') => void;
  /** Stops the restore before its next call to the org. */
  signal?: AbortSignal;
}

/** What a restore did. */
export interface SyncRestoreOutcome {
  objects: SyncRestoreObjectResult[];
  /** The records still to put back: changed since and left, refused, not reached. */
  left: string[];
  /** Whether it wrote to the org. */
  wrote: boolean;
  /** Whether a stop ended it before it was through. */
  cancelled: boolean;
  /**
   * Of the records {@link SyncRestoreInput.stampsFor} names, those the restore
   * left holding their values from before the run, unchanged since it, by
   * id: the `LastModifiedDate` the org gives each — written back by the
   * restore's user, or holding them already — for that earlier run's removal
   * to read as no change since it.
   */
  stamps: Record<string, string>;
}

/** Why records were refused, a few of each: the org repeats a handful of reasons. */
const REASONS_KEPT = 5;

/** Columns past which a read by Id names fewer records per query, so it stays short enough for a URL. */
const WIDE_COLUMNS = 100;

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** Whether a value reads as nothing, as the org answers an empty field. */
function empty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** An ISO date and time, as the org writes one. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Whether two values of a field are the same as the org holds them: nothing
 * and an empty text alike, a number whatever its form, a date and time
 * whatever its zone and precision.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return true;
    if (DATE_TIME.test(a) && DATE_TIME.test(b)) {
      const at = Date.parse(a);
      return Number.isFinite(at) && at === Date.parse(b);
    }
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The user a session writes as, by the first fifteen characters of its id,
 * read once, for the stamps of what it writes; undefined when the org does
 * not say.
 */
export function writerOnce(
  org: Partial<Pick<RemovalOrg, 'userId'>>,
): () => Promise<string | undefined> {
  let writer: Promise<string | undefined> | undefined;
  return () => {
    writer ??= (async () => {
      try {
        const user = await org.userId?.();
        return typeof user === 'string' && user !== '' ? recordKey(user) : undefined;
      } catch {
        return undefined;
      }
    })();
    return writer;
  };
}

/** The org's clock ahead of this machine's, in milliseconds; 0 when the org will not say. */
export async function orgAheadOf(org: Pick<RemovalOrg, 'serverTime'>): Promise<number> {
  const before = Date.now();
  try {
    const now = Date.parse(await org.serverTime());
    return Number.isFinite(now) ? now - (before + Date.now()) / 2 : 0;
  } catch {
    return 0;
  }
}

/**
 * When a run last wrote, `lastWriteAt` on this machine's clock, read on the
 * org's, a little later for the drift of one clock from the other, in epoch
 * milliseconds: a record the org dates modified after it was changed since
 * the run. Minus infinity when the run's last write is unknown: every record
 * reads as changed since. What a restore of the values a run wrote over —
 * its removal's, or DataOps' of the run's backup — holds each record to.
 */
export async function runEndOnOrgClock(
  org: Pick<RemovalOrg, 'serverTime'>,
  lastWriteAt: string | undefined,
): Promise<number> {
  const lastWrite = Date.parse(lastWriteAt ?? '');
  return Number.isFinite(lastWrite)
    ? lastWrite + (await orgAheadOf(org)) + CLOCK_LEEWAY_MS
    : Number.NEGATIVE_INFINITY;
}

/**
 * The grain the org dates a write to: its second, truncated. An undelete
 * begun at :26.731 by the org's clock was dated :26.000.
 */
const ORG_DATE_GRAIN_MS = 1_000;

/**
 * The latest date the org can give a record and have it modified before
 * `date`, a date of its own clock (`SyncRestoreInput.changedAfter`), in epoch
 * milliseconds: a write is dated the start of its second, so one dated a
 * whole second or more before `date` was made before it, and one dated later
 * may not have been. Minus infinity when `date` does not read as a date:
 * every record then reads as changed since.
 */
function datedBefore(date: string): number {
  const at = Date.parse(date);
  return Number.isFinite(at) ? at - ORG_DATE_GRAIN_MS : Number.NEGATIVE_INFINITY;
}

/**
 * The fields of `objectApiName` that may be written back, by their name in
 * lower case, as Salesforce matches a field whatever its case, to the name
 * as given; none when the object is not named.
 */
function allowedFieldsOf(
  fields: Readonly<Record<string, readonly string[]>>,
  objectApiName: string,
): Map<string, string> {
  const named = Object.hasOwn(fields, objectApiName) ? fields[objectApiName] : [];
  return new Map(
    named
      .filter((field) => field.toLowerCase() !== 'id')
      .map((field) => [field.toLowerCase(), field]),
  );
}

/** One record's answer to an update, as jsforce gives it: a REST collection names the fields refused. */
interface UpdateAnswer {
  success?: boolean;
  errors?: Array<{ statusCode?: string; message?: string; fields?: unknown } | string>;
}

/**
 * Refusals that name no field and are about one all the same: the field the
 * record holds the refused value in.
 */
const FIELD_OF_CODE: Readonly<Record<string, string>> = {
  INACTIVE_OWNER_OR_USER: 'OwnerId',
};

/**
 * The fields of `sent` a refusal is about, as the org names them in
 * `errors[].fields` or by its code: the values from before it no longer
 * takes — a restricted picklist value deactivated since, an owner no longer
 * active. None when it names no field of the update: the whole record
 * refused, or a lookup to a record in the recycle bin, which the org refuses
 * naming no field (`ENTITY_IS_DELETED`, see {@link restoreOverwrites}).
 */
function refusedFields(answer: UpdateAnswer, sent: Readonly<Record<string, unknown>>): string[] {
  const named = new Set<string>();
  for (const error of answer.errors ?? []) {
    if (typeof error === 'string') continue;
    if (Array.isArray(error.fields)) {
      for (const field of error.fields) if (typeof field === 'string') named.add(field);
    }
    const byCode = error.statusCode !== undefined ? FIELD_OF_CODE[error.statusCode] : undefined;
    if (byCode !== undefined && (!Array.isArray(error.fields) || error.fields.length === 0)) {
      named.add(byCode);
    }
  }
  const lower = new Map(Object.keys(sent).map((field) => [field.toLowerCase(), field]));
  return [...named].flatMap((field) => {
    const own = lower.get(field.toLowerCase());
    return own !== undefined && own !== 'Id' ? [own] : [];
  });
}

/** What an update's answer said of each record, by its place. */
function answersOf(answer: unknown, count: number): UpdateAnswer[] {
  const rows = Array.isArray(answer) ? (answer as UpdateAnswer[]) : [answer as UpdateAnswer];
  return Array.from({ length: count }, (_, at) => rows[at] ?? { success: false });
}

/** A refusal in the org's words: `CODE: message`. */
function refusalOf(answer: UpdateAnswer): { code?: string; words: string } {
  const error = answer.errors?.[0];
  if (error === undefined) return { words: 'The org gave no reason.' };
  if (typeof error === 'string') return { words: error };
  const code = error.statusCode;
  const message = error.message ?? '';
  return {
    ...(code ? { code } : {}),
    words: code && message ? `${code}: ${message}` : code || message,
  };
}

/** Fields of a record left as the run wrote them, and the org's words for why. */
interface FieldsLeft {
  fields: string[];
  why: string;
}

/** Fields left as the run wrote them, said with why the org no longer takes their values from before. */
function fieldsLeftWords(objectApiName: string, { fields, why }: FieldsLeft): string {
  return (
    `${fields.map((field) => `${objectApiName}.${field}`).join(', ')}: the value from ` +
    `before is no longer taken (${why}) — left as the run wrote it`
  );
}

/**
 * Of `ids`, the records of `object` still in the org, by key, read by their
 * Ids, up to 200 a query; or, when the org could not be read, why.
 */
async function stillThere(
  org: Pick<RemovalOrg, 'query'>,
  object: string,
  ids: readonly string[],
): Promise<{ live: Set<string>; unread?: undefined } | { unread: string }> {
  const live = new Set<string>();
  try {
    for (const list of idLists(ids)) {
      const answer = await org.query(`SELECT Id FROM ${object} WHERE Id IN (${list})`);
      for (const row of answer.records as Array<Record<string, unknown>>) {
        if (typeof row.Id === 'string') live.add(recordKey(row.Id));
      }
    }
  } catch (err: unknown) {
    return { unread: extractErrorMessage(err) };
  }
  return { live };
}

/** The tally of one object. */
class ObjectRestore {
  readonly result: SyncRestoreObjectResult;
  private readonly said = new Set<string>();

  constructor(objectApiName: string, planned: number) {
    this.result = {
      objectApiName,
      planned,
      restored: 0,
      keptChanged: 0,
      alreadyGone: 0,
      refused: 0,
      notKept: 0,
      reasons: [],
    };
  }

  /** Records given back their values but for fields the org no longer takes. */
  without(): void {
    this.result.restoredWithout = (this.result.restoredWithout ?? 0) + 1;
  }

  reason(words: string): void {
    if (this.said.has(words) || this.said.size >= REASONS_KEPT) return;
    this.said.add(words);
    this.result.reasons.push(words);
  }
}

/**
 * Give back to the records a run wrote over the values they held before it:
 * see the module's comment. A call to the org that fails outright fails the
 * object it was for, its records counted refused with why; the next object
 * is tried all the same.
 */
export async function restoreOverwrites(input: SyncRestoreInput): Promise<SyncRestoreOutcome> {
  const { org, plan } = input;
  const objects: SyncRestoreObjectResult[] = [];
  const left: string[] = [];
  const stamps: Record<string, string> = {};
  let wrote = false;
  let cancelled = false;
  if (plan.length === 0) return { objects, left, wrote, cancelled, stamps };

  const runEnd =
    input.changedAfter !== undefined
      ? datedBefore(input.changedAfter)
      : await runEndOnOrgClock(org, input.lastWriteAt);
  const stampedBefore = new Map(
    Object.entries(input.stamps ?? {}).map(([id, date]) => [recordKey(id), Date.parse(date)]),
  );
  const owners =
    input.ownWriters && input.ownWriters.length > 0
      ? new Set(input.ownWriters.map(recordKey))
      : undefined;
  const stampsFor = input.stampsFor;
  const writerOf = writerOnce(org);

  for (const { objectApiName, backup, ids } of plan) {
    const tally = new ObjectRestore(objectApiName, ids.length);
    objects.push(tally.result);
    const masked = input.unkept?.find((object) => object.objectApiName === objectApiName);
    if (masked && masked.fields.length > 0) {
      tally.reason(
        `${masked.fields.map((field) => `${objectApiName}.${field}`).join(', ')}: not kept, ` +
          "encrypted — the run's user cannot view encrypted data, and read their values from " +
          'before masked; left as the run wrote them',
      );
    }
    if (cancelled || input.signal?.aborted) {
      cancelled = true;
      tally.result.notReached = ids.length;
      left.push(...ids);
      continue;
    }
    const object = assertSoqlIdentifier(objectApiName);
    const wanted = new Map(ids.map((id) => [recordKey(id), id]));
    const allowed = input.fields ? allowedFieldsOf(input.fields, objectApiName) : undefined;

    // The values from before, as the run kept them: each field once, as it
    // was before the run first wrote it — of the fields that may be written
    // back, when they are named: a checkpoint's row holds the org's
    // `attributes` and its stamps beside its values, and a restore that took
    // every key of it read them and wrote them.
    const before = new Map<string, Record<string, unknown>>();
    /** Records kept, by key, whose kept values are of no field that may be written back. */
    const noneAllowed = new Set<string>();
    try {
      const batches = await input.backups.batches(backup, objectApiName, RECORDS_PER_CALL);
      for await (const batch of batches ?? []) {
        for (const record of batch) {
          if (typeof record.Id !== 'string' || !wanted.has(recordKey(record.Id))) continue;
          const values = before.get(recordKey(record.Id)) ?? {};
          for (const [key, value] of Object.entries(record)) {
            if (key === 'Id') continue;
            const field = allowed ? allowed.get(key.toLowerCase()) : key;
            if (field !== undefined && !(field in values)) values[field] = value;
          }
          if (allowed && Object.keys(values).length === 0) {
            noneAllowed.add(recordKey(record.Id));
            continue;
          }
          before.set(recordKey(record.Id), values);
        }
      }
    } catch (err: unknown) {
      tally.reason(`The values from before the run could not be read: ${extractErrorMessage(err)}`);
      before.clear();
      noneAllowed.clear();
    }
    const nothingAllowed = [...noneAllowed].filter((key) => !before.has(key)).length;
    if (nothingAllowed > 0) {
      tally.reason(
        `${nothingAllowed} ${objectApiName} record(s) hold no value of a field that may be ` +
          'written back now: left as they are',
      );
    }
    for (const key of [...wanted.keys()]) {
      if (before.has(key)) continue;
      tally.result.notKept++;
      wanted.delete(key);
    }
    if (wanted.size === 0) continue;

    // What the records hold now, when they were last modified, and by whom
    // when some writers are the restore's own. A record too wide for one
    // statement is read in column groups, each held to the write its
    // modified date names: merged across a write made between two groups,
    // it would show values that write left under the date of the one before,
    // and be given back over a change made since.
    const named = new Set<string>();
    for (const values of before.values()) {
      for (const field of Object.keys(values)) named.add(assertSoqlIdentifier(field));
    }
    const columns = ['Id', 'LastModifiedDate', ...(owners ? ['LastModifiedById'] : []), ...named];
    const perQuery = columns.length > WIDE_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
    const now = new Map<string, Record<string, unknown>>();
    const read = async (statement: string): Promise<Array<Record<string, unknown>>> => {
      if (input.signal?.aborted) throw new RestoreStopped();
      const answer = await org.query(statement);
      return answer.records as Array<Record<string, unknown>>;
    };
    try {
      for (const list of idLists([...wanted.values()], perQuery)) {
        const rows = await readColumnsApart(
          `SELECT ${columns.join(', ')} FROM ${object} WHERE Id IN (${list})`,
          read,
          { stamp: 'LastModifiedDate' },
        );
        for (const row of rows) {
          if (typeof row.Id === 'string') now.set(recordKey(row.Id), row);
        }
      }
    } catch (err: unknown) {
      if (err instanceof RestoreStopped) {
        cancelled = true;
        tally.result.notReached = wanted.size;
        left.push(...wanted.values());
        continue;
      }
      tally.result.refused += wanted.size;
      tally.reason(extractErrorMessage(err));
      left.push(...wanted.values());
      continue;
    }

    // What each record is given back: the fields that differ.
    const updates: Array<Record<string, unknown> & { Id: string }> = [];
    /** The records written back whose new date an earlier run of the target reads, by id. */
    const stamping = new Set<string>();
    /** When the writes began, by the org's clock, give or take the drift; read only when stamped. */
    const writesFrom = stampsFor ? Date.now() + (await orgAheadOf(org)) - CLOCK_LEEWAY_MS : 0;
    for (const [key, id] of wanted) {
      const current = now.get(key);
      if (!current) {
        tally.result.alreadyGone++;
        input.counted?.(id, 'alreadyGone');
        continue;
      }
      const modified = Date.parse(String(current.LastModifiedDate ?? ''));
      const lastBy = current.LastModifiedById;
      // Changed since the run: modified after it, and after what a removal
      // that took back a later run's write of it left on it, by someone
      // other than the restore's own writers.
      const unchanged =
        modified <= runEnd ||
        modified <= (stampedBefore.get(key) ?? Number.NaN) ||
        (owners !== undefined && typeof lastBy === 'string' && owners.has(recordKey(lastBy)));
      if (!unchanged && !input.includeChanged) {
        tally.result.keptChanged++;
        left.push(id);
        continue;
      }
      const values = before.get(key) ?? {};
      const back: Record<string, unknown> & { Id: string } = { Id: current.Id as string };
      for (const [field, value] of Object.entries(values)) {
        if (!sameValue(value, current[field])) back[field] = empty(value) ? null : value;
      }
      if (Object.keys(back).length === 1) {
        tally.result.restored++;
        input.counted?.(id, 'restored');
        // Holding them already, as last modified by the run — or a run after
        // it whose removal gave it back its values: no change since either.
        if (unchanged && stampsFor?.(id) && typeof current.LastModifiedDate === 'string') {
          stamps[current.Id as string] = current.LastModifiedDate;
        }
        continue;
      }
      updates.push(back);
      if (unchanged && stampsFor?.(id)) stamping.add(id);
    }

    /**
     * The records refused for some of their fields, sent once more without
     * them, with the fields left out and why. One field the org no longer
     * takes refused the whole record, and every later removal sent it again
     * and was refused the same way: the fields put back with it kept the
     * run's values.
     */
    const again: Array<{
      record: Record<string, unknown> & { Id: string };
      leftOut: FieldsLeft[];
    }> = [];
    /**
     * The records refused `ENTITY_IS_DELETED` naming no field, and why. The
     * org answers so, word for word, an update of a record no longer there
     * and one that sets a lookup to a record in its recycle bin, in a single
     * write as in a collection. Read as gone, a record whose parent stays in
     * the bin would be counted no longer in the org, and none of its other
     * fields written.
     */
    const unnamed: Array<{ record: Record<string, unknown> & { Id: string }; why: string }> = [];
    const refused = (record: { Id: string }, words: string): void => {
      tally.result.refused++;
      tally.reason(words);
      left.push(wanted.get(recordKey(record.Id)) ?? record.Id);
    };
    const whole = (record: { Id: string }): void => {
      tally.result.restored++;
      input.counted?.(wanted.get(recordKey(record.Id)) ?? record.Id, 'restored');
    };
    const gone = (record: { Id: string }): void => {
      tally.result.alreadyGone++;
      input.counted?.(wanted.get(recordKey(record.Id)) ?? record.Id, 'alreadyGone');
    };
    const stopped = (records: ReadonlyArray<{ Id: string }>): void => {
      cancelled = true;
      tally.result.notReached = (tally.result.notReached ?? 0) + records.length;
      left.push(...records.map((record) => wanted.get(recordKey(record.Id)) ?? record.Id));
    };
    /**
     * A record still there whose `lookups` the org was sent: those it no
     * longer takes left as the run wrote them, and named; the rest of the
     * record sent once more, or, nothing else to send, the record given back
     * but for them — refused when none of its lookups was written either.
     */
    const settleLookups = (
      record: Record<string, unknown> & { Id: string },
      lookups: readonly string[],
      leftOut: FieldsLeft[],
      givenAlone: boolean,
    ): void => {
      const rest = Object.keys(record).filter(
        (field) => field !== 'Id' && !lookups.includes(field),
      );
      if (rest.length > 0) {
        const without: Record<string, unknown> & { Id: string } = { Id: record.Id };
        for (const field of rest) without[field] = record[field];
        again.push({ record: without, leftOut });
        return;
      }
      if (leftOut.length === 0) {
        whole(record);
        return;
      }
      const [first, ...others] = leftOut;
      if (givenAlone) {
        tally.without();
        tally.reason(fieldsLeftWords(objectApiName, first));
      } else {
        refused(record, fieldsLeftWords(objectApiName, first));
      }
      for (const fields of others) tally.reason(fieldsLeftWords(objectApiName, fields));
    };
    const send = async (
      batch: ReadonlyArray<Record<string, unknown> & { Id: string }>,
    ): Promise<UpdateAnswer[]> => {
      try {
        wrote = true;
        return answersOf(await org.update(objectApiName, [...batch]), batch.length);
      } catch (err: unknown) {
        const words = extractErrorMessage(err);
        return batch.map(() => ({ success: false, errors: [words] }));
      }
    };
    /**
     * What an update is about to write over, kept before it is sent: the
     * values the records hold now of the fields it writes, as read just
     * before. Whether it may go; when they could not be kept, its records
     * are refused, with why. Its records sent again without a refused field
     * write fewer of the same fields, already kept.
     */
    const keptFirst = async (
      batch: ReadonlyArray<Record<string, unknown> & { Id: string }>,
    ): Promise<boolean> => {
      const keep = input.keep;
      if (!keep) return true;
      const held = batch.map((record) => {
        const current = now.get(recordKey(record.Id)) ?? {};
        const values: Record<string, unknown> = { Id: record.Id };
        for (const field of Object.keys(record)) {
          if (field !== 'Id') values[field] = current[field] ?? null;
        }
        return values;
      });
      try {
        await keep(objectApiName, held);
        return true;
      } catch (err: unknown) {
        const words =
          `What these ${batch.length} ${objectApiName} record(s) hold now could not be kept ` +
          `before they were written (${extractErrorMessage(err)}), so none of them was written: ` +
          'nothing is written over that cannot be put back.';
        for (const record of batch) refused(record, words);
        return false;
      }
    };
    for (let at = 0; at < updates.length; at += RECORDS_PER_CALL) {
      const batch = updates.slice(at, at + RECORDS_PER_CALL);
      if (input.signal?.aborted) {
        cancelled = true;
        const rest = updates.slice(at);
        tally.result.notReached = (tally.result.notReached ?? 0) + rest.length;
        left.push(...rest.map((record) => wanted.get(recordKey(record.Id)) ?? record.Id));
        break;
      }
      if (!(await keptFirst(batch))) continue;
      const answers = await send(batch);
      answers.forEach((answer, place) => {
        const record = batch[place];
        if (answer.success === true) {
          whole(record);
          return;
        }
        const refusal = refusalOf(answer);
        const fields = refusedFields(answer, record);
        if (refusal.code === 'ENTITY_IS_DELETED' && fields.length === 0) {
          unnamed.push({ record, why: refusal.words });
          return;
        }
        const rest = Object.keys(record).filter(
          (field) => field !== 'Id' && !fields.includes(field),
        );
        if (fields.length > 0 && rest.length > 0) {
          const without: Record<string, unknown> & { Id: string } = { Id: record.Id };
          for (const field of rest) without[field] = record[field];
          again.push({ record: without, leftOut: [{ fields, why: refusal.words }] });
          return;
        }
        refused(record, refusal.words);
      });
    }

    // Gone, or a lookup to a record in the bin: told apart by whether the
    // record is still there, one read of up to 200 of them by their Ids, sent
    // only once the org refused some. Still there, the refused lookup is the
    // one the org was sent, or, of several, the one it refuses alone.
    /** Records still there that were sent several lookups, and what each one sent alone met. */
    const probes: Array<{
      record: Record<string, unknown> & { Id: string };
      lookups: string[];
      given: string[];
      refusedAlone: Array<{ field: string; why: string }>;
    }> = [];
    if (unnamed.length > 0 && input.signal?.aborted) {
      stopped(unnamed.map(({ record }) => record));
    } else if (unnamed.length > 0) {
      const there = await stillThere(
        org,
        object,
        unnamed.map(({ record }) => record.Id),
      );
      if (there.unread !== undefined) {
        tally.reason(
          `Whether ${unnamed.length} ${objectApiName} record(s) refused as deleted are still in ` +
            `the org could not be read (${there.unread}): left to be given back again`,
        );
      }
      for (const { record, why } of unnamed) {
        if (there.unread !== undefined) {
          refused(record, why);
          continue;
        }
        if (!there.live.has(recordKey(record.Id))) {
          gone(record);
          continue;
        }
        const lookups = Object.keys(record).filter(
          (field) => field !== 'Id' && isRecordId(record[field]),
        );
        if (lookups.length === 0) {
          // There, and sent no lookup: refused for something else of it.
          refused(record, why);
        } else if (lookups.length === 1) {
          settleLookups(record, lookups, [{ fields: lookups, why }], false);
        } else {
          probes.push({ record, lookups, given: [], refusedAlone: [] });
        }
      }
    }
    let probing = probes.length > 0;
    for (let round = 0; probing && probes.some(({ lookups }) => lookups.length > round); round++) {
      const sent = probes.filter(({ lookups }) => lookups.length > round);
      for (let at = 0; at < sent.length; at += RECORDS_PER_CALL) {
        if (input.signal?.aborted) {
          stopped(probes.map(({ record }) => record));
          probing = false;
          break;
        }
        const batch = sent.slice(at, at + RECORDS_PER_CALL);
        const answers = await send(
          batch.map(({ record, lookups }) => ({
            Id: record.Id,
            [lookups[round]]: record[lookups[round]],
          })),
        );
        answers.forEach((answer, place) => {
          const probe = batch[place];
          const field = probe.lookups[round];
          if (answer.success === true) probe.given.push(field);
          else probe.refusedAlone.push({ field, why: refusalOf(answer).words });
        });
      }
    }
    for (const probe of probing ? probes : []) {
      const byWhy = new Map<string, string[]>();
      for (const { field, why } of probe.refusedAlone) {
        byWhy.set(why, [...(byWhy.get(why) ?? []), field]);
      }
      settleLookups(
        probe.record,
        probe.lookups,
        [...byWhy].map(([why, fields]) => ({ fields, why })),
        probe.given.length > 0,
      );
    }

    for (let at = 0; at < again.length; at += RECORDS_PER_CALL) {
      const batch = again.slice(at, at + RECORDS_PER_CALL);
      if (input.signal?.aborted) {
        cancelled = true;
        tally.result.notReached = (tally.result.notReached ?? 0) + again.length - at;
        left.push(
          ...again.slice(at).map(({ record }) => wanted.get(recordKey(record.Id)) ?? record.Id),
        );
        break;
      }
      const answers = await send(batch.map(({ record }) => record));
      answers.forEach((answer, place) => {
        const { record, leftOut } = batch[place];
        if (answer.success === true) {
          // Each of its lookups written alone, none refused: given back whole.
          if (leftOut.length === 0) {
            whole(record);
            return;
          }
          // Given back but for those fields, which keep the run's values: the
          // run settles, and nothing more is sent for them.
          tally.without();
          for (const fields of leftOut) tally.reason(fieldsLeftWords(objectApiName, fields));
          return;
        }
        refused(record, refusalOf(answer).words);
      });
    }
    Object.assign(stamps, await stampsWritten(org, object, [...stamping], writesFrom, writerOf));
  }
  return { objects, left, wrote, cancelled, stamps };
}

/**
 * The `LastModifiedDate` the org gives the records a restore wrote back — or
 * an undelete brought back (`SyncRunUndelete`) — by id, of those its user
 * last modified since its writes began: a record someone else modified since
 * keeps their change. Best effort: records that
 * cannot be read back are left unstamped, and so is every one when the org
 * does not say who the restore writes as.
 */
export async function stampsWritten(
  org: Pick<RemovalOrg, 'query'>,
  object: string,
  ids: readonly string[],
  from: number,
  writerOf: () => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {};
  if (ids.length === 0) return stamps;
  const user = await writerOf();
  if (user === undefined) return stamps;
  for (const list of idLists(ids)) {
    let rows: Array<Record<string, unknown>>;
    try {
      const answer = await org.query(
        `SELECT Id, LastModifiedDate, LastModifiedById FROM ${object} WHERE Id IN (${list})`,
      );
      rows = answer.records as Array<Record<string, unknown>>;
    } catch {
      continue;
    }
    for (const row of rows) {
      if (
        typeof row.Id === 'string' &&
        typeof row.LastModifiedDate === 'string' &&
        typeof row.LastModifiedById === 'string' &&
        recordKey(row.LastModifiedById) === user &&
        Date.parse(row.LastModifiedDate) >= from
      ) {
        stamps[row.Id] = row.LastModifiedDate;
      }
    }
  }
  return stamps;
}

/** A stop that came while a restore read the records it puts back. */
class RestoreStopped extends Error {}

/**
 * What a removal deleted, per object, for the audit trail, with what it gave
 * back counted as updated, what it brought back from the recycle bin as
 * created, and what the target refused it as failed, each object once.
 */
export function withRestoreAudit(
  deleted: readonly AuditObjectCounts[],
  restored: readonly SyncRestoreObjectResult[],
  undeleted: readonly SyncUndeleteObjectResult[] = [],
): AuditObjectCounts[] {
  const merged = deleted.map((object) => ({ ...object }));
  for (const object of undeleted) {
    if (object.undeleted + object.refused === 0) continue;
    const entry = merged.find((counts) => counts.objectApiName === object.objectApiName);
    if (entry) {
      entry.created += object.undeleted;
      entry.failed += object.refused;
    } else {
      merged.push({
        objectApiName: object.objectApiName,
        created: object.undeleted,
        updated: 0,
        deleted: 0,
        failed: object.refused,
      });
    }
  }
  for (const object of restored) {
    const updated = object.restored + (object.restoredWithout ?? 0);
    if (updated + object.refused === 0) continue;
    const entry = merged.find((counts) => counts.objectApiName === object.objectApiName);
    if (entry) {
      entry.updated += updated;
      entry.failed += object.refused;
    } else {
      merged.push({
        objectApiName: object.objectApiName,
        created: 0,
        updated,
        deleted: 0,
        failed: object.refused,
      });
    }
  }
  return merged;
}
