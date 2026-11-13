/**
 * What an emptying would delete, counted before anything is: per object its
 * records and those its own pass sends, what goes along with them by object
 * and by lookup, and what the org will likely refuse — each a `COUNT()` the
 * org answers whatever the table holds, never a list of ids.
 *
 * A count that names ids (`countRelated`, 200 a statement) does not reach a
 * table of a million records; a count of a lookup filled does, in one
 * statement. Counts go in two rounds: first each emptied object's own, then
 * the rest, leaving out what can only count nothing — what hangs from an
 * object that holds no record.
 *
 * Likely refusals, as the org was seen to answer them:
 *
 * - an activated order refuses its delete, and its account's; set back to
 *   Draft, it goes. The run sets it back first, and what fires on an order's
 *   update fires then;
 * - a record named through a lookup that refuses the delete — a case under
 *   an account, the contact of a portal user — keeps that record from being
 *   deleted while it lives: an object not emptied that names deleted records
 *   so blocks them, named with its count, and so does an object going along
 *   by those of its records that stay — an opportunity under no account
 *   naming a price book emptied with the accounts;
 * - a direct relation of a contact to its account goes only with the
 *   contact: emptying the relations alone leaves the direct ones;
 * - an opportunity closed won refuses its account's delete, which its
 *   describe says takes it along ("some opportunities of this account were
 *   closed won"): going along, it blocks its account; emptied too, it goes
 *   by its own pass once its account was refused, with the account's other
 *   opportunities, beyond any undo, and they are counted lost — at least
 *   those closed won;
 * - a person account's contact goes only with its account: sent alone, in a
 *   job of contacts, the org refused each, "INVALID_PERSON_ACCOUNT_OPERATION:
 *   cannot reference person contact". The pass of the contacts never sends
 *   one ({@link passRowsOf}), and counts it only when its account goes;
 * - the standard price book is never deleted, and is counted as kept.
 *
 * A count the org would not give keeps the org's words and no number: an
 * object it could not count is never taken for an empty one.
 */

import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import { inPool } from '../RecordRemoval.js';
import {
  ACCOUNT,
  ACCOUNT_CONTACT_RELATION,
  CONTACT,
} from '../../../core/common/platformRecords.js';
import { REFUSING_CASCADES } from '../../../core/removal/refusingCascades.js';
import { PERSON_ACCOUNT_FLAG } from '../../checkpoint/checkpointFields.js';
import type { EmptyOrder } from './emptyOrder.js';
import {
  anyRouteCondition,
  carriersOf,
  countedWithArchived,
  deletedRowsOf,
  keptRowsOf,
  namesDeletedCondition,
  stepsCondition,
  type Affected,
  type Condition,
  type EmptyDescribe,
  type Relation,
  type Route,
  type RouteStep,
} from './emptyRelations.js';

/** What a count of an emptying needs from the org. */
export interface EmptyCountOrg {
  /** The records `SELECT COUNT() …` counts. */
  count(soql: string): Promise<number>;
  /** The same through `queryAll`, which reads archived activities, and the recycle bin unless told not to. */
  countAll(soql: string): Promise<number>;
}

/**
 * Counts sent at once: as the related records of a delete are counted
 * (`countRelated`), each answering in a fraction of a second.
 */
const COUNTS_AT_ONCE = 4;

/** A number the org gave, or why it gave none. */
export interface Counted {
  records?: number;
  /** The org's words, when it gave no number. */
  unread?: string;
  /** Set when the statement may count more than it names: its path was cut where the org could not read it. */
  atMost?: true;
  /** Set when it is a difference whose second count may count more: there may be more. */
  atLeast?: true;
}

/**
 * The condition the pass of `objectApiName` reads its records by, leaving
 * out the rows it never sends: the standard price book, which no emptying
 * deletes, and, in an org of person accounts, a person account's contact,
 * which goes only with its account. Nothing when it sends every row.
 *
 * @param personAccounts - Whether the org has person accounts: its contacts'
 *   describe lists `IsPersonAccount`.
 */
export function passRowsOf(objectApiName: string, personAccounts: boolean): string | undefined {
  const deleted = deletedRowsOf(objectApiName);
  if (deleted !== undefined) return deleted;
  if (personAccounts && objectApiName.toLowerCase() === CONTACT.toLowerCase()) {
    return `${PERSON_ACCOUNT_FLAG} = false`;
  }
  return undefined;
}

