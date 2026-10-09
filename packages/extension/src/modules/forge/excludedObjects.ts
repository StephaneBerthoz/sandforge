/**
 * Objects no copy discovers or writes.
 *
 * Forge's discovery and its orphan-parent expansion used to keep separate
 * lists that had drifted both ways: expansion would fetch and insert an
 * `AsyncApexJob` or `CronTrigger` discovery refused to walk into, while
 * discovery counted `PermissionSet` rows expansion would never create. One
 * list keeps both stages refusing the same objects.
 *
 * Autopilot is the third caller. It had none of this and walked into whatever
 * a lookup pointed at: a run asked for two objects came back with an
 * `OpportunityHistory` in its plan and the platform answered "entity type
 * cannot be inserted". The rule is about what a copy can carry, not about
 * which module is asking — which is why this is no longer named for one.
 *
 * Metadata is the other half. Autopilot walked from `Product2` into the
 * external data source it may name, from there into its auth provider, the
 * Apex class behind it and the static resources it shows, and from a
 * location's logo into the Content objects — then copied those whole tables.
 * Each real run wrote five static resources whose body was their own URL, a
 * folder and six content assets, and tried twenty-two Apex classes. Metadata
 * is deployed, not copied as data, and an org says which objects are
 * metadata: the Tooling API serves them, and the data API will not create
 * the rest. {@link excludedByDescribe} reads both; the list below keeps what
 * no describe singles out.
 */

import { isFileBodiedObject, isUncopyableObject } from '@sandforge/shared';

/** Hub, system and non-queryable objects excluded by API name. */
const EXCLUDED_OBJECT_NAMES: readonly string[] = [
  'User',
  'Group',
  'Profile',
  'UserRole',
  'RecordType',
  'Organization',
  'Queue',
  'PermissionSet',
  'BusinessProcess',
  'CurrencyType',
  'DandBCompany',
  'DuplicateRecordItem',
  'DuplicateRecordSet',
  'ProcessInstance',
  // Big-org perf killers: SELECT COUNT() on these takes 30s+ each on big
  // sandboxes. They never carry user data worth cloning anyway.
  'LoginHistory',
  'LoginEvent',
  'LoginIp',
  'LoginGeo',
  'AsyncApexJob',
  'ApexLog',
  'ApexTestResult',
  'ApexTestQueueItem',
  'LightningUsageByPageMetrics',
  'LightningExitByPageMetrics',
  'EventBusSubscriber',
  'PlatformEventUsageMetric',
  'CronTrigger',
  'CronJobDetail',
  // Non-queryable virtual objects exposed in describe but unsupported by SOQL
  'AttachedContentDocument',
  'AttachedContentNote',
  'CombinedAttachment',
  'ContentBody',
  'NoteAndAttachment',
  'OwnedContentDocument',
  'EntitySubscription',
  'TopicAssignment',
  'UserRecordAccess',
  'DeclinedEventRelation',
  'UndecidedEventRelation',
  'AcceptedEventRelation',
  'OpenActivity',
  'ActivityHistory',
  // A tag the platform puts on records created through an app such as
  // Revenue Lifecycle Management. Written by a copy onto a quote, it is
  // refused — "you can't modify quotes with an app usage assignment" — and
  // the platform assigns it itself to what it manages.
  'AppUsageAssignment',
  // Setup the describe cannot tell from data: the Tooling API serves neither,
  // the data API creates both, and every flag they carry — not layoutable,
  // not triggerable — is shared by data objects such as a case team member.
  // A real run wrote a folder into the target.
  'AuthProvider',
  'Folder',
  // A file's document and its links to records. The document is created with
  // a file's first version, never on its own, and a link names a document the
  // copy never writes as a record. The files of a clone are copied by a stage
  // of their own, which writes both.
  'ContentDocument',
  'ContentDocumentLink',
];

/*
 * Every name below is matched case-insensitively, as Salesforce matches an
 * object's name and as `isUncopyableObject` already did: Sync's boundary and
 * object picker read this list, and a configuration naming `loginhistory` or
 * `ACCOUNTSHARE` passed both while `user` was refused.
 */

/** {@link EXCLUDED_OBJECT_NAMES} in lower case. */
const EXCLUDED_OBJECTS: ReadonlySet<string> = new Set(
  EXCLUDED_OBJECT_NAMES.map((name) => name.toLowerCase()),
);

/** History, feed, sharing and change-event variants of any object, in lower case. */
const EXCLUDED_SUFFIXES: readonly string[] = [
  'History',
  'Feed',
  'Share',
  'ChangeEvent',
  '__hd',
  '__Tag',
].map((suffix) => suffix.toLowerCase());

/**
 * Managed-package namespaces left out of a clone. Vlocity (`vlocity_ins__`,
 * `vlocity_cmt__`, `vlocity_ps__`) hangs dozens of configuration objects off
 * standard records through reverse lookups; following them from one Case or
 * Account pulls the package's catalogue into a dev sandbox instead of the
 * record's data. Read as a namespace, its `__` included: an org's own
 * `Vlocity__c`, which lower-cased starts the same way, is data.
 */
const EXCLUDED_NAMESPACE = /^vlocity_[a-z0-9]+__/;

