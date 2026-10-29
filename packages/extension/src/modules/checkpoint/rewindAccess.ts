/**
 * What an act on a checkpoint — a preview, a rewind, an undo — may read and
 * write of each of its objects, as its guard read the user's permissions at
 * that act: the take proved them once, and they may have changed since, or
 * another user may be the one acting now.
 *
 * With View All Data and Modify All Data (`org`), every object is held, as
 * it always was. Without them, each object of the checkpoint is proven again
 * by the rules a take proves it by (`checkpointAccess.ts`): Modify All on the
 * object (`object`), or, for one with no permissions of its own, on every
 * record it hangs from through a lookup whose delete takes it along
 * (`parent`). One no longer proven is not read at all, and named: it could
 * not be read, the user no longer has View All and Modify All on it, and a
 * rewind leaves it as it is, as any object it could not read.
 *
 * Read object by object, two things change in what a rewind may promise
 * (P-B3, on a scratch org, a Standard User given View All and Modify All on
 * a private object):
 *
 * - the user sees what other users deleted of an object they hold by its own
 *   permissions, through `queryAll`, but Salesforce refuses them its undelete,
 *   `INSUFFICIENT_ACCESS_OR_READONLY`: only Modify All Data restores what
 *   someone else deleted. The deleted row names who deleted it, its last
 *   modifier (F2): {@link ActAccess.userKey} tells the user's own;
 * - of an object held through what it hangs from, nothing proves the user
 *   sees what others deleted of it in the bin: a record of the checkpoint
 *   neither live nor in what the bin shows may sleep there out of sight, and
 *   is never made again.
 *
 * And what the rewind deletes may take along records the user does not see:
 * a delete takes along every record that hangs from it through a lookup
 * whose delete cascades, whoever may see them — a private task of another
 * user under an account created since. Of each object, the objects it takes
 * along records of that the user is not proven to see whole are
 * {@link ActAccess.unseenOf}: a rewind deletes such records only once that
 * is accepted.
 *
 * What proving them sends — the guard's reads of the user's permissions, and
 * the describes of the objects held through what they hang from and of
 * those parents — is counted in {@link ActAccess.requests}, each describe
 * asked once an act.
 */

import type { CheckpointObject, OrgCheckpoint, RewindDiffAccess } from '@sandforge/shared';
import {
  coverageOf,
  parentsToDescribe,
  type AccessLeftOutReason,
  type ObjectCoverage,
} from './checkpointAccess.js';
import { checkpointDescribeSchema, type CheckpointDescribe } from './checkpointFields.js';
import type { CheckpointGrants } from './checkpointGuard.js';
import { OrgReadStopped, type CompositeReader } from './compositeQueries.js';

/** How an object of the checkpoint is held now. */
export type HeldAs = 'org' | 'object' | 'parent';

/** What an act may read and write of the checkpoint's objects: see the module's comment. */
export interface ActAccess {
  /** `org`: View All Data and Modify All Data; `perObject`: object by object. */
  readonly kind: 'org' | 'perObject';
  /**
   * The key, its first fifteen characters, of the user the act runs as: a
   * record deleted by anyone else stays in the recycle bin. Absent with View
   * All Data and Modify All Data, which restore whoever's deletions.
   */
  readonly userKey?: string;
  /** The objects of the checkpoint the user no longer holds whole, with the words saying why. */
  readonly notHeld: ReadonlyMap<string, string>;
  /** How an object of the checkpoint is held now; undefined for one not held. */
  heldAs(objectApiName: string): HeldAs | undefined;
  /**
   * Of `objectApiNames`, those the user is not proven to see every record
   * of, in their order: none with View All Data and Modify All Data.
   *
   * @throws {OrgReadStopped} When the act was stopped as it described them.
   */
  unseenOf(objectApiNames: readonly string[]): Promise<string[]>;
  /** What proving it sent the org so far: the guard's reads and the describes. */
  requests(): number;
  /** As a diff says it. */
  diffAccess(): RewindDiffAccess;
}

/** What an act's access is read from. */
export interface ActAccessInput {
  /** What the guard read of the user. */
  grants: CheckpointGrants;
  /** The id of the user the act runs as, read by the guard: absent with View All Data and Modify All Data. */
  userId?: string;
  /** The user SandForge connects as, as a reason names them. */
  username: string;
  /** The checkpoint: its objects, and who took it. */
  checkpoint: {
    objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'customSetting'>>;
    takenBy: Pick<OrgCheckpoint['takenBy'], 'userId'>;
  };
  /** The org's describes, through the act's own reader: what the parent rule reads. */
  reader: Pick<CompositeReader, 'describe' | 'calls'>;
}

/** The access of an act whose user has View All Data and Modify All Data: everything held, nothing read. */
export const ORG_ACCESS: ActAccess = Object.freeze({
  kind: 'org' as const,
  notHeld: new Map<string, string>(),
  heldAs: (): HeldAs => 'org',
  unseenOf: () => Promise.resolve([]),
  requests: () => 0,
  diffAccess: (): RewindDiffAccess => ({ kind: 'org' }),
});

