/**
 * The objects an emptying deletes the records of, and those it leaves out,
 * each with why: the objects picked ("Empty objects"), or every object people
 * work in ("Empty the org"), less what is never touched and what is only
 * touched when asked.
 *
 * One rule says what "every object people work in" is, for a clone of the
 * whole org and for an emptying alike: a clone and an emptying that read two
 * rules would cover two sets of objects, and an emptied org would keep
 * records a clone then copies into it next to their twins. An emptying reads
 * it asking what emptying asks of the user, to query and delete an object's
 * records, where a clone asks to write them (`wholeOrgScope`, act `empty`):
 * it leaves out users, permissions and the rest of setup — what no copy
 * writes (`excludedObjects.ts`) and what the org gives no page layout —
 * Chatter, history, sharing and change events, big, external and Data Cloud
 * objects, Knowledge versions and platform events, the records Salesforce
 * alone creates, what the Tooling API serves, and the org's configuration
 * kept as records: its flows, orchestrations, settings and definitions.
 *
 * Four kinds of object are emptied only when asked, in either mode — a pick
 * asks for its object:
 *
 * - custom settings, which are configuration: an integration's endpoint, a
 *   switch an admin flipped;
 * - files and attachments: a file is not deleted with a record it is linked
 *   to, only its link is, and a file shared with a colleague is theirs too.
 *   An attachment still goes with the record it hangs from, said as what
 *   goes along;
 * - the objects of managed packages, whose records a package's own
 *   configuration may live in;
 * - the objects whose records no undelete brings back on their own, as the
 *   global describe says (`undeletable: false`): a price, an opportunity's
 *   product, a contact's role. What they hold under a record emptied still
 *   goes along with it, and comes back with it; sent on their own, by a pass
 *   of theirs, they would be beyond any undo, which the preview then says.
 *
 * The standard price book is never deleted, whatever is asked: every price
 * of every product hangs from it, and a copy matches it rather than makes it
 * (`IsStandard`). It is kept as a row, not as an object (`emptyRelations.ts`).
 */

import {
  ALL_CUSTOM_SETTINGS,
  ATTACHMENT_OBJECT,
  FILE_OBJECT,
  namespaceOf,
  type GlobalObject,
} from '../../checkpoint/checkpointScope.js';
import { wholeOrgScope, type WholeOrgLeftOutReason } from '../../forge/wholeOrgScope.js';
import type { EmptyDescribe } from './emptyRelations.js';

/** The objects picked, or every object people work in. */
export type EmptyMode = 'objects' | 'org';

/** What a person asks an emptying to delete. */
export interface EmptyScopeRequest {
  mode: EmptyMode;
  /** In `objects` mode, the objects picked. */
  objects?: readonly string[];
  /** In `org` mode, the objects left out by name. */
  excluded?: readonly string[];
  /** In `org` mode, whether custom settings are emptied: not unless asked. */
  customSettings?: boolean;
  /** In `org` mode, whether files and attachments are emptied: not unless asked. */
  files?: boolean;
  /** In `org` mode, whether the objects of managed packages are emptied: not unless asked. */
  managedPackages?: boolean;
  /**
   * In `org` mode, whether the objects whose records no undelete brings back
   * are emptied by passes of their own: not unless asked.
   */
  unrestorable?: boolean;
}

/** Why an emptying leaves an object out. */
export type EmptyLeftOutReason =
  /** Left out by name. */
  | 'excludedByUser'
  /** Picked or left out by name, and the org has no such object. */
  | 'notFound'
  /** A Chatter post, comment or feed. */
  | 'chatter'
  /** A history object: the org's trace of changes. */
  | 'history'
  /** A sharing object, which the org keeps itself. */
  | 'sharing'
  /** A change event of Change Data Capture. */
  | 'changeEvent'
  /** A big object, an external or Data Cloud object, a Knowledge version or a platform event. */
  | 'unsupportedKind'
  /** A custom setting, not asked for. */
  | 'customSetting'
  /** A file or an attachment, not asked for. */
  | 'files'
  /** An object of a managed package, not asked for. */
  | 'managedPackage'
  /** A document of the Documents tab: shared content kept in folders, as setup is. */
  | 'documents'
  /** A file's version or link, which goes with its file. */
  | 'heldWithFiles'
  /** Users, permissions and the rest of setup, and the org's logs and jobs. */
  | 'setup'
  /** Records Salesforce alone creates. */
  | 'platformCreated'
  /** Metadata, which the Tooling API serves. */
  | 'metadata'
  /** The org's configuration kept as records: its flows, orchestrations, settings and definitions. */
  | 'configuration'
  /** Its records cannot come back from the recycle bin on their own, not asked for. */
  | 'notRestorable'
  /** The user may not query or delete its records. */
  | 'notDeletable'
  /** Its describe could not be read. */
  | 'notDescribed'
  /** No recycle bin: its records would be gone for good, beyond any undo. */
  | 'noRecycleBin'
  /** A file, asked to be deleted for good: only a Bulk API job does that, and none sends a file. */
  | 'notForGood';