/**
 * Whether a copy refuses to discover or write `objectApiName`.
 *
 * @param described - The objects the org's own describes say no copy writes,
 *   from {@link excludedByDescribe}, when the caller read them.
 */
export function isExcludedFromCopy(
  objectApiName: string,
  described?: ReadonlySet<string>,
): boolean {
  return excludedFromCopy(objectApiName, described, { byNamespace: true });
}

/**
 * {@link isExcludedFromCopy}, with or without the managed-package namespaces
 * of {@link EXCLUDED_NAMESPACE}.
 */
function excludedFromCopy(
  objectApiName: string,
  described: ReadonlySet<string> | undefined,
  options: { byNamespace: boolean },
): boolean {
  const name = objectApiName.toLowerCase();
  if (EXCLUDED_OBJECTS.has(name)) return true;
  // A file is no record to clone: read as one, its body comes back as the
  // address of the file, and that address is what the insert would have
  // written. Discovery used to walk into ContentVersion from a quote.
  if (isFileBodiedObject(objectApiName)) return true;
  if (described && (described.has(objectApiName) || lowerCased(described).has(name))) return true;
  if (options.byNamespace && EXCLUDED_NAMESPACE.test(name)) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Each set of names {@link lowerCased} has read, with its size then, in lower case. */
const LOWER_CASED = new WeakMap<ReadonlySet<string>, { size: number; names: Set<string> }>();

/**
 * `names` in lower case, read once per set: discovery asks of every lookup of
 * every object. Read again when the set has grown or shrunk since.
 */
function lowerCased(names: ReadonlySet<string>): ReadonlySet<string> {
  const read = LOWER_CASED.get(names);
  if (read && read.size === names.size) return read.names;
  const lower = new Set([...names].map((name) => name.toLowerCase()));
  LOWER_CASED.set(names, { size: names.size, names: lower });
  return lower;
}

/**
 * Whether no copy ever creates `objectApiName`: the platform will not take it
 * as data, or every copy leaves it out.
 *
 * @param described - As for {@link isExcludedFromCopy}.
 */
export function isNeverCopied(objectApiName: string, described?: ReadonlySet<string>): boolean {
  return isUncopyableObject(objectApiName) || isExcludedFromCopy(objectApiName, described);
}

/**
 * Whether no copy creates `objectApiName` even when a person names it: Sync,
 * whose objects the user picks, and the parents it offers for them.
 *
 * {@link isNeverCopied} without the managed-package namespaces. Those are
 * left out because a discovery that follows reverse lookups from one record
 * pulls the package's catalogue in; an object a person picks, or the parent
 * one of its lookups points at, is no such walk, and a Vlocity party is data
 * like an account. Sync refused it with a message that called it a user, a
 * piece of metadata or a history row, while its command line copied it.
 */
export function isNeverCopiedWhenPicked(objectApiName: string): boolean {
  return (
    isUncopyableObject(objectApiName) ||
    excludedFromCopy(objectApiName, undefined, { byNamespace: false })
  );
}

/** An object as an org's global describe lists it. */
export interface DescribedObject {
  /** API name. */
  readonly name: string;
  /** Whether the data API creates records of it. */
  readonly createable?: boolean;
}

/**
 * The objects an org's own describes say no copy writes: those the Tooling
 * API serves — metadata, deployed rather than inserted — and those the data
 * API will not create.
 *
 * Read from the org rather than listed by hand, because the list is the org's
 * own and grows with its licences: an org with Revenue Cloud serves its
 * pricing procedures and context definitions through the Tooling API, and a
 * hand list would chase every one of them.
 *
 * @param dataObjects - The data API's global describe of the org.
 * @param toolingObjects - The names the org's Tooling API serves; none when it could not say.
 */
export function excludedByDescribe(
  dataObjects: readonly DescribedObject[],
  toolingObjects: readonly string[] = [],
): Set<string> {
  const excluded = new Set(toolingObjects);
  for (const object of dataObjects) {
    if (object.createable === false) excluded.add(object.name);
  }
  return excluded;
}

/** A lookup as a describe gives it: the field, and every object it may point at. */
export interface LookupField {
  /** Field API name. */
  readonly name: string;
  /** The objects the lookup may point at. */
  readonly referenceTo?: readonly string[];
}

/**
 * The lookups among `fields` that can only ever point at an object the copy
 * does not create — `OwnerId` at a `User`, and the other provisioning and
 * metadata objects. None of them can be remapped: no record they point at is
 * ever written. Carried, they send the target an id from the source, which it
 * refuses; left out, the platform fills them in, and `OwnerId` becomes the
 * running user.
 *
 * @param leftOut - Whether the copy leaves an object out; by default, the
 *   objects no copy ever creates.
 */
export function lookupsAtObjectsLeftOut(
  fields: readonly LookupField[],
  leftOut: (objectApiName: string) => boolean = (name) => isNeverCopied(name),
): Set<string> {
  return new Set(
    fields
      .filter((field) => {
        const targets = field.referenceTo ?? [];
        return targets.length > 0 && targets.every((target) => leftOut(target));
      })
      .map((field) => field.name),
  );
}