/** A user's key: an id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/**
 * Why an object of the checkpoint is no longer held, in the words a person
 * reads after its name: the user no longer has — or, acting in another
 * user's place, doesn't have — what proves it.
 */
export function notHeldWords(
  objectApiName: string,
  why: { reason: AccessLeftOutReason; detail?: string },
  user: string,
  has: 'no longer has' | "doesn't have",
): string {
  const detail = why.detail !== undefined ? ` (${why.detail})` : '';
  switch (why.reason) {
    case 'noViewAll':
    case 'noModifyAll':
      return `${user} ${has} View All and Modify All on ${objectApiName}`;
    case 'parentNotSeen':
      return (
        `${user} ${has} View All and Modify All on every record ${objectApiName} hangs from` +
        detail
      );
    case 'activities':
      return (
        `${user} doesn't have View All Data and Modify All Data, which tasks and events need: ` +
        'Salesforce has no View All for activities'
      );
    case 'catalog':
      return (
        `${user} doesn't have View All Data and Modify All Data, which products and price books ` +
        'need: Salesforce has no View All or Modify All for them'
      );
    case 'filesNotProven':
      return (
        `${user} doesn't have View All Data and Modify All Data, which files need: nothing else ` +
        'proves who sees every file'
      );
    case 'settingNotProven':
      return (
        `${user} doesn't have View All Data and Modify All Data, which custom settings need: no ` +
        'permission on an object proves who sees and writes every row'
      );
  }
}

/**
 * The access of an act, as its guard read the user: see the module's
 * comment. With View All Data and Modify All Data it reads nothing more.
 *
 * @throws {OrgReadStopped} When the act was stopped as it described the objects.
 */
export async function actAccessOf(input: ActAccessInput): Promise<ActAccess> {
  const { grants, reader } = input;
  if (grants.kind === 'org' || input.userId === undefined) return ORG_ACCESS;
  const objects = input.checkpoint.objects;
  const customSettings = objects
    .filter((object) => object.customSetting !== undefined)
    .map((object) => object.objectApiName);
  /** Describes asked, by the object's name in lower case: undefined for one the org did not describe. */
  const described = new Map<string, CheckpointDescribe | undefined>();
  let sent = grants.requests;

  const describe = async (names: readonly string[]): Promise<void> => {
    const asked = [...new Set(names)].filter((name) => !described.has(name.toLowerCase()));
    if (asked.length === 0) return;
    const before = reader.calls();
    const answers = await Promise.allSettled(asked.map((name) => reader.describe(name)));
    sent += reader.calls() - before;
    answers.forEach((answer, at) => {
      if (answer.status === 'rejected' && answer.reason instanceof OrgReadStopped) {
        throw answer.reason;
      }
      const body =
        answer.status === 'fulfilled' && 'body' in answer.value ? answer.value.body : undefined;
      const parsed = checkpointDescribeSchema.safeParse(body);
      described.set(asked[at].toLowerCase(), parsed.success ? parsed.data : undefined);
    });
  };
  const describes = (): CheckpointDescribe[] =>
    [...described.values()].filter((held): held is CheckpointDescribe => held !== undefined);

  /**
   * How each of `names` is held, once what the parent rule reads of them is
   * described: the objects with no permission row of their own, then what
   * they hang from.
   */
  const coverage = async (names: readonly string[]): Promise<Map<string, ObjectCoverage>> => {
    const own = names.filter((name) => !grants.objects.has(name.toLowerCase()));
    await describe(own);
    const coverageInput = { grants: grants.objects, describes: describes(), customSettings };
    await describe(parentsToDescribe(names, coverageInput));
    return coverageOf(names, { ...coverageInput, describes: describes() });
  };

  const held = await coverage(objects.map((object) => object.objectApiName));
  const has =
    keyOf(input.userId) === keyOf(input.checkpoint.takenBy.userId)
      ? ('no longer has' as const)
      : ("doesn't have" as const);
  const heldAs = new Map<string, HeldAs>();
  const notHeld = new Map<string, string>();
  for (const [name, proof] of held) {
    if ('access' in proof) heldAs.set(name, proof.access);
    else notHeld.set(name, notHeldWords(name, proof, input.username, has));
  }

  return {
    kind: 'perObject',
    userKey: keyOf(input.userId),
    notHeld,
    heldAs: (objectApiName) => heldAs.get(objectApiName),
    unseenOf: async (names) => {
      const proofs = await coverage(names);
      return names.filter((name) => {
        const proof = proofs.get(name);
        return proof === undefined || !('access' in proof);
      });
    },
    requests: () => sent,
    diffAccess: () => ({ kind: 'perObject', requests: sent }),
  };
}
