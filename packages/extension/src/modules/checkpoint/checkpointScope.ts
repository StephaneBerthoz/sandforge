/**
 * The objects a checkpoint holds, the ones it leaves out with why, and the
 * order it reads them in.
 *
 * "Everything people work in" is every object of the org the user may query,
 * create, edit and delete, empty ones included — what is created there later
 * is caught too — less what is no one's data: users, permissions and the rest
 * of setup, which every copy leaves out too, and what the org's own describes
 * say is metadata. Then less what a rewind cannot put back as it was:
 *
 * - Chatter posts, comments and their attachments: Salesforce undeletes a
 *   post only with its parent, and a post's history is the audit trail. Their
 *   names end in neither `Feed` nor anything else the copy's rule reads;
 * - history, sharing rows, feeds and change events: the org's own
 *   bookkeeping, which it writes as records change, and which a rewind would
 *   only fight;
 * - custom settings, which are configuration — an integration's endpoint, a
 *   switch an admin flipped — unless the take names them, in either mode: a
 *   rewind sets them back as the checkpoint holds them, whoever changed them
 *   since, so none is held unasked (`customSettings`);
 * - big objects, external objects, Data Cloud objects, Knowledge article
 *   versions and platform events, which neither the recycle bin nor an
 *   update reaches as it reaches a record;
 * - the documents of the Documents tab, shared content kept in folders —
 *   logos, letterheads, email template images — as setup is;
 * - and any object the org will not read without a filter, which never fails
 *   the checkpoint.
 *
 * Files are held. A file is a `ContentDocument`, held as a record though the
 * data API creates none — a rewind never makes a file, it deletes one, brings
 * one back or gives its fields back — with its versions and its links to
 * records held through it: Salesforce neither deletes nor brings back a
 * version on its own, and a link is read through the record it ties a file
 * to (`checkpointFiles.ts`). An `Attachment` of the old model is a record
 * like any other, its body left out as every file body is. Picked objects
 * hold both unless they are left out by name: a rewind of the picked objects
 * would otherwise leave the files added to their records since.
 *
 * A managed package's objects stay: a party of an industry package is data
 * like an account, and a copy that leaves such a package out does so because
 * following lookups from one record pulled its whole catalogue in, which a
 * checkpoint of every object does not do. They are listed by package.
 */

import * as z from 'zod';
import {
  isFileBodiedObject,
  type CheckpointCustomSettingKind,
  type CheckpointCustomSettings,
  type CheckpointObject,
} from '@sandforge/shared';
import { excludedByDescribe, isNeverCopiedWhenPicked } from '../forge/excludedObjects.js';
import type { AccessLeftOutReason } from './checkpointAccess.js';
import type { CheckpointDescribe } from './checkpointFields.js';

/** An object as the org's global describe lists it, as far as the scope reads it. */
export const globalObjectSchema = z
  .object({
    name: z.string(),
    queryable: z.boolean().optional(),
    createable: z.boolean().optional(),
    updateable: z.boolean().optional(),
    deletable: z.boolean().optional(),
    customSetting: z.boolean().optional(),
    layoutable: z.boolean().optional(),
    /** The first three characters of its records' ids: what tells the object a link names. */
    keyPrefix: z.string().nullish(),
  })
  .loose();

/** A globally described object, checked. */
export type GlobalObject = z.infer<typeof globalObjectSchema>;

/** Every object of the org a person works in, or only those a person picked. */
export type CheckpointScopeMode = 'everything' | 'picked';

