import { z } from 'zod';
import type { Connection } from 'jsforce';
import type {
  ForgeRemovalSpan,
  ForgeRunObjectRecords,
  ForgeUndoObjectResult,
} from '@sandforge/shared';
import { isPricebookEntry } from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  STATUS_LIFECYCLES,
  standardPriceIds,
  statusCategories,
  type SoqlQuery,
} from '../../core/common/platformRecords.js';
import { describedObjectSchema } from '../dataops/DataQualityScanner.js';
import type { OrgSession } from '../dataops/RecordRemoval.js';
import {
  idLists,
  orgSession,
  readRecordsById,
  RECORDS_PER_CALL,
  workedObjects,
} from '../dataops/RecordRemoval.js';

/** Reasons kept per object: an org repeats the same few. */
const REASON_LIMIT = 5;

/**
 * Rows one read of an object's dependents takes. A list that fills it may
 * hold more than were read, and every record it names is kept.
 */
const DEPENDENTS_READ_LIMIT = 2_000;

/**
 * The dates a read of dependents asks for, tried in turn, with who created
 * the record where the object keeps both dates: an object that has neither
 * `CreatedDate` nor `LastModifiedDate` may still keep a system stamp, and one
 * that keeps none is read without dates.
 */
const DEPENDENT_DATE_COLUMNS: readonly (readonly string[])[] = [
  ['CreatedDate', 'LastModifiedDate', 'CreatedById'],
  ['SystemModstamp'],
  [],
];

/**
 * Leeway on a date this machine's clock gave, once read on the org's: the
 * drift of one clock from the other between a run and its removal, and the
 * second the org rounds its dates to. A Frozen reload judges the records of a
 * load the org did not date by it too, as that load's removal will.
 */
export const CLOCK_LEEWAY_MS = 10_000;

/**
 * The code the org refuses a delete with while other records still hang from
 * the one deleted — "associated with the following opportunities", "some
 * opportunities of this account were closed won". A record refused with it is
 * tried again once the rest of the pass is gone.
 */
const DEPENDENCY_REFUSAL = 'DELETE_FAILED';

/** Key prefix of a user: the owner a file's first link names. */
const USER_KEY_PREFIX = '005';

/** Whether `value` is the id of one of the run's records. */
function isRunRecord(value: unknown, runRecords: ReadonlySet<string>): boolean {
  return typeof value === 'string' && runRecords.has(recordKey(value));
}

/**
 * The dates a snapshot of the run's records reads them by, tried in turn: when
 * each was created, which dates a run that kept no dates of its own by the
 * org's clock, and when each was last modified; or, for an object that keeps
 * no `LastModifiedDate` — a relation of an email message — its system stamp
 * alone.
 */
const SNAPSHOT_DATE_COLUMNS: readonly { created?: string; modified: string }[] = [
  { created: 'CreatedDate', modified: 'LastModifiedDate' },
  { modified: 'SystemModstamp' },
];

/**
 * A record the platform adds on its own to a record it has just written: the
 * fields that tie it to the run, read with it, and whether they do.
 */
interface PlatformAdded {
  /** The fields read with the record to tell. */
  ends: readonly string[];
  /** Whether the record came with the run, by those fields. */
  cameWithRun: (row: Record<string, unknown>, runRecords: ReadonlySet<string>) => boolean;
}

/**
 * The records the platform adds on its own to a record right after it is
 * written, which come with the run and go with it: they never hold a record
 * of the run in the org. Each is read by the ends that tie it to the run
 * rather than by its date, because the platform writes it a moment after the
 * record — after the run's last write when that record was the last — and
 * dated, it read as added since the run and held the record. Seen on a
 * sandbox, cloning a quote with its account and files, and an account alone:
 *
 * - `ContentDocumentLink`: the owner's link and the record's link to a file
 *   the run wrote, stamped a second after the file. It came with the run when
 *   it links a document the run created to one of the run's records or to a
 *   user; a link to a file from before the run is someone's since.
 * - `DuplicateRecordItem`: a duplicate rule's report that the record matches
 *   others, written up to two seconds after the record, into a set the org
 *   already held. Cloning an account alone, it came after the run's last
 *   write and held the account. It is bookkeeping about the run's record,
 *   whenever it was written: the org deletes it with the record.
 *
 * The same clone had the platform write QuoteHistory, Pricebook2History and
 * ContentDocumentHistory rows, which this check never reads (the org gives
 * them no page layout), and restamp each file's version seconds after the run,
 * which is read by its created and modified dates, both inside the run.
 */
const PLATFORM_ADDED: Readonly<Record<string, PlatformAdded>> = {
  ContentDocumentLink: {
    ends: ['ContentDocumentId', 'LinkedEntityId'],
    cameWithRun: (row, runRecords) => {
      const linked = row.LinkedEntityId;
      return (
        isRunRecord(row.ContentDocumentId, runRecords) &&
        (isRunRecord(linked, runRecords) ||
          (typeof linked === 'string' && linked.startsWith(USER_KEY_PREFIX)))
      );
    },
  },
  DuplicateRecordItem: {
    ends: ['RecordId'],
    cameWithRun: (row, runRecords) => isRunRecord(row.RecordId, runRecords),
  },
};

/** What the removal of a run's records needs from the org it wrote to. */
export type RemovalOrg = Pick<
  OrgSession,
  'query' | 'destroy' | 'describe' | 'describeGlobal' | 'update'
> & {
  /**
   * The org's clock now, as the org writes a date: the removal dates its own
   * start by it, as the org dates what the removal makes it do.
   */
  serverTime(): Promise<string>;
  /**
   * The id of the user the session writes as: what the org creates in answer
   * to the removal is created by that user.
   */
  userId(): Promise<string>;
};

/**
 * The org a removal works on, over a jsforce connection: the session the
 * cleanup work uses, and the org's clock and the session's user, which only
 * the SOAP API tells.
 *
 * @param conn - The run's target org.
 * @param context - Names the work in the API-usage warnings.
 */
export function removalOrg(conn: Connection, context: string): RemovalOrg {
  return {
    ...orgSession(conn, context),
    serverTime: async () => (await conn.soap.getServerTimestamp()).timestamp,
    userId: async () => (await conn.soap.getUserInfo()).userId,
  };
}

/**
 * How a removal of a run's records goes.
 *
 * The run's span is the target's, never this machine's: every date the
 * removal compares with it is the org's own, and against a clock a second
 * behind the org's, the records a run wrote last would read as changed since.
 * Given, it is what the run read back from the org as it ended
 * (`ForgeExecutionResult.writtenBetween`); absent — a run recorded before runs
 * kept it, or one whose dates could not all be read back — it is read from the
 * records and from when the run was recorded.
 */
