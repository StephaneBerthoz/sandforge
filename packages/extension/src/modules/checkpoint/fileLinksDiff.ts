/**
 * What a rewind to a checkpoint that holds files would do about them beside
 * what the diff of `ContentDocument` tells record by record: which files it
 * acts on at all, the links between its files and its records, what it
 * cannot undo of a file, and the file storage it takes.
 *
 * A rewind acts on a file when one of its links names a record of an object
 * the checkpoint holds — its anchor (`anchorOf`): for a file the checkpoint
 * holds, its links then, as the files' annex keeps them; for a file added
 * since, its links now. Every other file — a user's own, a library's, one
 * shared with a group — is counted and named, never touched: a file added
 * since that no held record links to is left (`outsideAdded`), never among
 * the deletions, and one deleted since that none linked to stays in the
 * recycle bin (`outsideDeleted`). The diff of `ContentDocument` asks
 * {@link FileAnchors} as it tells each file.
 *
 * The links are read now as the take read them: through the records of each
 * object the checkpoint holds that a link may name, one statement each
 * (`LinkedEntityId IN (SELECT Id FROM <Object>)`), or by lists of 200 of
 * their records' ids where the org refuses it or answers too late — the ids
 * the snapshot holds and those of the records stamped since, which together
 * are every record live now. A read that cannot be read whole either way
 * fails the read of the files: a file whose links were not read is no file a
 * rewind can tell anchored.
 *
 * Links are compared as sets, by the file and the record each ties, never by
 * a stamp nor by its Id: adding or removing a link stamps nothing of its file
 * (P-A4), one removed since is in no read, not even of the recycle bin
 * (P-A3), and one inserted again — as a rewind inserts one — has a new Id.
 * The org keeps one link between a file and a record at most.
 *
 * - A link now that the checkpoint does not hold, between a file and a record
 *   that both stay, is removed (`linkAdded`): one of a file or a record the
 *   rewind deletes goes with it.
 * - A link of the checkpoint not read now, between a file and a record that
 *   are both live, is inserted again (`linkRemoved`), under a new Id: one of
 *   a file or a record the rewind brings back from the recycle bin comes back
 *   with it, under its Id, in any order the two were deleted and brought back
 *   (P-A1, P-A2, P-A5); one of a file or a record gone for good is gone with
 *   it. One of a record the rewind makes again names it by the Id it had.
 * - A link of both whose sharing (`ShareType`, `Visibility`) changed is given
 *   it back (`linkChanged`).
 *
 * An admin without Query All Files sees a file another user owns only in a
 * read that names it by its id (P-A7), and the diff of `ContentDocument`
 * reads none so: such a file of the checkpoint — a link names it — is read by
 * its id, brought back when deleted since (`deletedWhileTaken`: the snapshot
 * holds none of its values), named gone for good when the bin no longer holds
 * it; and such a file a link names now that no read showed is read by its id
 * too, deleted when created since. What no held record links to of another
 * user's files is never seen: the diff says so (`blindSpot`).
 *
 * A file given a new version since — its latest version is not the one the
 * checkpoint holds — keeps it: Salesforce neither deletes a version
 * (`INSUFFICIENT_ACCESS_OR_READONLY`) nor lets the latest point back at an
 * older one (`INVALID_FIELD_FOR_INSERT_UPDATE`, P-A6). It is named among what
 * a rewind cannot undo (`newFileVersion`); its title, which a new version
 * gives the file, is given back as any field.
 *
 * A file in the recycle bin takes no file storage, and its undelete counts
 * it again (P-A8): the storage the files brought back take is counted, and
 * that of the files deleted, which an Undo would bring back.
 *
 * Nothing here holds the org's links whole: the checkpoint's are kept by the
 * two ends each ties, and each class is written to the preview's folder as it
 * is told (`fileLinkClassFileOf`).
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import {
  sanitizeSoqlObjectName,
  type CheckpointObject,
  type RewindFilesDiff,
} from '@sandforge/shared';
import { idLists } from '../dataops/RecordRemoval.js';
import { orgDateTime } from '../sync/SyncDelta.js';
import type { CheckpointDescribe } from './checkpointFields.js';
import {
  FILE_IDS_PER_READ,
  anchorOf,
  fileLinkClassFileOf,
  fileLinkLineSchema,
  heldFileDocuments,
  heldFileLinks,
  heldPrefixesOf,
  linksOfObjectRead,
  linksOfRecordsRead,
  type FileDocumentLine,
  type FileLinkChangedLine,
  type FileLinkClass,
  type FileLinkLine,
} from './checkpointFiles.js';
import { FILE_LINK_OBJECT, FILE_OBJECT, globalObjectSchema } from './checkpointScope.js';
import { QUERIES_PER_COMPOSITE, type CompositeReader, type OrgRow } from './compositeQueries.js';
import { CHECKPOINT_FILE_MODE, type CheckpointFolder } from './OrgCheckpointStore.js';
import {
  readStreams,
  spoolReads,
  spooledRows,
  type ObjectChanges,
  type ObjectRead,
  type SpooledRead,
} from './orgStreams.js';
import type { RewindClass } from './rewindDiff.js';
import { RecordKeySet } from './spooledRunRecords.js';
import { Recreated, SnapshotIndex } from './snapshotIndex.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/** Reads by id sent together: ten composites of five, as the take sends them. */
const READS_AT_ONCE = QUERIES_PER_COMPOSITE * 10;