/** Why a checkpoint leaves an object out. */
export type ScopeLeftOutReason =
  /** Its owner asked for it to be left out. */
  | 'excludedByUser'
  /** Picked, and the org has no such object. */
  | 'notFound'
  /** A Chatter post, comment or feed. */
  | 'chatter'
  /** A history object: the org's trace of changes. */
  | 'history'
  /** A sharing object: who may see a record, which the org keeps itself. */
  | 'sharing'
  /** A change event of Change Data Capture. */
  | 'changeEvent'
  /** A big object, an external or Data Cloud object, a Knowledge version or a platform event. */
  | 'unsupportedKind'
  /** A custom setting the take did not name: configuration. */
  | 'customSetting'
  /** Named as a custom setting, and the org has no custom setting of that name. */
  | 'notCustomSetting'
  /** A document of the Documents tab: shared content kept in folders. */
  | 'files'
  /** A file's version or link: held with its file, `ContentDocument`. */
  | 'heldWithFiles'
  /** Users, permissions and the rest of setup, and the org's logs and jobs. */
  | 'setup'
  /** Metadata, which the Tooling API serves: deployed, not kept as data. */
  | 'metadata'
  /** The user may not query, create, edit and delete its records. */
  | 'notWritable'
  /** Its describe could not be read. */
  | 'notDescribed'
  /** No `SystemModstamp`: nothing would tell a record that moved since. */
  | 'noSystemModstamp'
  /**
   * No `IsDeleted`: the org deletes its records for good, with no recycle bin,
   * so nothing would tell one deleted since, nor bring it back.
   */
  | 'noRecycleBin'
  /** The org refuses to read it whole. */
  | 'unreadable'
  /**
   * Without View All Data and Modify All Data, why an object the user is not
   * proven to see and put back whole is left out (`checkpointAccess.ts`).
   * `filesNotProven` and `settingNotProven` are the note's `files` and a
   * custom setting's: `files` already names the Documents tab's.
   */
  | AccessLeftOutReason;

/** An object a checkpoint leaves out, with why. */
export interface ScopeLeftOut {
  objectApiName: string;
  reason: ScopeLeftOutReason;
  /** The org's own words, where it gave any: why it could not be described or read. */
  detail?: string;
}

/** What a checkpoint holds, as the global describe settles it. */
export interface ScopeCandidates {
  mode: CheckpointScopeMode;
  /** The objects to describe, by the names the org gives them. */
  candidates: string[];
  leftOut: ScopeLeftOut[];
  /**
   * In `picked` mode, the objects of {@link HELD_WHEN_PICKED} the scope holds
   * though they were not picked, by the names the org gives them; none in
   * `everything` mode.
   */
  addedToPicked: string[];
}

/** What a person asks a checkpoint to hold. */
export interface ScopeRequest {
  mode: CheckpointScopeMode;
  /** In `picked` mode, the objects picked. */
  objects?: readonly string[];
  /** Objects to leave out, in either mode. */
  excluded?: readonly string[];
  /** The custom settings to hold, by name, or `all`, in either mode; none unless given. */
  customSettings?: Readonly<CheckpointCustomSettings>;
}

/** A file, as the org names its object: held, and its versions and links with it. */
export const FILE_OBJECT = 'ContentDocument';

/** The link of a file to a record, read through the record: held with its file. */
export const FILE_LINK_OBJECT = 'ContentDocumentLink';

/** A file's version, which Salesforce deletes and brings back with its file only. */
export const FILE_VERSION_OBJECT = 'ContentVersion';

/** A file of the old model, hanging from one record: held as a record, its body left out. */
export const ATTACHMENT_OBJECT = 'Attachment';

/**
 * The objects of files that picked objects hold though they were not picked,
 * unless left out by name: a rewind of the picked objects would otherwise
 * leave as they are the files added to their records since.
 */
export const HELD_WHEN_PICKED: readonly string[] = [FILE_OBJECT, ATTACHMENT_OBJECT];

/**
 * Chatter's records that hold what people post. Their names end in no suffix
 * the copy's rule reads — a feed item's ends in `item` — and a post comes
 * back from the recycle bin only with what it was posted on.
 */
const CHATTER_OBJECTS: ReadonlySet<string> = new Set(['feeditem', 'feedcomment', 'feedattachment']);

/**
 * A file's versions and its links to records: held with the file, never as
 * objects of their own. Salesforce neither deletes nor brings back a version
 * on its own (`deletable` and `undeletable` false), and refuses to read the
 * links without naming the file or the record they tie (FA4).
 */
