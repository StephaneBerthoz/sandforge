/**
 * The closure of a sample of the whole org: from the roots a draw keeps, the
 * records under them and the records they name, read through a reader of the
 * source this file knows only by its interface ({@link SampleReader}), and
 * the threshold each record enters the sample at.
 *
 * Each round, in this order, until nothing new is read:
 *
 * 1. Up. The records a record cannot be written without are read, and theirs,
 *    to the top. Then which records die is known: one whose own record type
 *    the run holds back, and one that cannot be written without a record the
 *    source does not hold, one outside its object's filter, one of an object
 *    the user left out, or one that dies itself. Up comes before down, so
 *    that a record that dies brings no records under it to read.
 * 2. With `parents: 'all'` (the default), the records a living record names
 *    by its other lookups at drawn objects are read too, and copied without
 *    their children; with `'required'`, those lookups stay empty when their
 *    record is not in the sample for itself.
 * 3. Down. Of each living root, and of each living record reached from above,
 *    the records that name it through a lookup that carries the draw are
 *    read: a hundred at most by default per record and relation, the newest
 *    by the date each was made, all of them under a master-detail. The
 *    newest as a statement `ORDER BY CreatedDate DESC, Id DESC LIMIT n` reads
 *    them, ties and records the reader gave no date of by their ids, the
 *    greatest first: the same whether the reader read a record's children
 *    through such a statement or in a list of all of them, and never what
 *    the sample's share is. A record read only as one a record
 *    names never brings the records under it: a price book read for one
 *    price would bring the whole catalog.
 *
 * Then each record gets the threshold it enters at, a root's index in the
 * draw's order (`compareRoots`), smaller first, -1 for a record of an object
 * copied whole: `above(r)` is the root's own index, or for a record reached
 * from above the least `above` of the living records it was reached under,
 * within their cap; its threshold is the least of `above(r)` and of the
 * thresholds of the living records that read it up. A sample at a share is
 * every living record whose threshold's rank is within it: a smaller share
 * keeps a part of a larger one, and every record it keeps has its records
 * that it cannot be written without, which entered no later than it did.
 * Least values are found from the smallest out, in any order the source
 * answered in.
 */

import type { ForgeSampleParents, WholeOrgSampleDropReason } from '@sandforge/shared';
import { ACCOUNT, CONTACT } from '../../../core/common/platformRecords.js';
import { type SampleLink, type SampleLinks, namesParent } from './sampleLinks.js';
import { compareIds, idKey, type DrawnRoot } from './sampleRank.js';

/**
 * A record as the plan reads it: its id, the lookups the sample reads of its
 * object (`fieldsToRead`), and what decides its weight and whether it can be
 * written. Never a value of any other field.
 */
export interface SampleRow {
  id: string;
  /** Each lookup of `fieldsToRead`, as the source holds it: an id, or empty. */
  refs: Readonly<Record<string, string | null | undefined>>;
  /** Its record type, of an object that has record types. */
  recordTypeId?: string | null;
  /** An account of a person account, or the contact the platform writes with one (`IsPersonAccount`). */
  personAccount?: boolean;
  /** Read by id, the record is outside its object's filter: never in the sample. */
  outsideFilter?: boolean;
  /** The run links it to the target's own record, and never writes it: the standard price book. */
  matched?: boolean;
  /**
   * The records it cannot be written without that none of its lookups names:
   * a custom price's standard price, of its product, currency and selling
   * model. Null where the source holds none: the record cannot be written.
   */
  also?: ReadonlyArray<{ objectApiName: string; id: string | null }>;
  /** The data storage it takes, where it is its own: an email's size. */
  bytes?: number;
  /**
   * When it was made, in milliseconds, where the reader read it: of a record
   * read under a cap, the order its newest are kept in. Absent, its id.
   */
  created?: number;
}

/**
 * Whether record `a` is newer than record `b`: the later made first; ties,
 * and records with no date after those with one, by their ids, the greatest
 * first — the order `ORDER BY CreatedDate DESC, Id DESC` reads them in.
 */
export function newerFirst(a: SampleRow, b: SampleRow): number {
  if (a.created !== b.created) {
    if (a.created === undefined) return 1;
    if (b.created === undefined) return -1;
    return b.created - a.created;
  }
  return compareIds(b.id, a.id);
}

/**
 * A relation the draw goes down: the records of `objectApiName` whose
 * `field` names a record of one of `parents`.
 */
