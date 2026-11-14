/**
 * The manifest of a set of slices: a masking run, or a backup, that cuts each
 * object into slices of as many rows as a snapshot holds, consecutive by Id,
 * each slice backed up whole — and, for a masking run, masked from its
 * snapshot just after.
 *
 * One snapshot of every row a run masks held up to a million rows of an
 * object, and a run past it was refused, its only way out to mask without
 * keeping the values. A slice is a snapshot of its own, so a set holds as
 * many rows as its slices do, and each slice is restored, and resumed, on
 * its own.
 *
 * Kept in the config store under `backupSet:<setId>`, beside the snapshots'
 * own metadata (`backup:<snapshotId>`), read back through its schema: an
 * entry edited by hand or written by another version is no set, and nothing
 * is resumed or restored from it.
 */

import * as z from 'zod';
import type {
  BackupSetSummary,
  SliceSetOpen,
  SliceSetResult,
  SliceSummary,
} from '@sandforge/shared';

import type { ConfigStore } from '../../../core/storage/ConfigStore.js';

/** Key prefix of a set's manifest in the config store. */
export const BACKUP_SET_PREFIX = 'backupSet:';

/** Config store category of the manifests. */
const BACKUP_SET_CATEGORY = 'backups';

/** A record id, 15 or 18 letters and digits: what goes into a statement as it is. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A date as `toISOString` writes it. */
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

const countSchema = z.number().int().nonnegative();

/** One slice of an object. */
const sliceSchema = z.object({
  /** Its number in the set, from 1, whatever its object: `--slice 2` names one slice. */
  index: z.number().int().positive(),
  /** The last row of the slice before it: the slice holds the rows past it. Absent for the first. */
  afterId: z.string().regex(RECORD_ID).optional(),
  /**
   * The last row its snapshot holds, once taken: the next slice starts past
   * it. For a slice of late rows, the end of the range it was taken in.
   */
  lastId: z.string().regex(RECORD_ID).optional(),
  /** Rows its snapshot holds. */
  rows: countSchema,
  /** The snapshot it is backed up in: `<setId>-s0001`. */
  snapshotId: z.string().min(1).max(240),
  /** When its snapshot was taken, on this machine's clock. */
  takenAt: ISO_DATE.optional(),
  /**
   * The org's clock just before its snapshot was read: a row created in its
   * range since is one no slice holds (`late`).
   */
  readSince: ISO_DATE.optional(),
  state: z.enum(['pending', 'snapshotted', 'masking', 'masked', 'restored']),
  masked: countSchema,
  refused: countSchema,
  /** Rows of its snapshot the org no longer had when the run wrote them. */
  deletedSince: countSchema,
  nothingToMask: countSchema,
  /** Rows of the update it stopped on, whose answer never came back. */
  unanswered: countSchema.optional(),
  /** Set on a slice of rows created during the run in a range a slice before masked. */
  late: z.literal(true).optional(),
  /** Rows the slice was read with: fewer than the set's size when the org would not read that many. */
  sizeUsed: z.number().int().positive(),
  /** Rows created in its range since its snapshot, which no slice holds yet. */
  lateLeft: countSchema.optional(),
  /** Of a slice of late rows, the slice whose range it was read in. */
  lateOf: z.number().int().positive().optional(),
  /**
   * Of a slice whose late rows filled a slice of their own: the last of
   * them read, which the next slice of late rows of its range starts past.
   */
  lateAfterId: z.string().regex(RECORD_ID).optional(),
  /** When a restore last wrote it back. */
  restoredAt: ISO_DATE.optional(),
});

/** One object of a set. */
const objectSchema = z.object({
  objectApiName: z.string().min(1).max(255),
  /** The filter the run held its rows to. */
  where: z.string().max(2000).optional(),
  /** The fields the snapshots read, all of them when absent. */
  select: z.string().max(100_000).optional(),
  /** Whether every row of it, up to the last by Id, is in a slice. */
  done: z.boolean(),
  /** Rows past the last slice's end created while the run went on, said at its end. */
  tailLeft: countSchema.optional(),
  slices: z.array(sliceSchema),
});

