/**
 * What a checkpoint holds of the org's files beside its objects — the links
 * between a file and the records it holds, and each file's latest version
 * and size — how its take reads them, how a rewind tells what a link anchors,
 * and where a preview spools the links it tells apart.
 *
 * A file is a `ContentDocument`, a record of the checkpoint like any other
 * (`checkpointScope.ts`, `checkpointFields.ts`). Its links are not: the org
 * refuses to read them without naming the file or the record each ties
 * (FA4), and a link has no `CreatedDate`. Nor are its versions, which the org
 * neither deletes nor brings back on their own. So the checkpoint keeps, in
 * its folder's `files/`:
 *
 * ```
 * files/links.ndjson.gz      {Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility}
 * files/documents.ndjson.gz  {Id, LatestPublishedVersionId, ContentSize, anchored}
 * ```
 *
 * compressed as the snapshot is (`compressedSnapshotFiles.ts`).
 *
 * The links are read from the records, never from the files. An admin with
 * View All Data but without Query All Files does not see a file someone else
 * owns in a read that names no id, even linked to an account the admin sees;
 * named by its id, it is seen, deleted and brought back (P-A7, a scratch
 * org). A read of the files, or of their links through the files, misses
 * every such file. So the links of each object the checkpoint holds records
 * of are read by one statement, `LinkedEntityId IN (SELECT Id FROM <Object>)`
 * (FA5); an object whose statement the org refuses or answers too late
 * (`QUERY_TIMEOUT`) has its links read by lists of 200 of its records' ids,
 * from the snapshot, and the checkpoint says so (`readByIds`). Then each file
 * a link names is read by its id, for its latest version and its size.
 *
 * A file is held when the snapshot of `ContentDocument` holds it, or a link
 * names it: `anchored` when a link ties it to a record of the checkpoint,
 * which alone a rewind acts on. One already in the org but anchored to
 * nothing is held all the same, so that linked since to a record of the
 * checkpoint it reads as a file already there, never as one added since to
 * delete.
 *
 * What moves of the links while the take runs is not told: a link has no
 * stamp to tell one added after T0 (P-A4: adding a link stamps nothing of
 * its file), and the checkpoint holds the links as they were read, between
 * T0 and T1. Nor are the links of an archived activity read: the statement
 * that reads an object's links reads its live records', as a plain query
 * does.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { sanitizeSoqlObjectName, type CheckpointFiles } from '@sandforge/shared';
import { nodeBackupFiles, type BackupRecordStoreDeps } from '../dataops/BackupRecordStore.js';
import {
  CHECKPOINT_DIR_MODE,
  CheckpointStoreError,
  filesDocumentsFileOf,
  filesLinksFileOf,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import { FILE_LINK_OBJECT, FILE_OBJECT } from './checkpointScope.js';
import { QUERIES_PER_COMPOSITE, type CompositeReader, type OrgRow } from './compositeQueries.js';
import { compressedSnapshotFiles } from './compressedSnapshotFiles.js';
import { spoolReads, spooledRows, type ObjectRead, type SpooledRead } from './orgStreams.js';
import { SnapshotIndex } from './snapshotIndex.js';

// ─── Figures ─────────────────────────────────────────────────────────────────

/**
 * Ids one read by id names: of records whose links are read when the org
 * refuses the statement that reads them all, or of files read for their
 * version. As many as a removal's reads by id name.
 */
export const FILE_IDS_PER_READ = 200;

/**
 * Reads by id spooled at once, ten composites of five: what a take writes to
 * the annex before it asks the next ones, so an object of 500,000 records
 * read by its ids never holds 2,500 spool files.
 */
const READS_AT_ONCE = QUERIES_PER_COMPOSITE * 10;

/** Lines the annex is written by at a time. */
const LINES_AT_ONCE = 2_000;

/** What a take reads of a link, in the order a line of the annex holds it. */
export const FILE_LINK_COLUMNS: readonly string[] = [
  'Id',
  'ContentDocumentId',
  'LinkedEntityId',
  'ShareType',
  'Visibility',
];