export interface SampleRelation {
  objectApiName: string;
  field: string;
  /** The objects the lookup names in the sample's draw; several for one that may name several. */
  parents: readonly string[];
  masterDetail: boolean;
}

/** The records a relation holds under the records asked. */
export interface SampleChildren {
  rows: readonly SampleRow[];
  /**
   * Per record asked, by its id, the records it holds through the relation
   * under the child object's filter, all of them, those past the cap too.
   * A record not in it was not counted — an object may refuse to count by
   * a lookup (FeedItem refuses `COUNT(Id)`), and its records are then read
   * in a list: the records given are all it has.
   */
  counts?: ReadonlyMap<string, number>;
}

/**
 * What a sample reads of the source. Every read gives back the records it
 * found, in any order, each with the lookups `fieldsToRead` names of its
 * object; every one counts its requests and keeps to what the org accepts.
 */
export interface SampleReader {
  /**
   * The records of `objectApiName` among `ids`, read by id under no filter,
   * the recycle bin left out: an id not given back is one the source does
   * not hold. One outside its object's filter comes marked so.
   */
  rows(objectApiName: string, ids: readonly string[]): Promise<readonly SampleRow[]>;
  /**
   * The records of the relation's object whose lookup names one of
   * `parentIds`, under its filter: at most `cap` per record asked, the
   * newest by the date each was made ({@link newerFirst}), or all of them;
   * with how many each has, where it counted them.
   */
  children(
    relation: SampleRelation,
    parentIds: readonly string[],
    cap: number | 'all',
  ): Promise<SampleChildren>;
  /** Every record of an object copied whole, under its filter. */
  whole(objectApiName: string): Promise<readonly SampleRow[]>;
}

/** The decisions a sample is closed by. */
export interface SampleClosureOptions {
  /** What an optional lookup at a record outside the sample becomes: see `ForgeSampleParents`. */
  parents: ForgeSampleParents;
  /** The most records of a record per relation, master-details aside, the newest ({@link newerFirst}). */
  children: number | 'all';
  /**
   * Why a record of `objectApiName` of the record type `recordTypeId` is
   * held back: a type closed to the user the run writes as, or one the
   * target has none of; nothing when it goes.
   */
  recordTypeVerdict?: (
    objectApiName: string,
    recordTypeId: string,
  ) => 'heldBack' | 'recordTypeNotInTarget' | undefined;
  /** The most records the closure holds before it stops ({@link SAMPLE_MAX_ROWS}). */
  maxRows?: number;
  signal?: AbortSignal;
  /** Told the records read, after each read. */
  onRows?: (rows: number) => void;
}

/** The most records a sample holds in memory as it is drawn. */
export const SAMPLE_MAX_ROWS = 1_000_000;

/** Thrown when the records a sample reads pass {@link SAMPLE_MAX_ROWS}: nothing is drawn. */
export class SampleTooLarge extends Error {
  constructor(
    readonly rows: number,
    readonly most: number,
  ) {
    super(
      `Drawing the sample read ${rows} records, more than the ${most} it holds at once. ` +
        'Nothing was written. Lower the bound (--fit-within or --max-total), or leave objects ' +
        'out (--exclude-object) or narrow them (--filter).',
    );
    this.name = 'SampleTooLarge';
  }
}

/** Thrown when the drawing is cancelled. */
export class SampleCancelled extends Error {
  constructor() {
    super('The sample was cancelled before it was drawn. Nothing was written.');
    this.name = 'SampleCancelled';
  }
}

/** The contact's lookup at its account, which a person account's contact cannot be written without. */
const CONTACT_ACCOUNT_FIELD = 'AccountId';

/** A record named by a record: by its object and id. */
interface Named {
  objectApiName: string;
  id: string;
}

/** A record of a record's way up, and the field that names it. */
interface UpTarget {
  row: number;
  field: string;
}

/** Thresholds of the records of a closure: see {@link SampleClosure.thresholds}. */
export interface SampleThresholds {
  /** Per record, its threshold: a root's index, -1 for an object copied whole, Infinity when none. */
  threshold: Float64Array;
  /** Per record, its `above`: the root's index it was reached under, Infinity when none. */
  above: Float64Array;
  /**
   * Per record, the relation it got its threshold by, `object.field`: the
   * lookup it was reached under, or the lookup of the record that read it up.
   * Absent for a root and for a record of an object copied whole.
   */
  via: Array<string | undefined>;
}

