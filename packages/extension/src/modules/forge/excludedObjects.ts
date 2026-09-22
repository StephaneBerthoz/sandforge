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
 */

/** Hub, system and non-queryable objects excluded by exact API name. */
const EXCLUDED_OBJECTS: ReadonlySet<string> = new Set([
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
]);

/** History, feed, sharing and change-event variants of any object. */
const EXCLUDED_SUFFIXES: readonly string[] = [
  'History',
  'Feed',
  'Share',
  'ChangeEvent',
  '__hd',
  '__Tag',
];

/**
 * Managed-package namespaces left out of a clone. Vlocity (`vlocity_ins__`,
 * `vlocity_cmt__`, `vlocity_ps__`) hangs dozens of configuration objects off
 * standard records through reverse lookups; following them from one Case or
 * Account pulls the package's catalogue into a dev sandbox instead of the
 * record's data.
 */
const EXCLUDED_PREFIXES: readonly string[] = ['vlocity_'];

/** Whether a copy refuses to discover or write `objectApiName`. */
export function isExcludedFromCopy(objectApiName: string): boolean {
  if (EXCLUDED_OBJECTS.has(objectApiName)) return true;
  if (EXCLUDED_PREFIXES.some((prefix) => objectApiName.startsWith(prefix))) return true;
  return EXCLUDED_SUFFIXES.some((suffix) => objectApiName.endsWith(suffix));
}
