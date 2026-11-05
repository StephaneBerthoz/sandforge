/**
 * Who may create an object's records in the target, for an object the user a
 * run writes as may not create: nobody, a user the target would give Create
 * on it, or a user the records it hangs from are open to.
 *
 * A describe's `createable` speaks for the user who asks alone, and
 * `EntityDefinition.IsEverCreatable` says false for a few objects only: a
 * scratch org answers true for its reports, calendars, entitlement processes
 * and approvals' work items, which no user creates as data. A dry run said
 * each such object BLOCKING and asked the target's administrator to tick
 * Create on a report, and the hand list of what every copy leaves out
 * (`excludedObjects.ts`) grew by the name each time a clone met another one.
 *
 * Two facts of the target settle it, read once per run whatever the number of
 * objects:
 * - the objects a permission set can give Create on: the `SobjectType`
 *   picklist of `ObjectPermissions`, one describe. Read on a scratch org, it
 *   lists 3 210 objects, custom objects among them, and none of the reports,
 *   dashboards, apps, tabs, delete events, content setup, calendars,
 *   entitlement processes, clean info, approval processes' records or event
 *   stores. Nor the objects whose access comes from the record they hang from
 *   — an opportunity's products and contact roles, an order's products, a
 *   quote's lines, a price book's entries, a campaign's members — or a task
 *   and an event;
 * - whether the user holds Modify All Data, from `UserPermissionAccess`, as a
 *   checkpoint's guard reads it. Read as an administrator who
 *   holds it, the global describe of the same org says createable every one
 *   of those children, a task and an event. Of the objects it may query and
 *   not create, feeds, histories and sharing aside, 254 are none a permission
 *   set can give Create on, all setup or the platform's own, and 17 are ones
 *   a permission set can, which a feature or licence the org has not turned
 *   on keeps closed: invoices, credit memos, approvals' submissions and work
 *   items, Einstein's insights.
 *
 * Held by a user without Modify All Data, an object no permission set opens
 * may be setup, or a child whose parent they may not edit: the two read the
 * same, and the object stays blocking with what would open it if it is the
 * second.
 */

import type { QueryAnswer } from './TargetAutomationReader.js';

/** The object whose `SobjectType` picklist names what a permission set can give Create on. */
export const OBJECT_PERMISSIONS = 'ObjectPermissions';

/** The field of {@link OBJECT_PERMISSIONS} that names the objects. */
const SOBJECT_TYPE = 'SobjectType';

/** Whether the user who asks holds Modify All Data. */
export const MODIFY_ALL_DATA_SOQL = 'SELECT PermissionsModifyAllData FROM UserPermissionAccess';

/** An API name as it may go in a query. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * Whether any user can ever create the records of the objects named, over the
 * Tooling API: `IsEverCreatable` is false where the platform writes them
 * itself and no user can create one, whatever they are granted — a flow's
 * records, a case's milestones. True says nothing either way: a scratch org
 * answers it for calendars, entitlement processes, approvals' work items and
 * reports, which no user creates as data, and which {@link notCreatableBy}
 * tells from the target's permissions.
 */
export function everCreatableSoql(objectApiNames: readonly string[]): string {
  const names = objectApiNames.map((name) => `'${name}'`).join(', ');
  return (
    'SELECT QualifiedApiName, IsEverCreatable FROM EntityDefinition ' +
    `WHERE QualifiedApiName IN (${names})`
  );
}

/** What the target says of who may be given Create, as far as it answered. */
export interface CreateFacts {
  /**
   * The objects a permission set can give Create on, in lower case; absent
   * when the target would not describe {@link OBJECT_PERMISSIONS}.
   */
  coverable?: ReadonlySet<string>;
  /** Whether the user the run writes as holds Modify All Data; absent when the target did not say. */
  modifyAllData?: boolean;
}

/**
 * Why the user a run writes as may not create an object's records in the
 * target, and so who may:
 * - `platform`: no user ever can, the target's `EntityDefinition` says;
 * - `setup`: no user can, not even one with Modify All Data, as the user
 *   holds it, and no permission set gives Create on it: setup the org keeps
 *   as records, or what the platform writes itself;
 * - `feature`: a permission set can give Create on it, yet the user holds
 *   Modify All Data and still may not: a feature or licence the target has
 *   not turned on for them keeps it closed;
 * - `parent`: no permission set gives Create on it, and the user lacks
 *   Modify All Data: the records it hangs from, which they may not edit, may
 *   open it — or no user can;
 * - `user`: a permission set can give that user Create on it, or the target
 *   did not say who may.
 */
export type NotCreatableBy = 'platform' | 'setup' | 'feature' | 'parent' | 'user';

/**
 * Why the user may not create `objectApiName`'s records, from what the target
 * said. A fact the target did not answer leaves the object to the user: it
 * stays blocking with the grant that opens it, never left out unasked.
 *
 * @param everCreatable - `EntityDefinition.IsEverCreatable`, when answered.
 */
export function notCreatableBy(
  objectApiName: string,
  facts: CreateFacts,
  everCreatable?: boolean,
): NotCreatableBy {
  if (everCreatable === false) return 'platform';
  if (facts.coverable === undefined) return 'user';
  const grantable = facts.coverable.has(objectApiName.toLowerCase());
  if (facts.modifyAllData === true) return grantable ? 'feature' : 'setup';
  return grantable ? 'user' : 'parent';
}

/** Whether no user can create the records of an object so judged: the run leaves it out. */
export function noUserCreates(by: NotCreatableBy): boolean {
  return by === 'platform' || by === 'setup';
}