/** A queue of records by a value, the smallest first. */
class MinQueue {
  private readonly values: number[] = [];
  private readonly rows: number[] = [];

  get size(): number {
    return this.rows.length;
  }

  push(value: number, row: number): void {
    const { values, rows } = this;
    values.push(value);
    rows.push(row);
    let at = rows.length - 1;
    while (at > 0) {
      const up = (at - 1) >> 1;
      if (values[up] <= values[at]) break;
      [values[at], values[up]] = [values[up], values[at]];
      [rows[at], rows[up]] = [rows[up], rows[at]];
      at = up;
    }
  }

  /** The smallest value and its record, taken out. */
  pop(): [number, number] {
    const { values, rows } = this;
    const top: [number, number] = [values[0], rows[0]];
    const lastValue = values.pop()!;
    const lastRow = rows.pop()!;
    if (rows.length > 0) {
      values[0] = lastValue;
      rows[0] = lastRow;
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let least = at;
        if (left < rows.length && values[left] < values[least]) least = left;
        if (right < rows.length && values[right] < values[least]) least = right;
        if (least === at) break;
        [values[at], values[least]] = [values[least], values[at]];
        [rows[at], rows[least]] = [rows[least], rows[at]];
        at = least;
      }
    }
    return top;
  }
}

/**
 * The records of a sample as they are read, and how each came: see the
 * file's header. Roots are added a batch at a time, the smallest ranks first;
 * each batch is closed before the next is added.
 */
export class SampleClosure {
  /** Per record: what was read of it, its object, and its index in the draw when it is a root (else -1). */
  readonly rows: SampleRow[] = [];
  readonly objectOf: string[] = [];
  readonly rootOf: number[] = [];
  /** Per record: of an object copied whole and read. */
  readonly whole: boolean[] = [];
  /** Per record: why it is never in the sample; `out` for one outside its object's filter. */
  readonly dead: Array<WholeOrgSampleDropReason | undefined> = [];
  readonly out: boolean[] = [];

  /** Per object, its records by id key. */
  private readonly index = new Map<string, Map<string, number>>();
  /** Per object, the ids asked that the source does not hold. */
  private readonly absent = new Map<string, Set<string>>();
  /** The objects copied whole whose every record was read. */
  private readonly wholeRead = new Set<string>();

  /** Per record, the records reached under it within its cap, and the relation. */
  private readonly below = new Map<number, Array<{ child: number; relation: string }>>();
  /** Per relation `object.field`, per record of it descended, the records the cap left out. */
  private readonly cuts = new Map<string, Map<number, number>>();

  /** Per record, the records that cannot be written without it. */
  private readonly needs = new Map<number, number[]>();
  /** Per record not read yet, the records waiting on it as one they cannot be written without. */
  private readonly waiting = new Map<string, number[]>();
  /** Records to read, per object, by id key. */
  private readonly pending = new Map<string, Map<string, string>>();

  /** The records read up from, and whose optional parents were asked: those before each. */
  private upCursor = 0;
  private optionalCursor = 0;
  /** Per record, whether the draw went down from it; and those to go down from next. */
  private readonly descended: boolean[] = [];
  private toDescend: number[] = [];

  constructor(
    readonly links: SampleLinks,
    private readonly reader: SampleReader,
    readonly options: SampleClosureOptions,
  ) {}

  /** The record of `objectApiName` of id `id`, when read. */
  rowOf(objectApiName: string, id: string): number | undefined {
    return this.index.get(objectApiName)?.get(idKey(id));
  }

  /** Whether the source does not hold the record `id` of `objectApiName`, as read. */
  isAbsent(objectApiName: string, id: string): boolean {
    return this.absent.get(objectApiName)?.has(idKey(id)) === true;
  }

  /** Whether every record of the object copied whole was read. */
  wasReadWhole(objectApiName: string): boolean {
    return this.wholeRead.has(objectApiName);
  }

  /** Whether the record is alive: in the source, within its filter, and writable. */
  alive(row: number): boolean {
    return this.dead[row] === undefined;
  }

  /** Per relation `object.field`, per record descended, the records the cap left out. */
  get cut(): ReadonlyMap<string, ReadonlyMap<number, number>> {
    return this.cuts;
  }

