/**
 * A target org in miniature for removal, checkpoint and rewind tests: rows
 * per object, dated as the org dates them, the child relationships each
 * object lists, a recycle bin read by `queryAll`, deletes that take along
 * what cascades from a record and undeletes that bring it back, paged
 * queries behind cursors, and the data API's composite call with its limits.
 *
 * Where the org's behaviour was an open question, the fake does what the
 * checkpoint's live probes saw (tour 0, on a scratch org): each such fact is
 * one switch of {@link MemoryOrgFacts}, so a test can hold a run to the other
 * answer as well. What it does by default:
 *
 * - The org dates what it writes to the second, truncated: an undelete
 *   started at :26.731 was stamped :26.000. A delete stamps `SystemModstamp`
 *   and `LastModifiedDate` to its second and makes the deleting user the last
 *   modifier, on the record and on what cascades from it; an undelete does
 *   the same as the undeleting user, children included.
 * - A child deleted in cascade comes back with its parent; one deleted on its
 *   own before stays in the bin, and a record's stamp never moves there,
 *   whatever happens to its parent.
 * - A child deleted on its own, then its cascade parent deleted, can no
 *   longer come back at all: `queryAll` still reads it deleted, and its
 *   undelete answers `UNDELETE_FAILED` "Entity is not in the recycle bin",
 *   sent with its parent, after it or before it (a case under an account, on a
 *   scratch org, tour 15). So does one deleted on its own before a record it
 *   points at through a lookup that restricts that record's delete: the
 *   case's account lookup, on that org, restricted the account's delete
 *   rather than taking the case along. A child deleted with its parent
 *   answers the same while the parent is in the bin: the rewind's undo sent
 *   contacts before the accounts they went with, and the org refused each so.
 * - A record emptied from the recycle bin (`empty`), with what its delete
 *   took along, still reads deleted through `queryAll`, and its undelete
 *   answers "Entity is not in the recycle bin": seen on a scratch org right
 *   after `Database.emptyRecycleBin`, and half an hour later still; a day
 *   later `queryAll` no longer read it (`purge`). No read tells it from a
 *   record still in the bin; only the undelete's answer does.
 * - Deleting a record clears a lookup to it that does not cascade (a
 *   contact's `ReportsToId`) and restamps the child; undeleting the record
 *   puts the lookup back and restamps the child again.
 * - An update that points a lookup at a record in the recycle bin is refused,
 *   `ENTITY_IS_DELETED` "entity is deleted", the record left as it was: a
 *   contact's account, a contact's `ReportsToId` and an account's parent,
 *   live (P-B1, P-D4).
 * - A delete of several objects in one call deletes the parents first: a
 *   child listed before its parent answers `ENTITY_IS_DELETED`, gone with it.
 * - A plain query leaves out deleted records and archived activities; one
 *   that reads the recycle bin (`queryAll`, `scanAll`) returns both.
 * - A person account's contact is deleted and brought back with its account,
 *   never on its own.
 * - A `/composite` call holds 25 subrequests at most (26 are refused whole,
 *   `LIMIT_EXCEEDED`), of which 5 at most may be a query, a `queryAll` or a
 *   cursor's next page: the sixth is halted (`PROCESSING_HALTED`) while the
 *   call answers. Describes do not count toward the five.
 * - A cursor keeps its rows until it is read to the end; there is no limit to
 *   how many stay open (a REST org kept 150 open, the oldest still readable).
 *   One released or expired fails its next read. A test may set a limit past
 *   which the oldest is released.
 *
 * One fact the probes could not settle: no user of the test orgs could
 * hard-delete, so a hard-deleted record shows nowhere unless told. A child
 * deleted in cascade is refused an undelete of its own while its parent is in
 * the bin unless told, as the org was seen to refuse it.
 *
 * A statement it cannot read throws (`memorySoql.ts`), so one it cannot read
 * never passes for one that selects nothing. A semi-join, `Field IN (SELECT
 * Column FROM Object [WHERE …])`, is read as the list of what its inner
 * statement selects, from the rows the outer one sees.
 *
 * What a subclass changes of what the org does — which rows a statement
 * sees, which it refuses, what follows a delete or an undelete — goes through
 * the protected hooks `rowsFor`, `statementRefusal`, `removed` and
 * `undeleted`; a file's org (`memoryFileOrg.ts`) is one.
 *
 * Lives under `src/test/`: a helper, not a suite.
 */

import type { RemovalOrg } from '../modules/forge/ForgeRunRemoval.js';
import { parseSoql, selectFrom } from './memorySoql.js';

/** A row of the fake org. */
export type MemoryRow = Record<string, unknown> & { Id: string };

/** A child relationship as an object's describe lists it. */
export interface MemoryChild {
  childSObject: string;
  field: string;
  /** Whether a delete of the parent takes the child along. */
  cascadeDelete?: boolean;
  /** Whether the org refuses to delete a parent a live child still names. */
  restrictedDelete?: boolean;
}

/** The user the session writes as. */
export const MEMORY_ORG_USER = '005000000000001AAA';

/**
 * What the fake org does where Salesforce's behaviour was a question; each as
 * the checkpoint's live probes answered it by default (see the module's
 * comment), and switchable to the other answer.
 */
