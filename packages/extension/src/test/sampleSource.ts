/**
 * A source org in miniature for drawing a sample of the whole org: objects,
 * their lookups as a describe gives them, and records, read as a sample's
 * reader reads them (`SampleReader`):
 *
 * - by id, under no filter, a record outside its object's filter marked so,
 *   and an id the source does not hold simply not given back;
 * - the records under a relation, under the child object's filter, at most
 *   the cap per record asked, the newest by when each was made (`createdAt`),
 *   ties and undated records by id, each with that date, with how many each
 *   has — or
 *   none of them counted (`uncounted`), as an object that refuses to count
 *   by a lookup reads its records in a list — or, asked
 *   to (`pastTheCap`), every one of them, as a direct read of a list would;
 * - every record of an object copied whole, under its filter.
 *
 * Each answer comes in an order of its own, drawn from a seed (`order`): a
 * sample that depended on the order the org answers in would show it.
 *
 * Besides, what a test asks of a sample once drawn: the roots a draw reads
 * ({@link drawRootsOf}) — spread over the org, the newest or the oldest
 * first, held to a window of dates, a filter on the roots of an object, and
 * strata, as a reader of the org reads them —, and the lookups of the plan
 * that name a record the plan does not hold ({@link orphansOf}).
 *
 * Lives under `src/test/` with no `.test.ts` suffix: a helper, not a suite.
 */

import type { ForgeSampleDraw } from '@sandforge/shared';
import { countedStorageBytes } from '../modules/forge/ForgeRunGate';
import type { CascadingRelation } from '../modules/forge/masterDetail';
import {
  newerFirst,
  type SampleChildren,
  type SampleClosureOptions,
  type SampleReader,
  type SampleRelation,
  type SampleRow,
} from '../modules/forge/sample/sampleClosure';
import {
  documentedMeasure,
  drawTheSample,
  type SampleBounds,
  type SampleCut,
} from '../modules/forge/sample/sampleFit';
import {
  sampleLinksOf,
  isRootRow,
  linkNamed,
  namesParent,
  type SampleField,
  type SampleLinks,
  type SampleObjectInput,
} from '../modules/forge/sample/sampleLinks';
import {
  RootDraw,
  compareIds,
  idKey,
  rankOf,
  recentRankOf,
  rootsTheBudgetHolds,
} from '../modules/forge/sample/sampleRank';
import { StratifiedRoots, strataTakesOf, stratumKeyOf } from '../modules/forge/sample/sampleStrata';

/** A record of the fake source. */
export interface FakeRecord {
  id: string;
  refs?: Record<string, string | null>;
  recordTypeId?: string;
  personAccount?: boolean;
  /** Outside its object's filter: read by id, never under a relation nor whole. */
  filteredOut?: boolean;
  matched?: boolean;
  also?: Array<{ objectApiName: string; id: string | null }>;
  bytes?: number;
  /** When it was created, in any unit: the order a draw by recency reads roots in, the latest first. */
  createdAt?: number;
  /** When it was last modified, in the unit of `createdAt`: what a window on `LastModifiedDate` reads. */
  modifiedAt?: number;
  /** Its values of the fields its roots may be stratified by, or a filter on them may read, by field. */
  values?: Record<string, string | boolean | null>;
}

/** An object of the fake source. */
export interface FakeObject {
  name: string;
  keyPrefix: string;
  fields: SampleField[];
  /** Its relations to its children, as its describe lists them: see {@link cascadesTo}. */
  childRelationships?: CascadingRelation[];
  records: FakeRecord[];
}

/** A lookup of a fake object, as a describe gives it. */
export function lookup(
  name: string,
  referenceTo: string | string[],
  extra: Partial<SampleField> = {},
): SampleField {
  return {
    name,
    referenceTo: Array.isArray(referenceTo) ? referenceTo : [referenceTo],
    isMasterDetail: false,
    nillable: true,
    createable: true,
    updateable: true,
    ...extra,
  };
}