  /** The records reached under `row` within its cap. */
  belowOf(row: number): ReadonlyArray<{ child: number; relation: string }> {
    return this.below.get(row) ?? [];
  }

  /**
   * Read every record of the objects copied whole whose records name drawn
   * records to be read up, or that a lookup of the run names, and close over
   * them. A record that names one the source does not hold, or holds outside
   * its filter, is then told: an orphan of the source is never sent as one.
   * The others are counted, not read: nothing of theirs is needed. Reference
   * data is matched by name in the target, never written.
   */
  async openWhole(): Promise<void> {
    const named = new Set<string>();
    for (const links of this.links.linksOf.values()) {
      for (const link of links) if (link.target === 'whole') named.add(link.parent);
    }
    for (const [objectApiName, kind] of this.links.classes) {
      if (kind.kind !== 'whole' || kind.why === 'referenceData') continue;
      const readsUp = (this.links.linksOf.get(objectApiName) ?? []).some(
        (link) => link.target === 'drawn' && (link.required || this.options.parents === 'all'),
      );
      if (!readsUp && !named.has(objectApiName)) continue;
      this.checkSignal();
      const rows = await this.reader.whole(objectApiName);
      this.wholeRead.add(objectApiName);
      for (const row of rows) {
        const at = this.register(objectApiName, row);
        this.whole[at] = true;
      }
      this.told();
    }
    await this.close();
  }

  /**
   * Add the roots of one batch, each read by id, and close over them.
   *
   * @param roots - The roots, in the draw's order.
   * @param first - The index in the draw of the first of them.
   */
  async addRoots(roots: readonly DrawnRoot[], first: number): Promise<void> {
    const byObject = new Map<string, Array<{ id: string; index: number }>>();
    roots.forEach((root, offset) => {
      const list = byObject.get(root.objectApiName) ?? [];
      list.push({ id: root.id, index: first + offset });
      byObject.set(root.objectApiName, list);
    });
    for (const [objectApiName, list] of [...byObject].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const toRead = list
        .filter(({ id }) => this.rowOf(objectApiName, id) === undefined)
        .map(({ id }) => id)
        .sort(compareIds);
      if (toRead.length > 0) {
        this.checkSignal();
        const rows = await this.reader.rows(objectApiName, toRead);
        for (const row of rows) this.register(objectApiName, row);
        this.markAbsent(objectApiName, toRead);
        this.told();
      }
      for (const { id, index } of list) {
        const at = this.rowOf(objectApiName, id);
        if (at === undefined || this.rootOf[at] >= 0) continue;
        this.rootOf[at] = index;
        this.toDescend.push(at);
      }
    }
    await this.close();
  }

  /** Read until nothing new comes: up, the optional parents, then down. */
  private async close(): Promise<void> {
    for (;;) {
      await this.readUp();
      if (await this.readOptionalParents()) continue;
      if (await this.readDown()) continue;
      return;
    }
  }

  /** Whether a lookup of `row` is one it cannot be written without. */
  private requiredHere(link: SampleLink, row: number): boolean {
    if (link.required) return true;
    // The platform writes a person account's contact with its account, and
    // refuses one sent alone: the account comes with it, whatever was asked.
    return (
      link.objectApiName === CONTACT &&
      link.field === CONTACT_ACCOUNT_FIELD &&
      link.parent === ACCOUNT &&
      this.rows[row].personAccount === true
    );
  }

  /**
   * The records `row` cannot be written without that a read may bring, and
   * why it dies without reading: a record of an object the user left out,
   * a record the source does not hold.
   */
  private requiredOf(row: number): { named: Named[]; dies?: WholeOrgSampleDropReason } {
    const objectApiName = this.objectOf[row];
    const { refs, also } = this.rows[row];
    const named: Named[] = [];
    let dies: WholeOrgSampleDropReason | undefined;
    for (const link of this.links.linksOf.get(objectApiName) ?? []) {
      if (!this.requiredHere(link, row)) continue;
      const value = refs[link.field];
      if (!namesParent(value, link)) continue;
      if (link.target === 'excluded') dies ??= 'excludedObject';
      else if (link.target === 'drawn' || this.wholeRead.has(link.parent)) {
        named.push({ objectApiName: link.parent, id: value });
      }
    }
    for (const other of also ?? []) {
      if (other.id === null) dies ??= 'noParentInSource';
      else if (this.readable(other.objectApiName)) {
        named.push({ objectApiName: other.objectApiName, id: other.id });
      }
    }
    return { named, ...(dies ? { dies } : {}) };
  }

