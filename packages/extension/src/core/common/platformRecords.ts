/**
 * Records the platform owns or makes, and records it refuses to hold twice
 * without saying which one it holds.
 *
 * A copy learns each of these against a real org, and each module used to
 * learn it again for itself: Forge found the direct account-contact relation
 * and the product selling model's key, Frozen Dataset found the order born a
 * draft. One copy of each rule, so the next module that writes records reads
 * it here instead of rediscovering it on a live run.
 */

import {
  SELLING_MODEL_OPTION_OBJECT,
  accountKindRequiring,
  isPersonAccountField,
  leftOutForAccountKind,
} from '@sandforge/shared';
import type { AccountKind, ForgeGraphEdge } from '@sandforge/shared';

// The fields each kind of account takes are the shared package's, where the
// Seed wizard reads them too: the step that sets an account's rules lists
// what the run sends. Exported here for the modules that write accounts.
export { accountKindRequiring, isPersonAccountField, leftOutForAccountKind, type AccountKind };
import { assertSoqlIdentifier, assertSoqlWhere, sanitizeSoqlValue } from './soqlValidator.js';

/** A SOQL query against the target org, answering the rows it read. */
export type SoqlQuery = (soql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** The join Salesforce creates for a contact inserted with an account. */
export const ACCOUNT_CONTACT_RELATION = 'AccountContactRelation';

/** An email, which the platform gives a task of its own as it takes it. */
export const EMAIL_MESSAGE = 'EmailMessage';

/** The object of an email's task. */
export const TASK = 'Task';

/** A task's relation to its who and to its what. */
const TASK_RELATION = 'TaskRelation';

/** An event's relation to its who, to its what, and to each of its invitees. */
const EVENT_RELATION = 'EventRelation';

/** Contacts per `IN` list when the direct relations are looked up. */
const DIRECT_RELATION_CHUNK = 200;

/**
 * Objects the platform keeps unique on a combination of fields, which a
 * refusal names without naming the record. A product selling model is one
 * per selling model type, pricing term and unit: run for real, a clone was
 * refused "a product selling model already exists for this combination", and
 * every price and line pointing at it lost the link.
 */
export const NATURAL_KEYS: Readonly<Record<string, readonly string[]>> = {
  ProductSellingModel: ['SellingModelType', 'PricingTerm', 'PricingTermUnit'],
};

/**
 * Rows of an object the platform writes itself: those whose field holds a
 * value, or every row of the object.
 */
export interface PlatformWrittenRows {
  /** The field that tells them; none when every row of the object is one. */
  readonly field?: string;
  /** Its value on them. */
  readonly value?: string | boolean;
  /** One of them, in words. */
  readonly noun: string;
  /**
   * What the platform writes them from, in words — `the task's WhatId` — when
   * it writes them from a record a copy sends. None for a row it makes of
   * nothing a copy sends.
   */
  readonly from?: string;
}

/**
 * Rows the platform writes itself and refuses from a copy, by object.
 *
 * A tracked change is the org's own record of a change to a tracked field,
 * written as the change is made. Run for real, the clone of an opportunity
 * sent the one feed item it had, a tracked change, and the target refused
 * it: "Cannot directly insert FeedItem with type TrackedChange". The other
 * types the platform generates — a call logged, a record created from the
 * publisher — are ones the API reference asks a copy not to create, not ones
 * it says are refused: a Chatter migration may carry them, so they are left
 * to the insert.
 *
 * A task's what relation is the platform's own record of the task's WhatId,
 * written with the task: in a real source org every one was created the
 * second its task was, by the task's author. Run for real, a frozen load sent
 * the one of an email's task — its `IsWhat` cleared by the dataset's rules —
 * and the target refused it: "RelationId must be a contact or lead when
 * isWhat is false". A task has one what relation, and that one is its
 * WhatId's.
 *
 * An event's what relation is its WhatId's the same way. An event relation
 * takes `IsWhat` at insert and never after, as a task relation does, and in a
 * real sandbox each relation an event held was its who's, written the second
 * the event was last saved, by the event's author, as each task's were: no
 * call wrote them, and no event whose WhatId was empty held a what relation.
 * An event related to an opportunity holds one to the opportunity among its
 * relations, which nothing but its WhatId wrote.
 *
 * An email's relations are the platform's own record of the addresses the
 * email carries. Salesforce generates one for each address of an email
 * inserted with them, and once the email is sent it takes none that differs
 * from them (Salesforce Help: "Operation Is Not Allowed" on insert of
 * EmailMessageRelation). Each email a clone wrote into a sandbox came with the
 * three its addresses make, written the second the email was, by no call of
 * the clone's; a frozen load that sent the email's three from the dataset,
 * their addresses cleared by its rules, had all three refused for want of a
 * RelationId or a RelationAddress.
 */
export const PLATFORM_WRITTEN_ROWS: Readonly<Record<string, readonly PlatformWrittenRows[]>> = {
  FeedItem: [{ field: 'Type', value: 'TrackedChange', noun: 'tracked change' }],
  [TASK_RELATION]: [
    { field: 'IsWhat', value: true, noun: 'what relation', from: "the task's WhatId" },
  ],
  [EVENT_RELATION]: [
    { field: 'IsWhat', value: true, noun: 'what relation', from: "the event's WhatId" },
  ],
  EmailMessageRelation: [{ noun: 'email relation', from: "the email's addresses" }],
};

/**
 * Which rows the platform writes itself `row` is one of, or nothing when a
 * copy may write it. A value is compared as its text: a boolean the API
 * answers as `'true'` is the same value as `true`.
 */
export function writtenByThePlatform(
  objectApiName: string,
  row: Record<string, unknown>,
): PlatformWrittenRows | undefined {
  return PLATFORM_WRITTEN_ROWS[objectApiName]?.find(
    (rows) =>
      rows.field === undefined ||
      (rows.value !== undefined && String(row[rows.field]) === String(rows.value)),
  );
}

/**
 * Why a copy leaves a row it read to the platform: the row is one of the rows
 * the platform writes itself, or it cannot go in without one.
 */
export interface LeftToThePlatform {
  /** The rows the platform writes itself the row is one of, or hangs from. */
  readonly rows: PlatformWrittenRows;
  /**
   * The lookup the row may not leave empty and that names the row it hangs
   * from. None for a row the platform writes itself.
   */
  readonly through?: string;
}

/** How many rows of one object a copy left to the platform, for one reason. */
export interface RowsLeftOut {
  readonly objectApiName: string;
  readonly why: LeftToThePlatform;
  readonly count: number;
}

/** One reason's rows of an object, by id. */
interface LeftOutGroup {
  readonly why: LeftToThePlatform;
  readonly ids: Set<string>;
}

/**
 * The rows a copy leaves to the platform, noted as it reads them: those the
 * platform writes itself (`writtenByThePlatform`), and those that hang from
 * one of them through a lookup they may not leave empty.
 *
 * A comment on a tracked change names, in a lookup it may not leave empty, the
 * feed item it answers, which no copy writes: a copy that reads comments whole
 * reads it with the rest, and it goes to the target without its feed item.
 * Read parents first, a row that hangs from a row left out is left out in
 * turn, and so is what hangs from it. Rows are told apart by their id: a row
 * read twice is counted once.
 */
export class RowsLeftToThePlatform {
  /** Why each row left out was, by its id. */
  private readonly reasons = new Map<string, LeftToThePlatform>();
  /** Per object, the rows left out by reason, in the order first met. */
  private readonly byObject = new Map<string, Map<string, LeftOutGroup>>();

  /**
   * @param rowsOf - Which rows are left out for what they are, before what
   *   hangs from them: by default, those the platform writes itself. A load
   *   of a frozen dataset also leaves out the feed items whose type the
   *   dataset does not carry, which it cannot tell from those.
   */
  constructor(
    private readonly rowsOf: (
      objectApiName: string,
      row: Record<string, unknown>,
    ) => PlatformWrittenRows | undefined = writtenByThePlatform,
  ) {}

  /**
   * Why `row` is left to the platform, noted under `id` — or nothing, when a
   * copy may write it.
   *
   * @param requiredLookups - The lookups the row may not leave empty.
   */
  leaveOut(
    objectApiName: string,
    id: string,
    row: Record<string, unknown>,
    requiredLookups: readonly string[] = [],
  ): LeftToThePlatform | undefined {
    const known = this.reasons.get(id);
    if (known) return known;
    const why = this.reasonFor(objectApiName, row, requiredLookups);
    if (!why) return undefined;
    this.reasons.set(id, why);
    const groups = this.byObject.get(objectApiName) ?? new Map<string, LeftOutGroup>();
    const key = `${why.rows.field}=${why.rows.value}|${why.through ?? ''}`;
    const group = groups.get(key) ?? { why, ids: new Set<string>() };
    group.ids.add(id);
    groups.set(key, group);
    this.byObject.set(objectApiName, groups);
    return why;
  }

  /**
   * The rows of `records` a copy may write, in their order: each of the others
   * is noted with why, by its `Id`.
   *
   * @param requiredLookups - The lookups the rows may not leave empty.
   */
  keep<T extends Record<string, unknown>>(
    objectApiName: string,
    records: readonly T[],
    requiredLookups: readonly string[] = [],
  ): T[] {
    return records.filter(
      (row) => !this.leaveOut(objectApiName, String(row['Id']), row, requiredLookups),
    );
  }

  /** Whether the row of this id was left to the platform. */
  has(id: string): boolean {
    return this.reasons.has(id);
  }

  /** How many rows were left out, per object and reason — of one object when it is named. */
  counts(objectApiName?: string): RowsLeftOut[] {
    const objects =
      objectApiName === undefined
        ? [...this.byObject]
        : [[objectApiName, this.byObject.get(objectApiName)] as const];
    return objects.flatMap(([object, groups]) =>
      [...(groups?.values() ?? [])].map(({ why, ids }) => ({
        objectApiName: object,
        why,
        count: ids.size,
      })),
    );
  }

  private reasonFor(
    objectApiName: string,
    row: Record<string, unknown>,
    requiredLookups: readonly string[],
  ): LeftToThePlatform | undefined {
    const rows = this.rowsOf(objectApiName, row);
    if (rows) return { rows };
    for (const through of requiredLookups) {
      const value = row[through];
      const parent = typeof value === 'string' ? this.reasons.get(value) : undefined;
      if (parent) return { rows: parent.rows, through };
    }
    return undefined;
  }
}

/**
 * What an object's last word says of `count` of its rows left to the
 * platform: `1 tracked change left out: the platform writes them itself`, or
 * `3 email relations left out: the platform writes them itself, from the
 * email's addresses`, or for rows that hang from one, `1 left out: FeedItemId
 * names a tracked change, which the platform writes itself`.
 */
export function leftToThePlatformNote(count: number, why: LeftToThePlatform): string {
  if (why.through) {
    return `${count} left out: ${why.through} names a ${why.rows.noun}, which the platform writes itself`;
  }
  const from = why.rows.from ? `, from ${why.rows.from}` : '';
  return `${count} ${why.rows.noun}${count === 1 ? '' : 's'} left out: the platform writes them itself${from}`;
}

/**
 * The rows a report says `count` rows left to the platform are:
 * `Type=TrackedChange (1 record)`, or `every email relation (3 records)`.
 */
export function leftToThePlatformSummary(count: number, why: LeftToThePlatform): string {
  const records = `${count} record${count === 1 ? '' : 's'}`;
  if (why.through) return `${why.through} → ${why.rows.noun} (${records})`;
  return why.rows.field === undefined
    ? `every ${why.rows.noun} (${records})`
    : `${why.rows.field}=${String(why.rows.value)} (${records})`;
}

/** Why a report says rows left to the platform were not written. */
export function leftToThePlatformReason(why: LeftToThePlatform): string {
  if (why.through) {
    return (
      `Not written: ${why.through} may not be left empty, and the ${why.rows.noun} it names ` +
      'is one the platform writes itself, which no copy sends.'
    );
  }
  return why.rows.from
    ? `Not written: the platform writes each ${why.rows.noun} itself, from ${why.rows.from}.`
    : `Not written: the platform writes each ${why.rows.noun} itself, and refuses one a copy sends.`;
}

/** A lookup the rows of an object may not leave empty, and the objects it can name. */
export interface RequiredLookup {
  readonly name: string;
  readonly referenceTo: readonly string[];
}

/**
 * A rule of {@link PLATFORM_WRITTEN_ROWS} as a SOQL condition: `=` holds for
 * its rows, `!=` for the others. A rule with no field covers every row of the
 * object, and a boolean is a SOQL literal, not a quoted string.
 */
function ruleCondition({ field, value }: PlatformWrittenRows, operator: '=' | '!='): string {
  if (field === undefined) return operator === '=' ? 'Id != null' : 'Id = null';
  const literal =
    typeof value === 'boolean' ? String(value) : `'${sanitizeSoqlValue(value ?? '')}'`;
  return `${assertSoqlIdentifier(field)} ${operator} ${literal}`;
}

/**
 * What a copy sends of an object, as SOQL conditions its filter is joined to
 * with AND: none of the rows the platform writes itself, and none that hang,
 * through a lookup they may not leave empty, from one of those the copy reads
 * of another of its objects. `RowsLeftToThePlatform` leaves them out as the
 * copy reads; these say it before a row is read, so a count or a sample taken
 * with them is of what the copy will send. A Seed Clone's preview counted and
 * sampled every row its filter matched: the tracked changes the clone leaves
 * to the platform, and the comments on them, among the records it said it
 * would clone.
 *
 * One level only: SOQL nests no semi-join in another, so a row that hangs from
 * a row that itself hangs from one the platform writes is left out by the copy
 * and still counted here.
 *
 * @param requiredLookups - The lookups the object's rows may not leave empty.
 * @param copied - Every object of the copy, with the filter it is read by.
 */
export function rowsACopySends(
  objectApiName: string,
  requiredLookups: readonly RequiredLookup[],
  copied: ReadonlyMap<string, string | undefined>,
): string[] {
  const isOneOf = (rows: readonly PlatformWrittenRows[]): string =>
    rows.map((rule) => ruleCondition(rule, '=')).join(' OR ');
  // A field SOQL compares with != includes the rows where it is null, as the
  // copy keeps them.
  const own = (PLATFORM_WRITTEN_ROWS[objectApiName] ?? []).map((rule) => ruleCondition(rule, '!='));
  const hanging = requiredLookups.flatMap((lookup) =>
    lookup.referenceTo.flatMap((parent) => {
      const rows = PLATFORM_WRITTEN_ROWS[parent];
      if (parent === objectApiName || !copied.has(parent) || !rows || rows.length === 0) return [];
      const filter = copied.get(parent);
      const where = filter
        ? `(${assertSoqlWhere(filter)}) AND (${isOneOf(rows)})`
        : `(${isOneOf(rows)})`;
      return [
        `${assertSoqlIdentifier(lookup.name)} NOT IN ` +
          `(SELECT Id FROM ${assertSoqlIdentifier(parent)} WHERE ${where})`,
      ];
    }),
  );
  return [...own, ...hanging];
}

/**
 * Per relation object, what its who can be: a relation to anything else is to
 * its activity's what. An event invites users and resources too.
 */
const WHO_OBJECTS: Readonly<Record<string, ReadonlySet<string>>> = {
  [TASK_RELATION]: new Set(['Contact', 'Lead']),
  [EVENT_RELATION]: new Set(['Contact', 'Lead', 'User', 'Calendar']),
};

/**
 * A task or event relation's row, with `IsWhat` said when the row no longer
 * says it and the record it names does.
 *
 * A frozen dataset's rules clear every field they keep no value of, and a
 * real dataset carried its one task relation with `IsWhat` cleared: sent, it
 * was taken for a relation to a who — "RelationId must be a contact or lead
 * when isWhat is false" — though it named a quote. A relation to anything but
 * a contact or a lead — or, for an event, a user or a resource it invites — is
 * a relation to the activity's what.
 *
 * @param relationObject - The object of the record `RelationId` names, when known.
 */
export function withTheRelationItIs(
  objectApiName: string,
  row: Record<string, unknown>,
  relationObject: string | undefined,
): Record<string, unknown> {
  const whoObjects = WHO_OBJECTS[objectApiName];
  if (!whoObjects) return row;
  const said = row['IsWhat'];
  if (said !== '' && said !== null && said !== undefined) return row;
  if (relationObject === undefined || whoObjects.has(relationObject)) return row;
  return { ...row, IsWhat: true };
}

/** The three characters every case id begins with, in every org. */
const CASE_KEY_PREFIX = '500';

/** `Case` for the id of a case, as the three characters it begins with tell. */
function caseById(id: string): string | undefined {
  return id.startsWith(CASE_KEY_PREFIX) ? 'Case' : undefined;
}

/**
 * Whether an email is on a case — the one kind whose task a copy may name:
 * its `ParentId`, which names nothing but a case, holds one, or its
 * `RelatedToId` names one.
 *
 * An email related to a case through `RelatedToId` alone is on it: inserted
 * with a case there, no `ParentId`, and the task it names, an email goes in,
 * where one related to an account is refused its task,
 * INSUFFICIENT_ACCESS_OR_READONLY. Told by `ParentId` alone, such an email was
 * sent without the task it names.
 *
 * @param objectOf - The object of the record `RelatedToId` holds: by default
 *   the one its id's first three characters tell, and for the reference ids of
 *   a frozen dataset the one the dataset's index knows.
 */
export function emailOnACase(
  row: Record<string, unknown>,
  objectOf: (id: string) => string | undefined = caseById,
): boolean {
  const parent = row['ParentId'];
  if (typeof parent === 'string' && parent !== '') return true;
  const related = row['RelatedToId'];
  return typeof related === 'string' && related !== '' && objectOf(related) === 'Case';
}

/**
 * The lookups of a row, as it is to be sent, that the platform fills in
 * itself and refuses from a copy: an email's task, unless the email is on a
 * case.
 *
 * "ActivityId can only be specified for emails on cases. It's auto-created
 * for other entities" (Object Reference, EmailMessage). Run for real, the
 * clone of an opportunity sent its one email, related to a quote, with the
 * task it names, and the target refused it — INSUFFICIENT_ACCESS_OR_READONLY,
 * "you cannot modify this field" — as it refused the same email from a frozen
 * load; cloned at a cap that left the task out, the email went in.
 */
export function lookupsThePlatformFills(
  objectApiName: string,
  row: Record<string, unknown>,
): string[] {
  return objectApiName === EMAIL_MESSAGE && !emailOnACase(row) ? ['ActivityId'] : [];
}

/**
 * The order emails and tasks are written in, as an edge between the objects a
 * run writes: the emails first, but for those that wait for their task
 * ({@link waitsForItsTask}).
 *
 * The platform writes an email's task itself as it takes the email, when the
 * email is related to a record — none, run for real, for the emails whose
 * related quote the target never got — and refuses the task's id from a copy
 * (`lookupsThePlatformFills`). Written first, the task read from the source
 * would stand beside the platform's: two for one email. Written after, it is
 * found in the target by its email when the platform wrote one
 * ({@link tasksWrittenWithEmails}), and written when it did not.
 *
 * An email on a case names its task from the copy, as a parent, and goes in
 * once the tasks are written. The order is the email's, not the object's: a
 * run that held an email on a case wrote every task first, and the task of
 * each of its other emails related to a record then stood beside the one the
 * platform wrote with it. The order is set here, not left to how the rest of
 * the graph happens to break the tie.
 *
 * @param objects - The objects the run writes; the edge joins two of them only.
 */
export function emailWriteEdges(objects: ReadonlySet<string>): ForgeGraphEdge[] {
  if (!objects.has(EMAIL_MESSAGE) || !objects.has(TASK)) return [];
  return [
    {
      sourceObject: EMAIL_MESSAGE,
      targetObject: TASK,
      relationshipName: `${EMAIL_MESSAGE}Before${TASK}`,
      type: 'lookup',
      required: true,
    },
  ];
}

/**
 * Whether an email goes in after the task it names, rather than before the
 * tasks with the others (`emailWriteEdges`): it is on a case, so it names its
 * task from the copy (`lookupsThePlatformFills`), and it names one. A run that
 * writes tasks after its emails holds such an email back until they are in,
 * when the task it names has an id in the target.
 *
 * @param objectOf - As for {@link emailOnACase}.
 */
export function waitsForItsTask(
  row: Record<string, unknown>,
  objectOf?: (id: string) => string | undefined,
): boolean {
  const task = row['ActivityId'];
  return typeof task === 'string' && task !== '' && emailOnACase(row, objectOf);
}

/** Ids per `IN` list when the target is asked about the records a run wrote. */
const WRITTEN_CHUNK = 200;

/**
 * The task the platform wrote with each of the emails `ids`, by the email's
 * id: the task each names, read from the target once the emails are in. An
 * email the platform gave no task is not listed.
 */
export async function tasksWrittenWithEmails(
  query: SoqlQuery,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < ids.length; i += WRITTEN_CHUNK) {
    const inList = ids
      .slice(i, i + WRITTEN_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(`SELECT Id, ActivityId FROM ${EMAIL_MESSAGE} WHERE Id IN (${inList})`);
    for (const row of rows) {
      const task = row['ActivityId'];
      if (typeof row['Id'] === 'string' && typeof task === 'string' && task !== '') {
        found.set(row['Id'], task);
      }
    }
  }
  return found;
}

/** An account: a person account is one of a person account record type. */
export const ACCOUNT = 'Account';

/** A contact: the platform writes one with each person account. */
export const CONTACT = 'Contact';

/** A person account's lookup at the contact the platform writes with it. */
export const PERSON_CONTACT_FIELD = 'PersonContactId';

/** The flag of an account, and of a contact, that tells a person account's. */
const PERSON_ACCOUNT_FLAG = 'IsPersonAccount';

/**
 * Whether a row read of an account or a contact is a person account's: its
 * `IsPersonAccount`, as the API answers it — a boolean, the text of one, or a
 * number. An org without person accounts has no such field, and none of its
 * rows is one.
 */
export function isPersonAccountRow(row: Record<string, unknown>): boolean {
  const flag = row[PERSON_ACCOUNT_FLAG];
  return flag === true || flag === 'true' || flag === 1;
}

/**
 * The kind a row of an account goes in as.
 *
 * @param row - The row as the source holds it, `IsPersonAccount` included.
 * @param asBusiness - Whether the target takes a person account's row as a business account.
 */
export function accountKindOf(row: Record<string, unknown>, asBusiness: boolean): AccountKind {
  if (!isPersonAccountRow(row)) return 'business';
  return asBusiness ? 'personAsBusiness' : 'person';
}

/**
 * Whether a row of an account that goes in as `kind` is held to a field
 * {@link accountKindRequiring} says `required` of: a person account the target
 * takes as a business one keeps its name, and is held to it.
 */
export function heldToAccountKind(required: 'business' | 'person', kind: AccountKind): boolean {
  return required === 'person' ? kind === 'person' : kind !== 'person';
}

/**
 * The order accounts and contacts are written in, as an edge between the
 * objects a run writes, when the source describes person accounts: the
 * accounts first.
 *
 * The platform writes a person account's contact itself as it takes the
 * account, and links the two by the account's `PersonContactId`, a field
 * neither an insert nor an update sets (Salesforce Help, "Obtain the Contact
 * ID for a Person Account": a person account has an account id and a contact
 * id, the second read as `PersonContactId`). The contact is the account's to
 * create and to delete, though an update may change it: "You can modify a
 * person contact but you can't create or delete a person contact … Instead,
 * delete or modify the account" (SOAP API Developer Guide, "Person Account
 * Record Types"). A copy sent on its own, without its account, would stand as
 * a contact of its own beside the platform's. So the contact of a person
 * account is not sent where the target writes one with the account: written
 * after the accounts, it is found as the platform wrote it
 * (`personContactsOfAccounts`) and linked to it, which written before the
 * accounts it could not be. One the target wrote none for — it has no person
 * accounts, or holds the account as a business one — goes in as a contact of
 * its own. The order is set here, not left to how the rest of the graph
 * happens to break the tie: an account pointing at its key contact puts the
 * two in a cycle.
 *
 * @param objects - The objects the run writes; the edge joins two of them only.
 * @param fieldsOf - The source fields of the objects the run has described:
 *   only an org with person accounts describes the account's lookup at its
 *   contact, or the contact's flag.
 */
export function personAccountWriteEdges(
  objects: ReadonlySet<string>,
  fieldsOf: ReadonlyMap<string, ReadonlyArray<{ readonly name: string }>>,
): ForgeGraphEdge[] {
  if (!objects.has(ACCOUNT) || !objects.has(CONTACT)) return [];
  const described =
    fieldsOf.get(ACCOUNT)?.some((f) => f.name === PERSON_CONTACT_FIELD) === true ||
    fieldsOf.get(CONTACT)?.some((f) => f.name === PERSON_ACCOUNT_FLAG) === true;
  if (!described) return [];
  return [
    {
      sourceObject: ACCOUNT,
      targetObject: CONTACT,
      relationshipName: `${ACCOUNT}Before${CONTACT}`,
      type: 'lookup',
      required: true,
    },
  ];
}

/** The query that reads, for each of the accounts `ids`, the contact the platform wrote with it. */
export function personContactsSoql(ids: readonly string[]): string {
  const inList = ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
  return `SELECT Id, ${PERSON_CONTACT_FIELD} FROM ${ACCOUNT} WHERE Id IN (${inList})`;
}

const PERSON_CONTACTS_SOQL_RE = new RegExp(
  `^SELECT Id, ${PERSON_CONTACT_FIELD} FROM ${ACCOUNT} WHERE Id IN \\((.*)\\)$`,
);

/**
 * The accounts a query of {@link personContactsSoql} asks about, in the order
 * it names them; undefined for any other query. What answers that query in
 * place of the target — a rehearsal, which wrote no account — reads it so.
 */
export function accountsOfPersonContactsSoql(soql: string): string[] | undefined {
  const asked = PERSON_CONTACTS_SOQL_RE.exec(soql);
  if (!asked) return undefined;
  return [...asked[1].matchAll(/'([^']*)'/g)].map(([, id]) => id);
}

/**
 * The contact the platform wrote with each of the accounts `ids`, by the
 * account's id, read from the target once they are in: written by the run, or
 * found there and linked. An account that is no person account has none, and
 * is not listed.
 *
 * That contact is the account's for as long as the account is there. A copy
 * can create none and delete none on its own; the platform deletes it with its
 * account, and it "is the only contact record that can be associated directly
 * with the person account" (SOAP API Developer Guide, "Person Account Record
 * Types": "You can modify a person contact but you can't create or delete a
 * person contact … Instead, delete or modify the account"). A removal of a
 * copy's records, or a reload's purge, never sends its delete: it goes when
 * its account does.
 */
export async function personContactsOfAccounts(
  query: SoqlQuery,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < ids.length; i += WRITTEN_CHUNK) {
    const rows = await query(personContactsSoql(ids.slice(i, i + WRITTEN_CHUNK)));
    for (const row of rows) {
      const contact = row[PERSON_CONTACT_FIELD];
      if (typeof row['Id'] === 'string' && typeof contact === 'string' && contact !== '') {
        found.set(row['Id'], contact);
      }
    }
  }
  return found;
}

