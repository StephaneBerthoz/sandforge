/**
 * The preview of a rewind to a checkpoint, as the panel asks for one: what
 * the rewind would delete, give back and bring back, read from the org now;
 * what the org runs as it writes; what it would cost; and the refusal it would
 * meet before writing. Nothing is written to the org.
 *
 * The guard comes first, as for every act of a checkpoint: an org it refuses
 * — a production org, another org than the checkpoint's, a user without View
 * All Data and Modify All Data — is not read further, and the refusal is
 * given as the guard words it. The day's limits are read next, once, before
 * any record: the estimate says what the rewind would leave the org. Tr is
 * read on the org's clock just before the diff.
 *
 * The rewind's estimate prices the reads of its fresh diff, its convergence
 * pass and its verify from what this read found, and the children it reads
 * through each relationship from the describes this read already made: they
 * are kept as the diff reads them, never asked twice. The global describe the
 * diff reads, when its deletions reach outside the checkpoint, tells which of
 * those relationships lead to an object a person works in.
 *
 * What the org runs is read only when the rewind would write something, on
 * every object it would delete records of, give values back to or bring
 * records back to. A read of it that fails is said in its answer, as a part
 * of it left unread, and the diff is answered all the same: the rewind reads
 * it again before it writes, and refuses without it. The emails it sends as
 * the rewind writes are counted against the daily limits the org has left,
 * read with its requests (`rewindEmails.ts`): past them, the rewind is
 * refused.
 */

import type {
  CheckpointEmails,
  CheckpointEstimate,
  CheckpointRefusal,
  ForgeTargetAutomation,
  OrgCheckpoint,
  OrgTypeAndEdition,
  RewindDiff,
  RewindDiffObject,
} from '@sandforge/shared';
import type { Connection } from 'jsforce';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { workedObjects } from '../dataops/RecordRemoval.js';
import { guardCheckpoint } from './checkpointGuard.js';
import { compositeReader, type CompositeReader } from './compositeQueries.js';
import {
  newFolderId,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLockHolder,
} from './OrgCheckpointStore.js';
import { rewindDiff } from './rewindDiff.js';
import { checkpointEmails, emailsRefusal, writtenByDiff } from './rewindEmails.js';
import {
  budgetRefusal,
  readBudget,
  relationshipsOf,
  rewindEstimate,
  type ObjectRelationships,
} from './rewindEstimate.js';
import type { TakeOrg } from './takeCheckpoint.js';

/** What a preview works with. */
export interface PreviewDeps {
  /** The org, as a take reads it: queries and describes, its global describe and its clock. */
  org: TakeOrg;
  /** The store the checkpoint is kept in: who holds the org's lock now. */
  store: Pick<OrgCheckpointStore, 'heldBy'>;
  /**
   * What the org runs as records of `objects` are updated, deleted or
   * brought back. Not given, nothing of it is read.
   */
  readAutomation?: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /**
   * What else of this machine is writing to the org, said as a refusal names
   * it, or nothing: a rewind would be refused while it writes.
   */
  runWriting?: (organizationId: string) => Promise<string | undefined> | string | undefined;
  /** Stops the reads between two pages, two calls or two objects. */
  signal?: AbortSignal;
  /** This machine's clock: the preview's id. */
  now?: () => Date;
}

/** What a preview is asked. */
export interface PreviewRequest {
  checkpoint: OrgCheckpoint;
  /** The checkpoint's folder: its snapshot, index and bin, and where the preview keeps its reads. */
  folder: CheckpointFolder;
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none, which the guard refuses. */
  registered: OrgTypeAndEdition | undefined;
  /** The user SandForge connects as. */
  username: string;
}

/** How a preview ended, when it was not stopped and did not fail. */
export type PreviewOutcome =
  | {
      previewed: true;
      diff: RewindDiff;
      /** Absent when the rewind would write nothing. */
      automation?: ForgeTargetAutomation;
      /** The emails its writes make the org send, per daily limit; absent when none. */
      emails?: CheckpointEmails[];
      estimate: CheckpointEstimate;
      /** The refusal the rewind would meet before writing, when it would meet one. */
      refusal?: CheckpointRefusal;
    }
  | { previewed: false; refusal: CheckpointRefusal };

/** What a rewind did not do, as each refusal it would meet ends. */
const NOTHING_WRITTEN = 'No record would be read or written.';

/** The refusal a rewind would meet while a take, another rewind or an undo of the org holds its lock. */
function lockedRefusal(orgName: string, holder: OrgLockHolder): CheckpointRefusal {
  const what =
    holder.operation === 'take'
      ? `A checkpoint of ${orgName} is being taken`
      : holder.operation === 'rewind'
        ? `A rewind is writing to ${orgName}`
        : holder.operation === 'undo'
          ? `An undo is writing to ${orgName}`
          : `SandForge is deleting checkpoints of ${orgName}`;
  return {
    code: 'RUN_WRITING',
    message: `${what} (process ${holder.pid} on ${holder.host}): rewind once it has ended. ${NOTHING_WRITTEN}`,
  };
}

/** {@link guardCheckpoint}'s view of the org: it reads the answer's records, nothing else of jsforce's query. */
function guardConnectionOf(org: TakeOrg): Pick<Connection, 'query'> {
  return { query: (soql: string) => org.query(soql) } as unknown as Pick<Connection, 'query'>;
}