const HELD_WITH_FILES: ReadonlySet<string> = new Set(
  [FILE_VERSION_OBJECT, FILE_LINK_OBJECT].map((name) => name.toLowerCase()),
);

/**
 * Big objects, external objects, Data Cloud objects, Knowledge article
 * versions and their articles, and platform events: none is a record the
 * recycle bin keeps or an update writes back as a rewind needs.
 */
const UNSUPPORTED_SUFFIXES: readonly string[] = ['__b', '__x', '__dlm', '__kav', '__ka', '__e'];

/**
 * The objects the org's own describes say no copy writes
 * (`excludedByDescribe`), and of them those the Tooling API serves, in lower
 * case: the second set words the reason, metadata rather than data the user
 * may not write.
 */
interface DescribedOut {
  out: ReadonlySet<string>;
  tooling: ReadonlySet<string>;
}

/**
 * The objects without a page layout that people still work in, from the
 * related lists of the records they hang from. Every other object the org
 * gives no layout is setup kept as records — permissions, OAuth scopes, CORS
 * entries, email services, licence assignments — which "everything people
 * work in" leaves out: a rewind would take back a permission granted since.
 */
const WORKED_WITHOUT_LAYOUT: ReadonlySet<string> = new Set(
  [
    'AccountContactRole',
    ATTACHMENT_OBJECT,
    'CaseTeamMember',
    'EmailMessageRelation',
    'EventRelation',
    'OpportunityCompetitor',
  ].map((name) => name.toLowerCase()),
);

/**
 * Why a checkpoint leaves `object` out, or nothing when it may hold it. The
 * most telling reason first: a feed is said to be a feed, not setup, though
 * every copy leaves it out too. An object picked by name is held though the
 * org gives it no layout: the person asked for it. So is a custom setting
 * the take names, which needs only that its user may write its rows: the
 * global describe flags it, and no other rule reads it as setup.
 */
