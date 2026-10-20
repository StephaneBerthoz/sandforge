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
 *   second document. A legacy attachment, which has no versions, whose source
 *   changed since it was copied has its copy replaced: the new one written
 *   under the target record, then the earlier one deleted. Two sandboxes taken
 *   from the same production share their files' ids: a file the target already
 *   holds under the source's own id is taken as copied, rather than copied
 *   over itself. A configuration that is not saved keeps nothing, so it copies
 *   no file.
 * - **Delta.** A delta read finds the files of the records changed since the
 *   watermark, the documents an earlier run copied whose source has a version
 *   stamped after it, and the files of the records nothing else of which
 *   changed: a document linked to one since, or whose latest version was
 *   published since, and an attachment created or changed under one since.
 *   Those records are not written: their files go to the copies an earlier
 *   run made of them, found by the key the object's write matches on.
 * - **Measured first.** Before anything is written the target's file storage
 *   is read, and the files of every object are found and measured against the
 *   configuration's caps: a file over the largest size, and the files past
 *   what one run copies, are skipped and counted. A run whose files would not
 *   fit in what the target has left is refused, with the numbers.
 */

import { z } from 'zod';
import type {
  OrgTypeAndEdition,
  SyncConfig,
  SyncFileCopyOption,
  SyncFilesOutcome,
  SyncFilesStorage,
  SyncObjectConfig,
} from '@sandforge/shared';
import {
  BYTES_PER_MB,
  formatFileSize,
  guardTierOf,
  sanitizeSoqlObjectName,
} from '@sandforge/shared';
import type { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
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
import { assertSoqlWhere } from '../../core/common/soqlValidator.js';
import { assertSoqlDateTime, orgDateTime, soqlDateTimeOf } from './SyncDelta.js';

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
  /**
   * For an attachment: when the source last changed it, as it was copied —
   * a later change replaces the copy. Absent from a copy kept before it was.
   */
  sourceModifiedAt: z.iso.datetime().optional(),
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
  /**
   * Delete records of the target in one call: the earlier copy of a legacy
   * attachment the source changed, once its new copy is written. Without it,
   * a changed attachment is left as it was copied, and the run says how many.
   */
  deleteFromTarget?: (objectApiName: string, ids: string[]) => Promise<InsertResult[]>;
  /** Told as each file is copied, for the run's progress: how far, in percent, and what. */
  onProgress?: (percent: number, message: string) => void;
}

/**
 * Whether Production Guard would let Sync delete in the target without
 * refusing it: a changed legacy attachment is replaced by writing its new copy
 * and deleting the earlier one, and the guard allows no delete on a production
 * org. A Developer Edition org is none (`guardTierOf`): it holds nobody's
 * business, and its attachments are replaced as a sandbox's are. Where the
 * guard would refuse, the earlier copy stays and the change is not copied, as
 * before attachments were replaced: a run never deletes where a delete of its
 * own would be refused. No guard, no delete. The panel asks it with the org's
 * registered type and edition, the command line with what the org says it is
 * (`IsSandbox`, `OrganizationType`): one rule for both.
 *
 * @param guard - The Production Guard the run is judged by.
 * @param targetOrgId - The org the run writes to.
 * @param targetOrg - That org's type and edition, as `guardTierOf` reads them.
 */
export function targetAllowsDeletes(
  guard: Pick<ProductionGuard, 'check'> | undefined,
  targetOrgId: string,
  targetOrg: OrgTypeAndEdition | undefined,
): boolean {
  if (!guard) return false;
  return guard.check({
    orgId: targetOrgId,
    orgTier: guardTierOf(targetOrg),
    operation: 'delete',
    objectName: 'Attachment',
    recordCount: 1,
    module: 'sync',
  }).allowed;
}

/**
 * The records an earlier run wrote in the target for some source records,
 * tied by the key the object's write matches on.
 */
