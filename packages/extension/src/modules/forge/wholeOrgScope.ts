/**
 * The objects an act on a whole org covers, and those it leaves out with
 * why: a clone of the whole source org into a target, or the emptying of an
 * org, settled from the orgs' global describes.
 *
 * One rule decides what "everything people work in" is: the checkpoint's
 * (`scopeCandidates`, mode `everything`). It leaves out setup, the org's
 * bookkeeping (history, sharing, feeds, change events), the records only
 * Salesforce creates, the kinds of objects no insert writes as a record and
 * what the Tooling API serves, and it asks of each object what the act needs
 * of the user. A clone asks that the user may query, create, edit and delete
 * its records in the target: create for the insert, edit for the second pass
 * that fills in the lookups an insert could not, delete for a rewind. An
 * emptying asks that they may query and delete them. A second rule beside
 * the checkpoint's would drift from it: a rewind of the clone would meet
 * objects the take before it never held, and a clone into an org just
 * emptied would write objects the emptying had left as they were.
 *
 * As a checkpoint, neither act takes a custom setting unless asked to by
 * name or with all of them: a custom setting is configuration — an
 * integration's endpoint, a switch an admin flipped — and a clone of a
 * production writes no endpoint of its into a sandbox unasked.
 *
 * What a clone adds to the rule ({@link wholeOrgCandidates}):
 *
 * - files are not objects of their own: a file, its versions, its links to
 *   records and an attachment of the old model are copied with the records
 *   they hang on by the run's pass over files, never as nodes of the graph;
 * - the source has its say too: an object the target has and the source does
 *   not let the user query is left out, and so is one only the source has.
 *   An object only the target has is no object of the source's, and is not
 *   listed at all;
 * - an object every Forge clone leaves out (`isNeverCopied`) stays out, the
 *   objects of the industry packages whose configuration catalogue a clone
 *   never copies among them: the checkpoint holds those as data;
 * - the target says who may create what its user may not
 *   (`targetCreators.ts`): an object no user can create there, not even
 *   with Modify All Data, is setup, never one an administrator is asked to
 *   open, and one a feature not turned on or a parent's access keeps closed
 *   says so.
 */

import type {
  CheckpointCustomSettings,
  ForgeLeftOutObject,
  ForgeLeftOutReason,
} from '@sandforge/shared';
import {
  ATTACHMENT_OBJECT,
  FILE_OBJECT,
  scopeCandidates,
  type CandidateLeftOutReason,
  type GlobalObject,
  type ScopeAccess,
  type ScopeCandidates,
} from '../checkpoint/checkpointScope.js';
import { isNeverCopied, isNeverCopiedWhenPicked } from './excludedObjects.js';
import { notCreatableBy, type CreateFacts, type NotCreatableBy } from './targetCreators.js';

/** What is done to every object of an org: a clone of the whole source org into it, or its emptying. */
export type WholeOrgAct = 'clone' | 'empty';

/** What each act asks of the user on an object it covers. */
const ACCESS_OF: Readonly<Record<WholeOrgAct, ScopeAccess>> = { clone: 'write', empty: 'delete' };

/** What a person narrows an act on the whole org by. */
export interface WholeOrgScopeOptions {
  /** Objects left out by name. */
  excluded?: readonly string[];
  /** The custom settings to take, by name, or `all`; none unless given. */
  customSettings?: Readonly<CheckpointCustomSettings>;
}

/**
 * The objects of `org` an act on the whole org covers, and those it leaves
 * out with why, sorted by name: the checkpoint's rule, asked what the act
 * asks of the user.
 *
 * @param org - The org's global describe: the target of a clone, the org an emptying empties.
 * @param tooling - The names the org's Tooling API serves; none when it could not say.
 */
export function wholeOrgScope(
  org: readonly GlobalObject[],
  tooling: readonly string[],
  act: WholeOrgAct,
  options: WholeOrgScopeOptions = {},
): ScopeCandidates {
  return scopeCandidates(
    org,
    {
      mode: 'everything',
      access: ACCESS_OF[act],
      ...(options.excluded !== undefined ? { excluded: options.excluded } : {}),
      ...(options.customSettings !== undefined ? { customSettings: options.customSettings } : {}),
    },
    tooling,
  );
}

/**
 * The objects of files a checkpoint holds as records and a clone copies with
 * the records they hang on, in lower case: their versions and links already
 * come out of the checkpoint's rule as held with their file.
 */
const COPIED_WITH_THEIR_RECORDS: ReadonlySet<string> = new Set(
  [FILE_OBJECT, ATTACHMENT_OBJECT].map((name) => name.toLowerCase()),
);

/**
 * What `detail` says of a file left out as an object because the run copies
 * it with the records it hangs on: a word the page translates, as
 * `noLayout`, rather than a sentence in one language.
 */
const WITH_THEIR_RECORDS = 'withTheirRecords';

/** What `detail` says of setup left out because the org gives it no page layout. */
const NO_LAYOUT = 'noLayout';