/** An opportunity's team member: a user `UserId` names, with a role and an access. */
export const OPPORTUNITY_TEAM_MEMBER = 'OpportunityTeamMember';

/** A share of an opportunity's amount, credited to the team member `SplitOwnerId` names. */
export const OPPORTUNITY_SPLIT = 'OpportunitySplit';

/** The opportunity a team member or a split is of. */
const OPPORTUNITY = 'Opportunity';

/** A split's type, which no copy writes: the target has its own, matched by name. */
const SPLIT_TYPE = 'OpportunitySplitType';

/** A split's lookup at its type. */
const SPLIT_TYPE_FIELD = 'SplitTypeId';

/** Per object of an opportunity's team, the lookup at the user each row is of. */
export const TEAM_USER_FIELD: Readonly<Record<string, string>> = {
  [OPPORTUNITY_TEAM_MEMBER]: 'UserId',
  [OPPORTUNITY_SPLIT]: 'SplitOwnerId',
};

/** Whether rows of `objectApiName` are of an opportunity's team: its members, or its splits. */
export function isOpportunityTeamObject(objectApiName: string): boolean {
  return TEAM_USER_FIELD[objectApiName] !== undefined;
}

/**
 * What the platform writes a row of `objectApiName` with, in the words the
 * line of each object says it: an email's task, a person account's contact,
 * the owner's member and split of an opportunity, the role of the contact an
 * opportunity goes in with.
 */