/** Lines a class's file is written by at a time. */
const LINES_AT_ONCE = 2_000;

/**
 * The first characters of a user's id, in every org: a link to a user — the
 * owner's, a share with a person — follows its file wherever it goes, and is
 * no link to anything outside the checkpoint.
 */
const USER_PREFIX = '005';

/** What the diff reads of a file by its id: what tells whether it is live, created since, its latest version and size. */
const DOCUMENT_NOW_COLUMNS = [
  'Id',
  'IsDeleted',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'LatestPublishedVersionId',
  'ContentSize',
];

// ─── Flags ───────────────────────────────────────────────────────────────────

/** A file the files' annex holds. */
const HELD = 1;
/** A file a link of the checkpoint tied to a record it holds: one a rewind acts on as it was then. */
const ANCHORED_THEN = 1 << 1;
/** A file a link read now ties to a record of an object the checkpoint holds: one a rewind acts on as it is now. */
const NAMED_NOW = 1 << 2;
/** A file the diff's reads of `ContentDocument` read now: stamped since, or deleted since. */
const SEEN = 1 << 3;
/** A file the rewind deletes. */
const TO_DELETE = 1 << 4;
/** A file the rewind brings back from the recycle bin. */
const COMES_BACK = 1 << 5;
/** A file gone for good. */
const LOST = 1 << 6;

/** A record the rewind deletes: a link to it goes with it. */
const RECORD_TO_DELETE = 1;
/** A record the rewind brings back: a link to it comes back with it. */
const RECORD_COMES_BACK = 1 << 1;
/** A record gone for good, or left in the bin: a link to it is gone with it. */
const RECORD_LOST = 1 << 2;

/** On a link of the checkpoint, beside its sharing's place: read now too. */
const LINK_SEEN = 1 << 15;

/** The classes of a file's diff, by what they tell of the file. */
const FILE_CLASSES: Readonly<Record<'toDelete' | 'comesBack' | 'lost', readonly RewindClass[]>> = {
  toDelete: ['createdSince', 'broughtBackSince'],
  comesBack: ['inBin', 'withParent', 'deletedWhileTaken'],
  lost: ['goneForGood', 'toRecreate'],
};

/** The classes of a record's diff, by what they tell a link to it of the record. */
const RECORD_CLASSES: Readonly<Record<'toDelete' | 'comesBack' | 'lost', readonly RewindClass[]>> =
  {
    toDelete: ['createdSince', 'broughtBackSince', 'comesBackWithParent'],
    comesBack: ['inBin', 'withParent', 'deletedWhileTaken'],
    lost: ['goneForGood', 'deletedWithCreatedParent', 'deletedWithParentOutside'],
  };

/** Where a diff spools the ids of one class of one object, as `classFileOf` names it. */
export type ClassFileOf = (objectApiName: string, cls: RewindClass) => string;

// ─── Small helpers ───────────────────────────────────────────────────────────

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: unknown): string | undefined {
  return typeof id === 'string' && id.length >= 15 ? id.slice(0, 15) : undefined;
}

/** The two ends of a link, as one key: the org keeps one link between a file and a record at most. */
function endsOf(link: Pick<FileLinkLine, 'ContentDocumentId' | 'LinkedEntityId'>): string {
  return `${link.ContentDocumentId.slice(0, 15)}${link.LinkedEntityId.slice(0, 15)}`;
}

/** A link's sharing, as one key. */
function sharingOf(link: Pick<FileLinkLine, 'ShareType' | 'Visibility'>): string {
  return `${link.ShareType}/${link.Visibility}`;
}

