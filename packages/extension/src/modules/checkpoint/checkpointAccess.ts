/**
 * Which objects a checkpoint may hold for a user without View All Data and
 * Modify All Data, and why it leaves out the others.
 *
 * An object is held only when SandForge can prove its user sees and puts back
 * every record of it, whoever owns them. The org's sharing is never that
 * proof: restriction rules hide records from a user the sharing model lets
 * see them, and View All Records and View All Data alone are exempt from them
 * (Restriction Rules Considerations); the sharing model can change between a
 * take and its rewind besides. A record out of the user's sight would read as
 * deleted since, and be brought back or made again. So an object is covered:
 *
 * - by `object`: Modify All Records on it, which Salesforce grants only with
 *   View All Records on the same object (P2, `ObjectPermissions`);
 * - by `parent`: no permission row of its own — an opportunity's products, a
 *   case's comments, a campaign's members — and Modify All on every record it
 *   hangs from by a lookup whose delete takes it along, each such parent of a
 *   single object and itself covered. That the user then sees every one of
 *   its records is the design's reading (P10); the live probe could not tell
 *   it on the test org, whose opportunities and cases every user sees
 *   anyway. {@link COVERS_BY_PARENT} holds the rule.
 *
 * Always left out, each with its reason: tasks and events (Salesforce has no
 * View All for activities, and a private activity linked to no record stays
 * out of sight), products and price books (no View All or Modify All exists
 * for them, P3), files (nothing proves who sees every file without View All
 * Data, P12) and custom settings (no permission row tells who sees and
 * writes every row).
 *
 * What the user holds of an object is read from every row of
 * `ObjectPermissions` of their permission sets, OR over the rows, as the
 * platform adds them up: a permission set group by its aggregate, which
 * reflects its muting (P-B5).
 *
 * Pure: the guard reads the rows (`checkpointGuard.ts`), the take the
 * describes (`takeCheckpoint.ts`).
 */

import type { CheckpointDescribe } from './checkpointFields.js';
import { FILE_OBJECT } from './checkpointScope.js';

/**
 * Whether an object with no permission row of its own is held when every
 * record it hangs from is: the note's rule, whose live proof is open (P-B3,
 * step 7, could not tell it). False leaves every such object out as
 * `parentNotSeen`.
 */
export const COVERS_BY_PARENT = true;

/** What the user holds on one object, every permission row of theirs added up. */
export interface ObjectGrant {
  viewAll: boolean;
  modifyAll: boolean;
}

/** What the user holds on each object that has a permission row of theirs, by its name in lower case. */
export type ObjectGrants = ReadonlyMap<string, ObjectGrant>;

/**
 * The user's grants from their rows of `ObjectPermissions`: an object holds
 * View All or Modify All when any row of it does. A row naming no object is
 * no row of an object.
 */
export function grantsOf(
  rows: Iterable<Readonly<Record<string, unknown>>>,
): Map<string, ObjectGrant> {
  const grants = new Map<string, ObjectGrant>();
  for (const row of rows) {
    const object = row.SobjectType;
    if (typeof object !== 'string' || object === '') continue;
    const key = object.toLowerCase();
    const held = grants.get(key) ?? { viewAll: false, modifyAll: false };
    grants.set(key, {
      viewAll: held.viewAll || row.PermissionsViewAllRecords === true,
      modifyAll: held.modifyAll || row.PermissionsModifyAllRecords === true,
    });
  }
  return grants;
}

/** Whether any object is covered by its own permissions: without one, nothing can be held. */
export function coversAnyObject(grants: ObjectGrants): boolean {
  return [...grants.values()].some((grant) => grant.modifyAll);
}