export function writtenWithWords(objectApiName: string): string {
  if (objectApiName === 'Task') return 'their email';
  if (objectApiName === 'Contact') return 'their person account';
  if (objectApiName === OPPORTUNITY_CONTACT_ROLE) return 'their opportunity, for its contact';
  return 'their opportunity, for its owner';
}

/** A contact's role on an opportunity. */
export const OPPORTUNITY_CONTACT_ROLE = 'OpportunityContactRole';

/**
 * An opportunity's lookup at its primary contact, and a contact role's at its
 * contact: on the opportunity, the contact of its primary contact role, which
 * an insert sets and no update does (createable, not updateable, in a real
 * org's describe).
 */
export const CONTACT_FIELD = 'ContactId';

/** Whether a role row is its opportunity's primary one: `IsPrimary`, as the API answers it. */
const isPrimaryRole = (row: Record<string, unknown>): boolean =>
  row['IsPrimary'] === true || row['IsPrimary'] === 'true';

/**
 * Of the contact roles `rows` a copy read, the one the platform writes itself
 * with each opportunity the copy sends with a contact, by its index in
 * `rows`: of that opportunity and that contact, the primary one first, one an
 * opportunity at most.
 *
 * Learnt in a real org. An opportunity inserted with its `ContactId` is given
 * by the platform, as it is taken, a contact role of that contact, primary,
 * with no role. The clone of an opportunity with its contact and its one
 * contact role — primary, Decision Maker — left the target two: the
 * platform's, written the second the opportunity went in by the user the run
 * writes as, and the run's two seconds later. The source's `ContactId` is the
 * contact of its primary role, so that role is the one the platform's stands
 * for; a role of another contact is no copy of it, and goes in as read.
 *
 * @param rows - The contact roles, as the copy will send them or as read.
 * @param sentWith - The contact an opportunity, named as the rows name it,
 *   goes in with, in the ids the rows give their contacts; nothing for one
 *   sent without one, or that is not the copy's to send.
 */