/** What a take reads of a file by its id. */
export const FILE_DOCUMENT_COLUMNS: readonly string[] = [
  'Id',
  'LatestPublishedVersionId',
  'ContentSize',
];

/** Where a take spools its reads before they go into the annex: removed before it ends. */
const TAKING_DIR = 'taking';

// ─── Lines ───────────────────────────────────────────────────────────────────

/** A record id, 15 or 18 characters. */
const recordIdSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'Not a record id');

/** A link's sharing, as the org names its values: `V`, `C`, `I`; `AllUsers`, … */
const sharingSchema = z.string().regex(/^[A-Za-z]{1,40}$/, 'Not a sharing value');

/** A link between a file and a record, as the annex holds it and a preview spools it. */
export const fileLinkLineSchema = z.object({
  Id: recordIdSchema,
  ContentDocumentId: recordIdSchema,
  LinkedEntityId: recordIdSchema,
  ShareType: sharingSchema,
  Visibility: sharingSchema,
});

/** A link, read. */
export type FileLinkLine = z.infer<typeof fileLinkLineSchema>;

/** A file, as the annex holds it. */
export const fileDocumentLineSchema = z.object({
  Id: recordIdSchema,
  /** Its latest version, which a new one replaces: null where the org gave none. */
  LatestPublishedVersionId: recordIdSchema.nullable(),
  /** The bytes of its content: what it takes of the org's file storage while it is not in the recycle bin. */
  ContentSize: z.number().int().nonnegative().nullable(),
  /** Whether a link ties it to a record of the checkpoint. */
  anchored: z.boolean(),
});

/** A file, read. */
export type FileDocumentLine = z.infer<typeof fileDocumentLineSchema>;

// ─── A preview's spools ──────────────────────────────────────────────────────

/**
 * The links a preview tells apart, between a file and a record that both
 * stay: one added since (removed by a rewind), one of the checkpoint removed
 * since (inserted again, under a new Id), one whose sharing changed since
 * (given back).
 */
export type FileLinkClass = 'linkAdded' | 'linkRemoved' | 'linkChanged';

/**
 * Where a preview spools the links of one class: beside the classes of its
 * objects, named as they are (`<Object>.<class>.ndjson`), under the object
 * of a link.
 */
export function fileLinkClassFileOf(previewDir: string, cls: FileLinkClass): string {
  return join(previewDir, `${FILE_LINK_OBJECT}.${cls}.ndjson`);
}

/**
 * A line of a preview's `linkChanged` spool: the link as the checkpoint
 * holds it — the sharing a rewind gives back — and the sharing it has now,
 * which an undo gives back in turn. A line of `linkAdded` is the link as it
 * is now, which an undo inserts again; one of `linkRemoved`, the link as the
 * checkpoint holds it, its Id the one it had.
 */
export const fileLinkChangedLineSchema = fileLinkLineSchema.extend({
  now: z.object({ ShareType: sharingSchema, Visibility: sharingSchema }),
});

/** A line of `linkChanged`, read. */
export type FileLinkChangedLine = z.infer<typeof fileLinkChangedLineSchema>;

// ─── Anchoring ───────────────────────────────────────────────────────────────

/** An object as the global describe lists it, as far as anchoring reads it. */
export interface PrefixedObject {
  name: string;
  keyPrefix?: string | null;
}

/**
 * The objects a checkpoint holds, by the first three characters of their
 * records' ids, from the org's global describe — each by the name the org
 * gives it: what tells the record a link names. An object the describe gives
 * no prefix is in none.
 */
export function heldPrefixesOf(
  globalObjects: readonly PrefixedObject[],
  held: readonly string[],
): Map<string, string> {
  const names = new Set(held.map((name) => name.toLowerCase()));
  const prefixes = new Map<string, string>();
  for (const object of globalObjects) {
    const prefix = object.keyPrefix;
    if (names.has(object.name.toLowerCase()) && typeof prefix === 'string' && prefix.length === 3) {
      prefixes.set(prefix, object.name);
    }
  }
  return prefixes;
}

