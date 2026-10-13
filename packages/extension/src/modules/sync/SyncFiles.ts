/**
 * The files of a Sync run: the latest version of each Salesforce File linked
 * to a record an object writes, and the legacy attachments under it, copied
 * once the object's records are in the target and linked to the records they
 * hang on there. Off unless a configuration asks for it (`SyncConfig.files`):
 * a run that does not reads no file.
 *
 * The copy itself is Forge's file stage (`forge/stages/FileCopier.ts`): its
 * selection of the files of a set of records, its one-call-each-way transfer
 * with the byte count checked, its links. What Sync adds is what a run that
 * comes back again needs.
 *
 * - **Never twice.** Kept beside the watermarks of a saved configuration is
 *   which file it copied where: the source document or attachment, its copy
 *   in the target, the source version copied and the target records the copy
 *   is linked to. A file found again is not copied again; a document whose
 *   source holds a newer version gets that version added to its copy, never a
 *   second document. Two sandboxes taken from the same production share their
 *   files' ids: a file the target already holds under the source's own id is
 *   taken as copied, rather than copied over itself. A configuration that is
 *   not saved keeps nothing, so it copies no file.
 * - **Delta.** A delta read finds the files of the records changed since the
 *   watermark, and besides those the documents an earlier run copied whose
 *   source has a version stamped after it: a new version reaches the target
 *   though its record did not change. A file attached to a record nothing else
 *   changed is found when the record changes, or on a full read.
 * - **Measured first.** Before anything is written the target's file storage
 *   is read, and the files of every object are found and measured against the
 *   configuration's caps: a file over the largest size, and the files past
 *   what one run copies, are skipped and counted. A run whose files would not
 *   fit in what the target has left is refused, with the numbers.
 */

import { z } from 'zod';
import type {
  SyncConfig,
  SyncFileCopyOption,
  SyncFilesOutcome,
  SyncFilesStorage,
  SyncObjectConfig,
} from '@sandforge/shared';
import { BYTES_PER_MB, formatFileSize } from '@sandforge/shared';
import {
  copyFiles,
  lookupFailure,
  plannedFilesReport,
  remainingStorageBytes,
  selectFiles,
  type CopiedFile,
  type FileCopyDeps,
  type FileToCopy,
} from '../forge/stages/FileCopier.js';
import type { ExecutionObjectError, InsertResult } from '../forge/ForgeExecutor.js';
import { idLists, isRecordId } from '../dataops/RecordRemoval.js';
import { queryAllPages, type PagedQuerySource } from '../forge/queryAllPages.js';
import {
  insertFile as insertFileOverRest,
  readFileBody as readFileBodyOverRest,
  remainingFileStorageMB as remainingFileStorageOverRest,
  type FileTransport,
} from '../forge/fileTransfer.js';
import { toSaveOutcomes } from '../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlDateTime } from './SyncDelta.js';

/**
 * Most copied files one configuration keeps a record of. Every file a run
 * copies is written to that record as soon as it exists, so a run stopped
 * part way never copies it again; past this many, a run copies no new file
 * and says why.
 */
export const SYNC_FILE_MAP_MAX = 5_000;

/** Most target records one copied file keeps as linked. */
const MAX_LINKS = 200;

/** A record id, as the map keeps one. */
const recordIdSchema = z.string().refine((value) => isRecordId(value), 'not a record id');

/** One file a configuration copied, as stored beside its watermarks. */
export const syncCopiedFileSchema = z.object({
  sourceOrgId: z.string().min(1).max(200),
  targetOrgId: z.string().min(1).max(200),
  /** The object whose record the file was copied for. */
  objectApiName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
  /** A Salesforce File, by its document; or a legacy attachment. */
  kind: z.enum(['document', 'attachment']),
  /** The document or the attachment in the source. */
  sourceId: recordIdSchema,
  /** Its copy in the target. */
  targetId: recordIdSchema,
  /** For a document: the source version last copied. */
  sourceVersionId: recordIdSchema.optional(),
  /** The target records the copy is linked to. */
  linked: z.array(recordIdSchema).max(MAX_LINKS),
  /** When it was last written, by this machine's clock: said, never read from. */
  copiedAt: z.iso.datetime(),
});

