/**
 * The preview of a rewind to a checkpoint, as the panel asks for one: what
 * the rewind would delete, give back and bring back, read from the org now;
 * what the org runs as it writes; what it would cost; and the refusal it would
 * meet before writing. Nothing is written to the org.
 *
 * The guard comes first, as for every act of a checkpoint: an org it refuses
 * — a production org, another org than the checkpoint's, a user without View
 * All Data and Modify All Data who holds no object by its own permissions —
 * is not read further, and the refusal is given as the guard words it. The
 * day's limits are read next, once, before any record: the estimate says what
 * the rewind would leave the org. A user without the two is read object by
 * object (`rewindAccess.ts`), whoever took the checkpoint: an object the user
 * no longer holds whole is not read, and could not be read, with why. Tr is
 * read on the org's clock just before the diff.
 *
 * The rewind's estimate prices the reads of its fresh diff, its convergence
 * pass and its verify from what this read found — no fresh diff for a rewind
 * that acts on this preview as read (`reusesPreview`) —, and the children it reads
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
 * refused. What sends emails and could not be read — a flow whose definition
 * the org refused, a package's, which no user reads — is named as not
 * counted, even when nothing else sends: what it sends is not known.
 * Whether the org delivers those emails at all is read once something that
 * runs may send one, with one line of anonymous Apex that sends nothing
 * (`rewindEmails.ts`), and answered beside them: where the org delivers
 * them, or would not say, the rewind is asked to send them (`acceptEmails`).
 *
 * Of a checkpoint that holds files, the files it brings back from the recycle
 * bin are held to the file storage the org has left, read with its requests:
 * a file in the bin takes none, and its undelete counts it again (P-A8), so
 * a rewind that would bring back more than is left is refused
 * (`FILE_STORAGE`) before it writes. The diff says what is left, and what the
 * files it deletes would take again, were Undo to bring them back.
 *
 * A preview of a rewind limited to some objects (`objects`) reads every
 * object all the same — the plan of a selection needs the classes of their
 * parents and children —, and answers the whole diff; its estimate, the
 * emails its writes send, the automation they fire and the refusal it would
 * meet are those of a rewind of the objects picked, the automation read on
 * every object that rewind writes to, as its own plan says
 * (`planSelection`): an object not picked among them for the children of it
 * that come back with a parent it brings back, deleted again.
 */

