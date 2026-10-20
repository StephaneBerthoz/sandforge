/**
 * File stage of the Forge execution pipeline.
 *
 * Copies the files attached to the records a run clones, once those records
 * are in the target: Salesforce Files — the latest version of each document
 * linked to a record in scope — and legacy attachments. Nothing else: a file
 * linked only to records outside the scope is never read, and neither is a
 * library, since the files are found from the records and not the other way
 * round.
 *
 * Every file goes in one call each way: its content read from the source,
 * then written to the target as the base64 value of a JSON body — one record
 * per request, never a batch, never Bulk API, which rejects base64. A file
 * larger than the run's cap is left out and listed, never cut short, and the
 * whole set is checked against the file storage the target has left before
 * the run writes anything at all.
 *
 * Sync copies the files of the records it writes with this same stage. A run
 * of a saved Sync configuration may find a file an earlier run copied: it is
 * then written as a new version of that copy, or only linked to the records
 * it lacks, never copied as a second document (see {@link FileCopyTarget}).
 */

import type {
  ForgeFileLeftOut,
  ForgeFileObject,
  ForgeFileObjectReport,
  ForgeFilesReport,
} from '@sandforge/shared';
import { BYTES_PER_MB, formatFileSize } from '@sandforge/shared';
import type { ExecutionObjectError, ForgeProgressEvent, InsertResult } from '../ForgeExecutor.js';
import type { IdRemapper } from '../IdRemapper.js';
import { createHash } from 'node:crypto';
import { idLists } from '../../dataops/RecordRemoval.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';
import { whatTheWriteLeft } from '../../../core/common/thrownWrite.js';
import type { InsertCallJournal } from './BatchWriter.js';

/** The objects a file's content is read from and written to, and the field holding it. */
export const FILE_BODY_FIELDS = {
  ContentVersion: 'VersionData',
  Attachment: 'Body',
} as const;

/** An object whose records hold a file's content. */
export type FileBodyObject = keyof typeof FILE_BODY_FIELDS;

/** Samples kept per object and stage, as the record stages keep them. */
const SAMPLE_LIMIT = 3;

/**
 * Raised when a run asked to copy files may not go ahead: it anonymizes and
 * the files were not accepted as they are, the session cannot move a file,
 * the files of its records could not be looked up, or the files do not fit in
 * what the target has left. Raised before anything is written.
 */
export class ForgeFilesRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeFilesRefusedError';
  }
}

/** What the stage needs from the two orgs. */
export interface FileCopyDeps {
  /** Query records, as the rest of the run does. */
  queryRecords: (orgId: string, soql: string) => Promise<Record<string, unknown>[]>;
  /** The content of one file, base64-encoded, as the org holds it. */
  readFileBody: (orgId: string, objectApiName: FileBodyObject, id: string) => Promise<string>;
  /** Create one record carrying a file's content, in a call of its own. */
  insertFile: (
    orgId: string,
    objectApiName: FileBodyObject,
    record: Record<string, unknown>,
  ) => Promise<InsertResult>;
  /** Create records carrying no content: the links of a copied document. */
  insertRecords: (
    orgId: string,
    objectApiName: string,
    records: Record<string, unknown>[],
  ) => Promise<InsertResult[]>;
  /** The file storage the org has left, in MB, as its `/limits` say. */
  remainingFileStorageMB: (orgId: string) => Promise<number>;
}

/** A record in scope a file hangs on, with how the source linked the file to it. */
export interface FileHost {
  /** The record's id in the source. */
  id: string;
  /** For a Salesforce File, the link's permission: V, C or I. */
  shareType?: string;
  /** For a Salesforce File, who the link shows the file to. */
  visibility?: string;
}

/**
 * A Salesforce File an earlier run copied into the target. Its content goes
 * in as a new version of that copy, rather than as a second document.
 */
export interface FileCopyTarget {
  /** The copy's document in the target. */
  documentId: string;
  /** The target records the copy is linked to already: none of them is linked again. */
  linked: readonly string[];
  /**
   * The source holds the version copied before: nothing is read or written,
   * and the copy is only linked to the records it lacks.
   */
  unchanged?: boolean;
}

