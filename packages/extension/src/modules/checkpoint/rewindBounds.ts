/**
 * What a rewind nobody watches is held to, in the place of the person who
 * would read its preview before typing the org's alias: a pipeline's Rewind
 * step, whose bounds are its configuration, and the command line given
 * `--max-records` or `--refuse-when-active` — a cron job, a CI step — whose
 * `--yes` asks nobody.
 *
 * Each is checked on the preview the rewind then acts on as it read the org
 * (`RewindRequest.reusesPreview`): the step reads its own, the command line
 * shows its own. The rewind's plan does no more than that preview counts, so
 * a bound that lets the preview through holds the rewind too. In order:
 *
 * - `TOO_MANY_TO_REWIND`: more records to delete, give back, bring back and
 *   make again, all together, than its bound allows ({@link RewindBounds.maxRecords});
 * - `PEOPLE_ACTIVE`: someone other than the rewind's own writers — the user
 *   it writes as and the org's Automated Process (`rewindWriters`) — changed
 *   records of the checkpoint's objects in the hour before the preview read
 *   the org, whose work it would take back ({@link RewindBounds.refuseWhenActive}).
 *   Named by how many people they are, never by their names: a pipeline's
 *   history and the audit trail keep the refusal;
 * - an acceptance the rewind needs and was not given: the refusal the command
 *   line gives without its flag (`NO_UNDO`, `RECREATE`, `UNSEEN`,
 *   `AUTOMATION`), saying what gives it — a flag, or the step's setting;
 * - `EMAILS`: more emails of a daily limit than the org has left today, a
 *   Developer Edition's fifteen single emails among them, which nothing lifts.
 *
 * A rewind that would write nothing meets none of them. The rewind itself
 * meets the acceptances and the emails again before it writes, whatever this
 * says.
 *
 * Besides, the refusals of a rewind nobody watches that are not bounds: one
 * whose user may not delete some of what it deletes, which nobody is there to
 * be asked about (`UNDELETABLE_UNATTENDED`), and a pipeline's step no person
 * confirmed for its configuration as saved (`NOT_CONFIRMED`).
 */

import {
  blindedBy,
  firedOnRemovalStepsOf,
  type CheckpointEmails,
  type CheckpointRefusal,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type RewindBounds,
  type RewindDiff,
  type RewindDiffObject,
  type RewindSelectionPlan,
  type RewindUndoCannot,
  type RewindUndoCannotReason,
} from '@sandforge/shared';

import { FILE_LINK_OBJECT } from './checkpointScope.js';
import { objectsWrittenBy } from './previewCheckpoint.js';
import { emailsRefusal } from './rewindEmails.js';
import { diffOfPicked } from './rewindPlan.js';

/** What a refusal before any write ends with. */
const NOTHING_WRITTEN = 'No record was written.';

const count = (n: number): string => n.toLocaleString('en-US');

const toDeleteOf = (o: RewindDiffObject): number =>
  o.toDelete.createdSince + o.toDelete.broughtBackSince + o.toDelete.comesBackWithParent;
const toBringBackOf = (o: RewindDiffObject): number =>
  o.toBringBack.inBin + o.toBringBack.withParent + o.toBringBack.deletedWhileTaken;
const toRecreateOf = (o: RewindDiffObject): number => o.toRecreate ?? 0;
/**
 * Records the checkpoint does not hold brought back for a moment, with the
 * records of it their delete took along, then deleted again: in none of the
 * three numbers, but written twice.
 */
const carriersOf = (o: RewindDiffObject): number => o.toBringBack.carriers ?? 0;

// ─── What a preview says a rewind does ───────────────────────────────────────

/**
 * What a rewind to a checkpoint would do, in the three numbers the preview
 * leads with, and the records it would make again with new Ids.
 */
export interface PreviewTotals {
  toDelete: number;
  toGiveBack: number;
  toBringBack: number;
  toRecreate: number;
}

/**
 * The three numbers: records to delete (created since, brought back from the
 * bin since, and those that come back with a parent and go again), to give
 * their values back, and to bring back from the recycle bin; and the records
 * the recycle bin no longer gives back, to make again with new Ids.
 */