/** The rows of a spool file, none when the file is not there: a class told empty writes none. */
async function* linesOf(file: string): AsyncGenerator<OrgRow> {
  try {
    for await (const row of spooledRows(file)) yield row;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/** An id the org gave, or null for anything else. */
function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value)
    ? value
    : null;
}

/** A size the org gave, or null for anything else. */
function sizeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A date as the org gives it, `+0000` or `Z`, in milliseconds; NaN for anything else. */
function dateMs(value: unknown): number {
  const at = orgDateTime(value);
  return at === null ? Number.NaN : Date.parse(at);
}

/** Lines of one class, written to its file as they come: appended to what the diff wrote of it. */
class Lines {
  private lines: string[] = [];
  count = 0;

  constructor(private readonly file: string) {}

  async add(line: Record<string, unknown>): Promise<void> {
    this.lines.push(`${JSON.stringify(line)}\n`);
    this.count++;
    if (this.lines.length >= LINES_AT_ONCE) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.lines.length === 0) return;
    const text = this.lines.join('');
    this.lines = [];
    await appendFile(this.file, text, { encoding: 'utf8', mode: CHECKPOINT_FILE_MODE, flag: 'a' });
  }
}

/** Where a diff spools the links it reads now of one object's records, in its preview's folder. */
function linksNowFileOf(previewDir: string, objectApiName: string, part?: number): string {
  const object = sanitizeSoqlObjectName(objectApiName);
  return join(previewDir, `${object}.links${part === undefined ? '' : `.${part}`}.ndjson`);
}

/** `items` in slices of `size`. */
function* slices<T>(items: Iterable<T>, size: number): Generator<T[]> {
  let slice: T[] = [];
  for (const item of items) {
    slice.push(item);
    if (slice.length >= size) {
      yield slice;
      slice = [];
    }
  }
  if (slice.length > 0) yield slice;
}

const globalSchema = z.object({ sobjects: z.array(globalObjectSchema) }).loose();

// ─── Before the objects are told ─────────────────────────────────────────────

/** What the files' read reads before any object of the checkpoint is told. */
export interface FileAnchorsInput {
  reader: CompositeReader;
  /** The checkpoint's folder: its files' annex, its snapshot's indexes. */
  folder: CheckpointFolder;
  /** The preview's folder: the links read now are spooled there. */
  previewDir: string;
  snapshotId: string;
  /** The checkpoint's objects, the files' among them. */
  objects: readonly CheckpointObject[];
  /** What the change reads found of each object: the records live now beside the snapshot's. */
  changes: ReadonlyMap<string, ObjectChanges>;
  /** The describe of a file's link, which names the objects whose records a link may tie a file to. */
  linkDescribe: Promise<CheckpointDescribe>;
  /** The org's global describe: the first characters of each object's ids. */
  describeGlobal: () => Promise<unknown>;
  signal?: AbortSignal;
}

/**
 * What a diff knows of the checkpoint's files and of their links now, before
 * any object is told: which file a rewind acts on, as it was then and as it
 * is now. See the module's comment.
 */
export class FileAnchors {
  /** By a file's key, what is known of it. */
  readonly files = new RecordKeySet();
  /** By the two ends of each link the checkpoint holds, the place of its sharing in {@link sharings}. */
  readonly held = new Map<string, number>();
  /** Each sharing the checkpoint's links have, once. */
  readonly sharings: string[] = [];
  /** The objects the checkpoint holds, by the first three characters of their ids. */
  readonly prefixes: ReadonlyMap<string, string>;
  /** The links read now, spooled, each file with the object whose records it read the links of. */
  readonly now: ReadonlyArray<{ objectApiName: string; file: string }>;

  constructor(prefixes: ReadonlyMap<string, string>, now: FileAnchors['now']) {
    this.prefixes = prefixes;
    this.now = now;
  }

  /** Whether a link read now ties the file `id` to a record of an object the checkpoint holds. */
  anchoredNow(id: unknown): boolean {
    return (this.files.flagsOf(id) & NAMED_NOW) !== 0;
  }

  /** Whether a link of the checkpoint tied the file `id` to a record it holds. */
  anchoredThen(id: unknown): boolean {
    return (this.files.flagsOf(id) & ANCHORED_THEN) !== 0;
  }

  /** The place of `sharing` in {@link sharings}, given one the first time. */
  sharingAt(sharing: string): number {
    const at = this.sharings.indexOf(sharing);
    if (at >= 0) return at;
    this.sharings.push(sharing);
    return this.sharings.length - 1;
  }
}