import {
  BYTES_PER_MB,
  removalStepsWrites,
  type CheckpointEmails,
  type CheckpointEstimate,
  type CheckpointRefusal,
  type ForgeTargetAutomation,
  type OrgCheckpoint,
  type OrgTypeAndEdition,
  type RewindDiff,
  type RewindSelectionPlan,
  type RunDeliverability,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { workedObjects } from '../dataops/RecordRemoval.js';
import { planMute } from '../forge/AutomationMuteLease.js';
import { guardCheckpoint, type CheckpointGuardConnection } from './checkpointGuard.js';
import {
  FILE_LINK_OBJECT,
  FILE_OBJECT,
  FILE_VERSION_OBJECT,
  holdsCustomSettings,
} from './checkpointScope.js';
import { compositeReader, type CompositeReader } from './compositeQueries.js';
import {
  newFolderId,
  previewDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
  type OrgLockHolder,
} from './OrgCheckpointStore.js';
import { actAccessOf } from './rewindAccess.js';
import { objectsWrittenBy, rewindStepsOf, selectionDiff } from './rewindBounds.js';
import { rewindDiff } from './rewindDiff.js';
import { diffOfPicked, planSelection, snapshotRowsOf } from './rewindPlan.js';
import { muteOfSteps, type MuteOfWrites } from './rewindOrg.js';
import {
  actDeliverability,
  checkpointEmails,
  checkpointEmailsUncounted,
  emailsRefusal,
  writtenByDiff,
} from './rewindEmails.js';
import { readEmailDeliverability } from '../forge/targetDeliverability.js';
import {
  budgetRefusal,
  fileStorageRefusal,
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
  /**
   * How the rewind's mute is planned (`RewindDeps.mute`), for a preview asked
   * with `muteAutomation`: asked of the org — what it is, whether the user may
   * assign permission sets — as the rewind asks it before it writes, nothing
   * assigned. Its refusal is the one the rewind would meet. Not given, the
   * mute is planned from the read alone, and nothing of it is refused.
   */
  mute?: MuteOfWrites;
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
  /**
   * The objects of the checkpoint a rewind would be limited to, by their API
   * names as the checkpoint holds them: see the module's comment. Absent,
   * every object.
   */
  objects?: readonly string[];
  /**
   * Whether the rewind that follows acts on this preview as it read the org
   * (`RewindRequest.reusesPreview`): the command line's, which shows the
   * preview and rewinds in the same command, and a pipeline's Rewind step,
   * which reads its own. Its estimate then counts no fresh read of the org,
   * which that rewind never makes; the panel's rewind, which reads the org
   * again, is priced with that read.
   */
  reusesPreview?: boolean;
  /**
   * Whether the rewind that follows is asked to mute the org's automation:
   * the emails it counts, those it could not count, whether the org delivers
   * them and the refusal it would meet are then those of what still runs, as
   * the rewind's own gate judges them, and a mute the org would refuse is
   * that refusal (`PreviewDeps.mute`). `automation` stays the org's as read,
   * which the mute is planned from. Nothing is assigned.
   */
  muteAutomation?: boolean;
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
      /**
       * Why the emails of what fires as it writes were not all counted: what
       * of the org's automation that sends them could not be read. Absent
       * when every one was.
       */
      emailsUncounted?: string;
      /**
       * What still runs as it writes that may send an email, and whether the
       * org delivers them, read only when something may: absent when nothing
       * sends, or it would write nothing. Not a refusal: the rewind is asked
       * to send them (`acceptEmails`), as it is asked for its automation.
       */
      deliverability?: RunDeliverability;
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

/**
 * {@link guardCheckpoint}'s view of the org: it reads the answer's records
 * and next pages, nothing else of jsforce's query.
 */
function guardConnectionOf(org: TakeOrg): CheckpointGuardConnection {
  return {
    query: (soql: string) => org.query(soql),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
  } as unknown as CheckpointGuardConnection;
}

// The objects a rewind would write to, as its bounds read them too.
export { objectsWrittenBy };

/** The files a rewind brings back from the recycle bin: on their own, or as another user's file the snapshot could not read. */
function filesBroughtBack(diff: Pick<RewindDiff, 'objects'>): number {
  const files = diff.objects.find((object) => object.objectApiName === FILE_OBJECT);
  if (files === undefined) return 0;
  const back = files.toBringBack;
  return back.inBin + back.withParent + back.deletedWhileTaken;
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
      tooling: (soql) => reader.tooling(soql),
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
  // The user the guard reads object by object, when it does.
  let userId: string | undefined;
  const guard = await guardCheckpoint(
    guardConnectionOf(org),
    {
      act: 'preview',
      orgName,
      registered: request.registered,
      username: request.username,
      organizationId: checkpoint.org.organizationId,
      customSettings: holdsCustomSettings(checkpoint),
    },
    { userId: async () => (userId = await org.userId()) },
  );
  if (!guard.allowed) return { previewed: false, refusal: guard.refusal };

  const budget = await readBudget(org, orgName);
  const kept = keepingDescribes(org, compositeReader(org, signal));
  const access = await actAccessOf({
    grants: guard.grants,
    ...(userId !== undefined ? { userId } : {}),
    username: request.username,
    checkpoint,
    reader: kept.reader,
  });
  const readAt = await org.serverTime();
  const previewId = newFolderId('pv', (deps.now ?? (() => new Date()))());
  const diff = await rewindDiff({
    checkpoint,
    folder: request.folder,
    reader: kept.reader,
    describeGlobal: kept.describeGlobal,
    previewId,
    readAt,
    queryAllFiles: guard.queryAllFiles,
    access,
    ...(signal ? { signal } : {}),
  });
  const storage = budget.fileStorage;
  if (diff.files !== undefined && storage !== undefined) {
    diff.files.storage.remaining = storage.remaining * BYTES_PER_MB;
  }

  // Of a rewind limited to some objects, what it writes, as its own plan says.
  const picked = request.objects !== undefined ? new Set(request.objects) : undefined;
  const selected = diffOfPicked(diff, picked);
  const written = objectsWrittenBy(selected);
  let plan: RewindSelectionPlan | undefined;
  if (picked !== undefined) {
    plan = await planSelection({
      checkpoint,
      previewDir: previewDirOf(request.folder, previewId),
      readAt,
      objects: picked,
      acceptOutside: false,
      heldRows: snapshotRowsOf(checkpoint, request.folder),
      ...(signal ? { signal } : {}),
    });
    for (const { objectApiName } of plan.acts) {
      if (!written.includes(objectApiName)) written.push(objectApiName);
    }
  }
  let automation: ForgeTargetAutomation | undefined;
  if (written.length > 0 && deps.readAutomation) {
    try {
      automation = await deps.readAutomation(written);
    } catch (err: unknown) {
      automation = automationUnread(written, extractErrorMessage(err));
    }
  }
  // Whether the org delivers the emails of what fires as the rewind writes,
  // read only once something that runs may send one, on the writes the
  // command line's and a pipeline's bounds judge it on: the page asks for
  // them to be accepted, and the rewind reads it again before it writes.
  let deliverability: RunDeliverability | undefined;
  let deliverabilityRequests = 0;
  const steps = rewindStepsOf(plan ? selectionDiff(diff, plan) : selected);
  const muted =
    automation && request.muteAutomation === true
      ? planMute(automation, removalStepsWrites(steps))
      : undefined;
  // A dry run that planned the mute from the read alone passed a user who
  // may not assign permission sets, whom the rewind then refused.
  const asked =
    automation && muted && muted.plan.assign.length > 0 && deps.mute
      ? await muteOfSteps(deps.mute, automation, steps)
      : undefined;
  const muteRefusal = asked && 'refusal' in asked ? asked.refusal : undefined;
  if (automation) {
    const emails = await actDeliverability({
      act: 'rewind',
      orgName,
      automation,
      steps,
      ...(muted ? { plan: muted.plan } : {}),
      accepted: false,
      mayMute: muted === undefined,
      read: () => readEmailDeliverability(org),
    });
    deliverability = emails.gate.deliverability;
    deliverabilityRequests = emails.ofRun.read?.requests ?? 0;
  }

  const read = kept.global();
  const worked = read
    ? new Set((await workedObjects({ describeGlobal: () => read })).keys())
    : undefined;
  const inCheckpoint = new Set(
    checkpoint.objects.map(({ objectApiName }) => objectApiName.toLowerCase()),
  );
  // A checkpoint that holds files holds their links and versions with them:
  // no relationship to either leads outside it, as the diff reads them.
  if (checkpoint.files !== undefined) {
    for (const held of [FILE_LINK_OBJECT, FILE_VERSION_OBJECT])
      inCheckpoint.add(held.toLowerCase());
  }
  const relationships = new Map<string, ObjectRelationships>();
  for (const [objectApiName, body] of kept.bodies) {
    relationships.set(
      objectApiName,
      relationshipsOf(body, { inCheckpoint, ...(worked ? { worked } : {}) }),
    );
  }
  const cost = rewindEstimate({
    objects: checkpoint.objects,
    diff: selected,
    automationRequests: automation?.requests ?? 0,
    ...(deliverabilityRequests > 0 ? { deliverabilityRequests } : {}),
    relationships,
    ...(request.reusesPreview === true ? { reusesPreview: true } : {}),
  });
  const estimate: CheckpointEstimate = { ...cost, apiRequestsLeft: budget.remaining };
  const records = writtenByDiff(selected.objects);
  // What still runs: a rewind that mutes sends nothing of what its bypasses
  // keep quiet, which neither counts against the day's emails nor refuses it.
  const running = muted?.automation ?? automation;
  const emails = running ? checkpointEmails(records, running, budget.emails) : [];
  const emailsUncounted = running ? checkpointEmailsUncounted(records, running) : undefined;

  const holder = deps.store.heldBy(checkpoint.org.organizationId);
  const writing = holder === undefined ? await deps.runWriting?.(guard.org.id) : undefined;
  const refusal =
    holder !== undefined
      ? lockedRefusal(orgName, holder)
      : writing !== undefined
        ? ({ code: 'RUN_WRITING', message: writing } satisfies CheckpointRefusal)
        : (muteRefusal ??
          budgetRefusal(
            'rewind',
            {
              run: cost.apiRequests - deliverabilityRequests,
              deliverability: deliverabilityRequests,
            },
            budget,
            orgName,
          ) ??
          emailsRefusal('rewind', emails, orgName) ??
          (selected.files !== undefined
            ? fileStorageRefusal(
                'rewind',
                { files: filesBroughtBack(selected), bytes: selected.files.storage.bringBack },
                storage?.remaining,
                orgName,
              )
            : undefined));
  return {
    previewed: true,
    diff,
    ...(automation ? { automation } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(emailsUncounted !== undefined ? { emailsUncounted } : {}),
    ...(deliverability ? { deliverability } : {}),
    estimate,
    ...(refusal ? { refusal } : {}),
  };
}
