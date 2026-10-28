/**
 * The undo of a rewind, as the panel and the command line ask for one: the
 * guards and gates a rewind passes before it writes, then the undo itself
 * (`undoRewind`), and the checkpoint told it was undone.
 *
 * `undoRewind` takes the rewind back from its journal and nothing else: it
 * neither guards the org nor takes its lock. Here, nothing is read before the
 * guard has said the org is no production org, is the checkpoint's own and
 * lets its user see and put back every record; and nothing is written before
 * the org's lock is held, for the undo's whole length, no SandForge run of
 * this machine writes to the org, what the undo's writes fire was accepted,
 * the day's requests are enough, and the emails its writes make the org send
 * fit what it has left of each daily limit (`rewindEmails.ts`). Each refusal
 * names why, and writes nothing.
 *
 * What the undo writes is what the rewind's journal says it did, read before
 * the gates: what it deleted comes back from the recycle bin, what it wrote
 * over gets its values back, what it brought back goes back to the bin, and
 * so does what it made again, which the result names apart. Those objects'
 * automation is read as a rewind reads it, undeletes included.
 *
 * Once through, a record it gave back that differs again from its values
 * from before the rewind is named by who last changed it: the user it writes
 * as and the org's Automated Process are its own — automation that set the
 * field again on save —, anyone else changed it during the undo, which makes
 * it unstable. An undo that went through, part way or whole, marks the
 * checkpoint's last rewind undone (`lastRewind.undoneAt`): the list no
 * longer offers it, and the next rewind of the checkpoint starts a journal of
 * its own. One stopped part way, or that took nothing back, leaves the mark
 * off, and is offered again: the next undo takes up what this one left.
 */

import type { Connection } from 'jsforce';
import {
  blindedBy,
  firedOnRemovalStepsOf,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type OrgCheckpoint,
  type OrgTypeAndEdition,
  type RewindResidual,
  type RewindResult,
  type RewindStatus,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { RunRemovalOptions } from '../forge/ForgeRunRemoval.js';
import type { UndeleteCall } from '../sync/SyncRunUndelete.js';
import { guardCheckpoint } from './checkpointGuard.js';
import type { CheckpointFolder, OrgCheckpointStore, OrgLockHolder } from './OrgCheckpointStore.js';
import { checkpointEmails, emailsRefusal, writtenByUndo } from './rewindEmails.js';
import { budgetRefusal, readBudget, undoEstimate } from './rewindEstimate.js';
import { rewoundObjects, undoPlansOf } from './rewindJournal.js';
import { automationUnread, counted, type RewindOrg } from './rewindOrg.js';
import { rewindWriters } from './rewindPlan.js';
import { undoRewind, type UndoResidual, type UndoRewindOutcome } from './undoRewind.js';

/** How far an undo is. */
export interface UndoProgress {
  percentage: number;
  step: string;
}

/** What an undo works with. */
export interface UndoCheckpointDeps {
  /** The org, as a rewind reads and writes it. */
  org: RewindOrg;
  /** Takes records out of the recycle bin by their ids (`conn.soap.undelete`). */
  undelete: UndeleteCall;
  /** The store the checkpoint is kept in: the org's lock, and the checkpoint's last rewind. */
  store: Pick<OrgCheckpointStore, 'lock' | 'update'>;
  /**
   * What the org runs as records of `objects` are brought back, updated or
   * deleted. Not given, nothing of it is read, and nothing is refused for it.
   */
  readAutomation?: (objects: readonly string[]) => Promise<ForgeTargetAutomation>;
  /**
   * What else of this machine is writing to the org, said as a refusal names
   * it, or nothing. Asked once the org's lock is held, before anything is read.
   */
  runWriting?: (organizationId: string) => Promise<string | undefined> | string | undefined;
  /** Asked before the first delete when the user may not delete some objects' records. */
  onUndeletable?: RunRemovalOptions['onUndeletable'];
  onProgress?: (progress: UndoProgress) => void;
  /** Stops the undo before its next call to the org. */
  signal?: AbortSignal;
  /** This machine's clock: when the checkpoint is told it was undone. */
  now?: () => Date;
}

/** What an undo is asked. */
export interface UndoCheckpointRequest {
  checkpoint: OrgCheckpoint;
  /** The checkpoint's folder: the rewind's journal is in it. */
  folder: CheckpointFolder;
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none, which the guard refuses. */
  registered: OrgTypeAndEdition | undefined;
  /** The user SandForge connects as. */
  username: string;
  /** The rewind to take back: the checkpoint's last. */
  rewindId: string;
  /** Undo even though the org runs automation as the undo writes. */
  acceptAutomation: boolean;
}

/** How an undo ended: what it did and what still differs, or the refusal it met before writing. */
export type UndoCheckpointOutcome =
  | {
      undone: true;
      result: RewindResult;
      /** What could not be read, kept or said, in plain words; never thrown. */
      notes: string[];
    }
  | { undone: false; refusal: CheckpointRefusal };

/** Why an undo ended before it wrote anything: it was stopped. Nothing was written. */
export class UndoStopped extends Error {
  constructor() {
    super('The undo was stopped before it wrote anything to the org.');
    this.name = 'UndoStopped';
  }
}

/** What a refusal before the first write did not do. */
const NOTHING_WRITTEN = 'No record was written.';

/** A record by its first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** {@link guardCheckpoint}'s view of the org: it reads the answer's records, nothing else of jsforce's query. */
function guardConnectionOf(org: RewindOrg): Pick<Connection, 'query'> {
  return { query: (soql: string) => org.query(soql) } as unknown as Pick<Connection, 'query'>;
}

/** A refusal under `code`. */
function refusedWith(code: CheckpointRefusalCode, message: string): UndoCheckpointOutcome {
  return { undone: false, refusal: { code, message } };
}

/** The refusal of an undo while a take, a rewind or another undo of the org holds its lock. */
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
    message:
      `${what} (process ${holder.pid} on ${holder.host}): undo the rewind once it has ended. ` +
      'No record was read or written.',
  };
}