/**
 * The objects whose records' links are read now: those the checkpoint holds
 * that a link may name, by the describe of a link, holding records now.
 */
function linkedObjectsOf(
  input: Pick<FileAnchorsInput, 'objects' | 'changes'>,
  describe: CheckpointDescribe,
): string[] {
  const entity = describe.fields.find((field) => field.name.toLowerCase() === 'linkedentityid');
  const linkable = new Set((entity?.referenceTo ?? []).map((name) => name.toLowerCase()));
  if (linkable.size === 0) {
    throw new Error(`The describe of ${FILE_LINK_OBJECT} names no record a link ties a file to.`);
  }
  return input.objects
    .map(({ objectApiName }) => objectApiName)
    .filter((name) => {
      if (name.toLowerCase() === FILE_OBJECT.toLowerCase()) return false;
      if (!linkable.has(name.toLowerCase())) return false;
      const changed = input.changes.get(name);
      return changed !== undefined && !('unread' in changed) && (changed.count ?? 0) > 0;
    });
}

/**
 * The ids of the records of `objectApiName` live now, as far as a read of
 * their links needs them: those the snapshot holds — deleted since, a record
 * has no link to read — and those stamped since that it does not hold, which
 * is every record live now it does not hold.
 */
async function* liveIdsOf(
  input: Pick<FileAnchorsInput, 'folder' | 'snapshotId' | 'changes'>,
  objectApiName: string,
): AsyncGenerator<string> {
  const index = await SnapshotIndex.read(input.folder, input.snapshotId, objectApiName);
  for (let row = 0; row < index.size; row++) yield index.idAt(row);
  const changed = input.changes.get(objectApiName);
  if (changed === undefined || 'unread' in changed || !changed.live) return;
  for await (const row of spooledRows(changed.live.file)) {
    if (typeof row.Id === 'string' && !index.has(row.Id)) yield row.Id;
  }
}

/**
 * Read the links of the records of each object of `objects` now, spooled to
 * the preview's folder: one statement an object, or, where the org refuses it
 * or answers too late, by lists of 200 of the records' ids.
 *
 * @throws When the links of an object could not be read whole either way.
 */
async function readLinksNow(
  input: FileAnchorsInput,
  objects: readonly string[],
): Promise<Array<{ objectApiName: string; file: string }>> {
  const { reader, previewDir, signal } = input;
  const whole: SpooledRead[] = objects.map((objectApiName) => ({
    ...linksOfObjectRead(objectApiName),
    file: linksNowFileOf(previewDir, objectApiName),
  }));
  const outcomes = await spoolReads(reader, whole, signal);
  const read: Array<{ objectApiName: string; file: string }> = [];
  for (const [at, outcome] of outcomes.entries()) {
    const objectApiName = objects[at];
    if (outcome.read) {
      read.push({ objectApiName, file: whole[at].file });
      continue;
    }
    let part = 0;
    const ids = liveIdsOf(input, objectApiName);
    for await (const group of asyncSlices(ids, FILE_IDS_PER_READ * READS_AT_ONCE)) {
      const lists = [...slices(group, FILE_IDS_PER_READ)];
      const reads: SpooledRead[] = lists.map((list) => ({
        ...linksOfRecordsRead(objectApiName, list),
        file: linksNowFileOf(previewDir, objectApiName, part++),
      }));
      const answers = await spoolReads(reader, reads, signal);
      const failed = answers.find((answer) => !answer.read);
      if (failed && !failed.read) {
        throw new Error(
          `The links of the files of ${objectApiName} could not be read whole: ${outcome.reason}; ` +
            `read by the ids of its records, ${failed.reason}`,
        );
      }
      for (const spooled of reads) read.push({ objectApiName, file: spooled.file });
    }
  }
  return read;
}

/** `items` in slices of `size`, as they come. */
async function* asyncSlices<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let slice: T[] = [];
  for await (const item of items) {
    slice.push(item);
    if (slice.length >= size) {
      yield slice;
      slice = [];
    }
  }
  if (slice.length > 0) yield slice;
}

/**
 * What the files' read knows before any object is told: the checkpoint's
 * files and links from its annex, and the links of its records now, read
 * from the org. See the module's comment.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 * @throws When the annex is damaged, or a read of the links failed.
 */
