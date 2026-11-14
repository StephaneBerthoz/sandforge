import type { IdMapRow } from '@sandforge/shared';
import type { RecordKeys, RunRecords } from './ForgeRunRemoval.js';
import {
  hashA,
  hashB,
  journalLines,
  SourceIdIndex,
  UNATTRIBUTED_TAG,
  type RunFile,
} from './ForgeRunStore.js';

/**
 * A part of a run's journal as the readers of its ids take it — a removal,
 * the Id map saved — read from the journal a page at a time instead of whole.
 *
 * A run past the summary's bound keeps its ids in its journal, a million for
 * a run of whole tables, and its readers read them all into memory: the
 * table of every source id to its target, what the part created per object,
 * what it linked to, then the removal's plan of them, some hundreds of MB of
 * the extension host while a removal ran. Here the journal is gone through
 * once to index its lines — a few bytes a record, no id — and each reader
 * reads the lines it needs back from the file as it goes.
 *
 * What it gives is what the journal's whole read gives (`ForgeRunJournal.idsOf`),
 * and what a removal's plan makes of it (`forgeRunCreatedRecords`): the part's
 * records created, by the latest word on each in that part, each object's
 * records newest first and the objects too, and a record named twice taken
 * once. A record the part created stays the part's when another of its rows
 * is linked to it — the target refused that row as a copy of the record the
 * run had just written. The records a Bulk API job of the part wrote that no
 * row was matched to (`createdUnattributed`) are the part's too, though no
 * source row maps to them, and whether or not a row was linked to them since:
 * a removal takes them with the rest of their object.
 */

/** A Salesforce id, as every id a journal holds is. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;
/** An object's API name, as a journal names it. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A mapping line of a journal: a record created, linked to, or written over. */
interface Mapping {
  tag: 'c' | 'e' | 'u';
  sourceId: string;
  targetId: string;
  /** Empty for a mapping registered without its object. */
  object: string;
}