function leftOutReason(
  object: GlobalObject,
  described: DescribedOut,
  mode: CheckpointScopeMode,
  namedSetting: boolean,
): ScopeLeftOutReason | undefined {
  const name = object.name.toLowerCase();
  if (CHATTER_OBJECTS.has(name) || name.endsWith('feed')) return 'chatter';
  if (name.endsWith('history') || name.endsWith('__hd')) return 'history';
  if (name.endsWith('share')) return 'sharing';
  if (name.endsWith('changeevent')) return 'changeEvent';
  if (UNSUPPORTED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'unsupportedKind';
  if (object.customSetting === true) {
    if (!namedSetting) return 'customSetting';
    return writableData(object) ? undefined : 'notWritable';
  }
  if (HELD_WITH_FILES.has(name)) return 'heldWithFiles';
  // Every copy leaves both out, a file for its body: a checkpoint holds
  // their records and none of their bodies. A file is held though the data
  // API creates none, as a rewind never makes one.
  if (name === FILE_OBJECT.toLowerCase()) return editable(object) ? undefined : 'notWritable';
  if (name === ATTACHMENT_OBJECT.toLowerCase())
    return writableData(object) ? undefined : 'notWritable';
  if (isFileBodiedObject(object.name)) return 'files';
  if (isNeverCopiedWhenPicked(object.name)) return 'setup';
  if (mode === 'everything' && object.layoutable === false && !WORKED_WITHOUT_LAYOUT.has(name)) {
    return 'setup';
  }
  if (described.out.has(name)) return described.tooling.has(name) ? 'metadata' : 'notWritable';
  return writableData(object) ? undefined : 'notWritable';
}

/** Whether the user may query, create, edit and delete an object's records. */
function writableData(object: GlobalObject): boolean {
  return object.createable === true && editable(object);
}

/**
 * Whether the user may query, edit and delete an object's records: what a
 * rewind does to a file, which it never creates.
 */
function editable(object: GlobalObject): boolean {
  return object.queryable === true && object.updateable === true && object.deletable === true;
}

/** Names in code-unit order, so that the same org gives the same list on any machine. */
function byName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/** The value of {@link ScopeRequest.customSettings} that names every custom setting of the org. */
export const ALL_CUSTOM_SETTINGS = 'all';

/** Whether a global describe lists `object` as a custom setting. */
export function isCustomSetting(object: Pick<GlobalObject, 'customSetting'>): boolean {
  return object.customSetting === true;
}

/**
 * The custom settings `request` names, by the names the org gives them, in
 * lower case; and the names given that are no custom setting of the org.
 */
function namedSettings(
  globalObjects: readonly GlobalObject[],
  named: Readonly<CheckpointCustomSettings> | undefined,
): { held: Set<string>; unknown: string[] } {
  const settings = globalObjects.filter(isCustomSetting);
  if (named === undefined) return { held: new Set(), unknown: [] };
  if (named === ALL_CUSTOM_SETTINGS) {
    return { held: new Set(settings.map((object) => object.name.toLowerCase())), unknown: [] };
  }
  const known = new Set(settings.map((object) => object.name.toLowerCase()));
  const held = new Set<string>();
  const unknown: string[] = [];
  for (const name of named) {
    const key = name.toLowerCase();
    if (held.has(key) || unknown.some((other) => other.toLowerCase() === key)) continue;
    if (known.has(key)) held.add(key);
    else unknown.push(name);
  }
  return { held, unknown };
}

/**
 * The objects a checkpoint describes, and those it leaves out already, from
 * the org's global describe.
 *
 * In `everything` mode every object the global describe lists is either a
 * candidate or left out with its reason; in `picked` mode, every object
 * picked. The same rules hold in both: a feed picked by name is still a feed,
 * and a custom setting is held only when the request names it among its
 * custom settings, which in `picked` mode adds it to the objects picked. A
 * custom setting picked as an object and not named so is left out: the
 * opt-in is the custom settings' own.
 *
 * @param toolingObjects - The names the org's Tooling API serves; none when it could not say.
 */
export function scopeCandidates(
  globalObjects: readonly GlobalObject[],
  request: ScopeRequest,
  toolingObjects: readonly string[] = [],
): ScopeCandidates {
  const described: DescribedOut = {
    out: new Set(
      [...excludedByDescribe(globalObjects, toolingObjects)].map((name) => name.toLowerCase()),
    ),
    tooling: new Set(toolingObjects.map((name) => name.toLowerCase())),
  };
  const excluded = new Set((request.excluded ?? []).map((name) => name.toLowerCase()));
  const byLowerName = new Map(globalObjects.map((object) => [object.name.toLowerCase(), object]));
  const settings = namedSettings(globalObjects, request.customSettings);
  const leftOut: ScopeLeftOut[] = settings.unknown.map((objectApiName) => ({
    objectApiName,
    reason: 'notCustomSetting',
  }));
  const candidates: string[] = [];
  const asked: GlobalObject[] = [];
  const addedToPicked: string[] = [];
  if (request.mode === 'picked') {
    const seen = new Set<string>();
    for (const picked of request.objects ?? []) {
      const key = picked.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const object = byLowerName.get(key);
      if (object) asked.push(object);
      else leftOut.push({ objectApiName: picked, reason: 'notFound' });
    }
    // Only an org that has them, and only when not left out by name: a
    // scope that leaves files out by name keeps the rewind of 1.69, which
    // leaves files added since.
    for (const name of HELD_WHEN_PICKED) {
      const key = name.toLowerCase();
      const object = byLowerName.get(key);
      if (seen.has(key) || excluded.has(key) || object === undefined) continue;
      asked.push(object);
      addedToPicked.push(object.name);
    }
    for (const key of settings.held) {
      const object = byLowerName.get(key);
      if (seen.has(key) || object === undefined) continue;
      seen.add(key);
      asked.push(object);
    }
  } else {
    asked.push(...byLowerName.values());
  }
  for (const object of asked) {
    const key = object.name.toLowerCase();
    const reason = excluded.has(key)
      ? 'excludedByUser'
      : leftOutReason(object, described, request.mode, settings.held.has(key));
    if (reason === undefined) candidates.push(object.name);
    else leftOut.push({ objectApiName: object.name, reason });
  }
  candidates.sort();
  leftOut.sort(byName);
  return { mode: request.mode, candidates, leftOut, addedToPicked };
}

/**
 * What kind of custom setting `described` is: a list when its `Name` is
 * required, a hierarchy otherwise. Both kinds carry `SetupOwnerId` (P-C2: a
 * hierarchy and a list deployed side by side both described it, polymorphic,
 * createable and updateable), so its presence tells nothing. A list's row is
 * known by its name, which it must have — `nillable false`, 38 characters,
 * on the list probed — and a hierarchy's by its owner, its name optional —
 * `nillable true`, 80 characters, on the hierarchy probed. The describe is
 * read already, where the kind as the metadata gives it
 * (`CustomObject.customSettingsType`, through the Tooling API) would cost a
 * request per custom setting. A describe that lists no `Name`, which every
 * custom object has, is read as a list.
 */
export function customSettingKindOf(
  described: Pick<CheckpointDescribe, 'fields'>,
): CheckpointCustomSettingKind {
  const name = described.fields.find((field) => field.name === 'Name');
  return name?.nillable === true ? 'hierarchy' : 'list';
}

/**
 * The field that tells the rows of a custom setting apart, which no two
 * live rows share: a hierarchy's owner — the org, a profile or a user — and
 * a list's name, compared as the org compares it, case and all (P-C2: a list
 * refused `Billing` twice and took `billing` beside it).
 */
export function customSettingKeyOf(kind: CheckpointCustomSettingKind): string {
  return kind === 'hierarchy' ? 'SetupOwnerId' : 'Name';
}

/**
 * Whether a checkpoint holds a custom setting: every act on it then asks for
 * Customize Application (`checkpointGuard`).
 */
export function holdsCustomSettings(checkpoint: {
  objects: ReadonlyArray<Pick<CheckpointObject, 'customSetting'>>;
}): boolean {
  return checkpoint.objects.some((object) => object.customSetting !== undefined);
}

/** An object a checkpoint holds. */
export interface ScopedObject {
  objectApiName: string;
  /** Its place in the reading, children first, from 0. */
  readOrder: number;
  /** The managed package it belongs to, when it belongs to one. */
  namespace?: string;
}

/** A managed package's objects a checkpoint holds. */
export interface ScopePackage {
  namespace: string;
  objects: string[];
}

/** What a checkpoint holds and leaves out, settled. */
export interface CheckpointScope {
  mode: CheckpointScopeMode;
  /** In reading order: children first. */
  objects: ScopedObject[];
  leftOut: ScopeLeftOut[];
  /** The objects of `objects` that belong to a managed package, by package. */
  packages: ScopePackage[];
}

/**
 * The managed package `objectApiName` belongs to: what comes before the first
 * `__` of a name that has another after it, `vlocity_cmt` of
 * `vlocity_cmt__Party__c`. A namespace never holds two underscores in a row;
 * an org's own `Party__c` has one `__`, and no package.
 */
export function namespaceOf(objectApiName: string): string | undefined {
  const parts = objectApiName.split('__');
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

/**
 * `names` children first: each object after every other one whose records
 * point at it, otherwise in the order given — the order a removal deletes
 * them in (`removalOrder`). Read so, a snapshot's row names only parents that
 * existed when the parents were read later, and records are created during a
 * reading far more often than deleted. Where objects point at each other, the
 * order given decides.
 *
 * Read from the child relationships each object's describe lists.
 */
export function childrenFirst(
  names: readonly string[],
  describes: ReadonlyMap<string, CheckpointDescribe>,
): string[] {
  const index = new Map(names.map((name, at) => [name.toLowerCase(), at]));
  /** Per object, by its place in `names`, the objects of `names` it points at. */
  const parentsOf = names.map(() => new Set<number>());
  /** Per object, how many objects not yet placed point at it. */
  const children = names.map(() => 0);
  names.forEach((name, parent) => {
    for (const relationship of describes.get(name)?.childRelationships ?? []) {
      const child = index.get(relationship.childSObject.toLowerCase());
      if (child === undefined || child === parent || parentsOf[child].has(parent)) continue;
      parentsOf[child].add(parent);
      children[parent]++;
    }
  });
  const placed = names.map(() => false);
  const ordered: string[] = [];
  while (ordered.length < names.length) {
    let next = -1;
    let first = -1;
    for (let at = 0; at < names.length; at++) {
      if (placed[at]) continue;
      if (first < 0) first = at;
      if (children[at] === 0) {
        next = at;
        break;
      }
    }
    if (next < 0) next = first;
    placed[next] = true;
    ordered.push(names[next]);
    for (const parent of parentsOf[next]) children[parent]--;
  }
  return ordered;
}

/** {@link CheckpointScope.packages} of `objects`, by package name. */
function packagesOf(objects: readonly ScopedObject[]): ScopePackage[] {
  const packages = new Map<string, string[]>();
  for (const { objectApiName, namespace } of objects) {
    if (namespace === undefined) continue;
    packages.set(namespace, [...(packages.get(namespace) ?? []), objectApiName]);
  }
  return [...packages]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([namespace, names]) => ({ namespace, objects: names.sort() }));
}

/** `names` children first, each with its place and package. */
function scoped(
  names: readonly string[],
  describes: ReadonlyMap<string, CheckpointDescribe>,
): ScopedObject[] {
  return childrenFirst(names, describes).map((objectApiName, readOrder) => {
    const namespace = namespaceOf(objectApiName);
    return { objectApiName, readOrder, ...(namespace === undefined ? {} : { namespace }) };
  });
}

/**
 * The scope settled from the candidates' describes: those the org described
 * with a `SystemModstamp`, children first, and the rest left out with why.
 *
 * @param describes - The candidates' describes, by name.
 * @param describeErrors - Why the org would not describe a candidate, in its words.
 */
export function resolveScope(
  candidates: ScopeCandidates,
  describes: ReadonlyMap<string, CheckpointDescribe>,
  describeErrors: ReadonlyMap<string, string> = new Map(),
): CheckpointScope {
  const leftOut = [...candidates.leftOut];
  const kept: string[] = [];
  for (const name of candidates.candidates) {
    const described = describes.get(name);
    if (!described) {
      const detail = describeErrors.get(name);
      leftOut.push({
        objectApiName: name,
        reason: 'notDescribed',
        ...(detail === undefined ? {} : { detail }),
      });
    } else if (!described.fields.some((field) => field.name === 'SystemModstamp')) {
      leftOut.push({ objectApiName: name, reason: 'noSystemModstamp' });
    } else if (!described.fields.some((field) => field.name === 'IsDeleted')) {
      leftOut.push({ objectApiName: name, reason: 'noRecycleBin' });
    } else {
      kept.push(name);
    }
  }
  const objects = scoped(kept, describes);
  return {
    mode: candidates.mode,
    objects,
    leftOut: leftOut.sort(byName),
    packages: packagesOf(objects),
  };
}

/**
 * `scope` without the objects the org refused to read whole, each left out
 * with the org's words: an object whose every query must name a record, as a
 * file's links must, is named and never fails the checkpoint.
 *
 * Only an answer of the org's belongs here, never a call that did not reach
 * it: an object left out is one a rewind never puts back.
 *
 * @param refused - Per object, why the org refused its unfiltered read.
 */
export function withoutRefusedReads(
  scope: CheckpointScope,
  refused: ReadonlyMap<string, string>,
): CheckpointScope {
  if (refused.size === 0) return scope;
  const leftOut = [...scope.leftOut];
  const objects: ScopedObject[] = [];
  for (const object of scope.objects) {
    const detail = refused.get(object.objectApiName);
    if (detail === undefined) objects.push({ ...object, readOrder: objects.length });
    else leftOut.push({ objectApiName: object.objectApiName, reason: 'unreadable', detail });
  }
  return { ...scope, objects, leftOut: leftOut.sort(byName), packages: packagesOf(objects) };
}