export interface RunRemovalOptions {
  /**
   * The target's date of the run's first write: a record older than this did
   * not come with it. Absent, the earliest `CreatedDate` of the run's records,
   * or when the run began if that is later.
   */
  runStartedAt?: Date;
  /**
   * The target's date of the last stamp the run left: a record modified after
   * it was changed since. Absent, when the run was recorded, read on the
   * org's clock; or, with no such time, the start plus `runDurationMs`.
   */
  runEndedAt?: Date;
  /** How long the run took, for a run whose end the target did not date. */
  runDurationMs?: number;
  /**
   * When the run was recorded, on this machine's clock, right after its last
   * write: for a run the target did not date, the latest that write can have
   * been, once read on the org's clock.
   */
  runRecordedAt?: Date;
  /**
   * What earlier removals of the run wrote to records they left in the org,
   * by record id: the `LastModifiedDate` the org left on each. A record last
   * modified no later than that was not changed since the run.
   */
  removalStamps?: Readonly<Record<string, string>>;
  /**
   * When earlier removals of the run that wrote to the org ran, and as which
   * user: what that user created meanwhile is the org's answer to one of
   * them, as what the removal's user creates once it is under way is its own.
   */
  removalSpans?: readonly ForgeRemovalSpan[];
  /**
   * Delete the records the run created that were modified since it ended too,
   * and let what was added to its records since go with them.
   */
  includeChanged: boolean;
  /**
   * Stops the removal before its next call to the org, but for the calls that
   * give a status it changed for a delete back to the records it leaves, and
   * the reads of what it left on them.
   */
  signal?: AbortSignal;
  /** Told how many of the run's records are settled, after each step. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
}

/** What a removal did, object by object. */
export interface RunRemovalOutcome {
  /**
   * Per object, in the order they were removed. An object not reached is left
   * out, unless the removal could not give a status back to one of its records.
   */
  objects: ForgeUndoObjectResult[];
  /** Whether the removal was stopped before it was through. */
  cancelled: boolean;
  /**
   * The run's records the removal deleted, or found gone, by their ids as the
   * plan names them: what a caller that keeps the run's records — a Frozen
   * load's mapping — no longer has in the org.
   */
  gone: string[];
  /**
   * What this removal left on records of the run it did not delete — what it
   * wrote to them, and what the org wrote in answer to its deletes — by record
   * id: the `LastModifiedDate` the org left on each, for a later removal to
   * pass back as `removalStamps`. Only records unchanged since the run when it
   * began, and last modified by its user since it started, are named: a change
   * someone made stays a change.
   */
  stamps: Record<string, string>;
  /**
   * When this removal ran, by the org's clock, and as which user, for a later
   * removal to pass back in `removalSpans`. Absent when it wrote nothing, and
   * when the org did not tell its clock or its user.
   */
  span?: ForgeRemovalSpan;
}

/** One row of a delete's answer, or an update's. */
const writeResultSchema = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z.union([
          z
            .object({
              statusCode: z.string().optional(),
              errorCode: z.string().optional(),
              message: z.string().optional(),
            })
            .passthrough(),
          z.string(),
        ]),
      )
      .optional(),
  })
  .passthrough();

type WriteError = NonNullable<z.infer<typeof writeResultSchema>['errors']>[number];

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** The code of a write's error, whichever name the answer gave it. */
function codeOf(error: WriteError): string | undefined {
  return typeof error === 'string' ? undefined : (error.statusCode ?? error.errorCode);
}

/** One error of a write, as the org said it: `CODE: message`. */
function describeError(error: WriteError): string {
  if (typeof error === 'string') return error;
  const code = codeOf(error);
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
}

/** What the org holds of one object's records now, before anything is deleted. */
interface ObjectSnapshot {
  /** Record key -> when the record was last modified, for the records still there. */
  lastModified: Map<string, number>;
  /**
   * The column those dates were read from: `LastModifiedDate`, which the org
   * keeps with who modified the record, or `SystemModstamp`. Absent when the
   * object could not be read.
   */
  modifiedColumn?: string;
  /** The earliest `CreatedDate` among them; NaN when none could be read. */
  firstCreated: number;
  /** Why the object could not be read, when it could not. */
  error?: string;
}

/** Why the org refused to delete one record. */
interface Refusal {
  /** In the org's words. */
  reason: string;
  /** Refused for records still hanging from it: tried again once the rest of the pass is gone. */
  dependency: boolean;
}

/** Where a removal stands with one object's records. */
class ObjectRemoval {
  readonly result: ForgeUndoObjectResult;
  /** Why the object as a whole could not be read or checked. */
  private readonly notes: string[] = [];
  /** Records the org refused, by id. */
  readonly refused = new Map<string, Refusal>();
  /** Records kept because records that stay depend on them. */
  held: string[] = [];
  /** Keys of the records deleted, or found gone, once the removal reached them. */
  readonly gone = new Set<string>();

  constructor(objectApiName: string, planned: number) {
    this.result = {
      objectApiName,
      planned,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    };
  }

  /** Note why the object as a whole could not be read or checked. */
  note(reason: string): void {
    if (!this.notes.includes(reason)) this.notes.push(reason);
  }

  /**
   * The records worth another try once the rest of the pass is gone: the ones
   * refused for a dependency and the ones held by one. They keep their count
   * until they are settled again, so a removal stopped meanwhile still
   * accounts for them.
   */
  waiting(): string[] {
    return [
      ...[...this.refused].filter(([, refusal]) => refusal.dependency).map(([id]) => id),
      ...this.held,
    ];
  }

  /** The object's result, its counts and reasons as they stand. */
  settle(): ForgeUndoObjectResult {
    this.result.keptDependents = this.held.length;
    this.result.refused = this.refused.size;
    if (this.held.length === 0) this.result.heldBy = [];
    const reasons = [...this.notes, ...[...this.refused.values()].map((r) => r.reason)];
    this.result.reasons = [...new Set(reasons)].slice(0, REASON_LIMIT);
    return this.result;
  }
}