export async function readFileAnchors(input: FileAnchorsInput): Promise<FileAnchors> {
  const global = globalSchema.safeParse(await input.describeGlobal());
  if (!global.success) throw new Error('The org’s global describe does not read as one.');
  const prefixes = heldPrefixesOf(
    global.data.sobjects,
    input.objects.map(({ objectApiName }) => objectApiName),
  );
  const objects = linkedObjectsOf(input, await input.linkDescribe);
  const now = await readLinksNow(input, objects);
  const anchors = new FileAnchors(prefixes, now);

  for await (const file of heldFileDocuments(input.folder)) {
    anchors.files.add(file.Id, HELD | (file.anchored ? ANCHORED_THEN : 0));
  }
  const recreated = await Recreated.read(input.folder);
  for await (const link of heldFileLinks(input.folder)) {
    anchors.held.set(endsOf(entityNow(link, recreated)), anchors.sharingAt(sharingOf(link)));
  }
  for (const { file } of now) {
    for await (const row of spooledRows(file)) {
      if (typeof row.ContentDocumentId === 'string') {
        anchors.files.add(row.ContentDocumentId, NAMED_NOW);
      }
    }
  }
  return anchors;
}

/** A link of the checkpoint with the record it names as the org names it now: one a rewind made again by its new Id. */
function entityNow(link: FileLinkLine, recreated: Recreated): FileLinkLine {
  const key = keyOf(link.LinkedEntityId);
  const current = key === undefined ? undefined : recreated.currentOf(key);
  return current === undefined ? link : { ...link, LinkedEntityId: current };
}

// ─── Once the objects are told ───────────────────────────────────────────────

/** What the files' read reads once every object is told. */
export interface FilesTellInput {
  anchors: FileAnchors;
  reader: CompositeReader;
  folder: CheckpointFolder;
  snapshotId: string;
  /** T0's second, in milliseconds: what a file's `CreatedDate` is compared with. */
  t0s: number;
  /** The checkpoint's objects, the files' among them. */
  objects: readonly CheckpointObject[];
  /** What the change reads found of the files' object. */
  fileChanges: ObjectChanges;
  /** The objects the diff told; one not told could not be read, and a link to its records is left as it is. */
  told: ReadonlySet<string>;
  /** Where the diff spools each class of each object. */
  classFileOf: ClassFileOf;
  previewDir: string;
  /** Whether the user reads every file, whoever owns it: without Query All Files, the diff says what it cannot see. */
  queryAllFiles: boolean;
  signal?: AbortSignal;
}

/** What the files' read adds to the diff of `ContentDocument`, and the diff's files. */
export interface FilesTold {
  /** The links, the files left, the storage: `remaining` is the preview's to say. */
  files: Omit<RewindFilesDiff, 'storage'> & {
    storage: Omit<RewindFilesDiff['storage'], 'remaining'>;
  };
  /** Files another user owns, a link names now and no read showed, created since: added to the files to delete. */
  createdSince: number;
  /** Files another user owns, of the checkpoint, deleted since: brought back with the values they had. */
  deletedWhileTaken: number;
  /** Files another user owns, of the checkpoint, no longer in the recycle bin. */
  goneForGood: number;
  /** Files of the checkpoint given a new version since. */
  newFileVersion: number;
  /** Who last changed the files it adds to those to delete, and when. */
  changedBy: OrgRow[];
}

/** Mark in `set`, with `flag`, every record of `classes` of `objectApiName` the diff told. */
async function markClasses(
  set: RecordKeySet,
  classFileOf: ClassFileOf,
  objectApiName: string,
  classes: readonly RewindClass[],
  flag: number,
): Promise<void> {
  for (const cls of classes) {
    for await (const row of linesOf(classFileOf(objectApiName, cls))) {
      if (typeof row.Id === 'string') set.add(row.Id, flag);
    }
  }
}

/** The lines of a class the diff wrote. */
async function countOf(file: string): Promise<number> {
  let count = 0;
  for await (const row of linesOf(file)) if (typeof row.Id === 'string') count++;
  return count;
}