/** A lookup a record cannot be written without. */
export function required(name: string, referenceTo: string | string[]): SampleField {
  return lookup(name, referenceTo, { nillable: false });
}

/** A master-detail lookup its own field says (`cascadeDelete` read on the detail's field). */
export function masterDetail(name: string, referenceTo: string): SampleField {
  return lookup(name, referenceTo, { nillable: false, isMasterDetail: true });
}

/**
 * A relation of a parent to its children that its delete cascades to, as the
 * parent's describe lists it. Salesforce says a standard master-detail there
 * alone: a line item's `OpportunityId` is {@link required}, its field says no
 * cascade, and only the opportunity's list says it. An account's list says it
 * of its contacts too, whose `AccountId` may be left empty: a lookup.
 */
export function cascadesTo(childSObject: string, field: string): CascadingRelation {
  return { childSObject, field, isCascadeDelete: true };
}

/** An 18-character id of `prefix`, numbered `n`: the same `n` gives the same id. */
export function fakeId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(12, '0')}AAA`;
}

/** A pseudo-random sequence from a seed (mulberry32): the same seed, the same sequence. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The read of a record as a sample's reader gives it. */
function rowOf(record: FakeRecord, fields: readonly SampleField[]): SampleRow {
  const refs: Record<string, string | null> = {};
  for (const field of fields) refs[field.name] = record.refs?.[field.name] ?? null;
  return {
    id: record.id,
    refs,
    ...(record.recordTypeId !== undefined ? { recordTypeId: record.recordTypeId } : {}),
    ...(record.personAccount ? { personAccount: true } : {}),
    ...(record.filteredOut ? { outsideFilter: true } : {}),
    ...(record.matched ? { matched: true } : {}),
    ...(record.also ? { also: record.also } : {}),
    ...(record.bytes !== undefined ? { bytes: record.bytes } : {}),
  };
}

/** What the fake source was asked, read by read. */
export interface FakeCall {
  kind: 'rows' | 'children' | 'whole';
  objectApiName: string;
  /** The ids asked, or the parents asked of a relation. */
  ids: readonly string[];
  field?: string;
  cap?: number | 'all';
}

/** The fake source: see the file's header. */
export class FakeSampleSource implements SampleReader {
  readonly calls: FakeCall[] = [];
  private readonly byName: Map<string, FakeObject>;
  private readonly shuffle: () => number;

  constructor(
    readonly objects: readonly FakeObject[],
    private readonly options: { order?: number; pastTheCap?: boolean; uncounted?: boolean } = {},
  ) {
    this.byName = new Map(objects.map((o) => [o.name, o]));
    this.shuffle = seeded(options.order ?? 1);
  }

  /** The objects as discovery would count them, under their filters, for a sample's links. */
  inputs(): SampleObjectInput[] {
    return this.objects.map((o) => ({
      objectApiName: o.name,
      rows: o.records.filter((r) => !r.filteredOut).length,
      keyPrefix: o.keyPrefix,
      fields: o.fields,
      ...(o.childRelationships ? { childRelationships: o.childRelationships } : {}),
    }));
  }

  /** Per object, the records the source holds under its filter. */
  sourceRows(): Map<string, number> {
    return new Map(this.inputs().map((o) => [o.objectApiName, o.rows ?? 0]));
  }

  private object(name: string): FakeObject {
    const object = this.byName.get(name);
    if (!object) throw new Error(`INVALID_TYPE: sObject type '${name}' is not supported.`);
    return object;
  }

  /** `rows` in an order of the source's own. */
  private mixed<T>(rows: T[]): T[] {
    const out = [...rows];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.shuffle() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  async rows(objectApiName: string, ids: readonly string[]): Promise<readonly SampleRow[]> {
    this.calls.push({ kind: 'rows', objectApiName, ids: [...ids] });
    const object = this.object(objectApiName);
    const asked = new Set(ids.map(idKey));
    return Promise.resolve(
      this.mixed(
        object.records.filter((r) => asked.has(idKey(r.id))).map((r) => rowOf(r, object.fields)),
      ),
    );
  }

  async children(
    relation: SampleRelation,
    parentIds: readonly string[],
    cap: number | 'all',
  ): Promise<SampleChildren> {
    this.calls.push({
      kind: 'children',
      objectApiName: relation.objectApiName,
      field: relation.field,
      ids: [...parentIds],
      cap,
    });
    const object = this.object(relation.objectApiName);
    const asked = new Set(parentIds.map(idKey));
    const byParent = new Map<string, FakeRecord[]>();
    for (const record of object.records) {
      if (record.filteredOut) continue;
      const value = record.refs?.[relation.field];
      if (typeof value !== 'string' || !asked.has(idKey(value))) continue;
      const list = byParent.get(idKey(value)) ?? [];
      list.push(record);
      byParent.set(idKey(value), list);
    }
    const rows: SampleRow[] = [];
    const counts = new Map<string, number>();
    for (const [parent, list] of byParent) {
      counts.set(parent, list.length);
      // Each with the date it was made, as the reader reads it under a cap.
      const dated = list.map((record) => ({
        ...rowOf(record, object.fields),
        ...(record.createdAt !== undefined ? { created: record.createdAt } : {}),
      }));
      const newest = dated.sort(newerFirst);
      const listed = this.options.uncounted || this.options.pastTheCap;
      const given = cap === 'all' || listed ? newest : newest.slice(0, cap);
      rows.push(...given);
    }
    return Promise.resolve(
      this.options.uncounted ? { rows: this.mixed(rows) } : { rows: this.mixed(rows), counts },
    );
  }

  async whole(objectApiName: string): Promise<readonly SampleRow[]> {
    this.calls.push({ kind: 'whole', objectApiName, ids: [] });
    const object = this.object(objectApiName);
    return Promise.resolve(
      this.mixed(object.records.filter((r) => !r.filteredOut).map((r) => rowOf(r, object.fields))),
    );
  }

  /** The records of `objectApiName` under its filter. */
  recordsOf(objectApiName: string): FakeRecord[] {
    return this.object(objectApiName).records.filter((r) => !r.filteredOut);
  }

  /** The ids the source holds of `objectApiName`, all of them, by id key. */
  holds(objectApiName: string, id: string): boolean {
    return this.byName.get(objectApiName)?.records.some((r) => idKey(r.id) === idKey(id)) ?? false;
  }

  /** The record of `objectApiName` of id `id`. */
  record(objectApiName: string, id: string): FakeRecord | undefined {
    return this.byName.get(objectApiName)?.records.find((r) => idKey(r.id) === idKey(id));
  }
}

/**
 * The dates a test draws roots in, in the unit of `createdAt` and
 * `modifiedAt`: from `from`, included, to before `to`.
 */
export interface FakeWindow {
  field: 'CreatedDate' | 'LastModifiedDate';
  from?: number;
  to?: number;
}

/** How a test draws the roots. */
export interface FakeDrawOptions {
  seed?: number;
  draw?: ForgeSampleDraw;
  floor?: number;
  /** The bytes the roots kept are counted against ({@link rootsTheBudgetHolds}). */
  bytes: number;
  maxTotal?: number;
  /** The dates the roots are drawn in: a record without the date is not. */
  window?: FakeWindow;
  /** Per object, the roots drawn among, as its filter on its roots would choose them. */
  rootWhere?: Readonly<Record<string, (record: FakeRecord) => boolean>>;
  /** Per object, the field of `FakeRecord.values` its roots are stratified by. */
  strata?: Readonly<Record<string, string>>;
  /** Every root of each stratum read, whatever the draw could keep: what the reads are held against. */
  readEveryRoot?: boolean;
  /** The order a scan spread over the org meets the roots in, drawn from it. */
  order?: number;
}

/**
 * Whether a root of `objectApiName` is in the draw: in the window, and
 * chosen by its object's filter on its roots.
 */
export function inTheDraw(
  objectApiName: string,
  record: FakeRecord,
  options: Pick<FakeDrawOptions, 'window' | 'rootWhere'>,
): boolean {
  const { window } = options;
  if (window) {
    const at = window.field === 'CreatedDate' ? record.createdAt : record.modifiedAt;
    if (at === undefined) return false;
    if (window.from !== undefined && at < window.from) return false;
    if (window.to !== undefined && at >= window.to) return false;
  }
  const where = options.rootWhere?.[objectApiName];
  return where === undefined || where(record);
}

/**
 * The order of a draw by date: the latest created first (`recent`), ties by
 * the greatest id, as `ORDER BY CreatedDate DESC, Id DESC` reads them; or the
 * first (`oldest`), `ORDER BY CreatedDate ASC, Id ASC`.
 */
export function byDateOf(draw: 'recent' | 'oldest'): (a: FakeRecord, b: FakeRecord) => number {
  return draw === 'recent'
    ? (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || compareIds(b.id, a.id)
    : (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || compareIds(a.id, b.id);
}

/** A record's value of `field`, none when it has none. */
function valueOf(record: FakeRecord, field: string): string | boolean | null {
  return record.values?.[field] ?? null;
}

/**
 * The roots a draw keeps, read as a sample's reader reads them: every root of
 * each object drawn from its roots, under its filter, in the window and
 * chosen by the filter on its roots, ranked by the seed — or by date, the
 * latest or the first created first, then the id, as long as the draw keeps
 * them. An object stratified is counted by value, then each stratum read as
 * far as it can enter — every root scanned and its smallest kept, or the
 * first by date of each value — and ranked in its stratum (`sampleStrata`).
 *
 * Besides the draw, the ids of the roots each object read (`read`), and its
 * strata.
 */
export function drawRootsOf(
  source: FakeSampleSource,
  links: SampleLinks,
  options: FakeDrawOptions,
) {
  const most = rootsTheBudgetHolds(options.bytes, options.maxTotal);
  const floor = options.floor ?? 1;
  const seed = options.seed ?? 1;
  const by = options.draw ?? 'uniform';
  const draw = new RootDraw(most, floor);
  const shuffle = seeded((options.order ?? 1) * 7919 + 13);
  const mixed = <T>(rows: readonly T[]): T[] => {
    const out = [...rows];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(shuffle() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const read = new Map<string, Set<string>>();
  const strata = new Map<string, StratifiedRoots>();
  for (const [objectApiName, kind] of [...links.classes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (kind.kind !== 'drawn' || !kind.rooted) continue;
    const roots = source
      .recordsOf(objectApiName)
      .filter((record) => isRootRow(links, objectApiName, record.refs ?? {}))
      .filter((record) => inTheDraw(objectApiName, record, options));
    const readOf = new Set<string>();
    read.set(objectApiName, readOf);
    const field = options.strata?.[objectApiName];
    if (field !== undefined) {
      // Counted as the org groups them, then read as far as each can enter.
      const groups = new Map<string, { value: string | boolean | null; roots: number }>();
      for (const record of roots) {
        const key = stratumKeyOf(valueOf(record, field));
        const group = groups.get(key) ?? { value: valueOf(record, field), roots: 0 };
        group.roots++;
        groups.set(key, group);
      }
      const counts = [...groups.values()];
      const takes = options.readEveryRoot
        ? counts.map((count) => count.roots)
        : strataTakesOf(
            counts.map((count) => count.roots),
            most,
            floor,
          );
      const stratified = new StratifiedRoots({
        objectApiName,
        field,
        strata: counts.map((count, index) => ({ ...count, take: takes[index] })),
        draw: by,
        seed,
        floor,
      });
      if (by === 'uniform') {
        for (const record of mixed(roots)) stratified.scanned(record.id, valueOf(record, field));
      } else {
        for (const { value, key, take } of stratified.reads()) {
          const ids = roots
            .filter((record) => stratumKeyOf(valueOf(record, field)) === key)
            .sort(byDateOf(by))
            .slice(0, take)
            .map((record) => record.id);
          stratified.read(value, ids);
        }
      }
      for (const root of stratified.ranked()) {
        draw.offer(objectApiName, root.id, root.rank, root.stratum);
        readOf.add(idKey(root.id));
      }
      draw.leftUnread(stratified.firstUnread);
      strata.set(objectApiName, stratified);
    } else if (by !== 'uniform') {
      const ordered = [...roots].sort(byDateOf(by));
      for (let position = 0; position < ordered.length; position++) {
        const rank = recentRankOf(position, ordered.length);
        if (!draw.keeps(objectApiName, rank)) {
          draw.leftUnread(rank);
          break;
        }
        draw.offer(objectApiName, ordered[position].id, rank);
        readOf.add(idKey(ordered[position].id));
      }
    } else {
      for (const record of mixed(roots)) {
        draw.offer(objectApiName, record.id, rankOf(seed, record.id));
        readOf.add(idKey(record.id));
      }
    }
  }
  const byBytes = Math.floor(options.bytes / 1024);
  return {
    roots: draw.drawn(),
    beyond: draw.beyond,
    heldBy:
      options.maxTotal !== undefined && options.maxTotal < byBytes
        ? ('maxTotal' as const)
        : ('storage' as const),
    floor,
    read,
    strata,
  };
}

/** A lookup of the plan that names a record the plan does not hold. */
export interface FakeOrphan {
  objectApiName: string;
  id: string;
  field: string;
  names: string;
  required: boolean;
}

/**
 * The lookups of the records of a sample at objects of the run that name a
 * record it does not hold: every record of an object copied whole and not
 * read is held; one the platform writes with its account (a person account's
 * contact) holds its account as a record it cannot be written without.
 *
 * A sample without orphans has none that is `required`, and, with
 * `parents: 'all'`, none other than those it says it leaves empty.
 */
export function orphansOf(
  source: FakeSampleSource,
  links: SampleLinks,
  cut: Pick<SampleCut, 'ids'>,
): FakeOrphan[] {
  const held = (objectApiName: string, id: string): boolean => {
    const kind = links.classes.get(objectApiName);
    if (kind?.kind === 'whole' && !cut.ids.has(objectApiName)) {
      return source.recordsOf(objectApiName).some((r) => idKey(r.id) === idKey(id));
    }
    return (cut.ids.get(objectApiName) ?? []).some((kept) => idKey(kept) === idKey(id));
  };
  const orphans: FakeOrphan[] = [];
  for (const [objectApiName, ids] of cut.ids) {
    for (const id of ids) {
      const record = source.record(objectApiName, id);
      if (!record) {
        orphans.push({ objectApiName, id, field: 'Id', names: id, required: true });
        continue;
      }
      for (const link of links.linksOf.get(objectApiName) ?? []) {
        const value = record.refs?.[link.field];
        if (!namesParent(value, link) || link.target === 'excluded') continue;
        if (held(link.parent, value)) continue;
        const personsAccount =
          objectApiName === 'Contact' &&
          link.field === 'AccountId' &&
          record.personAccount === true;
        orphans.push({
          objectApiName,
          id,
          field: link.field,
          names: value,
          required: link.required || personsAccount,
        });
      }
      for (const other of record.also ?? []) {
        if (other.id === null || !held(other.objectApiName, other.id)) {
          orphans.push({
            objectApiName,
            id,
            field: `(${other.objectApiName})`,
            names: other.id ?? '',
            required: true,
          });
        }
      }
    }
  }
  return orphans;
}

/** The orphans of a sample counted per object and field, as its `leftEmpty` says them. */
export function emptiedOf(
  orphans: readonly FakeOrphan[],
): Array<{ objectApiName: string; field: string; rows: number }> {
  const counts = new Map<string, { objectApiName: string; field: string; rows: number }>();
  for (const orphan of orphans) {
    const key = `${orphan.objectApiName}\n${orphan.field}`;
    const entry = counts.get(key) ?? {
      objectApiName: orphan.objectApiName,
      field: orphan.field,
      rows: 0,
    };
    entry.rows++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) =>
    a.objectApiName === b.objectApiName
      ? a.field < b.field
        ? -1
        : 1
      : a.objectApiName < b.objectApiName
        ? -1
        : 1,
  );
}

/** Whether a lookup names its parent: for a test that reads a value as a link would. */
export function namedBy(
  links: SampleLinks,
  objectApiName: string,
  field: string,
  value: unknown,
): string | undefined {
  return linkNamed(links, objectApiName, field, value)?.parent;
}

/** How a test draws a sample of the fake source: see {@link drawFakeSample}. */
export interface FakeSampleOptions {
  bytes: number;
  bytesLimit?: SampleBounds['bytesLimit'];
  maxTotal?: number;
  requests?: SampleBounds['requests'];
  /** The room the objects copied whole are chosen against; none by default, so that every object is drawn. */
  wholeRoom?: number;
  /** The room the heavy roots are weighed against; ten times the bytes by default. */
  roomBytes?: number;
  /** What the target's automation creates under each record of an object the run inserts; nothing by default. */
  automationBytes?: (objectApiName: string) => number;
  seed?: number;
  draw?: ForgeSampleDraw;
  floor?: number;
  /** See {@link FakeDrawOptions}. */
  window?: FakeWindow;
  rootWhere?: FakeDrawOptions['rootWhere'];
  strata?: FakeDrawOptions['strata'];
  readEveryRoot?: boolean;
  whole?: string[];
  referenceData?: string[];
  order?: number;
  closure?: Partial<SampleClosureOptions>;
}

/**
 * Draw a sample of `objects` as a run would: the objects and lookups, the
 * roots, then the closure and the cut, against the documented sizes.
 */
export async function drawFakeSample(objects: FakeObject[], options: FakeSampleOptions) {
  const source = new FakeSampleSource(objects, { order: options.order ?? 1 });
  const links = sampleLinksOf({
    objects: source.inputs(),
    roomBytes: options.wholeRoom ?? 0,
    wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    ...(options.whole ? { whole: options.whole } : {}),
    ...(options.referenceData ? { referenceData: new Set(options.referenceData) } : {}),
  });
  const draw = drawRootsOf(source, links, {
    bytes: options.bytes,
    maxTotal: options.maxTotal,
    seed: options.seed ?? 1,
    draw: options.draw ?? 'uniform',
    floor: options.floor ?? 1,
    order: options.order ?? 1,
    ...(options.window ? { window: options.window } : {}),
    ...(options.rootWhere ? { rootWhere: options.rootWhere } : {}),
    ...(options.strata ? { strata: options.strata } : {}),
    ...(options.readEveryRoot ? { readEveryRoot: true } : {}),
  });
  const cut = await drawTheSample({
    links,
    reader: source,
    draw,
    sourceRows: source.sourceRows(),
    options: { parents: 'all', children: 100, ...options.closure },
    measure: options.automationBytes
      ? { ...documentedMeasure, roomBytes: options.automationBytes }
      : documentedMeasure,
    bounds: {
      bytes: options.bytes,
      bytesLimit: options.bytesLimit ?? 'storage',
      ...(options.maxTotal !== undefined ? { maxTotal: options.maxTotal } : {}),
      ...(options.requests ? { requests: options.requests } : {}),
    },
    roomBytes: options.roomBytes ?? options.bytes * 10,
  });
  return { source, links, draw, cut };
}