/** Every file one configuration copied. */
export const syncFileMapSchema = z.object({
  version: z.literal(1),
  entries: z.array(syncCopiedFileSchema).max(SYNC_FILE_MAP_MAX),
});

export type SyncCopiedFile = z.infer<typeof syncCopiedFileSchema>;
export type SyncFileMap = z.infer<typeof syncFileMapSchema>;

/** What the store holds for a configuration. */
export type SyncFileMapLoad =
  { kind: 'none' } | { kind: 'stored'; map: SyncFileMap } | { kind: 'unreadable'; issue: string };

/** What a store holds, read as a file map or not at all. */
export function readFileMap(raw: unknown): SyncFileMapLoad {
  if (raw === undefined || raw === null) return { kind: 'none' };
  const parsed = syncFileMapSchema.safeParse(raw);
  if (parsed.success) return { kind: 'stored', map: parsed.data };
  const issue = parsed.error.issues[0];
  return { kind: 'unreadable', issue: `${issue.path.join('.') || 'map'}: ${issue.message}` };
}

/** Where the files a configuration copied are kept: see `SyncConfigStore`. */
export interface SyncFileStore {
  /** The files a configuration copied, or `null` when no configuration is saved under that id. */
  load(configId: string): SyncFileMapLoad | null;
  /** Record one copied file, replacing what was kept of the same source file between the same orgs. */
  record(configId: string, entry: SyncCopiedFile): void;
}

/** What a run that copies files needs beside its records' reads and writes. */
export interface SyncFileDeps {
  /** The calls Forge's file stage makes to both orgs. */
  copy: FileCopyDeps;
  /**
   * The ids of the source records an object's read returns: its filter and,
   * on a delta read, the same bound, asked for the ids alone.
   */
  sourceIds(objectConfig: SyncObjectConfig, changedSince?: string): Promise<string[]>;
  /** Where the files a configuration copied are kept. */
  store: SyncFileStore;
  /** Told as each file is copied, for the run's progress: how far, in percent, and what. */
  onProgress?: (percent: number, message: string) => void;
}

/** Raised before anything is written, when a run that copies files may not go ahead. */
export class SyncFilesRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncFilesRefusedError';
  }
}

/** Raised from the copy's checkpoint when the run is cancelled between two files. */
class FilesStopped extends Error {}

/** An outcome with nothing in it. */
export function emptyFilesOutcome(): SyncFilesOutcome {
  return {
    copied: 0,
    versions: 0,
    bytes: 0,
    links: 0,
    unchanged: 0,
    tooLarge: 0,
    pastRunCap: 0,
    external: 0,
    recordNotWritten: 0,
    failed: 0,
  };
}

/** The files of one object, found and measured before anything is written. */
export interface PlannedObjectFiles {
  /** The source records the files were found from: one written outside them has its files left. */
  scope: ReadonlySet<string>;
  /** What the copy is handed, in the order the records were read. */
  files: FileToCopy[];
  /** What was found: in `copied`, `versions` and `bytes`, what the run sets out to copy. */
  outcome: SyncFilesOutcome;
  /** What the counts leave unsaid. */
  notes: string[];
  /**
   * Files the target already held under the source's own id, taken as
   * copied: recorded once the run writes, never by a simulation.
   */
  shared: SyncCopiedFile[];
}

/** The files of a run, found and measured before anything is written. */
export interface SyncFilePlan {
  /** Per object, by API name. */
  objects: Map<string, PlannedObjectFiles>;
  /** The target's file storage, and what the files take of it. */
  storage: SyncFilesStorage;
}

