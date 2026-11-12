/**
 * What the user sees of what an emptying deletes, when they lack View All
 * Data or Modify All Data.
 *
 * SOQL applies the user's sharing: a record they cannot see is neither
 * counted by the dry run nor read by the run, and stays. A record they see
 * but may not delete is refused. And what a deleted parent takes along goes,
 * seen or not: a private task of a colleague under an account. So an object
 * is proven seen and deleted whole by the rules a checkpoint holds an object
 * by (`checkpointAccess.ts`): Modify All on the object, or, for one with no
 * permissions of its own, on every record it hangs from through a lookup
 * whose delete takes it along. Every other object the emptying deletes
 * records of is named, with why: tasks and events, products and price books,
 * files and custom settings never are, as no permission proves who sees all
 * of them.
 *
 * Undo is held to the same: only Modify All Data brings back what another
 * user deleted (P-B3), and the records an emptying deletes are its user's
 * deletions alone — what its delete took along included — so an Undo by the
 * same user brings them back, and one by another user does not.
 */

import type { DataOpsEmptyAccess } from '@sandforge/shared';
import {
  coverageOf,
  parentsToDescribe,
  type ObjectGrants,
} from '../../checkpoint/checkpointAccess.js';
import type { CheckpointDescribe } from '../../checkpoint/checkpointFields.js';
import type { EmptyPermissions } from './emptyGuard.js';

/** What reading the user's coverage needs. */
export interface EmptyAccessInput {
  permissions: EmptyPermissions;
  /** The objects the emptying deletes records of: emptied, and going along. */
  objects: readonly string[];
  /** The custom settings among them. */
  customSettings?: readonly string[];
  /** The user's grants object by object (`grantsByObject`), or why they were not read. */
  grants: () => Promise<{ grants: ObjectGrants } | { unread: string }>;
  /** The describes of `names`, those the org would not describe left out. */
  describe: (names: readonly string[]) => Promise<CheckpointDescribe[]>;
}

/**
 * What the user sees of `input.objects`: every record, or the objects they
 * are not proven to see and delete whole, each with why. Nothing is read
 * of a user with View All Data and Modify All Data.
 */
export async function emptyAccessOf(input: EmptyAccessInput): Promise<DataOpsEmptyAccess> {
  const { permissions, objects } = input;
  if (permissions.viewAllData && permissions.modifyAllData) return { kind: 'org' };
  const base = {
    kind: 'perObject' as const,
    viewAllData: permissions.viewAllData,
    modifyAllData: permissions.modifyAllData,
  };
  const read = await input.grants();
  if ('unread' in read) {
    return {
      ...base,
      unseen: objects.map((objectApiName) => ({
        objectApiName,
        reason: 'permissionsUnread',
        detail: read.unread,
      })),
    };
  }
  const described = await input.describe(objects);
  const coverageInput = {
    grants: read.grants,
    describes: described,
    ...(input.customSettings ? { customSettings: input.customSettings } : {}),
  };
  const parents = parentsToDescribe(objects, coverageInput);
  const all = parents.length > 0 ? [...described, ...(await input.describe(parents))] : described;
  const coverage = coverageOf(objects, { ...coverageInput, describes: all });
  const unseen: Array<{ objectApiName: string; reason: string; detail?: string }> = [];
  for (const [objectApiName, held] of coverage) {
    if ('access' in held) continue;
    unseen.push({
      objectApiName,
      reason: held.reason,
      ...(held.detail !== undefined ? { detail: held.detail } : {}),
    });
  }
  return { ...base, unseen };
}

/**
 * The objects of `after` its user is not proven to see that `before` said
 * they saw: what a run read with less than its preview showed refuses on, as
 * a rewind refuses a preview read with more than its user holds now.
 */
export function accessNarrowedSince(
  before: DataOpsEmptyAccess,
  after: DataOpsEmptyAccess,
): string[] {
  if (after.kind === 'org') return [];
  const unseenBefore = new Set(
    before.kind === 'org' ? [] : before.unseen.map((object) => object.objectApiName),
  );
  return after.unseen
    .map((object) => object.objectApiName)
    .filter((objectApiName) => !unseenBefore.has(objectApiName));
}