const setSchema = z.object({
  setId: z.string().min(1).max(200),
  kind: z.enum(['masking', 'backup']),
  orgId: z.string().min(1).max(200),
  /** Which org the rows were read from (`Organization.Id`): a restore into another is asked about. */
  organizationId: z.string().max(18).optional(),
  templateId: z.string().min(1).max(200).optional(),
  /** `maskingFingerprint` of the run, its slices' size among it. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Rows a slice holds at most. */
  size: z.number().int().positive(),
  state: z.enum(['open', 'done', 'abandoned']),
  startedAt: ISO_DATE,
  /** The org's clock as the set began: what a row created since is told by. */
  serverStartedAt: ISO_DATE.optional(),
  lastActivityAt: ISO_DATE,
  /** Requests the set's runs sent, all of them. */
  requestsSpent: countSchema,
  /**
   * A digest of the key its slices were masked with, never the key: a resume
   * masking with another one would give the same address another digest.
   */
  keyCheck: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  objects: z.array(objectSchema),
});

/** One slice of a set, as its manifest keeps it. */
export type BackupSlice = z.infer<typeof sliceSchema>;

/** One object of a set. */
export type BackupSetObject = z.infer<typeof objectSchema>;

/** A set of slices, as its manifest keeps it. */
export type BackupSet = z.infer<typeof setSchema>;

/**
 * The id of a slice's snapshot: the set's, and the slice's number on four
 * digits. No colon, which the keys of a backup's records add after its id.
 */
export function sliceSnapshotId(setId: string, index: number): string {
  return `${setId}-s${String(index).padStart(4, '0')}`;
}

/** Every slice of a set, in their order. */
export function slicesOf(set: Pick<BackupSet, 'objects'>): BackupSlice[] {
  return set.objects.flatMap((o) => o.slices).sort((a, b) => a.index - b.index);
}

/** The number the next slice of a set takes. */
export function nextSliceIndex(set: Pick<BackupSet, 'objects'>): number {
  return slicesOf(set).reduce((most, slice) => Math.max(most, slice.index), 0) + 1;
}

/** Whether a slice is done with: masked, or, of a backup, backed up. */
export function sliceDone(slice: Pick<BackupSlice, 'state'>): boolean {
  return slice.state === 'masked' || slice.state === 'snapshotted' || slice.state === 'restored';
}

/** Rows of a set its slices hold. */
export function setRows(set: Pick<BackupSet, 'objects'>): number {
  return slicesOf(set).reduce((sum, slice) => sum + slice.rows, 0);
}

/**
 * One slice as a result, a listing and a restore say it: the rows it was read
 * with too, when the org would not read as many as its set's slices hold.
 */
export function sliceSummaryOf(
  objectApiName: string,
  slice: BackupSlice,
  size: number,
): SliceSummary {
  return {
    index: slice.index,
    objectApiName,
    snapshotId: slice.snapshotId,
    rows: slice.rows,
    masked: slice.masked,
    refused: slice.refused,
    deletedSince: slice.deletedSince,
    nothingToMask: slice.nothingToMask,
    state: slice.state,
    ...(slice.late ? { late: true as const } : {}),
    ...(slice.sizeUsed < size ? { sizeUsed: slice.sizeUsed } : {}),
    ...(slice.restoredAt ? { restoredAt: slice.restoredAt } : {}),
  };
}

/** Rows created during the run that no slice holds yet: past the last slice, and in ranges masked. */
export function lateRowsOf(set: Pick<BackupSet, 'objects'>): number {
  return set.objects.reduce(
    (sum, o) => sum + (o.tailLeft ?? 0) + o.slices.reduce((rows, s) => rows + (s.lateLeft ?? 0), 0),
    0,
  );
}