/** One object emptied, as counted. */
export interface EmptyObjectCount {
  objectApiName: string;
  /** The condition its pass reads its records by: see {@link passRowsOf}. Absent when it sends every row. */
  rows?: string;
  /** Its records the emptying deletes, every pass together. */
  records: Counted;
  /** Of them, those its own pass sends: the rest go with an emptied object whose pass comes before. */
  sent: Counted;
  /** Of a task or an event, those archived, which only `queryAll` reads. */
  archived?: Counted;
  /** Rows the emptying keeps whatever is asked: the standard price book. */
  kept?: Counted;
}

/** Records of an object not emptied that go along all the same. */
export interface EmptyAlongCount {
  objectApiName: string;
  /** Every route together. */
  records: Counted;
  /** By route: the lookup the records hang by, and the emptied object at the top. */
  via: Array<{ field: string; parent: string; emptied: string; records: Counted }>;
}

/** What the org will likely refuse, or what the run does first so that it does not. */
export type EmptyRefusalCode =
  /** Orders past Draft, which the run sets back to Draft before any delete. */
  | 'activatedOrder'
  /** The standard price book, which the emptying keeps. */
  | 'standardPriceBook'
  /** Direct relations of contacts to their accounts, which go only with their contacts. */
  | 'directContactRelation'
  /** Person accounts' contacts, which go only with their accounts. */
  | 'personAccountContact';

/** A likely refusal, counted. */
export interface EmptyRefusal {
  code: EmptyRefusalCode;
  objectApiName: string;
  records: Counted;
}

/**
 * Records of an object not emptied that name, through a lookup that refuses
 * the delete, records the emptying deletes: those are refused, and what
 * they go with.
 */
export interface EmptyBlocker {
  objectApiName: string;
  field: string;
  parent: string;
  records: Counted;
}

/**
 * Records no undo would bring back, and why:
 *
 * - `restricted`: they leave before a record they name, as the platform
 *   requires, and once it has gone too, no undelete brings them back (F41);
 * - `unordered`: so too, where objects point at each other and a constraint
 *   gave way;
 * - `standardPrices`: the standard prices of a product emptied, which go
 *   with it and did not come back with it (seen live: "no longer in the
 *   recycle bin"), where the prices of a custom book came back with theirs;
 * - `notRestorable`: those the pass of an object whose records no undelete
 *   brings back on their own sends (`undeletable: false`), the 34 prices no
 *   book held among them.
 */
export interface EmptyUndoLost {
  objectApiName: string;
  /** The lookup through which they name the record they go before, or go with; absent for `notRestorable`. */
  field?: string;
  /** The object of that record; absent for `notRestorable`. */
  parent?: string;
  reason: 'restricted' | 'unordered' | 'standardPrices' | 'notRestorable';
  records: Counted;
}

/** Everything an emptying's preview counted. */
export interface EmptyCounts {
  objects: EmptyObjectCount[];
  along: EmptyAlongCount[];
  refusals: EmptyRefusal[];
  blockers: EmptyBlocker[];
  undoLost: EmptyUndoLost[];
  /** The statements the org was sent: what the preview cost it. */
  statements: number;
  /** Set when it was stopped before every count was in: what is missing says it. */
  stopped?: true;
}

/** What {@link countEmpty} counts from. */
export interface EmptyCountInput {
  affected: Affected;
  order: EmptyOrder;
  relations: readonly Relation[];
  describes: ReadonlyMap<string, EmptyDescribe>;
}

/** The answer of a count not sent because it was stopped first. */
const STOPPED = 'stopped before the org was asked';

/** A count statement of `objectApiName` under every condition of `conditions`. */
function statementOf(
  objectApiName: string,
  conditions: readonly string[],
): { soql: string; all: boolean } {
  const all = countedWithArchived(objectApiName);
  const where = [...conditions, ...(all ? ['IsDeleted = false'] : [])];
  const tail =
    where.length === 0
      ? ''
      : ` WHERE ${where.map((condition) => (where.length > 1 ? `(${condition})` : condition)).join(' AND ')}`;
  return { soql: `SELECT COUNT() FROM ${assertSoqlIdentifier(objectApiName)}${tail}`, all };
}

/** The statements of one round, each counted once whatever asks for it. */
class Round {
  private readonly statements = new Map<string, { soql: string; all: boolean; atMost: boolean }>();
  private readonly answers = new Map<string, Counted>();