/**
 * The object of the checkpoint a link anchors its file to: the object of the
 * record it names, when the checkpoint holds that object. None for a link to
 * a user, a group, a library (`ContentWorkspace`), or a record of an object
 * the checkpoint does not hold: such a link ties the file to nothing a rewind
 * puts back.
 *
 * @param prefixes - {@link heldPrefixesOf}.
 */
export function anchorOf(
  link: Pick<FileLinkLine, 'LinkedEntityId'>,
  prefixes: ReadonlyMap<string, string>,
): string | undefined {
  const id = link.LinkedEntityId;
  return typeof id === 'string' && id.length >= 15 ? prefixes.get(id.slice(0, 3)) : undefined;
}

// ─── The take's reads ────────────────────────────────────────────────────────

/** `ids` as a SOQL list, each an id. */
function idList(ids: readonly string[]): string {
  return ids
    .map((id) => {
      if (!recordIdSchema.safeParse(id).success) throw new Error(`Not a record id: ${id}`);
      return `'${id}'`;
    })
    .join(', ');
}

/** The statement that reads the links of every live record of `objectApiName`, through a semi-join (FA5). */
export function linksOfObjectRead(objectApiName: string): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  return {
    objectApiName: object,
    soql:
      `SELECT ${FILE_LINK_COLUMNS.join(', ')} FROM ${FILE_LINK_OBJECT} ` +
      `WHERE LinkedEntityId IN (SELECT Id FROM ${object})`,
    scanAll: false,
  };
}

/** How many links the records of `objectApiName` have: what a take's estimate prices their read by. */
export function linksCountRead(objectApiName: string): ObjectRead {
  const object = sanitizeSoqlObjectName(objectApiName);
  return {
    objectApiName: object,
    soql: `SELECT COUNT() FROM ${FILE_LINK_OBJECT} WHERE LinkedEntityId IN (SELECT Id FROM ${object})`,
    scanAll: false,
  };
}

/** The statement that reads the links of the records `ids` of `objectApiName`, {@link FILE_IDS_PER_READ} at most. */
export function linksOfRecordsRead(objectApiName: string, ids: readonly string[]): ObjectRead {
  return {
    objectApiName: sanitizeSoqlObjectName(objectApiName),
    soql:
      `SELECT ${FILE_LINK_COLUMNS.join(', ')} FROM ${FILE_LINK_OBJECT} ` +
      `WHERE LinkedEntityId IN (${idList(ids)})`,
    scanAll: false,
  };
}

/**
 * The statement that reads the files `ids` by their ids, {@link FILE_IDS_PER_READ}
 * at most: named so, a file another user owns is read too (P-A7).
 */
export function documentsRead(ids: readonly string[]): ObjectRead {
  return {
    objectApiName: FILE_OBJECT,
    soql: `SELECT ${FILE_DOCUMENT_COLUMNS.join(', ')} FROM ${FILE_OBJECT} WHERE Id IN (${idList(ids)})`,
    scanAll: false,
  };
}

/** What a take reads the files' annex from. */
export interface FilesTakeInput {
  reader: CompositeReader;
  /** The checkpoint's folder: its snapshot and index, read before. */
  folder: CheckpointFolder;
  snapshotId: string;
  /**
   * The objects whose records' links are read: those the checkpoint holds
   * records of that a link may name, in the take's reading order.
   */
  linked: readonly string[];
  /** Whether the snapshot holds records of `ContentDocument`: files anchored to nothing come from it. */
  documentsInSnapshot: boolean;
  signal?: AbortSignal;
  /** The annex's files: compressed as the snapshot is, over the checkpoint's folder, unless given. */
  files?: BackupRecordStoreDeps;
}