  /**
   * Whether a record of `objectApiName` is one a sample reads by id: an
   * object of the run drawn, or copied whole and read whole. One copied
   * whole and not read is in whole already.
   */
  private readable(objectApiName: string): boolean {
    const kind = this.links.classes.get(objectApiName);
    return kind !== undefined && (kind.kind === 'drawn' || this.wholeRead.has(objectApiName));
  }

  /** The records `row` names by its lookups at drawn objects that are not required of it. */
  private optionalOf(row: number): Named[] {
    const objectApiName = this.objectOf[row];
    const { refs } = this.rows[row];
    const named: Named[] = [];
    for (const link of this.links.linksOf.get(objectApiName) ?? []) {
      if (link.target !== 'drawn' || this.requiredHere(link, row)) continue;
      const value = refs[link.field];
      if (namesParent(value, link)) named.push({ objectApiName: link.parent, id: value });
    }
    return named;
  }

  /**
   * The records `row` reads up as the sample is closed: those it cannot be
   * written without, and with `parents: 'all'` those its other lookups at
   * drawn objects name — each read, and with the field that names it.
   */
  upTargets(row: number): UpTarget[] {
    const objectApiName = this.objectOf[row];
    const { refs, also } = this.rows[row];
    const targets: UpTarget[] = [];
    for (const link of this.links.linksOf.get(objectApiName) ?? []) {
      if (link.target === 'excluded') continue;
      if (link.target === 'whole' && !this.wholeRead.has(link.parent)) continue;
      if (!this.requiredHere(link, row) && this.options.parents !== 'all') continue;
      const value = refs[link.field];
      if (!namesParent(value, link)) continue;
      const at = this.rowOf(link.parent, value);
      if (at !== undefined) targets.push({ row: at, field: link.field });
    }
    for (const other of also ?? []) {
      if (other.id === null || !this.readable(other.objectApiName)) continue;
      const at = this.rowOf(other.objectApiName, other.id);
      if (at !== undefined) targets.push({ row: at, field: `(${other.objectApiName})` });
    }
    return targets;
  }

  /** Read up, to the top, the records the records read cannot be written without. */
  private async readUp(): Promise<void> {
    for (;;) {
      for (; this.upCursor < this.rows.length; this.upCursor++) {
        const row = this.upCursor;
        const { named, dies } = this.requiredOf(row);
        if (dies) this.kill(row, dies);
        for (const target of named) this.need(row, target);
      }
      if (this.pending.size === 0) return;
      await this.readPending();
    }
  }

  /** Read the records living records name by their optional lookups; whether any was read. */
  private async readOptionalParents(): Promise<boolean> {
    if (this.options.parents !== 'all') return false;
    // Every record before the cursor was read up first: whether it dies is
    // known, and does not change.
    for (; this.optionalCursor < this.upCursor; this.optionalCursor++) {
      const row = this.optionalCursor;
      if (!this.alive(row)) continue;
      for (const target of this.optionalOf(row)) this.ask(target);
    }
    if (this.pending.size === 0) return false;
    await this.readPending();
    return true;
  }