export interface MemoryOrgFacts {
  /**
   * A delete stamps `SystemModstamp` and `LastModifiedDate` to its second and
   * makes the deleting user the last modifier, on the record and on what
   * cascades from it. Off: they go to the bin with the stamps they had.
   */
  deleteStamps: boolean;
  /**
   * A child deleted on its own before its parent stays in the bin when the
   * parent comes back. Off: it comes back with the parent.
   */
  childDeletedAloneStays: boolean;
  /**
   * An undelete makes the undeleting user the last modifier, of the record
   * and of the children that come back with it. Off: the last modifier stays
   * who it was. The dates move either way, as shipped code saw on live runs.
   */
  undeleterIsLastModifier: boolean;
  /**
   * Deleting a record that a lookup names clears the lookup and restamps the
   * child, as the deleting user. Off: the lookup is cleared, the child's
   * stamps stay.
   */
  clearedLookupRestamps: boolean;
  /**
   * Undeleting the record puts back the lookups its delete cleared, and
   * restamps their children as the undeleting user. Off: they stay cleared.
   */
  undeleteRestoresLookups: boolean;
  /**
   * A hard-deleted record still shows, deleted, in `queryAll`. Unknown: no
   * user of the test orgs could hard-delete. Off: it shows nowhere.
   */
  hardDeleteInQueryAll: boolean;
  /**
   * A delete of several objects in one call deletes the parents of the call
   * first. Off: in the order the ids were listed.
   */
  parentsDeletedFirst: boolean;
  /**
   * A child deleted in cascade may be undeleted while its parent is still
   * deleted. Off: refused until the parent is back, "Entity is not in the
   * recycle bin", as the org answered contacts sent before their accounts.
   */
  cascadeChildComesBackAlone: boolean;
  /**
   * A child deleted on its own, then its cascade parent deleted — the parent
   * alone or with a record it hangs from — stays `IsDeleted` in the bin, and
   * its own undelete answers "Entity is not in the recycle bin", sent with its
   * parent, after it or before it: it can no longer come back on its own.
   * Whether it comes back with its parent is {@link childDeletedAloneStays}.
   * The same holds of a record deleted on its own before one it points at
   * through a lookup that restricts that one's delete, which never brings it
   * back. Off: either comes back on its own, as any record deleted on its own.
   */
  childDeletedAloneThenParentLimbo: boolean;
  /**
   * A record emptied from the recycle bin (`empty`), with what its delete
   * took along, still reads `IsDeleted = true` through `queryAll`, as its
   * delete left it, and its undelete answers "Entity is not in the recycle
   * bin" (P11, a scratch org, half an hour after `Database.emptyRecycleBin`).
   * Off: it shows nowhere, as {@link MemoryRemovalOrg.purge} leaves it, and as
   * the org left it a day later.
   */
  emptiedStillListed: boolean;
}

/**
 * The facts as the live probes saw them; the one they could not see, a hard
 * delete, as the answer that brings back less.
 */
export const MEMORY_ORG_FACTS: Readonly<MemoryOrgFacts> = Object.freeze({
  deleteStamps: true,
  childDeletedAloneStays: true,
  undeleterIsLastModifier: true,
  clearedLookupRestamps: true,
  undeleteRestoresLookups: true,
  hardDeleteInQueryAll: false,
  parentsDeletedFirst: true,
  cascadeChildComesBackAlone: false,
  childDeletedAloneThenParentLimbo: true,
  emptiedStillListed: true,
});

/**
 * Every combination of the facts `names`, the others as the probes saw them:
 * what a test runs a scenario under to hold it to every hypothesis at once.
 * The probes' own answers come first.
 */
export function factCombinations(
  names: ReadonlyArray<keyof MemoryOrgFacts> = Object.keys(MEMORY_ORG_FACTS) as Array<
    keyof MemoryOrgFacts
  >,
): MemoryOrgFacts[] {
  return names.reduce<MemoryOrgFacts[]>(
    (combinations, name) =>
      combinations.flatMap((facts) =>
        [facts[name], !facts[name]].map((value) => ({ ...facts, [name]: value })),
      ),
    [{ ...MEMORY_ORG_FACTS }],
  );
}

/** How a fake org is set up, beside its relationships. */
export interface MemoryOrgOptions {
  /** The facts that differ from {@link MEMORY_ORG_FACTS}. */
  facts?: Partial<MemoryOrgFacts>;
  /** The org's clock, in ms since the epoch: this machine's unless given. */
  now?: () => number;
  /**
   * The rows of each page a query answers: 2,000 unless given, or by the
   * page's place from 0 and the statement, since an org's pages are not all
   * the same size, and it answers a wide statement in shorter pages (P-D2).
   */
  pageSize?: number | ((page: number, soql: string) => number);
  /** Open cursors past which a new one releases the oldest: none unless given. */
  cursorLimit?: number;
}

/** A page of a query, as jsforce answers it. */
export interface MemoryQueryPage {
  totalSize: number;
  done: boolean;
  records: MemoryRow[];
  nextRecordsUrl?: string;
}

/** A request sent through the connection, as jsforce's `conn.request` takes it. */
export interface MemoryOrgRequest {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** One subrequest of a composite's answer. */
export interface MemorySubAnswer {
  body: unknown;
  httpHeaders: Record<string, string>;
  httpStatusCode: number;
  referenceId: string;
}

/** The API version the fake org answers under. */
const API_VERSION = '66.0';
const API_PATH = `/services/data/v${API_VERSION}`;

/** Subrequests one composite holds. */
const COMPOSITE_SUBREQUESTS = 25;

/** Queries, `queryAll`s and next pages one composite runs; past them, halted. */
const COMPOSITE_QUERIES = 5;

/** The rows of a page unless the org is told otherwise. */
const PAGE_SIZE = 2_000;

/** The prefix of a cursor's locator in a next page's address. */
const LOCATOR_PREFIX = '01gMEM';

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** Whether `value` names the record keyed `key`. */
function names(value: unknown, key: string): boolean {
  return typeof value === 'string' && value.length >= 15 && keyOf(value) === key;
}

/** `ms` as the org dates a write: to the second, truncated. */
export function orgStamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/**
 * The error jsforce rejects with when the org refuses a request: its
 * `errorCode` as the error's name.
 */
export function orgError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: errorCode,
    errorCode,
    data: { errorCode, message },
  });
}

/** One record's answer to a delete or an undelete. */
type WriteAnswer =
  | { id: string; success: true; errors: [] }
  | { id?: string; success: false; errors: Array<{ statusCode: string; message: string }> };

