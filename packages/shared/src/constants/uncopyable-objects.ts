/**
 * Objects no module of SandForge can copy into a target org, and why.
 *
 * Every module that picks objects to copy asked Salesforce the same question —
 * "is it queryable and createable?" — and every module got the same wrong
 * answer. `User` is createable, so Autopilot put 39 of them in a run's first
 * wave and its executor called `insert` on them; a user costs a licence and a
 * globally unique username, so the node fails and everything downstream is left
 * remapping foreign keys onto records that were never created. Sync learnt this
 * first and grew a private list; the scanner in Autopilot and the two object
 * pickers in Seed never did.
 *
 * The two reasons are kept apart because their scope is not the same. A file
 * object could be copied by a module that learns to move a base64 body; an
 * object the platform refuses to create through the data API never can.
 *
 * Names are matched case-insensitively, as Salesforce matches them.
 */

/**
 * The platform will not create these through the data API, whatever
 * `describeGlobal` reports about them.
 *
 * `User` and `UserRole` are provisioning, not data: a licence and a unique
 * username each. `Profile`, `PermissionSet` and `RecordType` are metadata,
 * deployed rather than inserted. `Group` and `Queue` are sharing configuration
 * that carries its own membership rules.
 */
const NOT_CREATABLE_AS_DATA: ReadonlySet<string> = new Set([
  'user',
  'userrole',
  'profile',
  'permissionset',
  'permissionsetassignment',
  'recordtype',
  'group',
  'groupmember',
  'queue',
]);

/**
 * Objects whose content is a file held in a base64 body.
 *
 * No copy moves one as a record, and Bulk API 2.0 rejects base64 — so a run
 * carrying one failed past the bulk threshold, after the REST path had already
 * written. A Forge run asked to copy files reads each body and writes it in a
 * stage of its own, after the records the file hangs on.
 */
const FILE_BODIED: ReadonlySet<string> = new Set(['attachment', 'contentversion', 'document']);

/** Whether the platform refuses to create `objectApiName` through the data API. */
export function isProvisioningObject(objectApiName: string): boolean {
  return NOT_CREATABLE_AS_DATA.has(objectApiName.toLowerCase());
}

/** Whether `objectApiName` keeps its content in a file body no stage moves. */
export function isFileBodiedObject(objectApiName: string): boolean {
  return FILE_BODIED.has(objectApiName.toLowerCase());
}

/**
 * Whether a copy — a sync, a forge, a seed, an autopilot run — must leave
 * `objectApiName` alone. Either reason is enough.
 */
export function isUncopyableObject(objectApiName: string): boolean {
  return isProvisioningObject(objectApiName) || isFileBodiedObject(objectApiName);
}

/** Every name either rule covers, lower-cased. For messages and for tests. */
export const UNCOPYABLE_OBJECT_NAMES: readonly string[] = [
  ...NOT_CREATABLE_AS_DATA,
  ...FILE_BODIED,
].sort();