/** Why an object is left out of a checkpoint taken without View All Data and Modify All Data. */
export type AccessLeftOutReason =
  /** Neither View All nor Modify All on it. */
  | 'noViewAll'
  /** View All on it, and not Modify All: what others changed could not be put back. */
  | 'noModifyAll'
  /** A task or an event: activities have no View All. */
  | 'activities'
  /** A product or a price book: they have no View All or Modify All. */
  | 'catalog'
  /** A file: nothing proves who sees every file. */
  | 'filesNotProven'
  /** A custom setting: no permission row tells who sees and writes every row. */
  | 'settingNotProven'
  /** No permission of its own, and what it hangs from is not proven held whole. */
  | 'parentNotSeen';

/** How an object is held, or why it is not, with what the reason names. */
export type ObjectCoverage =
  { access: 'object' | 'parent' } | { reason: AccessLeftOutReason; detail?: string };

/** Tasks and events, in lower case. */
const ACTIVITIES: ReadonlySet<string> = new Set(['task', 'event']);

/** Products and price books, in lower case. */
const CATALOG: ReadonlySet<string> = new Set(['product2', 'pricebook2', 'pricebookentry']);

/**
 * The objects a reference field may name that are never a parent whose
 * delete takes a record along: a user is deactivated, never deleted, and a
 * queue that owns records cannot be deleted. Their fields — owners, the
 * stamps of who created and changed a record — tell nothing of what a record
 * hangs from.
 */
const NEVER_A_PARENT: ReadonlySet<string> = new Set(['user', 'group']);

/** What coverage is read from. */
export interface CoverageInput {
  grants: ObjectGrants;
  /**
   * The objects described: the scope's, and the objects their reference
   * fields name that {@link parentsToDescribe} asked for. A parent not among
   * them proves nothing.
   */
  describes: Iterable<CheckpointDescribe>;
  /** The custom settings among the objects, by any case. */
  customSettings?: Iterable<string>;
}

/** A reference field of an object, with what it may name beyond users and queues. */
interface Reference {
  field: string;
  targets: string[];
}

/** The reference fields of `described` that may name a record it hangs from. */
function referencesOf(described: CheckpointDescribe): Reference[] {
  const references: Reference[] = [];
  for (const field of described.fields) {
    if (field.type !== 'reference') continue;
    const targets = (field.referenceTo ?? []).filter(
      (target) => !NEVER_A_PARENT.has(target.toLowerCase()),
    );
    if (targets.length > 0) references.push({ field: field.name, targets });
  }
  return references;
}

/** An object left out for a fixed reason, before any permission is read; or none. */
function fixedReason(key: string, settings: ReadonlySet<string>): AccessLeftOutReason | undefined {
  if (ACTIVITIES.has(key)) return 'activities';
  if (CATALOG.has(key)) return 'catalog';
  if (key === FILE_OBJECT.toLowerCase()) return 'filesNotProven';
  if (settings.has(key)) return 'settingNotProven';
  return undefined;
}

/**
 * The objects the parent rule needs described to tell what `objectApiNames`
 * hang from, and that `describes` does not hold: what the single-object
 * reference fields of each object with no permission row of its own name.
 * Whether a lookup's delete takes the record along is said by the parent's
 * describe alone (`cascadeParentsOf`), so a parent left undescribed would be
 * a parent the rule never saw. A field that may name several objects is not
 * asked for: covered or not, it proves nothing.
 *
 * @returns Their names as the fields give them, each once.
 */
export function parentsToDescribe(
  objectApiNames: readonly string[],
  input: CoverageInput,
): string[] {
  const described = describedByKey(input.describes);
  const settings = keysOf(input.customSettings);
  const wanted = new Map<string, string>();
  for (const name of objectApiNames) {
    const key = name.toLowerCase();
    if (fixedReason(key, settings) !== undefined || input.grants.has(key)) continue;
    const own = described.get(key);
    if (own === undefined) continue;
    for (const { targets } of referencesOf(own)) {
      if (targets.length !== 1) continue;
      const target = targets[0];
      const targetKey = target.toLowerCase();
      if (!described.has(targetKey) && !wanted.has(targetKey)) wanted.set(targetKey, target);
    }
  }
  return [...wanted.values()];
}