/** A file the run is to copy. */
export interface FileToCopy {
  /** The object it is counted under. */
  objectApiName: ForgeFileObject;
  /** Its id in the source: the document, or the attachment. */
  sourceId: string;
  /** Where its content is read from: the document's latest version, or the attachment. */
  body: { objectApiName: FileBodyObject; id: string };
  /** Its title or name. */
  name: string;
  /** Its size in bytes, as the source reports it. */
  bytes: number;
  /** The records in scope it hangs on, in the order the run read them. */
  hosts: FileHost[];
  /** The fields written beside the content, as the source holds them. */
  fields: Record<string, unknown>;
  /** For a Salesforce File an earlier run copied: the copy its content goes into. */
  into?: FileCopyTarget;
}

/** The files of a run's records, before anything is written. */
export interface FileSelection {
  /** The files to copy, within the cap. */
  files: FileToCopy[];
  /** The files left out already: too large, or kept outside Salesforce. */
  leftOut: ForgeFileLeftOut[];
  /** The reads that failed, to report. */
  errors: ExecutionObjectError[];
}

/** A string field of a row, or undefined. */
function text(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A number field of a row, 0 when the row gives none. */
function size(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A report of a lookup that failed. It counts no file, since the files it
 * would have found are unknown: a real run stops on it (see
 * {@link lookupFailure}), and only a dry run reports it.
 */
function readFailure(objectApiName: string, what: string, err: unknown): ExecutionObjectError {
  return {
    objectApiName,
    stage: 'query',
    failedCount: 0,
    attemptedCount: 0,
    samples: [{ recordSummary: what, messages: [extractErrorMessage(err)] }],
  };
}

/**
 * The files attached to the records in scope: the latest version of every
 * document linked to one of them, and every attachment one of them is the
 * parent of. A file over `maxFileBytes`, or one kept outside Salesforce, is
 * left out and listed.
 *
 * @param scope - Per object, the source ids of the records the run read.
 */
export async function selectFiles(input: {
  scope: ReadonlyMap<string, readonly string[]>;
  sourceOrgId: string;
  maxFileBytes: number;
  queryRecords: FileCopyDeps['queryRecords'];
}): Promise<FileSelection> {
  const { scope, sourceOrgId, maxFileBytes, queryRecords } = input;
  const position = new Map<string, number>();
  for (const ids of scope.values()) {
    for (const id of ids) if (!position.has(id)) position.set(id, position.size);
  }
  const selection: FileSelection = { files: [], leftOut: [], errors: [] };
  const recordIds = [...position.keys()];
  if (recordIds.length === 0) return selection;
  const orderOf = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;

  // Salesforce Files: the links from the records, then each document's latest version.
  const hostsOf = new Map<string, FileHost[]>();
  try {
    for (const list of idLists(recordIds)) {
      const links = await queryRecords(
        sourceOrgId,
        'SELECT ContentDocumentId, LinkedEntityId, ShareType, Visibility FROM ContentDocumentLink ' +
          `WHERE LinkedEntityId IN (${list})`,
      );
      for (const link of links) {
        const documentId = text(link, 'ContentDocumentId');
        const recordId = text(link, 'LinkedEntityId');
        if (!documentId || !recordId || !position.has(recordId)) continue;
        const hosts = hostsOf.get(documentId) ?? [];
        if (!hosts.some((host) => host.id === recordId)) {
          hosts.push({
            id: recordId,
            shareType: text(link, 'ShareType'),
            visibility: text(link, 'Visibility'),
          });
        }
        hostsOf.set(documentId, hosts);
      }
    }
  } catch (err) {
    selection.errors.push(readFailure('ContentDocument', '(links of the records in scope)', err));
  }

  const candidates: Array<{ file: FileToCopy; external: boolean }> = [];
  try {
    for (const list of idLists([...hostsOf.keys()])) {
      const versions = await queryRecords(
        sourceOrgId,
        'SELECT Id, ContentDocumentId, Title, PathOnClient, ContentSize, ContentLocation, SharingPrivacy ' +
          `FROM ContentVersion WHERE ContentDocumentId IN (${list}) AND IsLatest = true`,
      );
      for (const version of versions) {
        const documentId = text(version, 'ContentDocumentId');
        const versionId = text(version, 'Id');
        const hosts = documentId ? hostsOf.get(documentId) : undefined;
        if (!documentId || !versionId || !hosts) continue;
        const name = text(version, 'Title') ?? documentId;
        candidates.push({
          external: (text(version, 'ContentLocation') ?? 'S') !== 'S',
          file: {
            objectApiName: 'ContentDocument',
            sourceId: documentId,
            body: { objectApiName: 'ContentVersion', id: versionId },
            name,
            bytes: size(version, 'ContentSize'),
            hosts: [...hosts].sort((a, b) => orderOf(a.id) - orderOf(b.id)),
            fields: {
              Title: name,
              PathOnClient: text(version, 'PathOnClient') ?? name,
              // Private to its owner in the source, it stays so in the target:
              // written without it, the copy would show to anyone who sees
              // the record.
              ...(text(version, 'SharingPrivacy') === 'P' ? { SharingPrivacy: 'P' } : {}),
            },
          },
        });
      }
    }
  } catch (err) {
    selection.errors.push(readFailure('ContentDocument', '(latest versions of the files)', err));
  }

  // Legacy attachments: every one whose parent is in scope.
  try {
    for (const list of idLists(recordIds)) {
      const attachments = await queryRecords(
        sourceOrgId,
        'SELECT Id, ParentId, Name, ContentType, BodyLength, IsPrivate FROM Attachment ' +
          `WHERE ParentId IN (${list})`,
      );
      for (const attachment of attachments) {
        const id = text(attachment, 'Id');
        const parentId = text(attachment, 'ParentId');
        if (!id || !parentId || !position.has(parentId)) continue;
        const name = text(attachment, 'Name') ?? id;
        candidates.push({
          external: false,
          file: {
            objectApiName: 'Attachment',
            sourceId: id,
            body: { objectApiName: 'Attachment', id },
            name,
            bytes: size(attachment, 'BodyLength'),
            hosts: [{ id: parentId }],
            fields: {
              Name: name,
              ...(text(attachment, 'ContentType')
                ? { ContentType: text(attachment, 'ContentType') }
                : {}),
              IsPrivate: attachment['IsPrivate'] === true,
            },
          },
        });
      }
    }
  } catch (err) {
    selection.errors.push(readFailure('Attachment', '(attachments of the records in scope)', err));
  }

  // In the order the records they hang on were read, so the files of the root
  // come first and a stopped run has copied those.
  candidates.sort((a, b) => orderOf(a.file.hosts[0].id) - orderOf(b.file.hosts[0].id));
  for (const { file, external } of candidates) {
    const leftOut = external ? 'external' : file.bytes > maxFileBytes ? 'too-large' : undefined;
    if (leftOut) {
      selection.leftOut.push({
        objectApiName: file.objectApiName,
        sourceId: file.sourceId,
        name: file.name,
        bytes: file.bytes,
        reason: leftOut,
      });
    } else {
      selection.files.push(file);
    }
  }
  return selection;
}

/**
 * Why the run cannot say which files its records hold, or null when every
 * lookup answered.
 *
 * A lookup that failed — the links, the versions or the attachments — hides
 * an unknown number of files. The run used to write its records all the
 * same, without those files, and read as a success whose files said there
 * was none to copy.
 */
export function lookupFailure(selection: FileSelection): string | null {
  if (selection.errors.length === 0) return null;
  const messages = new Set(
    selection.errors.flatMap((error) => error.samples.flatMap((sample) => sample.messages)),
  );
  return (
    `The files of the records to clone could not all be looked up in the source ` +
    `(${[...messages].join('; ')}). Run it again, or leave the files out.`
  );
}

/** What an earlier part of a run made of a file, as its journal says: see {@link takeUpFilesCopiedBefore}. */
export interface FileCopiedBefore {
  /** The object it was registered under: its document, its version alone, or the attachment. */
  objectApiName: string;
  targetId: string;
}

/** The files of a run that takes up another, once what that one copied is set apart. */
export interface FilesTakenUp {
  /**
   * The files, in their order: those to copy as they were, and those an
   * earlier part copied, as copies to link to the records they lack
   * (`FileCopyTarget.unchanged`). An attachment it copied is left out: its
   * parent is its one record.
   */
  files: FileToCopy[];
  /** A version whose document still cannot be read back: neither copied again nor linked. */
  errors: ExecutionObjectError[];
}

/**
 * Of the files a run is to copy, set apart those an earlier part of the run
 * copied — the run this one takes up where it stopped: none is copied again.
 * A copy is linked to the records it lacks, read from its links in the target,
 * and a version the earlier part kept without its document — the process was
 * killed before the document was read back — has its document read back now,
 * and is then such a copy. The version stays the earlier part's record, as
 * its journal names it: a removal of that part takes its document.
 *
 * @param copiedBefore - What an earlier part registered for a file's source
 *   id, when it did; nothing for one this part is to copy.
 */
export async function takeUpFilesCopiedBefore(input: {
  files: readonly FileToCopy[];
  targetOrgId: string;
  copiedBefore: (sourceId: string) => FileCopiedBefore | undefined;
  queryRecords: FileCopyDeps['queryRecords'];
}): Promise<FilesTakenUp> {
  const { files, targetOrgId, copiedBefore, queryRecords } = input;
  const taken: FilesTakenUp = { files: [], errors: [] };
  const before = new Map<string, FileCopiedBefore>();
  for (const file of files) {
    const made = copiedBefore(file.sourceId);
    if (made) before.set(file.sourceId, made);
  }
  if (before.size === 0) return { ...taken, files: [...files] };

  /** The document of each copy, by the file's source id: as registered, or read back now. */
  const documents = new Map<string, string>();
  /** Why the versions' documents could not be read back, when they could not. */
  let versionsUnread: string | undefined;
  const versions = new Map<string, string>();
  for (const [sourceId, made] of before) {
    if (made.objectApiName === 'ContentVersion') versions.set(made.targetId, sourceId);
    if (made.objectApiName === 'ContentDocument') documents.set(sourceId, made.targetId);
  }
  try {
    for (const list of idLists([...versions.keys()])) {
      const rows = await queryRecords(
        targetOrgId,
        `SELECT Id, ContentDocumentId FROM ContentVersion WHERE Id IN (${list})`,
      );
      for (const row of rows) {
        const version = text(row, 'Id');
        const document = text(row, 'ContentDocumentId');
        const sourceId = version ? versions.get(version) : undefined;
        if (sourceId && document) documents.set(sourceId, document);
      }
    }
  } catch (err) {
    versionsUnread = extractErrorMessage(err);
  }

  /** The records each copy is linked to in the target, by its document. */
  const linkedTo = new Map<string, string[]>();
  /** Why the links of the copies could not be read, when they could not. */
  let linksUnread: string | undefined;
  try {
    for (const list of idLists([...new Set(documents.values())])) {
      const links = await queryRecords(
        targetOrgId,
        'SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink ' +
          `WHERE ContentDocumentId IN (${list})`,
      );
      for (const link of links) {
        const document = text(link, 'ContentDocumentId');
        const record = text(link, 'LinkedEntityId');
        if (document && record) linkedTo.set(document, [...(linkedTo.get(document) ?? []), record]);
      }
    }
  } catch (err) {
    linksUnread = extractErrorMessage(err);
  }

  const notTakenUp = (file: FileToCopy, why: string): void => {
    taken.errors.push({
      objectApiName: 'ContentDocument',
      stage: 'query',
      failedCount: 0,
      attemptedCount: 0,
      samples: [{ recordSummary: `${file.name} (${formatFileSize(file.bytes)})`, messages: [why] }],
    });
  };
  for (const file of files) {
    const made = before.get(file.sourceId);
    if (!made) {
      taken.files.push(file);
      continue;
    }
    // An attachment hangs on its one parent: copied, it is done.
    if (file.body.objectApiName === 'Attachment') continue;
    const document = documents.get(file.sourceId);
    if (!document) {
      notTakenUp(
        file,
        `Copied as ContentVersion ${made.targetId} by the run this one takes up, and its ` +
          'document still cannot be read back' +
          (versionsUnread ? ` (${versionsUnread})` : '') +
          ': the file is not copied again, nor linked to the records it lacks.',
      );
      continue;
    }
    if (linksUnread) {
      notTakenUp(
        file,
        `Copied by the run this one takes up; its links could not be read (${linksUnread}): ` +
          'it is not linked to the records it lacks.',
      );
      continue;
    }
    taken.files.push({
      ...file,
      into: { documentId: document, linked: linkedTo.get(document) ?? [], unchanged: true },
    });
  }
  return taken;
}

/**
 * A report about the run's files as a whole, rather than one object's: named
 * for no object, as the other reports of a pass are, so the audit trail does
 * not count it as a record.
 */
export function filesRunError(message: string): ExecutionObjectError {
  return {
    objectApiName: '__files__',
    stage: 'scope',
    failedCount: 0,
    attemptedCount: 0,
    samples: [{ recordSummary: '(files)', messages: [message] }],
  };
}

/** The bytes the files take. */
export function bytesOf(files: readonly FileToCopy[]): number {
  return files.reduce((total, file) => total + file.bytes, 0);
}

/**
 * Why the files do not fit in what the target has left, or null when they do.
 *
 * @param neededBytes - What the files take.
 * @param remainingBytes - What the target's file storage has left.
 */
export function storageShortfall(neededBytes: number, remainingBytes: number): string | null {
  if (neededBytes <= remainingBytes) return null;
  return (
    `The files to copy take ${formatFileSize(neededBytes)} and the target has ` +
    `${formatFileSize(Math.max(0, remainingBytes))} of file storage left. ` +
    'Lower the largest file copied, or leave the files out.'
  );
}

/** The target's file storage left, in bytes. */
export async function remainingStorageBytes(
  deps: Pick<FileCopyDeps, 'remainingFileStorageMB'>,
  targetOrgId: string,
): Promise<number> {
  const megabytes = await deps.remainingFileStorageMB(targetOrgId);
  if (!Number.isFinite(megabytes)) {
    throw new Error('The target did not say how much file storage it has left.');
  }
  return megabytes * BYTES_PER_MB;
}

/**
 * The report of a run's files before any is written: what it sets out to
 * copy, per object, and what it left out.
 */
export function plannedFilesReport(
  selection: FileSelection,
  maxFileBytes: number,
  remainingBytes?: number,
): ForgeFilesReport {
  const objects: ForgeFileObjectReport[] = [];
  for (const file of selection.files) {
    let entry = objects.find((o) => o.objectApiName === file.objectApiName);
    if (!entry) {
      entry = {
        objectApiName: file.objectApiName,
        planned: 0,
        plannedBytes: 0,
        copied: 0,
        failed: 0,
      };
      objects.push(entry);
    }
    entry.planned++;
    entry.plannedBytes += file.bytes;
  }
  return {
    maxFileBytes,
    objects,
    links: 0,
    leftOut: [...selection.leftOut],
    ...(remainingBytes === undefined ? {} : { remainingStorageBytes: remainingBytes }),
  };
}

/** What a user reads of the files of one object: a file, or an attachment. */
function noun(objectApiName: ForgeFileObject, count: number): string {
  const one = objectApiName === 'Attachment' ? 'attachment' : 'file';
  return count === 1 ? one : `${one}s`;
}

/** The line a dry run says of one object's files. */
export function dryRunLine(entry: ForgeFileObjectReport): string {
  return (
    `[dry-run] ${entry.objectApiName}: ${entry.planned} ${noun(entry.objectApiName, entry.planned)} ` +
    `would be copied (${formatFileSize(entry.plannedBytes)})`
  );
}

/** What a file the stage wrote became in the target. */
export interface CopiedFile {
  /** The copy: the document, or the attachment. */
  targetId: string;
  /** The target records this call linked it to, the one it was published on first. */
  linked: string[];
  /** Whether its content was written as a new version of an earlier copy. */
  asVersion: boolean;
}

/** Inputs for {@link copyFiles}. */
export interface FileCopyInput {
  files: readonly FileToCopy[];
  sourceOrgId: string;
  targetOrgId: string;
  /**
   * Which records the run created, and their ids in the target; files are
   * added to it, and put on disk as each is (`persist`) when it keeps them there.
   */
  remapper: Pick<IdRemapper, 'isCreated' | 'get' | 'add'> & Partial<Pick<IdRemapper, 'persist'>>;
  deps: FileCopyDeps;
  /**
   * The report the run returns, kept up to date file by file: a run stopped
   * part way still says what it copied.
   */
  report: ForgeFilesReport;
  /** Where the failures are reported, as the record stages report theirs. */
  errors: ExecutionObjectError[];
  /** Pause/abort checkpoint, called before each file. */
  waitIfPaused: () => Promise<void>;
  onProgress: (event: ForgeProgressEvent) => void;
  /** Told of each file once it and its links are written: what Sync keeps to not copy it twice. */
  onCopied?: (file: FileToCopy, copy: CopiedFile) => void;
  /**
   * Where each file's insert is kept before it goes, and closed once the
   * file is registered: the run's journal, as for its records
   * (`WriteNodeInput.calls`), fingerprinted by what the target reads back of
   * it (`fileFingerprint`). A process killed while a file was under way left
   * it in the target unnamed, and the part that took the run up copied it a
   * second time. Its links are not kept: the platform refuses a second link of
   * a document to a record, and a part taking the run up reads the links of
   * each copy back (`takeUpFilesCopiedBefore`). Absent, none is kept.
   */
  calls?: InsertCallJournal;
}

/**
 * What a file's insert is fingerprinted by in the run's journal: what the
 * target reads back of the record it creates — a version's title, the MD5 of
 * its content the platform keeps as its `Checksum`, and its size; an
 * attachment's name, size and parent — never the content itself.
 *
 * @param content - The file's content, base64-encoded, as it is sent.
 * @param parentId - The record an attachment goes under, in the target.
 */
export function fileFingerprint(
  file: Pick<FileToCopy, 'body' | 'name' | 'bytes' | 'fields'>,
  content: string,
  parentId: string | undefined,
): Record<string, unknown> {
  if (file.body.objectApiName === 'Attachment') {
    return { Name: file.fields['Name'] ?? file.name, BodyLength: file.bytes, ParentId: parentId };
  }
  return {
    Title: file.fields['Title'] ?? file.name,
    Checksum: createHash('md5').update(Buffer.from(content, 'base64')).digest('hex'),
    ContentSize: file.bytes,
  };
}

/** A version's fields: its title and file name. Who sees the document stays as the copy has it. */
function versionFields(fields: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field !== 'SharingPrivacy') kept[field] = value;
  }
  return kept;
}