/**
 * Remove from the org the records a Forge run created, each object after the
 * objects of the run whose records point at it, and say what became of each.
 *
 * Nothing is deleted before every object has been read: deleting a child can
 * stamp its parent as modified (a roll-up recalculated), and a parent read
 * afterwards would look changed since the run. A record no longer in the org
 * is counted as already gone; one modified after the run ended is kept unless
 * `includeChanged` says otherwise. What the removal itself stamps — a refused
 * delete, a child deleted under a record — is never read as a change, because
 * that reading is the one taken before the first delete; and what it left on
 * a record it did not delete — a status given back, an amount its deleted
 * children changed — a later removal is told (`RunRemovalOutcome.stamps`),
 * with when it ran (`RunRemovalOutcome.span`), whether it ended, was stopped,
 * or was cancelled.
 *
 * An order or a contract past Draft is set to Draft before anything is
 * deleted, and one the removal leaves in the org — kept, refused, or not
 * reached when it was cancelled — gets its status back as it ends.
 *
 * The objects go in the order their records can go, not the reverse of the
 * one they were written in. A clone writes its root first and its optional
 * parents after, so reversed, the root opportunity came last: its account
 * was refused ("some opportunities of this account were closed won"), its
 * price book too ("associated with the following opportunities"), and the
 * removal ended partial with both left behind. What the org still refuses
 * for records hanging from it — a cycle no order breaks — is tried again once
 * the rest of the pass is gone, with the records held back for such a record.
 *
 * A record is also kept while records that stay in the org would be deleted
 * along with it — the org deletes what cascades from a record, and those are
 * not all the run's to take: one that was in the org before the run, one of
 * the run's own records kept here or refused by the org, and one added or
 * changed since the run unless `includeChanged` asks for what changed since
 * the run as well. What was created during the run and never touched since —
 * the contact of a person account, a task a flow opened on insert — came with
 * the run and goes with it.
 *
 * The rest are deleted {@link RECORDS_PER_CALL} at a time. A record the org
 * refuses is counted with its reason, and the rest go on; so does the next
 * object when one cannot be read at all.
 *
 * @param org - The run's target org.
 * @param plan - The run's records, children before their parents as far as
 *   the run knows — the reverse of the order it wrote them.
 * @param options - The run's time span, what earlier removals of it wrote,
 *   whether changed records go, the stop signal.
 */
export async function removeRunRecords(
  org: RemovalOrg,
  plan: readonly ForgeRunObjectRecords[],
  options: RunRemovalOptions,
): Promise<RunRemovalOutcome> {
  const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
  const stopped = (): boolean => options.signal?.aborted === true;

  const snapshots = new Map<string, ObjectSnapshot>();
  for (const { objectApiName, ids } of plan) {
    if (stopped()) return { objects: [], cancelled: true, gone: [], stamps: {} };
    snapshots.set(objectApiName, await snapshotOf(org, objectApiName, ids));
  }

  // Each object described once: the order and the dependents check read it.
  const describes = new Map<string, Promise<unknown>>();
  /** Whether the removal has asked the org to write: until then it stamped nothing. */
  let wrote = false;
  const session: RemovalOrg = {
    query: (soql) => org.query(soql),
    destroy: (objectApiName, ids) => {
      wrote = true;
      return org.destroy(objectApiName, ids);
    },
    update: (objectApiName, records) => {
      wrote = true;
      return org.update(objectApiName, records);
    },
    serverTime: () => org.serverTime(),
    userId: () => org.userId(),
    describeGlobal: () => org.describeGlobal(),
    describe: (objectApiName) => {
      let described = describes.get(objectApiName);
      if (!described) {
        described = org.describe(objectApiName);
        describes.set(objectApiName, described);
      }
      return described;
    },
  };
  const order = await removalOrder(session, plan);
  // Read before the removal's first write: what the org creates from then on,
  // as the user the removal runs as, is the removal's doing, dated by the same
  // clock as the run.
  const [clock, removalUser] = await Promise.all([removalClockOf(session), removalUserOf(session)]);

  // Every record of the run, by key; a record in the org is changed when it
  // was modified after the run ended, both by the org's clock — or after what
  // an earlier removal of the run wrote to it, which was that removal's doing.
  const runRecords = new Set(plan.flatMap((object) => object.ids.map(recordKey)));
  const { start: runStart, end: runEnd } = runSpan(options, snapshots.values(), clock.aheadMs);
  const stampedBefore = new Map(
    Object.entries(options.removalStamps ?? {}).map(([id, date]) => [recordKey(id), epochOf(date)]),
  );
  const changed = new Set<string>();
  for (const snapshot of snapshots.values()) {
    for (const [key, modified] of snapshot.lastModified) {
      // A date that cannot be read cannot show the record was left alone.
      const unchanged = modified <= runEnd || modified <= (stampedBefore.get(key) ?? Number.NaN);
      if (!unchanged) changed.add(key);
    }
  }

  /** Records of the run whose object the removal has been through. */
  const reached = new Set<string>();
  const dependents = new DependentsCheck(session, {
    runRecords,
    reached,
    stays: (key) => changed.has(key) && !options.includeChanged,
    runStart,
    runEnd,
    removalStart: clock.start,
    removalUser,
    earlierRemovals: (options.removalSpans ?? []).map((span) => ({
      start: epochOf(span.first),
      end: epochOf(span.last),
      user: recordKey(span.userId),
    })),
    includeChanged: options.includeChanged,
  });

  if (stopped()) return { objects: [], cancelled: true, gone: [], stamps: {} };
  const drafting = await backToDraft(
    session,
    dependents,
    order,
    (objectApiName, id) => {
      const key = recordKey(id);
      const snapshot = snapshots.get(objectApiName);
      return (
        snapshot?.error === undefined &&
        snapshot?.lastModified.has(key) === true &&
        !(changed.has(key) && !options.includeChanged)
      );
    },
    stopped,
  );

  const removals: ObjectRemoval[] = [];
  /**
   * The run's records the removal may have left in the org, per object: the
   * ones there and unchanged since the run when it began, read by their
   * `LastModifiedDate`, that it has not deleted or found gone since.
   */
  const leftUnchanged = (): ForgeRunObjectRecords[] => {
    const gone = new Set(removals.flatMap((removal) => [...removal.gone]));
    return order.flatMap(({ objectApiName, ids }) => {
      const snapshot = snapshots.get(objectApiName);
      if (snapshot?.modifiedColumn !== 'LastModifiedDate') return [];
      const left = ids.filter((id) => {
        const key = recordKey(id);
        return snapshot.lastModified.has(key) && !changed.has(key) && !gone.has(key);
      });
      return left.length > 0 ? [{ objectApiName, ids: left }] : [];
    });
  };
  // Every way out once a status may have been changed: what the removal leaves
  // in the org gets its status back first; then, once it has written, what it
  // left on the run's records is read, and when it ran is said, for the next
  // removal.
  const outcome = async (cancelled: boolean): Promise<RunRemovalOutcome> => {
    await putBackStatuses(session, drafting.drafted, {
      note: (objectApiName, reason, failed) => {
        let removal = removals.find((r) => r.result.objectApiName === objectApiName);
        // An object not reached is named only for a record left in Draft:
        // otherwise it is as the removal found it.
        if (!removal) {
          if (!failed) return;
          const planned = plan.find((object) => object.objectApiName === objectApiName);
          removal = new ObjectRemoval(objectApiName, planned?.ids.length ?? 0);
          removals.push(removal);
        }
        removal.note(reason);
      },
    });
    const stamps = wrote
      ? await stampsLeft(session, leftUnchanged(), { start: clock.start, user: removalUser })
      : {};
    const span = wrote ? removalSpanOf(clock, removalUser) : undefined;
    const gone = new Set(removals.flatMap((removal) => [...removal.gone]));
    return {
      objects: removals.map((removal) => removal.settle()),
      cancelled,
      gone: order.flatMap(({ ids }) => ids.filter((id) => gone.has(recordKey(id)))),
      stamps,
      ...(span ? { span } : {}),
    };
  };
  if (drafting.cancelled) return outcome(true);
  let settled = 0;
  for (const { objectApiName, ids } of order) {
    if (stopped()) return outcome(true);
    const removal = new ObjectRemoval(objectApiName, ids.length);
    removals.push(removal);
    const snapshot = snapshots.get(objectApiName);

    if (!snapshot || snapshot.error !== undefined) {
      const reason = snapshot?.error ?? 'The org gave no reason.';
      for (const id of ids) removal.refused.set(id, { reason, dependency: false });
      ids.forEach((id) => reached.add(recordKey(id)));
      settled += ids.length;
      options.onProgress?.(settled, total, objectApiName);
      continue;
    }

    const candidates: string[] = [];
    for (const id of ids) {
      const key = recordKey(id);
      reached.add(key);
      if (!snapshot.lastModified.has(key)) {
        removal.result.alreadyGone++;
        removal.gone.add(key);
      } else if (changed.has(key) && !options.includeChanged) removal.result.keptChanged++;
      else candidates.push(id);
    }
    settled += ids.length - candidates.length;

    const cancelledPart = await removeCandidates(session, dependents, removal, candidates, {
      stopped,
      onDeleted: (count) => {
        settled += count;
        options.onProgress?.(settled, total, objectApiName);
      },
      onHeld: (count) => {
        settled += count;
        options.onProgress?.(settled, total, objectApiName);
      },
    });
    if (cancelledPart) return outcome(true);
  }

  // Once the rest of the pass is gone, what waited for it — refused while
  // records still hung from it, or held by one of those — goes again, until
  // a round takes nothing more. Settled already, it is not counted twice.
  for (let progress = removals.some((r) => r.result.deleted > 0); progress; ) {
    progress = false;
    for (const removal of removals) {
      const waiting = removal.waiting();
      if (waiting.length === 0) continue;
      if (stopped()) return outcome(true);
      const deletedBefore = removal.result.deleted;
      const cancelledPart = await removeCandidates(session, dependents, removal, waiting, {
        stopped,
      });
      if (cancelledPart) return outcome(true);
      if (removal.result.deleted > deletedBefore) progress = true;
    }
  }

  for (const removal of removals) {
    if (stopped()) return outcome(true);
    await settleTakenAlong(session, removal);
  }
  return outcome(false);
}