/** The refusal of an undo whose writes fire the org's automation, not accepted. */
function automationRefusal(
  orgName: string,
  automation: ForgeTargetAutomation,
  steps: ForgeRemovalSteps,
): CheckpointRefusal {
  const fired = firedOnRemovalStepsOf(automation, steps);
  const objects = [...new Set(fired.map((each) => each.objectApiName))];
  const what =
    fired.length > 0
      ? `${fired.length} flow(s), trigger(s) or rule(s) of ${objects.join(', ')} run as the ` +
        'undo brings records back, gives them their values back or sends them back to the ' +
        'recycle bin'
      : 'what runs as the undo writes could not all be read, so automation may run';
  return {
    code: 'AUTOMATION',
    message:
      `${orgName}: ${what}. Undo refused; accept that it runs to undo the rewind all the same. ` +
      NOTHING_WRITTEN,
  };
}

/** How the undo ended, as a rewind's result says it: unstable when someone else changed what it gave back. */
function statusOf(outcome: UndoRewindOutcome, residual: readonly RewindResidual[]): RewindStatus {
  if (outcome.status === 'cancelled' || outcome.status === 'failure') return outcome.status;
  if (residual.some((entry) => entry.reason === 'changedDuringRewind')) return 'unstable';
  return outcome.status;
}

/**
 * What still differs once the undo was through, as a rewind names it: of the
 * records of an object whose last change is by the undo's own users, kept by
 * the org's automation; of those another user changed, changed during it,
 * naming that user when one alone did.
 */
function residualOf(
  residual: readonly UndoResidual[],
  owners: ReadonlySet<string>,
): RewindResidual[] {
  return residual.map((object) => {
    const others = Object.keys(object.by).filter((by) => !owners.has(keyOf(by)));
    if (others.length === 0) {
      return {
        objectApiName: object.objectApiName,
        reason: 'automation',
        count: object.count,
        ids: [...object.ids],
      };
    }
    const named = others.length === 1 && others[0] !== 'unknown' ? others[0] : undefined;
    return {
      objectApiName: object.objectApiName,
      reason: 'changedDuringRewind',
      ...(named !== undefined ? { by: named } : {}),
      count: object.count,
      ids: [...object.ids],
    };
  });
}

/**
 * Undo a rewind: see the module's comment.
 *
 * @returns What it did and what still differs, stopped part way included;
 *   or the refusal a guard or a gate gave, with nothing written.
 * @throws {UndoStopped} When it was stopped before it wrote anything.
 * @throws {CheckpointStoreError} When the rewind's journal is not kept or
 *   cannot be read: nothing is sent.
 * @throws When a call to the org failed outright: the journal keeps what the
 *   undo did, and the next undo takes up the rest.
 */
