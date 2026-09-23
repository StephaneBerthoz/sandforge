import { z } from 'zod';
import type { ForgeRunObjectRecords, ForgeUndoObjectResult } from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { describedObjectSchema } from '../dataops/DataQualityScanner.js';
import type { OrgSession } from '../dataops/RecordRemoval.js';
import {
  idLists,
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
 * The dates a read of dependents asks for, tried in turn: an object that has
 * neither `CreatedDate` nor `LastModifiedDate` may still keep a system stamp,
 * and one that keeps none is read without dates.
 */
const DEPENDENT_DATE_COLUMNS: readonly (readonly string[])[] = [
  ['CreatedDate', 'LastModifiedDate'],
  ['SystemModstamp'],
  [],
];

/**
 * The code the org refuses a delete with while other records still hang from
 * the one deleted — "associated with the following opportunities", "some
 * opportunities of this account were closed won". A record refused with it is
 * tried again once the rest of the pass is gone.
 */
const DEPENDENCY_REFUSAL = 'DELETE_FAILED';

/** What the removal of a run's records needs from the org it wrote to. */
export type RemovalOrg = Pick<OrgSession, 'query' | 'destroy' | 'describe' | 'describeGlobal'>;

/** How a removal of a run's records goes. */
export interface RunRemovalOptions {
  /** When the run started: a record older than this did not come with it. */
  runStartedAt: Date;
  /** When the run ended: a record modified after it was changed since. */
  runEndedAt: Date;
  /**
   * Delete the records the run created that were modified since it ended too,
   * and let what was added to its records since go with them.
   */
  includeChanged: boolean;
  /** Stops the removal before its next call to the org. */
  signal?: AbortSignal;
  /** Told how many of the run's records are settled, after each step. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
}

/** What a removal did, object by object. */
export interface RunRemovalOutcome {
  /** Per object, in the order they were removed; an object not reached is left out. */
  objects: ForgeUndoObjectResult[];
  /** Whether the removal was stopped before it was through. */
  cancelled: boolean;
}

/** One row of a delete's answer. */
const deleteResultSchema = z
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

type DeleteError = NonNullable<z.infer<typeof deleteResultSchema>['errors']>[number];

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** The code of a delete's error, whichever name the answer gave it. */
function codeOf(error: DeleteError): string | undefined {
  return typeof error === 'string' ? undefined : (error.statusCode ?? error.errorCode);
}

/** One error of a delete, as the org said it: `CODE: message`. */
function describeError(error: DeleteError): string {
  if (typeof error === 'string') return error;
  const code = codeOf(error);
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
}

/** What the org holds of one object's records now, before anything is deleted. */
interface ObjectSnapshot {
  /** Record key -> when the record was last modified, for the records still there. */
  lastModified: Map<string, number>;
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
 * that reading is the one taken before the first delete.
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
 * @param options - The run's time span, whether changed records go, the stop signal.
 */
export async function removeRunRecords(
  org: RemovalOrg,
  plan: readonly ForgeRunObjectRecords[],
  options: RunRemovalOptions,
): Promise<RunRemovalOutcome> {
  const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
  const runEnd = options.runEndedAt.getTime();
  const runStart = options.runStartedAt.getTime();
  const stopped = (): boolean => options.signal?.aborted === true;

  // Every record of the run, by key; a record in the org is changed when it
  // was modified after the run ended.
  const runRecords = new Set(plan.flatMap((object) => object.ids.map(recordKey)));
  const changed = new Set<string>();
  const snapshots = new Map<string, ObjectSnapshot>();
  for (const { objectApiName, ids } of plan) {
    if (stopped()) return { objects: [], cancelled: true };
    snapshots.set(objectApiName, await snapshotOf(org, objectApiName, ids));
  }
  for (const snapshot of snapshots.values()) {
    for (const [key, modified] of snapshot.lastModified) {
      // A date that cannot be read cannot show the record was left alone.
      if (!(modified <= runEnd)) changed.add(key);
    }
  }

  // Each object described once: the order and the dependents check read it.
  const describes = new Map<string, Promise<unknown>>();
  const session: RemovalOrg = {
    query: (soql) => org.query(soql),
    destroy: (objectApiName, ids) => org.destroy(objectApiName, ids),
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

  /** Records of the run whose object the removal has been through. */
  const reached = new Set<string>();
  const dependents = new DependentsCheck(session, {
    runRecords,
    reached,
    stays: (key) => changed.has(key) && !options.includeChanged,
    runStart,
    runEnd,
    includeChanged: options.includeChanged,
  });

  const removals: ObjectRemoval[] = [];
  const outcome = (cancelled: boolean): RunRemovalOutcome => ({
    objects: removals.map((removal) => removal.settle()),
    cancelled,
  });
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
      if (!snapshot.lastModified.has(key)) removal.result.alreadyGone++;
      else if (changed.has(key) && !options.includeChanged) removal.result.keptChanged++;
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
  return outcome(false);
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
  for (let at = 0; at < toDelete.length; at += RECORDS_PER_CALL) {
    if (hooks.stopped()) return true;
    const batch = toDelete.slice(at, at + RECORDS_PER_CALL);
    const outcomes = await deleteBatch(org, objectApiName, batch);
    batch.forEach((id, index) => {
      const result = outcomes[index];
      if (result.kind === 'refused') {
        removal.refused.set(id, { reason: result.reason, dependency: result.dependency });
        return;
      }
      removal.refused.delete(id);
      if (result.kind === 'deleted') removal.result.deleted++;
      else removal.result.alreadyGone++;
    });
    hooks.onDeleted?.(batch.length);
  }
  return false;
}

/** Which records of one object are still in the org, and when each was last modified. */
async function snapshotOf(
  org: RemovalOrg,
  objectApiName: string,
  ids: readonly string[],
): Promise<ObjectSnapshot> {
  try {
    const rows = await readRecordsById(org, objectApiName, ['LastModifiedDate'], ids);
    const lastModified = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.Id === 'string') {
        lastModified.set(recordKey(row.Id), epochOf(row.LastModifiedDate));
      }
    }
    return { lastModified };
  } catch (err: unknown) {
    return { lastModified: new Map(), error: extractErrorMessage(err) };
  }
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
    const row = deleteResultSchema.safeParse(rows[index]);
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
    for (const dates of DEPENDENT_DATE_COLUMNS) {
      let answer: { records: unknown[] };
      try {
        answer = await this.org.query(
          `SELECT ${['Id', field, ...dates].join(', ')} FROM ${child} ` +
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
        if (typeof parent === 'string' && typeof row.Id === 'string' && this.stays(row)) {
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
   *   own — a tracked change in its feed, the duplicate rule's match — and a
   *   request that asks for the changed records back out means those too.
   *
   * An object that keeps no created and modified dates is read by its system
   * stamp; one that keeps no date at all stays.
   */
  private stays(row: Record<string, unknown>): boolean {
    const key = recordKey(row.Id as string);
    const { runRecords, reached, runStart, runEnd, includeChanged } = this.context;
    if (runRecords.has(key)) return reached.has(key) || this.context.stays(key);
    const dated =
      'CreatedDate' in row ? 'CreatedDate' : 'SystemModstamp' in row ? 'SystemModstamp' : undefined;
    if (!dated) return true;
    const created = epochOf(row[dated]);
    const modified = epochOf(dated === 'CreatedDate' ? row.LastModifiedDate : row.SystemModstamp);
    // A date that cannot be read cannot show the record came with the run.
    if (!(created >= runStart)) return true;
    if (modified <= runEnd) return false;
    return !includeChanged;
  }

  /** The org's objects a person works with, read once per removal. */
  private workedObjects(): Promise<ReadonlyMap<string, string>> {
    this.worked ??= workedObjects(this.org);
    return this.worked;
  }
}
