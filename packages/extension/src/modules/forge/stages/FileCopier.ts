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
import { idLists } from '../../dataops/RecordRemoval.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';

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
 * the files were not accepted as they are, the session cannot move a file, or
 * the files do not fit in what the target has left. Raised before anything
 * is written.
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

/** A report of a read that failed, as the record stages write one. */
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

/** Inputs for {@link copyFiles}. */
export interface FileCopyInput {
  files: readonly FileToCopy[];
  sourceOrgId: string;
  targetOrgId: string;
  /** Which records the run created, and their ids in the target; files are added to it. */
  remapper: IdRemapper;
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
 * @returns The records that were not written — files, and links to them —
 *   for the run's failed count.
 */
export async function copyFiles(input: FileCopyInput): Promise<number> {
  const { files, sourceOrgId, targetOrgId, remapper, deps, report, errors, onProgress } = input;
  let failures = 0;

  const entryOf = (objectApiName: ForgeFileObject): ForgeFileObjectReport => {
    let entry = report.objects.find((o) => o.objectApiName === objectApiName);
    if (!entry) {
      entry = { objectApiName, planned: 0, plannedBytes: 0, copied: 0, failed: 0 };
      report.objects.push(entry);
    }
    return entry;
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
    let error = errors.find((e) => e.objectApiName === objectApiName && e.stage === stage);
    if (!error) {
      error = { objectApiName, stage, failedCount: 0, attemptedCount: 0, samples: [] };
      errors.push(error);
    }
    if (!written) {
      error.failedCount++;
      error.attemptedCount++;
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

  for (const [index, file] of files.entries()) {
    await input.waitIfPaused();
    const hosts = file.hosts.filter((host) => remapper.isCreated(host.id));
    const publishedOn = hosts.length > 0 ? remapper.get(hosts[0].id) : undefined;
    if (!publishedOn) {
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
      progress: Math.round((index / files.length) * 100),
      message: `Copying ${noun(file.objectApiName, 1)} ${index + 1} of ${files.length} (${formatFileSize(file.bytes)})`,
    });

    let content: string;
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

    const record =
      file.body.objectApiName === 'ContentVersion'
        ? { ...file.fields, VersionData: content, FirstPublishLocationId: publishedOn }
        : { ...file.fields, Body: content, ParentId: publishedOn };
    let written: InsertResult;
    try {
      written = await deps.insertFile(targetOrgId, file.body.objectApiName, record);
    } catch (err) {
      failFile(file, 'insert', extractErrorMessage(err));
      continue;
    }
    if (!written.success || !written.id) {
      failFile(file, 'insert', written.errors.join('; ') || 'The target gave no reason.');
      continue;
    }
    entryOf(file.objectApiName).copied++;

    if (file.body.objectApiName === 'Attachment') {
      remapper.add(file.sourceId, written.id, 'Attachment');
      continue;
    }

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
          'removing this run will not find it.',
        true,
      );
      continue;
    }
    remapper.add(file.sourceId, documentId, 'ContentDocument');

    const links = hosts.slice(1).flatMap((host) => {
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
    if (links.length === 0) continue;
    try {
      const results = await deps.insertRecords(targetOrgId, 'ContentDocumentLink', links);
      links.forEach((_, at) => {
        const result = results[at];
        if (result?.success) {
          report.links++;
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