/** The mapping a line holds, as the journal's whole read takes it; nothing for any other line. */
function mappingOf(text: string): Mapping | undefined {
  if (!text.startsWith('["')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const [tag, sourceId, targetId, object] = value as unknown[];
  if (tag !== 'c' && tag !== 'e' && tag !== 'u') return undefined;
  if (typeof sourceId !== 'string' || !RECORD_ID.test(sourceId)) return undefined;
  if (typeof targetId !== 'string' || !RECORD_ID.test(targetId)) return undefined;
  return {
    tag,
    sourceId,
    targetId,
    object: typeof object === 'string' && OBJECT_NAME.test(object) ? object : '',
  };
}

/** The records a Bulk API job wrote that no row was matched to, as a line names them; nothing for any other line. */
export function unattributedOf(text: string): { object: string; ids: string[] } | undefined {
  if (!text.startsWith(`["${UNATTRIBUTED_TAG}"`)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const [, object, ids] = value as unknown[];
  if (typeof object !== 'string' || !OBJECT_NAME.test(object) || !Array.isArray(ids)) {
    return undefined;
  }
  return {
    object,
    ids: ids.filter((id): id is string => typeof id === 'string' && RECORD_ID.test(id)),
  };
}

/** A record's key: the first fifteen characters of its id. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** Where lines of a journal are, in the order kept: an offset and a length each. */
class LinePlaces {
  private offsets = new Float64Array(64);
  private lengths = new Uint16Array(64);
  size = 0;

  push(offset: number, length: number): void {
    if (this.size === this.offsets.length) {
      const offsets = new Float64Array(this.size * 2);
      offsets.set(this.offsets);
      this.offsets = offsets;
      const lengths = new Uint16Array(this.size * 2);
      lengths.set(this.lengths);
      this.lengths = lengths;
    }
    this.offsets[this.size] = offset;
    this.lengths[this.size] = length;
    this.size++;
  }

  offsetAt(at: number): number {
    return this.offsets[at];
  }

  lengthAt(at: number): number {
    return this.lengths[at];
  }
}

/**
 * Keys under two hashes each and nothing else: a few bytes a key. Two keys
 * whose hashes meet are taken for one — for the records a removal left, one
 * more record set out to be taken again, which the org says is gone.
 */
export class HashedKeys implements RecordKeys {
  private capacity = 1024;
  private used = 0;
  private h1 = new Uint32Array(this.capacity);
  private h2 = new Uint32Array(this.capacity);
  private taken = new Uint8Array(this.capacity);

  add(key: string): void {
    const a = hashA(key);
    const b = hashB(key);
    if (this.slotOf(a, b) >= 0) return;
    if (this.used + 1 > this.capacity * 0.6) this.grow();
    const slot = this.freeSlotFor(b);
    this.h1[slot] = a;
    this.h2[slot] = b;
    this.taken[slot] = 1;
    this.used++;
  }

  has(key: string): boolean {
    return this.slotOf(hashA(key), hashB(key)) >= 0;
  }

  get size(): number {
    return this.used;
  }

  private slotOf(a: number, b: number): number {
    const mask = this.capacity - 1;
    for (let slot = b & mask; ; slot = (slot + 1) & mask) {
      if (this.taken[slot] === 0) return -1;
      if (this.h1[slot] === a && this.h2[slot] === b) return slot;
    }
  }

  private freeSlotFor(b: number): number {
    const mask = this.capacity - 1;
    let slot = b & mask;
    while (this.taken[slot] !== 0) slot = (slot + 1) & mask;
    return slot;
  }

  private grow(): void {
    const { h1, h2, taken } = this;
    this.capacity *= 2;
    this.h1 = new Uint32Array(this.capacity);
    this.h2 = new Uint32Array(this.capacity);
    this.taken = new Uint8Array(this.capacity);
    for (let i = 0; i < taken.length; i++) {
      if (taken[i] === 0) continue;
      const slot = this.freeSlotFor(h2[i]);
      this.h1[slot] = h1[i];
      this.h2[slot] = h2[i];
      this.taken[slot] = 1;
    }
  }
}

/** Ids handed over a page at a time: see {@link JournalPart.runRecords}. */
const IDS_PER_PAGE = 2_000;

/** What a part of a run's journal created and mapped, indexed over its lines. */
export class JournalPart {
  private constructor(
    private readonly file: RunFile,
    /** Per source id, its latest line in every part. */
    private readonly all: SourceIdIndex,
    /** Per source id, its latest line in the part; 1 when that line says the part created it. */
    private readonly mine: SourceIdIndex,
    /** The source ids of the part, by their first line in it, in that order. */
    private readonly firstInPart: LinePlaces,
    /** The part's lines naming records a job wrote that no row was matched to. */
    private readonly unattributed: LinePlaces,
  ) {}

  /**
   * The part `part` of the journal `file`, gone through once; nothing for a
   * file that is not a run's journal, or a journal of 1.50, which keeps its
   * records in lines of a page each and is read whole.
   */
  static read(file: RunFile, part: number): JournalPart | undefined {
    const sourceAt = (offset: number, length: number): string =>
      mappingOf(file.read(offset, length).toString('utf8'))?.sourceId ?? '';
    const all = new SourceIdIndex(sourceAt);
    const mine = new SourceIdIndex(sourceAt);
    const firstInPart = new LinePlaces();
    const unattributed = new LinePlaces();
    let head = false;
    let current = -1;
    for (const line of journalLines(file)) {
      if (!head) {
        if (!line.text.startsWith('{"run":')) return undefined;
        head = true;
        continue;
      }
      if (line.text.startsWith('{"part":')) {
        current++;
        continue;
      }
      if (line.text.startsWith('{"object":')) return undefined;
      if (current === part && unattributedOf(line.text)) {
        unattributed.push(line.offset, line.length);
        continue;
      }
      const mapping = mappingOf(line.text);
      if (!mapping) continue;
      const a = hashA(mapping.sourceId);
      const b = hashB(mapping.sourceId);
      all.put(all.find(mapping.sourceId, a, b), a, b, line.offset, line.length, 0);
      if (current !== part) continue;
      const found = mine.find(mapping.sourceId, a, b);
      if (found < 0) firstInPart.push(line.offset, line.length);
      const created = mapping.tag === 'c' && mapping.object !== '';
      mine.put(found, a, b, line.offset, line.length, created ? 1 : 0);
    }
    return head ? new JournalPart(file, all, mine, firstInPart, unattributed) : undefined;
  }

  /** The mapping of the line at `offset`. */
  private mappingAt(offset: number, length: number): Mapping | undefined {
    return mappingOf(this.file.read(offset, length).toString('utf8'));
  }

  /** The latest line of `sourceId` in every part, and the part's latest word on it. */
  private wordsOn(sourceId: string): {
    latest: { offset: number; length: number } | undefined;
    createdByThePart: boolean;
    inThePart: { offset: number; length: number } | undefined;
  } {
    const a = hashA(sourceId);
    const b = hashB(sourceId);
    const slot = this.all.find(sourceId, a, b);
    const mineSlot = this.mine.find(sourceId, a, b);
    return {
      latest:
        slot >= 0
          ? { offset: this.all.offsetOf(slot), length: this.all.lengthOf(slot) }
          : undefined,
      createdByThePart: mineSlot >= 0 && this.mine.codeOf(mineSlot) === 1,
      inThePart:
        mineSlot >= 0
          ? { offset: this.mine.offsetOf(mineSlot), length: this.mine.lengthOf(mineSlot) }
          : undefined,
    };
  }

  /**
   * What the part created, per object, objects in the order the part first
   * created one of them: the latest line, in every part, of each source id
   * the part created, in the order the part first named each.
   */
  private createdByObject(): Map<string, LinePlaces> {
    const byObject = new Map<string, LinePlaces>();
    for (let at = 0; at < this.firstInPart.size; at++) {
      const first = this.mappingAt(this.firstInPart.offsetAt(at), this.firstInPart.lengthAt(at));
      if (!first) continue;
      const words = this.wordsOn(first.sourceId);
      if (!words.createdByThePart || !words.latest || !words.inThePart) continue;
      const word = this.mappingAt(words.inThePart.offset, words.inThePart.length);
      if (!word) continue;
      const places = byObject.get(word.object) ?? new LinePlaces();
      places.push(words.latest.offset, words.latest.length);
      byObject.set(word.object, places);
    }
    return byObject;
  }

  /**
   * The records the part created, as a removal takes them: per object the
   * newest first, the objects too (`forgeRunCreatedRecords`), and of those,
   * the ones `left` holds when given — what the part's removals left.
   *
   * @param left - The keys of the records earlier removals left.
   */
  runRecords(left?: RecordKeys, pageSize = IDS_PER_PAGE): RunRecords {
    // What the records handed over read the journal by, and no more: once
    // they are built, the indexes of every source id can go.
    const { file } = this;
    const mappingAt = (offset: number, length: number): Mapping | undefined =>
      mappingOf(file.read(offset, length).toString('utf8'));
    const targetAt = (offset: number, length: number): string => {
      const mapping = mappingAt(offset, length);
      return mapping ? keyOf(mapping.targetId) : '';
    };

    // Each record once, by the first of its rows taken: the latest.
    const members = new SourceIdIndex(targetAt);
    const byObject = this.createdByObject();
    const objects: Array<{ objectApiName: string; count: number }> = [];
    for (const objectApiName of [...byObject.keys()].reverse()) {
      const places = byObject.get(objectApiName);
      if (!places) continue;
      let count = 0;
      for (let at = places.size - 1; at >= 0; at--) {
        const offset = places.offsetAt(at);
        const mapping = mappingAt(offset, places.lengthAt(at));
        // Its latest word without its object: the journal's read maps it to nothing.
        if (!mapping || mapping.object === '') continue;
        const key = keyOf(mapping.targetId);
        const a = hashA(key);
        const b = hashB(key);
        const found = members.find(key, a, b);
        if (found >= 0) continue;
        members.put(found, a, b, offset, places.lengthAt(at), 0);
        if (!left || left.has(key)) count++;
      }
      if (count > 0) objects.push({ objectApiName, count });
    }
    const member = (key: string, offset?: number): boolean => {
      const slot = members.find(key, hashA(key), hashB(key), offset);
      return (
        slot >= 0 &&
        (offset === undefined || members.offsetOf(slot) === offset) &&
        (!left || left.has(key))
      );
    };

    // The records a job wrote that no row was matched to: each once, none a
    // row maps to already, counted with the records of its object.
    const unattributedAt = (at: number): { object: string; ids: string[] } | undefined =>
      unattributedOf(
        file.read(this.unattributed.offsetAt(at), this.unattributed.lengthAt(at)).toString('utf8'),
      );
    const unattributed = new HashedKeys();
    const unattributedLines = this.unattributed.size;
    const extraOf = new Map<string, number>();
    for (let at = 0; at < unattributedLines; at++) {
      const line = unattributedAt(at);
      if (!line) continue;
      for (const id of line.ids) {
        const key = keyOf(id);
        if (unattributed.has(key)) continue;
        if (members.find(key, hashA(key), hashB(key)) >= 0) continue;
        unattributed.add(key);
        if (!left || left.has(key)) extraOf.set(line.object, (extraOf.get(line.object) ?? 0) + 1);
      }
    }
    for (const [objectApiName, count] of extraOf) {
      const known = objects.find((object) => object.objectApiName === objectApiName);
      if (known) known.count += count;
      else objects.unshift({ objectApiName, count });
    }
    const unattributedMember = (key: string): boolean =>
      unattributed.size > 0 && unattributed.has(key) && (!left || left.has(key));

    return {
      objects,
      pages: async function* (objectApiName) {
        const places = byObject.get(objectApiName);
        let page: string[] = [];
        if (places) {
          for (let at = places.size - 1; at >= 0; at--) {
            const offset = places.offsetAt(at);
            const mapping = mappingAt(offset, places.lengthAt(at));
            if (!mapping || mapping.object === '') continue;
            const key = keyOf(mapping.targetId);
            if (!member(key, offset)) continue;
            page.push(mapping.targetId);
            if (page.length >= pageSize) {
              yield page;
              page = [];
            }
          }
        }
        // Then what its jobs wrote that no row was matched to, each once.
        if (extraOf.has(objectApiName)) {
          const given = new HashedKeys();
          for (let at = 0; at < unattributedLines; at++) {
            const line = unattributedAt(at);
            if (line?.object !== objectApiName) continue;
            for (const id of line.ids) {
              const key = keyOf(id);
              if (given.has(key) || !unattributedMember(key)) continue;
              if (members.find(key, hashA(key), hashB(key)) >= 0) continue;
              given.add(key);
              page.push(id);
              if (page.length >= pageSize) {
                yield page;
                page = [];
              }
            }
          }
        }
        if (page.length > 0) yield page;
      },
      has: (key) => member(key) || unattributedMember(key),
    };
  }

  /**
   * The rows of the part's Id map (`idMapRows`), in the order the journal
   * first named each source id: every source id mapped with its object, in
   * every part, by the latest word on it — created when the part created it,
   * linked to otherwise, the object of a row the part did not create told by
   * the key prefix it shares with one it did.
   */
  *idMapRows(): Generator<IdMapRow> {
    const objectOfPrefix = new Map<string, string>();
    for (const [objectApiName, places] of this.createdByObject()) {
      for (let at = 0; at < places.size; at++) {
        const mapping = this.mappingAt(places.offsetAt(at), places.lengthAt(at));
        if (mapping) objectOfPrefix.set(mapping.sourceId.slice(0, 3), objectApiName);
      }
    }
    // A bit for each source id, by its slot in the index: named once.
    const named = new Uint8Array(Math.ceil(this.all.slots / 8));
    for (const line of journalLines(this.file)) {
      const first = mappingOf(line.text);
      if (!first) continue;
      const slot = this.all.find(first.sourceId, hashA(first.sourceId), hashB(first.sourceId));
      if (slot < 0 || (named[slot >> 3] & (1 << (slot & 7))) !== 0) continue;
      named[slot >> 3] |= 1 << (slot & 7);
      const words = this.wordsOn(first.sourceId);
      if (!words.latest) continue;
      const latest = this.mappingAt(words.latest.offset, words.latest.length);
      if (!latest || latest.object === '') continue;
      const inThePart =
        words.createdByThePart && words.inThePart
          ? this.mappingAt(words.inThePart.offset, words.inThePart.length)
          : undefined;
      yield {
        objectApiName: inThePart?.object ?? objectOfPrefix.get(latest.sourceId.slice(0, 3)),
        sourceId: latest.sourceId,
        targetId: latest.targetId,
        outcome: words.createdByThePart ? 'created' : 'linked to existing',
      };
    }
  }
}