/**
 * Count as gone the refused records the org no longer holds: a parent the
 * removal deleted took them along.
 *
 * The org deletes an email message's relations only with their message —
 * "can be updated only in a draft state", on each of them — and the removal
 * reaches the relations first, children before their parents. Their message
 * took them a call later, and the removal still said the org had refused
 * them, and that it ended partial.
 */
async function settleTakenAlong(org: RemovalOrg, removal: ObjectRemoval): Promise<void> {
  const refused = [...removal.refused.keys()];
  if (refused.length === 0) return;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await readRecordsById(org, removal.result.objectApiName, [], refused);
  } catch {
    return;
  }
  const still = new Set(rows.map((row) => recordKey(String(row.Id))));
  for (const id of refused) {
    if (still.has(recordKey(id))) continue;
    removal.refused.delete(id);
    removal.gone.add(recordKey(id));
    removal.result.alreadyGone++;
  }
}

/**
 * The plan's objects in the order their records can go: each one after every
 * other object of the plan whose records point at it, and otherwise in the
 * order given. Where objects point at each other, the order given decides,
 * and what the org refuses for it is tried again once the rest is gone.
 *
 * Read from the child relationships the org lists for each object: which
 * objects hold a lookup to it. An object the org cannot describe keeps its
 * place.
 */
async function removalOrder(
  org: RemovalOrg,
  plan: readonly ForgeRunObjectRecords[],
): Promise<ForgeRunObjectRecords[]> {
  const inPlan = new Set(plan.map((object) => object.objectApiName));
  /** Per object, the objects of the plan it points at. */
  const pointsAt = new Map<string, Set<string>>();
  for (const { objectApiName } of plan) {
    let children: string[];
    try {
      const described = describedObjectSchema.parse(await org.describe(objectApiName));
      children = (described.childRelationships ?? []).map((r) => r.childSObject);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child === objectApiName || !inPlan.has(child)) continue;
      const parents = pointsAt.get(child) ?? new Set<string>();
      parents.add(objectApiName);
      pointsAt.set(child, parents);
    }
  }
  const remaining = [...plan];
  const ordered: ForgeRunObjectRecords[] = [];
  while (remaining.length > 0) {
    const free = remaining.findIndex(
      (object) =>
        !remaining.some(
          (other) =>
            other !== object && pointsAt.get(other.objectApiName)?.has(object.objectApiName),
        ),
    );
    ordered.push(...remaining.splice(free >= 0 ? free : 0, 1));
  }
  return ordered;
}

/** A SOQL query of the org, answering its rows. */
function queryOf(org: RemovalOrg): SoqlQuery {
  return async (soql) => {
    const answer = await org.query(soql);
    return answer.records.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
  };
}

/** A record {@link backToDraft} set to Draft, and the status it had. */
interface Drafted {
  objectApiName: string;
  id: string;
  /** The Draft status it was set to. */
  draft: string;
  /** The status it had, and gets back if it stays in the org. */
  status: string;
}