/** An object an emptying leaves out, with why. */
export interface EmptyLeftOut {
  objectApiName: string;
  reason: EmptyLeftOutReason;
  /** The org's own words, where it gave any. */
  detail?: string;
}

/** What the rule of "every object people work in" says of an org. */
export interface WholeOrgScope {
  /** The objects people work in that the user may delete, by the names the org gives them. */
  candidates: string[];
  /** Every other object of the global describe, with why. */
  leftOut: EmptyLeftOut[];
}

/**
 * The rule of "every object people work in", read with what the user may
 * delete: from the org's global describe and the names its Tooling API
 * serves (none when it could not say), with custom settings or without.
 */
export type WholeOrgScopeRule = (
  global: readonly GlobalObject[],
  tooling: readonly string[],
  options: { customSettings: boolean },
) => WholeOrgScope;

/**
 * Why the whole-org rule left an object out, as an emptying says it, each
 * reason the rule can give named: the Documents tab is `files` there, where
 * `files` here is what a person opts into; an object the user may not write
 * there is, asked what emptying asks, one they may not query or delete.
 */
function reasonOf(reason: WholeOrgLeftOutReason): EmptyLeftOutReason {
  switch (reason) {
    case 'configuration':
    case 'excludedByUser':
    case 'notFound':
    case 'chatter':
    case 'history':
    case 'sharing':
    case 'changeEvent':
    case 'unsupportedKind':
    case 'customSetting':
    case 'heldWithFiles':
    case 'setup':
    case 'platformCreated':
    case 'metadata':
      return reason;
    case 'notCustomSetting':
      return 'notFound';
    case 'files':
      return 'documents';
    case 'notWritable':
      return 'notDeletable';
  }
}

/**
 * The whole-org rule, asked what emptying asks of the user: that they may
 * query and delete an object's records, whether or not they may create
 * them — a file, which the data API never creates, among them.
 */
export const emptyingRule: WholeOrgScopeRule = (global, tooling, options) => {
  const scope = wholeOrgScope(
    global,
    tooling,
    'empty',
    options.customSettings ? { customSettings: ALL_CUSTOM_SETTINGS } : {},
  );
  return {
    candidates: scope.candidates,
    leftOut: scope.leftOut.map(({ objectApiName, reason, detail }) => ({
      objectApiName,
      reason: reasonOf(reason),
      ...(detail === undefined ? {} : { detail }),
    })),
  };
};

/** What an emptying deletes the records of, and what it leaves out. */
export interface EmptyScope {
  mode: EmptyMode;
  /** The objects emptied, by the names the org gives them, in code-unit order. */
  objects: string[];
  /** The objects left out, with why: in `objects` mode, of those picked. */
  leftOut: EmptyLeftOut[];
  /**
   * Every object people work in, whatever the request leaves out: what goes
   * with an emptied record is read among them, a contact left out by name
   * going with its account all the same.
   */
  worked: string[];
}

/** The files and attachments an emptying deletes only when asked, in lower case. */
const FILE_OBJECTS: ReadonlySet<string> = new Set(
  [FILE_OBJECT, ATTACHMENT_OBJECT].map((name) => name.toLowerCase()),
);

/** Names in code-unit order, so that the same org gives the same list on any machine. */
function byName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/** Why `org` mode leaves out a candidate the request did not ask for, or nothing. */
function notAskedReason(
  object: GlobalObject,
  request: EmptyScopeRequest,
): EmptyLeftOutReason | undefined {
  if (object.customSetting === true && request.customSettings !== true) return 'customSetting';
  if (FILE_OBJECTS.has(object.name.toLowerCase()) && request.files !== true) return 'files';
  if (namespaceOf(object.name) !== undefined && request.managedPackages !== true) {
    return 'managedPackage';
  }
  if (object.undeletable === false && request.unrestorable !== true) return 'notRestorable';
  return undefined;
}