export function previewTotals(diff: Pick<RewindDiff, 'objects'>): PreviewTotals {
  return diff.objects.reduce<PreviewTotals>(
    (totals, object) => ({
      toDelete: totals.toDelete + toDeleteOf(object),
      toGiveBack: totals.toGiveBack + object.toGiveBack.records,
      toBringBack: totals.toBringBack + toBringBackOf(object),
      toRecreate: totals.toRecreate + toRecreateOf(object),
    }),
    { toDelete: 0, toGiveBack: 0, toBringBack: 0, toRecreate: 0 },
  );
}

/**
 * The diff a rewind limited to the plan's objects is counted by, beside the
 * whole one: of the objects picked, and of those not picked it writes to, the
 * plan's numbers in place of the diff's, what it cannot take back and the
 * objects it could not read of the objects picked alone, and what Undo
 * couldn't bring back as the plan says it.
 */
export function selectionDiff(diff: RewindDiff, plan: RewindSelectionPlan): RewindDiff {
  const picked = new Set(plan.objects);
  const actOf = new Map(plan.acts.map((act) => [act.objectApiName, act]));
  const base = diffOfPicked(diff, picked);
  return {
    ...base,
    objects: diff.objects
      .filter((o) => picked.has(o.objectApiName) || actOf.has(o.objectApiName))
      .map((o): RewindDiffObject => {
        const act = actOf.get(o.objectApiName);
        const own = picked.has(o.objectApiName);
        return {
          ...o,
          toDelete: {
            createdSince: act?.toDelete ?? 0,
            broughtBackSince: 0,
            comesBackWithParent: 0,
          },
          toGiveBack: { ...o.toGiveBack, records: act?.toGiveBack ?? 0 },
          toBringBack: {
            inBin: act?.toBringBack ?? 0,
            withParent: 0,
            deletedWhileTaken: 0,
            ...(own && o.toBringBack.carriers !== undefined
              ? { carriers: o.toBringBack.carriers }
              : {}),
          },
          toRecreate: act?.toRecreate ?? 0,
          cannotUndo: own ? o.cannotUndo : [],
          unexplained: own ? o.unexplained : 0,
        };
      }),
    undoCannot: [...plan.undoCannot],
  };
}

/**
 * The objects whose records each step of a rewind writes, as its preview
 * counts them: brought back, given back, deleted — an order activated since
 * set back to Draft first, which the platform deletes no other way — and the
 * records it brings back for a moment, then deletes again.
 */
export function rewindStepsOf(
  diff: Pick<RewindDiff, 'objects'> & Partial<Pick<RewindDiff, 'files'>>,
): ForgeRemovalSteps {
  // What comes back for a moment is brought back and deleted, as the rewind
  // itself lists it: its automation runs on both.
  const deleted = diff.objects
    .filter((o) => toDeleteOf(o) + carriersOf(o) > 0)
    .map((o) => o.objectApiName);
  // A link between a file and a record removed is a delete, one put back an
  // insert, one given its sharing back an update, as the rewind lists them:
  // a trigger on links runs on each.
  const links = diff.files;
  const linked = (step: string[], writes: number): string[] =>
    writes > 0 ? [...step, FILE_LINK_OBJECT] : step;
  return {
    bringBack: diff.objects
      .filter((o) => toBringBackOf(o) + carriersOf(o) > 0)
      .map((o) => o.objectApiName),
    recreate: linked(
      diff.objects.filter((o) => toRecreateOf(o) > 0).map((o) => o.objectApiName),
      links?.relink ?? 0,
    ),
    giveBack: linked(
      diff.objects.filter((o) => o.toGiveBack.records > 0).map((o) => o.objectApiName),
      links?.updateLinks ?? 0,
    ),
    setToDraft: deleted.filter((name) => name === 'Order'),
    delete: linked(deleted, links?.unlink ?? 0),
  };
}

// ─── The acceptances ─────────────────────────────────────────────────────────