/** What a file is now, read by its id, by its key. */
async function documentsNow(
  reader: CompositeReader,
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, OrgRow>> {
  const rows = new Map<string, OrgRow>();
  if (ids.length === 0) return rows;
  const reads = idLists([...ids], FILE_IDS_PER_READ).map((list): ObjectRead => ({
    objectApiName: FILE_OBJECT,
    soql: `SELECT ${DOCUMENT_NOW_COLUMNS.join(', ')} FROM ${FILE_OBJECT} WHERE Id IN (${list})`,
    // A file of the checkpoint deleted since is read in the bin, by its id
    // as a file another user owns is read (P-A7).
    scanAll: true,
  }));
  const outcomes = await readStreams(
    reader,
    reads,
    (_, page) => {
      for (const row of page) {
        const key = keyOf(row.Id);
        if (key !== undefined) rows.set(key, row);
      }
    },
    signal,
  );
  const failed = outcomes.find((outcome) => !outcome.read);
  if (failed && !failed.read) {
    throw new Error(
      `The files the checkpoint names could not be read by their ids: ${failed.reason}`,
    );
  }
  return rows;
}

/** The latest version and size of a file, as a read gives them. */
interface Witness {
  version: string | null;
  size: number | null;
}

/** Whether a file's latest version now is another than the one the checkpoint holds. */
function newVersion(then: FileDocumentLine, now: Witness | undefined): boolean {
  if (now === undefined || now.version === null || then.LatestPublishedVersionId === null) {
    return false;
  }
  return keyOf(now.version) !== keyOf(then.LatestPublishedVersionId);
}

/**
 * Tell what a rewind would do about the checkpoint's files once every object
 * is told: the files another user owns, the new versions, the links, the
 * storage. See the module's comment. Adds to the classes of `ContentDocument`
 * in the preview's folder the files it tells there, and writes the links'
 * classes beside them.
 *
 * @throws {OrgReadStopped} When the run was stopped.
 * @throws When a read by id failed, or the annex is damaged.
 */
export async function tellFiles(input: FilesTellInput): Promise<FilesTold> {
  const { anchors, reader, classFileOf, signal } = input;
  const files = anchors.files;
  const fileObject = FILE_OBJECT;
  await markClasses(files, classFileOf, fileObject, FILE_CLASSES.toDelete, TO_DELETE);
  await markClasses(files, classFileOf, fileObject, FILE_CLASSES.comesBack, COMES_BACK);
  await markClasses(files, classFileOf, fileObject, FILE_CLASSES.lost, LOST);

  // What the diff's reads of the files gave now: their latest version and
  // size, of those stamped since and those deleted since.
  const witnesses = new Map<string, Witness>();
  const changes = input.fileChanges;
  if (!('unread' in changes)) {
    for (const spool of [changes.live, changes.deleted]) {
      if (spool === undefined) continue;
      for await (const row of spooledRows(spool.file)) {
        const key = keyOf(row.Id);
        if (key === undefined) continue;
        files.add(String(row.Id), SEEN);
        witnesses.set(key, {
          version: idOrNull(row.LatestPublishedVersionId),
          size: sizeOrNull(row.ContentSize),
        });
      }
    }
  }
  const index = await SnapshotIndex.read(input.folder, input.snapshotId, fileObject);
  /** A file the diff of its object could not see: neither in the snapshot nor read now. */
  const unseen = (id: string): boolean => (files.flagsOf(id) & SEEN) === 0 && !index.has(id);

  const created = new Lines(classFileOf(fileObject, 'createdSince'));
  const broughtBack = new Lines(classFileOf(fileObject, 'deletedWhileTaken'));
  const gone = new Lines(classFileOf(fileObject, 'goneForGood'));
  const versions = new Lines(classFileOf(fileObject, 'newFileVersion'));
  let bringBack = 0;
  let undo = 0;

  // The checkpoint's files, a slice at a time: those of the checkpoint the
  // diff could not see read by their ids, then each compared with what the
  // checkpoint holds of it.
  const settle = async (slice: FileDocumentLine[]): Promise<void> => {
    const now = await documentsNow(
      reader,
      slice.filter((file) => file.anchored && unseen(file.Id)).map((file) => file.Id),
      signal,
    );
    for (const then of slice) {
      if (!then.anchored) continue;
      const key = keyOf(then.Id) ?? '';
      let witness = witnesses.get(key);
      if (unseen(then.Id)) {
        const row = now.get(key);
        if (row === undefined) {
          files.add(then.Id, LOST);
          await gone.add({ Id: then.Id });
          continue;
        }
        witness = {
          version: idOrNull(row.LatestPublishedVersionId),
          size: sizeOrNull(row.ContentSize),
        };
        if (row.IsDeleted === true) {
          files.add(then.Id, COMES_BACK);
          await broughtBack.add({ Id: then.Id });
        }
      }
      const flags = files.flagsOf(then.Id);
      if ((flags & LOST) !== 0) continue;
      if ((flags & COMES_BACK) !== 0) bringBack += witness?.size ?? then.ContentSize ?? 0;
      if (newVersion(then, witness)) await versions.add({ Id: then.Id });
    }
  };
  let slice: FileDocumentLine[] = [];
  for await (const file of heldFileDocuments(input.folder)) {
    slice.push(file);
    if (slice.length >= FILE_IDS_PER_READ * READS_AT_ONCE) {
      await settle(slice);
      slice = [];
    }
  }
  await settle(slice);

  // The files a link names now that neither the annex holds nor a read
  // showed — another user's — read by their ids: one created since is
  // deleted with the rest.
  const asked = new RecordKeySet();
  const changedBy: OrgRow[] = [];
  const unknown = async (ids: string[]): Promise<void> => {
    const now = await documentsNow(reader, ids, signal);
    for (const id of ids) {
      const row = now.get(keyOf(id) ?? '');
      if (row === undefined || row.IsDeleted === true) continue;
      if (!(dateMs(row.CreatedDate) >= input.t0s)) continue;
      files.add(id, TO_DELETE);
      await created.add({ Id: id });
      changedBy.push(row);
    }
  };
  let pending: string[] = [];
  for (const { file } of anchors.now) {
    for await (const row of spooledRows(file)) {
      const id = row.ContentDocumentId;
      if (typeof id !== 'string' || (files.flagsOf(id) & HELD) !== 0 || !unseen(id)) continue;
      if (!asked.add(id)) continue;
      pending.push(id);
      if (pending.length >= FILE_IDS_PER_READ * READS_AT_ONCE) {
        await unknown(pending);
        pending = [];
      }
    }
  }
  await unknown(pending);

  // What the files to delete take of the storage once Undo brings them back.
  for await (const row of linesOf(classFileOf(fileObject, 'createdSince'))) {
    const key = keyOf(row.Id);
    if (key === undefined) continue;
    undo += witnesses.get(key)?.size ?? 0;
  }
  for await (const row of linesOf(classFileOf(fileObject, 'broughtBackSince'))) {
    undo += witnesses.get(keyOf(row.Id) ?? '')?.size ?? 0;
  }
  for (const row of changedBy) undo += sizeOrNull(row.ContentSize) ?? 0;
  for (const lines of [created, broughtBack, gone, versions]) await lines.flush();

  const links = await tellLinks(input);
  return {
    files: {
      ...links,
      outsideAdded: await countOf(classFileOf(fileObject, 'outsideAdded')),
      outsideDeleted: await countOf(classFileOf(fileObject, 'outsideDeleted')),
      storage: { bringBack, undo },
      ...(input.queryAllFiles ? {} : { blindSpot: true as const }),
    },
    createdSince: created.count,
    deletedWhileTaken: broughtBack.count,
    goneForGood: gone.count,
    newFileVersion: versions.count,
    changedBy,
  };
}

/**
 * The links of the files to the records, now against the checkpoint's, told
 * into their classes: see the module's comment. A link to a record of an
 * object the diff could not read is left as it is.
 */
async function tellLinks(
  input: FilesTellInput,
): Promise<Pick<RewindFilesDiff, 'unlink' | 'relink' | 'updateLinks'>> {
  const { anchors, classFileOf } = input;
  const records = new RecordKeySet();
  const unreadPrefixes = new Set<string>();
  for (const { objectApiName } of input.objects) {
    if (objectApiName.toLowerCase() === FILE_OBJECT.toLowerCase()) continue;
    if (!input.told.has(objectApiName)) {
      for (const [prefix, object] of anchors.prefixes) {
        if (object.toLowerCase() === objectApiName.toLowerCase()) unreadPrefixes.add(prefix);
      }
      continue;
    }
    const mark = (classes: readonly RewindClass[], flag: number): Promise<void> =>
      markClasses(records, classFileOf, objectApiName, classes, flag);
    await mark(RECORD_CLASSES.toDelete, RECORD_TO_DELETE);
    await mark(RECORD_CLASSES.comesBack, RECORD_COMES_BACK);
    await mark(RECORD_CLASSES.lost, RECORD_LOST);
  }
  const unread = (link: Pick<FileLinkLine, 'LinkedEntityId'>): boolean =>
    unreadPrefixes.has(link.LinkedEntityId.slice(0, 3));

  const spoolOf = (cls: FileLinkClass): Lines =>
    new Lines(fileLinkClassFileOf(input.previewDir, cls));
  const added = spoolOf('linkAdded');
  const removed = spoolOf('linkRemoved');
  const changed = spoolOf('linkChanged');

  for (const { file } of anchors.now) {
    for await (const row of spooledRows(file)) {
      const parsed = fileLinkLineSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(
          `The org answered a link that does not read as one: ${parsed.error.message}`,
        );
      }
      const link = parsed.data;
      const ends = endsOf(link);
      const held = anchors.held.get(ends);
      if (held !== undefined) {
        anchors.held.set(ends, held | LINK_SEEN);
        if (unread(link) || anchors.sharings[held & ~LINK_SEEN] === sharingOf(link)) continue;
        const [shareType, visibility] = (anchors.sharings[held & ~LINK_SEEN] ?? '').split('/');
        const line: FileLinkChangedLine = {
          ...link,
          ShareType: shareType,
          Visibility: visibility,
          now: { ShareType: link.ShareType, Visibility: link.Visibility },
        };
        await changed.add(line);
        continue;
      }
      if (unread(link)) continue;
      // It goes with the file or the record the rewind deletes.
      if ((anchors.files.flagsOf(link.ContentDocumentId) & TO_DELETE) !== 0) continue;
      if ((records.flagsOf(link.LinkedEntityId) & RECORD_TO_DELETE) !== 0) continue;
      await added.add(link);
    }
  }

  const recreated = await Recreated.read(input.folder);
  for await (const kept of heldFileLinks(input.folder)) {
    const link = entityNow(kept, recreated);
    const held = anchors.held.get(endsOf(link)) ?? 0;
    if ((held & LINK_SEEN) !== 0 || unread(link)) continue;
    // It comes back with the file or the record the rewind brings back, or
    // is gone with the one gone for good.
    if ((anchors.files.flagsOf(link.ContentDocumentId) & (COMES_BACK | LOST)) !== 0) continue;
    if ((records.flagsOf(link.LinkedEntityId) & (RECORD_COMES_BACK | RECORD_LOST)) !== 0) continue;
    await removed.add(link);
  }
  for (const lines of [added, removed, changed]) await lines.flush();
  return { unlink: added.count, relink: removed.count, updateLinks: changed.count };
}