  /** Ask for a count: its key, to read it back once the round is in. */
  ask(objectApiName: string, conditions: ReadonlyArray<string | Condition>): string {
    const statement = statementOf(
      objectApiName,
      conditions.map((condition) => (typeof condition === 'string' ? condition : condition.soql)),
    );
    const atMost = conditions.some(
      (condition) => typeof condition !== 'string' && !condition.exact,
    );
    const known = this.statements.get(statement.soql);
    this.statements.set(statement.soql, { ...statement, atMost: atMost || known?.atMost === true });
    return statement.soql;
  }

  get size(): number {
    return this.statements.size;
  }

  async run(org: EmptyCountOrg, stopped: () => boolean): Promise<boolean> {
    let cut = false;
    await inPool(
      [...this.statements].map(([key, { soql, all, atMost }]) => async () => {
        if (stopped()) {
          cut = true;
          this.answers.set(key, { unread: STOPPED });
          return;
        }
        try {
          const records = await (all ? org.countAll(soql) : org.count(soql));
          this.answers.set(key, { records, ...(atMost ? { atMost: true as const } : {}) });
        } catch (error) {
          this.answers.set(key, { unread: extractErrorMessage(error) });
        }
      }),
      COUNTS_AT_ONCE,
    );
    return cut;
  }

  answer(key: string): Counted {
    return this.answers.get(key) ?? { unread: STOPPED };
  }
}

/** `a` less `b`, when both are numbers; else what is known of why not. */
function less(a: Counted, b: Counted): Counted {
  if (a.records === undefined) return a;
  if (b.records === undefined) return { unread: b.unread ?? STOPPED };
  // What the second counts beyond what it names makes the difference look
  // smaller than it is: what is left is then at least this.
  return {
    records: Math.max(0, a.records - b.records),
    ...(b.atMost ? { atLeast: true as const } : {}),
  };
}

/**
 * Whether `counted` says for certain there is nothing: a zero the org gave,
 * not one left of a difference that may be short. Nothing is not listed.
 */
function none(counted: Counted): boolean {
  return counted.records === 0 && counted.atLeast !== true;
}

/** Whether `counted` may hold records: a number past zero, or no number at all. */
function mayHold(counted: Counted | undefined): boolean {
  return counted === undefined || counted.records === undefined || counted.records > 0;
}

/** The answer of a condition that does not read, said as a count: no number, and why. */
function unreadable(objectApiName: string): Counted {
  return { unread: `${objectApiName}: the lookup its records go by is hidden from the user` };
}

/** The price, which goes with its product and with its price book. */
const PRICE = 'PricebookEntry';
/** The product whose standard prices go with it. */
const PRODUCT = 'Product2';

/**
 * The condition that a price is in the standard price book, read through the
 * price's lookup to its book: nothing when the price's describe does not
 * list it.
 */
function standardPriceCondition(describes: ReadonlyMap<string, EmptyDescribe>): string | undefined {
  const book = describes
    .get(PRICE)
    ?.fields.find((field) => field.name.toLowerCase() === 'pricebook2id')?.relationshipName;
  const kept = keptRowsOf('Pricebook2');
  return book && kept ? `${book}.${kept}` : undefined;
}

/**
 * `lost` with one entry per pair — the same records said lost twice, under
 * two reasons, were listed twice (38 prices, then 36) — the one counting
 * more kept, or the one the org would not count.
 */
function onceEach(lost: readonly EmptyUndoLost[]): EmptyUndoLost[] {
  const kept = new Map<string, EmptyUndoLost>();
  const weight = (entry: EmptyUndoLost): number =>
    entry.records.records ?? Number.POSITIVE_INFINITY;
  for (const entry of lost) {
    const key = [entry.objectApiName, entry.field ?? '', entry.parent ?? ''].join('\u0000');
    const known = kept.get(key);
    if (!known || weight(entry) > weight(known)) kept.set(key, entry);
  }
  return [...kept.values()];
}

/**
 * Count what deleting `input`'s passes would delete and refuse: see the
 * module's comment. Nothing is written.
 *
 * @param stopped - Asked before each count is sent: once it says so, the
 *   counts not sent come back with no number and the result says it stopped.
 * @param options.undo - Whether what no undo would bring back is counted:
 *   not of records deleted for good, which none brings back.
 */