/**
 * Return to a Draft status, before anything is deleted, the run's records of
 * an object with a status lifecycle — an order, a contract — that are past
 * Draft and set to go.
 *
 * An activated order keeps its products and itself from being deleted —
 * "unable to modify activated order" — and a clone now writes orders back as
 * the source held them, activated ones included. The Frozen purge learnt it
 * first. Only a record the removal means to delete is touched: one it keeps,
 * changed since the run or held for a record that stays, is left as it is. A
 * refusal here shows again, with its reason, as the delete that follows.
 *
 * Which records stay is only known once the deletes are through — an item the
 * org refuses holds its order — so each record set to Draft is handed back
 * with the status it had, for {@link putBackStatuses}. Stopped, it sets
 * nothing more.
 *
 * @param goes - Whether the record is still in the org and not kept as changed.
 */
async function backToDraft(
  org: RemovalOrg,
  dependents: DependentsCheck,
  order: readonly ForgeRunObjectRecords[],
  goes: (objectApiName: string, id: string) => boolean,
  stopped: () => boolean,
): Promise<{ drafted: Drafted[]; cancelled: boolean }> {
  const query = queryOf(org);
  const drafted: Drafted[] = [];
  for (const { objectApiName, ids } of order) {
    const lifecycle = STATUS_LIFECYCLES[objectApiName];
    if (!lifecycle) continue;
    const candidates = ids.filter((id) => goes(objectApiName, id));
    if (candidates.length === 0) continue;
    if (stopped()) return { drafted, cancelled: true };
    const categories = await statusCategories(query, lifecycle);
    if (!categories?.draft) continue;
    const draft = categories.draft;
    const { held } = await dependents.heldAmong(objectApiName, candidates);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(org, objectApiName, ['Status'], candidates);
    } catch {
      continue;
    }
    const pastDraft = rows
      .filter((row) => typeof row.Id === 'string' && !held.has(recordKey(row.Id)))
      .filter((row) => {
        const category = categories.categoryOf.get(String(row.Status));
        return category !== undefined && category !== 'Draft';
      })
      .map((row) => ({ objectApiName, id: String(row.Id), draft, status: String(row.Status) }));
    for (let at = 0; at < pastDraft.length; at += RECORDS_PER_CALL) {
      if (stopped()) return { drafted, cancelled: true };
      const batch = pastDraft.slice(at, at + RECORDS_PER_CALL);
      // Kept before the call: an update the org applied without answering is
      // put back all the same.
      drafted.push(...batch);
      try {
        await org.update(
          objectApiName,
          batch.map(({ id }) => ({ Id: id, Status: draft })),
        );
      } catch {
        // Shown again by the delete.
      }
    }
  }
  return { drafted, cancelled: false };
}

/** How {@link putBackStatuses} says what it did. */
interface PutBackHooks {
  /**
   * Say something of an object's records on its result.
   *
   * @param failed - Whether a record of it was left in Draft.
   */
  note: (objectApiName: string, reason: string, failed: boolean) => void;
}

/**
 * Give each record {@link backToDraft} set to Draft that the removal leaves in
 * the org — kept, refused, or not reached — the status it had, and say so on
 * its object, whether the org took it back or not.
 *
 * Set to Draft before any delete, an order was then held by an item the org
 * refused, or refused itself, or the removal was cancelled before its turn:
 * it stayed in the org deactivated, and nothing said so. A record the removal
 * set to Draft and someone changed since is left as they left it. What this
 * leaves on the records, a later removal is told by {@link stampsLeft}.
 */
async function putBackStatuses(
  org: RemovalOrg,
  drafted: readonly Drafted[],
  hooks: PutBackHooks,
): Promise<void> {
  const objects = [...new Set(drafted.map((record) => record.objectApiName))];
  for (const objectApiName of objects) {
    const records = drafted.filter((record) => record.objectApiName === objectApiName);
    const byKey = new Map(records.map((record) => [recordKey(record.id), record]));
    const ids = records.map((record) => record.id);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(org, objectApiName, ['Status'], ids);
    } catch (err: unknown) {
      hooks.note(
        objectApiName,
        `Status set to ${records[0].draft} for the delete, and not read back to be restored: ${extractErrorMessage(err)}`,
        true,
      );
      continue;
    }
    const inDraft = rows.flatMap((row) => {
      const record = typeof row.Id === 'string' ? byKey.get(recordKey(row.Id)) : undefined;
      return record && row.Status === record.draft ? [record] : [];
    });
    for (let at = 0; at < inDraft.length; at += RECORDS_PER_CALL) {
      const batch = inDraft.slice(at, at + RECORDS_PER_CALL);
      let answer: unknown;
      try {
        answer = await org.update(
          objectApiName,
          batch.map(({ id, status }) => ({ Id: id, Status: status })),
        );
      } catch (err: unknown) {
        answer = batch.map(() => ({ success: false, errors: [extractErrorMessage(err)] }));
      }
      const answered = Array.isArray(answer) ? answer : [answer];
      batch.forEach(({ draft, status }, index) => {
        const row = writeResultSchema.safeParse(answered[index]);
        if (row.success && row.data.success) {
          hooks.note(
            objectApiName,
            `Status set to ${draft} for the delete, then back to ${status}.`,
            false,
          );
          return;
        }
        const errors = row.success ? (row.data.errors ?? []) : [];
        const reason = errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.';
        hooks.note(
          objectApiName,
          `Status set to ${draft} for the delete, and left there: the org refused ${status} back — ${reason}`,
          true,
        );
      });
    }
  }
}

/**
 * What a removal left on the run's records it did not delete, by id: the
 * `LastModifiedDate` of each that its user last modified once it had started
 * — what a later removal reads as this one's doing, not as a change since the
 * run.
 *
 * Deleting a record's children restamps it: an opportunity's line items
 * deleted, the org recalculates its amount and dates the opportunity then, as
 * modified by whoever deleted them. Cancelled after the line items, a removal
 * left the opportunity so, and the next one read it as changed since the run
 * and kept it, and its account and price book with it. An order given its
 * status back is stamped the same way. A record someone else modified last
 * keeps their change, and so does one that had changed since the run when the
 * removal began: `records` holds only the ones that had not.
 *
 * Read {@link RECORDS_PER_CALL} at a time, and best effort: an object whose
 * records cannot be read back leaves them unstamped, and an org that did not
 * tell its clock or the removal's user leaves every record so.
 *
 * @param removal - When the removal started, by the org's clock, and the key
 *   of the user it runs as.
 */