/**
 * The reason a clone gives for what the checkpoint's rule left out. Each
 * reason the rule can give is named here, none passed over to a reason it
 * is not: an object said to be one the user may not write would have the
 * target's administrator asked to grant what no grant opens.
 *
 * A file's version or link is copied with its file, and so with the records
 * the file hangs on. An object picked and not found, which a whole org never
 * picks, and a custom setting named that the target holds none of, are
 * objects the target lacks. The rule's own word for why is never put in
 * `detail`, which holds a word the page translates or the org's own words.
 */
function reasonOf(reason: CandidateLeftOutReason): { reason: ForgeLeftOutReason; detail?: string } {
  switch (reason) {
    case 'chatter':
    case 'history':
    case 'sharing':
    case 'changeEvent':
    case 'unsupportedKind':
    case 'customSetting':
    case 'files':
    case 'setup':
    case 'platformCreated':
    case 'metadata':
    case 'notWritable':
    case 'excludedByUser':
      return { reason };
    case 'heldWithFiles':
      return { reason: 'files', detail: WITH_THEIR_RECORDS };
    case 'notFound':
    case 'notCustomSetting':
      return { reason: 'missingInTarget' };
  }
}

/**
 * What a clone says of an object the user may not create in the target, by
 * who may (`notCreatableBy`): no user, as setup or the platform's own; or a
 * user the target would open it to, with what opens it where a grant to
 * this user would not.
 */
function notCreatableReason(by: NotCreatableBy): { reason: ForgeLeftOutReason; detail?: string } {
  switch (by) {
    case 'platform':
      return { reason: 'platformCreated' };
    case 'setup':
      return { reason: 'setup' };
    case 'feature':
    case 'parent':
      return { reason: 'notWritable', detail: by };
    case 'user':
      return { reason: 'notWritable' };
  }
}

/** Names in code-unit order, so that the same orgs give the same list on any machine. */
function byName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/**
 * The objects of the source a clone of the whole org counts, and those it
 * leaves out, each with why, sorted by name; each object of the source once.
 *
 * A candidate is named as the source names it: its records are read there.
 * It still has to hold records to become a node, which counting says.
 *
 * @param source - The source org's global describe.
 * @param target - The target org's global describe.
 * @param targetTooling - The names the target's Tooling API serves; none when it could not say.
 * @param options - What the clone is narrowed by, and what the target said of
 *   who may be given Create on an object (`readCreateFacts`); without those
 *   facts, an object its user may not create is one they may not write.
 */
export function wholeOrgCandidates(
  source: readonly GlobalObject[],
  target: readonly GlobalObject[],
  targetTooling: readonly string[],
  options: WholeOrgScopeOptions & { createFacts?: CreateFacts } = {},
): { candidates: string[]; leftOut: ForgeLeftOutObject[] } {
  const scope = wholeOrgScope(target, targetTooling, 'clone', options);
  const sourceByName = new Map(source.map((object) => [object.name.toLowerCase(), object]));
  const targetByName = new Map(target.map((object) => [object.name.toLowerCase(), object]));
  const candidates: string[] = [];
  const leftOut: ForgeLeftOutObject[] = [];
  /** The objects of the source already listed, in lower case. */
  const listed = new Set<string>();
  const leave = (objectApiName: string, reason: ForgeLeftOutReason, detail?: string): void => {
    listed.add(objectApiName.toLowerCase());
    leftOut.push({ objectApiName, reason, ...(detail !== undefined ? { detail } : {}) });
  };

  for (const object of source) {
    if (!targetByName.has(object.name.toLowerCase())) leave(object.name, 'missingInTarget');
  }
  for (const out of scope.leftOut) {
    const key = out.objectApiName.toLowerCase();
    const inSource = sourceByName.get(key);
    if (!inSource || listed.has(key)) continue;
    const inTarget = targetByName.get(key);
    let said = reasonOf(out.reason);
    // A file is asked no Create, the data API creating none: the rule asks
    // it to be edited and deleted alone.
    const askedCreate = key !== FILE_OBJECT.toLowerCase();
    if (
      said.reason === 'notWritable' &&
      askedCreate &&
      inTarget?.createable !== true &&
      options.createFacts
    ) {
      said = notCreatableReason(notCreatableBy(inSource.name, options.createFacts));
    }
    // The rule reads a feed or a setup object by its name before it reads
    // the layout, so setup said of an object no name rule leaves out is the
    // org giving it no page layout.
    const noLayout =
      out.reason === 'setup' &&
      inTarget?.layoutable === false &&
      !isNeverCopiedWhenPicked(out.objectApiName);
    leave(inSource.name, said.reason, noLayout ? NO_LAYOUT : (said.detail ?? out.detail));
  }
  for (const name of scope.candidates) {
    const key = name.toLowerCase();
    const inSource = sourceByName.get(key);
    if (!inSource) continue;
    if (inSource.queryable !== true) {
      leave(inSource.name, 'notQueryable');
    } else if (COPIED_WITH_THEIR_RECORDS.has(key)) {
      leave(inSource.name, 'files', WITH_THEIR_RECORDS);
    } else if (isNeverCopied(inSource.name)) {
      leave(inSource.name, 'neverCopied');
    } else {
      candidates.push(inSource.name);
    }
  }
  candidates.sort();
  leftOut.sort(byName);
  return { candidates, leftOut };
}
