import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import type { PendingFkUpdate } from './stages/BatchWriter.js';

/**
 * What a run that writes keeps of what it wrote, on disk as it goes: the
 * journal of the run, and what the run looks up in it.
 *
 * A run read page by page holds a page of rows whatever its tables hold, and
 * kept in memory all the same the source and target id of every record it
 * wrote, the ids it read, the lookups it owed to its second pass and the
 * statuses it owed to its end — a few hundred bytes a row, past a million
 * rows several hundred MB of the extension host. Here each goes to the end of
 * the journal as one line, and what the run asks of them is answered by an
 * index of a few bytes a record, which holds no id, over the lines, and by a
 * cache of the records asked for last. A lookup reads its line back.
 *
 * The journal is what a run stopped part way leaves: what it created, to
 * remove; where each object's read stood, the lookups and statuses still
 * owed, to resume from. A run that resumes another goes on in the same
 * journal, as a part of its own (`beginPart`): what an earlier part wrote is
 * found, and linked to, and none of it is this part's own.
 *
 * Ids alone, never a value of a record — but for the status a draft is owed.
 */

/** The journal file of a run, as its store writes and reads it. */
export interface RunFile {
  /** Bytes the file holds. */
  size(): number;
  /** Add `text` at the end of the file. */
  append(text: string): void;
  /** Up to `length` bytes from `offset`. */
  read(offset: number, length: number): Buffer;
  close(): void;
}