  /** Go down from the living records a draw reached, not gone down from yet; whether any was. */
  private async readDown(): Promise<boolean> {
    const relations = new Map<
      string,
      { masterDetail: boolean; parents: Map<string, number>; objects: Set<string> }
    >();
    const next = this.toDescend;
    this.toDescend = [];
    for (const row of next) {
      if (this.descended[row] || !this.alive(row)) continue;
      this.descended[row] = true;
      for (const link of this.links.carriersInto.get(this.objectOf[row]) ?? []) {
        const key = `${link.objectApiName}.${link.field}`;
        let entry = relations.get(key);
        if (!entry) {
          entry = { masterDetail: link.masterDetail, parents: new Map(), objects: new Set() };
          relations.set(key, entry);
        }
        entry.objects.add(link.parent);
        entry.parents.set(idKey(this.rows[row].id), row);
      }
    }
    if (relations.size === 0) return false;
    for (const [key, entry] of [...relations].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const dot = key.indexOf('.');
      const relation: SampleRelation = {
        objectApiName: key.slice(0, dot),
        field: key.slice(dot + 1),
        parents: [...entry.objects].sort(),
        masterDetail: entry.masterDetail,
      };
      const cap = relation.masterDetail ? 'all' : this.options.children;
      const ids = [...entry.parents.values()].map((row) => this.rows[row].id).sort(compareIds);
      this.checkSignal();
      const answer = await this.reader.children(relation, ids, cap);
      const under = new Map<number, Map<string, SampleRow>>();
      for (const child of answer.rows) {
        const value = child.refs[relation.field];
        if (typeof value !== 'string' || value === '') continue;
        const parent = entry.parents.get(idKey(value));
        if (parent === undefined) continue;
        const list = under.get(parent) ?? new Map<string, SampleRow>();
        if (!list.has(idKey(child.id))) list.set(idKey(child.id), child);
        under.set(parent, list);
      }
      const counts = new Map<string, number>();
      for (const [id, count] of answer.counts ?? []) counts.set(idKey(id), count);
      const cuts = this.cuts.get(key) ?? new Map<number, number>();
      for (const [parent, list] of [...under].sort(([a], [b]) => a - b)) {
        // The newest by the date each was made, ties by our order of ids,
        // the greatest first: whatever order the source gave them in, and
        // however many past the cap.
        const last = [...list.values()].sort(newerFirst);
        const kept = cap === 'all' ? last : last.slice(0, cap);
        const children = this.below.get(parent) ?? [];
        for (const child of kept) {
          const at = this.register(relation.objectApiName, child);
          children.push({ child: at, relation: key });
          if (!this.descended[at]) this.toDescend.push(at);
        }
        this.below.set(parent, children);
        const has = counts.get(idKey(this.rows[parent].id)) ?? list.size;
        if (has > kept.length) cuts.set(parent, has - kept.length);
      }
      if (cuts.size > 0) this.cuts.set(key, cuts);
      this.told();
    }
    return true;
  }

  /** Note that `row` cannot be written without `target`, reading it when it is not read. */
  private need(row: number, target: Named): void {
    const at = this.rowOf(target.objectApiName, target.id);
    if (at !== undefined) {
      this.tie(at, row);
      return;
    }
    if (this.isAbsent(target.objectApiName, target.id)) {
      this.kill(row, 'noParentInSource');
      return;
    }
    const key = `${target.objectApiName}\n${idKey(target.id)}`;
    const list = this.waiting.get(key) ?? [];
    list.push(row);
    this.waiting.set(key, list);
    this.ask(target);
  }

  /** Ask for `target` to be read, unless it is read or known absent. */
  private ask(target: Named): void {
    if (this.rowOf(target.objectApiName, target.id) !== undefined) return;
    if (this.isAbsent(target.objectApiName, target.id)) return;
    const list = this.pending.get(target.objectApiName) ?? new Map<string, string>();
    list.set(idKey(target.id), target.id);
    this.pending.set(target.objectApiName, list);
  }

  /** Read what is asked, object by object in name order, the ids in our order. */
  private async readPending(): Promise<void> {
    const batch = [...this.pending].sort(([a], [b]) => (a < b ? -1 : 1));
    this.pending.clear();
    for (const [objectApiName, ids] of batch) {
      const list = [...ids.values()].sort(compareIds);
      this.checkSignal();
      const rows = await this.reader.rows(objectApiName, list);
      for (const row of rows) this.register(objectApiName, row);
      this.markAbsent(objectApiName, list);
      this.told();
    }
  }

  /** Mark the ids of `asked` not read as absent from the source, and kill what waits on them. */
  private markAbsent(objectApiName: string, asked: readonly string[]): void {
    for (const id of asked) {
      if (this.rowOf(objectApiName, id) !== undefined) continue;
      const set = this.absent.get(objectApiName) ?? new Set<string>();
      set.add(idKey(id));
      this.absent.set(objectApiName, set);
      const key = `${objectApiName}\n${idKey(id)}`;
      for (const row of this.waiting.get(key) ?? []) this.kill(row, 'noParentInSource');
      this.waiting.delete(key);
    }
  }