export function rolesThePlatformWrites(
  rows: readonly Record<string, unknown>[],
  sentWith: (opportunity: string) => string | undefined,
): number[] {
  /** Per opportunity, the index of the row of its contact, the primary one first. */
  const chosen = new Map<string, number>();
  rows.forEach((row, index) => {
    const opportunity = textOf(row, 'OpportunityId');
    const contact = textOf(row, CONTACT_FIELD);
    if (opportunity === undefined || contact === undefined) return;
    const sent = sentWith(opportunity);
    if (sent === undefined || idKey(sent) !== idKey(contact)) return;
    const key = idKey(opportunity);
    const before = chosen.get(key);
    if (before === undefined || (!isPrimaryRole(rows[before]) && isPrimaryRole(row))) {
      chosen.set(key, index);
    }
  });
  return [...chosen.values()].sort((a, b) => a - b);
}

/**
 * The query that reads the contact roles the target holds of the opportunities
 * `ids`, with `fields` besides the ones that pair them with a row.
 */
export function contactRolesSoql(ids: readonly string[], fields: readonly string[] = []): string {
  const pairing = ['Id', 'OpportunityId', CONTACT_FIELD];
  const columns = [...pairing, ...fields.filter((field) => !pairing.includes(field))]
    .map(assertSoqlIdentifier)
    .join(', ');
  return `SELECT ${columns} FROM ${OPPORTUNITY_CONTACT_ROLE} WHERE OpportunityId IN ${inListOf(ids)}`;
}

/**
 * The contact roles the target holds of the opportunities `ids`, read with
 * `fields` besides: a statement per two hundred opportunities.
 */
export async function contactRolesOf(
  query: SoqlQuery,
  ids: readonly string[],
  fields: readonly string[] = [],
): Promise<Array<Record<string, unknown>>> {
  const read: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += WRITTEN_CHUNK) {
    read.push(...(await query(contactRolesSoql(ids.slice(i, i + WRITTEN_CHUNK), fields))));
  }
  return read;
}

/**
 * Of the contact roles `held` the target holds, the one the platform wrote
 * for each row of `paired` — under its opportunity, of its contact, both in
 * the target's ids — by the row's index. A record is one row's only. A row
 * no record is found for is not listed: it goes in as written.
 */
export function platformRolesOf(
  paired: ReadonlyMap<number, { readonly opportunity: string; readonly contact: string }>,
  held: ReadonlyArray<Readonly<Record<string, unknown>>>,
): Map<number, Readonly<Record<string, unknown>>> {
  const free = new Map<string, Array<Readonly<Record<string, unknown>>>>();
  for (const record of held) {
    const id = textOf(record, 'Id');
    const opportunity = textOf(record, 'OpportunityId');
    const contact = textOf(record, CONTACT_FIELD);
    if (!id || !opportunity || !contact) continue;
    const key = `${idKey(opportunity)}:${idKey(contact)}`;
    free.set(key, [...(free.get(key) ?? []), record]);
  }
  const found = new Map<number, Readonly<Record<string, unknown>>>();
  for (const [index, { opportunity, contact }] of paired) {
    const record = free.get(`${idKey(opportunity)}:${idKey(contact)}`)?.shift();
    if (record) found.set(index, record);
  }
  return found;
}

/**
 * The order an opportunity's team members and its splits are written in, as
 * an edge between the objects a run writes: the members first.
 *
 * A split goes in only for a member of the team: in a real org with Team
 * Selling and Splits on, a split of a user not on it was refused —
 * `INVALID_CROSS_REFERENCE_KEY`, "You can't create an Opportunity Split for a
 * user unless they're part of the opportunity team" — and the same split went
 * in once the member was written. Nothing in a split names a member, so the
 * graph orders nothing between the two: a clone wrote the splits first.
 *
 * @param objects - The objects the run writes; the edge joins two of them only.
 */
export function opportunityTeamWriteEdges(objects: ReadonlySet<string>): ForgeGraphEdge[] {
  if (!objects.has(OPPORTUNITY_TEAM_MEMBER) || !objects.has(OPPORTUNITY_SPLIT)) return [];
  return [
    {
      sourceObject: OPPORTUNITY_TEAM_MEMBER,
      targetObject: OPPORTUNITY_SPLIT,
      relationshipName: `${OPPORTUNITY_TEAM_MEMBER}Before${OPPORTUNITY_SPLIT}`,
      type: 'lookup',
      required: true,
    },
  ];
}

/**
 * What the platform writes on the owner's member and splits besides their
 * lookups, as it takes an opportunity: read in a real org with Team Selling
 * and Splits on, the member's role "Opportunity Owner" and its access All; a
 * split, its percentage alone.
 */
export const WRITTEN_BY_THE_PLATFORM: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [OPPORTUNITY_TEAM_MEMBER]: {
    TeamMemberRole: 'Opportunity Owner',
    OpportunityAccessLevel: 'All',
  },
  [OPPORTUNITY_SPLIT]: {},
};

/**
 * Whether what the platform's own member or split holds of `field` is known
 * without reading it: a standard field, which it writes as
 * {@link WRITTEN_BY_THE_PLATFORM} says or leaves empty. A custom field may hold
 * the default value the target gives it, which only the target's record says.
 */
const knownOfThePlatformsRecord = (field: string): boolean => !/__c$/i.test(field);

/**
 * Fields of a team's row a link to the target's record is never said to go
 * without: the platform sets them. A split's percentage and amount follow the
 * splits of the other members — the owner's Revenue split at 100 % went to
 * 60 % once a member's 40 % was written — and a row's currency its
 * opportunity's.
 */
const SET_BY_THE_PLATFORM: ReadonlySet<string> = new Set([
  'SplitPercentage',
  'SplitAmount',
  'CurrencyIsoCode',
]);

/** The query that reads the owner of opportunities, ending with `IN `. */
const OPPORTUNITY_OWNERS_SOQL = `SELECT Id, OwnerId FROM ${OPPORTUNITY} WHERE Id IN `;

/** The query that reads the target's active split types. */
export const ACTIVE_SPLIT_TYPES_SOQL = `SELECT Id, DeveloperName, IsTotalValidated FROM ${SPLIT_TYPE} WHERE IsActive = true`;

/** An `IN` list of `ids`, in parentheses. */
const inListOf = (ids: readonly string[]): string =>
  `(${ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ')})`;

/** The ids an `IN (…)` list names, in its order. */
const idsOfInList = (list: string): string[] =>
  [...list.matchAll(/'([^']*)'/g)].map(([, id]) => id);

