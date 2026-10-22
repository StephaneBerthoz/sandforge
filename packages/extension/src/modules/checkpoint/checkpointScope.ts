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
 * - custom settings, which are configuration;
 * - big objects, external objects, Data Cloud objects, Knowledge article
 *   versions and platform events, which neither the recycle bin nor an
 *   update reaches as it reaches a record;
 * - files: a file's contents and versions are no record's values;
 * - and any object the org will not read without a filter, which never fails
 *   the checkpoint.
 *
 * A managed package's objects stay: a party of an industry package is data
 * like an account, and a copy that leaves such a package out does so because
 * following lookups from one record pulled its whole catalogue in, which a
 * checkpoint of every object does not do. They are listed by package.
 */

import * as z from 'zod';
import { isFileBodiedObject } from '@sandforge/shared';
import { excludedByDescribe, isNeverCopiedWhenPicked } from '../forge/excludedObjects.js';
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
  /** A custom setting: configuration. */
  | 'customSetting'
  /** A file, its versions, documents and links, or an attachment. */
  | 'files'
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
  /** The org refuses to read it whole. */
  | 'unreadable';

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
}

/** What a person asks a checkpoint to hold. */
export interface ScopeRequest {
  mode: CheckpointScopeMode;
  /** In `picked` mode, the objects picked. */
  objects?: readonly string[];
  /** Objects to leave out, in either mode. */
  excluded?: readonly string[];
}

/**
 * Chatter's records that hold what people post. Their names end in no suffix
 * the copy's rule reads — a feed item's ends in `item` — and a post comes
 * back from the recycle bin only with what it was posted on.
 */
const CHATTER_OBJECTS: ReadonlySet<string> = new Set(['feeditem', 'feedcomment', 'feedattachment']);

/**
 * A file's document and its links to records: a checkpoint holds no file,
 * nor the objects holding a file's body, which every copy leaves out too.
 */
const FILE_OBJECTS: ReadonlySet<string> = new Set(['contentdocument', 'contentdocumentlink']);

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
 * Why a checkpoint leaves `object` out, or nothing when it may hold it. The
 * most telling reason first: a feed is said to be a feed, not setup, though
 * every copy leaves it out too.
 */
function leftOutReason(
  object: GlobalObject,
  described: DescribedOut,
): ScopeLeftOutReason | undefined {
  const name = object.name.toLowerCase();
  if (CHATTER_OBJECTS.has(name) || name.endsWith('feed')) return 'chatter';
  if (name.endsWith('history') || name.endsWith('__hd')) return 'history';
  if (name.endsWith('share')) return 'sharing';
  if (name.endsWith('changeevent')) return 'changeEvent';
  if (UNSUPPORTED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return 'unsupportedKind';
  if (object.customSetting === true) return 'customSetting';
  if (FILE_OBJECTS.has(name) || isFileBodiedObject(object.name)) return 'files';
  if (isNeverCopiedWhenPicked(object.name)) return 'setup';
  if (described.out.has(name)) return described.tooling.has(name) ? 'metadata' : 'notWritable';
  const writable =
    object.queryable === true &&
    object.createable === true &&
    object.updateable === true &&
    object.deletable === true;
  return writable ? undefined : 'notWritable';
}

/** Names in code-unit order, so that the same org gives the same list on any machine. */
function byName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/**
 * The objects a checkpoint describes, and those it leaves out already, from
 * the org's global describe.
 *
 * In `everything` mode every object the global describe lists is either a
 * candidate or left out with its reason; in `picked` mode, every object
 * picked. The same rules hold in both: a feed picked by name is still a feed.
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
  const leftOut: ScopeLeftOut[] = [];
  const candidates: string[] = [];
  const asked: GlobalObject[] = [];
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
  } else {
    asked.push(...byLowerName.values());
  }
  for (const object of asked) {
    const reason = excluded.has(object.name.toLowerCase())
      ? 'excludedByUser'
      : leftOutReason(object, described);
    if (reason === undefined) candidates.push(object.name);
    else leftOut.push({ objectApiName: object.name, reason });
  }
  candidates.sort();
  leftOut.sort(byName);
  return { mode: request.mode, candidates, leftOut };
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