  /**
   * Keep a record read, once: the first reading of it stands. One the run
   * holds back for its record type, or outside its object's filter, dies.
   */
  private register(objectApiName: string, row: SampleRow): number {
    let ids = this.index.get(objectApiName);
    if (!ids) {
      ids = new Map();
      this.index.set(objectApiName, ids);
    }
    const key = idKey(row.id);
    const known = ids.get(key);
    if (known !== undefined) return known;
    const at = this.rows.length;
    this.rows.push(row);
    this.objectOf.push(objectApiName);
    this.rootOf.push(-1);
    this.whole.push(false);
    this.dead.push(undefined);
    this.out.push(false);
    this.descended.push(false);
    ids.set(key, at);
    const most = this.options.maxRows ?? SAMPLE_MAX_ROWS;
    if (this.rows.length > most) throw new SampleTooLarge(this.rows.length, most);
    if (row.outsideFilter) {
      this.out[at] = true;
      this.kill(at, 'outsideFilter');
    } else if (typeof row.recordTypeId === 'string' && row.recordTypeId !== '') {
      const verdict = this.options.recordTypeVerdict?.(objectApiName, row.recordTypeId);
      if (verdict) this.kill(at, verdict);
    }
    const waiting = this.waiting.get(`${objectApiName}\n${key}`);
    if (waiting) {
      this.waiting.delete(`${objectApiName}\n${key}`);
      for (const child of waiting) this.tie(at, child);
    }
    return at;
  }

  /** Note that `child` cannot be written without `parent`: it dies with it. */
  private tie(parent: number, child: number): void {
    const list = this.needs.get(parent) ?? [];
    list.push(child);
    this.needs.set(parent, list);
    if (!this.alive(parent)) this.kill(child, this.out[parent] ? 'outsideFilter' : 'withoutParent');
  }

  /** `row` dies for `reason`, and every record that cannot be written without it. */
  private kill(row: number, reason: WholeOrgSampleDropReason): void {
    if (!this.alive(row)) return;
    this.dead[row] = reason;
    const stack = [row];
    while (stack.length > 0) {
      const at = stack.pop()!;
      const why = this.out[at] ? 'outsideFilter' : 'withoutParent';
      for (const child of this.needs.get(at) ?? []) {
        if (!this.alive(child)) continue;
        this.dead[child] = why;
        stack.push(child);
      }
    }
  }

  private checkSignal(): void {
    if (this.options.signal?.aborted) throw new SampleCancelled();
  }

  private told(): void {
    this.options.onRows?.(this.rows.length);
  }

  /**
   * The threshold of each record read, with the roots `setAside` taken out:
   * see the file's header. A record that dies gets the threshold it would
   * have entered at, and passes none on.
   *
   * @param setAside - Indexes in the draw of roots set aside as too heavy.
   */
  thresholds(setAside: ReadonlySet<number> = new Set()): SampleThresholds {
    const n = this.rows.length;
    const above = new Float64Array(n).fill(Infinity);
    const via: Array<string | undefined> = new Array<string | undefined>(n);
    const viaAbove: Array<string | undefined> = new Array<string | undefined>(n);
    const queue = new MinQueue();
    for (let row = 0; row < n; row++) {
      const root = this.rootOf[row];
      if (root >= 0 && !setAside.has(root)) {
        above[row] = root;
        queue.push(root, row);
      }
    }
    const settled = new Uint8Array(n);
    while (queue.size > 0) {
      const [value, row] = queue.pop();
      if (settled[row] || value > above[row] || !this.alive(row)) continue;
      settled[row] = 1;
      for (const { child, relation } of this.below.get(row) ?? []) {
        if (value < above[child]) {
          above[child] = value;
          viaAbove[child] = relation;
          queue.push(value, child);
        } else if (value === above[child] && relation < (viaAbove[child] ?? '')) {
          // Reached as early by two relations: the first by name, read in any order.
          viaAbove[child] = relation;
        }
      }
    }
    const threshold = new Float64Array(above);
    for (let row = 0; row < n; row++) {
      if (this.whole[row]) threshold[row] = -1;
      if (threshold[row] !== Infinity) queue.push(threshold[row], row);
      via[row] = viaAbove[row];
    }
    settled.fill(0);
    while (queue.size > 0) {
      const [value, row] = queue.pop();
      if (settled[row] || value > threshold[row] || !this.alive(row)) continue;
      settled[row] = 1;
      for (const { row: target, field } of this.upTargets(row)) {
        const by = `${this.objectOf[row]}.${field}`;
        if (value < threshold[target]) {
          threshold[target] = value;
          via[target] = by;
          queue.push(value, target);
        } else if (value === threshold[target] && via[target] !== undefined && by < via[target]) {
          via[target] = by;
        }
      }
    }
    return { threshold, above, via };
  }
}
