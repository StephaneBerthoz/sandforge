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
 * Nor does either act take the org's configuration kept as records of
 * standard objects ({@link isConfiguration}), which a checkpoint holds for
 * a rewind to set back: the emptying of a scratch org would have deleted its
 * 90 flows (`FlowRecord`), their versions, its orchestrations, the settings
 * of its Field Service app and its badge definitions — four of the five
 * objects of a kind whose records no undelete brings back — and a clone
 * writes the settings and badge definitions of its source over the
 * target's.
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
 * - the objects of a managed package stay, as the checkpoint holds them as
 *   data: every other clone leaves an industry package out by its namespace
 *   (`isNeverCopied`), because following a record's reverse lookups pulled
 *   its configuration catalogue in, and a clone of the whole org follows no
 *   lookup — it copies the catalogue as the rest of the org, and writes the
 *   package's objects as any node (`neverCopiedIn` of the executor);
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
import { isNeverCopiedWhenPicked } from './excludedObjects.js';
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

/** Why an act on the whole org leaves an object out: the checkpoint's reasons, and configuration. */
export type WholeOrgLeftOutReason = CandidateLeftOutReason | 'configuration';

/** What an act on the whole org covers of an org, and what it leaves out with why. */
export interface WholeOrgScope extends Omit<ScopeCandidates, 'leftOut'> {
  leftOut: Array<{ objectApiName: string; reason: WholeOrgLeftOutReason; detail?: string }>;
}

/** The ends of the names of standard objects that hold configuration: a setup's settings, a definition. */
const CONFIGURATION_SUFFIXES: readonly string[] = ['settings', 'definition'];

/**
 * The configuration neither the describe nor the name tells, in lower case:
 * the libraries of files (`ContentWorkspace`), an asset library among them,
 * which the org makes itself. Its flags read as a price's — created, edited,
 * deleted, not undeleted, neither searched nor triggered — and a clone of a
 * whole org wrote one, refused for the org's own prefix: "INVALID_INPUT:
 * $sfdc_asset_ DeveloperName prefix is reserved".
 */
const CONFIGURATION_OBJECTS: ReadonlySet<string> = new Set(['contentworkspace']);

/**
 * Whether `object` holds the org's configuration rather than people's
 * records, as its global describe says it, of a standard object alone — an
 * org's own object, and a package's, is data:
 *
 * - the data API creates none of its records, Setup, a builder or Salesforce
 *   making them: a flow (`FlowRecord`) and its versions, an orchestration,
 *   an operation's log. A file is not one: the data API creates none either,
 *   and it is a file;
 * - or its name says it is a setup's settings or a definition: the settings
 *   of the Field Service app (`FieldServiceMobileSettings`), which the data
 *   API creates, and the definitions badges are given from
 *   (`WorkBadgeDefinition`), whose every flag reads as data's;
 * - or it is one of the few the two do not tell ({@link CONFIGURATION_OBJECTS}).
 *
 * A rule rather than a list where the describe allows it: the five such
 * objects of a scratch org's emptying were each read by one of the first
 * two, and of the three a clone of a whole org copied, two. A clone wrote
 * the twelve standard badge definitions again beside the target's own, and
 * the org refused the Field Service settings (`DUPLICATE_VALUE`) and the
 * asset library.
 */
export function isConfiguration(object: GlobalObject): boolean {
  if (object.name.includes('__')) return false;
  const name = object.name.toLowerCase();
  if (CONFIGURATION_OBJECTS.has(name)) return true;
  if (CONFIGURATION_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return object.createable === false && name !== FILE_OBJECT.toLowerCase();
}

/** Names in code-unit order, so that the same org gives the same list on any machine. */
function byObjectName<T extends { objectApiName: string }>(a: T, b: T): number {
  return a.objectApiName < b.objectApiName ? -1 : a.objectApiName > b.objectApiName ? 1 : 0;
}

/**
 * The objects of `org` an act on the whole org covers, and those it leaves
 * out with why, sorted by name: the checkpoint's rule, asked what the act
 * asks of the user, less the org's configuration ({@link isConfiguration}).
 *
 * @param org - The org's global describe: the target of a clone, the org an emptying empties.
 * @param tooling - The names the org's Tooling API serves; none when it could not say.
 */
export function wholeOrgScope(
  org: readonly GlobalObject[],
  tooling: readonly string[],
  act: WholeOrgAct,
  options: WholeOrgScopeOptions = {},
): WholeOrgScope {
  const scope = scopeCandidates(
    org,
    {
      mode: 'everything',
      access: ACCESS_OF[act],
      ...(options.excluded !== undefined ? { excluded: options.excluded } : {}),
      ...(options.customSettings !== undefined ? { customSettings: options.customSettings } : {}),
    },
    tooling,
  );
  const byName = new Map(org.map((object) => [object.name.toLowerCase(), object]));
  const candidates: string[] = [];
  const configuration: WholeOrgScope['leftOut'] = [];
  for (const name of scope.candidates) {
    const object = byName.get(name.toLowerCase());
    if (object !== undefined && isConfiguration(object)) {
      configuration.push({ objectApiName: name, reason: 'configuration' });
    } else {
      candidates.push(name);
    }
  }
  if (configuration.length === 0) return scope;
  return {
    ...scope,
    candidates,
    leftOut: [...scope.leftOut, ...configuration].sort(byObjectName),
  };
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
 * objects the target lacks. The org's configuration is setup, as Review
 * already words what no copy writes. The rule's own word for why is never
 * put in `detail`, which holds a word the page translates or the org's own
 * words.
 */
function reasonOf(reason: WholeOrgLeftOutReason): { reason: ForgeLeftOutReason; detail?: string } {
  switch (reason) {
    case 'configuration':
      return { reason: 'setup' };
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

/**
 * What a clone says of an object the target lets its user query and create
 * but not edit, or not delete: the run's second pass edits what it wrote to
 * fill in the lookups an insert could not, and its removal and a rewind
 * delete it. Said "not writable in the target", a real run left out sixteen
 * objects the target created, an account partner and a flow orchestration's
 * instances among them, on a word that read as one they could not create.
 * `detail` says which of the two is closed, nothing when both are. Nothing
 * when the user may not create its records, or not query them.
 */
function createOnlyReason(
  inTarget: GlobalObject,
): { reason: ForgeLeftOutReason; detail?: string } | undefined {
  if (inTarget.createable !== true || inTarget.queryable !== true) return undefined;
  const edit = inTarget.updateable === true;
  const remove = inTarget.deletable === true;
  if (edit && remove) return undefined;
  if (!edit && !remove) return { reason: 'createOnly' };
  return { reason: 'createOnly', detail: edit ? NO_DELETE : NO_EDIT };
}

/** What `detail` says of an object the target lets the user create and not edit. */
const NO_EDIT = 'noEdit';

/** What `detail` says of an object the target lets the user create and edit, and not delete. */
const NO_DELETE = 'noDelete';

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
    if (said.reason === 'notWritable' && askedCreate && inTarget) {
      said = createOnlyReason(inTarget) ?? said;
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
    } else {
      candidates.push(inSource.name);
    }
  }
  candidates.sort();
  leftOut.sort(byName);
  return { candidates, leftOut };
}
