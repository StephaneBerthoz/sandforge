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

import { SELLING_MODEL_OPTION_OBJECT } from '@sandforge/shared';
import type { ForgeGraphEdge } from '@sandforge/shared';
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
export const TASK_RELATION = 'TaskRelation';

/** An event's relation to its who, to its what, and to each of its invitees. */
export const EVENT_RELATION = 'EventRelation';

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

/**
 * The task relations the target already holds for the task and the record
 * each payload names, by the index of the payload.
 *
 * The platform writes a task's relations to its WhoId and its WhatId as it
 * writes the task — in a real source org, every relation was created the
 * second its task was, by the task's author, and named the task's who or
 * what — and the relations of an email's task as it writes that task with its
 * email. The what relation never goes (`PLATFORM_WRITTEN_ROWS`); a relation
 * to a contact or a lead read from the source is the one the platform wrote
 * when the target holds it, linked to rather than sent twice, and sent when it
 * does not: a task shared with several contacts has a relation to each. The
 * payloads carry target ids already.
 */
export async function existingTaskRelations(
  query: SoqlQuery,
  records: readonly Record<string, unknown>[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const tasks = [
    ...new Set(
      records
        .map((r) => r['TaskId'])
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  ];
  if (tasks.length === 0) return found;
  const byPair = new Map<string, string>();
  for (let i = 0; i < tasks.length; i += WRITTEN_CHUNK) {
    const inList = tasks
      .slice(i, i + WRITTEN_CHUNK)
      .map((id) => `'${sanitizeSoqlValue(id)}'`)
      .join(', ');
    const rows = await query(
      `SELECT Id, TaskId, RelationId FROM ${TASK_RELATION} WHERE TaskId IN (${inList})`,
    );
    for (const row of rows) {
      if (typeof row['Id'] === 'string') {
        byPair.set(`${String(row['TaskId'])}|${String(row['RelationId'])}`, row['Id']);
      }
    }
  }
  records.forEach((r, i) => {
    const id = byPair.get(`${String(r['TaskId'])}|${String(r['RelationId'])}`);
    if (id) found.set(i, id);
  });
  return found;
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