/** A set as a run's end says it. */
export function sliceSetResultOf(
  set: BackupSet,
  run: { requestsSpent: number; stoppedOnBudget?: boolean },
): SliceSetResult {
  return {
    setId: set.setId,
    size: set.size,
    state: set.state,
    objects: set.objects.map((o) => ({
      objectApiName: o.objectApiName,
      slices: o.slices.map((slice) => sliceSummaryOf(o.objectApiName, slice, set.size)),
    })),
    lateRecords: lateRowsOf(set),
    requestsSpent: run.requestsSpent,
    ...(run.stoppedOnBudget ? { stoppedOnBudget: true as const } : {}),
    slicesLeft: set.objects.some((o) => !o.done || o.slices.some((s) => !sliceDone(s))),
  };
}

/** A set as the backup listing gives it. */
export function backupSetSummaryOf(set: BackupSet): BackupSetSummary {
  const wheres = Object.fromEntries(
    set.objects.flatMap((o) => (o.where ? [[o.objectApiName, o.where] as const] : [])),
  );
  return {
    setId: set.setId,
    orgId: set.orgId,
    kind: set.kind,
    state: set.state,
    startedAt: set.startedAt,
    lastActivityAt: set.lastActivityAt,
    size: set.size,
    totalRecords: setRows(set),
    ...(set.templateId ? { templateId: set.templateId } : {}),
    slices: set.objects.flatMap((o) =>
      o.slices.map((s) => sliceSummaryOf(o.objectApiName, s, set.size)),
    ),
    ...(Object.keys(wheres).length > 0 ? { wheres } : {}),
  };
}

/** A set open on an org, as a coverage names it. */
export function sliceSetOpenOf(set: BackupSet): SliceSetOpen {
  const slices = slicesOf(set);
  return {
    setId: set.setId,
    savedAt: set.lastActivityAt,
    done: slices.filter(sliceDone).length,
    total: slices.length,
    state: set.state,
    size: set.size,
  };
}

/**
 * The manifests of the sets of slices, in the config store: `snapshots.json`
 * on a command line, the window's state in the editor.
 */
export class BackupSetStore {
  /** @param configStore - The configuration store backend. */
  constructor(private readonly configStore: ConfigStore) {}

  /** A set's manifest, or undefined when none reads as one. */
  get(setId: string): BackupSet | undefined {
    const parsed = setSchema.safeParse(this.configStore.get(this.key(setId)));
    return parsed.success && parsed.data.setId === setId ? parsed.data : undefined;
  }

  /**
   * Keep a set's manifest, in place of the one kept before.
   *
   * @throws When it does not read as a set: a manifest kept is one read back.
   */
  save(set: BackupSet): void {
    this.configStore.set(this.key(set.setId), setSchema.parse(set), BACKUP_SET_CATEGORY);
  }

  /** Forget a set's manifest. */
  delete(setId: string): void {
    this.configStore.delete(this.key(setId));
  }

  /** Every set kept, of one org when one is named. */
  list(orgId?: string): BackupSet[] {
    return this.configStore
      .getKeysByPrefix(BACKUP_SET_PREFIX)
      .map((key) => this.get(key.slice(BACKUP_SET_PREFIX.length)))
      .filter((set): set is BackupSet => set !== undefined)
      .filter((set) => orgId === undefined || set.orgId === orgId);
  }

  /** The masking set of a template left open on an org, if one is. */
  openFor(orgId: string, templateId: string): BackupSet | undefined {
    return this.list(orgId).find(
      (set) => set.kind === 'masking' && set.state === 'open' && set.templateId === templateId,
    );
  }

  /** The set a slice's snapshot belongs to, if one does. */
  ofSnapshot(snapshotId: string): BackupSet | undefined {
    return this.list().find((set) => slicesOf(set).some((s) => s.snapshotId === snapshotId));
  }

  private key(setId: string): string {
    return `${BACKUP_SET_PREFIX}${setId}`;
  }
}