/** A record in the recycle bin. */
interface Binned {
  objectApiName: string;
  /** The row as the delete left it. */
  row: MemoryRow;
  /** The record whose delete took this one along; none when it was deleted on its own. */
  deletedWith?: string;
  /** Hard-deleted: never to come back. */
  hard?: boolean;
  /**
   * Deleted on its own, then a record it hangs from through a cascade, or
   * points at through a lookup that restricts its delete, deleted after it:
   * still in the bin, never to come back (see
   * {@link MemoryOrgFacts.childDeletedAloneThenParentLimbo}).
   */
  stuck?: boolean;
  /**
   * Emptied from the bin, still read deleted through `queryAll`, never to
   * come back (see {@link MemoryOrgFacts.emptiedStillListed}).
   */
  emptied?: boolean;
  /** The user whose delete sent it there, with its parent's or on its own. */
  deletedBy?: string;
}

/** A lookup a delete cleared, to put back when the record comes back. */
interface ClearedLookup {
  objectApiName: string;
  id: string;
  field: string;
  value: string;
}

/** An open cursor: the rows it read, the pages it has answered, and the statement it answers. */
interface Cursor {
  rows: MemoryRow[];
  pages: number;
  soql: string;
}

/** The answer of one read of a request, before it is sent back. */
interface ReadAnswer {
  status: number;
  body: unknown;
}

/** The person account's flag, on its account and on its contact. */
const PERSON_ACCOUNT = 'IsPersonAccount';

/** The org's answer when a person account's contact is created or deleted on its own. */
const PERSON_CONTACT_REFUSAL = {
  // A code of the API's own list; the case is documented, not seen live.
  statusCode: 'INVALID_PERSON_ACCOUNT_OPERATION',
  message:
    "You can't create or delete a person contact on its own: delete or modify the account instead.",
};

/**
 * The org's answer to an undelete of a record it will not bring back: one no
 * longer in the bin, one stuck there, one whose parent is still there.
 */
const NOT_IN_BIN = 'Entity is not in the recycle bin';

/** See the module's comment. */
export class MemoryRemovalOrg implements RemovalOrg {
  /** The API version, as `conn.version` gives it. */
  readonly version = API_VERSION;
  /** The facts this org holds to: see {@link MemoryOrgFacts}. */
  readonly facts: MemoryOrgFacts;
  /** The live rows of each object, by key, in the order they came in. */
  private readonly rows = new Map<string, Map<string, MemoryRow>>();
  /** The rows in the recycle bin, by key: what an undelete puts back. */
  private readonly binned = new Map<string, Binned>();
  /** By the key of a deleted record, the lookups its delete cleared. */
  private readonly cleared = new Map<string, ClearedLookup[]>();
  /** By object, when its schema last changed and its fields since: what a describe answers. */
  private readonly schemaChanged = new Map<string, { at: number; fields: unknown[] }>();
  private readonly cursors = new Map<string, Cursor>();
  private cursorsOpened = 0;
  /** The org's clock, in ms since the epoch. */
  protected readonly now: () => number;
  private readonly pageSize: (page: number, soql: string) => number;
  private readonly cursorLimit: number;
  /** Records whose delete the org refuses, with its answer. */
  readonly refuse = new Map<string, string>();
  /** Every delete asked, object and ids, in order. */
  readonly deletes: Array<{ objectApiName: string; ids: string[] }> = [];
  /** Called before each delete: what a test cancels a removal from. */
  beforeDelete?: () => void;
  /** Objects whose describe says the session's user may not delete their records. */
  readonly undeletable = new Set<string>();
  /**
   * Objects whose describe says a record does not come back from the recycle
   * bin on its own (`undeletable: false`): an opportunity's products, a
   * campaign's members. They come back with their parent only.
   */
  readonly comesBackOnlyWithParent = new Set<string>();
  /** Objects the org refuses to read, with its answer: one it will not read whole. */
  readonly refuseRead = new Map<string, { errorCode: string; message: string }>();
  /**
   * Whether the session's user lacks Modify All Data, which Salesforce asks
   * of an undelete of what another user deleted: refused then,
   * `INSUFFICIENT_ACCESS_OR_READONLY`, whatever the user holds on the object,
   * while their own deletions come back (P-B3, a Standard User given View
   * All and Modify All on a private object). Off: the session's user brings
   * back whoever's deletions, as with Modify All Data.
   */
  othersDeletionsRefused = false;
  /**
   * Objects whose recycle bin a read by the session's user shows only their
   * own deletions in. Of an object its user holds by its own View All, the
   * probe saw every user's deletions (P-B3); of one held through what it
   * hangs from, it could not tell, so a test holds a rewind to either answer.
   */
  readonly binShowsOwnOnly = new Set<string>();
  /**
   * Fields an object does not have, by object: a statement naming one is
   * refused as the org refuses it, `INVALID_FIELD` — a ContentDocumentLink has
   * no CreatedDate.
   */
  readonly missingFields = new Map<string, ReadonlySet<string>>();
  /**
   * Fields field-level security hides from the user, by object: gone from
   * the describe as a deleted field is, still listed by the Tooling API's
   * `FieldDefinition`, as asked live.
   */
  readonly hiddenFields = new Map<string, ReadonlySet<string>>();
  /** The org's answer to every read of the Tooling API, when it refuses them. */
  refuseTooling?: { errorCode: string; message: string };
  /** The statements of the Tooling API it was asked, in order. */
  readonly toolingAsked: string[] = [];
  /** REST requests answered: a composite is one, whatever it holds. */
  requests = 0;
  /** SOAP calls answered (the clock, the user, undeletes), which a count of REST requests misses. */
  soapCalls = 0;

  /**
   * @param children - Per object, the child relationships its describe lists.
   * @param options - The facts, the clock, the pages and the cursors.
   */
  constructor(
    private readonly children: Readonly<Record<string, readonly MemoryChild[]>> = {},
    options: MemoryOrgOptions = {},
  ) {
    this.facts = { ...MEMORY_ORG_FACTS, ...options.facts };
    this.now = options.now ?? Date.now;
    const pageSize = options.pageSize ?? PAGE_SIZE;
    this.pageSize = typeof pageSize === 'number' ? () => pageSize : pageSize;
    this.cursorLimit = options.cursorLimit ?? Number.POSITIVE_INFINITY;
  }

