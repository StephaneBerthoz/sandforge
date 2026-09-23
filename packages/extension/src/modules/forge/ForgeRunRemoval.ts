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

/** Keep a reason once, and only the first few. */
function addReason(result: ForgeUndoObjectResult, reason: string): void {
  if (!result.reasons.includes(reason) && result.reasons.length < REASON_LIMIT) {
    result.reasons.push(reason);
  }
}

/** What the org holds of one object's records now, before anything is deleted. */
interface ObjectSnapshot {
  /** Record key -> when the record was last modified, for the records still there. */
  lastModified: Map<string, number>;
  /** Why the object could not be read, when it could not. */
  error?: string;
}

/**
 * Remove from the org the records a Forge run created, one object after the
 * other in the order given — children before their parents — and say what
 * became of each.
 *
 * Nothing is deleted before every object has been read: deleting a child can
 * stamp its parent as modified (a roll-up recalculated), and a parent read
 * afterwards would look changed since the run. A record no longer in the org
 * is counted as already gone; one modified after the run ended is kept unless
 * `includeChanged` says otherwise.
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
 * @param plan - The run's records, in the order they are to be removed.
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

  /** Records of the run whose object the removal has been through. */
  const reached = new Set<string>();
  const dependents = new DependentsCheck(org, {
    runRecords,
    reached,
    stays: (key) => changed.has(key) && !options.includeChanged,
    runStart,
    runEnd,
    includeChanged: options.includeChanged,
  });

  const objects: ForgeUndoObjectResult[] = [];
  let settled = 0;
  for (const { objectApiName, ids } of plan) {
    if (stopped()) return { objects, cancelled: true };
    const result: ForgeUndoObjectResult = {
      objectApiName,
      planned: ids.length,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    };
    objects.push(result);
    const snapshot = snapshots.get(objectApiName);

    if (!snapshot || snapshot.error !== undefined) {
      result.refused = ids.length;
      addReason(result, snapshot?.error ?? 'The org gave no reason.');
      ids.forEach((id) => reached.add(recordKey(id)));
      settled += ids.length;
      options.onProgress?.(settled, total, objectApiName);
      continue;
    }

    const candidates: string[] = [];
    for (const id of ids) {
      const key = recordKey(id);
      reached.add(key);
      if (!snapshot.lastModified.has(key)) result.alreadyGone++;
      else if (changed.has(key) && !options.includeChanged) result.keptChanged++;
      else candidates.push(id);
    }

    const held = await dependents.heldAmong(objectApiName, candidates, result);
    const toDelete = candidates.filter((id) => !held.has(recordKey(id)));
    result.keptDependents = candidates.length - toDelete.length;
    settled += ids.length - toDelete.length;
    options.onProgress?.(settled, total, objectApiName);

    for (let at = 0; at < toDelete.length; at += RECORDS_PER_CALL) {
      if (stopped()) return { objects, cancelled: true };
      const batch = toDelete.slice(at, at + RECORDS_PER_CALL);
      await deleteBatch(org, objectApiName, batch, result);
      settled += batch.length;
      options.onProgress?.(settled, total, objectApiName);
    }
  }
  return { objects, cancelled: false };
}

/** Which of an object's records are still in the org, and when each was last modified. */
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

/**
 * Delete one batch and count each record: deleted, already gone — deleted
 * since it was read, often along with a parent — or refused, with the org's
 * reason. A call the org refuses whole refuses every record of it.
 */
async function deleteBatch(
  org: RemovalOrg,
  objectApiName: string,
  batch: readonly string[],
  result: ForgeUndoObjectResult,
): Promise<void> {
  let answer: unknown;
  try {
    answer = await org.destroy(objectApiName, [...batch]);
  } catch (err: unknown) {
    result.refused += batch.length;
    addReason(result, extractErrorMessage(err));
    return;
  }
  const rows = Array.isArray(answer) ? answer : [answer];
  batch.forEach((_, index) => {
    const row = deleteResultSchema.safeParse(rows[index]);
    if (row.success && row.data.success) {
      result.deleted++;
      return;
    }
    const errors = row.success ? (row.data.errors ?? []) : [];
    if (errors.some((error) => codeOf(error) === 'ENTITY_IS_DELETED')) {
      result.alreadyGone++;
      return;
    }
    result.refused++;
    addReason(result, errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.');
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
   * The keys of the records among `candidates` that a record staying in the
   * org depends on, through a relationship the org deletes along.
   *
   * Only the objects a person works with are read — queryable, createable and
   * given a page layout: an object's history, sharing rows and feed are the
   * org's own bookkeeping and go with it. An object that cannot be described
   * keeps every candidate, with the org's reason; a relationship the org does
   * not let be read by the record it depends on is named as not checked.
   *
   * @param result - Where the objects that hold records, the ones not
   *   checked, and the reasons, go.
   */
  async heldAmong(
    objectApiName: string,
    candidates: readonly string[],
    result: ForgeUndoObjectResult,
  ): Promise<Set<string>> {
    const held = new Set<string>();
    if (candidates.length === 0) return held;
    let relationships: Array<{ childSObject: string; field: string }>;
    let worked: ReadonlyMap<string, string>;
    try {
      const described = describedObjectSchema.parse(await this.org.describe(objectApiName));
      worked = await this.workedObjects();
      relationships = (described.childRelationships ?? []).filter(
        (r) => r.cascadeDelete === true && worked.has(r.childSObject),
      );
    } catch (err: unknown) {
      addReason(result, extractErrorMessage(err));
      candidates.forEach((id) => held.add(recordKey(id)));
      return held;
    }

    const holders = new Set<string>();
    for (const relationship of relationships) {
      for (let at = 0; at < candidates.length; at += RECORDS_PER_CALL) {
        const chunk = candidates.slice(at, at + RECORDS_PER_CALL);
        const holding = await this.holdingIn(relationship, chunk, result);
        if (holding.size > 0) holders.add(relationship.childSObject);
        holding.forEach((key) => held.add(key));
      }
    }
    // The objects are named, never their records: a person reads which kind
    // of record stays, the org can show which ones.
    for (const holder of holders) {
      if (!result.heldBy.includes(holder)) result.heldBy.push(holder);
    }
    return held;
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
    result: ForgeUndoObjectResult,
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
    if (!result.unchecked.includes(relationship.childSObject)) {
      result.unchecked.push(relationship.childSObject);
    }
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