export interface TiedRecords {
  /** Source id to the one target record its key ties it to. */
  held: ReadonlyMap<string, string>;
  /** Why none could be tied: no key carried from the source ties a record to one copy. */
  refused?: string;
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
  /**
   * Source records the run does not write — their files changed, nothing
   * else of them — with the copy an earlier run made of each in the target,
   * by source id: their new files go to it.
   */
  held: ReadonlyMap<string, string>;
  /**
   * Legacy attachments an earlier run copied that the source changed since:
   * the earlier copy of each, by source id, deleted once the new one is written.
   */
  replacing: ReadonlyMap<string, string>;
  /** When the source last changed each legacy attachment found, as ISO, by id: kept with its copy. */
  attachmentsChangedAt: ReadonlyMap<string, string>;
  /**
   * On a delta read: the newest stamp the lookups for files gained since have
   * looked at, this run's or an earlier one's, as ISO — what the object's next
   * watermark keeps, so the next run looks only past it.
   */
  filesSeen?: string;
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
  /**
   * On a delta read: the newest stamp an earlier run's lookups for files
   * looked at (`SyncWatermark.filesSeen`), as ISO. Those lookups look only
   * past it when it is later than `changedSince`.
   */
  filesSeen?: string;
}

/** A string field of a row, or undefined. */
function text(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A date a row holds at `pathOfField` — a dotted path through its relationships — as ISO, or null. */
function stampAt(row: Record<string, unknown>, pathOfField: string): string | null {
  let value: unknown = row;
  for (const step of pathOfField.split('.')) {
    if (typeof value !== 'object' || value === null) return null;
    value = (value as Record<string, unknown>)[step];
  }
  return orgDateTime(value);
}

/** The later of two ISO dates, either of which may be absent. */
function later(a: string | undefined, b: string | null | undefined): string | undefined {
  if (b === null || b === undefined) return a;
  if (a === undefined) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
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

/** The version stamp a file link carries through its document. */
const LINKED_VERSION_STAMP = 'ContentDocument.LatestPublishedVersion.SystemModstamp';

/**
 * The records of an object's scope whose files changed after `lookPast`: a
 * Salesforce File linked to one since — the link's stamp — or whose latest
 * version was published since — its version's stamp — and a legacy attachment
 * created or changed under one since. Nothing else of such a record need have
 * changed, and a delta read, which reads the records stamped since, did not
 * return it: a file attached to it was found only once the record changed, or
 * on a full read.
 *
 * With them, the newest of the stamps the lookups found, as ISO: the point
 * the next run's lookups start from. Started from the watermark alone, they
 * found the same files on every run whose records did not change — the
 * watermark stays put then — each found again only to be counted unchanged.
 */
async function recordsWithFilesSince(
  deps: SyncFileDeps,
  config: SyncConfig,
  objectConfig: SyncObjectConfig,
  lookPast: string,
): Promise<{ ids: string[]; newest?: string }> {
  const object = sanitizeSoqlObjectName(objectConfig.objectApiName);
  const own = objectConfig.where?.trim() ? ` WHERE (${assertSoqlWhere(objectConfig.where)})` : '';
  const scope = `SELECT Id FROM ${object}${own}`;
  const since = assertSoqlDateTime(lookPast);
  const found = new Set<string>();
  let newest: string | undefined;
  const links = await deps.copy.queryRecords(
    config.sourceOrgId,
    `SELECT LinkedEntityId, SystemModstamp, ${LINKED_VERSION_STAMP} FROM ContentDocumentLink ` +
      `WHERE LinkedEntityId IN (${scope}) AND ` +
      `(SystemModstamp > ${since} OR ${LINKED_VERSION_STAMP} > ${since})`,
  );
  for (const link of links) {
    const id = text(link, 'LinkedEntityId');
    if (id && isRecordId(id)) found.add(id);
    newest = later(
      later(newest, stampAt(link, 'SystemModstamp')),
      stampAt(link, LINKED_VERSION_STAMP),
    );
  }
  const attachments = await deps.copy.queryRecords(
    config.sourceOrgId,
    `SELECT ParentId, LastModifiedDate FROM Attachment WHERE ParentId IN (${scope}) AND ` +
      `LastModifiedDate > ${since}`,
  );
  for (const attachment of attachments) {
    const id = text(attachment, 'ParentId');
    if (id && isRecordId(id)) found.add(id);
    newest = later(newest, stampAt(attachment, 'LastModifiedDate'));
  }
  return { ids: [...found], ...(newest !== undefined ? { newest } : {}) };
}

/** When the source last changed each legacy attachment of `ids`, as ISO, by id. */
async function attachmentsChangedAt(
  deps: SyncFileDeps,
  config: SyncConfig,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const changedAt = new Map<string, string>();
  for (const list of idLists(ids)) {
    const rows = await deps.copy.queryRecords(
      config.sourceOrgId,
      `SELECT Id, LastModifiedDate FROM Attachment WHERE Id IN (${list})`,
    );
    for (const row of rows) {
      const id = text(row, 'Id');
      const at = orgDateTime(row['LastModifiedDate']);
      if (id && at) changedAt.set(id, at);
    }
  }
  return changedAt;
}

/**
 * Whether a legacy attachment an earlier run copied changed in the source
 * since: its last change is not the one its copy was made from — or, for a
 * copy kept before that was, it changed after the point a delta read starts
 * from. A full read cannot tell such a copy from a change, and leaves it.
 *
 * One the target held under the source's own id — two sandboxes taken from
 * the same production — was taken as copied, and is the target's own: it is
 * never deleted to be replaced.
 */
function attachmentChanged(
  earlier: SyncCopiedFile,
  changedAt: string | undefined,
  changedSince: string | undefined,
): boolean {
  if (changedAt === undefined || earlier.targetId === earlier.sourceId) return false;
  if (earlier.sourceModifiedAt !== undefined) return earlier.sourceModifiedAt !== changedAt;
  return changedSince !== undefined && Date.parse(changedAt) > Date.parse(changedSince);
}

/**
 * The latest versions of documents an earlier run copied for `objectApiName`
 * that are stamped after `lookPast`: what a delta read adds to the files of
 * the records it read, so a new version reaches the target though its record
 * did not change. With them, the newest stamp among them, as ISO.
 */
async function newerVersions(
  deps: SyncFileDeps,
  config: SyncConfig,
  objectApiName: string,
  lookPast: string,
  copied: ReadonlyMap<string, SyncCopiedFile>,
  found: ReadonlySet<string>,
): Promise<{ files: FileToCopy[]; newest?: string }> {
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
  const since = assertSoqlDateTime(lookPast);
  const files: FileToCopy[] = [];
  let newest: string | undefined;
  for (const list of idLists(documents)) {
    const versions = await deps.copy.queryRecords(
      config.sourceOrgId,
      'SELECT Id, ContentDocumentId, Title, PathOnClient, ContentSize, ContentLocation, ' +
        `SystemModstamp FROM ContentVersion WHERE ContentDocumentId IN (${list}) AND ` +
        `IsLatest = true AND SystemModstamp > ${since}`,
    );
    for (const version of versions) {
      newest = later(newest, stampAt(version, 'SystemModstamp'));
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
  return { files, ...(newest !== undefined ? { newest } : {}) };
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
  /**
   * On a delta read: the copies an earlier run made in the target of source
   * records this run does not write, whose files changed since. Without it,
   * their new files are left for when the record changes.
   */
  tie?: (objectConfig: SyncObjectConfig, sourceIds: readonly string[]) => Promise<TiedRecords>;
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

  for (const { objectConfig, changedSince, filesSeen: seenBefore } of objects) {
    if (objectConfig.operation === 'delete') continue;
    const name = objectConfig.objectApiName;
    const ids = await deps.sourceIds(objectConfig, changedSince);
    const notes: string[] = [];
    // On a delta read, the lookups for files gained since start from the
    // watermark, or past the newest stamp an earlier run's looked at.
    const lookPast =
      changedSince === undefined
        ? undefined
        : seenBefore !== undefined && Date.parse(seenBefore) > Date.parse(changedSince)
          ? soqlDateTimeOf(seenBefore)
          : changedSince;
    let filesSeen = changedSince === undefined ? undefined : seenBefore;
    // On a delta read, the records whose files changed while nothing else of
    // them did: the read does not return them, and their files go to the
    // copy an earlier run made of each, which the object's key finds.
    let held: ReadonlyMap<string, string> = new Map();
    if (lookPast !== undefined) {
      try {
        const changed = new Set(ids);
        const gained = await recordsWithFilesSince(deps, config, objectConfig, lookPast);
        filesSeen = later(filesSeen, gained.newest);
        const others = gained.ids.filter((id) => !changed.has(id));
        if (others.length > 0) {
          const tied: TiedRecords = input.tie
            ? await input.tie(objectConfig, others)
            : { held: new Map() };
          held = tied.held;
          const untied = others.filter((id) => !held.has(id)).length;
          if (untied > 0) {
            notes.push(
              `${untied} record(s) whose files changed since the last run, and nothing else of ` +
                'them, could not be tied to their copy in the target' +
                (tied.refused ? ` (${tied.refused})` : '') +
                ': their new files are copied when the record changes, or on a full read.',
            );
          }
        }
      } catch (err) {
        throw new SyncFilesRefusedError(
          `${name}: the files its records gained since the last run could not be looked up ` +
            `(${extractErrorMessage(err)}). Run it again, or turn the files off. Nothing was written.`,
        );
      }
    }
    const scope = [...ids, ...held.keys()];
    const selection = await selectFiles({
      scope: new Map([[name, scope]]),
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
    let changedAt = new Map<string, string>();
    try {
      if (lookPast !== undefined) {
        const found = new Set(candidates.map((f) => f.sourceId));
        const newer = await newerVersions(deps, config, name, lookPast, copied, found);
        filesSeen = later(filesSeen, newer.newest);
        for (const version of newer.files) {
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
      // When the source last changed each attachment: one changed since its
      // copy was made has the copy replaced. An attachment has no versions,
      // and one the source changed was never copied again. Read where the
      // run may not delete too, to say what it leaves.
      const attachments = candidates.filter((f) => f.objectApiName === 'Attachment');
      if (attachments.length > 0) {
        changedAt = await attachmentsChangedAt(
          deps,
          config,
          attachments.map((f) => f.sourceId),
        );
      }
    } catch (err) {
      throw new SyncFilesRefusedError(
        `${name}: the files an earlier run copied could not be looked up ` +
          `(${extractErrorMessage(err)}), so a run could copy them twice. Nothing was written.`,
      );
    }

    const files: FileToCopy[] = [];
    const replacing = new Map<string, string>();
    let mapFull = 0;
    /** Attachments the source changed since their copy, left as copied: the run may not delete. */
    let leftChanged = 0;
    for (const file of candidates) {
      if (plannedEarlier.has(file.sourceId)) {
        // Its copy exists by the time this object's files are copied: see
        // `copyPlannedFiles`, which links it to this object's records.
        outcome.unchanged++;
        files.push(file);
        continue;
      }
      const earlier = copied.get(mapKey(config.sourceOrgId, config.targetOrgId, file.sourceId));
      const replaces =
        earlier?.kind === 'attachment' &&
        attachmentChanged(earlier, changedAt.get(file.sourceId), changedSince);
      // Replacing one deletes its earlier copy. Where the run may not delete
      // in the target, it was counted unchanged, as if the change had been
      // copied, and nothing said it was not.
      if (replaces && !deps.deleteFromTarget) {
        leftChanged++;
        continue;
      }
      if (
        earlier &&
        !replaces &&
        (earlier.kind === 'attachment' || earlier.sourceVersionId === file.body.id)
      ) {
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
      if (earlier && replaces) {
        outcome.replaced = (outcome.replaced ?? 0) + 1;
        replacing.set(file.sourceId, earlier.targetId);
        files.push(file);
      } else if (earlier) {
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
    if (leftChanged > 0) {
      notes.push(
        `${leftChanged} legacy attachment(s) the source changed since they were copied were left ` +
          'as copied: replacing one deletes its earlier copy, and this run may not delete in ' +
          'the target.',
      );
    }
    if (mapFull > 0) {
      notes.push(
        `${mapFull} file(s) were not copied: this configuration keeps the record of ` +
          `${SYNC_FILE_MAP_MAX} copied files at most, which it holds already.`,
      );
    }
    plan.objects.set(name, {
      scope: new Set(scope),
      files,
      outcome,
      notes,
      shared,
      held,
      replacing,
      attachmentsChangedAt: changedAt,
      ...(filesSeen !== undefined ? { filesSeen } : {}),
    });
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
  /**
   * Told of each file the copy created in the target, as soon as it exists:
   * a Salesforce File's first copy, by its document, or a legacy attachment.
   * Never a version added to an earlier copy, nor a copy only linked to more
   * records: those were the target's before. What a removal of the run takes.
   */
  onCreated?: (objectApiName: 'ContentDocument' | 'Attachment', id: string) => void;
}): Promise<CopiedObjectFiles> {
  const { config, option, objectApiName, planned, written, deps, signal } = input;
  const outcome: SyncFilesOutcome = {
    ...planned.outcome,
    copied: 0,
    versions: 0,
    bytes: 0,
    ...(planned.outcome.replaced !== undefined ? { replaced: 0 } : {}),
  };
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
  /** The earlier copies of the attachments replaced, to delete once the new ones are kept. */
  const replaced: string[] = [];
  /** Those the target would not delete, and why. */
  let left: EarlierCopiesLeft = { ids: [], note: undefined };

  const record = (file: FileToCopy, copy: CopiedFile): void => {
    const key = mapKey(config.sourceOrgId, config.targetOrgId, file.sourceId);
    const linked = [...new Set([...(file.into?.linked ?? []), ...copy.linked])].slice(0, MAX_LINKS);
    const document = file.objectApiName === 'ContentDocument';
    const earlierCopy = planned.replacing.get(file.sourceId);
    const changedAt = planned.attachmentsChangedAt.get(file.sourceId);
    if (copy.asVersion) {
      outcome.versions++;
      outcome.bytes += file.bytes;
    } else if (earlierCopy !== undefined) {
      outcome.replaced = (outcome.replaced ?? 0) + 1;
      outcome.bytes += file.bytes;
    } else if (!file.into?.unchanged) {
      outcome.copied++;
      outcome.bytes += file.bytes;
    }
    // A copy written whole is the run's: a first copy, or the new copy of an
    // attachment replaced, the earlier one deleted by the run.
    if (!copy.asVersion && !file.into) {
      input.onCreated?.(document ? 'ContentDocument' : 'Attachment', copy.targetId);
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
        ...(!document && changedAt !== undefined ? { sourceModifiedAt: changedAt } : {}),
        linked,
        copiedAt: new Date().toISOString(),
      });
      if (earlierCopy !== undefined && earlierCopy !== copy.targetId) replaced.push(earlierCopy);
    } catch (err) {
      unsaved = `${extractErrorMessage(err)} (${key})`;
    }
  };

  try {
    await copyFiles({
      files,
      sourceOrgId: config.sourceOrgId,
      targetOrgId: config.targetOrgId,
      // A record the run wrote, or one it did not whose files changed: its
      // files go to the copy an earlier run made of it.
      remapper: {
        isCreated: (id) => written.has(id) || planned.held.has(id),
        get: (id) => written.get(id) ?? planned.held.get(id),
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
  } finally {
    // The earlier copy of each attachment replaced goes once the new one is
    // kept, a cancel or a failure after it notwithstanding: deleted first, a
    // copy whose replacement the target then refused was lost.
    if (replaced.length > 0) left = await deleteEarlierCopies(deps, replaced);
  }

  outcome.links = report.links;
  outcome.failed = report.objects.reduce((sum, entry) => sum + entry.failed, 0) + left.ids.length;
  outcome.recordNotWritten = report.leftOut.filter((l) => l.reason === 'record-not-created').length;
  notes.push(...failureLines(errors));
  if (left.note !== undefined) notes.push(left.note);
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

/** The most records one delete call takes. */
const DELETE_BATCH = 200;

/** The earlier copies of replaced attachments the target would not delete, and the line that names them. */
interface EarlierCopiesLeft {
  ids: string[];
  note: string | undefined;
}

/**
 * Delete from the target the earlier copies of the attachments a run
 * replaced. A copy the target would not delete is counted as failed and
 * named: the record then holds the new copy and the old one.
 */
async function deleteEarlierCopies(
  deps: SyncFileDeps,
  ids: readonly string[],
): Promise<EarlierCopiesLeft> {
  const left: string[] = [];
  const messages = new Set<string>();
  for (let at = 0; at < ids.length; at += DELETE_BATCH) {
    const batch = ids.slice(at, at + DELETE_BATCH);
    try {
      const answers = (await deps.deleteFromTarget?.('Attachment', batch)) ?? [];
      batch.forEach((id, index) => {
        const answer = answers[index];
        if (answer?.success) return;
        left.push(id);
        messages.add(answer?.errors.join('; ') || 'The target gave no reason.');
      });
    } catch (err) {
      left.push(...batch);
      messages.add(extractErrorMessage(err));
    }
  }
  if (left.length === 0) return { ids: [], note: undefined };
  return {
    ids: left,
    note:
      `${left.length} earlier copy(ies) of an attachment replaced could not be deleted from the ` +
      `target (${[...messages].join('; ')}): the record holds the new copy and the old one, ` +
      `${left.join(', ')}.`,
  };
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
    files += o.copied + o.versions + (o.replaced ?? 0);
    bytes += o.bytes;
    skipped += o.tooLarge + o.pastRunCap;
  }
  return `${files} file(s), ${formatFileSize(bytes)} copied, ${skipped} skipped past the caps`;
}