async function stampsLeft(
  org: RemovalOrg,
  records: readonly ForgeRunObjectRecords[],
  removal: { start: number; user: string | undefined },
): Promise<Record<string, string>> {
  const stamps: Record<string, string> = {};
  const { start, user } = removal;
  if (user === undefined || !Number.isFinite(start)) return stamps;
  for (const { objectApiName, ids } of records) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(
        org,
        objectApiName,
        ['LastModifiedDate', 'LastModifiedById'],
        ids,
      );
    } catch {
      continue;
    }
    for (const row of rows) {
      if (
        typeof row.Id === 'string' &&
        typeof row.LastModifiedDate === 'string' &&
        typeof row.LastModifiedById === 'string' &&
        recordKey(row.LastModifiedById) === user &&
        epochOf(row.LastModifiedDate) >= start
      ) {
        stamps[row.Id] = row.LastModifiedDate;
      }
    }
  }
  return stamps;
}

/**
 * The batches `ids` of one object are deleted in: every custom price before
 * any standard one, which the org refuses while a custom price of its product
 * is left — `UNKNOWN_EXCEPTION` when both went in one call.
 */
async function deleteRounds(
  org: RemovalOrg,
  objectApiName: string,
  ids: string[],
): Promise<string[][]> {
  const rounds: string[][] = [];
  const cut = (list: string[]): void => {
    for (let at = 0; at < list.length; at += RECORDS_PER_CALL) {
      rounds.push(list.slice(at, at + RECORDS_PER_CALL));
    }
  };
  if (!isPricebookEntry(objectApiName) || ids.length === 0) {
    cut(ids);
    return rounds;
  }
  let standard = new Set<string>();
  try {
    standard = new Set([...(await standardPriceIds(queryOf(org), ids))].map(recordKey));
  } catch {
    // Unread, the prices go as they come: the retry takes what is refused.
  }
  cut(ids.filter((id) => !standard.has(recordKey(id))));
  cut(ids.filter((id) => standard.has(recordKey(id))));
  return rounds;
}

/** How {@link removeCandidates} reports as it goes. */
interface CandidateHooks {
  stopped: () => boolean;
  /** Records deleted, or found gone, by one call. */
  onDeleted?: (count: number) => void;
  /** Records kept for their dependents or left for the org's refusal to be read. */
  onHeld?: (count: number) => void;
}

/**
 * Settle `candidates` of one object: keep the ones records that stay depend
 * on, delete the rest, and count each in `removal`.
 *
 * @returns Whether the removal was stopped part way.
 */
async function removeCandidates(
  org: RemovalOrg,
  dependents: DependentsCheck,
  removal: ObjectRemoval,
  candidates: readonly string[],
  hooks: CandidateHooks,
): Promise<boolean> {
  const { objectApiName } = removal.result;
  const verdict = await dependents.heldAmong(objectApiName, candidates);
  if (verdict.reason !== undefined) removal.note(verdict.reason);
  for (const name of verdict.unchecked) {
    if (!removal.result.unchecked.includes(name)) removal.result.unchecked.push(name);
  }
  // Every record held before is among the candidates: the held ones are
  // settled afresh, and a record refused before and held now is held.
  removal.held = candidates.filter((id) => verdict.held.has(recordKey(id)));
  for (const id of removal.held) removal.refused.delete(id);
  // The objects are named, never their records: a person reads which kind of
  // record stays, the org can show which ones.
  removal.result.heldBy = [...verdict.holders];
  hooks.onHeld?.(removal.held.length);

  const toDelete = candidates.filter((id) => !verdict.held.has(recordKey(id)));
  for (const batch of await deleteRounds(org, objectApiName, toDelete)) {
    if (hooks.stopped()) return true;
    const outcomes = await deleteBatch(org, objectApiName, batch);
    batch.forEach((id, index) => {
      const result = outcomes[index];
      if (result.kind === 'refused') {
        removal.refused.set(id, { reason: result.reason, dependency: result.dependency });
        return;
      }
      removal.refused.delete(id);
      removal.gone.add(recordKey(id));
      if (result.kind === 'deleted') removal.result.deleted++;
      else removal.result.alreadyGone++;
    });
    hooks.onDeleted?.(batch.length);
  }
  return false;
}

/**
 * Which records of one object are still in the org, when each was last
 * modified — by its system stamp when the object keeps no modified date — and
 * when the first of them was created. An email message's relation keeps no
 * modified date: read by it alone, the object was refused whole, and the
 * removal said so of records its message took along.
 */
async function snapshotOf(
  org: RemovalOrg,
  objectApiName: string,
  ids: readonly string[],
): Promise<ObjectSnapshot> {
  let error: string | undefined;
  for (const { created, modified } of SNAPSHOT_DATE_COLUMNS) {
    try {
      const columns = created ? [created, modified] : [modified];
      const rows = await readRecordsById(org, objectApiName, columns, ids);
      const lastModified = new Map<string, number>();
      let firstCreated = Number.NaN;
      for (const row of rows) {
        if (typeof row.Id === 'string') lastModified.set(recordKey(row.Id), epochOf(row[modified]));
        if (created) firstCreated = earliest(firstCreated, epochOf(row[created]));
      }
      return { lastModified, modifiedColumn: modified, firstCreated };
    } catch (err: unknown) {
      error ??= extractErrorMessage(err);
    }
  }
  return { lastModified: new Map(), firstCreated: Number.NaN, error };
}

/** The org's clock as a removal starts. */
interface RemovalClock {
  /**
   * When the removal starts, by the org's clock, to the second: the org dates
   * what it writes to the second, so what the removal makes it write within
   * the second it started is dated to that second's start. Infinite when the
   * org did not tell its clock: nothing is then read as the removal's doing.
   */
  start: number;
  /** How far the org's clock runs ahead of this machine's; NaN when untold. */
  aheadMs: number;
}

/** The org's clock, read once, before the removal's first write. */
async function removalClockOf(org: RemovalOrg): Promise<RemovalClock> {
  const before = Date.now();
  let now = Number.NaN;
  try {
    now = epochOf(await org.serverTime());
  } catch {
    // Untold: see `RemovalClock`.
  }
  if (!Number.isFinite(now)) return { start: Number.POSITIVE_INFINITY, aheadMs: Number.NaN };
  // This machine's time halfway through the call: the org read its clock in it.
  return { start: Math.floor(now / 1000) * 1000, aheadMs: now - (before + Date.now()) / 2 };
}

/**
 * The key of the user the removal runs as. An org that does not say leaves
 * nothing read as the removal's own doing.
 */