/** One object of the run as the plan reads it. */
export interface FilePlanObject {
  objectConfig: SyncObjectConfig;
  /** On a delta read: the SOQL datetime the read starts from. */
  changedSince?: string;
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

/** The key a copied file is kept under: one per source file between one pair of orgs. */
function mapKey(sourceOrgId: string, targetOrgId: string, sourceId: string): string {
  return `${sourceOrgId}|${targetOrgId}|${sourceId}`;
}

/** The files a configuration copied, by {@link mapKey}; or why they cannot be read. */
function copiedFilesOf(config: SyncConfig, store: SyncFileStore): Map<string, SyncCopiedFile> {
  const load = store.load(config.id);
  if (load === null) {
    throw new SyncFilesRefusedError(
      'Files are copied by a saved configuration only: it keeps which file it copied where, so ' +
        'that running it again copies none of them twice. Save the configuration, then run it. ' +
        'Nothing was read or written.',
    );
  }
  if (load.kind === 'unreadable') {
    throw new SyncFilesRefusedError(
      `The record of the files this configuration copied could not be read (${load.issue}), so ` +
        'a run could copy them a second time. Turn the files off, or save the configuration ' +
        'again under a new name. Nothing was read or written.',
    );
  }
  const copied = new Map<string, SyncCopiedFile>();
  if (load.kind === 'stored') {
    for (const entry of load.map.entries) {
      copied.set(mapKey(entry.sourceOrgId, entry.targetOrgId, entry.sourceId), entry);
    }
  }
  return copied;
}

/**
 * The latest versions of documents an earlier run copied for `objectApiName`
 * that are stamped after `changedSince`: what a delta read adds to the files
 * of the records it read, so a new version reaches the target though its
 * record did not change.
 */
async function newerVersions(
  deps: SyncFileDeps,
  config: SyncConfig,
  objectApiName: string,
  changedSince: string,
  copied: ReadonlyMap<string, SyncCopiedFile>,
  found: ReadonlySet<string>,
): Promise<FileToCopy[]> {
  const documents = [...copied.values()]
    .filter(
      (entry) =>
        entry.kind === 'document' &&
        entry.objectApiName === objectApiName &&
        entry.sourceOrgId === config.sourceOrgId &&
        entry.targetOrgId === config.targetOrgId &&
        !found.has(entry.sourceId),
    )
    .map((entry) => entry.sourceId);
  const since = assertSoqlDateTime(changedSince);
  const files: FileToCopy[] = [];
  for (const list of idLists(documents)) {
    const versions = await deps.copy.queryRecords(
      config.sourceOrgId,
      'SELECT Id, ContentDocumentId, Title, PathOnClient, ContentSize, ContentLocation ' +
        `FROM ContentVersion WHERE ContentDocumentId IN (${list}) AND IsLatest = true ` +
        `AND SystemModstamp > ${since}`,
    );
    for (const version of versions) {
      const documentId = text(version, 'ContentDocumentId');
      const versionId = text(version, 'Id');
      if (!documentId || !versionId || (text(version, 'ContentLocation') ?? 'S') !== 'S') continue;
      const name = text(version, 'Title') ?? documentId;
      files.push({
        objectApiName: 'ContentDocument',
        sourceId: documentId,
        body: { objectApiName: 'ContentVersion', id: versionId },
        name,
        bytes: size(version, 'ContentSize'),
        hosts: [],
        fields: { Title: name, PathOnClient: text(version, 'PathOnClient') ?? name },
      });
    }
  }
  return files;
}

/**
 * Of `files` no earlier run copied, those the target already holds under the
 * source's own id — two sandboxes taken from the same production share their
 * files' ids — taken as copied: the document with the version it holds and
 * the records it is linked to, the attachment as it is.
 */
async function sharedWithTarget(
  deps: SyncFileDeps,
  config: SyncConfig,
  objectApiName: string,
  files: readonly FileToCopy[],
): Promise<Map<string, SyncCopiedFile>> {
  const shared = new Map<string, SyncCopiedFile>();
  const now = new Date().toISOString();
  const entry = (
    kind: SyncCopiedFile['kind'],
    id: string,
    extra: Partial<SyncCopiedFile>,
  ): SyncCopiedFile => ({
    sourceOrgId: config.sourceOrgId,
    targetOrgId: config.targetOrgId,
    objectApiName,
    kind,
    sourceId: id,
    targetId: id,
    linked: [],
    copiedAt: now,
    ...extra,
  });

  const documents = files
    .filter((f) => f.objectApiName === 'ContentDocument')
    .map((f) => f.sourceId);
  for (const list of idLists(documents)) {
    const rows = await deps.copy.queryRecords(
      config.targetOrgId,
      `SELECT Id, LatestPublishedVersionId FROM ContentDocument WHERE Id IN (${list})`,
    );
    for (const row of rows) {
      const id = text(row, 'Id');
      if (!id) continue;
      const version = text(row, 'LatestPublishedVersionId');
      shared.set(id, entry('document', id, version ? { sourceVersionId: version } : {}));
    }
  }
  const held = [...shared.keys()];
  for (const list of idLists(held)) {
    const links = await deps.copy.queryRecords(
      config.targetOrgId,
      `SELECT ContentDocumentId, LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId IN (${list})`,
    );
    for (const link of links) {
      const document = text(link, 'ContentDocumentId');
      const linkedTo = text(link, 'LinkedEntityId');
      const known = document ? shared.get(document) : undefined;
      if (known && linkedTo && isRecordId(linkedTo) && known.linked.length < MAX_LINKS) {
        known.linked.push(linkedTo);
      }
    }
  }

  const attachments = files.filter((f) => f.objectApiName === 'Attachment').map((f) => f.sourceId);
  for (const list of idLists(attachments)) {
    const rows = await deps.copy.queryRecords(
      config.targetOrgId,
      `SELECT Id FROM Attachment WHERE Id IN (${list})`,
    );
    for (const row of rows) {
      const id = text(row, 'Id');
      if (id) shared.set(id, entry('attachment', id, {}));
    }
  }
  return shared;
}

/**
 * Find and measure the files of every object a run writes, before anything
 * is written: the target's file storage first, then per object the files of
 * the records its read returns — and, on a delta read, the newer versions of
 * the documents an earlier run copied — each sorted into what is copied, what
 * goes into an earlier copy as a version, what is unchanged, and what is
 * skipped and why. The caps are kept in the order the run writes: the files
 * past the most a run copies are those of its last records.
 *
 * @throws {SyncFilesRefusedError} When the configuration is not saved, its
 *   record of copied files does not read, the target's file storage cannot be
 *   read, or the files of an object's records could not all be looked up.
 */
export async function planRunFiles(input: {
  config: SyncConfig;
  option: SyncFileCopyOption;
  objects: readonly FilePlanObject[];
  deps: SyncFileDeps;
}): Promise<SyncFilePlan> {
  const { config, option, objects, deps } = input;
  const copied = copiedFilesOf(config, deps.store);

  let remainingBytes: number;
  try {
    remainingBytes = await remainingStorageBytes(deps.copy, config.targetOrgId);
  } catch (err) {
    throw new SyncFilesRefusedError(
      `The file storage the target has left could not be read (${extractErrorMessage(err)}), ` +
        'so the files could not be measured against it. Nothing was written.',
    );
  }

  const maxFileBytes = option.maxFileSizeMB * BYTES_PER_MB;
  const maxRunBytes = option.maxRunMB * BYTES_PER_MB;
  let plannedBytes = 0;
  let newEntries = 0;
  /**
   * The files an earlier object of this run sets out to copy. A document
   * linked to records of two objects is copied with the first, and only
   * linked to the second's: planned twice, it was copied twice.
   */
  const plannedEarlier = new Set<string>();
  const plan: SyncFilePlan = {
    objects: new Map(),
    storage: { remainingBytes, plannedBytes: 0 },
  };

  for (const { objectConfig, changedSince } of objects) {
    if (objectConfig.operation === 'delete') continue;
    const name = objectConfig.objectApiName;
    const ids = await deps.sourceIds(objectConfig, changedSince);
    const selection = await selectFiles({
      scope: new Map([[name, ids]]),
      sourceOrgId: config.sourceOrgId,
      maxFileBytes,
      queryRecords: deps.copy.queryRecords,
    });
    // A lookup that failed hides files: written without them, the records
    // would reach the target and a run would read as having copied them all.
    if (lookupFailure(selection)) {
      const messages = new Set(
        selection.errors.flatMap((e) => e.samples.flatMap((x) => x.messages)),
      );
      throw new SyncFilesRefusedError(
        `${name}: the files of its records could not all be looked up in the source ` +
          `(${[...messages].join('; ')}). Run it again, or turn the files off. Nothing was written.`,
      );
    }

    const outcome = emptyFilesOutcome();
    const notes: string[] = [];
    for (const left of selection.leftOut) {
      if (left.reason === 'too-large') outcome.tooLarge++;
      else if (left.reason === 'external') outcome.external++;
    }
    if (outcome.tooLarge > 0) {
      notes.push(
        `${outcome.tooLarge} file(s) larger than ${option.maxFileSizeMB} MB were not copied.`,
      );
    }

    let candidates = selection.files;
    const shared: SyncCopiedFile[] = [];
    try {
      if (changedSince !== undefined) {
        const found = new Set(candidates.map((f) => f.sourceId));
        const versions = await newerVersions(deps, config, name, changedSince, copied, found);
        for (const version of versions) {
          if (version.bytes > maxFileBytes) outcome.tooLarge++;
          else candidates = [...candidates, version];
        }
      }
      const unknown = candidates.filter(
        (f) => !copied.has(mapKey(config.sourceOrgId, config.targetOrgId, f.sourceId)),
      );
      if (unknown.length > 0) {
        for (const [id, entry] of await sharedWithTarget(deps, config, name, unknown)) {
          copied.set(mapKey(config.sourceOrgId, config.targetOrgId, id), entry);
          shared.push(entry);
        }
      }
    } catch (err) {
      throw new SyncFilesRefusedError(
        `${name}: the files an earlier run copied could not be looked up ` +
          `(${extractErrorMessage(err)}), so a run could copy them twice. Nothing was written.`,
      );
    }

    const files: FileToCopy[] = [];
    let mapFull = 0;
    for (const file of candidates) {
      if (plannedEarlier.has(file.sourceId)) {
        // Its copy exists by the time this object's files are copied: see
        // `copyPlannedFiles`, which links it to this object's records.
        outcome.unchanged++;
        files.push(file);
        continue;
      }
      const earlier = copied.get(mapKey(config.sourceOrgId, config.targetOrgId, file.sourceId));
      if (earlier && (earlier.kind === 'attachment' || earlier.sourceVersionId === file.body.id)) {
        // Copied before and unchanged since: a document is only linked to the
        // records its copy lacks, an attachment left as it is.
        outcome.unchanged++;
        if (earlier.kind === 'document') {
          files.push({
            ...file,
            into: { documentId: earlier.targetId, linked: earlier.linked, unchanged: true },
          });
        }
        continue;
      }
      if (!earlier && newEntries >= SYNC_FILE_MAP_MAX - copied.size) {
        mapFull++;
        outcome.pastRunCap++;
        continue;
      }
      if (plannedBytes + file.bytes > maxRunBytes) {
        outcome.pastRunCap++;
        continue;
      }
      plannedBytes += file.bytes;
      outcome.bytes += file.bytes;
      plannedEarlier.add(file.sourceId);
      if (earlier) {
        outcome.versions++;
        files.push({ ...file, into: { documentId: earlier.targetId, linked: earlier.linked } });
      } else {
        newEntries++;
        outcome.copied++;
        files.push(file);
      }
    }
    if (outcome.pastRunCap > mapFull) {
      notes.push(
        `${outcome.pastRunCap - mapFull} file(s) past the ${option.maxRunMB} MB a run copies ` +
          'were not copied: the next run copies them.',
      );
    }
    if (mapFull > 0) {
      notes.push(
        `${mapFull} file(s) were not copied: this configuration keeps the record of ` +
          `${SYNC_FILE_MAP_MAX} copied files at most, which it holds already.`,
      );
    }
    plan.objects.set(name, { scope: new Set(ids), files, outcome, notes, shared });
  }

  plan.storage = {
    remainingBytes,
    plannedBytes,
    ...(plannedBytes > remainingBytes
      ? {
          shortfall:
            `The files to copy take ${formatFileSize(plannedBytes)} and the target has ` +
            `${formatFileSize(Math.max(0, remainingBytes))} of file storage left. Lower the ` +
            'largest file or the most a run copies, or leave the files out.',
        }
      : {}),
  };
  return plan;
}

/** What copying one object's files came to. */
export interface CopiedObjectFiles {
  /** The plan's counts, with what the copy did. */
  outcome: SyncFilesOutcome;
  /** What the counts leave unsaid: the plan's notes, and each failure. */
  notes: string[];
  /** Records written outside the plan's scope: their files are left for the next run. */
  unplanned: number;
  /** Whether a cancel stopped the copy before its last file. */
  cancelled: boolean;
}

/** A failure the copy reported, as a line of the object's result. */
function failureLines(errors: readonly ExecutionObjectError[]): string[] {
  return errors.flatMap((error) =>
    error.samples.map(
      (sample) => `${error.objectApiName}: ${sample.recordSummary}: ${sample.messages.join('; ')}`,
    ),
  );
}

/**
 * Copy the files planned for one object, once its records are written: each
 * file of a record the run wrote, published on the first of its records and
 * linked to the others, a newer version into the copy an earlier run made.
 * Each copy is recorded as soon as it exists.
 *
 * @param written - The records of the object the run wrote: source id to target id.
 * @param signal - The run's cancel, honoured before each file.
 * @param waitIfPaused - The run's pause, waited on before each file.
 */
export async function copyPlannedFiles(input: {
  config: SyncConfig;
  option: SyncFileCopyOption;
  objectApiName: string;
  planned: PlannedObjectFiles;
  written: ReadonlyMap<string, string>;
  deps: SyncFileDeps;
  signal?: AbortSignal;
  waitIfPaused?: () => Promise<void>;
}): Promise<CopiedObjectFiles> {
  const { config, option, objectApiName, planned, written, deps, signal } = input;
  const outcome: SyncFilesOutcome = { ...planned.outcome, copied: 0, versions: 0, bytes: 0 };
  const notes = [...planned.notes];
  const unplanned = [...written.keys()].filter((id) => !planned.scope.has(id)).length;
  if (unplanned > 0) {
    notes.push(
      `${unplanned} record(s) written were not in the source when the files were looked up: ` +
        'their files are copied by the next run.',
    );
  }
  // Taken as copied by the plan: kept now, so the next run finds them without asking.
  try {
    for (const entry of planned.shared) deps.store.record(config.id, entry);
  } catch (err) {
    notes.push(
      `The files the target already held could not be recorded (${extractErrorMessage(err)}): ` +
        'the next run looks them up again.',
    );
  }
  if (planned.files.length === 0) return { outcome, notes, unplanned, cancelled: false };

  // A document an earlier object of this run copied is only linked to this
  // object's records: its copy is in the record by now.
  const load = deps.store.load(config.id);
  const kept = new Map(
    (load?.kind === 'stored' ? load.map.entries : [])
      .filter((e) => e.sourceOrgId === config.sourceOrgId && e.targetOrgId === config.targetOrgId)
      .map((e) => [e.sourceId, e]),
  );
  const files = planned.files.map((file): FileToCopy => {
    const earlier = file.into ? undefined : kept.get(file.sourceId);
    return earlier && earlier.kind === 'document'
      ? { ...file, into: { documentId: earlier.targetId, linked: earlier.linked, unchanged: true } }
      : file;
  });

  const report = plannedFilesReport(
    { files: files.filter((f) => !f.into?.unchanged), leftOut: [], errors: [] },
    option.maxFileSizeMB * BYTES_PER_MB,
  );
  const errors: ExecutionObjectError[] = [];
  let unsaved: string | undefined;
  let cancelled = false;

  const record = (file: FileToCopy, copy: CopiedFile): void => {
    const key = mapKey(config.sourceOrgId, config.targetOrgId, file.sourceId);
    const linked = [...new Set([...(file.into?.linked ?? []), ...copy.linked])].slice(0, MAX_LINKS);
    const document = file.objectApiName === 'ContentDocument';
    if (copy.asVersion) {
      outcome.versions++;
      outcome.bytes += file.bytes;
    } else if (!file.into?.unchanged) {
      outcome.copied++;
      outcome.bytes += file.bytes;
    }
    try {
      deps.store.record(config.id, {
        sourceOrgId: config.sourceOrgId,
        targetOrgId: config.targetOrgId,
        objectApiName,
        kind: document ? 'document' : 'attachment',
        sourceId: file.sourceId,
        targetId: copy.targetId,
        ...(document ? { sourceVersionId: file.body.id } : {}),
        linked,
        copiedAt: new Date().toISOString(),
      });
    } catch (err) {
      unsaved = `${extractErrorMessage(err)} (${key})`;
    }
  };

  try {
    await copyFiles({
      files,
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
      remapper: {
        isCreated: (id) => written.has(id),
        get: (id) => written.get(id),
        // What the run copied is kept by `record`, from what each file became.
        add: () => undefined,
      },
      deps: deps.copy,
      report,
      errors,
      waitIfPaused: async () => {
        // A file whose copy could not be recorded would be copied again by
        // the next run: none is copied after it.
        if (unsaved !== undefined) throw new FilesStopped();
        await input.waitIfPaused?.();
        if (signal?.aborted) throw new FilesStopped();
      },
      onProgress: (event) => {
        if (event.status === 'running') {
          deps.onProgress?.(event.progress, `${objectApiName}: ${event.message}`);
        }
      },
      onCopied: record,
    });
  } catch (err) {
    if (!(err instanceof FilesStopped)) throw err;
    cancelled = unsaved === undefined;
  }

  outcome.links = report.links;
  outcome.failed = report.objects.reduce((sum, entry) => sum + entry.failed, 0);
  outcome.recordNotWritten = report.leftOut.filter((l) => l.reason === 'record-not-created').length;
  notes.push(...failureLines(errors));
  if (outcome.recordNotWritten > 0) {
    notes.push(
      `${outcome.recordNotWritten} file(s) were not copied: no record they hang on was written.`,
    );
  }
  if (unsaved !== undefined) {
    outcome.failed++;
    notes.push(
      `A copied file could not be recorded, so no more files were copied: ${unsaved}. ` +
        'Check the copies of the last files in the target before running it again.',
    );
  }
  return { outcome, notes, unplanned, cancelled };
}

/** The calls a run's files make to an org, over its connection. */
export interface FileCopyOrg {
  /** Its paged query. */
  pages: PagedQuerySource<Record<string, unknown>>;
  /** Its REST requests, a file's content read and written. */
  transport: FileTransport;
  /** Create records of an object in one call: the links of a copied document. */
  create: (objectApiName: string, records: Record<string, unknown>[]) => Promise<unknown>;
}

/**
 * {@link FileCopyDeps} over the connections of the run's two orgs: the same
 * requests Forge's file copy sends.
 */
export function orgFileCopyDeps(orgs: Readonly<Record<string, FileCopyOrg>>): FileCopyDeps {
  const org = (orgId: string): FileCopyOrg => {
    const found = orgs[orgId];
    if (!found) throw new Error(`No connection for the org ${orgId}.`);
    return found;
  };
  return {
    queryRecords: async (orgId, soql) => (await queryAllPages(org(orgId).pages, soql)).records,
    readFileBody: (orgId, objectApiName, id) =>
      readFileBodyOverRest(org(orgId).transport, objectApiName, id),
    insertFile: (orgId, objectApiName, record) =>
      insertFileOverRest(org(orgId).transport, objectApiName, record),
    insertRecords: async (orgId, objectApiName, records): Promise<InsertResult[]> =>
      toSaveOutcomes(await org(orgId).create(objectApiName, records), objectApiName).map(
        (outcome) => ({ id: outcome.id, success: outcome.success, errors: outcome.errors }),
      ),
    remainingFileStorageMB: (orgId) => remainingFileStorageOverRest(org(orgId).transport),
  };
}

/** The files of a run as one line: "3 files, 1.2 MB copied, 1 skipped past the caps". */
export function filesSummaryLine(outcomes: readonly SyncFilesOutcome[]): string {
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  for (const o of outcomes) {
    files += o.copied + o.versions;
    bytes += o.bytes;
    skipped += o.tooLarge + o.pastRunCap;
  }
  return `${files} file(s), ${formatFileSize(bytes)} copied, ${skipped} skipped past the caps`;
}