/**
 * The objects a rewind would write to: records to delete, to give values
 * back, to bring back, or to make again, and records it brings back for a
 * moment to delete again — counted in none of those, but written twice: the
 * rewind reads what runs on their object, and refuses it unaccepted.
 */
export function objectsWrittenBy(diff: Pick<RewindDiff, 'objects'>): string[] {
  const writes = (object: RewindDiffObject): boolean =>
    object.toDelete.createdSince +
      object.toDelete.broughtBackSince +
      object.toDelete.comesBackWithParent +
      object.toGiveBack.records +
      object.toBringBack.inBin +
      object.toBringBack.withParent +
      object.toBringBack.deletedWhileTaken +
      (object.toBringBack.carriers ?? 0) +
      (object.toRecreate ?? 0) >
    0;
  return diff.objects.filter(writes).map((object) => object.objectApiName);
}

/** What a read of the org's automation that failed answers: each part it reads left unread, and why. */
function automationUnread(objects: readonly string[], reason: string): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [],
    unread: (['flows', 'triggers', 'processes', 'workflowRules'] as const).map((part) => ({
      part,
      reason,
    })),
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
  };
}

/**
 * A reader that keeps every describe it is answered in full, by object, and
 * the org's global describe once read: the relationships the estimate counts.
 */
function keepingDescribes(
  org: TakeOrg,
  reader: CompositeReader,
): {
  reader: CompositeReader;
  describeGlobal: () => Promise<unknown>;
  bodies: Map<string, unknown>;
  global: () => Promise<unknown> | undefined;
} {
  const bodies = new Map<string, unknown>();
  let global: Promise<unknown> | undefined;
  return {
    bodies,
    global: () => global,
    describeGlobal: () => (global ??= org.describeGlobal()),
    reader: {
      lane: () => reader.lane(),
      calls: () => reader.calls(),
      describe: async (objectApiName, modifiedSince) => {
        const answer = await reader.describe(objectApiName, modifiedSince);
        if ('body' in answer) bodies.set(objectApiName, answer.body);
        return answer;
      },
    },
  };
}

/**
 * Preview a rewind to a checkpoint: see the module's comment.
 *
 * @returns What the rewind would do, cost and meet; or the guard's refusal,
 *   with nothing read but what the guard asked.
 * @throws {OrgReadStopped} When it was stopped.
 * @throws When a read failed, or the org did not say what it has left today.
 */
export async function previewCheckpoint(
  deps: PreviewDeps,
  request: PreviewRequest,
): Promise<PreviewOutcome> {
  const { org, signal } = deps;
  const { checkpoint, orgName } = request;
  const guard = await guardCheckpoint(guardConnectionOf(org), {
    act: 'preview',
    orgName,
    registered: request.registered,
    username: request.username,
    organizationId: checkpoint.org.organizationId,
  });
  if (!guard.allowed) return { previewed: false, refusal: guard.refusal };

  const budget = await readBudget(org, orgName);
  const readAt = await org.serverTime();
  const previewId = newFolderId('pv', (deps.now ?? (() => new Date()))());
  const kept = keepingDescribes(org, compositeReader(org, signal));
  const diff = await rewindDiff({
    checkpoint,
    folder: request.folder,
    reader: kept.reader,
    describeGlobal: kept.describeGlobal,
    previewId,
    readAt,
    ...(signal ? { signal } : {}),
  });

  const written = objectsWrittenBy(diff);
  let automation: ForgeTargetAutomation | undefined;
  if (written.length > 0 && deps.readAutomation) {
    try {
      automation = await deps.readAutomation(written);
    } catch (err: unknown) {
      automation = automationUnread(written, extractErrorMessage(err));
    }
  }

  const read = kept.global();
  const worked = read
    ? new Set((await workedObjects({ describeGlobal: () => read })).keys())
    : undefined;
  const inCheckpoint = new Set(
    checkpoint.objects.map(({ objectApiName }) => objectApiName.toLowerCase()),
  );
  const relationships = new Map<string, ObjectRelationships>();
  for (const [objectApiName, body] of kept.bodies) {
    relationships.set(
      objectApiName,
      relationshipsOf(body, { inCheckpoint, ...(worked ? { worked } : {}) }),
    );
  }
  const cost = rewindEstimate({
    objects: checkpoint.objects,
    diff,
    automationRequests: automation?.requests ?? 0,
    relationships,
  });
  const estimate: CheckpointEstimate = { ...cost, apiRequestsLeft: budget.remaining };
  const emails = automation
    ? checkpointEmails(writtenByDiff(diff.objects), automation, budget.emails)
    : [];

  const holder = deps.store.heldBy(checkpoint.org.organizationId);
  const writing = holder === undefined ? await deps.runWriting?.(guard.org.id) : undefined;
  const refusal =
    holder !== undefined
      ? lockedRefusal(orgName, holder)
      : writing !== undefined
        ? ({ code: 'RUN_WRITING', message: writing } satisfies CheckpointRefusal)
        : (budgetRefusal('rewind', cost.apiRequests, budget, orgName) ??
          emailsRefusal('rewind', emails, orgName));
  return {
    previewed: true,
    diff,
    ...(automation ? { automation } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    estimate,
    ...(refusal ? { refusal } : {}),
  };
}