/** An acceptance a rewind needs for some of what it does. */
export type RewindAcceptance =
  'acceptAutomation' | 'acceptNoUndo' | 'acceptRecreate' | 'acceptUnseen';

/** What a rewind is told it may do, by its flags or its step's configuration. */
export interface RewindAccepted {
  acceptAutomation: boolean;
  acceptNoUndo: boolean;
  acceptRecreate: boolean;
  /** Not given, not accepted. */
  acceptUnseen?: boolean;
}

/** What a rewind's preview answered: what it reads the acceptances and the bounds from. */
export interface BoundedPreview {
  /** The diff the rewind acts on: of a rewind of some objects, {@link selectionDiff}. */
  diff: RewindDiff;
  automation?: ForgeTargetAutomation;
  emails?: readonly CheckpointEmails[];
  /** Why the emails of what fires as the rewind writes were not all counted. */
  emailsUncounted?: string;
}

/**
 * How a refusal for want of a bound or an acceptance says what lifts it, each
 * said after "Rewind refused; ": the command line names its flags, a
 * pipeline's Rewind step its settings ({@link REWIND_STEP_WORDS}).
 */
export interface BoundWords {
  /** The bound on records, `max` of them, as "past …" ends: "this step's limit of 1,000". */
  limit: (max: number) => string;
  /** What lifts each refusal: "give --accept-no-undo to rewind all the same". */
  lift: Readonly<Record<RewindAcceptance | 'maxRecords' | 'refuseWhenActive', string>>;
}

/**
 * What a pipeline's Rewind step says lifts each refusal: a setting of its
 * configuration, which voids its confirmation, so it is confirmed again.
 */
export const REWIND_STEP_WORDS: BoundWords = {
  limit: (max) => `this step's limit of ${count(max)}`,
  lift: {
    acceptAutomation:
      'turn on acceptAutomation in the step and confirm it again to rewind all the same',
    acceptNoUndo: 'turn on acceptNoUndo in the step and confirm it again to rewind all the same',
    acceptRecreate:
      'turn on acceptRecreate in the step and confirm it again to rewind all the same',
    acceptUnseen: 'turn on acceptUnseen in the step and confirm it again to rewind all the same',
    maxRecords:
      "preview the rewind, then raise the step's maxRecords to what it rewinds and confirm it " +
      'again',
    refuseWhenActive:
      'run it once they are done, or turn off refuseWhenActive in the step and confirm it again',
  },
};

/** Why Undo couldn't bring back records a rewind deletes, as a refusal for want of the acceptance says it. */
const UNDO_CANNOT_WORDS: ReadonlyArray<{ reason: RewindUndoCannotReason; words: string }> = [
  {
    reason: 'onlyWithParent',
    words: 'Salesforce undeletes them only with their parent, which stays',
  },
  {
    reason: 'deletedBeforeParent',
    words:
      'deleted before a record they point at, which the rewind deletes next, Salesforce ' +
      'cannot bring them back after that',
  },
];

/**
 * The refusal a rewind of what `answer` previewed would meet before it
 * writes, for want of an acceptance: deletions Undo couldn't bring back,
 * records to make again with new Ids, deletions that take along records
 * `user` is not proven to see, automation its writes fire — or that could not
 * all be read. Said before the rewind is asked, as the page holds its button
 * until the box is ticked; the rewind itself refuses the same, whatever this
 * says.
 *
 * @param lift - What gives each acceptance: {@link BoundWords.lift}.
 */