export async function undoCheckpoint(
  deps: UndoCheckpointDeps,
  request: UndoCheckpointRequest,
): Promise<UndoCheckpointOutcome> {
  const { checkpoint, folder, orgName, rewindId } = request;
  const signal = deps.signal;
  const stopped = (): boolean => signal?.aborted === true;
  const progress = (percentage: number, step: string): void =>
    deps.onProgress?.({ percentage, step });
  const count = counted(deps.org, deps.undelete);
  const guard = await guardCheckpoint(guardConnectionOf(count.org), {
    act: 'undo',
    orgName,
    registered: request.registered,
    username: request.username,
    organizationId: checkpoint.org.organizationId,
  });
  if (!guard.allowed) return { undone: false, refusal: guard.refusal };
  const locked = deps.store.lock(checkpoint.org.organizationId, 'undo', checkpoint.checkpointId);
  if ('busy' in locked) return { undone: false, refusal: lockedRefusal(orgName, locked.busy) };
  try {
    const writing = await deps.runWriting?.(guard.org.id);
    if (writing !== undefined) return refusedWith('RUN_WRITING', writing);
    const budget = await readBudget(count.org, orgName);
    if (stopped()) throw new UndoStopped();

    progress(5, 'Reading what the rewind did');
    // What it takes back, per object, read from the journal on disk and let
    // go: the undo reads its plans again as it writes.
    const plans = await undoPlansOf(folder, rewindId, checkpoint.objects);
    const rewound = rewoundObjects(plans);
    const along = plans.goesWithParent.objects;
    // What the rewind made again goes to the bin too, and is said so.
    const sending =
      plans.remade.keys.size > 0
        ? 'Sending back to the recycle bin what the rewind brought back, and deleting again what ' +
          'it made again'
        : 'Sending back to the recycle bin what the rewind brought back';
    const namesOf = (spooled: ReadonlyArray<{ objectApiName: string; count: number }>): string[] =>
      spooled.filter((object) => object.count > 0).map((object) => object.objectApiName);
    // What goes back to the bin with its parent is read with what the undo
    // deletes, as it was when it was sent on its own: what the org runs for
    // a record its parent's delete takes along is not told apart here.
    const steps: ForgeRemovalSteps = {
      bringBack: namesOf(plans.bringBack.objects),
      giveBack: namesOf(plans.giveBack.objects),
      delete: [...new Set([...namesOf(along), ...namesOf(plans.remove.objects)])],
    };
    await plans.dispose();
    const objects = [
      ...new Set([...(steps.bringBack ?? []), ...(steps.giveBack ?? []), ...(steps.delete ?? [])]),
    ];
    let automation: ForgeTargetAutomation | undefined;
    if (objects.length > 0 && deps.readAutomation) {
      try {
        automation = await deps.readAutomation(objects);
      } catch (err: unknown) {
        automation = automationUnread(objects, extractErrorMessage(err));
      }
      // Read through the host's own reader: counted as it says it sent them.
      count.add(automation.requests);
    }
    if (
      automation &&
      !request.acceptAutomation &&
      (firedOnRemovalStepsOf(automation, steps).length > 0 || blindedBy(automation.unread))
    ) {
      return { undone: false, refusal: automationRefusal(orgName, automation, steps) };
    }
    const cost = undoEstimate({
      objects: checkpoint.objects,
      rewound,
      automationRequests: 0,
    });
    const overBudget = budgetRefusal('undo', count.used() + cost.apiRequests, budget, orgName);
    if (objects.length > 0 && overBudget) return { undone: false, refusal: overBudget };
    // The emails its writes make the org send, against what it has left of
    // each daily limit: past them, no box lifts the refusal.
    const overEmails = automation
      ? emailsRefusal(
          'undo',
          checkpointEmails(writtenByUndo(rewound, along), automation, budget.emails),
          orgName,
        )
      : undefined;
    if (objects.length > 0 && overEmails) return { undone: false, refusal: overEmails };
    if (stopped()) throw new UndoStopped();

    // The user it writes as: what it gave back that this user, or the org's
    // Automated Process, changed again since is its own automation's doing.
    const userId = await count.org.userId();
    const owners = new Set(rewindWriters(checkpoint.takenBy, userId).map(keyOf));
    progress(20, 'Bringing back what the rewind deleted and giving back what it wrote over');
    const outcome = await undoRewind({
      folder,
      rewindId,
      lock: locked.lock,
      objects: checkpoint.objects,
      org: count.org,
      undelete: count.undelete,
      ...(signal ? { signal } : {}),
      ...(deps.onUndeletable ? { onUndeletable: deps.onUndeletable } : {}),
      onProgress: (settled, total, objectApiName) =>
        progress(
          20 + Math.round((70 * settled) / Math.max(total, 1)),
          `${sending}: ${objectApiName} ${settled} / ${total}`,
        ),
    });
    const residual = residualOf(outcome.residual, owners);
    const status = statusOf(outcome, residual);
    const notes = [...outcome.notes];
    if (status !== 'cancelled' && status !== 'failure') {
      const undoneAt = (deps.now ?? (() => new Date()))().toISOString();
      try {
        await deps.store.update(checkpoint.checkpointId, (held) =>
          held.lastRewind?.rewindId === rewindId
            ? { ...held, lastRewind: { ...held.lastRewind, undoneAt } }
            : held,
        );
      } catch (err: unknown) {
        notes.push(
          `The checkpoint could not be told the rewind was undone (${extractErrorMessage(err)}): ` +
            'its list may still offer to undo it.',
        );
      }
    }
    const used = count.used();
    return {
      undone: true,
      result: {
        checkpointId: checkpoint.checkpointId,
        rewindId,
        status,
        deleted: outcome.deleted,
        ...(outcome.remade ? { remade: outcome.remade } : {}),
        ...(outcome.carriedAlone ? { carriedAlone: outcome.carriedAlone } : {}),
        restored: outcome.restored,
        undeleted: outcome.undeleted,
        residual,
        passes: 1,
        apiRequests: { used, leftToday: Math.max(0, budget.remaining - used) },
        finishedAt: outcome.finishedAt,
      },
      notes,
    };
  } finally {
    locked.lock.release();
  }
}