/** What reads the facts: a describe of an object, and a query, in the target. */
export interface CreateFactsDeps {
  /**
   * The fields of an object as the target describes them, with the active
   * values of a picklist, and whether this call sent the describe.
   */
  describeFields: (
    orgId: string,
    objectApiName: string,
  ) => Promise<{
    fields: ReadonlyArray<{ name: string; picklistValues: readonly string[] }>;
    sent: boolean;
  }>;
  /** A SOQL query on the regular API, every page of it. */
  query: (orgId: string, soql: string) => Promise<QueryAnswer>;
}

/**
 * The target's {@link CreateFacts}: a describe of {@link OBJECT_PERMISSIONS},
 * which a run's describes keep, and one query. A part the target refuses is
 * left out of the facts, and the requests it cost counted.
 */
export async function readCreateFacts(
  deps: CreateFactsDeps,
  orgId: string,
): Promise<{ facts: CreateFacts; requests: number }> {
  let requests = 0;
  const [described, held] = await Promise.allSettled([
    deps.describeFields(orgId, OBJECT_PERMISSIONS),
    deps.query(orgId, MODIFY_ALL_DATA_SOQL),
  ]);
  const facts: CreateFacts = {};
  if (described.status === 'fulfilled') {
    if (described.value.sent) requests++;
    const field = described.value.fields.find((f) => f.name === SOBJECT_TYPE);
    if (field && field.picklistValues.length > 0) {
      facts.coverable = new Set(field.picklistValues.map((name) => name.toLowerCase()));
    }
  } else {
    requests++;
  }
  if (held.status === 'fulfilled') {
    requests += held.value.requests;
    const row = held.value.records[0];
    if (row && typeof row.PermissionsModifyAllData === 'boolean') {
      facts.modifyAllData = row.PermissionsModifyAllData;
    }
  } else {
    requests++;
  }
  return { facts, requests };
}

/**
 * What the target's `EntityDefinition` says of whether any user can ever
 * create the objects named, by their names in lower case: one Tooling query.
 * Unanswered, it says nothing of any.
 */
export async function readEverCreatable(
  toolingQuery: (orgId: string, soql: string) => Promise<QueryAnswer>,
  orgId: string,
  objectApiNames: readonly string[],
): Promise<{ answered: Map<string, boolean>; requests: number }> {
  const answered = new Map<string, boolean>();
  const names = objectApiNames.filter((name) => API_NAME_RE.test(name));
  if (names.length === 0) return { answered, requests: 0 };
  try {
    const answer = await toolingQuery(orgId, everCreatableSoql(names));
    for (const row of answer.records) {
      const name = row.QualifiedApiName;
      if (typeof name === 'string' && typeof row.IsEverCreatable === 'boolean') {
        answered.set(name.toLowerCase(), row.IsEverCreatable);
      }
    }
    return { answered, requests: answer.requests };
  } catch {
    return { answered, requests: 1 };
  }
}

/**
 * Why the user may not create each of the objects named in an org, by name:
 * the target's EntityDefinition for them, one request, and its facts, which
 * `createFacts` keeps. What the metadata comparison of Review and a command
 * refusing a root ask.
 */
export function whyNotCreatableOver(
  toolingQuery: (orgId: string, soql: string) => Promise<QueryAnswer>,
  createFacts: (orgId: string) => Promise<CreateFacts>,
): (orgId: string, objectApiNames: readonly string[]) => Promise<Map<string, NotCreatableBy>> {
  return async (orgId, objectApiNames) => {
    const [facts, ever] = await Promise.all([
      createFacts(orgId).catch((): CreateFacts => ({})),
      readEverCreatable(toolingQuery, orgId, objectApiNames),
    ]);
    return new Map(
      objectApiNames.map((name) => [
        name,
        notCreatableBy(name, facts, ever.answered.get(name.toLowerCase())),
      ]),
    );
  };
}

/** A field of the object, as far as {@link parentsToEdit} reads it. */
export interface ParentField {
  name: string;
  type: string;
  nillable: boolean;
  referenceTo: readonly string[];
}

/**
 * The objects whose Edit would let the user create an object no permission
 * set opens: those its required lookups point at that a permission set can
 * give Edit on. An opportunity's product names its opportunity and its price
 * book entry; only the first is one a permission set opens, and Edit on it is
 * what Salesforce asks of a user who adds products to an opportunity. None
 * when the target would not say what a permission set covers.
 */
export function parentsToEdit(fields: readonly ParentField[], facts: CreateFacts): string[] {
  const coverable = facts.coverable;
  if (!coverable) return [];
  const parents = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'reference' || field.nillable) continue;
    for (const target of field.referenceTo) {
      if (coverable.has(target.toLowerCase())) parents.add(target);
    }
  }
  return [...parents];
}

/**
 * {@link readCreateFacts} read once per org for `ttlMs`, the time a run's
 * describes are kept: Review compares the two orgs' metadata and reads the
 * target's gaps at the same moment, and both ask. A read that fails is not
 * kept.
 */
export function createFactsOnce(
  read: (orgId: string) => Promise<CreateFacts>,
  ttlMs: number,
  now: () => number = Date.now,
): (orgId: string) => Promise<CreateFacts> {
  const kept = new Map<string, { at: number; facts: Promise<CreateFacts> }>();
  return (orgId) => {
    const held = kept.get(orgId);
    if (held && now() - held.at < ttlMs) return held.facts;
    const facts = read(orgId);
    kept.set(orgId, { at: now(), facts });
    facts.catch(() => {
      if (kept.get(orgId)?.facts === facts) kept.delete(orgId);
    });
    return facts;
  };
}