function describedByKey(describes: Iterable<CheckpointDescribe>): Map<string, CheckpointDescribe> {
  return new Map([...describes].map((described) => [described.name.toLowerCase(), described]));
}

function keysOf(names: Iterable<string> | undefined): Set<string> {
  return new Set([...(names ?? [])].map((name) => name.toLowerCase()));
}

/** Whether a delete of a record of `parent` takes a record of `child` named by `field` along, as `parent`'s describe says. */
function cascades(parent: CheckpointDescribe, child: string, field: string): boolean {
  return (parent.childRelationships ?? []).some(
    (relationship) =>
      relationship.cascadeDelete === true &&
      relationship.childSObject.toLowerCase() === child &&
      relationship.field.toLowerCase() === field.toLowerCase(),
  );
}

/**
 * How the user would hold each of `objectApiNames` whole, or why it is left
 * out: see the module's comment.
 *
 * @param options.byParent - Whether the parent rule holds; {@link COVERS_BY_PARENT} unless given.
 * @returns Per object, by the name given.
 */
export function coverageOf(
  objectApiNames: readonly string[],
  input: CoverageInput,
  options: { byParent?: boolean } = {},
): Map<string, ObjectCoverage> {
  const byParent = options.byParent ?? COVERS_BY_PARENT;
  const described = describedByKey(input.describes);
  const settings = keysOf(input.customSettings);
  const decided = new Map<string, ObjectCoverage>();

  const coverOf = (name: string, visiting: ReadonlySet<string>): ObjectCoverage => {
    const key = name.toLowerCase();
    const known = decided.get(key);
    if (known !== undefined) return known;
    const fixed = fixedReason(key, settings);
    if (fixed !== undefined) return { reason: fixed };
    const grant = input.grants.get(key);
    if (grant !== undefined) {
      if (grant.modifyAll) return { access: 'object' };
      return { reason: grant.viewAll ? 'noModifyAll' : 'noViewAll' };
    }
    if (!byParent) {
      return { reason: 'parentNotSeen', detail: 'held through its parents is not proven' };
    }
    const own = described.get(key);
    if (own === undefined) return { reason: 'parentNotSeen', detail: 'it could not be described' };
    const parents: Array<{ field: string; parent: string }> = [];
    for (const { field, targets } of referencesOf(own)) {
      const unknown = targets.filter((target) => !described.has(target.toLowerCase()));
      const cascading = targets.filter((target) => {
        const parent = described.get(target.toLowerCase());
        return parent !== undefined && cascades(parent, key, field);
      });
      if (targets.length > 1) {
        // A lookup that may name several objects: no permission covers them
        // all, so one whose delete may take the record along proves nothing.
        if (cascading.length > 0 || unknown.length > 0) {
          return {
            reason: 'parentNotSeen',
            detail: `${field} may name a record of ${targets.join(', ')}`,
          };
        }
        continue;
      }
      if (unknown.length > 0) {
        return {
          reason: 'parentNotSeen',
          detail: `${unknown[0]}, which ${field} names, could not be described`,
        };
      }
      if (cascading.length > 0) parents.push({ field, parent: cascading[0] });
    }
    if (parents.length === 0) {
      return {
        reason: 'parentNotSeen',
        detail: 'it hangs from no record whose delete takes it along',
      };
    }
    const inside = new Set([...visiting, key]);
    for (const { field, parent } of parents) {
      const parentKey = parent.toLowerCase();
      const held = inside.has(parentKey) ? undefined : coverOf(parent, inside);
      if (held === undefined || !('access' in held)) {
        return {
          reason: 'parentNotSeen',
          detail: `${parent}, which ${field} names, is not held whole`,
        };
      }
    }
    return { access: 'parent' };
  };

  const coverage = new Map<string, ObjectCoverage>();
  for (const name of objectApiNames) {
    // Decided with no object under way: what a later object's parent reads
    // of it holds whatever led there.
    const held = coverOf(name, new Set());
    decided.set(name.toLowerCase(), held);
    coverage.set(name, held);
  }
  return coverage;
}