export async function countEmpty(
  input: EmptyCountInput,
  org: EmptyCountOrg,
  stopped: () => boolean = () => false,
  options: { undo: boolean } = { undo: true },
): Promise<EmptyCounts> {
  const { affected, order, relations, describes } = input;
  const emptied = order.passes.map((pass) => pass.objectApiName);
  const personAccounts =
    describes.get(CONTACT)?.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG) === true;
  /**
   * The rows of `name` its emptying deletes, every pass together, as a
   * condition: those its pass sends, and a person account's contact too when
   * its account goes. Nothing when it deletes every row.
   */
  const deletedRowOf = (name: string): string | undefined => {
    const rows = passRowsOf(name, personAccounts);
    if (name.toLowerCase() === CONTACT.toLowerCase() && affected.emptied.has(ACCOUNT)) {
      return undefined;
    }
    return rows;
  };
  const deletedRows = (name: string): string[] => {
    const rows = deletedRowOf(name);
    return rows === undefined ? [] : [rows];
  };
  // What hangs from a record by a route, read up to the rows the emptying
  // deletes: a case naming a person account's contact names one that stays,
  // and blocked nothing.
  const steps = (route: readonly RouteStep[]): Condition | undefined =>
    stepsCondition(route, describes, deletedRowOf);
  const anyRoute = (routes: readonly Route[]): Condition | undefined =>
    anyRouteCondition(routes, describes, deletedRowOf);
  const namesDeleted = (child: string, field: string, parent: string): Condition | undefined =>
    namesDeletedCondition(child, field, parent, affected, describes, deletedRowOf);

  // The first round: each emptied object's own records.
  const first = new Round();
  const ownKeys = new Map<string, string>();
  for (const name of emptied) ownKeys.set(name, first.ask(name, deletedRows(name)));
  let cut = await first.run(org, stopped);
  const own = new Map(emptied.map((name) => [name, first.answer(ownKeys.get(name) ?? '')]));

  /** Whether records of `name` may be deleted: emptied and holding some, or going with one that does. */
  const mayGo = (name: string): boolean =>
    [...carriersOf(name, affected)].some((carrier) => mayHold(own.get(carrier)));
  const routesFrom = (routes: readonly Route[]): Route[] =>
    routes.filter((route) => mayHold(own.get(route.emptied)));

  const second = new Round();
  const asked = {
    archived: new Map<string, string>(),
    kept: new Map<string, string>(),
    goneBefore: new Map<string, { key?: string; unreadable: boolean }>(),
    along: new Map<string, { total?: string; via: Array<{ route: Route; key?: string }> }>(),
    refusals: [] as Array<{ code: EmptyRefusalCode; objectApiName: string; key?: string }>,
    blockers: [] as Array<{
      objectApiName: string;
      field: string;
      parent: string;
      key?: string;
      /** Those of them that go along, to take off: they go before they could block. */
      going?: string;
    }>,
    undoLost: [] as Array<
      Omit<EmptyUndoLost, 'records'> & {
        key?: string;
        /** Set when more records than it counts go so: there are at least that many. */
        more?: true;
      }
    >,
  };

  for (const pass of order.passes) {
    const name = pass.objectApiName;
    if (!mayHold(own.get(name))) continue;
    const rows = deletedRows(name);
    if (countedWithArchived(name))
      asked.archived.set(name, second.ask(name, [...rows, 'IsArchived = true']));
    const kept = keptRowsOf(name);
    if (kept !== undefined) asked.kept.set(name, second.ask(name, [kept]));
    const before = routesFrom(pass.goneBefore);
    if (before.length > 0) {
      const condition = anyRoute(before);
      asked.goneBefore.set(
        name,
        condition
          ? { key: second.ask(name, [...rows, condition]), unreadable: false }
          : { unreadable: true },
      );
    }
    const after = options.undo ? routesFrom(pass.sentBeforeTheirParent) : [];
    for (const route of after) {
      const condition = steps(route.steps);
      const step = route.steps[0];
      asked.undoLost.push({
        objectApiName: name,
        field: step.field,
        parent: step.parent,
        reason: 'unordered',
        ...(condition ? { key: second.ask(name, [...rows, condition]) } : {}),
      });
    }
  }

  for (const name of affected.along) {
    const routes = routesFrom(affected.routes.get(name) ?? []);
    if (routes.length === 0) continue;
    const via = routes.map((route) => {
      const condition = steps(route.steps);
      return { route, ...(condition ? { key: second.ask(name, [condition]) } : {}) };
    });
    const total = routes.length > 1 ? anyRoute(routes) : undefined;
    asked.along.set(name, {
      ...(total ? { total: second.ask(name, [total]) } : via[0].key ? { total: via[0].key } : {}),
      via,
    });
  }

  for (const pair of options.undo ? order.beforeParent : []) {
    // A custom price goes with its book, before its product, and came back
    // with it: the 36 counted lost of the product came back but for the
    // product's standard prices, counted below.
    if (pair.reason === 'customPrices') continue;
    if (!mayGo(pair.objectApiName) || !mayGo(pair.parent)) continue;
    const names = namesDeleted(pair.objectApiName, pair.field, pair.parent);
    const conditions: Condition[] = [];
    if (!affected.emptied.has(pair.objectApiName)) {
      const goes = anyRoute(routesFrom(affected.routes.get(pair.objectApiName) ?? []));
      if (goes) conditions.push(goes);
    }
    asked.undoLost.push({
      objectApiName: pair.objectApiName,
      field: pair.field,
      parent: pair.parent,
      reason: 'restricted',
      ...(names ? { key: second.ask(pair.objectApiName, [...conditions, names]) } : {}),
    });
  }

  // The standard prices of the products emptied go with them, and did not
  // come back with them: in the undo of an emptying of the whole org, the
  // products came back and their two standard prices stayed "no longer in
  // the recycle bin".
  const deleted = (name: string): boolean =>
    affected.emptied.has(name) || affected.routes.has(name);
  if (options.undo && deleted(PRICE) && deleted(PRODUCT) && mayGo(PRODUCT)) {
    const withProduct = namesDeleted(PRICE, 'Product2Id', PRODUCT);
    const standard = standardPriceCondition(describes);
    asked.undoLost.push({
      objectApiName: PRICE,
      field: 'Product2Id',
      parent: PRODUCT,
      reason: 'standardPrices',
      ...(withProduct && standard ? { key: second.ask(PRICE, [standard, withProduct]) } : {}),
    });
  }

  // An object going along blocks by the records of it that stay: those
  // naming a deleted record, less those that go along themselves.
  for (const { parent, child, field, kind } of relations) {
    if (kind !== 'restricted' || child === parent) continue;
    if (affected.emptied.has(child) || !mayGo(parent)) continue;
    const names = namesDeleted(child, field, parent);
    const goes = affected.routes.has(child)
      ? anyRoute(routesFrom(affected.routes.get(child) ?? []))
      : undefined;
    asked.blockers.push({
      objectApiName: child,
      field,
      parent,
      ...(names ? { key: second.ask(child, [names]) } : {}),
      ...(names && goes ? { going: second.ask(child, [goes, names]) } : {}),
    });
  }

  // A lookup whose parent the org refuses to delete while some of its records
  // live, though the parent's describe says its delete takes them along: an
  // opportunity closed won, "some opportunities of this account were closed
  // won" (`REFUSING_CASCADES`). Going along, those block their account. Of an
  // object emptied too, they go by its own pass once their account was
  // refused, with the account's other records of it, alone: no undo brings
  // them back once the rounds of tries have taken the account.
  for (const { child, field, parent, rows } of REFUSING_CASCADES) {
    if (rows === undefined || !mayGo(parent)) continue;
    const holds = describes.get(child)?.fields.some((each) => each.name === rows.field) === true;
    const names = holds ? namesDeleted(child, field, parent) : undefined;
    if (!names) continue;
    const refusing = `${rows.field} = ${String(rows.value)}`;
    if (affected.emptied.has(child)) {
      if (!options.undo || !mayHold(own.get(child))) continue;
      asked.undoLost.push({
        objectApiName: child,
        field,
        parent,
        reason: 'restricted',
        key: second.ask(child, [refusing, names]),
        more: true,
      });
    } else if (affected.routes.has(child)) {
      asked.blockers.push({
        objectApiName: child,
        field,
        parent,
        key: second.ask(child, [refusing, names]),
      });
    }
  }

  const refusal = (
    code: EmptyRefusalCode,
    objectApiName: string,
    conditions: Array<string | Condition>,
  ): void => {
    asked.refusals.push({ code, objectApiName, key: second.ask(objectApiName, conditions) });
  };
  for (const name of order.toDraft) {
    if (!mayGo(name)) continue;
    const pastDraft = "StatusCode != 'Draft'";
    if (affected.emptied.has(name)) {
      refusal('activatedOrder', name, [pastDraft]);
      continue;
    }
    const goes = anyRoute(routesFrom(affected.routes.get(name) ?? []));
    refusal('activatedOrder', name, goes ? [goes, pastDraft] : [{ soql: pastDraft, exact: false }]);
  }
  for (const [name, key] of asked.kept)
    asked.refusals.push({ code: 'standardPriceBook', objectApiName: name, key });
  if (
    affected.emptied.has(ACCOUNT_CONTACT_RELATION) &&
    mayHold(own.get(ACCOUNT_CONTACT_RELATION))
  ) {
    // Those whose contact goes along go with it: which they are, no count
    // of the relation alone says.
    if (!affected.emptied.has(CONTACT)) {
      refusal('directContactRelation', ACCOUNT_CONTACT_RELATION, [
        { soql: 'IsDirect = true', exact: !affected.routes.has(CONTACT) },
      ]);
    }
  }
  const contact = describes.get(CONTACT);
  if (
    affected.emptied.has(CONTACT) &&
    !affected.emptied.has(ACCOUNT) &&
    mayHold(own.get(CONTACT)) &&
    contact?.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG) === true
  ) {
    refusal('personAccountContact', CONTACT, [`${PERSON_ACCOUNT_FLAG} = true`]);
  }

  cut = (await second.run(org, stopped)) || cut;

  const objects = order.passes.map((pass): EmptyObjectCount => {
    const name = pass.objectApiName;
    const rows = passRowsOf(name, personAccounts);
    const records = own.get(name) ?? { unread: STOPPED };
    if (!mayHold(records)) {
      return {
        objectApiName: name,
        ...(rows !== undefined ? { rows } : {}),
        records,
        sent: records,
      };
    }
    const gone = asked.goneBefore.get(name);
    const sent =
      gone === undefined
        ? records
        : gone.unreadable || gone.key === undefined
          ? unreadable(name)
          : less(records, second.answer(gone.key));
    const archived = asked.archived.get(name);
    const kept = asked.kept.get(name);
    return {
      objectApiName: name,
      ...(rows !== undefined ? { rows } : {}),
      records,
      sent,
      ...(archived ? { archived: second.answer(archived) } : {}),
      ...(kept ? { kept: second.answer(kept) } : {}),
    };
  });
  // What the pass of an object no undelete brings back on its own sends: a
  // price no book held, sent by the pass of the prices, stayed gone.
  const notRestorable: EmptyUndoLost[] = options.undo
    ? objects
        .filter(
          (object) =>
            describes.get(object.objectApiName)?.undeletable === false && !none(object.sent),
        )
        .map((object) => ({
          objectApiName: object.objectApiName,
          reason: 'notRestorable' as const,
          records: object.sent,
        }))
    : [];
  const along = [...asked.along]
    .map(([name, { total, via }]) => ({
      objectApiName: name,
      records: total ? second.answer(total) : unreadable(name),
      via: via
        .map(({ route, key }) => ({
          field: route.steps[0].field,
          parent: route.steps[0].parent,
          emptied: route.emptied,
          records: key ? second.answer(key) : unreadable(name),
        }))
        .filter((route) => !none(route.records)),
    }))
    .filter((object) => !none(object.records));
  const answered = <T extends { key?: string; going?: string; more?: true; objectApiName: string }>(
    entries: readonly T[],
  ): Array<Omit<T, 'key' | 'going' | 'more'> & { records: Counted }> =>
    entries
      .map(({ key, going, more, ...rest }) => {
        const counted = key ? second.answer(key) : unreadable(rest.objectApiName);
        const records = going ? less(counted, second.answer(going)) : counted;
        return {
          ...rest,
          records:
            more && (records.records ?? 0) > 0 ? { ...records, atLeast: true as const } : records,
        };
      })
      .filter((entry) => !none(entry.records));
  return {
    objects,
    along,
    refusals: answered(asked.refusals),
    blockers: answered(asked.blockers),
    undoLost: onceEach([...answered(asked.undoLost), ...notRestorable]),
    statements: first.size + second.size,
    ...(cut ? { stopped: true as const } : {}),
  };
}