/** The lines of a spool file, `count` at a time, as written by the annex. */
async function* chunksOf<T>(rows: AsyncIterable<T>, count: number): AsyncGenerator<T[]> {
  let chunk: T[] = [];
  for await (const row of rows) {
    chunk.push(row);
    if (chunk.length >= count) {
      yield chunk;
      chunk = [];
    }
  }
  if (chunk.length > 0) yield chunk;
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

/** A row of the org as a line of `schema`, the columns it reads alone: the org's `attributes` left. */
function lineOf<T>(schema: z.ZodType<T>, row: OrgRow, what: string): T {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new Error(
      `The org answered a ${what} that does not read as one: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The key the org knows a record by: its id's first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/**
 * Read the files' annex into the checkpoint's folder, once its snapshot is
 * read and indexed: the links of the records of each object of `linked`,
 * then each file they name by its id, then the files of the snapshot no
 * link names. See the module's comment.
 *
 * Every read is whole or the take fails: a statement the org refuses is
 * read again by lists of ids, and a read by id that fails fails the take,
 * since a link left out would read, at a rewind, as one added since.
 *
 * @returns What `checkpoint.json` says of the files.
 * @throws {OrgReadStopped} When the take was stopped: the folder goes with it.
 */
export async function takeFiles(input: FilesTakeInput): Promise<CheckpointFiles> {
  const { reader, folder, signal } = input;
  const annex = input.files ?? compressedSnapshotFiles(nodeBackupFiles(folder.dir));
  const taking = join(folder.filesDir, TAKING_DIR);
  await mkdir(taking, { recursive: true, mode: CHECKPOINT_DIR_MODE });
  const linksFile = filesLinksFileOf(folder);
  const documentsFile = filesDocumentsFileOf(folder);
  await annex.writeFile(linksFile, '');
  await annex.writeFile(documentsFile, '');
  try {
    const named = new Map<string, string>();
    let links = 0;
    /** Put the rows of a spool whose read ended whole into the annex. */
    const keepLinks = async (file: string): Promise<void> => {
      for await (const rows of chunksOf(spooledRows(file), LINES_AT_ONCE)) {
        const lines = rows.map((row) => lineOf(fileLinkLineSchema, row, 'link'));
        for (const line of lines) {
          if (!named.has(keyOf(line.ContentDocumentId))) {
            named.set(keyOf(line.ContentDocumentId), line.ContentDocumentId);
          }
        }
        links += lines.length;
        await annex.appendFile(
          linksFile,
          lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
        );
      }
      await rm(file, { force: true });
    };

    const whole: SpooledRead[] = input.linked.map((objectApiName) => ({
      ...linksOfObjectRead(objectApiName),
      file: join(taking, `${sanitizeSoqlObjectName(objectApiName)}.links.ndjson`),
    }));
    const outcomes = await spoolReads(reader, whole, signal);
    const readByIds: string[] = [];
    for (const [at, outcome] of outcomes.entries()) {
      if (outcome.read) {
        await keepLinks(whole[at].file);
        continue;
      }
      // Refused, timed out, or stopped before the org said it was done: the
      // object's links are read again by its records' ids, as the snapshot
      // holds them.
      const objectApiName = input.linked[at];
      readByIds.push(objectApiName);
      const index = await SnapshotIndex.read(folder, input.snapshotId, objectApiName);
      let part = 0;
      for (const group of slices(slices(idsOf(index), FILE_IDS_PER_READ), READS_AT_ONCE)) {
        const reads: SpooledRead[] = group.map((ids) => ({
          ...linksOfRecordsRead(objectApiName, ids),
          file: join(taking, `${sanitizeSoqlObjectName(objectApiName)}.links.${part++}.ndjson`),
        }));
        const read = await spoolReads(reader, reads, signal);
        const failed = read.find((answer) => !answer.read);
        if (failed && !failed.read) {
          throw new Error(
            `The links of the files of ${objectApiName} could not be read whole: ${outcome.reason}; ` +
              `read by the ids of its records, ${failed.reason}`,
          );
        }
        for (const spooled of reads) await keepLinks(spooled.file);
      }
    }

    let documents = 0;
    let anchored = 0;
    const anchoredKeys = new Set<string>();
    for (const group of slices(slices(named.values(), FILE_IDS_PER_READ), READS_AT_ONCE)) {
      const reads: SpooledRead[] = group.map((ids, at) => ({
        ...documentsRead(ids),
        file: join(taking, `documents.${at}.ndjson`),
      }));
      const read = await spoolReads(reader, reads, signal);
      const failed = read.find((answer) => !answer.read);
      if (failed && !failed.read) {
        throw new Error(
          `The files the links name could not be read by their ids: ${failed.reason}`,
        );
      }
      for (const spooled of reads) {
        for await (const rows of chunksOf(spooledRows(spooled.file), LINES_AT_ONCE)) {
          const lines = rows.map((row) => ({
            ...lineOf(fileDocumentLineSchema.omit({ anchored: true }), row, 'file'),
            anchored: true,
          }));
          for (const line of lines) anchoredKeys.add(keyOf(line.Id));
          documents += lines.length;
          anchored += lines.length;
          await annex.appendFile(
            documentsFile,
            lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
          );
        }
        await rm(spooled.file, { force: true });
      }
    }

    if (input.documentsInSnapshot) {
      const index = await SnapshotIndex.read(folder, input.snapshotId, FILE_OBJECT);
      for await (const rows of chunksOf(index.records(), LINES_AT_ONCE)) {
        const lines = rows
          .filter((row) => typeof row.Id === 'string' && !anchoredKeys.has(keyOf(row.Id)))
          .map((row) => ({
            ...lineOf(fileDocumentLineSchema.omit({ anchored: true }), witnessOf(row), 'file'),
            anchored: false,
          }));
        documents += lines.length;
        if (lines.length > 0) {
          await annex.appendFile(
            documentsFile,
            lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
          );
        }
      }
    }
    return { documents, links, anchored, ...(readByIds.length > 0 ? { readByIds } : {}) };
  } finally {
    await rm(taking, { recursive: true, force: true });
  }
}

/** The ids of the records a snapshot's index holds, in its order, each as it is now. */
function* idsOf(index: SnapshotIndex): Generator<string> {
  for (let row = 0; row < index.size; row++) yield index.idAt(row);
}

/** What the annex keeps of a snapshot row of a file: its id and its witnesses. */
function witnessOf(row: OrgRow): OrgRow {
  return {
    Id: row.Id,
    LatestPublishedVersionId: row.LatestPublishedVersionId ?? null,
    ContentSize: row.ContentSize ?? null,
  };
}

// ─── Reading the annex ───────────────────────────────────────────────────────

/** The lines of one of the annex's files, each read as `schema` reads it, or the checkpoint is damaged. */
async function* annexLines<T>(
  files: BackupRecordStoreDeps,
  file: string,
  schema: z.ZodType<T>,
  what: string,
): AsyncGenerator<T> {
  if (!(await files.exists(file))) {
    throw new CheckpointStoreError('damaged', `The checkpoint’s ${what} are not there`);
  }
  for await (const text of files.readLines(file)) {
    if (text === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CheckpointStoreError(
        'damaged',
        `The checkpoint’s ${what} hold a line that is not JSON`,
      );
    }
    const line = schema.safeParse(parsed);
    if (!line.success) {
      throw new CheckpointStoreError(
        'damaged',
        `The checkpoint’s ${what} hold a line that does not parse`,
      );
    }
    yield line.data;
  }
}

/**
 * The links a checkpoint holds, one at a time, never the file whole.
 *
 * @throws {CheckpointStoreError} `damaged`, when they are not there or a line does not parse.
 */
export function heldFileLinks(
  folder: Pick<CheckpointFolder, 'dir' | 'filesDir'>,
  files: BackupRecordStoreDeps = compressedSnapshotFiles(nodeBackupFiles(folder.dir)),
): AsyncGenerator<FileLinkLine> {
  return annexLines(files, filesLinksFileOf(folder), fileLinkLineSchema, 'file links');
}

/**
 * The files a checkpoint holds, one at a time, never the file whole.
 *
 * @throws {CheckpointStoreError} `damaged`, when they are not there or a line does not parse.
 */
export function heldFileDocuments(
  folder: Pick<CheckpointFolder, 'dir' | 'filesDir'>,
  files: BackupRecordStoreDeps = compressedSnapshotFiles(nodeBackupFiles(folder.dir)),
): AsyncGenerator<FileDocumentLine> {
  return annexLines(files, filesDocumentsFileOf(folder), fileDocumentLineSchema, 'files');
}