/** The query that reads the owner of each of the opportunities `ids`. */
export function opportunityOwnersSoql(ids: readonly string[]): string {
  return `${OPPORTUNITY_OWNERS_SOQL}${inListOf(ids)}`;
}

/**
 * The opportunities a query of {@link opportunityOwnersSoql} asks about, in
 * the order it names them; undefined for any other query. What answers that
 * query in place of the target — a rehearsal, which wrote no opportunity —
 * reads it so.
 */
export function opportunitiesOfOwnersSoql(soql: string): string[] | undefined {
  if (!soql.startsWith(OPPORTUNITY_OWNERS_SOQL)) return undefined;
  const list = soql.slice(OPPORTUNITY_OWNERS_SOQL.length);
  return /^\(.*\)$/.test(list) ? idsOfInList(list) : undefined;
}

/**
 * The query that reads what the target holds of the teams of opportunities —
 * their members, or their splits — with `fields` besides, ending with `IN `.
 */
function teamOfOpportunitiesSoql(objectApiName: string, fields: readonly string[]): string {
  const userField = TEAM_USER_FIELD[objectApiName];
  const lookups = objectApiName === OPPORTUNITY_SPLIT ? [userField, SPLIT_TYPE_FIELD] : [userField];
  return (
    `SELECT ${['Id', 'OpportunityId', ...lookups, ...fields].join(', ')} ` +
    `FROM ${objectApiName} WHERE OpportunityId IN `
  );
}

/** The same query, of the opportunities `ids`. */
export function opportunityTeamSoql(
  objectApiName: string,
  fields: readonly string[],
  ids: readonly string[],
): string {
  return `${teamOfOpportunitiesSoql(objectApiName, fields)}${inListOf(ids)}`;
}

const OPPORTUNITY_TEAM_SOQL_RE =
  /^SELECT Id, OpportunityId, (?:UserId|SplitOwnerId, SplitTypeId)((?:, \w+)*) FROM (OpportunityTeamMember|OpportunitySplit) WHERE OpportunityId IN (\(.*\))$/;

/**
 * The object, the fields besides its lookups and the opportunities a query
 * of {@link opportunityTeamSoql} asks about; undefined for any other query.
 * What answers it in place of the target — a rehearsal — reads it so.
 */
export function opportunityTeamOfSoql(
  soql: string,
): { objectApiName: string; fields: string[]; opportunities: string[] } | undefined {
  const asked = OPPORTUNITY_TEAM_SOQL_RE.exec(soql);
  if (!asked) return undefined;
  const [, tail, objectApiName, list] = asked;
  return {
    objectApiName,
    fields: tail.split(', ').filter((field) => field !== ''),
    opportunities: idsOfInList(list),
  };
}

/** What a copy reads of the two orgs to write an opportunity's team. */
export interface OpportunityTeamOrgs {
  readonly source: SoqlQuery;
  readonly target: SoqlQuery;
  /** The target's record the run wrote, or linked to, for a source id. */
  readonly targetIdOf: (sourceId: string) => string | undefined;
  /** The target's user the run maps a source user to, as it maps the owners of its records. */
  readonly mappedUser: (sourceUserId: string) => string | undefined;
  /**
   * The user a decision of the run gives the user lookup where a row leaves
   * it empty: that of a row of another user the target has no counterpart of,
   * which goes in as that user's, as a row of a mapped user does.
   */
  readonly defaultUser?: string;
  /**
   * The fields besides its lookups the run writes a row with: those a row
   * linked to the target's record is said to go without, when it gives one a
   * value the target's record does not hold.
   */
  readonly written?: readonly string[];
  /**
   * Set by a simulation, which wrote no opportunity: the owner each of them
   * would get in the target, in place of the one read there, and an id of the
   * simulation's own for each record the platform would write with one.
   */
  readonly simulated?: {
    readonly ownerOf: (sourceOwnerId: string) => string;
    readonly idFor: () => string;
  };
}

/** Why a row of an opportunity's team is not written, and the lookup that says it. */
export interface TeamRowNotWritten {
  readonly field: string;
  readonly parentObject: string;
  readonly why: string;
}

/** What a copy does with the rows of an opportunity's team it read. */
export interface OpportunityTeamRows {
  /**
   * The rows to write, each with its lookups as the target has them: its
   * user, and a split's type. Their lookups are none the run's ids map.
   */
  readonly lookups: Map<Record<string, unknown>, Readonly<Record<string, string>>>;
  /**
   * The rows the target holds already, each with the target's id: the
   * owner's member and split the platform wrote with the opportunity, or one
   * the team of an opportunity the target held has. `owners` is set for those
   * of the target opportunity's owner; `notKept` names the fields of
   * {@link OpportunityTeamOrgs.written} the row gives a value the target's
   * record does not hold, which keeps its own. A simulation, which reads no
   * record of the target, names in `unread` those it gives a value whose
   * record it cannot tell: a custom field of the platform's member or split,
   * which may hold the target's default.
   */
  readonly linked: Map<
    Record<string, unknown>,
    {
      readonly id: string;
      readonly owners: boolean;
      readonly notKept: readonly string[];
      readonly unread?: readonly string[];
    }
  >;
  /** The rows not written, each with why. */
  readonly held: Map<Record<string, unknown>, TeamRowNotWritten>;
  /** The rows of `lookups` that go in as the user a decision gives ({@link OpportunityTeamOrgs.defaultUser}). */
  readonly defaulted: Set<Record<string, unknown>>;
}

/** An id as a key that its 15- and its 18-character forms share. */
const idKey = (id: string): string => id.slice(0, 15);

/** The rows of `soql` asked of `ids`, `IN` list by `IN` list: `soql` ends with `IN `. */
async function rowsOfIds(
  query: SoqlQuery,
  soql: string,
  ids: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += WRITTEN_CHUNK) {
    const inList = ids
      .slice(i, i + WRITTEN_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    rows.push(...(await query(`${soql}(${inList})`)));
  }
  return rows;
}

/** Per id, the value of `field` a row read of it holds, by {@link idKey}. */
function byId(rows: readonly Record<string, unknown>[], field: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const row of rows) {
    const value = row[field];
    if (typeof row['Id'] === 'string' && typeof value === 'string' && value !== '') {
      found.set(idKey(row['Id']), value);
    }
  }
  return found;
}