// ─── What the deletion of files takes along ──────────────────────────────────

/**
 * Of the files the rewind deletes, those linked as well to something the
 * checkpoint does not hold — a library, a group, a record of another object —
 * whose deletion takes the file away from it too, and the links that do so;
 * a share with a user follows the file, and is none. The files are added to
 * the preview's `outsideParents` of `ContentDocument`: a rewind of picked
 * objects keeps them unless the deletion of what hangs from them is
 * accepted, and removes only their links to the records it holds.
 *
 * @throws When the links of the files to delete could not be read.
 */
export async function outsideOfFiles(input: {
  anchors: FileAnchors;
  reader: CompositeReader;
  classFileOf: ClassFileOf;
  signal?: AbortSignal;
}): Promise<{ links: number; files: number }> {
  const { anchors, reader, classFileOf, signal } = input;
  const ids: string[] = [];
  for (const cls of FILE_CLASSES.toDelete) {
    for await (const row of linesOf(classFileOf(FILE_OBJECT, cls))) {
      if (typeof row.Id === 'string') ids.push(row.Id);
    }
  }
  if (ids.length === 0) return { links: 0, files: 0 };
  const parents = new Map<string, string>();
  let links = 0;
  for (const group of slices(idLists(ids, FILE_IDS_PER_READ), READS_AT_ONCE)) {
    const reads = group.map((list): ObjectRead => ({
      objectApiName: FILE_LINK_OBJECT,
      soql:
        `SELECT Id, ContentDocumentId, LinkedEntityId FROM ${FILE_LINK_OBJECT} ` +
        `WHERE ContentDocumentId IN (${list})`,
      scanAll: false,
    }));
    const outcomes = await readStreams(
      reader,
      reads,
      (_, rows) => {
        for (const row of rows) {
          const entity = row.LinkedEntityId;
          const file = row.ContentDocumentId;
          if (typeof entity !== 'string' || typeof file !== 'string') continue;
          if (entity.startsWith(USER_PREFIX)) continue;
          if (anchorOf({ LinkedEntityId: entity }, anchors.prefixes) !== undefined) continue;
          links++;
          parents.set(file.slice(0, 15), file);
        }
      },
      signal,
    );
    const failed = outcomes.find((outcome) => !outcome.read);
    if (failed && !failed.read) {
      throw new Error(
        `The links of the files to delete to what the checkpoint does not hold could not be read: ${failed.reason}`,
      );
    }
  }
  if (parents.size > 0) {
    const spool = new Lines(classFileOf(FILE_OBJECT, 'outsideParents'));
    for (const id of parents.values()) await spool.add({ Id: id });
    await spool.flush();
  }
  return { links, files: parents.size };
}