export function acceptanceRefusal(
  orgName: string,
  answer: Pick<BoundedPreview, 'diff' | 'automation' | 'emailsUncounted'>,
  accepted: RewindAccepted,
  lift: BoundWords['lift'],
  user = 'the user SandForge connects as',
): CheckpointRefusal | undefined {
  const { diff, automation, emailsUncounted } = answer;
  if (diff.undoCannot.length > 0 && !accepted.acceptNoUndo) {
    const said = UNDO_CANNOT_WORDS.flatMap(({ reason, words }) => {
      // An entry that names no reason is of the first, as a diff made before
      // the second was told says it.
      const of = diff.undoCannot.filter(
        (u: RewindUndoCannot) => (u.reason ?? 'onlyWithParent') === reason,
      );
      if (of.length === 0) return [];
      const records = of.reduce((total, u) => total + u.count, 0);
      const objects = [...new Set(of.map((u) => u.objectApiName))].join(', ');
      return [
        `Undo couldn't bring back ${count(records)} ${objects} record(s) this rewind deletes: ` +
          `${words}.`,
      ];
    });
    return {
      code: 'NO_UNDO',
      message: `${said.join(' ')} Rewind refused; ${lift.acceptNoUndo}. ${NOTHING_WRITTEN}`,
    };
  }
  const remade = diff.objects.filter((o) => toRecreateOf(o) > 0);
  if (remade.length > 0 && !accepted.acceptRecreate) {
    const records = remade.reduce((total, o) => total + toRecreateOf(o), 0);
    return {
      code: 'RECREATE',
      message:
        `${count(records)} ${remade.map((o) => o.objectApiName).join(', ')} record(s) deleted ` +
        'since are no longer in the recycle bin, or Salesforce keeps them there for good: this ' +
        'rewind makes them again from the checkpoint, with new Ids. Anything outside Salesforce ' +
        'that names their old Ids — an integration, a link, a report filter — no longer finds ' +
        `them. Rewind refused; ${lift.acceptRecreate}. ${NOTHING_WRITTEN}`,
    };
  }
  const unseen = diff.unseen ?? [];
  if (unseen.length > 0 && accepted.acceptUnseen !== true) {
    const said = unseen.map(
      ({ objectApiName, children, records }) =>
        `Deleting ${count(records)} ${objectApiName} record(s) created since also deletes what ` +
        `${user} can't see under them in ${children.join(', ')}: Rewind can't count those.`,
    );
    return {
      code: 'UNSEEN',
      message: `${said.join(' ')} Rewind refused; ${lift.acceptUnseen}. ${NOTHING_WRITTEN}`,
    };
  }
  if (!automation || accepted.acceptAutomation) return undefined;
  const steps = rewindStepsOf(diff);
  const fired = firedOnRemovalStepsOf(automation, steps);
  if (fired.length === 0 && !blindedBy(automation.unread) && emailsUncounted === undefined) {
    return undefined;
  }
  const objects = [...new Set(fired.map((each) => each.objectApiName))];
  // A link put back is an insert of a link, no record made again.
  const makes = (steps.recreate ?? []).some((name) => name !== FILE_LINK_OBJECT)
    ? 'makes them again, '
    : '';
  const what =
    fired.length > 0
      ? `${fired.length} flow(s), trigger(s) or rule(s) of ${objects.join(', ')} run as the ` +
        `rewind brings records back, ${makes}gives them their values back or deletes them`
      : 'what runs as the rewind writes could not all be read, so automation may run';
  // Said here too: a rewind refused for its automation is the one place it
  // is said before nothing more is written.
  const uncounted =
    emailsUncounted !== undefined
      ? 'The emails it sends as the rewind writes were not counted against its daily limits, ' +
        `as what sends them was not read (${emailsUncounted}). `
      : '';
  return {
    code: 'AUTOMATION',
    message:
      `${orgName}: ${what}. ${uncounted}Rewind refused; ${lift.acceptAutomation}. ` +
      NOTHING_WRITTEN,
  };
}

// ─── The bounds ──────────────────────────────────────────────────────────────

/** What a rewind's bounds are checked with. */
export interface BoundsCheck {
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  preview: BoundedPreview;
  bounds: RewindBounds;
  accepted: RewindAccepted;
  /**
   * The rewind's own writers, by user Id (`rewindWriters`): the user it
   * writes as and the org's Automated Process. Asked only when the rewind is
   * refused while people are active and someone was: reading the user it
   * writes as is a call to the org.
   */
  writers: () => Promise<readonly string[]>;
  words: BoundWords;
  /** The user SandForge connects as, as a refusal for what it can't see names it. */
  user?: string;
}