/**
 * The objects an emptying deletes the records of, and those it leaves out,
 * from the org's global describe.
 *
 * In `objects` mode, each object picked is emptied when the rule holds it,
 * and left out with the rule's reason otherwise: a pick is the person's
 * opt-in to a custom setting, a file, a package's object or one whose records
 * no undelete brings back, never to a feed, to setup or to configuration. In
 * `org` mode, every object the rule holds is emptied but those left out by
 * name and those of the four kinds not asked for, and every object of the
 * org is either emptied or left out with why.
 *
 * @param tooling - The names the org's Tooling API serves; none when it could not say.
 * @param rule - The whole-org rule read: see {@link WholeOrgScopeRule}.
 */
export function emptyScopeOf(
  global: readonly GlobalObject[],
  tooling: readonly string[],
  request: EmptyScopeRequest,
  rule: WholeOrgScopeRule = emptyingRule,
): EmptyScope {
  const everything = rule(global, tooling, { customSettings: true });
  const byLowerName = new Map(global.map((object) => [object.name.toLowerCase(), object]));
  const held = new Set(everything.candidates.map((name) => name.toLowerCase()));
  const ruledOut = new Map(
    everything.leftOut.map((out) => [out.objectApiName.toLowerCase(), out] as const),
  );
  const objects: string[] = [];
  const leftOut: EmptyLeftOut[] = [];
  const outOf = (object: GlobalObject): EmptyLeftOut => {
    const out = ruledOut.get(object.name.toLowerCase());
    return out
      ? { ...out, objectApiName: object.name }
      : { objectApiName: object.name, reason: 'notDeletable' };
  };

  if (request.mode === 'objects') {
    const seen = new Set<string>();
    for (const picked of request.objects ?? []) {
      const key = picked.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const object = byLowerName.get(key);
      if (!object) leftOut.push({ objectApiName: picked, reason: 'notFound' });
      else if (held.has(key)) objects.push(object.name);
      else leftOut.push(outOf(object));
    }
  } else {
    const excluded = new Set((request.excluded ?? []).map((name) => name.toLowerCase()));
    for (const name of request.excluded ?? []) {
      if (!byLowerName.has(name.toLowerCase()))
        leftOut.push({ objectApiName: name, reason: 'notFound' });
    }
    for (const object of byLowerName.values()) {
      const key = object.name.toLowerCase();
      if (excluded.has(key)) {
        leftOut.push({ objectApiName: object.name, reason: 'excludedByUser' });
        continue;
      }
      if (!held.has(key)) {
        leftOut.push(outOf(object));
        continue;
      }
      const reason = notAskedReason(object, request);
      if (reason === undefined) objects.push(object.name);
      else leftOut.push({ objectApiName: object.name, reason });
    }
  }
  objects.sort();
  leftOut.sort(byName);
  return { mode: request.mode, objects, leftOut, worked: [...everything.candidates].sort() };
}

/**
 * `scope` once its objects are described: an object the org would not
 * describe is left out with its words, and so is one whose describe says the
 * user may not delete its records, or that has no recycle bin — no
 * `IsDeleted` — whose records would be gone for good, beyond any undo.
 *
 * @param describes - The emptied objects' describes, by name.
 * @param describeErrors - Why the org would not describe an object, in its words.
 */
export function settleEmptyScope(
  scope: EmptyScope,
  describes: ReadonlyMap<string, EmptyDescribe>,
  describeErrors: ReadonlyMap<string, string> = new Map(),
): EmptyScope {
  const objects: string[] = [];
  const leftOut = [...scope.leftOut];
  for (const name of scope.objects) {
    const described = describes.get(name);
    if (!described) {
      const detail = describeErrors.get(name);
      leftOut.push({
        objectApiName: name,
        reason: 'notDescribed',
        ...(detail === undefined ? {} : { detail }),
      });
    } else if (described.deletable === false) {
      leftOut.push({ objectApiName: name, reason: 'notDeletable' });
    } else if (!described.fields.some((field) => field.name === 'IsDeleted')) {
      leftOut.push({ objectApiName: name, reason: 'noRecycleBin' });
    } else {
      objects.push(name);
    }
  }
  return { ...scope, objects, leftOut: leftOut.sort(byName) };
}