/**
 * Write the files, one call each, after the records they hang on.
 *
 * A file hangs on the records in scope the run created: a Salesforce File is
 * published on the first of them (`FirstPublishLocationId`) and linked to the
 * others, an attachment written under its parent. A file whose records the
 * run did not create — the target held them already, or refused them — is
 * left out. Each file created is put in the remapper as soon as it exists,
 * under the object whose removal takes it away whole — a Salesforce File by
 * its document — so a run stopped part way can still have its files removed.
 *
 * A Salesforce File with a {@link FileCopyTarget} goes into that copy as a new
 * version, whether or not the run created a record it hangs on, and is linked
 * to the records the run created that the copy is not linked to yet; one whose
 * source has not changed is only linked.
 *
 * @returns The records that were not written — files, and links to them —
 *   for the run's failed count.
 */
export async function copyFiles(input: FileCopyInput): Promise<number> {
  const { files, sourceOrgId, targetOrgId, remapper, deps, report, errors, onProgress, onCopied } =
    input;
  let failures = 0;

  const entryOf = (objectApiName: ForgeFileObject): ForgeFileObjectReport => {
    let entry = report.objects.find((o) => o.objectApiName === objectApiName);
    if (!entry) {
      entry = { objectApiName, planned: 0, plannedBytes: 0, copied: 0, failed: 0 };
      report.objects.push(entry);
    }
    return entry;
  };
  const errorOf = (objectApiName: string, stage: ExecutionObjectError['stage']) =>
    errors.find((e) => e.objectApiName === objectApiName && e.stage === stage);
  /**
   * Per object and stage, the records the stage tried: what its failures are
   * counted out of, as the record stages count theirs. Counted from its
   * failures alone, a stage that lost 2 files of 50 said "2/2", as if it had
   * copied none.
   */
  const tried = new Map<string, number>();
  const attempt = (
    objectApiName: string,
    stage: ExecutionObjectError['stage'],
    count = 1,
  ): void => {
    const key = `${objectApiName}/${stage}`;
    tried.set(key, (tried.get(key) ?? 0) + count);
    const error = errorOf(objectApiName, stage);
    if (error) error.attemptedCount += count;
  };
  /**
   * Report a record the run did not write — or, when `written` says so, a
   * problem with one it did, which is not counted as failed.
   */
  const noteError = (
    objectApiName: string,
    stage: ExecutionObjectError['stage'],
    recordSummary: string,
    message: string,
    written = false,
  ): void => {
    let error = errorOf(objectApiName, stage);
    if (!error) {
      error = {
        objectApiName,
        stage,
        failedCount: 0,
        attemptedCount: tried.get(`${objectApiName}/${stage}`) ?? 0,
        samples: [],
      };
      errors.push(error);
    }
    if (!written) {
      error.failedCount++;
      failures++;
    }
    if (error.samples.length < SAMPLE_LIMIT) {
      error.samples.push({ recordSummary, messages: [message] });
    }
  };
  const failFile = (file: FileToCopy, stage: 'query' | 'insert', message: string): void => {
    noteError(file.objectApiName, stage, `${file.name} (${formatFileSize(file.bytes)})`, message);
    entryOf(file.objectApiName).failed++;
  };

  /**
   * Link `documentId` to the records of `hosts` the run created, and say which
   * links the target took: a link it refused is counted as a record not
   * written.
   */
  const link = async (
    file: FileToCopy,
    documentId: string,
    linkHosts: readonly FileHost[],
  ): Promise<string[]> => {
    const links = linkHosts.flatMap((host) => {
      const linkedTo = remapper.get(host.id);
      return linkedTo
        ? [
            {
              ContentDocumentId: documentId,
              LinkedEntityId: linkedTo,
              ShareType: host.shareType ?? 'V',
              Visibility: host.visibility ?? 'AllUsers',
            },
          ]
        : [];
    });
    if (links.length === 0) return [];
    const linked: string[] = [];
    attempt('ContentDocumentLink', 'insert', links.length);
    try {
      const results = await deps.insertRecords(targetOrgId, 'ContentDocumentLink', links);
      links.forEach((written, at) => {
        const result = results[at];
        if (result?.success) {
          report.links++;
          linked.push(written.LinkedEntityId);
          return;
        }
        noteError(
          'ContentDocumentLink',
          'insert',
          file.name,
          result?.errors.join('; ') || 'The target gave no reason.',
        );
      });
    } catch (err) {
      for (let at = 0; at < links.length; at++) {
        noteError('ContentDocumentLink', 'insert', file.name, extractErrorMessage(err));
      }
    }
    return linked;
  };

  // What the progress counts: the files whose content is read and written. A
  // copy only linked to the records it lacks is not one of them.
  const total = files.filter(
    (f) => !(f.body.objectApiName === 'ContentVersion' && f.into?.unchanged),
  ).length;
  let reached = 0;

  for (const file of files) {
    await input.waitIfPaused();
    const hosts = file.hosts.filter((host) => remapper.isCreated(host.id));
    // A version of an earlier copy goes into that copy, linked to the records
    // it lacks: its document is not published again on one of them.
    const into = file.body.objectApiName === 'ContentVersion' ? file.into : undefined;
    const unlinked = into
      ? hosts.filter((host) => {
          const target = remapper.get(host.id);
          return target !== undefined && !into.linked.includes(target);
        })
      : [];
    if (into?.unchanged) {
      const linked = await link(file, into.documentId, unlinked);
      if (linked.length > 0)
        onCopied?.(file, { targetId: into.documentId, linked, asVersion: false });
      continue;
    }
    const index = reached++;
    const publishedOn = hosts.length > 0 ? remapper.get(hosts[0].id) : undefined;
    if (!publishedOn && !into) {
      report.leftOut.push({
        objectApiName: file.objectApiName,
        sourceId: file.sourceId,
        name: file.name,
        bytes: file.bytes,
        reason: 'record-not-created',
      });
      continue;
    }
    onProgress({
      objectName: file.objectApiName,
      status: 'running',
      progress: Math.round((index / total) * 100),
      message: `Copying ${noun(file.objectApiName, 1)} ${index + 1} of ${total} (${formatFileSize(file.bytes)})`,
    });

    let content: string;
    attempt(file.objectApiName, 'query');
    try {
      content = await deps.readFileBody(sourceOrgId, file.body.objectApiName, file.body.id);
    } catch (err) {
      failFile(file, 'query', extractErrorMessage(err));
      continue;
    }
    // Written short, a file opens broken in the target with nothing to say
    // so: a read that did not bring the whole file writes nothing.
    const read = Buffer.byteLength(content, 'base64');
    if (read !== file.bytes) {
      failFile(
        file,
        'query',
        `Read ${read} bytes of the ${file.bytes} the source reports: the file was not written.`,
      );
      continue;
    }

    const record = into
      ? { ...versionFields(file.fields), VersionData: content, ContentDocumentId: into.documentId }
      : file.body.objectApiName === 'ContentVersion'
        ? { ...file.fields, VersionData: content, FirstPublishLocationId: publishedOn }
        : { ...file.fields, Body: content, ParentId: publishedOn };
    let written: InsertResult;
    attempt(file.objectApiName, 'insert');
    // Kept before it goes: see `FileCopyInput.calls`.
    const callId = input.calls?.sending(file.body.objectApiName, [
      { sourceId: file.sourceId, payload: fileFingerprint(file, content, publishedOn) },
    ]);
    /** Close the call: once the file is registered, or once it is known to have written nothing. */
    const answered = (): void => {
      if (callId !== undefined) input.calls?.answered(callId);
    };
    try {
      written = await deps.insertFile(targetOrgId, file.body.objectApiName, record);
    } catch (err) {
      // One that may have written the file stays open, for a run taken up to look for it.
      if (whatTheWriteLeft(err) !== 'may-have-written') answered();
      failFile(file, 'insert', extractErrorMessage(err));
      continue;
    }
    if (!written.success || !written.id) {
      answered();
      failFile(file, 'insert', written.errors.join('; ') || 'The target gave no reason.');
      continue;
    }
    entryOf(file.objectApiName).copied++;

    if (file.body.objectApiName === 'Attachment') {
      remapper.add(file.sourceId, written.id, 'Attachment');
      answered();
      remapper.persist?.();
      onCopied?.(file, {
        targetId: written.id,
        linked: publishedOn ? [publishedOn] : [],
        asVersion: false,
      });
      continue;
    }

    if (into) {
      remapper.add(file.sourceId, into.documentId, 'ContentDocument');
      answered();
      remapper.persist?.();
      const linked = await link(file, into.documentId, unlinked);
      onCopied?.(file, { targetId: into.documentId, linked, asVersion: true });
      continue;
    }

    // The version the target created, on disk before the run asks it anything
    // more: its document is read back next, and a process killed in between
    // left a file in the target that the journal did not name. Kept so, the
    // part that takes the run up reads the document back instead of copying
    // the file again (`takeUpFilesCopiedBefore`), and a removal of the run
    // takes the version's document. The insert itself is kept before it goes
    // (`calls`): a process killed while it is under way leaves a file the
    // part taking the run up looks for first, and links to once found.
    remapper.add(file.sourceId, written.id, 'ContentVersion');
    answered();
    remapper.persist?.();

    // The document the version created: what removing the run deletes, which
    // takes the version and every link with it, and what the links name.
    let documentId: string | undefined;
    try {
      const rows = await deps.queryRecords(
        targetOrgId,
        `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${sanitizeSoqlValue(written.id)}'`,
      );
      documentId = rows[0] ? text(rows[0], 'ContentDocumentId') : undefined;
    } catch {
      documentId = undefined;
    }
    if (!documentId) {
      noteError(
        'ContentDocument',
        'query',
        `${file.name} (${formatFileSize(file.bytes)})`,
        `Copied as ContentVersion ${written.id}, but its document could not be read back: ` +
          'the run keeps the version, which a removal of the run takes with its document, and ' +
          'links it to no other record.',
        true,
      );
      continue;
    }
    remapper.add(file.sourceId, documentId, 'ContentDocument');
    remapper.persist?.();

    const linked = await link(file, documentId, hosts.slice(1));
    onCopied?.(file, {
      targetId: documentId,
      linked: publishedOn ? [publishedOn, ...linked] : linked,
      asVersion: false,
    });
  }

  for (const entry of report.objects) {
    onProgress({
      objectName: entry.objectApiName,
      status: entry.failed > 0 && entry.copied === 0 ? 'error' : 'done',
      progress: 100,
      message:
        `Copied ${entry.copied} ${noun(entry.objectApiName, entry.copied)} of ${entry.planned}` +
        (entry.failed > 0 ? `, ${entry.failed} failed` : ''),
    });
  }
  return failures;
}