/** A user, by the first fifteen characters of their Id: an Id of 15 and one of 18 name the same user. */
const userKey = (id: string): string => id.slice(0, 15);

/**
 * The refusal a rewind held to bounds meets before it writes: see the
 * module's comment for the order. Nothing when it would write nothing, and
 * when it holds to every bound.
 */
export async function boundsRefusal(check: BoundsCheck): Promise<CheckpointRefusal | undefined> {
  const { orgName, preview, bounds, words } = check;
  const { diff } = preview;
  if (objectsWrittenBy(diff).length === 0) return undefined;
  const totals = previewTotals(diff);
  const records = totals.toDelete + totals.toGiveBack + totals.toBringBack + totals.toRecreate;
  if (bounds.maxRecords !== undefined && records > bounds.maxRecords) {
    const parts = [
      `${count(totals.toDelete)} to delete`,
      `${count(totals.toGiveBack)} to give back`,
      `${count(totals.toBringBack)} to bring back`,
      ...(totals.toRecreate > 0 ? [`${count(totals.toRecreate)} to make again`] : []),
    ];
    return {
      code: 'TOO_MANY_TO_REWIND',
      message:
        `The rewind of ${orgName} would rewind ${count(records)} records (${parts.join(', ')}), ` +
        `past ${words.limit(bounds.maxRecords)}. Rewind refused; ${words.lift.maxRecords}. ` +
        NOTHING_WRITTEN,
    };
  }
  if (bounds.refuseWhenActive && diff.activeLastHour.length > 0) {
    const own = new Set((await check.writers()).map(userKey));
    const others = new Set(diff.activeLastHour.map(userKey).filter((user) => !own.has(user)));
    if (others.size > 0) {
      const people = others.size === 1 ? '1 person' : `${count(others.size)} people`;
      return {
        code: 'PEOPLE_ACTIVE',
        message:
          `${people} other than the user the rewind writes as changed records of the ` +
          `checkpoint's objects in ${orgName} in the hour before the rewind read it: it would ` +
          `take their work back. Rewind refused; ${words.lift.refuseWhenActive}. ` +
          NOTHING_WRITTEN,
      };
    }
  }
  return (
    acceptanceRefusal(orgName, preview, check.accepted, words.lift, check.user) ??
    emailsRefusal('rewind', preview.emails ?? [], orgName)
  );
}

// ─── With nobody to ask ──────────────────────────────────────────────────────

/**
 * The refusal of a rewind nobody watches whose user may not delete records
 * of `objects` it deletes: the panel asks a person whether to delete the rest,
 * and with nobody to ask the answer is no. The deletion is left untouched;
 * `wrote` says whether an earlier pass of the rewind had written, which stays.
 */
export function undeletableUnattendedRefusal(
  orgName: string,
  objects: ReadonlyArray<{ objectApiName: string; records: number }>,
  wrote: boolean,
): CheckpointRefusal {
  const named = objects.map((o) => `${o.objectApiName} (${count(o.records)})`).join(', ');
  return {
    code: 'UNDELETABLE_UNATTENDED',
    message:
      `The user SandForge connects to ${orgName} as may not delete the ${named} record(s) this ` +
      'rewind deletes. With nobody to ask whether to delete the rest, the deletion was left ' +
      'untouched. Give the user Delete on those objects, or rewind from the Checkpoints page, ' +
      'which asks. ' +
      (wrote
        ? "What the rewind's first pass wrote stays: its result says what, and Undo takes it back."
        : NOTHING_WRITTEN),
  };
}

/**
 * The refusal of a pipeline's Rewind step that no person confirmed for its
 * configuration as saved: never confirmed, or confirmed before a change of
 * it (`changedSince`), which voids the confirmation.
 */
export function notConfirmedRefusal(stepName: string, changedSince: boolean): CheckpointRefusal {
  return {
    code: 'NOT_CONFIRMED',
    message:
      `Rewind step "${stepName}" has ` +
      (changedSince ? 'not been confirmed since it was changed' : 'never been confirmed') +
      `: open it and type the org's alias. ${NOTHING_WRITTEN}`,
  };
}