/** The text of a row's field, or nothing. */
const textOf = (row: Record<string, unknown>, field: string): string | undefined => {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/**
 * What a copy does with the team members or the splits of opportunities it
 * read (`objectApiName` says which), whose opportunity it wrote or linked to:
 * each linked to the record the target holds, written with its user and type
 * as the target has them, or held back with why. A row whose opportunity has
 * no record in the target is left to the write, as any row whose parent the
 * run did not write.
 *
 * Learnt in a real org with Team Selling and Splits on. The platform writes,
 * as it takes an opportunity, its owner's team member — role "Opportunity
 * Owner", access All — and its owner's Revenue split at 100 %, and nothing
 * more: no Overlay split. A clone sent both again as it read them, without
 * their user, which no copy writes, and the target refused them:
 * `REQUIRED_FIELD_MISSING [UserId]`, and `INVALID_CROSS_REFERENCE_KEY` "You
 * can't create an Opportunity Split for a user unless they're part of the
 * opportunity team" with `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY` "You can't
 * adjust necessary split percentages from the opportunity owner's split". Sent
 * with the owner's user, the Revenue split is refused, `DUPLICATE_VALUE` "The
 * user has already been entered for that split type", and the member goes in
 * as the platform's own: the insert answers with its id and changes its role.
 *
 * So the row of the source opportunity's owner is that of the target
 * opportunity's owner, which the target is asked for — the user the run
 * writes as, or the one an owner mapping gives — and a row the target holds
 * for the same opportunity, user and type is linked to, never sent. A
 * simulation, which wrote no opportunity, links the owner's member and the
 * owner's split of each type the target holds to a total of 100 %, as the
 * platform writes them. Another user is the one an owner mapping gives, or one
 * of the same id that the target holds active — two sandboxes of one
 * production share their users' ids — or the one a decision of the run gives;
 * a user of none of them is the reason the row is held back. A split's type is
 * the target's active type of the same developer name: sent without it, a
 * split goes in as a Revenue one, and with the source's id it is refused
 * (`INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY`). Whatever gives a row its
 * user, its type is looked up so, and a row of the target opportunity's owner
 * is linked as the owner's is: a decision that gave a rep's Overlay split a
 * user, the split went past the type and in as a Revenue one, taken from the
 * owner's; one that gave a rep's member the owner, the insert answered with
 * the platform's member, counted created.
 *
 * A row linked to is never written: the values it gives the fields the run
 * writes, and the target's record holds others of, are named
 * (`OpportunityTeamRows.linked`), the record keeping its own.
 *
 * A split of another member goes in after the member (`opportunityTeamWriteEdges`),
 * and a Revenue split of one is taken by the platform from the owner's: 40 %
 * written for a member left the owner 60 %, as the source had it.
 */
export async function opportunityTeamOf(
  objectApiName: string,
  rows: readonly Record<string, unknown>[],
  orgs: OpportunityTeamOrgs,
): Promise<OpportunityTeamRows> {
  const team: OpportunityTeamRows = {
    lookups: new Map(),
    linked: new Map(),
    held: new Map(),
    defaulted: new Set(),
  };
  const userField = TEAM_USER_FIELD[objectApiName];
  if (userField === undefined) return team;
  const split = objectApiName === OPPORTUNITY_SPLIT;
  const ofWritten = rows.filter((row) => {
    const opportunity = textOf(row, 'OpportunityId');
    return opportunity !== undefined && orgs.targetIdOf(opportunity) !== undefined;
  });
  if (ofWritten.length === 0) return team;
  const sourceOpportunities = [...new Set(ofWritten.map((row) => String(row['OpportunityId'])))];
  const sourceOwners = byId(
    await rowsOfIds(orgs.source, OPPORTUNITY_OWNERS_SOQL, sourceOpportunities),
    'OwnerId',
  );
  const targetOf = (row: Record<string, unknown>): string =>
    orgs.targetIdOf(String(row['OpportunityId'])) as string;
  const targetOpportunities = [...new Set(ofWritten.map(targetOf))];
  const { simulated } = orgs;
  const targetOwners = simulated
    ? undefined
    : byId(await rowsOfIds(orgs.target, OPPORTUNITY_OWNERS_SOQL, targetOpportunities), 'OwnerId');
  /** The source opportunity's owner of a row, and that owner's counterpart in the target. */
  const ownersOf = (row: Record<string, unknown>): { source?: string; target?: string } => {
    const source = sourceOwners.get(idKey(String(row['OpportunityId'])));
    if (source === undefined) return {};
    return {
      source,
      target: simulated ? simulated.ownerOf(source) : targetOwners?.get(idKey(targetOf(row))),
    };
  };
  const isOwners = (row: Record<string, unknown>): boolean => {
    const user = textOf(row, userField);
    const owner = ownersOf(row).source;
    return user !== undefined && owner !== undefined && idKey(user) === idKey(owner);
  };
  // The other users, asked of the target by their id.
  const others = [
    ...new Set(
      ofWritten.flatMap((row) => {
        const user = textOf(row, userField);
        return user === undefined || isOwners(row) || orgs.mappedUser(user) !== undefined
          ? []
          : [user];
      }),
    ),
  ];
  const sameUsers =
    others.length > 0
      ? new Set(
          (
            await rowsOfIds(
              orgs.target,
              'SELECT Id FROM User WHERE IsActive = true AND Id IN ',
              others,
            )
          ).flatMap((row) => (typeof row['Id'] === 'string' ? [idKey(row['Id'])] : [])),
        )
      : new Set<string>();
  // A split's type, by its developer name in the target.
  const sourceTypes = split
    ? byId(
        await rowsOfIds(orgs.source, `SELECT Id, DeveloperName FROM ${SPLIT_TYPE} WHERE Id IN `, [
          ...new Set(ofWritten.flatMap((row) => textOf(row, SPLIT_TYPE_FIELD) ?? [])),
        ]),
        'DeveloperName',
      )
    : new Map<string, string>();
  const targetTypes = new Map<string, { id: string; total: boolean }>();
  if (split) {
    for (const row of await orgs.target(ACTIVE_SPLIT_TYPES_SOQL)) {
      if (typeof row['Id'] === 'string' && typeof row['DeveloperName'] === 'string') {
        targetTypes.set(row['DeveloperName'], {
          id: row['Id'],
          total: row['IsTotalValidated'] === true || row['IsTotalValidated'] === 'true',
        });
      }
    }
  }
  // The fields a row linked to is said to go without, compared with the
  // target's record: its lookups are the run's to give, and what the platform
  // sets is its own.
  const compared = (orgs.written ?? []).filter(
    (field) =>
      field !== 'Id' &&
      field !== 'OpportunityId' &&
      field !== userField &&
      field !== SPLIT_TYPE_FIELD &&
      !SET_BY_THE_PLATFORM.has(field),
  );
  /** Whether `row` gives `field` a value. */
  const gives = (row: Record<string, unknown>, field: string): boolean => {
    const value = row[field];
    return !(value === undefined || value === null || value === '' || value === false);
  };
  /** Of `fields`, those `row` gives a value the target's record `held` does not hold. */
  const notKeptBy = (
    row: Record<string, unknown>,
    held: Readonly<Record<string, unknown>>,
    fields: readonly string[] = compared,
  ): string[] =>
    fields.filter((field) => gives(row, field) && String(row[field]) !== String(held[field] ?? ''));
  // What the target holds of these opportunities' teams, by opportunity, user and type.
  const held = new Map<string, Record<string, unknown>>();
  const heldKey = (opportunity: string, user: string, type?: string): string =>
    [opportunity, user, type ?? ''].map(idKey).join('|');
  if (!simulated) {
    for (const row of await rowsOfIds(
      orgs.target,
      teamOfOpportunitiesSoql(objectApiName, compared),
      targetOpportunities,
    )) {
      const opportunity = textOf(row, 'OpportunityId');
      const user = textOf(row, userField);
      if (typeof row['Id'] !== 'string' || opportunity === undefined || user === undefined)
        continue;
      held.set(heldKey(opportunity, user, split ? textOf(row, SPLIT_TYPE_FIELD) : undefined), row);
    }
  }
  for (const row of ofWritten) {
    const user = textOf(row, userField);
    if (user === undefined) continue;
    const owners = isOwners(row);
    const targetOwner = ownersOf(row).target;
    let targetUser = owners
      ? targetOwner
      : (orgs.mappedUser(user) ?? (sameUsers.has(idKey(user)) ? user : undefined));
    // Of none of them, a row of another user goes in as the one a decision gives.
    const defaulted = !owners && targetUser === undefined && orgs.defaultUser !== undefined;
    if (defaulted) targetUser = orgs.defaultUser;
    if (targetUser === undefined) {
      team.held.set(row, {
        field: userField,
        parentObject: 'User',
        why: owners
          ? `${userField} names the owner of its opportunity, whose owner in the target could not be read.`
          : `${userField} names a user the target has no counterpart of: a team member and a split ` +
            "go in for the opportunity's owner, which is the owner of its copy in the target, for a " +
            'user an owner mapping gives, or for a user of the same id the target holds active.',
      });
      continue;
    }
    const lookups: Record<string, string> = { [userField]: targetUser };
    let total = false;
    if (split) {
      const sourceType = textOf(row, SPLIT_TYPE_FIELD);
      if (sourceType !== undefined) {
        const name = sourceTypes.get(idKey(sourceType));
        const type = name === undefined ? undefined : targetTypes.get(name);
        if (type === undefined) {
          team.held.set(row, {
            field: SPLIT_TYPE_FIELD,
            parentObject: SPLIT_TYPE,
            why:
              `${SPLIT_TYPE_FIELD} names ${name === undefined ? 'a split type' : `the split type ${name}`}, ` +
              'which the target holds no active one of by that name: sent without it, the split ' +
              'would go in as one of the Revenue type.',
          });
          continue;
        }
        lookups[SPLIT_TYPE_FIELD] = type.id;
        total = type.total;
      }
    }
    const opportunity = targetOf(row);
    // The row of the target opportunity's owner, whoever it was of in the source.
    const ofTheOwner = targetOwner !== undefined && idKey(targetUser) === idKey(targetOwner);
    if (simulated) {
      // The platform writes the owner's member, and the owner's split of each
      // type held to 100 %, with the opportunity. What it writes of a
      // standard field is known; a custom one may hold the target's default,
      // which a simulation does not read: said lost, a region the target
      // defaults to the source's value was one the run then kept.
      if (ofTheOwner && (!split || total)) {
        const unread = compared.filter(
          (field) => !knownOfThePlatformsRecord(field) && gives(row, field),
        );
        team.linked.set(row, {
          id: simulated.idFor(),
          owners: true,
          notKept: notKeptBy(
            row,
            WRITTEN_BY_THE_PLATFORM[objectApiName] ?? {},
            compared.filter(knownOfThePlatformsRecord),
          ),
          ...(unread.length > 0 ? { unread } : {}),
        });
        continue;
      }
    } else {
      const found = held.get(heldKey(opportunity, targetUser, lookups[SPLIT_TYPE_FIELD]));
      if (found !== undefined) {
        team.linked.set(row, {
          id: String(found['Id']),
          owners: ofTheOwner,
          notKept: notKeptBy(row, found),
        });
        continue;
      }
    }
    team.lookups.set(row, lookups);
    if (defaulted) team.defaulted.add(row);
  }
  return team;
}

/**
 * Per relation object, the lookup that names its activity: a task relation's
 * task, an event relation's event.
 */
export const ACTIVITY_OF_RELATION: Readonly<Record<string, string>> = {
  [TASK_RELATION]: 'TaskId',
  [EVENT_RELATION]: 'EventId',
};

/**
 * The task or event relations the target already holds for the activity and
 * the record each payload names, by the index of the payload: none for an
 * object that is neither.
 *
 * The platform writes a task's relations to its WhoId and its WhatId as it
 * writes the task — in a real source org, every relation was created the
 * second its task was, by the task's author, and named the task's who or
 * what — and the relations of an email's task as it writes that task with its
 * email. It writes an event's the same way: in a real sandbox each relation
 * an event held was its who's, written the second the event was last saved,
 * by the event's author. The what relation never goes
 * (`PLATFORM_WRITTEN_ROWS`); a relation to a contact or a lead read from the
 * source is the one the platform wrote when the target holds it, linked to
 * rather than sent twice, and sent when it does not: a task shared with
 * several contacts has a relation to each, and an event one to each it
 * invites. The payloads carry target ids already.
 */
export async function existingActivityRelations(
  query: SoqlQuery,
  objectApiName: string,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const activity = ACTIVITY_OF_RELATION[objectApiName];
  if (activity === undefined) return found;
  const activities = [
    ...new Set(
      records
        .map((r) => r[activity])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (activities.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < activities.length; i += WRITTEN_CHUNK) {
    const inList = activities
      .slice(i, i + WRITTEN_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, ${activity}, RelationId FROM ${objectApiName} WHERE ${activity} IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(`${String(row[activity])}|${String(row['RelationId'])}`, row['Id']);
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r[activity])}|${String(r['RelationId'])}`);
    if (id) found.set(i, id);
  });
  return found;
}

/**
 * Per relation object, the flags a row read from the source can carry and
 * the relation the platform writes for the activity's who does not.
 *
 * An event's who the event also invites holds one relation, a parent and an
 * invitee at once. The platform writes the relation to the who as it writes
 * the event, not an invitee: linked to in place of the row read
 * (`existingActivityRelations`), it left the who uninvited. A task relation
 * carries no such flag.
 */
export const FLAGS_THE_PLATFORM_LEAVES: Readonly<Record<string, readonly string[]>> = {
  [EVENT_RELATION]: ['IsInvitee'],
};

/**
 * Per flag of {@link FLAGS_THE_PLATFORM_LEAVES}, the fields that go back with
 * it: an invitee's answer — whether it accepted or declined, when, and in
 * what words. The relation the platform writes for the who holds none of it:
 * given the flag alone, the invited who had never answered. Described in a
 * real sandbox, the three can be updated, as the flag can.
 */
const FIELDS_THAT_GO_WITH_A_FLAG: Readonly<Record<string, readonly string[]>> = {
  IsInvitee: ['Status', 'Response', 'RespondedDate'],
};

/** The update of one of the target's records: its id, and the fields it sets. */
type RecordUpdate = Record<string, unknown> & { Id: string };

/**
 * Why a field did not go back to a relation when the run's cancel kept its
 * update from the target: not sent, or sent in a write the cancel stopped
 * before it reached the relation.
 */
const CANCELLED_BEFORE_THE_UPDATE = 'the run was cancelled before it was updated';

/** A write of the target's records of one object, one outcome per record. */
export type RelationUpdate = (
  records: RecordUpdate[],
) => Promise<ReadonlyArray<{ readonly success: boolean; readonly errors: readonly string[] }>>;

/**
 * Give each relation linked in place of a row read from the source the flags
 * of {@link FLAGS_THE_PLATFORM_LEAVES} the row carried, each with what goes
 * with it ({@link FIELDS_THAT_GO_WITH_A_FLAG}) where the row holds it: an
 * update of the relation, of the fields the target's describe lets be
 * updated. A flag the describe does not let be updated is left out, and what
 * goes with it too — a relation that is no invitee has no answer to give. A
 * field left out so, or by an update the target refuses, stays as the
 * platform wrote it and is said in the note returned for the object's line;
 * none when everything went back. The relation stays linked either way: its
 * children and the run's count have it. A flag is carried when the row says
 * `true`, as a boolean or as the text a file keeps it as; a field that goes
 * with it, when the row gives it a value. An update that throws reaches the
 * caller, as any other write of its run does.
 *
 * The target takes or refuses the update of a record whole: a Status value
 * the target does not hold, sent with the flag, used to take the flag with
 * it, and the note named both as refused. An update of a flag and its answer
 * that the target refuses goes again a field at a time — the flags first,
 * then each field of the answer to the relations the flags went back to — so
 * the note names the field the target refused, and the rest goes back.
 *
 * The run's cancel is asked before each update, and none is sent once it
 * says so. A field it kept from a relation — its update not sent, or sent in
 * a write the cancel stopped before the relation, which answers for the
 * records it sent only — is said as the cancel's. Told by a short answer
 * alone, such a relation was noted as one the target refused "without saying
 * why", and a cancel that came while a single update was sent went unseen: a
 * refused relation's update went again a field at a time after it. The
 * refusal the target gave is what the note says of it instead. A write that
 * answers for fewer records than it was sent, with no cancel, is followed by
 * none either.
 *
 * @param linked - Each row read, and the id of the relation linked in its place.
 * @param updatable - Whether the target's describe of the object lets a field be updated.
 * @param update - The update of the target's relations.
 * @param stopped - Whether the run was cancelled. Absent, nothing stops the updates.
 */
export async function giveLinkedRelationsTheirFlags(
  objectApiName: string,
  linked: ReadonlyArray<readonly [row: Record<string, unknown>, id: string]>,
  updatable: (field: string) => boolean,
  update: RelationUpdate,
  stopped: () => boolean = () => false,
): Promise<string | undefined> {
  return flagsNotKeptNote(
    await relationsLeftWithoutTheirFlags(objectApiName, linked, updatable, update, stopped),
  );
}

/**
 * How many relations linked in place of a row went without a field, by the
 * field and why: `IsInvitee: the target does not let it be updated`.
 */
export type FlagsNotKept = Map<string, number>;

/**
 * What an object's line says of {@link FlagsNotKept}, a field at a time, or
 * nothing when every field went back.
 */
export function flagsNotKeptNote(
  without: ReadonlyMap<string, number> | undefined,
): string | undefined {
  if (without === undefined || without.size === 0) return undefined;
  return [...without].map(([why, count]) => `${count} linked without ${why}`).join(', ');
}

/**
 * `more` counted into `into`, for an object written in several writes — a
 * table read page by page, rounds of one page — whose line says each field
 * once: said write by write, the line repeated "1 linked without IsInvitee"
 * once per page.
 */
export function withFlagsNotKept(
  into: FlagsNotKept | undefined,
  more: ReadonlyMap<string, number>,
): FlagsNotKept | undefined {
  if (more.size === 0) return into;
  const sum = new Map(into ?? []);
  for (const [why, count] of more) sum.set(why, (sum.get(why) ?? 0) + count);
  return sum;
}

/**
 * {@link giveLinkedRelationsTheirFlags}, with what went without counted
 * rather than said: what a writer of an object in several writes adds up.
 */
export async function relationsLeftWithoutTheirFlags(
  objectApiName: string,
  linked: ReadonlyArray<readonly [row: Record<string, unknown>, id: string]>,
  updatable: (field: string) => boolean,
  update: RelationUpdate,
  stopped: () => boolean = () => false,
): Promise<FlagsNotKept> {
  const flags = FLAGS_THE_PLATFORM_LEAVES[objectApiName] ?? [];
  const fixed = new Set(
    flags
      .flatMap((flag) => [flag, ...(FIELDS_THAT_GO_WITH_A_FLAG[flag] ?? [])])
      .filter((field) => !updatable(field)),
  );
  /** How many relations were left without a field, by the field and why, in the order first met. */
  const without = new Map<string, number>();
  const leftWithout = (field: string, why: string): void => {
    const key = `${field}: ${why}`;
    without.set(key, (without.get(key) ?? 0) + 1);
  };
  /** Each relation given anything back: the flags it gets, and the answer that goes with them. */
  const toGive: Array<{
    Id: string;
    flagsGiven: Record<string, unknown>;
    answer: Record<string, unknown>;
  }> = [];
  for (const [row, id] of linked) {
    const flagsGiven: Record<string, unknown> = {};
    const answer: Record<string, unknown> = {};
    for (const flag of flags.filter((f) => String(row[f]) === 'true')) {
      if (fixed.has(flag)) {
        leftWithout(flag, 'the target does not let it be updated');
        continue;
      }
      flagsGiven[flag] = true;
      for (const field of FIELDS_THAT_GO_WITH_A_FLAG[flag] ?? []) {
        const value = row[field];
        if (value === undefined || value === null || value === '') continue;
        if (fixed.has(field)) leftWithout(field, 'the target does not let it be updated');
        else answer[field] = value;
      }
    }
    if (Object.keys(flagsGiven).length > 0) toGive.push({ Id: id, flagsGiven, answer });
  }
  /** Whether a write answered for fewer records than it was sent: nothing is sent after it. */
  let answeredShort = false;
  /**
   * Send `records`: why each that did not go back did not — the target
   * refused it, or the run's cancel kept it from the target — by its id.
   */
  const send = async (records: RecordUpdate[]): Promise<Map<string, string>> => {
    const refused = new Map<string, string>();
    if (records.length === 0) return refused;
    if (stopped()) {
      for (const record of records) refused.set(record.Id, CANCELLED_BEFORE_THE_UPDATE);
      return refused;
    }
    if (answeredShort) return refused;
    const outcomes = await update(records);
    answeredShort = outcomes.length < records.length;
    // Asked once the write has answered: a cancel that came while it was
    // sent is what kept the records past its answer from the target.
    const cancelled = stopped();
    records.forEach((record, i) => {
      const outcome = outcomes[i];
      if (outcome?.success) return;
      refused.set(
        record.Id,
        outcome === undefined && cancelled
          ? CANCELLED_BEFORE_THE_UPDATE
          : `the target refused the update, ${outcome?.errors[0] ?? 'without saying why'}`,
      );
    });
    return refused;
  };
  /** Each field of each record `refused` names, left without, and why. */
  const noteRefused = (records: readonly RecordUpdate[], refused: Map<string, string>): void => {
    for (const record of records) {
      const why = refused.get(record.Id);
      if (why === undefined) continue;
      for (const field of Object.keys(record).filter((key) => key !== 'Id')) {
        leftWithout(field, why);
      }
    }
  };
  const whole = toGive.map(({ Id, flagsGiven, answer }) => ({ Id, ...flagsGiven, ...answer }));
  const refused = await send(whole);
  // Refused, an update of the flags alone is not sent again: it has no answer
  // to part them from. Nor is any once the run is cancelled: the refusal the
  // target gave is what the note says.
  const again =
    answeredShort || stopped()
      ? []
      : toGive.filter(({ Id, answer }) => refused.has(Id) && Object.keys(answer).length > 0);
  noteRefused(
    whole.filter((record) => !again.some(({ Id }) => Id === record.Id)),
    refused,
  );
  const flagsAlone = again.map(({ Id, flagsGiven }) => ({ Id, ...flagsGiven }));
  const flagsRefused = await send(flagsAlone);
  noteRefused(flagsAlone, flagsRefused);
  const invited = again.filter(({ Id }) => !flagsRefused.has(Id));
  for (const field of new Set(invited.flatMap(({ answer }) => Object.keys(answer)))) {
    const alone = invited
      .filter(({ answer }) => field in answer)
      .map(({ Id, answer }) => ({ Id, [field]: answer[field] }));
    noteRefused(alone, await send(alone));
  }
  return without;
}

/**
 * Objects whose status follows a lifecycle, and the object listing each
 * status with its category. A record is born in the Draft category and moves
 * on afterwards — run for real, an activated order was refused: "for a new
 * order, choose Draft" — and an order takes its products only as a draft.
 */
export const STATUS_LIFECYCLES: Readonly<Record<string, string>> = {
  Order: 'OrderStatus',
  Contract: 'ContractStatus',
};

/**
 * Objects of {@link STATUS_LIFECYCLES} whose records past Draft the platform
 * deletes as they stand, and will not set back to Draft: a removal of a run's
 * records and a reload's purge send their delete with no Draft update before
 * it, and have no status to give back after it. An order past Draft is not
 * one: the platform deletes neither it nor its products until it is a draft
 * again.
 *
 * On a real sandbox, an activated contract set back to Draft was refused —
 * `FAILED_ACTIVATION`, "choisissez un statut du contrat valide et enregistrez
 * vos modifications" — and, still activated, was deleted with the rows
 * hanging from it. The removal and the purge sent that update all the same,
 * the purge asking Production Guard about it first, for a refusal.
 */
export const DELETED_PAST_DRAFT: ReadonlySet<string> = new Set(['Contract']);

/**
 * Objects of {@link STATUS_LIFECYCLES} whose records, past Draft, lock rows of
 * other objects under them: the platform refuses to delete those rows for as
 * long as the record keeps its status. An activated contract the platform
 * deletes with its item prices ({@link DELETED_PAST_DRAFT}). Kept in the
 * shared package: the Forge page says before a run which objects may refuse
 * the removal of its records.
 */
export { LOCKED_PAST_DRAFT, type LockedPastDraft } from '@sandforge/shared';

/**
 * Objects of {@link STATUS_LIFECYCLES} whose records take their status past
 * Draft back only with rows of another object under them, and those rows.
 * Kept in the shared package: the Forge page says before a run what leaving
 * those rows out costs.
 */
export { STATUS_NEEDS_CHILDREN, type ChildrenAStatusNeeds } from '@sandforge/shared';

/** A value as a SOQL literal. */
function soqlLiteral(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${sanitizeSoqlValue(String(value))}'`;
}

/**
 * The direct relations the platform created for the contacts a run inserted,
 * by the index of the payload that describes each.
 *
 * A contact inserted with its account gets its direct relation from the
 * platform, and the relation read from the source is that one: inserted
 * again it is refused — "the contact already has a relationship with this
 * account" — and the refusal names no record to link to. The payloads carry
 * target ids already; a relation is direct when the target holds one for the
 * same account and contact.
 */
export async function directAccountContactRelations(
  query: SoqlQuery,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const contactIds = [
    ...new Set(
      records
        .map((r) => r['ContactId'])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (contactIds.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += DIRECT_RELATION_CHUNK) {
    const inList = contactIds
      .slice(i, i + DIRECT_RELATION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, AccountId, ContactId FROM ${ACCOUNT_CONTACT_RELATION} ` +
        `WHERE IsDirect = true AND ContactId IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(`${String(row['AccountId'])}|${String(row['ContactId'])}`, row['Id']);
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r['AccountId'])}|${String(r['ContactId'])}`);
    if (id) found.set(i, id);
  });
  return found;
}

/**
 * Of the price book entries `ids`, the ones in the standard price book.
 *
 * A standard price goes only once the custom prices of its product have:
 * asked for both in one delete call, the target refuses the standard one with
 * an `UNKNOWN_EXCEPTION` — the insert's rule, run backwards. Learnt by the
 * Frozen purge first, and again by Forge's run removal, which left 33
 * standard prices behind, and the products and options they held, the first
 * time a clone's prices went in one call.
 */
export async function standardPriceIds(
  query: SoqlQuery,
  ids: readonly string[],
): Promise<Set<string>> {
  const standard = new Set<string>();
  for (let i = 0; i < ids.length; i += DIRECT_RELATION_CHUNK) {
    const inList = ids
      .slice(i, i + DIRECT_RELATION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id FROM PricebookEntry WHERE Id IN (${inList}) AND Pricebook2.IsStandard = true`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') standard.add(row['Id']);
    }
  }
  return standard;
}

/** Products per `IN` list when the selling model options are looked up. */
const OPTION_CHUNK = 200;

/**
 * The selling model options the target already holds for the product and
 * selling model a payload names, by the index of the payload.
 *
 * A product sells under a model through one option, and a clone whose
 * product the target already held — linked, not created — finds that option
 * there. Looked up before the insert rather than read from a refusal: which
 * words the platform refuses a second option in is not something a copy
 * should have to learn. The payloads carry target ids already.
 */
export async function existingSellingModelOptions(
  query: SoqlQuery,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const products = [
    ...new Set(
      records
        .map((r) => r['Product2Id'])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (products.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < products.length; i += OPTION_CHUNK) {
    const inList = products
      .slice(i, i + OPTION_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, Product2Id, ProductSellingModelId FROM ${SELLING_MODEL_OPTION_OBJECT} ` +
        `WHERE Product2Id IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(
          `${String(row['Product2Id'])}|${String(row['ProductSellingModelId'])}`,
          row['Id'],
        );
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r['Product2Id'])}|${String(r['ProductSellingModelId'])}`);
    if (id) found.set(i, id);
  });
  return found;
}

/**
 * The one target record holding each payload's natural key, by payload
 * index — or nothing where none, or more than one, does.
 */
export async function recordsByNaturalKey(
  query: SoqlQuery,
  objectApiName: string,
  keyFields: readonly string[],
  payloads: readonly Record<string, unknown>[],
): Promise<Array<string | undefined>> {
  const byKey = new Map<string, string | undefined>();
  for (const payload of payloads) {
    const key = JSON.stringify(keyFields.map((f) => payload[f] ?? null));
    if (byKey.has(key)) continue;
    const where = keyFields
      .map((f) => `${assertSoqlIdentifier(f)} = ${soqlLiteral(payload[f])}`)
      .join(' AND ');
    const rows = await query(
      `SELECT Id FROM ${assertSoqlIdentifier(objectApiName)} WHERE ${where} LIMIT 2`,
    );
    byKey.set(
      key,
      rows.length === 1 && typeof rows[0]['Id'] === 'string' ? rows[0]['Id'] : undefined,
    );
  }
  return payloads.map((p) => byKey.get(JSON.stringify(keyFields.map((f) => p[f] ?? null))));
}

/** A lifecycle's statuses in the target, each with its category. */
export interface StatusCategories {
  /** Status API name → its category (`Draft`, `Activated`, …). */
  categoryOf: Map<string, string>;
  /** One status of the Draft category, when the target has any. */
  draft: string | undefined;
}

/**
 * The target's statuses for a lifecycle object, each with its category, and
 * one status of the Draft category — or nothing, when the target cannot say
 * (the object is not enabled there).
 *
 * The categories are the target's own — `OrderStatus` and `ContractStatus`
 * list every value with its category — so nothing about a customised
 * picklist is guessed.
 */
export async function statusCategories(
  query: SoqlQuery,
  lifecycle: string,
): Promise<StatusCategories | undefined> {
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await query(`SELECT ApiName, StatusCode FROM ${assertSoqlIdentifier(lifecycle)}`);
  } catch {
    return undefined;
  }
  return {
    categoryOf: new Map(rows.map((row) => [String(row['ApiName']), String(row['StatusCode'])])),
    draft: rows
      .filter((row) => row['StatusCode'] === 'Draft')
      .map((row) => String(row['ApiName']))
      .sort()[0],
  };
}

/**
 * The Draft status a record has to be inserted with, when its own status is
 * past Draft — or nothing, when it can go in as it is: no status, a status in
 * the Draft category, one the target does not know (the insert will say), or
 * a target with no Draft status to start from.
 */
export function draftStartOf(status: unknown, categories: StatusCategories): string | undefined {
  if (typeof status !== 'string' || status === '' || !categories.draft) return undefined;
  const category = categories.categoryOf.get(status);
  if (category === undefined || category === 'Draft') return undefined;
  return categories.draft;
}
