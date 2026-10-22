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
 * the target refuses are counted apart, the refusals in its words.
 *
 * The removal of the run makes it before its first delete
 * (`SyncRunRemoval`): a record the run wrote over that now names a record the
 * run created would keep that record in the org, depending on it.
 */

import type { AuditObjectCounts, SyncRestoreObjectResult } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import type { BackupRecord } from '../dataops/BackupRecordStore.js';
import { CLOCK_LEEWAY_MS, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import type { SyncRunOverwritten } from './SyncRunCreations.js';

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
  org: Pick<RemovalOrg, 'query' | 'update' | 'serverTime'>;
  /** What the run wrote over and a removal puts back now (`syncRestorePlan`). */
  plan: readonly SyncRunOverwritten[];
  backups: BackupReader;
  /**
   * When the run last wrote, on this machine's clock (`SyncRunKept.lastWriteAt`):
   * a record modified after it, read on the org's clock, was changed since.
   * Absent, every record reads as changed since.
   */
  lastWriteAt?: string;
  /** Put back the records changed since the run too. */
  includeChanged: boolean;
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

/** The org's clock ahead of this machine's, in milliseconds; 0 when the org will not say. */
async function orgAheadOf(org: Pick<RemovalOrg, 'serverTime'>): Promise<number> {
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

/** One record's answer to an update, as jsforce gives it. */
interface UpdateAnswer {
  success?: boolean;
  errors?: Array<{ statusCode?: string; message?: string } | string>;
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
  let wrote = false;
  let cancelled = false;
  if (plan.length === 0) return { objects, left, wrote, cancelled };

  const runEnd = await runEndOnOrgClock(org, input.lastWriteAt);

  for (const { objectApiName, backup, ids } of plan) {
    const tally = new ObjectRestore(objectApiName, ids.length);
    objects.push(tally.result);
    if (cancelled || input.signal?.aborted) {
      cancelled = true;
      tally.result.notReached = ids.length;
      left.push(...ids);
      continue;
    }
    const object = assertSoqlIdentifier(objectApiName);
    const wanted = new Map(ids.map((id) => [recordKey(id), id]));

    // The values from before, as the run kept them: each field once, as it
    // was before the run first wrote it.
    const before = new Map<string, Record<string, unknown>>();
    try {
      const batches = await input.backups.batches(backup, objectApiName, RECORDS_PER_CALL);
      for await (const batch of batches ?? []) {
        for (const record of batch) {
          if (typeof record.Id !== 'string' || !wanted.has(recordKey(record.Id))) continue;
          const values = before.get(recordKey(record.Id)) ?? {};
          for (const [field, value] of Object.entries(record)) {
            if (field !== 'Id' && !(field in values)) values[field] = value;
          }
          before.set(recordKey(record.Id), values);
        }
      }
    } catch (err: unknown) {
      tally.reason(`The values from before the run could not be read: ${extractErrorMessage(err)}`);
      before.clear();
    }
    for (const key of [...wanted.keys()]) {
      if (before.has(key)) continue;
      tally.result.notKept++;
      wanted.delete(key);
    }
    if (wanted.size === 0) continue;

    // What the records hold now, and when they were last modified.
    const fields = new Set<string>();
    for (const values of before.values()) {
      for (const field of Object.keys(values)) fields.add(assertSoqlIdentifier(field));
    }
    const columns = ['Id', 'LastModifiedDate', ...fields];
    const perQuery = columns.length > WIDE_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
    const now = new Map<string, Record<string, unknown>>();
    try {
      for (const list of idLists([...wanted.values()], perQuery)) {
        if (input.signal?.aborted) throw new RestoreStopped();
        const answer = await org.query(
          `SELECT ${columns.join(', ')} FROM ${object} WHERE Id IN (${list})`,
        );
        for (const row of answer.records as Array<Record<string, unknown>>) {
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
    for (const [key, id] of wanted) {
      const current = now.get(key);
      if (!current) {
        tally.result.alreadyGone++;
        continue;
      }
      const modified = Date.parse(String(current.LastModifiedDate ?? ''));
      if (!(modified <= runEnd) && !input.includeChanged) {
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
        continue;
      }
      updates.push(back);
    }

    for (let at = 0; at < updates.length; at += RECORDS_PER_CALL) {
      const batch = updates.slice(at, at + RECORDS_PER_CALL);
      if (input.signal?.aborted) {
        cancelled = true;
        const rest = updates.slice(at);
        tally.result.notReached = (tally.result.notReached ?? 0) + rest.length;
        left.push(...rest.map((record) => wanted.get(recordKey(record.Id)) ?? record.Id));
        break;
      }
      let answers: UpdateAnswer[];
      try {
        wrote = true;
        answers = answersOf(await org.update(objectApiName, batch), batch.length);
      } catch (err: unknown) {
        const words = extractErrorMessage(err);
        answers = batch.map(() => ({ success: false, errors: [words] }));
      }
      answers.forEach((answer, place) => {
        const record = batch[place];
        if (answer.success === true) {
          tally.result.restored++;
          return;
        }
        const refusal = refusalOf(answer);
        if (refusal.code === 'ENTITY_IS_DELETED') {
          tally.result.alreadyGone++;
          return;
        }
        tally.result.refused++;
        tally.reason(refusal.words);
        left.push(wanted.get(recordKey(record.Id)) ?? record.Id);
      });
    }
  }
  return { objects, left, wrote, cancelled };
}

/** A stop that came while a restore read the records it puts back. */
class RestoreStopped extends Error {}

/**
 * What a removal deleted, per object, for the audit trail, with what it gave
 * back counted as updated and what the target refused it as failed, each
 * object once.
 */
export function withRestoreAudit(
  deleted: readonly AuditObjectCounts[],
  restored: readonly SyncRestoreObjectResult[],
): AuditObjectCounts[] {
  const merged = deleted.map((object) => ({ ...object }));
  for (const object of restored) {
    if (object.restored + object.refused === 0) continue;
    const entry = merged.find((counts) => counts.objectApiName === object.objectApiName);
    if (entry) {
      entry.updated += object.restored;
      entry.failed += object.refused;
    } else {
      merged.push({
        objectApiName: object.objectApiName,
        created: 0,
        updated: object.restored,
        deleted: 0,
        failed: object.refused,
      });
    }
  }
  return merged;
}
