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
 * the note names the field the target refused, and the rest goes back. A
 * write the run's cancel stopped answers for the records it sent only:
 * nothing is sent after it.
 *
 * @param linked - Each row read, and the id of the relation linked in its place.
 * @param updatable - Whether the target's describe of the object lets a field be updated.
 * @param update - The update of the target's relations.
 */
export async function giveLinkedRelationsTheirFlags(
  objectApiName: string,
  linked: ReadonlyArray<readonly [row: Record<string, unknown>, id: string]>,
  updatable: (field: string) => boolean,
  update: RelationUpdate,
): Promise<string | undefined> {
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
  /** Whether the run's cancel stopped a write: nothing is sent after it. */
  let stopped = false;
  /** Send `records`: why the target refused each it refused, by its id. */
  const send = async (records: RecordUpdate[]): Promise<Map<string, string>> => {
    const refused = new Map<string, string>();
    if (records.length === 0 || stopped) return refused;
    const outcomes = await update(records);
    stopped = outcomes.length < records.length;
    records.forEach((record, i) => {
      const outcome = outcomes[i];
      if (outcome?.success) return;
      refused.set(
        record.Id,
        `the target refused the update, ${outcome?.errors[0] ?? 'without saying why'}`,
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
  // to part them from.
  const again = stopped
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
  if (without.size === 0) return undefined;
  return [...without].map(([why, count]) => `${count} linked without ${why}`).join(', ');
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