  /** The live rows of an object, by key. */
  private table(objectApiName: string): Map<string, MemoryRow> {
    let table = this.rows.get(objectApiName);
    if (!table) {
      table = new Map();
      this.rows.set(objectApiName, table);
    }
    return table;
  }

  /** A live row of an object, by either length of its id. */
  protected liveRow(objectApiName: string, id: string): MemoryRow | undefined {
    return this.rows.get(objectApiName)?.get(keyOf(id));
  }

  /** Whether `value` names a record the recycle bin holds, by either length of its id. */
  protected namesBinned(value: unknown): boolean {
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value)) {
      return false;
    }
    const held = this.binned.get(keyOf(value));
    return held !== undefined && held.hard !== true;
  }

  /** Stamp a row as written now by `by`, to the second. */
  protected restamp(row: MemoryRow, by: string): void {
    const at = orgStamp(this.now());
    row.SystemModstamp = at;
    row.LastModifiedDate = at;
    row.LastModifiedById = by;
  }

  /** Put a row in, dated `at` unless it carries its own dates; now, to the second, by default. */
  add(objectApiName: string, row: MemoryRow, at = orgStamp(this.now())): void {
    const added: MemoryRow = { CreatedDate: at, LastModifiedDate: at, ...row, IsDeleted: false };
    added.SystemModstamp ??= added.LastModifiedDate;
    this.table(objectApiName).set(keyOf(row.Id), added);
  }

  /**
   * Put a person account in: the account and the contact the platform makes
   * with it, each flagged, the account naming its contact.
   */
  addPersonAccount(account: MemoryRow, contactId: string, at = orgStamp(this.now())): void {
    this.add('Account', { ...account, [PERSON_ACCOUNT]: true, PersonContactId: contactId }, at);
    this.add('Contact', { Id: contactId, AccountId: account.Id, [PERSON_ACCOUNT]: true }, at);
  }

  /** The objects the org holds records of, live or in the recycle bin. */
  objectNames(): string[] {
    return [
      ...new Set([
        ...this.rows.keys(),
        ...[...this.binned.values()].map((held) => held.objectApiName),
      ]),
    ];
  }

  /** The rows of an object still in the org. */
  all(objectApiName: string): MemoryRow[] {
    return [...(this.rows.get(objectApiName)?.values() ?? [])];
  }

  /** The rows of an object in the recycle bin, as the delete left them: none emptied from it. */
  inBin(objectApiName: string): MemoryRow[] {
    return [...this.binned.values()]
      .filter((held) => held.objectApiName === objectApiName && !held.hard && !held.emptied)
      .map((held) => held.row);
  }

  /** Change a row, as someone does after the run: its modified dates move to `at`. */
  touch(objectApiName: string, id: string, at: string): void {
    const row = this.liveRow(objectApiName, id);
    if (!row) return;
    row.LastModifiedDate = at;
    row.SystemModstamp = at;
  }

  /** Change a row's values now, as `by` does in the org: stamped to the second. */
  edit(
    objectApiName: string,
    id: string,
    values: Record<string, unknown>,
    by = MEMORY_ORG_USER,
  ): void {
    const row = this.liveRow(objectApiName, id);
    if (!row) throw new Error(`The fake org holds no live ${objectApiName} ${id}`);
    Object.assign(row, values);
    this.restamp(row, by);
  }

  /** Archive an activity, as the org does a year on: plain queries no longer see it. */
  archive(objectApiName: string, id: string): void {
    const row = this.liveRow(objectApiName, id);
    if (!row) throw new Error(`The fake org holds no live ${objectApiName} ${id}`);
    row.IsArchived = true;
  }

  /** Change an object's fields, as someone does in Setup: its describe answers them, dated now. */
  changeSchema(objectApiName: string, fields: unknown[]): void {
    this.schemaChanged.set(objectApiName, { at: this.now(), fields });
  }

  /** Release every open cursor, as the org does with cursors left unread. */
  expireCursors(): void {
    this.cursors.clear();
  }

  /** The cursors still open. */
  get openCursors(): number {
    return this.cursors.size;
  }

  private describeOf(objectApiName: string): Record<string, unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      ...(this.undeletable.has(objectApiName) ? { deletable: false } : {}),
      undeletable: !this.comesBackOnlyWithParent.has(objectApiName),
      fields: this.schemaChanged.get(objectApiName)?.fields ?? [],
      childRelationships: (this.children[objectApiName] ?? []).map((child) => ({
        childSObject: child.childSObject,
        field: child.field,
        cascadeDelete: child.cascadeDelete ?? false,
        ...(child.restrictedDelete ? { restrictedDelete: true } : {}),
      })),
    };
  }

  async describe(objectApiName: string): Promise<unknown> {
    this.requests++;
    return this.describeOf(objectApiName);
  }

  async describeGlobal(): Promise<unknown> {
    this.requests++;
    const names = new Set([
      ...this.rows.keys(),
      ...Object.keys(this.children),
      ...Object.values(this.children).flatMap((list) => list.map((child) => child.childSObject)),
    ]);
    return {
      sobjects: [...names].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    };
  }

  /**
   * The rows a read sees: the live ones but archived activities; reading the
   * recycle bin too, those as well, and the deleted ones.
   */
  protected visible(objectApiName: string, scanAll: boolean): MemoryRow[] {
    const live = this.all(objectApiName);
    if (!scanAll) return live.filter((row) => row.IsArchived !== true);
    const ownOnly = this.binShowsOwnOnly.has(objectApiName);
    for (const held of this.binned.values()) {
      if (held.objectApiName !== objectApiName) continue;
      if (ownOnly && held.deletedBy !== MEMORY_ORG_USER) continue;
      if (!held.hard || this.facts.hardDeleteInQueryAll) live.push(held.row);
    }
    return live;
  }

  /**
   * The rows `soql`, a statement of `objectApiName`, sees: {@link visible}'s,
   * unless a subclass sees others.
   */
  protected rowsFor(objectApiName: string, scanAll: boolean, _soql: string): MemoryRow[] {
    return this.visible(objectApiName, scanAll);
  }

  /** The org's refusal of `soql`, a statement of `objectApiName`, before it reads: none unless a subclass has one. */
  protected statementRefusal(_objectApiName: string, _soql: string): Error | undefined {
    return undefined;
  }

  /** Called with each record a delete sends to the recycle bin, what cascades included, once it is there. */
  protected removed(_objectApiName: string, _row: MemoryRow): void {}

  /** Called with each record an undelete brings back, what comes back with it included, once it is back. */
  protected undeleted(_objectApiName: string, _row: MemoryRow): void {}

  /**
   * `soql` with each semi-join, `IN (SELECT Column FROM Object [WHERE …])`,
   * read as the list of what its inner statement selects of the rows it
   * sees, through the recycle bin when the outer statement reads it.
   */
  private withSemiJoinsRead(soql: string, scanAll: boolean): string {
    return soql.replace(
      /\bIN\s*\(\s*(SELECT\s+(\w+)\s+FROM\s+(\w+)(?:\s+WHERE\s+[^()]+)?)\s*\)/gi,
      (_whole, inner: string, column: string, object: string) => {
        const statement = parseSoql(inner);
        const values = selectFrom(this.rowsFor(object, scanAll, inner), statement)
          .map((row) => row[column])
          .filter((value): value is string => typeof value === 'string');
        // An empty list is no statement the org reads: one no id can match.
        const listed = values.length > 0 ? values : ['000000000000000AAA'];
        return `IN (${listed.map((value) => `'${value}'`).join(', ')})`;
      },
    );
  }

  /** The first page of what `soql` selects, a cursor kept for the rest. */
  private run(soql: string, scanAll: boolean): MemoryQueryPage {
    const statement = parseSoql(this.withSemiJoinsRead(soql, scanAll));
    const refusal = this.refuseRead.get(statement.object);
    if (refusal) throw orgError(refusal.errorCode, refusal.message);
    const refused = this.statementRefusal(statement.object, soql);
    if (refused) throw refused;
    for (const field of this.missingFields.get(statement.object) ?? []) {
      if (new RegExp(`\\b${field}\\b`).test(soql)) {
        throw orgError(
          'INVALID_FIELD',
          `No such column '${field}' on entity '${statement.object}'.`,
        );
      }
    }
    const selected = selectFrom(this.rowsFor(statement.object, scanAll, soql), statement);
    const columns = statement.columns;
    if (columns === null) return { totalSize: selected.length, done: true, records: [] };
    const rows = selected.map(
      (row) => Object.fromEntries(columns.map((column) => [column, row[column]])) as MemoryRow,
    );
    const first = this.pageSize(0, soql);
    if (rows.length <= first) return { totalSize: rows.length, done: true, records: rows };
    for (const oldest of this.cursors.keys()) {
      if (this.cursors.size < this.cursorLimit) break;
      this.cursors.delete(oldest);
    }
    const locator = `${LOCATOR_PREFIX}${++this.cursorsOpened}`;
    this.cursors.set(locator, { rows, pages: 1, soql });
    return {
      totalSize: rows.length,
      done: false,
      records: rows.slice(0, first),
      nextRecordsUrl: `${API_PATH}/query/${locator}-${first}`,
    };
  }

  /** The page a cursor's next address names; refused for a cursor the org no longer holds. */
  private nextPage(nextRecordsUrl: string): MemoryQueryPage {
    const address = /\/query(?:All)?\/(\w+)-(\d+)$/.exec(nextRecordsUrl);
    if (!address) throw new Error(`Not a next page the fake org answers: ${nextRecordsUrl}`);
    const [, locator, offset] = address;
    const cursor = this.cursors.get(locator);
    if (!cursor) throw orgError('INVALID_QUERY_LOCATOR', 'invalid query locator');
    const from = Number(offset);
    const to = from + this.pageSize(cursor.pages, cursor.soql);
    cursor.pages++;
    const records = cursor.rows.slice(from, to);
    if (to >= cursor.rows.length) {
      this.cursors.delete(locator);
      return { totalSize: cursor.rows.length, done: true, records };
    }
    return {
      totalSize: cursor.rows.length,
      done: false,
      records,
      nextRecordsUrl: `${API_PATH}/query/${locator}-${to}`,
    };
  }

  async query(soql: string, options?: { scanAll?: boolean }): Promise<MemoryQueryPage> {
    this.requests++;
    return this.run(soql, options?.scanAll === true);
  }

  /** A query that reads the recycle bin too, as `conn.queryAll` does. */
  async queryAll(soql: string): Promise<MemoryQueryPage> {
    this.requests++;
    return this.run(soql, true);
  }

  async queryMore(nextRecordsUrl: string): Promise<MemoryQueryPage> {
    this.requests++;
    return this.nextPage(nextRecordsUrl);
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    this.requests++;
    return { records: this.run(soql, true).records };
  }

  /**
   * A read by its address, of a request or of a composite's subrequest: a
   * query, a `queryAll`, a cursor's next page or a describe; the org's
   * refusal as its answer.
   */
  private read(url: string, headers: Record<string, string> = {}): ReadAnswer {
    const path = url.replace(/^\/services\/data\/v\d+\.\d+/, '');
    const answered = (page: () => MemoryQueryPage): ReadAnswer => {
      try {
        return { status: 200, body: page() };
      } catch (err: unknown) {
        const code = (err as { errorCode?: unknown }).errorCode;
        if (typeof code !== 'string') throw err;
        return { status: 400, body: [{ errorCode: code, message: (err as Error).message }] };
      }
    };
    const search = /^\/(query|queryAll)\/?\?q=(.*)$/.exec(path);
    if (search) {
      const soql = new URLSearchParams(`q=${search[2]}`).get('q') ?? '';
      return answered(() => this.run(soql, search[1] === 'queryAll'));
    }
    if (/^\/(query|queryAll)\/\w+-\d+$/.test(path)) return answered(() => this.nextPage(path));
    const tooling = /^\/tooling\/query\/?\?q=(.*)$/.exec(path);
    if (tooling) {
      const soql = new URLSearchParams(`q=${tooling[1]}`).get('q') ?? '';
      this.toolingAsked.push(soql);
      return answered(() => this.fieldDefinitions(soql));
    }
    const described = /^\/sobjects\/(\w+)\/describe\/?$/.exec(path);
    if (described) {
      const since = headers['If-Modified-Since'];
      const changedAt = this.schemaChanged.get(described[1])?.at ?? 0;
      if (since !== undefined && changedAt <= Date.parse(since)) return { status: 304, body: null };
      return { status: 200, body: this.describeOf(described[1]) };
    }
    throw new Error(`Not a request the fake org answers: ${url}`);
  }

  /**
   * The rows of the Tooling API's `FieldDefinition` a statement selects, of
   * one object and a list of names: those its describe lists now and those
   * field-level security hides from the user. A deleted field is in
   * neither. Any other statement is refused, as the org refuses one it
   * cannot read.
   */
  private fieldDefinitions(soql: string): MemoryQueryPage {
    if (this.refuseTooling) {
      throw orgError(this.refuseTooling.errorCode, this.refuseTooling.message);
    }
    const asked =
      /^SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition\.QualifiedApiName = '(\w+)' AND QualifiedApiName IN \(([^)]*)\)$/.exec(
        soql,
      );
    if (!asked) throw orgError('MALFORMED_QUERY', `Not a statement the fake org reads: ${soql}`);
    const [, objectApiName, list] = asked;
    const names = list.split(', ').map((quoted) => quoted.slice(1, -1));
    const described = (this.schemaChanged.get(objectApiName)?.fields ?? []).map((field) =>
      String((field as { name?: unknown }).name).toLowerCase(),
    );
    const defined = new Set([
      ...described,
      ...[...(this.hiddenFields.get(objectApiName) ?? [])].map((name) => name.toLowerCase()),
    ]);
    const records = names
      .filter((name) => defined.has(name.toLowerCase()))
      .map((name) => ({ attributes: { type: 'FieldDefinition' }, QualifiedApiName: name }));
    return { totalSize: records.length, done: true, records: records as unknown as MemoryRow[] };
  }

  /**
   * A request as `conn.request` sends it: a `POST /composite`, or a read (a
   * query, a `queryAll`, a next page, a describe), refused as jsforce
   * rejects a refusal.
   */
  async request(request: MemoryOrgRequest): Promise<unknown> {
    this.requests++;
    const path = request.url.replace(/^\/services\/data\/v\d+\.\d+/, '');
    const method = request.method.toUpperCase();
    if (method === 'POST' && path === '/composite') return this.composite(request.body);
    if (method !== 'GET') throw new Error(`Not a request the fake org answers: ${method} ${path}`);
    const answer = this.read(request.url, request.headers);
    if (answer.status >= 400) {
      const [first] = answer.body as Array<{ errorCode: string; message: string }>;
      throw orgError(first.errorCode, first.message);
    }
    return answer.body;
  }

  /** A composite's answer, each subrequest's in turn, under the org's limits. */
  private composite(raw: unknown): { compositeResponse: MemorySubAnswer[] } {
    const body = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      compositeRequest?: Array<{
        method: string;
        url: string;
        referenceId: string;
        httpHeaders?: Record<string, string>;
      }>;
    };
    const subrequests = body.compositeRequest ?? [];
    if (subrequests.length > COMPOSITE_SUBREQUESTS) {
      throw orgError('LIMIT_EXCEEDED', 'The request can’t contain more than 25 operations.');
    }
    let queries = 0;
    return {
      compositeResponse: subrequests.map((sub) => {
        if (sub.method.toUpperCase() !== 'GET' || sub.url.includes('@{')) {
          throw new Error(`Not a subrequest the fake org answers: ${sub.method} ${sub.url}`);
        }
        const query = /\/(query|queryAll)(\/|\?)/.test(sub.url);
        const answer: ReadAnswer =
          query && ++queries > COMPOSITE_QUERIES
            ? {
                status: 400,
                body: [
                  {
                    errorCode: 'PROCESSING_HALTED',
                    message: 'Limit number of query or Collections in Rest Operations reached.',
                  },
                ],
              }
            : this.read(sub.url, sub.httpHeaders);
        return {
          body: answer.body,
          httpHeaders: {},
          httpStatusCode: answer.status,
          referenceId: sub.referenceId,
        };
      }),
    };
  }

  async update(_objectApiName: string, _records: Array<Record<string, unknown>>): Promise<unknown> {
    this.requests++;
    return [];
  }

  async serverTime(): Promise<string> {
    this.soapCalls++;
    return new Date(this.now()).toISOString();
  }

  async userId(): Promise<string> {
    this.soapCalls++;
    return MEMORY_ORG_USER;
  }

  /**
   * Delete records by id, as a REST collection delete does: the object of the
   * call names none of them, so ids of several objects go in one call (see
   * {@link MemoryOrgFacts.parentsDeletedFirst}). One answer per id, in their
   * order.
   */
  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.requests++;
    this.beforeDelete?.();
    this.deletes.push({ objectApiName, ids: [...ids] });
    return this.deleteAs(ids, MEMORY_ORG_USER);
  }

  /** Delete a row to the recycle bin, as someone, or a run, did. */
  trash(objectApiName: string, id: string, by = MEMORY_ORG_USER): void {
    if (this.liveRow(objectApiName, id)) this.remove(objectApiName, id, by);
  }

  /** Delete a row for good, past the recycle bin, as a Bulk `hardDelete` does. */
  hardDelete(objectApiName: string, id: string, by = MEMORY_ORG_USER): void {
    this.trash(objectApiName, id, by);
    for (const [key, held] of this.binned) {
      if (key === keyOf(id) || held.deletedWith === keyOf(id)) held.hard = true;
    }
  }

  /**
   * Empty a row from the recycle bin, with what its delete took along, as
   * `Database.emptyRecycleBin` does: never to come back, all of them, still
   * read deleted through `queryAll` (see
   * {@link MemoryOrgFacts.emptiedStillListed}).
   */
  empty(id: string): void {
    if (!this.facts.emptiedStillListed) {
      this.purge(id);
      return;
    }
    const key = keyOf(id);
    for (const [other, held] of this.binned) {
      if (other === key || held.deletedWith === key) held.emptied = true;
    }
  }

  /**
   * Empty a row from the recycle bin, with what its delete took along, and
   * let the org forget them: gone for good, all of them, shown nowhere, as a
   * record emptied from the bin once the org no longer lists it — a day
   * after, on a scratch org — or a hard-deleted one.
   */
  purge(id: string): void {
    const key = keyOf(id);
    for (const [other, held] of this.binned) {
      if (other === key || held.deletedWith === key) this.binned.delete(other);
    }
  }

  /** Take rows out of the recycle bin, as `conn.soap.undelete` does: one answer per id. */
  async undelete(ids: string[]): Promise<unknown> {
    this.soapCalls++;
    return this.undeleteAs(ids, MEMORY_ORG_USER);
  }

  /** Take a row out of the recycle bin, as someone does in the org. */
  untrash(id: string, by = MEMORY_ORG_USER): void {
    const [answer] = this.undeleteAs([id], by);
    if (!answer.success) throw new Error(answer.errors[0]?.message ?? 'not undeleted');
  }

  /** The object a live record is of, or none. */
  private objectOf(id: string): string | undefined {
    for (const [objectApiName, table] of this.rows) {
      if (table.has(keyOf(id))) return objectApiName;
    }
    return undefined;
  }

  /** Whether a delete of a `parent` record takes records of `child` along, through any number of objects. */
  private cascadesTo(parent: string, child: string, seen = new Set<string>()): boolean {
    if (seen.has(parent)) return false;
    seen.add(parent);
    return (this.children[parent] ?? []).some(
      (relation) =>
        relation.cascadeDelete === true &&
        (relation.childSObject === child || this.cascadesTo(relation.childSObject, child, seen)),
    );
  }

  /** The live records a delete of `id` takes along, the record first. */
  private cascadeOf(
    objectApiName: string,
    id: string,
  ): Array<{ objectApiName: string; row: MemoryRow }> {
    const taken = new Map<string, { objectApiName: string; row: MemoryRow }>();
    const take = (object: string, takenId: string): void => {
      const row = this.liveRow(object, takenId);
      const key = keyOf(takenId);
      if (!row || taken.has(key)) return;
      taken.set(key, { objectApiName: object, row });
      if (object === 'Account' && row[PERSON_ACCOUNT] === true) {
        for (const contact of this.all('Contact')) {
          if (contact[PERSON_ACCOUNT] === true && names(contact.AccountId, key)) {
            take('Contact', contact.Id);
          }
        }
      }
      for (const child of this.children[object] ?? []) {
        if (!child.cascadeDelete) continue;
        for (const held of this.all(child.childSObject)) {
          if (names(held[child.field], key)) take(child.childSObject, held.Id);
        }
      }
    };
    take(objectApiName, id);
    return [...taken.values()];
  }

  /** Why the org refuses to delete `id`, or nothing. */
  private refusalOf(
    objectApiName: string,
    id: string,
  ): { statusCode: string; message: string } | undefined {
    const refusal = this.refuse.get(id);
    if (refusal) return { statusCode: 'DELETE_FAILED', message: refusal };
    if (objectApiName === 'Contact' && this.liveRow(objectApiName, id)?.[PERSON_ACCOUNT] === true) {
      return PERSON_CONTACT_REFUSAL;
    }
    const taken = this.cascadeOf(objectApiName, id);
    const goes = new Set(taken.map((held) => keyOf(held.row.Id)));
    for (const held of taken) {
      for (const child of this.children[held.objectApiName] ?? []) {
        if (!child.restrictedDelete) continue;
        const holding = this.all(child.childSObject).find(
          (row) => names(row[child.field], keyOf(held.row.Id)) && !goes.has(keyOf(row.Id)),
        );
        if (holding) {
          return {
            statusCode: 'DELETE_FAILED',
            message: `${child.childSObject} ${holding.Id} still names it in ${child.field}`,
          };
        }
      }
    }
    return undefined;
  }

  /** Delete `ids` as `by`, the parents of the call first unless the facts say otherwise. */
  private deleteAs(ids: readonly string[], by: string): WriteAnswer[] {
    const objects = ids.map((id) => this.objectOf(id));
    const called = [...new Set(objects)].filter((object): object is string => object !== undefined);
    /** How many objects of the call take records of `object` along: none, for a parent's. */
    const depth = (object: string | undefined): number =>
      object === undefined
        ? 0
        : called.filter((other) => other !== object && this.cascadesTo(other, object)).length;
    const order = ids.map((_, place) => place);
    if (this.facts.parentsDeletedFirst) order.sort((a, b) => depth(objects[a]) - depth(objects[b]));
    const answers: WriteAnswer[] = [];
    for (const place of order) {
      const id = ids[place];
      const objectApiName = this.objectOf(id);
      const told = this.refuse.get(id);
      const refusal =
        objectApiName === undefined
          ? told
            ? { statusCode: 'DELETE_FAILED', message: told }
            : { statusCode: 'ENTITY_IS_DELETED', message: 'gone' }
          : this.refusalOf(objectApiName, id);
      if (refusal || objectApiName === undefined) {
        answers[place] = {
          success: false,
          errors: [refusal ?? { statusCode: 'ENTITY_IS_DELETED', message: 'gone' }],
        };
        continue;
      }
      this.remove(objectApiName, id, by);
      answers[place] = { id, success: true, errors: [] };
    }
    return answers;
  }

  /**
   * Send a live record to the recycle bin with what cascades from it, as
   * `by`, and clear the lookups that name them: see {@link MemoryOrgFacts}.
   */
  private remove(objectApiName: string, id: string, by: string): void {
    const root = keyOf(id);
    const taken = this.cascadeOf(objectApiName, id);
    const goes = new Set(taken.map((held) => keyOf(held.row.Id)));
    for (const { objectApiName: object, row } of taken) {
      const key = keyOf(row.Id);
      if (this.facts.childDeletedAloneThenParentLimbo) {
        const strands = (child: MemoryChild): boolean =>
          child.cascadeDelete === true || child.restrictedDelete === true;
        for (const [, held] of this.deletedAloneUnder({ objectApiName: object, row }, strands)) {
          held.stuck = true;
        }
      }
      this.table(object).delete(key);
      row.IsDeleted = true;
      if (this.facts.deleteStamps) this.restamp(row, by);
      this.binned.set(key, {
        objectApiName: object,
        row,
        ...(key === root ? {} : { deletedWith: root }),
        deletedBy: by,
      });
      this.removed(object, row);
      for (const child of this.children[object] ?? []) {
        if (child.cascadeDelete || child.restrictedDelete) continue;
        for (const held of this.all(child.childSObject)) {
          if (goes.has(keyOf(held.Id)) || !names(held[child.field], key)) continue;
          const value = String(held[child.field]);
          held[child.field] = null;
          if (this.facts.clearedLookupRestamps) this.restamp(held, by);
          this.cleared.set(key, [
            ...(this.cleared.get(key) ?? []),
            { objectApiName: child.childSObject, id: held.Id, field: child.field, value },
          ]);
        }
      }
    }
  }

  /** Why the org refuses to bring a record back from the bin, or nothing. */
  private undeleteRefusalOf(held: Binned | undefined): string | undefined {
    if (!held || held.hard || held.emptied) return NOT_IN_BIN;
    if (held.objectApiName === 'Contact' && held.row[PERSON_ACCOUNT] === true) {
      return PERSON_CONTACT_REFUSAL.message;
    }
    if (this.comesBackOnlyWithParent.has(held.objectApiName)) {
      return `${held.objectApiName} records come back from the recycle bin with their parent only`;
    }
    if (held.stuck) return NOT_IN_BIN;
    if (
      held.deletedWith !== undefined &&
      !this.facts.cascadeChildComesBackAlone &&
      this.binned.has(held.deletedWith)
    ) {
      return NOT_IN_BIN;
    }
    return undefined;
  }

  /**
   * The records the bin holds that were deleted on their own before `parent`,
   * through a relationship `through` takes — one that cascades from it unless
   * told: what its undelete may bring back; with the lookups that restrict its
   * delete too, what its delete leaves stuck.
   */
  private deletedAloneUnder(
    parent: Pick<Binned, 'objectApiName' | 'row'>,
    through: (child: MemoryChild) => boolean = (child) => child.cascadeDelete === true,
  ): Array<[string, Binned]> {
    const key = keyOf(parent.row.Id);
    const cascades = (this.children[parent.objectApiName] ?? []).filter(through);
    return [...this.binned].filter(
      ([, held]) =>
        !held.hard &&
        !held.emptied &&
        held.deletedWith === undefined &&
        cascades.some(
          (child) => child.childSObject === held.objectApiName && names(held.row[child.field], key),
        ),
    );
  }

  /** Bring back `ids` as `by`, each with what was deleted with it: see {@link MemoryOrgFacts}. */
  private undeleteAs(ids: readonly string[], by: string): WriteAnswer[] {
    return ids.map((id): WriteAnswer => {
      const key = keyOf(id);
      const held = this.binned.get(key);
      if (
        held !== undefined &&
        this.othersDeletionsRefused &&
        by === MEMORY_ORG_USER &&
        held.deletedBy !== by
      ) {
        return {
          id,
          success: false,
          errors: [
            {
              statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY',
              message: 'insufficient access rights on object id',
            },
          ],
        };
      }
      const refusal = this.undeleteRefusalOf(held);
      if (refusal !== undefined || held === undefined) {
        return {
          id,
          success: false,
          errors: [
            {
              statusCode: 'UNDELETE_FAILED',
              message: refusal ?? NOT_IN_BIN,
            },
          ],
        };
      }
      const back = [...this.binned].filter(
        ([other, entry]) =>
          other === key || (!entry.hard && !entry.emptied && entry.deletedWith === key),
      );
      if (!this.facts.childDeletedAloneStays) back.push(...this.deletedAloneUnder(held));
      const at = orgStamp(this.now());
      for (const [other, entry] of back) {
        this.binned.delete(other);
        const row = entry.row;
        row.IsDeleted = false;
        row.SystemModstamp = at;
        row.LastModifiedDate = at;
        if (this.facts.undeleterIsLastModifier) row.LastModifiedById = by;
        this.table(entry.objectApiName).set(other, row);
        this.undeleted(entry.objectApiName, row);
      }
      if (this.facts.undeleteRestoresLookups) {
        for (const [other] of back) this.restoreLookups(other, by);
      }
      return { id, success: true, errors: [] };
    });
  }

  /**
   * Put back the lookups a delete of the record keyed `key` cleared, on the
   * children still live whose lookup is still empty.
   */
  private restoreLookups(key: string, by: string): void {
    for (const lookup of this.cleared.get(key) ?? []) {
      const row = this.liveRow(lookup.objectApiName, lookup.id);
      if (!row || (row[lookup.field] !== null && row[lookup.field] !== undefined)) continue;
      row[lookup.field] = lookup.value;
      this.restamp(row, by);
    }
    this.cleared.delete(key);
  }
}