/** A journal file on disk, at `filePath`: created when it is not there, added to when it is. */
export function nodeRunFile(filePath: string): RunFile {
  const fd = openSync(filePath, 'a+');
  let size = fstatSync(fd).size;
  return {
    size: () => size,
    append: (text) => {
      const bytes = Buffer.from(text, 'utf8');
      let written = 0;
      // Opened to add, every write goes to the end of the file.
      while (written < bytes.length) written += writeSync(fd, bytes, written);
      size += bytes.length;
    },
    read: (offset, length) => {
      const buffer = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buffer, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      return buffer.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

/** A journal file held in memory, for tests: `text()` is what it holds. */
export function memoryRunFile(initial = ''): RunFile & { text(): string } {
  let bytes = Buffer.from(initial, 'utf8');
  let size = bytes.length;
  return {
    size: () => size,
    append: (text) => {
      const added = Buffer.from(text, 'utf8');
      if (size + added.length > bytes.length) {
        const grown = Buffer.alloc(Math.max(size + added.length, bytes.length * 2, 1024));
        bytes.copy(grown, 0, 0, size);
        bytes = grown;
      }
      added.copy(bytes, size);
      size += added.length;
    },
    read: (offset, length) => Buffer.from(bytes.subarray(offset, Math.min(size, offset + length))),
    close: () => {},
    text: () => bytes.subarray(0, size).toString('utf8'),
  };
}

/** What a source id maps onto: a record the run created, one the target held, or one an upsert wrote over. */
export type RemapKind = 'created' | 'existing' | 'updated';

/** A source id the store maps, as it last registered it. */
export interface StoredMapping {
  kind: RemapKind;
  sourceId: string;
  targetId: string;
  /** The object it was registered with; none for a mapping registered without one. */
  objectApiName?: string;
  /** Whether an earlier part of the run registered it: in the target before this part, none of its own. */
  earlier: boolean;
}

/** Where the read of an object read page by page stood once a page was written. */
export interface StoredCheckpoint {
  lastId: string;
  read: number;
  /** Set once the object was read to its end. */
  done?: true;
}

/** A lookup owed to the second pass, as the store gives it back. */
export interface StoredOwedLookup {
  update: PendingFkUpdate;
  /**
   * Owed to a row the run this one retries wrote: patched once its record is
   * written, dropped unsaid when it is not — the run retried said it.
   */
  toRowWrittenBefore: boolean;
}

/** A status owed to a record written as a draft. */
export interface StoredStatus {
  objectApiName: string;
  id: string;
  status: string;
}

/** Per object, the records of this part: created, linked to, written over. */
export interface StoredCounts {
  objectApiName: string;
  created: number;
  linked: number;
  updated?: number;
}

/** The kind codes of the index. */
const CREATED = 1;
const EXISTING = 2;
const UPDATED = 3;
/** A source id read and not mapped: what tells a lookup at a record outside the clone. */
const READ = 4;

const KIND_CODE: Readonly<Record<RemapKind, number>> = {
  created: CREATED,
  existing: EXISTING,
  updated: UPDATED,
};
const KIND_OF_CODE: Readonly<Record<number, RemapKind>> = {
  [CREATED]: 'created',
  [EXISTING]: 'existing',
  [UPDATED]: 'updated',
};
const LINE_TAG: Readonly<Record<number, string>> = {
  [CREATED]: 'c',
  [EXISTING]: 'e',
  [UPDATED]: 'u',
  [READ]: 'i',
};
const CODE_OF_TAG: Readonly<Record<string, number>> = {
  c: CREATED,
  e: EXISTING,
  u: UPDATED,
  i: READ,
};

/** Lines held before they are written, past which they are written at once. */
const FLUSH_BYTES = 1024 * 1024;
/** Bytes read at once when the journal is gone through from its start. */
const SCAN_BYTES = 1024 * 1024;
/** Records the cache holds: a few pages of rows and what they name. */
const CACHE_SIZE = 20_000;
/** Ids read held before they are kept: see `noteRead`. */
const READS_HELD = 20_000;
/** Fullness of the index past which it doubles. */
const INDEX_LOAD = 0.6;
/** Samples kept per object of the statuses owed, for a run that stops before giving them. */
const STATUS_SAMPLES = 3;

/** First 32-bit hash of an id (FNV-1a). */
function hashA(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Second 32-bit hash of an id, independent of the first. */
function hashB(id: string): number {
  let h = 0x9747b28c;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** What the cache holds of a source id: its line, and what the line says. */
interface CachedRecord {
  /** Offset of its latest line in the journal. */
  at: number;
  code: number;
  targetId: string;
  objectApiName: string;
}

/**
 * The index of the source ids of a journal: per id, the offset and length of
 * its latest line and the kind of record it holds, under two hashes of the id.
 * No id is kept: one whose hashes match is read back from its line.
 */
class SourceIdIndex {
  private capacity = 1024;
  private used = 0;
  private h1 = new Uint32Array(this.capacity);
  private h2 = new Uint32Array(this.capacity);
  /** Offset of the line, plus one; 0 for a free slot. */
  private at = new Float64Array(this.capacity);
  private len = new Uint16Array(this.capacity);
  private code = new Uint8Array(this.capacity);

  constructor(private readonly keyAt: (offset: number, length: number) => string) {}

  get size(): number {
    return this.used;
  }

  /** The slot of `id`, or the bitwise complement of the free slot it would take. */
  find(id: string, a: number, b: number, cachedAt?: number): number {
    const mask = this.capacity - 1;
    let slot = b & mask;
    for (;;) {
      const at = this.at[slot];
      if (at === 0) return ~slot;
      if (
        this.h1[slot] === a &&
        this.h2[slot] === b &&
        (cachedAt === at - 1 || this.keyAt(at - 1, this.len[slot]) === id)
      ) {
        return slot;
      }
      slot = (slot + 1) & mask;
    }
  }

  offsetOf(slot: number): number {
    return this.at[slot] - 1;
  }

  lengthOf(slot: number): number {
    return this.len[slot];
  }

  codeOf(slot: number): number {
    return this.code[slot];
  }

  /** Point `slot` — found, or the complement of a free one — at a line. */
  put(found: number, a: number, b: number, offset: number, length: number, code: number): void {
    let slot = found;
    if (found < 0) {
      if (this.used + 1 > this.capacity * INDEX_LOAD) {
        this.grow();
        slot = this.freeSlotFor(b);
      } else {
        slot = ~found;
      }
      this.used++;
      this.h1[slot] = a;
      this.h2[slot] = b;
    }
    this.at[slot] = offset + 1;
    this.len[slot] = length;
    this.code[slot] = code;
  }

  /** The first free slot from where `b` starts its probe: for an id known not to be there. */
  private freeSlotFor(b: number): number {
    const mask = this.capacity - 1;
    let slot = b & mask;
    while (this.at[slot] !== 0) slot = (slot + 1) & mask;
    return slot;
  }

  private grow(): void {
    const { h1, h2, at, len, code } = this;
    this.capacity *= 2;
    this.h1 = new Uint32Array(this.capacity);
    this.h2 = new Uint32Array(this.capacity);
    this.at = new Float64Array(this.capacity);
    this.len = new Uint16Array(this.capacity);
    this.code = new Uint8Array(this.capacity);
    for (let i = 0; i < at.length; i++) {
      if (at[i] === 0) continue;
      const slot = this.freeSlotFor(h2[i]);
      this.h1[slot] = h1[i];
      this.h2[slot] = h2[i];
      this.at[slot] = at[i];
      this.len[slot] = len[i];
      this.code[slot] = code[i];
    }
  }
}

/** A line of the journal, with where it starts. */
interface JournalLine {
  offset: number;
  length: number;
  text: string;
}

/**
 * The store of a run's journal. Opened on a journal that holds lines already
 * — the head the handler or the command wrote, and the parts of a run it
 * resumes — it reads them once to build its index; `beginPart` starts the
 * part the run writes.
 */
export class ForgeRunStore {
  private readonly index: SourceIdIndex;
  private readonly cache = new Map<string, CachedRecord>();
  private pending: string[] = [];
  private pendingBytes = 0;
  private flushQueued = false;
  /** Offset where the part under way starts: a line before it is an earlier part's. */
  private partStart = Number.POSITIVE_INFINITY;
  private parts = 0;
  /** Source ids mapped, in every part. */
  private mappedCount = 0;
  /** Per object, this part's records. */
  private readonly counts = new Map<string, { created: number; linked: number; updated: number }>();
  /** Per object, the records earlier parts mapped with it. */
  private readonly earlierByObject = new Map<string, number>();
  /** Per object, those of them mapped after the object's last checkpoint. */
  private readonly earlierPastCheckpoint = new Map<string, number>();
  private readonly checkpointsByObject = new Map<string, StoredCheckpoint>();
  private owedCount = 0;
  private readonly statuses = new Map<string, { count: number; samples: StoredStatus[] }>();
  private readsHeld: string[] = [];

  private constructor(private readonly file: RunFile) {
    this.index = new SourceIdIndex((offset, length) => this.idOfLine(offset, length));
  }

  /** The store of the journal `file`, its lines read once. */
  static open(file: RunFile): ForgeRunStore {
    const store = new ForgeRunStore(file);
    store.readWhatIsThere();
    return store;
  }

  /** Parts the journal held when it was opened, and the one under way once begun. */
  get partCount(): number {
    return this.parts;
  }

  /** Whether an earlier part wrote to this journal: the run under way resumes it. */
  get resumes(): boolean {
    return this.checkpointsByObject.size > 0 || this.earlierByObject.size > 0 || this.owedCount > 0;
  }

  /** Source ids earlier parts mapped. */
  get earlierMapped(): number {
    return this.partStart === Number.POSITIVE_INFINITY ? this.mappedCount : this.mappedBeforePart;
  }

  private mappedBeforePart = 0;

  /** Start the part the run writes: what was there before is an earlier part's. */
  beginPart(startedAt: Date): void {
    this.flush();
    this.mappedBeforePart = this.mappedCount;
    this.partStart = this.file.size();
    this.write({ part: { n: this.parts, startedAt: startedAt.toISOString() } });
    this.parts++;
    this.flush();
  }

  /* ---- what the run wrote: source id to target id ---- */

  /** Register what `sourceId` maps onto, as the latest word on it. */
  setMapping(kind: RemapKind, sourceId: string, targetId: string, objectApiName?: string): void {
    const code = KIND_CODE[kind];
    const a = hashA(sourceId);
    const b = hashB(sourceId);
    const cached = this.cache.get(sourceId);
    const found = this.index.find(sourceId, a, b, cached?.at);
    const wasMapped = found >= 0 && this.index.codeOf(found) !== READ;
    if (wasMapped) this.uncount(sourceId, found, cached);
    const line = JSON.stringify([LINE_TAG[code], sourceId, targetId, objectApiName ?? '']);
    const offset = this.write(line);
    this.index.put(found, a, b, offset, Buffer.byteLength(line), code);
    if (!wasMapped) this.mappedCount++;
    if (objectApiName) {
      const counts = this.countsOf(objectApiName);
      if (code === CREATED) counts.created++;
      else if (code === EXISTING) counts.linked++;
      else counts.updated++;
    }
    this.remember(sourceId, { at: offset, code, targetId, objectApiName: objectApiName ?? '' });
  }

  /** Take off this part's counts the record `sourceId` held before it is registered again. */
  private uncount(sourceId: string, slot: number, cached: CachedRecord | undefined): void {
    const at = this.index.offsetOf(slot);
    if (at < this.partStart) return;
    const code = this.index.codeOf(slot);
    const record = cached?.at === at ? cached : this.recordAt(sourceId, slot);
    const counts = record?.objectApiName ? this.counts.get(record.objectApiName) : undefined;
    if (!counts) return;
    if (code === CREATED) counts.created--;
    else if (code === EXISTING) counts.linked--;
    else counts.updated--;
  }

  private countsOf(objectApiName: string): { created: number; linked: number; updated: number } {
    let counts = this.counts.get(objectApiName);
    if (!counts) {
      counts = { created: 0, linked: 0, updated: 0 };
      this.counts.set(objectApiName, counts);
    }
    return counts;
  }

  /** What `sourceId` maps onto, in any part; none when it maps onto nothing. */
  mapping(sourceId: string): StoredMapping | undefined {
    const record = this.lookUp(sourceId);
    if (!record || record.code === READ) return undefined;
    return {
      kind: KIND_OF_CODE[record.code],
      sourceId,
      targetId: record.targetId,
      ...(record.objectApiName ? { objectApiName: record.objectApiName } : {}),
      earlier: record.at < this.partStart,
    };
  }

  /** The target id `sourceId` maps onto, in any part. */
  targetOf(sourceId: string): string | undefined {
    const record = this.lookUp(sourceId);
    return record && record.code !== READ ? record.targetId : undefined;
  }

  /** Source ids mapped, in every part. */
  get mappedSize(): number {
    return this.mappedCount;
  }

  /** Per object, the records this part created, linked to and wrote over. */
  countsByObject(): StoredCounts[] {
    const out: StoredCounts[] = [];
    for (const [objectApiName, { created, linked, updated }] of this.counts) {
      if (created + linked + updated === 0) continue;
      out.push(
        updated > 0
          ? { objectApiName, created, linked, updated }
          : { objectApiName, created, linked },
      );
    }
    return out;
  }

  /** Per object, the records earlier parts mapped with it; past its checkpoint, with `pastCheckpoint`. */
  earlierRecordsOf(objectApiName: string, pastCheckpoint = false): number {
    return (
      (pastCheckpoint ? this.earlierPastCheckpoint : this.earlierByObject).get(objectApiName) ?? 0
    );
  }

  /**
   * Every source id mapped, as last registered, in the order of those last
   * registrations: the journal read from its start.
   */
  *mappings(): Generator<StoredMapping> {
    for (const line of this.lines()) {
      if (!line.text.startsWith('["')) continue;
      const value = parseLine(line.text);
      if (!value) continue;
      const code = CODE_OF_TAG[String(value[0])];
      if (code === undefined || code === READ) continue;
      const sourceId = String(value[1]);
      const slot = this.index.find(sourceId, hashA(sourceId), hashB(sourceId), line.offset);
      if (slot < 0 || this.index.offsetOf(slot) !== line.offset) continue;
      const objectApiName = String(value[3] ?? '');
      yield {
        kind: KIND_OF_CODE[code],
        sourceId,
        targetId: String(value[2]),
        ...(objectApiName ? { objectApiName } : {}),
        earlier: line.offset < this.partStart,
      };
    }
  }

  /* ---- the ids read ---- */

  /**
   * Keep that the run read `sourceId`. Held until `settleReads` — at the end
   * of the page — and kept then only when the id maps onto nothing: one the
   * run wrote is told by its mapping.
   */
  noteRead(sourceId: string): void {
    this.readsHeld.push(sourceId);
    if (this.readsHeld.length >= READS_HELD) this.settleReads();
  }

  /** Keep the ids read and held that map onto nothing: see `noteRead`. */
  settleReads(): void {
    const held = this.readsHeld;
    this.readsHeld = [];
    for (const sourceId of held) {
      const a = hashA(sourceId);
      const b = hashB(sourceId);
      const found = this.index.find(sourceId, a, b, this.cache.get(sourceId)?.at);
      if (found >= 0) continue;
      const line = JSON.stringify([LINE_TAG[READ], sourceId]);
      const offset = this.write(line);
      this.index.put(found, a, b, offset, Buffer.byteLength(line), READ);
    }
  }

  /** Whether the run, in any part, read `sourceId` or maps it. */
  wasRead(sourceId: string): boolean {
    if (this.readsHeld.includes(sourceId)) return true;
    const found = this.index.find(
      sourceId,
      hashA(sourceId),
      hashB(sourceId),
      this.cache.get(sourceId)?.at,
    );
    return found >= 0;
  }

  /* ---- where each object's read stood ---- */

  /** Keep where the read of `objectApiName` stands, once a page of it is written. */
  checkpoint(objectApiName: string, checkpoint: StoredCheckpoint): void {
    this.settleReads();
    this.write({ at: { object: objectApiName, ...checkpoint } });
    this.checkpointsByObject.set(objectApiName, { ...checkpoint });
    this.flush();
  }

  /** Per object, where its read stood when the last part stopped. */
  checkpoints(): Map<string, StoredCheckpoint> {
    return new Map(this.checkpointsByObject);
  }

  /* ---- what is owed to the second pass and to the end ---- */

  /** Owe a lookup to the second pass. */
  owe(update: PendingFkUpdate, toRowWrittenBefore = false): void {
    this.owedCount++;
    this.write(
      JSON.stringify([
        toRowWrittenBefore ? 'w' : 'o',
        update.objectApiName,
        update.newId,
        update.sourceId ?? '',
        update.fieldName,
        update.sourceRefId,
        update.insertOnly ? 1 : 0,
      ]),
    );
  }

  /** Lookups owed, in every part. */
  get owed(): number {
    return this.owedCount;
  }

  /** The lookups owed, in every part, `size` at a time: the journal read from its start. */
  *owedPages(size: number): Generator<StoredOwedLookup[]> {
    let page: StoredOwedLookup[] = [];
    for (const line of this.lines()) {
      if (!line.text.startsWith('["o"') && !line.text.startsWith('["w"')) continue;
      const value = parseLine(line.text);
      if (!value || value.length < 7) continue;
      const [tag, objectApiName, newId, sourceId, fieldName, sourceRefId, insertOnly] = value;
      page.push({
        update: {
          objectApiName: String(objectApiName),
          newId: String(newId),
          sourceId: sourceId ? String(sourceId) : undefined,
          fieldName: String(fieldName),
          sourceRefId: String(sourceRefId),
          ...(insertOnly === 1 ? { insertOnly: true as const } : {}),
        },
        toRowWrittenBefore: tag === 'w',
      });
      if (page.length >= size) {
        yield page;
        page = [];
      }
    }
    if (page.length > 0) yield page;
  }

  /**
   * Keep that the lookup `fieldName` of the record `recordId` was filled in:
   * a run that fills in its lookups node by node, from memory, says so here,
   * and a run that takes it up owes again only those it had not.
   */
  patched(recordId: string, fieldName: string): void {
    this.write(JSON.stringify(['p', recordId, fieldName]));
  }

  /**
   * The lookups earlier parts owed that none of them filled in
   * (`patched`), in the order owed: what a run that fills in its lookups
   * from memory, and stopped before it filled them all in, leaves to the
   * part that takes it up. The journal read twice from its start.
   */
  owedLeftByEarlierParts(): PendingFkUpdate[] {
    const filled = new Set<string>();
    for (const line of this.lines()) {
      if (line.offset >= this.partStart) break;
      if (!line.text.startsWith('["p"')) continue;
      const value = parseLine(line.text);
      if (value && value.length >= 3) filled.add(`${String(value[1])}\u0000${String(value[2])}`);
    }
    const left: PendingFkUpdate[] = [];
    for (const line of this.lines()) {
      if (line.offset >= this.partStart) break;
      if (!line.text.startsWith('["o"')) continue;
      const value = parseLine(line.text);
      if (!value || value.length < 7) continue;
      const [, objectApiName, newId, sourceId, fieldName, sourceRefId, insertOnly] = value;
      if (filled.has(`${String(newId)}\u0000${String(fieldName)}`)) continue;
      left.push({
        objectApiName: String(objectApiName),
        newId: String(newId),
        sourceId: sourceId ? String(sourceId) : undefined,
        fieldName: String(fieldName),
        sourceRefId: String(sourceRefId),
        ...(insertOnly === 1 ? { insertOnly: true as const } : {}),
      });
    }
    return left;
  }

  /** Owe a record written as a draft its status. */
  oweStatus(objectApiName: string, id: string, status: string): void {
    this.write(JSON.stringify(['s', objectApiName, id, status]));
    this.tallyStatus({ objectApiName, id, status });
  }

  private tallyStatus(owed: StoredStatus): void {
    let tally = this.statuses.get(owed.objectApiName);
    if (!tally) {
      tally = { count: 0, samples: [] };
      this.statuses.set(owed.objectApiName, tally);
    }
    tally.count++;
    if (tally.samples.length < STATUS_SAMPLES) tally.samples.push(owed);
  }

  /** Per object, the statuses owed in every part, and the first few of them. */
  statusesOwed(): Map<string, { count: number; samples: StoredStatus[] }> {
    return new Map([...this.statuses].map(([object, tally]) => [object, { ...tally }]));
  }

  /** Every status owed, in every part, in the order owed: the journal read from its start. */
  *statusLines(): Generator<StoredStatus> {
    for (const line of this.lines()) {
      if (!line.text.startsWith('["s"')) continue;
      const value = parseLine(line.text);
      if (!value || value.length < 4) continue;
      yield { objectApiName: String(value[1]), id: String(value[2]), status: String(value[3]) };
    }
  }

  /* ---- the file ---- */

  /** Write every line held. */
  flush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;
    this.file.append(text);
  }

  /** Write what is held, and let the file go. */
  close(): void {
    this.settleReads();
    this.flush();
    this.file.close();
  }

  /**
   * Add a line, held until the next flush: once the calls under way have
   * registered what they wrote — the next turn of the event loop — or at
   * once past a size. Returns its offset in the journal.
   */
  private write(value: string | object): number {
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    const offset = this.file.size() + this.pendingBytes;
    const text = `${line}\n`;
    this.pending.push(text);
    this.pendingBytes += Buffer.byteLength(text);
    if (this.pendingBytes >= FLUSH_BYTES) {
      this.flush();
    } else if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.flush();
      });
    }
    return offset;
  }

  /** The text of the line at `offset`, written first when it is still held. */
  private lineAt(offset: number, length: number): string {
    if (offset + length > this.file.size()) this.flush();
    return this.file.read(offset, length).toString('utf8');
  }

  /** The source id a registration line holds. */
  private idOfLine(offset: number, length: number): string {
    const value = parseLine(this.lineAt(offset, length));
    return value ? String(value[1]) : '';
  }

  /** What the index says of `sourceId`, read back from its line, through the cache. */
  private lookUp(sourceId: string): CachedRecord | undefined {
    const cached = this.cache.get(sourceId);
    if (cached) {
      // Asked again, kept longer.
      this.cache.delete(sourceId);
      this.cache.set(sourceId, cached);
      return cached;
    }
    const slot = this.index.find(sourceId, hashA(sourceId), hashB(sourceId));
    if (slot < 0) return undefined;
    const record = this.recordAt(sourceId, slot);
    if (record) this.remember(sourceId, record);
    return record;
  }

  private recordAt(sourceId: string, slot: number): CachedRecord | undefined {
    const at = this.index.offsetOf(slot);
    const value = parseLine(this.lineAt(at, this.index.lengthOf(slot)));
    if (!value || String(value[1]) !== sourceId) return undefined;
    return {
      at,
      code: this.index.codeOf(slot),
      targetId: String(value[2] ?? ''),
      objectApiName: String(value[3] ?? ''),
    };
  }

  private remember(sourceId: string, record: CachedRecord): void {
    this.cache.delete(sourceId);
    this.cache.set(sourceId, record);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /** Every line of the journal, from its start, the lines held written first. */
  private *lines(): Generator<JournalLine> {
    this.flush();
    const end = this.file.size();
    let offset = 0;
    let rest: Buffer = Buffer.alloc(0);
    let restAt = 0;
    while (offset < end) {
      const chunk = this.file.read(offset, Math.min(SCAN_BYTES, end - offset));
      if (chunk.length === 0) break;
      offset += chunk.length;
      const bytes: Buffer = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const newline = bytes.indexOf(10, start);
        if (newline < 0) break;
        if (newline > start) {
          yield {
            offset: restAt + start,
            length: newline - start,
            text: bytes.toString('utf8', start, newline),
          };
        }
        start = newline + 1;
      }
      rest = bytes.subarray(start);
      restAt += start;
    }
  }

  /** Read the lines the journal holds already: the index, the parts, what is owed. */
  private readWhatIsThere(): void {
    for (const line of this.lines()) {
      if (line.text.startsWith('["')) {
        const value = parseLine(line.text);
        if (value) this.readRegistration(line, value);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.text);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      if ('part' in parsed) {
        this.parts++;
      } else if ('at' in parsed) {
        const at = (parsed as { at: unknown }).at;
        if (typeof at !== 'object' || at === null) continue;
        const { object, lastId, read, done } = at as Record<string, unknown>;
        if (typeof object !== 'string' || typeof lastId !== 'string' || typeof read !== 'number') {
          continue;
        }
        this.checkpointsByObject.set(object, { lastId, read, ...(done === true ? { done } : {}) });
        this.earlierPastCheckpoint.delete(object);
      }
    }
  }

  private readRegistration(line: JournalLine, value: unknown[]): void {
    const tag = String(value[0]);
    if (tag === 'o' || tag === 'w') {
      this.owedCount++;
      return;
    }
    if (tag === 's') {
      if (value.length >= 4) {
        this.tallyStatus({
          objectApiName: String(value[1]),
          id: String(value[2]),
          status: String(value[3]),
        });
      }
      return;
    }
    const code = CODE_OF_TAG[tag];
    if (code === undefined) return;
    const sourceId = String(value[1]);
    const a = hashA(sourceId);
    const b = hashB(sourceId);
    const found = this.index.find(sourceId, a, b);
    const wasMapped = found >= 0 && this.index.codeOf(found) !== READ;
    // An id read once it is mapped adds nothing.
    if (code === READ && found >= 0) return;
    this.index.put(found, a, b, line.offset, line.length, code);
    if (code === READ) return;
    if (!wasMapped) this.mappedCount++;
    const objectApiName = String(value[3] ?? '');
    if (!objectApiName) return;
    this.earlierByObject.set(objectApiName, (this.earlierByObject.get(objectApiName) ?? 0) + 1);
    this.earlierPastCheckpoint.set(
      objectApiName,
      (this.earlierPastCheckpoint.get(objectApiName) ?? 0) + 1,
    );
  }
}

/** A registration line, read; undefined for a line that is not one. */
function parseLine(text: string): unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