async function removalUserOf(org: RemovalOrg): Promise<string | undefined> {
  try {
    const user = await org.userId();
    return typeof user === 'string' && user !== '' ? recordKey(user) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a removal that wrote ran, for a later one to read what the org
 * created meanwhile as its doing: from its start to the org's time as it
 * ends — this machine's time with the gap measured as it started, give or
 * take {@link CLOCK_LEEWAY_MS} — and as which user. Undefined when the org
 * did not tell its clock or its user: nothing is then read as its doing.
 */
function removalSpanOf(
  clock: RemovalClock,
  user: string | undefined,
): ForgeRemovalSpan | undefined {
  if (user === undefined || !Number.isFinite(clock.start)) return undefined;
  return {
    first: new Date(clock.start).toISOString(),
    last: new Date(Date.now() + clock.aheadMs + CLOCK_LEEWAY_MS).toISOString(),
    userId: user,
  };
}

/** The earlier of two dates, either of which may be NaN for a date not read. */
function earliest(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  return b < a ? b : a;
}

/**
 * The run's span, in the target's dates: the one given, or, for a run whose
 * dates the org did not give back, read from its records and from when it
 * was recorded.
 *
 * Recorded right after its last write, on this machine's clock, the run is
 * read on the org's with the gap between the two measured as the removal
 * starts, give or take {@link CLOCK_LEEWAY_MS}: it ended when it was recorded,
 * and began as long before as it took, or with its first record's
 * `CreatedDate` if that came later. Timed from that first record for as long
 * as the run took, the end fell after the run's last write by the whole of
 * its reading of the source, and what someone changed or added in that time
 * went with the run. And a `CreatedDate` alone cannot start it: where the
 * run's user may set audit fields, the clone writes the source's, years
 * before the run.
 *
 * Without that time, or from an org that does not tell its clock, the span
 * runs from the first record's `CreatedDate` for as long as the run took:
 * late rather than early, as the run's first write came after it started.
 *
 * @param orgAheadMs - How far the org's clock runs ahead of this machine's.
 */
function runSpan(
  options: Pick<
    RunRemovalOptions,
    'runStartedAt' | 'runEndedAt' | 'runDurationMs' | 'runRecordedAt'
  >,
  snapshots: Iterable<ObjectSnapshot>,
  orgAheadMs: number,
): { start: number; end: number } {
  let firstCreated = Number.NaN;
  for (const snapshot of snapshots) firstCreated = earliest(firstCreated, snapshot.firstCreated);
  const duration = options.runDurationMs ?? 0;
  const recordedOnOrg = (options.runRecordedAt?.getTime() ?? Number.NaN) + orgAheadMs;
  if (options.runEndedAt === undefined && Number.isFinite(recordedOnOrg)) {
    const began = recordedOnOrg - duration - CLOCK_LEEWAY_MS;
    return {
      start: options.runStartedAt?.getTime() ?? (firstCreated > began ? firstCreated : began),
      end: recordedOnOrg + CLOCK_LEEWAY_MS,
    };
  }
  const start = options.runStartedAt?.getTime() ?? firstCreated;
  const end = options.runEndedAt?.getTime() ?? start + duration;
  return { start, end };
}

/** What a delete did to one record. */
type DeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | { kind: 'refused'; reason: string; dependency: boolean };

/**
 * Delete one batch and say what became of each record: deleted, already gone
 * — deleted since it was read, often along with a parent — or refused, with
 * the org's reason. A call the org refuses whole refuses every record of it.
 */
async function deleteBatch(
  org: RemovalOrg,
  objectApiName: string,
  batch: readonly string[],
): Promise<DeleteOutcome[]> {
  let answer: unknown;
  try {
    answer = await org.destroy(objectApiName, [...batch]);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  const rows = Array.isArray(answer) ? answer : [answer];
  return batch.map((_, index): DeleteOutcome => {
    const row = writeResultSchema.safeParse(rows[index]);
    if (row.success && row.data.success) return { kind: 'deleted' };
    const errors = row.success ? (row.data.errors ?? []) : [];
    if (errors.some((error) => codeOf(error) === 'ENTITY_IS_DELETED')) return { kind: 'gone' };
    return {
      kind: 'refused',
      reason: errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.',
      dependency: errors.some((error) => codeOf(error) === DEPENDENCY_REFUSAL),
    };
  });
}

/** What the dependents check knows of the removal under way. */
interface DependentsContext {
  /** Keys of every record the run created. */
  runRecords: ReadonlySet<string>;
  /** Keys of the run's records whose object has been through the removal. */
  reached: ReadonlySet<string>;
  /** Whether a run record not reached yet is one the removal will keep. */
  stays: (key: string) => boolean;
  runStart: number;
  runEnd: number;
  /**
   * When this removal started, by the org's clock: what its user created
   * after it is its own doing. Infinite when the org did not tell.
   */
  removalStart: number;
  /** The key of the user the removal runs as; undefined when the org did not tell. */
  removalUser: string | undefined;
  /**
   * When earlier removals of the run ran, by the org's clock, and the key of
   * the user each ran as: what that user created meanwhile was their doing.
   */
  earlierRemovals: ReadonlyArray<{ start: number; end: number; user: string }>;
  /** Whether what changed since the run, and what was added since, goes too. */
  includeChanged: boolean;
}

/** What {@link DependentsCheck.heldAmong} found for some records of one object. */
interface HeldVerdict {
  /** Keys of the records that records staying in the org depend on. */
  held: Set<string>;
  /** The objects whose staying records hold them, by API name. */
  holders: Set<string>;
  /** Relationships the org deletes along that could not be read by the record, by child object. */
  unchecked: Set<string>;
  /** Why the object's relationships could not be read at all; every record is then held. */
  reason?: string;
}

/**
 * Finds, among records about to be deleted, the ones records that stay in the
 * org hang from: the children the org would delete along with them.
 */
class DependentsCheck {
  private worked?: Promise<ReadonlyMap<string, string>>;

  constructor(
    private readonly org: RemovalOrg,
    private readonly context: DependentsContext,
  ) {}

  /**
   * The records among `candidates` that a record staying in the org depends
   * on, through a relationship the org deletes along.
   *
   * Only the objects a person works with are read — queryable, createable and
   * given a page layout: an object's history, sharing rows and feed are the
   * org's own bookkeeping and go with it. An object that cannot be described
   * keeps every candidate, with the org's reason; a relationship the org does
   * not let be read by the record it depends on is named as not checked.
   */
  async heldAmong(objectApiName: string, candidates: readonly string[]): Promise<HeldVerdict> {
    const verdict: HeldVerdict = { held: new Set(), holders: new Set(), unchecked: new Set() };
    if (candidates.length === 0) return verdict;
    let relationships: Array<{ childSObject: string; field: string }>;
    try {
      const described = describedObjectSchema.parse(await this.org.describe(objectApiName));
      const worked = await this.workedObjects();
      relationships = (described.childRelationships ?? []).filter(
        (r) => r.cascadeDelete === true && worked.has(r.childSObject),
      );
    } catch (err: unknown) {
      verdict.reason = extractErrorMessage(err);
      candidates.forEach((id) => verdict.held.add(recordKey(id)));
      return verdict;
    }

    for (const relationship of relationships) {
      for (let at = 0; at < candidates.length; at += RECORDS_PER_CALL) {
        const chunk = candidates.slice(at, at + RECORDS_PER_CALL);
        const holding = await this.holdingIn(relationship, chunk, verdict);
        if (holding.size > 0) verdict.holders.add(relationship.childSObject);
        holding.forEach((key) => verdict.held.add(key));
      }
    }
    return verdict;
  }

  /**
   * The keys of the records of `chunk` that a record of this relationship,
   * staying, depends on.
   *
   * Read with the dates that tell whether a record came with the run, where
   * the object has them. A real org answers three ways: most objects keep
   * `CreatedDate` and `LastModifiedDate`; a file's link to a record
   * (ContentDocumentLink) keeps only `SystemModstamp`; and a member of a sales
   * engagement list (ActionableListMember) cannot be read by the record it
   * points at at all. A record read without any date is taken to stay; a
   * relationship that cannot be read holds nothing and is named as not
   * checked, or no record with such a relationship could ever be removed.
   */
  private async holdingIn(
    relationship: { childSObject: string; field: string },
    chunk: readonly string[],
    verdict: HeldVerdict,
  ): Promise<Set<string>> {
    const child = assertSoqlIdentifier(relationship.childSObject);
    const field = assertSoqlIdentifier(relationship.field);
    const [list] = idLists(chunk, chunk.length);
    // A record the platform adds is read with the ends that tie it to the
    // run, whichever one the relationship follows: see `PLATFORM_ADDED`.
    const columns = new Set(['Id', field, ...(PLATFORM_ADDED[child]?.ends ?? [])]);
    for (const dates of DEPENDENT_DATE_COLUMNS) {
      let answer: { records: unknown[] };
      try {
        answer = await this.org.query(
          `SELECT ${[...columns, ...dates].join(', ')} FROM ${child} ` +
            `WHERE ${field} IN (${list}) LIMIT ${DEPENDENTS_READ_LIMIT}`,
        );
      } catch {
        continue;
      }
      // A read that filled its limit may hold more than it read: every
      // record of the chunk is kept rather than guessed about.
      if (answer.records.length >= DEPENDENTS_READ_LIMIT) return new Set(chunk.map(recordKey));
      const holding = new Set<string>();
      for (const record of answer.records) {
        if (typeof record !== 'object' || record === null) continue;
        const row = record as Record<string, unknown>;
        const parent = row[relationship.field];
        if (typeof parent === 'string' && typeof row.Id === 'string' && this.stays(row, child)) {
          holding.add(recordKey(parent));
        }
      }
      return holding;
    }
    verdict.unchecked.add(relationship.childSObject);
    return new Set();
  }

  /**
   * Whether a dependent record stays in the org once the removal is through.
   *
   * One of the run's own stays when its object has been through the removal
   * and it is still there — kept, or refused — or when the removal will keep
   * it. Any other record read with its dates:
   *
   * - one from before the run always stays: the run never made it, someone
   *   moved it under a record the run did;
   * - one created while the run went and not modified since came with the
   *   run — a person account's contact, a task a flow opened on insert — and
   *   goes with it;
   * - one added or modified since the run stays, unless the request includes
   *   what changed since the run. Editing a cloned record adds records of its
   *   own — a tracked change in its feed — and a request that asks for the
   *   changed records back out means those too.
   *
   * What the platform adds on its own to a record of the run comes with the
   * run, whatever its date: see `PLATFORM_ADDED`; and what the user a removal
   * of the run ran as created while it went — this one, or an earlier one —
   * is that removal's doing. An object that keeps no created and modified
   * dates is read by its system stamp; one that keeps no date at all stays.
   *
   * @param object - The record's object.
   */
  private stays(row: Record<string, unknown>, object: string): boolean {
    const key = recordKey(row.Id as string);
    const {
      runRecords,
      reached,
      runStart,
      runEnd,
      removalStart,
      removalUser,
      earlierRemovals,
      includeChanged,
    } = this.context;
    if (runRecords.has(key)) return reached.has(key) || this.context.stays(key);
    if (PLATFORM_ADDED[object]?.cameWithRun(row, runRecords)) return false;
    const dated =
      'CreatedDate' in row ? 'CreatedDate' : 'SystemModstamp' in row ? 'SystemModstamp' : undefined;
    if (!dated) return true;
    const created = epochOf(row[dated]);
    const modified = epochOf(dated === 'CreatedDate' ? row.LastModifiedDate : row.SystemModstamp);
    // A date that cannot be read cannot show the record came with the run.
    if (!(created >= runStart)) return true;
    // Created once this removal was under way, by the user it runs as: the
    // org answering what the removal did. Deleting an opportunity's line
    // items changes its amount, and feed tracking records the change on the
    // opportunity — which, read as added since the run, kept the opportunity,
    // and its account and price book behind it. So does what the org created
    // while an earlier removal of the run went, as the user it ran as: one
    // cancelled right after the line items left that tracked change, and on a
    // sandbox the next removal kept the opportunity for it. A record someone
    // else created meanwhile — a colleague's task, an integration's contact —
    // is theirs: taken for the removal's, it went with its parent, unreported.
    const creator = typeof row.CreatedById === 'string' ? recordKey(row.CreatedById) : undefined;
    const byRemoval =
      creator !== undefined &&
      ((creator === removalUser && created >= removalStart) ||
        earlierRemovals.some(
          (earlier) =>
            creator === earlier.user && created >= earlier.start && created <= earlier.end,
        ));
    if (byRemoval) return false;
    if (modified <= runEnd) return false;
    return !includeChanged;
  }

  /** The org's objects a person works with, read once per removal. */
  private workedObjects(): Promise<ReadonlyMap<string, string>> {
    this.worked ??= workedObjects(this.org);
    return this.worked;
  }
}
